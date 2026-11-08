import { pad2, type LocalStamp } from "./types";
import { isEnglish, t } from "./i18n";


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

/** 英文月份名。中文不用名字，走「N 月」；月份标题（年视图 12 个小月历）两种语言都要。 */
export const MONTH_NAMES_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
] as const;

/** 1st / 2nd / 3rd / 4th … 11th / 12th / 13th … 21st / 22nd / 23rd */
export function ordinalEn(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}

/**
 * 月份标题：英文 "January"，中文「1 月」。
 * 年视图 12 个小月历、月视图工具栏标题共用。
 */
export function monthLabel(month: number): string {
  if (month < 1 || month > 12) return String(month);
  // 中文分支直接用中文，不套 t()：zh_CN 本就是恒等映射，硬编码可杜绝
  // 「语言判定失效 + 英文字典」时退化成 `1 Month` 这种半英半中。
  return isEnglish() ? MONTH_NAMES_EN[month - 1] : `${month} 月`;
}

/**
 * 星期名（周一起始：0=周一 … 6=周日）。
 *
 * 旧实现在 view-month / view-week / view-list / view-year / editor 各自写死
 * `["周一",…,"周日"]` / `["一",…,"日"]`，且是**模块顶层常量** —— 宿主在插件
 * init 时才 setI18n(字典)，常量早在 import 阶段就求值成中文，英文界面永远显示中文
 * （雄哥 2026-11-08 截图）。故统一改成渲染时调用本函数。
 *
 * 英文全称 Monday…Sunday 用于月/周/日/列表视图；短名 Mon…Sun 用于年视图
 * 迷你月历与重复规则按钮（格子只有 ~20px / 28px，全称塞不下）。
 * 中文分支同样硬编码，不经 t()，避免语言判定失效时退化成半英半中。
 */
export const WEEKDAY_NAMES_EN = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"
] as const;
export const WEEKDAY_SHORT_EN = [
  "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"
] as const;
const WEEKDAY_NAMES_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;
const WEEKDAY_SHORT_ZH = ["一", "二", "三", "四", "五", "六", "日"] as const;

/** mon0：周一=0 … 周日=6；short=true 出短名（中文单字 / 英文三字母）。 */
export function weekdayLabel(mon0: number, short = false): string {
  const i = ((Math.trunc(mon0) % 7) + 7) % 7;
  if (isEnglish()) return short ? WEEKDAY_SHORT_EN[i] : WEEKDAY_NAMES_EN[i];
  return short ? WEEKDAY_SHORT_ZH[i] : WEEKDAY_NAMES_ZH[i];
}

/** 7 个星期名，按周一起始顺序（渲染表头用）。 */
export function weekdayLabels(short = false): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => weekdayLabel(i, short));
}

/**
 * 短日期（月 + 日）：中文「9月24日」，英文 "September 24th"。
 *
 * 旧实现是 `${m}${t("月")}${d}${t("日")}` 逐字翻译，英文界面得到
 * `9Month24Day`（雄哥 2026-11-08 截图）；日期格式必须按语言整体换，
 * 不能把「月」「日」当单词直译。名字沿用 fmtDateCn 避免改动所有调用点。
 */
export function fmtDateCn(stamp: LocalStamp): string {
  const m = +stamp.slice(5, 7);
  const d = +stamp.slice(8, 10);
  if (isEnglish()) return `${MONTH_NAMES_EN[m - 1] || m} ${ordinalEn(d)}`;
  // 同上：中文格式直接写死，不再经 t("月")/t("日")，避免退化成 9Month24Day
  return `${m}月${d}日`;
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
