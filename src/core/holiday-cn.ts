/**
 * 中国日历叠加层 · 数据层（2026-10-26）
 *
 * 三类数据，更新机制完全不同：
 *  - 节假日：外部政策数据（国务院每年公布）。按「年」联网拉取 + 内存缓存；
 *    打开某年视图时若该年未缓存就去拉，之后按更新频率静默复查。
 *    同一思源会话内另有一份 localStorage 共享快照：主窗口拉取、独立窗口零联网复用
 *    （见下方「跨窗口共享缓存」段）。
 *  - 农历 / 节气：内置天文算法（lunar-javascript，覆盖 1900–2100），运行时不联网。
 *
 * ⚠️ 纯展示层：数据一律**不进 CalDAV、不参与同步、不写服务器**，与多账户同步逻辑互不干扰。
 * ⚠️ 网络失败一律记录真实原因并返回 null（不抛、不打断界面）；拉取只在真实 SiYuan 宿主内触发
 *    （`window.siyuan` 存在），单测环境（jsdom 无宿主）不联网，避免拖慢/挂起测试。
 *
 * 数据源策略（2026-10-26 修正）：
 *  - 默认源 NateScarlet/holiday-cn 走 jsdelivr，但**国内常被墙**；
 *    故每个预设都把 **timor.tech（国内部署）作为最后兜底候选**，即便 jsdelivr 全挂也能拿到。
 *  - timor.tech 需要带 User-Agent 头（否则 403），所有候选统一带 UA。
 *  - 各候选带**各自的归一化函数**（NateScarlet 是 {days:[...]}，timor 是 {holiday:{...}}）。
 */
import { Solar } from "lunar-javascript";
import type { CalSettings } from "./types";
import { isEnglish, t as _t } from "./i18n";


export interface CnHoliday {
  /** 节假日名称，如「国庆节」 */
  name: string;
  /** true=休息日（休），false=调休补班（班） */
  off: boolean;
}

interface YearEntry {
  map: Record<string, CnHoliday>;
  updatedAt: number;
}

/** 归一化器：把各源原始 JSON 压成 dateStr → {name,off} */
type Normalizer = (data: unknown) => Record<string, CnHoliday> | null;

interface Cand {
  url: string;
  normalize: Normalizer;
}
interface SourceDef {
  label: string;
  /** 适用于本源全部候选的请求头（timor 需要 UA） */
  headers?: Record<string, string>;
  /** 按国内可达性排序的候选（并行竞速，谁先成功用谁） */
  candidates: (y: number) => Cand[];
}

const UA = { "User-Agent": "Mozilla/5.0 (SiYuanCalDAV/1.0)" };

// —— 归一化器 ——
function fromArray(arr: any[]): Record<string, CnHoliday> | null {
  const map: Record<string, CnHoliday> = {};
  for (const it of arr) {
    if (it && it.date) {
      map[String(it.date).slice(0, 10)] = { name: it.name || _t("节假日"), off: it.isOffDay !== false };
    }
  }
  return Object.keys(map).length ? map : null;
}
/** NateScarlet/holiday-cn：{days:[{name,date,isOffDay}]} 或 [{name,date,isOffDay}] */
function nateNormalize(data: unknown): Record<string, CnHoliday> | null {
  if (Array.isArray(data)) return fromArray(data);
  const d = data as any;
  if (d && Array.isArray(d.days)) return fromArray(d.days);
  return null;
}
/** timor.tech：{code, holiday:{"MM-DD":{holiday:bool,name,date,...}}} */
function timorNormalize(data: unknown): Record<string, CnHoliday> | null {
  const t = data as any;
  if (!t || !t.holiday || typeof t.holiday !== "object") return null;
  const map: Record<string, CnHoliday> = {};
  for (const k of Object.keys(t.holiday)) {
    const it = t.holiday[k];
    if (it && it.date) {
      map[String(it.date).slice(0, 10)] = { name: it.name || _t("节假日"), off: it.holiday === true };
    }
  }
  return Object.keys(map).length ? map : null;
}
/** 自定义源：尽力兼容多种结构（NateScarlet / timor / {dateStr:{name,isOffDay}}） */
function genericNormalize(data: unknown): Record<string, CnHoliday> | null {
  if (Array.isArray(data)) return fromArray(data);
  const d = data as any;
  if (d && Array.isArray(d.days)) return fromArray(d.days);
  if (d && d.holiday && typeof d.holiday === "object") return timorNormalize(data);
  if (data && typeof data === "object") {
    const map: Record<string, CnHoliday> = {};
    for (const k of Object.keys(data as object)) {
      const it = (data as any)[k];
      if (it && it.date) map[String(it.date).slice(0, 10)] = { name: it.name || _t("节假日"), off: it.isOffDay !== false };
      else if (it && it.name !== undefined) map[k.slice(0, 10)] = { name: it.name || _t("节假日"), off: it.isOffDay !== false };
    }
    return Object.keys(map).length ? map : null;
  }
  return null;
}

