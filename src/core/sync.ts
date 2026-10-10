/**
 * 双向同步引擎：
 * - 拉取：优先 sync-collection 增量，回退 calendar-query 全量
 * - 上传：本地脏条目 PUT（带 If-Match），412 冲突按策略处理
 * - 删除：本地 deleted 标记 -> 服务端 DELETE
 */
import type { CalItem } from "./types";
import { keyOf, type CalStore } from "./store";
import {
  syncCollection,
  fetchCalendarItems,
  putItem,
  deleteItem,
  icsRangeIso,
  listResourceNames,
  fileNameOf,
  type DavAuth
} from "./caldav";
import { httpRequest } from "./http";
import { itemToEditedICS, itemToNewICS } from "./ics";
import { dateStampOfMs, stampOfMs } from "./date";
import type { Channel } from "./http";

export interface SyncReport {
  ok: boolean;
  fetched: number;
  uploaded: number;
  deleted: number;
  errors: string[];
  elapsedMs: number;
  /** 对账清掉的「幽灵条目」数（本地有、服务端早已不存在，见 reconcile） */
  reconciled: number;
  /** 对账判定「服务端丢了」并重新上传的条目数（conflict === "local" 时） */
  requeued: number;
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

export class SyncEngine {
  private syncing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: CalStore,
    private getChannel: () => Channel
  ) {}

  private auth(): DavAuth {
    return { username: this.store.settings.username, password: this.store.settings.password };
  }

  private channel(): Channel {
    return this.getChannel();
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
      return { ok: false, fetched: 0, uploaded: 0, deleted: 0, errors: ["正在同步中"], elapsedMs: 0, reconciled: 0, requeued: 0 };
    this.syncing = true;
    const t0 = Date.now();
    const report: SyncReport = {
      ok: true,
      fetched: 0,
      uploaded: 0,
      deleted: 0,
      errors: [],
      elapsedMs: 0,
      reconciled: 0,
      requeued: 0
    };
    try {
      // 凭据缺失时直接给出明确错误，不再发无效请求、也不再显示“同步成功”
      const credErr = this.credentialError();
      if (credErr) {
        report.ok = false;
        report.errors.push(credErr);
        this.store.lastError = credErr;
        return report;
      }
      const enabledCals = this.store.settings.calendars.filter((c) => c.enabled);
      if (!enabledCals.length) {
        report.ok = false;
        report.errors.push("没有启用的日历");
        this.store.lastError = "没有启用的日历";
        return report;
      }
      // 服务器地址改过、但日历地址没跟着更新 → 明确报错。
      // 否则会静默地去连旧服务器并「同步成功」，让用户以为新地址是可用的。
      const stale = staleCalendarNames(this.store.settings.serverUrl, enabledCals);
      if (stale.length) {
        const msg = `服务器地址已变更，以下日历仍指向旧地址，请到设置里重新「发现日历」：${stale.join("、")}`;
        report.ok = false;
        report.errors.push(msg);
        this.store.lastError = msg;
        return report;
      }
      const rangeStart = Date.now() - this.store.settings.pastDays * 86400000;
      const rangeEnd = Date.now() + this.store.settings.futureDays * 86400000;

      // 1. 先上传本地脏数据（新条目无 etag 直接 PUT；有 etag 带条件）
      await this.pushDirty(report);

      // 2. 逐日历拉取
      for (const cal of this.store.settings.calendars) {
        if (!cal.enabled) continue;
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
              const r = await syncCollection(cal, this.channel(), this.auth(), cal.syncToken);
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
              this.channel(),
              this.auth(),
              icsRangeIso(rangeStart),
              icsRangeIso(rangeEnd)
            );
            items = r.items;
            // 尝试获取 sync-token 供下次增量（RFC 6578：PROPFIND sync-token）
            cal.syncToken = await this.tryGetSyncToken(cal);
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
          await this.reconcile(cal, report);
        } catch (e: any) {
          report.ok = false;
          report.errors.push(`${cal.displayName}: ${explainError(e)}`);
        }
      }

      // 3. 已删除条目已在 pushDirty 中处理（成功后即从本地移除），此处不再重复 DELETE

