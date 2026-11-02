import { pad2, type LocalStamp } from "./types";
import { t } from "./i18n";


/** 本地时区某个 UTC 毫秒的墙上时间字段 */
interface WallFields {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  weekday: number; // 0=周日
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function wallOf(ms: number): WallFields {
  const dt = new Date(ms);
  return {
    y: dt.getFullYear(),
    m: dt.getMonth() + 1,
    d: dt.getDate(),
    hh: dt.getHours(),
    mm: dt.getMinutes(),
    ss: dt.getSeconds(),
    weekday: dt.getDay()
  };
}

export function padDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** "YYYY-MM-DD" | "YYYY-MM-DDTHH:mm:ss" -> Date (本地时区) */
export function parseLocalStamp(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return new Date(NaN);
  return new Date(
    +m[1],
    +m[2] - 1,
    +m[3],
    m[4] ? +m[4] : 0,
    m[5] ? +m[5] : 0,
    m[6] ? +m[6] : 0
  );
}

export function stampOfMs(ms: number): LocalStamp {
  const w = wallOf(ms);
  return `${padDate(w.y, w.m, w.d)}T${pad2(w.hh)}:${pad2(w.mm)}:${pad2(w.ss)}`;
}

export function dateStampOfMs(ms: number): LocalStamp {
  const w = wallOf(ms);
  return padDate(w.y, w.m, w.d);
}

export function todayStamp(): LocalStamp {
  return dateStampOfMs(Date.now());
}

/**
 * 补上默认时刻的开始时间戳（新建日程/任务时用）：
 *  - 传入「今天」→ 当前时间的**下一个整点**（如 11:23 → 12:00；23:30 → 次日 00:00，日期一并进位）
 *  - 传入其它日期（或什么都没传，按今天算）→ 当天 09:00
 *  - 已经带时间的字符串原样返回
 *
 * 这样一来「新建」不再固定落在 9:00，而是落在下一个整点，符合直觉。
 */
export function defaultStartStamp(stamp = ""): LocalStamp {
  if (stamp.length > 10) return stamp; // 已经带了具体时间
  const date = stamp || todayStamp();
  if (date !== todayStamp()) return `${date}T09:00:00`;
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return stampOfMs(d.getTime());
}

export function addDays(stamp: LocalStamp, days: number): LocalStamp {
  const d = parseLocalStamp(stamp);
  d.setDate(d.getDate() + days);
  return isDateOnly(stamp) ? dateStampOfMs(d.getTime()) : stampOfMs(d.getTime());
}

export function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function startOfDay(stamp: LocalStamp): LocalStamp {
  return stamp.slice(0, 10);
}

export function weekdayIndexOfCode(code: string): number {
  return WEEKDAYS.indexOf(code.toUpperCase());
}

/** 周一为一周开始的一周起点 */
export function startOfWeek(stamp: LocalStamp): LocalStamp {
  const d = parseLocalStamp(stamp);
  const wd = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - wd);
  return dateStampOfMs(d.getTime());
}

export function diffDays(a: LocalStamp, b: LocalStamp): number {
  return Math.round((parseLocalStamp(startOfDay(a)).getTime() - parseLocalStamp(startOfDay(b)).getTime()) / 86400000);
}

export function fmtTime(stamp: LocalStamp): string {
  if (isDateOnly(stamp)) return t("全天");
  return stamp.slice(11, 16);
}

export function fmtDateCn(stamp: LocalStamp): string {
  return `${+stamp.slice(5, 7)}${t("月")}${+stamp.slice(8, 10)}${t("日")}`;
}

/**
 * 任意 IANA 时区下，把 UTC 毫秒映射为该时区的墙上时间毫秒差（用于解析 TZID）
 * 返回 zoneOffsetMs(tz, ms)：localWall = utc + offset
 */
const tzCache = new Map<string, Intl.DateTimeFormat>();
export function zoneOffsetMs(tz: string, ms: number): number {
  let fmt = tzCache.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
      tzCache.set(tz, fmt);
    } catch {
      return -new Date().getTimezoneOffset() * 60000; // 未知时区按本地
    }
  }
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t: string) => +parts.find((p) => p.type === t)!.value;
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUTC - Math.floor(ms / 1000) * 1000;
}
