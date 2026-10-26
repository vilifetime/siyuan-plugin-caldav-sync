/**
 * 中国日历叠加层 · 数据层（2026-10-26）
 *
 * 三类数据，更新机制完全不同：
 *  - 节假日：外部政策数据（国务院每年公布）。按「年」联网拉取 + 内存缓存；
 *    打开某年视图时若该年未缓存就去拉，之后按更新频率静默复查。
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
      map[String(it.date).slice(0, 10)] = { name: it.name || "节假日", off: it.isOffDay !== false };
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
      map[String(it.date).slice(0, 10)] = { name: it.name || "节假日", off: it.holiday === true };
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
      if (it && it.date) map[String(it.date).slice(0, 10)] = { name: it.name || "节假日", off: it.isOffDay !== false };
      else if (it && it.name !== undefined) map[k.slice(0, 10)] = { name: it.name || "节假日", off: it.isOffDay !== false };
    }
    return Object.keys(map).length ? map : null;
  }
  return null;
}

// ── 预设数据源（timor.tech 作为每个源的国内部署兜底）──
const timorCand = (y: number): Cand => ({ url: `https://timor.tech/api/holiday/year/${y}`, normalize: timorNormalize });
const SOURCES: Record<string, SourceDef> = {
  "timor": {
    label: "timor.tech（国内部署，推荐）",
    headers: UA,
    candidates: (y) => [timorCand(y)]
  },
  "holiday-cn": {
    label: "NateScarlet/holiday-cn（jsdelivr，国内常受限）",
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
    label: "vsme/chinese-days（jsdelivr/npm）",
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
    label: "自定义",
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

/**
 * 并行竞速某源所有候选；谁先成功用谁（不再串行等慢源超时）。
 * 全部失败则记录真实原因到 lastHolidayError 并返回 null。
 */
async function fetchYearJson(def: SourceDef, year: number, timeoutMs = 12000): Promise<Record<string, CnHoliday> | null> {
  const cands = def.candidates(year);
  const results = await Promise.all(cands.map((c) => holidayTransport(c.url, timeoutMs, def.headers)));
  const hit = results.findIndex((r) => r && r.ok);
  if (hit < 0) {
    const errs = results.filter((r) => r && r.error).map((r) => r!.error).join("；") || "全部候选源无响应";
    lastHolidayError = `「${def.label}」${year}年 所有候选源均失败：${errs}`;
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
    if (map) cache.set(year, { map, updatedAt: Date.now() });
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
    // 月、日间插入「月」字：八 → 八月廿九；闰六 → 闰六月初一；冬 → 冬月十一；正 → 正月初一
    return { lunar: l.getMonthInChinese() + "月" + l.getDayInChinese(), jieqi: l.getJieQi() };
  } catch {
    return { lunar: "", jieqi: "" };
  }
}

export function chinaCalendarEnabled(s: CalSettings): boolean {
  return !!(s.showHolidaysCN || s.showLunarCN || s.showTermCN);
}

/** 预热若干年份；返回是否有「新数据载入」（用于触发一次重绘） */
export async function warmChinaCalendar(s: CalSettings, years: number[]): Promise<boolean> {
  if (!IN_SIYUAN || !chinaCalendarEnabled(s)) return false;
  let changed = false;
  await Promise.all(
    years.map(async (y) => {
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