// ── 预设数据源（timor.tech 作为每个源的国内部署兜底）──
const timorCand = (y: number): Cand => ({ url: `https://timor.tech/api/holiday/year/${y}`, normalize: timorNormalize });
const SOURCES: Record<string, SourceDef> = {
  "timor": {
    label: _t("timor.tech（国内部署，推荐）"),
    headers: UA,
    candidates: (y) => [timorCand(y)]
  },
  "holiday-cn": {
    label: _t("NateScarlet/holiday-cn（jsdelivr，国内常受限）"),
    headers: UA,
    candidates: (y) => [
      { url: `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`, normalize: nateNormalize },
      { url: `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`, normalize: nateNormalize },
      { url: `https://ghproxy.net/https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${y}.json`, normalize: nateNormalize },
      { url: `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${y}.json`, normalize: nateNormalize },
      timorCand(y) // 国内部署兜底
    ]
  },
  "chinese-days": {
    label: _t("vsme/chinese-days（jsdelivr/npm）"),
    headers: UA,
    candidates: (y) => [
      { url: `https://fastly.jsdelivr.net/npm/chinese-days/dist/${y}.json`, normalize: genericNormalize },
      { url: `https://cdn.jsdelivr.net/npm/chinese-days/dist/${y}.json`, normalize: genericNormalize },
      timorCand(y) // 国内部署兜底
    ]
  }
};

function resolveSourceDef(source: string): SourceDef | null {
  if (SOURCES[source]) return SOURCES[source];
  if (!source) return null; // 自定义但未填 URL
  // 自定义：支持 {year} 占位；无自动镜像
  return {
    label: _t("自定义"),
    headers: UA,
    candidates: (y) => [{ url: source.replace(/\{year\}/g, String(y)), normalize: genericNormalize }]
  };
}

/** 解析 settings 得到「有效数据源」字符串（custom 时取自定义 URL） */
export function effectiveHolidaySource(s: CalSettings): string {
  if (s.holidayCnSource === "custom") return (s.holidayCnCustomUrl || "").trim();
  return s.holidayCnSource || "holiday-cn";
}

// ── 网络传输层（可注入）──────────────────────────────────────────────
// 默认走浏览器原生 fetch（单测用 global.fetch mock 覆盖）。
// 真实插件在 onload 时通过 setHolidayTransport 换成走 SiYuan 内核代理的 httpRequest：
// 内核代理是**服务端** fetch，不受浏览器 CORS 限制、走本机真实网络/代理。
export type HolidayTransport = (
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

let holidayTransport: HolidayTransport = (url, timeoutMs, headers) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { signal: ctrl.signal, headers })
    .then(async (r) => (r.ok ? { ok: true, data: await r.json() } : { ok: false, error: "HTTP " + r.status }))
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
    .finally(() => clearTimeout(timer)) as Promise<{ ok: boolean; data?: unknown; error?: string }>;
};

/** 真实插件初始化时调用：把节假日拉取切到内核代理通道（国内稳定） */
export function setHolidayTransport(fn: HolidayTransport): void {
  holidayTransport = fn;
}

