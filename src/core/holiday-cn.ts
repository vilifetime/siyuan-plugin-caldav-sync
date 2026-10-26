/**
 * 中国日历叠加层 · 数据层（2026-10-26）
 *
 * 三类数据，更新机制完全不同：
 *  - 节假日：外部政策数据（国务院每年公布）。按「年」联网拉取 + 内存缓存；
 *    打开某年视图时若该年未缓存就去拉，之后按更新频率静默复查。
 *  - 农历 / 节气：内置天文算法（lunar-javascript，覆盖 1900–2100），运行时不联网。
 *
 * ⚠️ 纯展示层：数据一律**不进 CalDAV、不参与同步、不写服务器**，与多账户同步逻辑互不干扰。
 * ⚠️ 网络失败一律静默降级（返回 null / 不打断界面）；拉取只在真实 SiYuan 宿主内触发
 *    （`window.siyuan` 存在），单测环境（jsdom 无宿主）不联网，避免拖慢/挂起测试。
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

const cache = new Map<number, YearEntry>();
const inflight = new Map<number, Promise<Record<string, CnHoliday> | null>>();

/** 真实 SiYuan 宿主内才联网；单测（jsdom 无 window.siyuan）不触发，避免挂起测试 */
const IN_SIYUAN = typeof window !== "undefined" && !!(window as unknown as { siyuan?: unknown }).siyuan;

// 多源回退：主源 + 镜像（仅预设源有镜像；自定义源不自动镜像）。
// ⚠️ 排序按「国内可达性」：fastly.jsdelivr.net 在国内最稳，cdn.jsdelivr 次之，
// ghproxy.net 作 GitHub 加速兜底，raw.githubusercontent 最后（国内常被墙，仅用户有代理时生效）。
const SOURCES = {
  "holiday-cn": {
    primary: (y: number) => `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`,
    mirrors: [
      (y: number) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`,
      (y: number) => `https://ghproxy.net/https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${y}.json`,
      (y: number) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${y}.json`
    ]
  },
  "chinese-days": {
    primary: (y: number) => `https://fastly.jsdelivr.net/npm/chinese-days/dist/${y}.json`,
    mirrors: [(y: number) => `https://cdn.jsdelivr.net/npm/chinese-days/dist/${y}.json`]
  }
} as const;

function resolveCandidates(source: string, year: number): string[] {
  const preset = (SOURCES as unknown as Record<string, { primary: (y: number) => string; mirrors: ((y: number) => string)[] }>)[source];
  if (preset) return [preset.primary(year), ...preset.mirrors.map((f) => f(year))];
  // 自定义：支持 {year} 占位；无自动镜像
  return [source.replace(/\{year\}/g, String(year))];
}

/** 解析 settings 得到「有效数据源」字符串（custom 时取自定义 URL） */
export function effectiveHolidaySource(s: CalSettings): string {
  if (s.holidayCnSource === "custom") return (s.holidayCnCustomUrl || "").trim();
  return s.holidayCnSource || "holiday-cn";
}

// ── 网络传输层（可注入）──────────────────────────────────────────────
// 默认走浏览器原生 fetch（单测用 global.fetch mock 覆盖）。
// 真实插件在 onload 时通过 setHolidayTransport 换成走 SiYuan 内核代理的 httpRequest：
// 内核代理是**服务端** fetch，不受浏览器 CORS 限制、走本机真实网络/代理，
// 国内 GitHub/raw 即便浏览器直连被墙也能经内核代理拿到（思源自身更新即此通道）。
export type HolidayTransport = (url: string, timeoutMs: number) => Promise<{ ok: boolean; data: unknown } | null>;

let holidayTransport: HolidayTransport = (url, timeoutMs) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { signal: ctrl.signal })
    .then(async (r) => (r.ok ? { ok: true, data: await r.json() } : null))
    .catch(() => null)
    .finally(() => clearTimeout(timer));
};

/** 真实插件初始化时调用：把节假日拉取切到内核代理通道（国内稳定） */
export function setHolidayTransport(fn: HolidayTransport): void {
  holidayTransport = fn;
}

function normalizeHolidays(data: unknown): Record<string, CnHoliday> | null {
  const map: Record<string, CnHoliday> = {};
  // 兼容两种结构：数组 [{date,name,isOffDay}] 或 对象 {dateStr:{name,isOffDay}}
  const arr: any[] = Array.isArray(data) ? data : Object.values(data as Record<string, any>);
  for (const it of arr) {
    if (it && it.date) {
      map[String(it.date).slice(0, 10)] = { name: it.name || "节假日", off: it.isOffDay !== false };
    }
  }
  return Object.keys(map).length ? map : null;
}

/**
 * 并行竞速所有候选源：谁先成功用谁（不再串行等慢源超时）。
 * 各源经 holidayTransport 拉取，整体超时由 transport 各自控制。
 */
async function fetchYearJson(urls: string[], timeoutMs = 12000): Promise<Record<string, CnHoliday> | null> {
  const results = await Promise.all(urls.filter(Boolean).map((u) => holidayTransport(u, timeoutMs)));
  const hit = results.find((r) => r && r.ok);
  if (!hit) {
    console.warn("[caldav] 节假日数据拉取失败（所有候选源均不可用），已静默降级");
    return null;
  }
  return normalizeHolidays(hit.data);
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
  const src = effectiveHolidaySource(s);
  if (!src) return null; // 自定义但未填 URL
  const p = fetchYearJson(resolveCandidates(src, year)).then((map) => {
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