      // 使用本地时区墙上时间（东八区等），避免 toISOString() 输出 UTC 导致显示偏差
      this.store.lastSync = stampOfMs(Date.now()).replace("T", " ");
      // 合并「自上次全量同步以来的即时推送」：单条新建/编辑/删除走 pushAndPersist
      // 立刻上云，计数攒在 pending 里。这里并进报告，用户才能看到「上传 1 / 删除 1」，
      // 而不是以为改动没同步（2026-10-10 实测）。合并后清零，避免下一轮重复计。
      report.uploaded += this.store.pendingUploaded;
      report.deleted += this.store.pendingDeleted;
      this.store.pendingUploaded = 0;
      this.store.pendingDeleted = 0;
      // 对账是**正常自愈，不是失败**（2026-10-10 实测：原先塞进 lastError，
      // Dock 状态栏显示「同步失败」、面板挂红色报错横幅，把一次成功同步报成失败）。
      // 「本地凭空少了 N 条」仍要让用户看得见，故走独立的中性提示通道。
      const notes: string[] = [];
      if (report.reconciled) notes.push(`对账：已清理 ${report.reconciled} 条服务端不存在的本地条目`);
      if (report.requeued) notes.push(`对账：${report.requeued} 条本地条目在服务端已丢失，已重新上传`);
      this.store.lastNote = notes.join("; ") || undefined;
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
      report.elapsedMs = Date.now() - t0;
      await this.store.persist();
      // 通知订阅者（Dock 状态栏等）刷新，否则自动同步失败时界面不会更新
      this.store.notify();
    }
    return report;
  }

  /** 凭据不可用时的统一提示（密码为空/解密失败），避免静默 401 */
  private credentialError(): string | undefined {
    const s = this.store.settings;
    if (!s.serverUrl) return "未配置服务器地址";
    if (!s.username) return "未填写用户名";
    if (this.store.pendingUnlock) return "密码待解密（密钥尚未就绪），稍后会自动重试";
    if (this.store.secretBroken) return "密码解不开（密文可能来自另一台设备），请在设置中重新输入密码";
    if (!s.password) return "未填写密码，请在设置中填写";
    return undefined;
  }

  private findKeyByHref(href: string, calUrl: string): string | undefined {
    const norm = (u: string) => decodeURIComponent(u).replace(/\/+$/, "");
    for (const it of this.store.getAll()) {
      if (norm(it.href) === norm(href) && it.calendarUrl === calUrl) {
        return it.recurId ? `${it.uid}|${it.recurId}|${it.kind}` : `${it.uid}|${it.kind}`;
      }
    }
    return undefined;
  }

  private async tryGetSyncToken(cal: import("./types").CalCalendar): Promise<string | undefined> {
    try {
      const res = await httpRequest(
        cal.url,
        {
          method: "PROPFIND",
          headers: { "Content-Type": "application/xml; charset=utf-8", Depth: "0" },
          body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:sync-token/></D:prop></D:propfind>`,
          timeoutMs: 15000
        },
        this.channel(),
        this.auth()
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
   * 处理方式跟随 `settings.conflict`：服务端优先 → 删本地；本地优先 → 置脏重传。
   */
  private async reconcile(cal: import("./types").CalCalendar, report: SyncReport): Promise<void> {
    let names: string[];
    try {
      names = await listResourceNames(cal, this.channel(), this.auth());
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
    if (this.store.settings.conflict === "local") {
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

  private async pushDirty(report: SyncReport): Promise<void> {
    // 新建 / 修改
    for (const item of this.store.dirtyItems()) {
      try {
        const ics = item.raw ? itemToEditedICS(item) : itemToNewICS(item);
        const r = await putItem(item, ics, this.channel(), this.auth());
        item.etag = r.etag;
        item.dirty = false;
        item.raw = item.raw || ics; // 新建后保留原文
        report.uploaded++;
      } catch (e: any) {
        if (e?.status === 412) {
          if (this.store.settings.conflict === "local") {
            // 本地优先：强制覆盖（去掉 If-Match）
            const keep = item.etag;
            item.etag = undefined;
            try {
              const ics = itemToEditedICS(item);
              const r = await putItem(item, ics, this.channel(), this.auth());
              item.etag = r.etag || keep;
              item.dirty = false;
              report.uploaded++;
              continue;
            } catch (e2: any) {
              report.errors.push(`覆盖 ${item.summary}: ${explainError(e2)}`);
            }
          } else {
            // 服务端优先：丢弃本地改动
            item.dirty = false;
            report.errors.push(`「${item.summary}」服务端已变更，本地改动已按策略丢弃`);
          }
        } else {
          report.ok = false;
          report.errors.push(`上传 ${item.summary}: ${explainError(e)}`);
        }
      }
    }
    // 删除
    for (const item of this.store.deletedItems()) {
      try {
        await deleteItem(item, this.channel(), this.auth());
        report.deleted++;
        // 删除成功后从本地移除，否则每次同步都会重复发 DELETE
        this.store.remove(keyOf(item));
      } catch (e: any) {
        report.ok = false;
        report.errors.push(`删除 ${item.summary}: ${explainError(e)}`);
      }
    }
  }

  /** 新建条目（先入本地并标记脏，立即上传） */
  async createItem(item: CalItem): Promise<void> {
    item.dirty = true;
    this.store.putAndEmit(item);
    await this.pushAndPersist();
  }

  /** 更新条目 */
  async updateItem(item: CalItem): Promise<void> {
    item.dirty = true;
    this.store.putAndEmit(item);
    await this.pushAndPersist();
  }

  /** 删除条目：标记后同步删除 */
  async removeItem(item: CalItem): Promise<void> {
    item.deleted = true;
    item.dirty = true;
    this.store.putAndEmit(item);
    await this.pushAndPersist();
  }

  private async pushAndPersist(): Promise<void> {
    // 单条上传/删除后立即落盘。**不做对账** —— 刚建的条目此刻还没被服务端列进清单，
    // 拿去比对只会把它误判成幽灵。
    const report: SyncReport = {
      ok: true,
      fetched: 0,
      uploaded: 0,
      deleted: 0,
      errors: [],
      elapsedMs: 0,
      reconciled: 0,
      requeued: 0
    };
    await this.pushDirty(report);
    // 这一轮的成功数不能就这么丢掉 —— 用户随后点全量同步时已无事可做，
    // 会看到「上传 0 · 删除 0」，以为改动没同步（2026-10-10 实测）。
    // 先攒进 pending，等下一轮 syncAll 合并进报告再清零。
    this.store.pendingUploaded += report.uploaded;
    this.store.pendingDeleted += report.deleted;
    // 立刻给一次反馈：用户点完保存/删除要看得到「已经上云了」
    const pushed: string[] = [];
    if (report.uploaded) pushed.push(`已同步到服务端：上传 ${report.uploaded} 条`);
    if (report.deleted) pushed.push(`已同步到服务端：删除 ${report.deleted} 条`);
    if (pushed.length) this.store.lastNote = pushed.join("; ");
    this.store.lastError = report.errors.length ? report.errors.join("; ") : this.store.lastError;
    await this.store.persist();
    this.store.notify();
  }
}

export { dateStampOfMs };