const cache = new Map<number, YearEntry>();
const inflight = new Map<number, Promise<Record<string, CnHoliday> | null>>();
let lastHolidayError: string | null = null;

/** 读取最近一次拉取失败原因（设置页「立即检查更新」回显用） */
export function getLastHolidayError(): string | null {
  return lastHolidayError;
}

/* ── 跨窗口共享缓存（issue #5 · C 项，2026-11-06）──────────────────────────
 * 节假日缓存原本是**模块级内存 Map**：独立窗口是新建的 Electron 渲染进程，内存不共享，
 * 于是它每次 renderView 都把 [y-1,y,y+1] 三年 × 多候选重新拉一遍；国内 jsdelivr/raw
 * 常全超时 → 控制台刷屏、内核代理反复回退直连，节假日徽标也迟迟补不出来。
 *
 * 同一思源会话内主/从窗口 origin 相同，localStorage 共享（跨窗口单例已用同一机制），
 * 故把「拉取成功」的年份按年写入 localStorage：主窗口负责拉，独立窗口启动后直接 hydrate，
 * 绝不联网。思源端口每次启动随机 → 这只是**运行期**缓存；跨会话仍由主窗口按更新频率重拉，
 * 不违背「跨会话偏好必须存配置」的铁律。
 *
 * 另加「失败冷却」：全部候选失败后短期内不重试，避免主窗口每次切月/筛选都重发请求。
 * 农历/节气是内置天文算法、同步渲染，与网络无关；hydrate 后独立窗口首帧即可显示完整叠加层。
 */
const SHARED_KEY = "siyuan-caldav-sync-holiday-cache-v1";
const FAIL_COOLDOWN_MS = 10 * 60 * 1000;  // 拉取失败后的冷却窗口
const SHARED_MAX_YEARS = 6;               // 共享快照最多保留年份数，避免无限增长

const failedAt = new Map<number, number>();
let sharedRaw: string | null = null;       // 上次已处理的快照原文，避免重复 JSON.parse
let runtimeHost: boolean | null = null;    // null = 自动按 window.siyuan 判定
let runtimeNetwork = true;                 // false = 独立窗口，只复用缓存、绝不联网
let runtimeStorage: Pick<Storage, "getItem" | "setItem"> | null = null;

/** 运行期策略注入（真实插件只注入 networkAllowed；其余两项供单测覆盖） */
export interface HolidayRuntime {
  /** 是否处于真实宿主；不传则按 window.siyuan 自动判定 */
  hostEnabled?: boolean;
  /** 是否允许联网拉取；独立窗口应置 false */
  networkAllowed?: boolean;
  /** 跨窗口共享存储；不传则取全局 localStorage */
  sharedStorage?: Pick<Storage, "getItem" | "setItem">;
}
export function setHolidayRuntime(opts: HolidayRuntime): void {
  if (typeof opts.hostEnabled === "boolean") runtimeHost = opts.hostEnabled;
  if (typeof opts.networkAllowed === "boolean") runtimeNetwork = opts.networkAllowed;
  if (opts.sharedStorage) { runtimeStorage = opts.sharedStorage; sharedRaw = null; }
}
/** 运行时才读取 IN_SIYUAN（定义在文件末尾，避开模块求值期的 TDZ） */
function hostEnabled(): boolean {
  return runtimeHost === null ? IN_SIYUAN : runtimeHost;
}
function sharedStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (runtimeStorage) return runtimeStorage;
  try {
    return (typeof localStorage !== "undefined" && localStorage) ? localStorage : null;
  } catch { return null; }
}

interface SharedEntry {
  year: number;
  /** 拉取时的有效数据源；换源后旧缓存不复用，避免格式不兼容 */
  source: string;
  updatedAt: number;
  map: Record<string, CnHoliday>;
}
interface SharedSnapshot { v: 1; years: SharedEntry[] }

