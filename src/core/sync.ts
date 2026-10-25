/**
 * 双向同步引擎：
 * - 拉取：优先 sync-collection 增量，回退 calendar-query 全量
 * - 上传：本地脏条目 PUT（带 If-Match），412 冲突按策略处理
 * - 删除：本地 deleted 标记 -> 服务端 DELETE
 */
import type { CalAccount, CalItem } from "./types";
import { accountOfUrl, enabledAccounts, enabledCalendars } from "./types";
import { keyOf, type CalStore } from "./store";
import {
  syncCollection,
  fetchCalendarItems,
  putItem,
  deleteItem,
  uploadIcloudAttachment,
  icsRangeIso,
  listResourceNames,
  fileNameOf,
  probeCalendarComponents,
  type DavAuth
} from "./caldav";
import { httpRequest } from "./http";
import { itemToEditedICS, itemToNewICS, base64ToBytes } from "./ics";
import { dateStampOfMs, stampOfMs } from "./date";
import type { Channel } from "./http";

export interface SyncReport {
  ok: boolean;
  fetched: number;
  uploaded: number;
  deleted: number;
  errors: string[];
  /** 冲突（412 等正常冲突，已按策略自愈，非失败）：单独计数走中性提示，不计入 errors */
  conflicts: string[];
  /** 中性提示（如「旧地址那份没删掉，请手动清理」）：不是错误，与 conflicts 一样走 lastNote */
  notes?: string[];
  elapsedMs: number;
  /** 对账清掉的「幽灵条目」数（本地有、服务端早已不存在，见 reconcile） */
  reconciled: number;
  /** 对账判定「服务端丢了」并重新上传的条目数（conflict === "local" 时） */
  requeued: number;
  /**
   * 本轮 pushDirty 实际推送**成功**的条目 key。为什么要单列：`uploaded` 只是计数，
   * 按 key 才能与 pendingUploadedKeys 取并集去重——同一条目即时推送 N 次再全量
   * 同步，报告只能算一条（2026-10-19 雄哥实测「操作几次就报上传几次」）。
   */
  uploadedKeys?: string[];
  /** 同上，删除口径 */
  deletedKeys?: string[];
}

/** 取 URL 的「源」（协议 + 主机 + 端口），用于判断两条地址是否属于同一台服务器 */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/**
 * 找出仍指向旧服务器的日历名。
 *
 * 用户在设置里改了「服务器地址」却没有重新点「发现日历」时，`calendars[].url`
 * 仍是旧地址 —— 这时同步会静默地去连**旧服务器**并且成功，让人误以为新地址可用。
 */
export function staleCalendarNames(
  serverUrl: string,
  cals: Array<{ url: string; displayName: string }>
): string[] {
  const origin = originOf(serverUrl);
  if (!origin) return [];
  return cals.filter((c) => originOf(c.url) !== origin).map((c) => c.displayName);
}

/** 把底层网络错误翻成可读提示（"Failed to fetch" 对用户毫无信息量） */
function explainError(e: any): string {
  const msg = e?.message || String(e);
  if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(msg)) {
    return "网络请求失败（服务不可达，或直连被跨域拦截，建议把请求通道改为「内核代理」）";
  }
  if (/timeout|aborted|abort/i.test(msg)) return "请求超时";
  if (/401/.test(msg)) return "认证失败（401）：用户名或密码错误";
  if (/403/.test(msg)) return "无权限（403）";
  return msg;
}

/**
 * 同一集合内的备用资源地址（组件类型变更被拒时换一个新文件名重试）。
 *
 * 为什么要换地址而不是硬覆盖：服务端是把组件类型绑在资源上校验的，同 href PUT
 * 另一种类型会被拒；换文件名等于「新建一份」，通常放行。UID 不变，所以各客户端
 * 仍按 UID 认它是同一条。
 */
function altHrefOf(href: string, uid: string): string {
  const i = href.lastIndexOf("/");
  const dir = i >= 0 ? href.slice(0, i) : "";
  const base = (uid || "item").replace(/[^A-Za-z0-9._-]/g, "") || "item";
  const alt = `${dir}/${base}-${Date.now().toString(36)}.ics`;
  return alt === href ? `${dir}/${base}-${Date.now().toString(36)}x.ics` : alt;
}

export class SyncEngine {
  private syncing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * 「同步中」可见状态的**引用计数**（2026-10-25 雄哥要求：保存即推时
   * 同步按钮也要转，示意该条目已同步到服务器）。
   *
   * 为什么用计数而不是布尔：两条推送路径可能**并存** —— 用户点「立即同步」
   * 跑全量同步的同时又保存了一条（保存即推走 pushAndPersist），
   * 先结束的那条不能把还在跑的那条的转动也抹掉。
   *
   * 置位方：syncAll（手动/定时全量同步）与 doPushAndPersist（保存即推）。
   */
  private syncDepth = 0;

  constructor(
    private store: CalStore,
    private getChannel: () => Channel
  ) {}

  /**
   * 按账户取凭据。多账户后每个服务器一套用户名/密码，不能再读全局
   * （2026-10-25 重构：serverUrl/凭据已下沉到 CalAccount）。
   * account 为空时回退第一个启用账户（兼容单账户的老调用路径）。
   */
  private authOf(acc?: CalAccount): DavAuth {
    const a = acc || enabledAccounts(this.store.settings)[0];
    return { username: a?.username || "", password: a?.password || "" };
  }

