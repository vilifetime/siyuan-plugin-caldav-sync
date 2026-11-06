/**
 * 独立窗口「乐观首帧」共享快照（issue #5 · L2）。
 *
 * 背景：独立窗口是新建的 Electron 渲染进程，`store.load()` 每次都要走
 * 「内核读盘往返 + 解析 2.6MB 数据 + 逐账户凭据解密」，实测约 175ms。
 * 主窗口启动时已把同一份数据读进内存，把它写一份**脱敏瘦身**快照到同源
 * localStorage（主窗口 / 独立窗口同 origin，实机已由单例标记验证过共享），
 * 独立窗口 onload 同步读它喂给 store，日历首帧无需等读盘/解密；随后后台
 * 再做一次真实读盘校正，恢复凭据并刷新面板。
 *
 * 安全红线：
 *  - 递归剔除所有凭据类键（password / secret / token / keyring / webhookUrl …），
 *    快照里**绝不出现明文或密文凭据**；
 *  - 剔除同步专用大字段（item.raw、附件），只留渲染所需；
 *  - 体积超限 / 写入抛错（localStorage 配额）时清掉旧快照并优雅降级；
 *  - 只用一次、限深度、限时效，损坏数据一律不采用（由调用方回退真实读盘）。
 */
export const FIRST_FRAME_KEY = "siyuan-caldav-sync-first-frame-v1";
/** 快照最长有效期：同源 localStorage 跨会话会被端口隔离，这里只防单次运行内的陈旧数据 */
export const FIRST_FRAME_MAX_AGE_MS = 30 * 60 * 1000;
/** 体积上限：localStorage 通常 5MB，留足余量给节假日缓存等其它条目 */
export const FIRST_FRAME_MAX_BYTES = 1_500_000;

export interface FirstFrameData {
  items: unknown[];
  settings: Record<string, unknown>;
  [key: string]: unknown;
}
export interface FirstFrameSnapshot {
  v: 1;
  updatedAt: number;
  data: FirstFrameData;
}

export interface FirstFrameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 命中即丢弃该键。用包含匹配而非单词边界，覆盖 password / accessToken / webhookSecret 等写法。 */
const SENSITIVE_PARTS = [
  "password", "passwd", "secret", "token", "keyring", "credential",
  "apikey", "api_key", "privatekey", "private_key", "authorization",
  "cookie", "signature", "webhookurl", "webhook_url"
];
/** 同步专用大字段：首帧渲染不需要，且 item.raw 占数据文件绝大部分体积。 */
const SYNC_ONLY_KEY = /^(raw|rawics|attachments?|attach)$/i;
const MAX_DEPTH = 8;

export function defaultFirstFrameStorage(): FirstFrameStorage | null {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return null;
    return localStorage as unknown as FirstFrameStorage;
  } catch {
    return null;
  }
}

/** 递归复制：丢弃敏感键与同步专用键；深度超限直接放弃该分支，防病态数据撑爆调用栈。 */
function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_PARTS.some((p) => lower.includes(p))) continue;
    if (SYNC_ONLY_KEY.test(lower)) continue;
    const cleaned = redact(val, depth + 1);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/**
 * 主窗口写快照。data 是插件数据文件的完整对象（含 keyring / settings / items / …）。
 * 返回是否真的写入；任何失败都不抛错、不留陈旧数据。
 */
export function writeFirstFrameSnapshot(
  data: unknown,
  storage?: FirstFrameStorage | null,
  now = Date.now()
): boolean {
  const st = storage === undefined ? defaultFirstFrameStorage() : storage;
  if (!st) return false;
  try {
    if (!data || typeof data !== "object") {
      st.removeItem(FIRST_FRAME_KEY);
      return false;
    }
    const src = data as Record<string, unknown>;
    if (!Array.isArray(src.items)) {
      st.removeItem(FIRST_FRAME_KEY);
      return false;
    }
    const cleaned = redact(src) as FirstFrameData;
    if (!cleaned || !Array.isArray(cleaned.items) ||
        !cleaned.settings || typeof cleaned.settings !== "object" || Array.isArray(cleaned.settings)) {
      st.removeItem(FIRST_FRAME_KEY);
      return false;
    }
    const raw = JSON.stringify({ v: 1, updatedAt: now, data: cleaned } satisfies FirstFrameSnapshot);
    if (raw.length > FIRST_FRAME_MAX_BYTES) {
      st.removeItem(FIRST_FRAME_KEY);
      return false;
    }
    st.setItem(FIRST_FRAME_KEY, raw);
    return true;
  } catch {
    // 典型是 localStorage 配额超限：清掉旧快照，宁可本次不加速也不能留半截数据。
    try { st.removeItem(FIRST_FRAME_KEY); } catch { /* 忽略 */ }
    return false;
  }
}

/** 独立窗口读快照。结构/时效任一不合格即视为没有，并清掉坏数据。 */
export function readFirstFrameSnapshot(
  storage?: FirstFrameStorage | null,
  now = Date.now()
): FirstFrameSnapshot | null {
  const st = storage === undefined ? defaultFirstFrameStorage() : storage;
  if (!st) return null;
  let raw: string | null;
  try { raw = st.getItem(FIRST_FRAME_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw) as FirstFrameSnapshot;
    if (!snap || snap.v !== 1 || typeof snap.updatedAt !== "number" || !Number.isFinite(snap.updatedAt)) {
      throw new Error("bad header");
    }
    // 过期、或时钟回拨导致的「未来快照」都不采用。
    if (now - snap.updatedAt > FIRST_FRAME_MAX_AGE_MS || snap.updatedAt - now > 60_000) {
      throw new Error("stale");
    }
    const d = snap.data;
    if (!d || !Array.isArray(d.items) || !d.settings ||
        typeof d.settings !== "object" || Array.isArray(d.settings)) {
      throw new Error("bad shape");
    }
    return snap;
  } catch {
    try { st.removeItem(FIRST_FRAME_KEY); } catch { /* 忽略 */ }
    return null;
  }
}

export function clearFirstFrameSnapshot(storage?: FirstFrameStorage | null): void {
  const st = storage === undefined ? defaultFirstFrameStorage() : storage;
  if (!st) return;
  try { st.removeItem(FIRST_FRAME_KEY); } catch { /* 忽略 */ }
}