/** 读共享快照；原文未变则跳过解析（renderView 会频繁调用 warmChinaCalendar） */
function readShared(): SharedSnapshot | null {
  const ls = sharedStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(SHARED_KEY);
    if (!raw || raw === sharedRaw) return null;
    sharedRaw = raw;
    const snap = JSON.parse(raw) as SharedSnapshot;
    if (!snap || snap.v !== 1 || !Array.isArray(snap.years)) return null;
    return snap;
  } catch {
    sharedRaw = null; // 损坏数据允许下次重试
    return null;
  }
}
/** 把某年成功拉取的数据合并进共享快照（只写成功结果，失败绝不写） */
function writeSharedYear(year: number, source: string, updatedAt: number, map: Record<string, CnHoliday>): void {
  const ls = sharedStorage();
  if (!ls) return;
  try {
    let years: SharedEntry[] = [];
    const old = ls.getItem(SHARED_KEY);
    if (old) {
      const prev = JSON.parse(old) as SharedSnapshot;
      if (prev && prev.v === 1 && Array.isArray(prev.years)) {
        years = prev.years.filter((e) => e && e.year !== year);
      }
    }
    years.push({ year, source, updatedAt, map });
    years.sort((a, b) => b.year - a.year);
    const next: SharedSnapshot = { v: 1, years: years.slice(0, SHARED_MAX_YEARS) };
    const raw = JSON.stringify(next);
    ls.setItem(SHARED_KEY, raw);
    sharedRaw = raw;
  } catch { /* 配额不足 / localStorage 被禁：静默，内存缓存仍有效 */ }
}
/**
 * 把其它窗口（通常是主窗口）已拉到的年份灌入本进程内存缓存。
 * @returns 是否灌入/更新了数据（调用方据此触发一次重绘补出「休/班」徽标）
 */
export function hydrateSharedHolidayCache(s: CalSettings): boolean {
  const snap = readShared();
  if (!snap) return false;
  const source = effectiveHolidaySource(s);
  let changed = false;
  for (const e of snap.years) {
    if (!e || !Number.isInteger(e.year) || !e.map || typeof e.map !== "object") continue;
    if (e.source !== source) continue;          // 换了数据源 → 旧数据不适用
    const cur = cache.get(e.year);
    if (cur && cur.updatedAt >= (e.updatedAt || 0)) continue;  // 本进程数据更新
    cache.set(e.year, { map: e.map, updatedAt: e.updatedAt || Date.now() });
    failedAt.delete(e.year);
    changed = true;
  }
  return changed;
}

/**
 * 并行竞速某源所有候选；谁先成功用谁（不再串行等慢源超时）。
 * 全部失败则记录真实原因到 lastHolidayError 并返回 null。
 */
async function fetchYearJson(def: SourceDef, year: number, timeoutMs = 12000): Promise<Record<string, CnHoliday> | null> {
  const cands = def.candidates(year);
  const results = await Promise.all(cands.map((c) => holidayTransport(c.url, timeoutMs, def.headers)));
  const hit = results.findIndex((r) => r && r.ok);
  if (hit < 0) {
    const errs = results.filter((r) => r && r.error).map((r) => r!.error).join(_t("；")) || _t("全部候选源无响应");
    lastHolidayError = `${_t("「")}${def.label}${_t("」")}${year}${isEnglish() ? "" : _t("年")} ${_t("所有候选源均失败：")}${errs}`;
    console.warn("[caldav] " + lastHolidayError);
    return null;
  }
  lastHolidayError = null;
  return cands[hit].normalize(results[hit]!.data);
}

function isStale(s: CalSettings, updatedAt: number): boolean {
  const freq = s.holidayCnUpdateFreq || "weekly";
  if (freq === "manual") return false;
  const age = Date.now() - updatedAt;
  const day = 86_400_000;
  return freq === "daily" ? age > day : age > 7 * day;
}

/**
 * 载入某年节假日数据（带缓存 + 防重入）。
 * @param force 强制忽略缓存重拉（「立即检查更新」用）
 * @returns 归一化 map（dateStr → {name,off}），失败返回 null
 */