  /** 按账户取请求通道（账户自己的 channel 设置，缺省回退全局） */
  private channelOf(acc?: CalAccount): Channel {
    return acc?.channel || this.getChannel();
  }

  /** 按日历集合地址反查所属账户（凭据/通道/冲突策略都靠它定位） */
  private accountOf(calUrl: string): CalAccount | undefined {
    return accountOfUrl(this.store.settings, calUrl);
  }

  /** 按日历集合地址找日历配置（跨所有账户） */
  private findCalendarByUrl(calUrl: string): import("./types").CalCalendar | undefined {
    for (const a of this.store.settings.accounts) {
      const hit = (a.calendars || []).find((c) => c.url === calUrl);
      if (hit) return hit;
    }
    return undefined;
  }

  /** 置「同步中」：界面据此转同步按钮、Dock 状态条显示「同步中…」 */
  private beginSyncing(): void {
    this.syncDepth++;
    this.store.syncing = true;
    // notify() 只通知不落盘 —— 同步中是瞬时状态，不该写进数据文件
    this.store.notify();
  }

  /** 退「同步中」：计数归零才真正复位（并存的另一条可能还在跑） */
  private endSyncing(): void {
    this.syncDepth = Math.max(0, this.syncDepth - 1);
    if (this.syncDepth === 0 && this.store.syncing) {
      this.store.syncing = false;
      this.store.notify();
    }
  }

  /** 启动定时同步（分钟） */
  startAutoSync(onDone?: () => void): void {
    this.stopAutoSync();
    const min = this.store.settings.syncIntervalMin;
    if (!min || min <= 0) return;
    this.timer = setInterval(() => {
      void this.syncAll().then(() => onDone?.());
    }, min * 60000);
  }

