/**
 * 本地存储与条目仓库：插件私有数据读写 + 内存索引 + 订阅
 */
import type { CalAttachment, CalItem, CalSettings, PersistData } from "./types";
import { DEFAULT_SETTINGS, normalizeCalendarColors } from "./types";
import {
  adoptKeyring,
  decryptSecretDeep,
  encryptSecret,
  getKeyring,
  isEncrypted,
  isLegacyEncrypted
} from "./secret";
import { sanitizeEtag } from "./caldav";

export interface StoreEnv {
  loadData: () => Promise<any>;
  saveData: (data: any) => Promise<void>;
}

export class CalStore {
  settings: CalSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  private items = new Map<string, CalItem>();
  lastSync?: string;
  lastError?: string;
  /**
   * 同步进行中的瞬时状态（UI 用，**不持久化**——重启后无意义）。
   * syncAll 置位/复位时走 notify() 通知各面板：Dock 与主窗口两条同步入口
   * 由此显示一致的「同步中…」，且同步期间不再挂着上次的过时错误
   * （2026-10-16 雄哥实测：主窗口点刷新后 Dock 显示上次的 412、按钮转几分钟）。
   */
  syncing?: boolean;
  /** 上次同步的中性提示（对账自愈等），**不是错误**，见 types.ts 的 SyncState */
  lastNote?: string;
  /**
   * 即时推送成功上传/删除的**条目 key**（按 key 去重），下一轮 syncAll 合并进
   * 报告后清零。为什么按 key：同一条目被操作 N 次会推 N 次，按推送轮次计数会让
   * 同步报告虚报「上传 N 条」（2026-10-19 雄哥实测），详见 types.ts 的 SyncState。
   */
  pendingUploadedKeys: string[] = [];
  pendingDeletedKeys: string[] = [];
  /** 密码解密失败（本地密钥丢失/损坏），需要用户重新输入密码 */
  secretBroken = false;
  /** 密钥尚未就绪导致的「暂时解不开」——不是密码损坏，稍后可重试 */
  pendingUnlock = false;
  /** 随数据持久化的主密钥（云同步会把它带到别的设备，见 core/secret.ts） */
  keyring = "";
  /** 磁盘上的原始密文：解密失败时用它回写，绝不把密文覆盖成空串 */
  private rawCipher = "";
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private env: StoreEnv) {}

  async load(): Promise<void> {
    const data = (await this.env.loadData()) as PersistData | undefined;
    if (data) {
      this.settings = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...data.settings };
      // 老数据：单一日历色 → eventColor + todoColor（不改变现有观感，见 types.ts）
      normalizeCalendarColors(this.settings.calendars);
      this.items = new Map(
        (data.items || []).map((it) => {
          // 幂等自愈：历史上拉取回来的 etag 被服务端 XML 转义成 &quot;xxxx&quot; 残留在本地
          // （见 core/caldav.ts 的 parseMultistatus 修复），这里加载时还原，避免 If-Match 永远 412。
          if (it && typeof it.etag === "string" && /&(quot|amp|lt|gt|apos);/.test(it.etag)) {
            it.etag = sanitizeEtag(it.etag);
          }
          return [keyOf(it), it];
        })
      );
      this.lastSync = data.sync?.lastSync;
      this.lastError = data.sync?.lastError;
      this.lastNote = data.sync?.lastNote;
      // 2026-10-19 起按条目 key 去重（旧版是 number、按推送轮次计数会虚胖）；
      // 老数据里的 number 字段直接忽略——计数只是展示用，丢一次无碍
      this.pendingUploadedKeys = Array.isArray(data.sync?.pendingUploadedKeys) ? data.sync.pendingUploadedKeys : [];
      this.pendingDeletedKeys = Array.isArray(data.sync?.pendingDeletedKeys) ? data.sync.pendingDeletedKeys : [];
      this.keyring = (data as any).keyring || "";
    }
    // 先注入主密钥再解密：密钥的权威副本随数据走，新生成的由 sink 回写持久化
    adoptKeyring(this.keyring, (k) => {
      this.keyring = k;
      this.persistSoon();
    });
    await this.unlockPassword();
  }

  /**
   * 把持久化的密码还原为内存明文；旧明文会在下次保存时自动改写为密文。
   *
   * 三条铁律（缺一条就会「丢密码」，见 core/secret.ts 的说明）：
   *   1. 密钥未就绪（unavailable）**不算**密码损坏：不置 secretBroken、不写盘，等重试；
   *   2. 解不开（mismatch）也只做提示，**原密文留在 rawCipher**，由 persist() 原样写回；
   *   3. 内存 password 为空 ≠ 用户想清空密码 —— persist() 必须能区分这两种情况。
   */
  private async unlockPassword(): Promise<void> {
    const raw = this.settings.password || "";
    this.rawCipher = raw;
    if (!raw) return;
    if (!isEncrypted(raw)) {
      // 旧版明文：兼容使用，并立即回写一份密文
      void this.persist();
      return;
    }
    // 逐层剥：兼容旧版把 enc:v3 当明文再包一层的套娃密文（升级过渡期）
    const r = await decryptSecretDeep(raw);
    if (r.ok) {
      this.settings.password = r.value ?? "";
      this.secretBroken = false;
      this.pendingUnlock = false;
      // v1/v2 密文的密钥是本机派生的，别的设备永远读不了 —— 既然本机解得开，
      // 立刻重存为 v3（密钥随数据走），否则下次照样「丢密码」。
      if (isLegacyEncrypted(raw)) void this.persist();
      return;
    }
    this.settings.password = "";
    this.pendingUnlock = r.reason === "unavailable";
    this.secretBroken = !this.pendingUnlock;
    if (this.pendingUnlock) {
      // 密钥还没到位：别惊动用户，更别动磁盘上的密文，等 retryUnlock()
      console.warn("[caldav] 密钥尚未就绪，暂缓解密密码（磁盘上的密文保持原样）");
      return;
    }
    // 写进 lastError，让 Dock 状态栏能直接显示出来（否则只在控制台，用户看不到）
    this.lastError = "密码密文与本地密钥不匹配（可能由另一台设备写入），请重新输入密码";
    console.warn("[caldav] 密码解密失败（密钥不匹配），请在设置中重新输入密码");
  }

  /** 密钥就绪后重试解密（例如设备标识迟到，或数据由另一台设备同步过来） */
  async retryUnlock(): Promise<void> {
    if (!this.pendingUnlock) return;
    await this.unlockPassword();
    if (!this.pendingUnlock) this.notify();
  }


  /** 凭据是否可用（用于同步前检查与界面提示） */
  credentialsIssue(): string | undefined {
    if (this.pendingUnlock) return "密码待解密（密钥未就绪），稍后会自动重试";
    if (this.secretBroken) return "密码解不开（密文来自另一台设备或已换设备），请在设置中重新输入密码";
    if (this.settings.serverUrl && !this.settings.password) return "未填写密码，请在设置中填写";
    return undefined;
  }

  private persistSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 400);
  }

  async persist(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const plain = this.settings.password || "";
    // 内存里没有明文有两种完全不同的含义 ——
    //   a) 已解开密文、用户本来就没密码 → 存空；
    //   b) 还没解开（密钥未就绪 / 密钥不匹配）→ **必须原样写回 rawCipher**。
    // 曾经不区分，b 会把磁盘上的密文覆盖成空串，密文永久丢失（「总是丢密码」的放大器）。
    const locked = this.secretBroken || this.pendingUnlock;
    const password = plain ? await encryptSecret(plain) : locked ? this.rawCipher : "";
    await this.env.saveData({
      keyring: getKeyring() || this.keyring,
      settings: { ...this.settings, password },
      items: Array.from(this.items.values()),
      sync: {
        lastSync: this.lastSync,
        lastError: this.lastError,
        lastNote: this.lastNote,
        pendingUploadedKeys: this.pendingUploadedKeys,
        pendingDeletedKeys: this.pendingDeletedKeys
      }
    });
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.persistSoon();
    for (const fn of this.listeners) fn();
  }

  getAll(): CalItem[] {
    return Array.from(this.items.values());
  }

  get(key: string): CalItem | undefined {
    return this.items.get(key);
  }

  /**
   * 某个日历在本地**一条条目都没有**吗？
   *
   * 用于「该不该信任 sync-token」的判定（见 core/sync.ts 的拉取分支）。
   *
   * 判据是「有没有任何条目」，**包含标记了 deleted 的** —— 待删条目同样说明
   * 本地掌握着这个日历的状态（哪怕 DELETE 这轮失败了），token 的声明仍然可信。
   *
   * 已知取舍：服务端本来就是空的日历（或条目全在时间窗外）会让本地恒为空，
   * 于是每轮都走全量。但那只是多一次返回空的 REPORT，代价可忽略；反过来，
   * 若把待删条目算成「空」，就会在「正清空某个日历」的当口触发无谓的全量重拉。
   */
  isCalendarLocallyEmpty(calendarUrl: string): boolean {
    for (const it of this.items.values()) {
      if (it.calendarUrl === calendarUrl) return false;
    }
    return true;
  }

  /** upsert（不触发 emit 的低层方法） */
  put(item: CalItem): void {
    this.items.set(keyOf(item), item);
  }

  putAndEmit(item: CalItem): void {
    this.put(item);
    this.emit();
  }

  remove(key: string): void {
    this.items.delete(key);
    this.emit();
  }

  /** 用一批服务端条目合并替换同日历的远端态（保留本地脏数据） */
  mergeServerItems(incoming: CalItem[], deletedKeys: string[] = []): { changed: boolean; removed: number; applied: number } {
    let changed = false;
    // 本地实际消失的条目数。**必须报给上层**，否则服务端删掉的条目在同步报告里
    // 表现为「删除 0 条」，用户会以为删除没同步过来（2026-10-10 实测）。
    let removed = 0;
    // 本地**实际写入**的条目数。上层要用它当「拉取 N 条」——
    // 不能用 incoming.length，否则自己刚推上去的条目被服务端当变更推回时，
    // 会被重复计入拉取（自环回显，2026-10-10 实测：新建一条显示「上传1 拉取1」）。
    let applied = 0;
    // 老数据自愈：2026-10-14 之前的版本**从不在拉取时保存 ICS 原文**，本地 store 里
    // 一大批条目的 `raw` 是 undefined。这些条目一旦被编辑就会走 `itemToNewICS` 整份重拼，
    // 服务端的 ATTACH / ORGANIZER / ATTENDEE / VTIMEZONE 全部被抹掉（实测数据丢失）。
    // 服务端内容没变（etag 相同 / 字段全同）时顺手把原文补上：数据上一个字节都没变，
    // 所以**不计入 `applied`**（否则「拉取 N 条」会虚增），只标 changed 让它落盘。
    const adoptRaw = (cur: CalItem, inc: CalItem): void => {
      if (cur.raw || !inc.raw) return;
      cur.raw = inc.raw;
      // 附件一起补：老数据（二进制附件支持之前解析的）这个字段是 undefined，
      // 而 rebuildComponent 的兜底逻辑只在 undefined 时原样带回原文里的二进制件。
      // 不补的话老条目永远走兜底，界面上看不到、也删不掉它们。
      // 只在本地没有时补 —— 本地有值说明插件已经接管附件，不能拿服务端的盖掉本地的。
      if (cur.attachments === undefined && inc.attachments) cur.attachments = inc.attachments;
      changed = true;
    };
    for (const inc of incoming) {
      // 本地脏数据优先：等上传后再被服务端确认覆盖
      const existing = this.items.get(keyOf(inc));
      if (existing?.dirty) continue;
      const cur = existing;
      if (cur && cur.href === inc.href) {
        // etag 是服务端对**内容**算的指纹：相同即代表服务端内容与本地上次同步时
        // 一致，没有实质变化，不必写入。
        //
        // 这是挡住「自环回显」唯一可靠的判据。逐字段比对做不到 —— 其中最脆弱的
        // `raw`：本地是生成的 ICS 原文，服务端返回的是它规范化过的版本（换行、
        // 属性顺序、补 PRODID/DTSTAMP 等），几乎必然不等，于是自己刚推上去的
        // 条目每轮都被判成「有变化」，拉取永远虚增 1（2026-10-10 实测）。
        if (cur.etag && inc.etag && cur.etag === inc.etag) {
          adoptRaw(cur, inc);
          continue;
        }
        // etag 缺失（老数据 / 服务端不返回）时才退回逐字段比对
        // ⚠️ 附件要按「空 ≡ 没有」归一化：编辑器删光附件时写的是 `[]`，
        //    而解析器在无 ATTACH 时留 `undefined`。直接比会把这两者判成「有变化」，
        //    于是删完附件的条目每轮同步都被拉回一次（自环回显的变体）。
        const attKey = (a?: CalAttachment[]): string => (a && a.length ? JSON.stringify(a) : "");
        const same =
          cur.summary === inc.summary &&
          cur.start === inc.start &&
          cur.end === inc.end &&
          cur.description === inc.description &&
          cur.location === inc.location &&
          cur.priority === inc.priority &&
          cur.percent === inc.percent &&
          cur.status === inc.status &&
          JSON.stringify(cur.rrule || null) === JSON.stringify(inc.rrule || null) &&
          JSON.stringify(cur.alarms || null) === JSON.stringify(inc.alarms || null) &&
          JSON.stringify(cur.categories || null) === JSON.stringify(inc.categories || null) &&
          attKey(cur.attachments) === attKey(inc.attachments) &&
          JSON.stringify(cur.exdates || null) === JSON.stringify(inc.exdates || null);
        if (same) {
          adoptRaw(cur, inc);
          // 服务端 etag 变了但受管字段没变（多端改了 DTSTAMP/ATTENDEE/ORGANIZER 等
          // 插件不管的字段、或服务器重算指纹）：必须把新 etag 回写，否则本地 etag 一直
          // 滞后，下一次编辑 PUT 带着旧 etag 发 If-Match，必被服务端 412、又按「服务端
          // 优先」把用户的改动静默丢掉（2026-10-19 雄哥实测：打勾完成即报「服务端已变更，
          // 本地改动已按策略丢弃」，根因就是这里漏了回写——单端不触发，多端/服务器重算才触发）。
          if (inc.etag && cur.etag !== inc.etag) {
            cur.etag = inc.etag;
            changed = true;
          }
          continue;
        }
      }
      this.items.set(keyOf(inc), { ...inc, dirty: false, deleted: false });
      changed = true;
      applied++;
    }
    for (const key of deletedKeys) {
      if (this.items.has(key)) {
        this.items.delete(key);
        changed = true;
        removed++;
      }
    }
    // 清理标记 deleted 且已处理完的
    for (const [k, it] of Array.from(this.items.entries())) {
      if (it.deleted && !it.dirty) {
        this.items.delete(k);
        changed = true;
      }
    }
    if (changed) this.emit();
    return { changed, removed, applied };
  }

  /** 待上传的脏条目 */
  dirtyItems(): CalItem[] {
    return this.getAll().filter((it) => it.dirty && !it.deleted);
  }

  /** 待删除 */
  deletedItems(): CalItem[] {
    return this.getAll().filter((it) => it.dirty && it.deleted);
  }

  /**
   * 记一条「即时推送成功上传」的条目 key。**按 key 去重**：同一条目被编辑 N 次
   * 会推 N 次，但同步报告按「条」计只能算一条（2026-10-19 雄哥实测：同一事件
   * 操作几次，同步就报上传几次——旧代码按轮次累加，虚胖）。
   */
  markUploaded(key: string): void {
    if (!this.pendingUploadedKeys.includes(key)) this.pendingUploadedKeys.push(key);
  }

  /** 同 markUploaded，删除口径 */
  markDeleted(key: string): void {
    if (!this.pendingDeletedKeys.includes(key)) this.pendingDeletedKeys.push(key);
  }

  isConfigured(): boolean {
    return !!this.settings.serverUrl && !!this.settings.username && this.settings.calendars.some((c) => c.enabled);
  }

  /** 手动通知订阅者（数据已被外部流程修改后） */
  notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** 修改 settings 后调用：持久化并通知订阅者 */
  saveSettings(): void {
    this.emit();
  }
}

export function keyOf(item: CalItem): string {
  // 同一资源同一 UID 一条；重复实例覆盖用 recurId 区分
  return item.recurId ? `${item.uid}|${item.recurId}|${item.kind}` : `${item.uid}|${item.kind}`;
}