export async function loadHolidayYear(s: CalSettings, year: number, force = false): Promise<Record<string, CnHoliday> | null> {
  const existing = cache.get(year);
  if (existing && !force && !isStale(s, existing.updatedAt)) return existing.map;
  if (inflight.has(year)) return inflight.get(year)!;
  const def = resolveSourceDef(effectiveHolidaySource(s));
  if (!def) return null; // 自定义但未填 URL
  const p = fetchYearJson(def, year).then((map) => {
    if (map) {
      const updatedAt = Date.now();
      cache.set(year, { map, updatedAt });
      failedAt.delete(year);
      // 写入跨窗口共享快照，供独立窗口（另一个渲染进程）零联网复用。
      writeSharedYear(year, effectiveHolidaySource(s), updatedAt, map);
    } else {
      // 全部候选失败：记冷却，避免每次 renderView 都重发一整批超时请求。
      failedAt.set(year, Date.now());
    }
    inflight.delete(year);
    return map;
  });
  inflight.set(year, p);
  return p;
}

/** 同步读取（渲染时用）；缓存未就绪返回 null */
export function holidayFor(dateStr: string): CnHoliday | null {
  const y = +dateStr.slice(0, 4);
  const e = cache.get(y);
  return e ? e.map[dateStr] || null : null;
}

/** 同步计算农历 + 节气（内置算法，无网络） */
export function lunarFor(dateStr: string): { lunar: string; jieqi: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  try {
    const l = Solar.fromYmd(y, m, d).getLunar();
    // 农历是中文专名，**任何界面语言下都保持中文**（雄哥 2026-11-08 拍板）：
    // 旧实现经字典模板把「月」译成 month，得到「九月month廿六」这类半英半中。
    // 月、日间插入「月」字：八 → 八月廿九；闰六 → 闰六月初一；冬 → 冬月十一；正 → 正月初一
    return { lunar: `${l.getMonthInChinese()}月${l.getDayInChinese()}`, jieqi: l.getJieQi() };
  } catch {
    return { lunar: "", jieqi: "" };
  }
}

export function chinaCalendarEnabled(s: CalSettings): boolean {
  return !!(s.showHolidaysCN || s.showLunarCN || s.showTermCN);
}

/**
 * 预热若干年份；返回是否有「新数据载入」（用于触发一次重绘）。
 * 独立窗口（setHolidayRuntime({networkAllowed:false})）只 hydrate 共享缓存，绝不联网。
 */
export async function warmChinaCalendar(s: CalSettings, years: number[]): Promise<boolean> {
  if (!hostEnabled() || !chinaCalendarEnabled(s)) return false;
  // 先复用其它窗口（通常是主窗口）已拉到的共享缓存；灌入新数据 → 需重绘补出徽标。
  let changed = hydrateSharedHolidayCache(s);
  if (!runtimeNetwork) return changed;
  await Promise.all(
    years.map(async (y) => {
      // 失败冷却：国内数据源全超时后，短期内不再重发这一整批请求（否则切月/筛选必刷屏）。
      const lastFail = failedAt.get(y) || 0;
      if (Date.now() - lastFail < FAIL_COOLDOWN_MS) return;
      const before = cache.has(y);
      const prev = before ? cache.get(y)!.map : null;
      const map = await loadHolidayYear(s, y);
      if (!map) return;
      if (!before) changed = true;
      else if (JSON.stringify(prev) !== JSON.stringify(map)) changed = true;
    })
  );
  return changed;
}

/** 强制刷新（设置页「立即检查更新」用）；返回是否有任一一年拉到数据 */
export async function forceRefreshChinaCalendar(s: CalSettings, years: number[]): Promise<boolean> {
  let ok = false;
  await Promise.all(
    years.map(async (y) => {
      const map = await loadHolidayYear(s, y, true);
      if (map) ok = true;
    })
  );
  return ok;
}

/** 真实 SiYuan 宿主内才联网；单测（jsdom 无 window.siyuan）不触发，避免挂起测试 */
const IN_SIYUAN = typeof window !== "undefined" && !!(window as unknown as { siyuan?: unknown }).siyuan;