  stopAutoSync(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async syncAll(): Promise<SyncReport> {
    if (this.syncing)
      return { ok: false, fetched: 0, uploaded: 0, deleted: 0, errors: ["正在同步中"], conflicts: [], elapsedMs: 0, reconciled: 0, requeued: 0 };
    this.syncing = true;
    // 同步一开始就清掉上次的遗留错误 + 置「同步中」状态：否则整个同步期间 Dock
    // 一直挂着上次的过时红字，用户以为本次已经失败（2026-10-16 雄哥实测：主窗口
    // 点刷新，Dock 显示上次的 412 错误、按钮转几分钟，最后才弹本次失败）。
    // notify() 只通知不落盘——同步中是瞬时状态，不该写进数据文件。
    this.store.lastError = undefined;
    this.beginSyncing();
    const t0 = Date.now();
    const report: SyncReport = {
      ok: true,
      fetched: 0,
      uploaded: 0,
      deleted: 0,
      errors: [],
      conflicts: [],
      elapsedMs: 0,
      notes: [],
      reconciled: 0,
      requeued: 0,
      uploadedKeys: [],
      deletedKeys: []
    };
    try {
      // 多账户（2026-10-25）：逐个启用账户过一遍。单个账户的配置问题或网络失败
      // 只记一条**带账户名**的错误，其他账户照常同步 —— 不能一个账户密码错了
      // 就把另一个好的账户也带停。
      const accounts = enabledAccounts(this.store.settings);
      if (!accounts.length) {
        report.ok = false;
        report.errors.push("没有启用的账户");
        this.store.lastError = "没有启用的账户";
        return report;
      }
      let anyCals = false;
      for (const acc of accounts) {
        const accCals = (acc.calendars || []).filter((c) => c.enabled);
        if (!accCals.length) continue; // 该账户没有启用日历：跳过（不算错误）
        anyCals = true;
        // 凭据缺失时给该账户一条明确错误，其他账户继续
        const credErr = this.accountCredentialError(acc);
        if (credErr) {
          report.ok = false;
          report.errors.push(`账户「${acc.name}」：${credErr}`);
          continue;
        }
        // 服务器地址改过、但日历地址没跟着更新 → 该账户明确报错。
        // 否则会静默地去连旧服务器并「同步成功」，让用户以为新地址是可用的。
        const stale = staleCalendarNames(acc.serverUrl, accCals);
        if (stale.length) {
          report.ok = false;
          report.errors.push(
            `账户「${acc.name}」服务器地址已变更，以下日历仍指向旧地址，请到设置里重新「发现日历」：${stale.join("、")}`
          );
          continue;
        }
        // 同步窗口按账户（不同服务器的时间范围本就该能各设各的）
        const rangeStart = Date.now() - acc.pastDays * 86400000;
        const rangeEnd = Date.now() + acc.futureDays * 86400000;

        // 0. 补齐日历能力（supported-calendar-component-set）。老配置里的
        //    supportsEvent/Todo 是「没问过服务端」时的缺省值（全 true），会把 iCloud
        //    的提醒事项集合误判成也收 VEVENT。必须在推送**之前**弄清，否则 403 降级
        //    可能对着一个根本不支持目标类型的集合做删旧建新（2026-10-24 事故）。
        await this.ensureCalendarCapabilities(acc);

        // 1. 先上传本地脏数据（新条目无 etag 直接 PUT；有 etag 带条件）。
        //    走推送队列：与「保存即推」的后台推送串行，避免并发推同一条目触发假 412
        //    （412 的处理是丢弃本地改动，见 enqueuePush 的注释）。
        await this.enqueuePush(() => this.pushDirty(report));

        // 2. 逐日历拉取
        for (const cal of accCals) {
          try {
            let items: CalItem[] = [];
            let deletedHrefs: string[] = [];
            // ⚠️ sync-token 的语义是「服务端截至该 token 时刻的全量，我本地已经全都有了」。
            // 本地若是空的，这个前提就不成立 ⇒ 增量拉取会「正确地」返回 0 条，
            // 于是界面一片空白、日志无报错，而且**不会自愈**（只要服务端没再变动，
            // 那个 token 就一直有效、一直返回 0 条）。reconcile 也兜不住——
            // 它只清理「本地有 href 而服务端没有」的幽灵条目，本地空时无事可做。
            //
            // 触发场景（不止「从备份恢复」一种）：
            //   · 数据文件被云同步覆盖成旧版本 / 被手删
            //   · 换设备、换工作区后本地条目为空但token 还在
            //   · 多端并用同一台服务器时，另一端的进度本端无从知晓
            // 所以做成**通用护栏**而不是只在某条路径清 token：以服务端为准全量拉一次，
            // 拿到条目后 token 会重新写回（tryGetSyncToken），下一轮就恢复增量。
            if (cal.syncToken && this.store.isCalendarLocallyEmpty(cal.url)) {
              cal.syncToken = undefined;
            }
            if (cal.syncToken) {
              try {
                const r = await syncCollection(cal, this.channelOf(acc), this.authOf(acc), cal.syncToken);
                items = r.items;
                deletedHrefs = r.deletedHrefs;
                if (r.syncToken) cal.syncToken = r.syncToken;
              } catch (e: any) {
                // sync-token 失效等，回退全量
                console.warn("[caldav] sync-collection 失败，回退全量:", e?.message);
                cal.syncToken = undefined;
              }
            }
            if (!cal.syncToken) {
              const r = await fetchCalendarItems(
                cal,
                this.channelOf(acc),
                this.authOf(acc),
                icsRangeIso(rangeStart),
                icsRangeIso(rangeEnd)
              );
              items = r.items;
              // 尝试获取 sync-token 供下次增量（RFC 6578：PROPFIND sync-token）
              cal.syncToken = await this.tryGetSyncToken(cal, acc);
            }
            const deletedKeys = deletedHrefs
              .map((h) => this.findKeyByHref(h, cal.url))
              .filter(Boolean) as string[];
            const merged = this.store.mergeServerItems(items, deletedKeys);
            // 「拉取 N 条」取**本地实际写入数**，不能取 items.length ——
            // 自己刚推上去的条目会被服务端当变更推回（自环回显），
            // 取后者会让「新建一条」显示成「上传1 拉取1」（2026-10-10 实测）。
            report.fetched += merged.applied;
            // 服务端删掉的条目（deletedKeys 命中的）也算「本地删除」——
            // 少了这个计数，用户在另一端删除后同步会看到「删除 0 条」，
            // 以为删除没同步过来（2026-10-10 实测）。
            report.deleted += merged.removed;
            // 拉取成功了才做对账 —— 上一步抛错说明与服务端的对话不完整，
            // 此时拿到的清单不可信，宁可这一轮不做（见 reconcile 的安全约束）
            await this.reconcile(cal, acc, report);
          } catch (e: any) {
            report.ok = false;
            report.errors.push(`账户「${acc.name}」/ ${cal.displayName}: ${explainError(e)}`);
          }
        }
      }
      if (!anyCals) {
        report.ok = false;
        report.errors.push("没有启用的日历");
        this.store.lastError = "没有启用的日历";
        return report;
      }

      // 3. 已删除条目已在 pushDirty 中处理（成功后即从本地移除），此处不再重复 DELETE

      // 使用本地时区墙上时间（东八区等），避免 toISOString() 输出 UTC 导致显示偏差
      this.store.lastSync = stampOfMs(Date.now()).replace("T", " ");
      // 合并「自上次全量同步以来的即时推送」：单条新建/编辑/删除走 pushAndPersist
      // 立刻上云，成功的条目 key 攒在 pending 里。这里并进报告，用户才能看到
      // 「上传 1 / 删除 1」，而不是以为改动没同步（2026-10-10 实测）。
      // **按条目取并集**：本轮推送与历史即时推送可能推同一条目（编辑→即时推送
      // 成功→再编辑→本轮又推），同一条目只计一条（2026-10-19 雄哥实测：同一
      // 事件打勾/编辑几次，同步就报「上传 N 条」——虚胖，此处修）。
      const upKeys = new Set([...(report.uploadedKeys ?? []), ...this.store.pendingUploadedKeys]);
      report.uploaded = upKeys.size;
      const delKeys = new Set([...(report.deletedKeys ?? []), ...this.store.pendingDeletedKeys]);
      // report.deleted 此刻 = 本轮推送删除数 + 跟随服务端删除数（merged.removed）；
      // 把「本轮推送删除」换成去重口径，跟随服务端删除那部分原样保留
      report.deleted = report.deleted - (report.deletedKeys?.length ?? 0) + delKeys.size;
      // 合并后清零，避免下一轮重复计
      this.store.pendingUploadedKeys = [];
      this.store.pendingDeletedKeys = [];
      // 对账是**正常自愈，不是失败**（2026-10-10 实测：原先塞进 lastError，
      // Dock 状态栏显示「同步失败」、面板挂红色报错横幅，把一次成功同步报成失败）。
      // 「本地凭空少了 N 条」仍要让用户看得见，故走独立的中性提示通道。
      const notes: string[] = [...(report.notes || [])];
      if (report.reconciled) notes.push(`对账：已清理 ${report.reconciled} 条服务端不存在的本地条目`);
      if (report.requeued) notes.push(`对账：${report.requeued} 条本地条目在服务端已丢失，已重新上传`);
      this.store.lastNote = [...notes, ...report.conflicts].join("; ") || undefined;
      this.store.lastError = report.errors.join("; ") || undefined;
    } catch (e: any) {
      // 兜底：try 内部若抛出未捕获的异常（例如 pushDirty 直接抛错），原先会跳过上面两行赋值，
      // 于是 lastError 保持旧值（空）→ 界面继续显示「上次同步 XX」，看起来像同步成功了。
      report.ok = false;
      if (!report.errors.length) report.errors.push(explainError(e));
      this.store.lastError = report.errors.join("; ");
      // 这一轮没能正常走完，对账结论不可信 → 清掉上一轮的中性提示，避免过期信息一直挂着
      this.store.lastNote = undefined;
    } finally {
      this.syncing = false;
      this.endSyncing();
      report.elapsedMs = Date.now() - t0;
      await this.store.persist();
      // 通知订阅者（Dock 状态栏等）刷新，否则自动同步失败时界面不会更新
      this.store.notify();
    }
    return report;
  }

  /** 单个账户的凭据不可用提示（密码为空/解密失败），避免静默 401 */
  private accountCredentialError(acc: CalAccount): string | undefined {
    if (!acc.serverUrl) return "未配置服务器地址";
    if (!acc.username) return "未填写用户名";
    if (this.store.pendingUnlock) return "密码待解密（密钥尚未就绪），稍后会自动重试";
    if (this.store.secretBroken) return "密码解不开（密文可能来自另一台设备），请在设置中重新输入密码";
    if (!acc.password) return "未填写密码，请在设置中填写";
    return undefined;
  }

  private findKeyByHref(href: string, calUrl: string): string | undefined {
    const norm = (u: string) => decodeURIComponent(u).replace(/\/+$/, "");
    for (const it of this.store.getAll()) {
      if (norm(it.href) === norm(href) && it.calendarUrl === calUrl) {
        return keyOf(it);
      }
    }
    return undefined;
  }

  private async tryGetSyncToken(cal: import("./types").CalCalendar, acc?: CalAccount): Promise<string | undefined> {
    try {
      const res = await httpRequest(
        cal.url,
        {
          method: "PROPFIND",
          headers: { "Content-Type": "application/xml; charset=utf-8", Depth: "0" },
          body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:sync-token/></D:prop></D:propfind>`,
          timeoutMs: 15000
        },
        this.channelOf(acc),
        this.authOf(acc)
      );
      if (res.status >= 400) return undefined;
      const m = /<(?:[A-Za-z0-9_-]+:)?sync-token[^>]*>([^<]*)</.exec(res.body);
      return m ? m[1].trim() || undefined : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 幽灵条目对账：清掉「服务端早已不存在、本地却以为已同步」的条目。
   *
   * 为什么必须专门做这件事（2026-10-08 实测确认过 4 条）：
   *   · 本地条目只要 `etag` 有值就会 `dirty=false` → `pushDirty` 永远跳过它；
   *   · `mergeServerItems` 只在 `deletedKeys` 里删本地，而 `deletedKeys`
   *     **只有增量 sync-collection 路径才产出**；sync-token 一旦失效回退全量
   *     `fetchCalendarItems`，它恒为空。
   * 结果是服务端删过的条目在本地永久残留：思源里看着完全正常，严格跟随服务端的
   * 别的客户端（如 Obsidian）却永远看不到，而且它再也不会被重传。
   *
   * 覆盖范围取「该日历集合的完整资源清单」（PROPFIND Depth:1），与 sync-token、
   * time-range 都无关 —— 事件与待办一视同仁，不必去算查询窗口。
   *
   * 安全约束（三条，都是「宁可漏判，不可误删」）：
   *   ① 清单拿不到（PROPFIND 失败/非 207）→ 直接跳过，**绝不**当成「服务端为空」；
   *   ② 清单为空而本地有条目 → 多半是路径或权限不对，同样跳过；
   *   ③ 只处理本地**不脏**的条目 —— 脏条目本来就在等上传，不能被判成幽灵。
   *
   * 处理方式跟随该日历所属账户的 `conflict`：服务端优先 → 删本地；本地优先 → 置脏重传。
   */
  private async reconcile(cal: import("./types").CalCalendar, acc: CalAccount | undefined, report: SyncReport): Promise<void> {
    let names: string[];
    try {
      names = await listResourceNames(cal, this.channelOf(acc), this.authOf(acc));
    } catch (e: any) {
      console.warn(`[caldav] ${cal.displayName}: 资源清单对账跳过（${explainError(e)}）`);
      return;
    }
    const onServer = new Set(names);
    const candidates = this.store
      .getAll()
      .filter((it) => it.calendarUrl === cal.url && !it.deleted && !it.dirty && !!it.href);
    // 服务端一条都没有、本地却有一堆 —— 大概率是查询打到了错地方，别据此清空本地
    if (!onServer.size && candidates.length) {
      console.warn(`[caldav] ${cal.displayName}: 服务端清单为空但本地有 ${candidates.length} 条，跳过对账`);
      return;
    }
    const ghosts = candidates.filter((it) => !onServer.has(fileNameOf(it.href)));
    if (!ghosts.length) return;
    if ((acc?.conflict || "server") === "local") {
      // 本地优先：认定是服务端把它弄丢了，重新上传
      for (const it of ghosts) {
        it.dirty = true;
        report.requeued++;
      }
      console.warn(`[caldav] ${cal.displayName}: ${ghosts.length} 条本地条目在服务端已不存在，将重新上传`);
      return;
    }
    // 服务端优先：跟随服务端删除（与用户在设置里选的口径一致）
    for (const it of ghosts) {
      this.store.remove(keyOf(it));
      report.reconciled++;
      // 对账清理掉的条目，本地确实少了一条 → 同样计入「删除」，
      // 否则用户在另一端删除后同步，本地条目消失了却报「删除 0 条」。
      report.deleted++;
    }
    console.warn(`[caldav] ${cal.displayName}: 已清理 ${ghosts.length} 条服务端不存在的本地条目`);
  }

  /**
   * 补齐尚未探测过的日历能力（`supported-calendar-component-set`）。
   *
   * 只在缺 `componentSetProbed` 标记时发一次 Depth-0 PROPFIND，探测失败就保持原值
   * （宁可当支持，也绝不因为探测失败禁用日历）。探测成功后写标记并落盘设置。
   */
  private async ensureCalendarCapabilities(acc: CalAccount): Promise<void> {
    const todo = (acc.calendars || []).filter((c) => c.enabled && !c.componentSetProbed);
    if (!todo.length) return;
    let dirty = false;
    for (const cal of todo) {
      const r = await probeCalendarComponents(cal, this.channelOf(acc), this.authOf(acc));
      if (!r) continue; // 探测失败：保留原值，下轮再试
      cal.supportsEvent = r.supportsEvent;
      cal.supportsTodo = r.supportsTodo;
      cal.componentSetProbed = true;
      dirty = true;
    }
    if (dirty) await this.store.persist();
  }

  /**
   * 上传成功后清掉「搬家」留下的旧资源（原日历里的那份）。
   *
   * 顺序铁律：**先 PUT 新地址、成功后再删旧地址**（见 pushDirty 403 分支注释）。
   * 删除失败只记中性提示——条目已安全落在新地址，不该为此把整次同步报成失败，
   * 也不留 movedFrom 反复重试（否则每轮都弹同一条提示）。
   */
  private async deleteMovedFrom(item: CalItem, report: SyncReport): Promise<void> {
    const from = item.movedFrom;
    item.movedFrom = undefined; // 无论成败都清，避免下一轮重复处理
    if (!from?.href || from.href === item.href) return;
    // 原资源可能在**另一个账户**的日历里（换日历搬家）→ 用原集合地址反查账户
    const acc = this.accountOf(from.calendarUrl || item.calendarUrl);
    try {
      await deleteItem({ ...item, href: from.href, etag: from.etag }, this.channelOf(acc), this.authOf(acc));
    } catch {
      // If-Match 对不上（旧资源被别处改过）时无条件再删一次；仍失败就只提示
      try {
        await deleteItem({ ...item, href: from.href, etag: undefined }, this.channelOf(acc), this.authOf(acc));
      } catch {
        report.notes = report.notes || [];
        report.notes.push(`「${item.summary}」已保存到新位置，原位置的那份未能删除，请到服务端手动清理`);
      }
    }
  }

  private async pushDirty(report: SyncReport): Promise<void> {
    // 新建 / 修改
    for (const item of this.store.dirtyItems()) {
      // 该条目所属账户（凭据/通道/冲突策略都按它来；反查不到时回退第一个启用账户）
      const acc = this.accountOf(item.calendarUrl);
      try {
        // iCloud 托管附件预上传：把仍是内联 base64 的件逐个 POST 进 iCloud 托管
        // 存储，就地改写成托管 URI（uri + managedId），随后的序列化只写
        // `ATTACH;MANAGED-ID="<id>":<uri>` —— iCloud 对内联二进制回 507（实测），
        // 托管形态是苹果官方路径。非 iCloud 服务器直接跳过（return 无副作用）。
        await this.uploadIcloudAttachments(item);
        const ics = item.raw ? itemToEditedICS(item) : itemToNewICS(item);
        const r = await putItem(item, ics, this.channelOf(acc), this.authOf(acc), acc?.icsSizeMaxMB);
        item.etag = r.etag;
        item.dirty = false;
        item.raw = item.raw || ics; // 新建后保留原文
        report.uploaded++;
        report.uploadedKeys?.push(keyOf(item));
        await this.deleteMovedFrom(item, report);
      } catch (e: any) {
        if (e?.status === 412) {
          if ((acc?.conflict || "server") === "local") {
            // 本地优先：强制覆盖（去掉 If-Match）
            const keep = item.etag;
            item.etag = undefined;
            try {
              // 与上面同一判据：有原文才走增量改写，否则整份重拼会丢掉
              // 服务端的 ATTACH / ORGANIZER / VTIMEZONE 等未管理属性。
              const ics = item.raw ? itemToEditedICS(item) : itemToNewICS(item);
              const r = await putItem(item, ics, this.channelOf(acc), this.authOf(acc), acc?.icsSizeMaxMB);
              item.etag = r.etag || keep;
              item.dirty = false;
              report.uploaded++;
              report.uploadedKeys?.push(keyOf(item));
              await this.deleteMovedFrom(item, report);
              continue;
            } catch (e2: any) {
              report.errors.push(`覆盖 ${item.summary}: ${explainError(e2)}`);
            }
          } else {
            // 服务端优先：丢弃本地改动。**必须同时清 etag** —— 上面只清了 dirty、
            // 没回滚字段（percent 等还是本地乐观值），若留着旧 etag，下一轮拉取会因
            // 「字段恰好相同」走 mergeServerItems 的 same 分支仍不纠正，UI 一直挂假状态
            // （显示打勾成功、服务端却没改）。清空 etag 后，同一轮 syncAll 随后的拉取会
            // 无条件以服务端版本覆盖本地，把假完成态纠正回真实值（2026-10-19 雄哥实测：
            // 打勾完成即报「服务端已变更，本地改动已按策略丢弃」，且界面上的勾是假的）。
            item.dirty = false;
            item.etag = undefined;
            report.conflicts.push(`「${item.summary}」服务端已变更，本地改动已按策略丢弃`);
          }
        } else if (e?.status === 400) {
          // body 畸形类 400（iCloud 实测：裸组件 / 缺 VCALENDAR 信封）。根因已修
          // （parseMultistatus 剥离 CDATA + itemToEditedICS 补信封），正常不会再出现；
          // 此分支仅作防御：本地序列化既已畸形，强行再 PUT 只会恒 400 死循环（2026-10-23
          // 雄哥实测刷屏），故按服务端优先清 etag+dirty，下轮 pull 用服务端版本覆盖本地。
          item.dirty = false;
          item.etag = undefined;
          report.errors.push(`「${item.summary}」上传被服务端拒绝（HTTP 400，疑似本地数据损坏），已按策略用服务端版本覆盖本地`);
        } else if (e?.status === 403) {
          // 先看是不是「集合根本不接受这个组件类型」——iCloud 的日历只收 VEVENT、
          // 提醒事项只收 VTODO（RFC 4791 §5.2.3 要求必须拒绝）。这种情形换地址重试
          // 也是白搭，且**绝不能删服务端旧资源**，只给可操作提示让用户换日历。
          // ⚠️ 不要求 item.etag：雄哥那条例外条目被上一版降级清掉了 etag，正是
          //    最需要这条明确提示的场景。
          // 组件类型变更（日程↔待办互转）被服务端拒绝：多数 CalDAV 服务端把资源
          // 的组件类型与 href 绑定校验，对已有 VTODO 资源 PUT VEVENT（或反之）
          // 回 403（RFC 4791 未强制允许原地改类型，2026-10-23 雄哥实测同步报错）。
          //
          // ⚠️ 降级顺序铁律：**先建新的，成功后再删旧的**。2026-10-24 之前是反的
          // （先 DELETE 再 PUT），结果 iCloud 提醒事项集合重建 VEVENT 仍被 403 →
          // 旧待办已被删、新的又建不回来，服务端那条直接没了（雄哥实测「测试任务」）。
          // 改成先 PUT 同集合下的另一个文件名：新建失败则服务端分毫不动，可安全重试。
          const cal = this.findCalendarByUrl(item.calendarUrl);
          // 目标类型在该集合根本不被支持（如 iCloud 提醒事项只收 VTODO）→ 换 URI 也
          // 必败，别白折腾，直接给可操作的错误提示（互转时应在编辑器里换日历，见
          // editor.ts 的 convert 处理）。
          const targetSupported =
            item.kind === "event" ? cal?.supportsEvent !== false : cal?.supportsTodo !== false;
          if (!targetSupported) {
            report.ok = false;
            report.errors.push(
              `「${item.summary}」所在日历不支持${item.kind === "event" ? "日程" : "待办"}，` +
                `服务端拒绝保存（403）。请在编辑器里把它换到支持该类型的日历再保存`
            );
            continue;
          }
          // ⚠️ 不看 item.etag 一律走下面的换地址重试：搬家后的条目 etag 本来就是空的，
          //    而 403 还有一种「URL 归档污染」形态——2026-10-24 实测 iCloud 报
          //    `invalid attempt to update record from type 'EventArchiveV1' to
          //    'ReminderArchiveV1'`：同一地址先 DELETE 再 PUT 另一种组件类型后，
          //    iCloud 会给这个地址留一条旧类型的归档记录，之后向它 PUT 新类型永远
          //    403（内容相同换任意新文件名都 201）。换地址是非破坏性的，失败再报错。
          const oldHref = item.href;
          const altHref = altHrefOf(oldHref, item.uid);
          try {
            const ics = item.raw ? itemToEditedICS(item) : itemToNewICS(item);
            const r = await putItem({ ...item, href: altHref, etag: undefined }, ics, this.channelOf(acc), this.authOf(acc), acc?.icsSizeMaxMB);
            item.href = altHref;
            item.etag = r.etag;
            item.dirty = false;
            item.raw = item.raw || ics;
            report.uploaded++;
            report.uploadedKeys?.push(keyOf(item));
            // 新建成功才删旧的：删不掉只提示，条目本身已安全落在新地址上
            try {
              await deleteItem({ ...item, href: oldHref }, this.channelOf(acc), this.authOf(acc));
            } catch {
              report.notes = report.notes || [];
              report.notes.push(`「${item.summary}」已保存到新地址，旧地址的那份未能删除，请到服务端手动清理`);
            }
            // 换地址重试成功同样要清搬家残留（换日历场景 movedFrom 还指着原日历那份）
            await this.deleteMovedFrom(item, report);
          } catch (e2: any) {
            report.ok = false;
            report.errors.push(`上传 ${item.summary}: ${explainError(e2)}`);
          }
        } else {
          report.ok = false;
          report.errors.push(`上传 ${item.summary}: ${explainError(e)}`);
        }
      }
    }
    // 删除
    for (const item of this.store.deletedItems()) {
      const acc = this.accountOf(item.calendarUrl);
      try {
        await deleteItem(item, this.channelOf(acc), this.authOf(acc));
        report.deleted++;
        // 删除成功后从本地移除，否则每次同步都会重复发 DELETE
        report.deletedKeys?.push(keyOf(item));
        this.store.remove(keyOf(item));
      } catch (e: any) {
        if (e?.status === 412) {
          // If-Match 没对上：服务端那份在我们记录之后被改过（别的客户端改的、
          // 或服务端重建导致 etag 变化）。**与上传同样按冲突策略分叉** ——
          // 2026-10-15 之前这里什么都不做，条目卡在 deleted+dirty，每轮同步
          // 重发 DELETE 再 412，同一个「删除失败」永远报不完（雄哥实测：
          // 任务测试Z 已从本地删除，远端因 etag 对不上删不掉，错误无限循环）。
          if ((acc?.conflict || "server") === "local") {
            // 本地优先：用户明确要删，去掉 If-Match 无条件删
            try {
              await deleteItem({ ...item, etag: undefined }, this.channelOf(acc), this.authOf(acc));
              report.deleted++;
              report.deletedKeys?.push(keyOf(item));
              this.store.remove(keyOf(item));
              continue;
            } catch (e2: any) {
              report.errors.push(`删除 ${item.summary}: ${explainError(e2)}`);
            }
          } else {
            // 服务端优先：撤销本地删除，按服务端版本留档。清 etag + dirty，
            // 下一轮拉取（etag 不同 → 写入）会把服务端当前版本带回来。
            item.deleted = false;
            item.dirty = false;
            item.etag = undefined;
            report.conflicts.push(
              `「${item.summary}」服务端已变更，删除未执行，已按策略恢复服务端版本（如仍要删除，把冲突策略改为「本地优先」后重试）`
            );
          }
        } else {
          report.ok = false;
          report.errors.push(`删除 ${item.summary}: ${explainError(e)}`);
        }
      }
    }
  }

  /**
   * iCloud 托管附件预上传：把 item.attachments 里仍是内联 base64 的件，逐个 POST 到
   * iCloud 的 add-attachment 端点，就地改写成托管 URI（uri + managedId）、清掉 b64。
   * 改写后 pushDirty 的序列化写出 `ATTACH;MANAGED-ID="<id>":<uri>`，ICS 里不再
   * 内联二进制，iCloud 不再 507。非 iCloud 服务器直接跳过。
   *
   * 新建条目（href 已由编辑器定好、但服务端还没有资源、etag 为空）要先建一份
   * **不含内联二进制**的资源拿到 etag，add-attachment 与最终 PUT 才有目标；
   * 已存在的条目（有 etag）直接 POST。
   *
   * ⚠️ 上传失败会抛错 → pushDirty 记错误、条目保持 dirty 下轮重试，b64 不会被
   *    清掉，数据不会坏。重试时已上传的件其 b64 已被改写，inline 过滤为空，
   *    不会重复上传（幂等）。
   */
  private async uploadIcloudAttachments(item: CalItem): Promise<void> {
    const acc = this.accountOf(item.calendarUrl);
    if (acc?.serverType !== "icloud") return;
    if (!item.attachments?.length) return;
    const inline = item.attachments.filter((a) => (a.b64 || "").trim());
    if (!inline.length) return;
    // 新建条目：服务端还没有资源，add-attachment 没处 POST。先建一份不含内联
    // 二进制的资源（URI 外链保留），拿到 etag，后续 add-attachment 与最终 PUT
    // 才有目标。过滤副本只影响这一次预上传的序列化，不动 item.attachments 本身。
    if (!item.href || !item.etag) {
      const draft: CalItem = {
        ...item,
        attachments: item.attachments.filter((a) => !(a.b64 || "").trim())
      };
      const ics0 = item.raw ? itemToEditedICS(draft) : itemToNewICS(draft);
      const r0 = await putItem(item, ics0, this.channelOf(acc), this.authOf(acc), acc?.icsSizeMaxMB);
      item.etag = r0.etag;
      item.raw = item.raw || ics0;
    }
    // 上传前就已托管的 MANAGED-ID 集合：iCloud 回 GET 认领「新传的那个」时扣减用；
    // 每成功传一个就补进集合，多个附件排队上传时不会认领错（见 caldav.ts 扣减法）。
    const known = new Set(item.attachments.map((a) => a.managedId).filter((v): v is string => !!v));
    for (const a of inline) {
      const bytes = base64ToBytes(a.b64!);
      const r = await uploadIcloudAttachment(
        item,
        bytes,
        a.name || "attachment",
        a.fmttype || "application/octet-stream",
        this.channelOf(acc),
        this.authOf(acc),
        [...known]
      );
      a.uri = r.uri;
      a.managedId = r.managedId;
      a.b64 = undefined;
      known.add(r.managedId);
      // add-attachment 会改变服务端资源的 etag（iCloud 连响应体都不给，只能从
      // 回 GET 的 ETag 头拿）。不更新的话 pushDirty 随后那次 PUT 带旧 etag 必 412，
      // 条目永远 dirty、每轮同步重传——2026-10-22 雄哥实测踩坑后的修复。
      if (r.etag) item.etag = r.etag;
    }
  }

  /**
   * 取回托管附件（iCloud 等）的原始字节，供编辑器下载。
   * 走传输层、保留鉴权；`responseEncoding: "base64"` 保证二进制不被 utf8 文本化破坏
   * （>0x7F 字节会被换成 U+FFFD）。auto 通道内核代理优先，也顺带绕开 CORS。
   *
   * `fromUrl` 为条目所属日历（用于反查账户）；缺省时按 URL 在已配置日历里找。
   */
  async fetchAttachmentBytes(url: string, fromUrl?: string): Promise<Uint8Array> {
    // iCloud 托管附件的下载 URI 在 gateway.icloud.com（预签名：路径尾部自带
    // token），**带 Authorization 反而 500**（2026-10-23 真机实测：带 auth 500、
    // 不带 200 且 256 字节 0x00-0xFF 原样回；直连带 auth 同样 500，与通道无关）。
    // 同主机的托管附件（自建服务器）才需要 auth，按主机是否相同决定带不带。
    const acc = this.accountOf(fromUrl || "");
    const serverUrl = acc?.serverUrl || "";
    let crossHost = false;
    try {
      crossHost = new URL(url).host !== new URL(serverUrl).host;
    } catch {
      crossHost = false; // URL 解析不了时保守带 auth（自建服务器场景）
    }
    const res = await httpRequest(
      url,
      { method: "GET", responseEncoding: "base64" },
      this.channelOf(acc),
      crossHost ? undefined : this.authOf(acc)
    );
    if (res.status >= 400) throw new Error(`下载附件失败: HTTP ${res.status}`);
    if (res.bytes && res.bytes.length) return res.bytes;
    return new TextEncoder().encode(res.body); // 兜底（纯文本类附件）
  }

  /** 新建条目（先入本地并标记脏，立即上传） */
  async createItem(item: CalItem): Promise<void> {
    item.dirty = true;
    this.store.putAndEmit(item);
    // 先落盘再上传：编辑器保存后不再等上传完成就关窗（见 editor.ts 保存按钮），
    // 这一行保证「上传还在后台排队」时改动也已经安全写在磁盘上。
    await this.store.persist();
    await this.pushAndPersist();
  }

  /** 更新条目 */
  async updateItem(item: CalItem): Promise<void> {
    item.dirty = true;
    this.store.putAndEmit(item);
    await this.store.persist();
    await this.pushAndPersist();
  }

  /** 删除条目：标记后同步删除 */
  async removeItem(item: CalItem): Promise<void> {
    item.deleted = true;
    item.dirty = true;
    this.store.putAndEmit(item);
    await this.store.persist();
    await this.pushAndPersist();
  }

  /**
   * 推送队列：所有上传/删除**串行**过这条链。
   *
   * 为什么需要：编辑器保存后立刻关窗、上传在后台跑（服务器卡死时不能把窗口
   * 冻住），连点两下保存就会有两条 pushDirty 并发推同一条目 —— 第二条拿着
   * 第一条还没更新的旧 etag 发 If-Match，服务端返 412，而 412 的处理是
   * 「服务端优先 → 丢弃本地改动」，用户的第二次编辑就这么被静默丢掉了。
   * syncAll 的第一步推送也走这条链，同理。
   */
  private pushChain: Promise<void> = Promise.resolve();
  private enqueuePush<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.pushChain.then(fn);
    // 单次失败不能把队列本身断掉
    this.pushChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  private pushAndPersist(): Promise<void> {
    return this.enqueuePush(() => this.doPushAndPersist());
  }

  private async doPushAndPersist(): Promise<void> {
    // 「保存即推」也要让界面转起来：用户新建/编辑/勾选完要看到「已经上云了」，
    // 与手动点同步同一套可见状态（2026-10-25 雄哥要求）。此前这条路不置
    // store.syncing，按钮只有在手动点同步时才转，用户以为改动还没提交。
    this.beginSyncing();
    // 单条上传/删除后立即落盘。**不做对账** —— 刚建的条目此刻还没被服务端列进清单，
    // 拿去比对只会把它误判成幽灵。
    const report: SyncReport = {
      ok: true,
      fetched: 0,
      uploaded: 0,
      deleted: 0,
      errors: [],
      conflicts: [],
      elapsedMs: 0,
      reconciled: 0,
      requeued: 0,
      uploadedKeys: [],
      deletedKeys: []
    };
    try {
      await this.pushDirty(report);
      // 这一轮的成功不能就这么丢掉 —— 用户随后点全量同步时已无事可做，
      // 会看到「上传 0 · 删除 0」，以为改动没同步（2026-10-10 实测）。
      // **按条目 key 去重攒**：同一条目被编辑 N 次会推 N 次，按轮次累加会让
      // 同步报告虚报「上传 N 条」（2026-10-19 雄哥实测：操作几次就报上传几次）。
      for (const k of report.uploadedKeys ?? []) this.store.markUploaded(k);
      for (const k of report.deletedKeys ?? []) this.store.markDeleted(k);
      // 立刻给一次反馈：用户点完保存/删除要看得到「已经上云了」
      const pushed: string[] = [];
      if (report.uploaded) pushed.push(`已同步到服务端：上传 ${report.uploaded} 条`);
      if (report.deleted) pushed.push(`已同步到服务端：删除 ${report.deleted} 条`);
      const noteParts = [...pushed, ...report.conflicts];
      if (noteParts.length) this.store.lastNote = noteParts.join("; ");
      this.store.lastError = report.errors.length ? report.errors.join("; ") : this.store.lastError;
      await this.store.persist();
      this.store.notify();
    } finally {
      // 放在 persist/notify 之后：最后一次通知让界面直接看到终态
      //（syncing 已复位 + lastNote 已更新），少一次中间态闪烁。
      this.endSyncing();
    }
  }
}

export { dateStampOfMs };
