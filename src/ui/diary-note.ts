/**
 * 日记文档定位与行文案的纯计算（2026-10-14）。
 *
 * 与 diary-range.ts 分开放：那一片算「哪一段时间」，这里算「写到哪一篇文档、
 * 每一行写成什么样」。两者都是无副作用纯函数，便于直接写契约测试
 * （见 test/diary.test.mjs）。
 *
 * ⚠️ 本文件里的 Go 模板渲染只认最常见的两种写法；**认不全就返回空串**让调用方走兜底，
 * 绝不返回半渲染的路径 —— 否则会建出名字里带 `{{ }}` 的垃圾文档。
 */
import { fmtDateCn, parseLocalStamp, startOfDay } from "../core/date";
import { t } from "../core/i18n";


/**
 * Go 的参考时间是 2006-01-02 15:04:05，所以「年」在格式串里长�� `2006`。
 * 思源的日记路径模板走 Go time 格式，必须先翻成 JS 记号才能格式化。
 *
 * 顺序有讲究：`January` 必须排在 `Jan` 前面（否则会先命中短的那个）。
 */
const GO_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["2006", "YYYY"],
  ["January", "MMMM"],
  ["Jan", "MMM"],
  ["01", "MM"],
  ["02", "DD"],
  ["15", "HH"],
  ["04", "mm"],
  ["05", "ss"],
  ["PM", "A"],
  ["pm", "a"]
];

/** Go 时间格式串 → JS 记号串（只覆盖日记路径模板会出现的那几种） */
export function goDateFormatToJs(format: string): string {
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const hit = GO_TOKENS.find(([go]) => format.startsWith(go, i));
    if (hit) {
      out += hit[1];
      i += hit[0].length - 1;
      continue;
    }
    out += format[i];
  }
  return out;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 按（已转换的）JS 记号串渲染日期；未知记号原样输出，不抛错 */
export function formatByJsTokens(d: Date, jsFormat: string): string {
  const p2 = (n: number) => (n < 10 ? "0" + n : String(n));
  const table: Record<string, () => string> = {
    YYYY: () => String(d.getFullYear()),
    MMMM: () => MONTH_ABBR[d.getMonth()],
    MMM: () => MONTH_ABBR[d.getMonth()],
    MM: () => p2(d.getMonth() + 1),
    DD: () => p2(d.getDate()),
    HH: () => p2(d.getHours()),
    mm: () => p2(d.getMinutes()),
    ss: () => p2(d.getSeconds()),
    ddd: () => WEEKDAY_ABBR[d.getDay()],
    A: () => (d.getHours() < 12 ? "AM" : "PM"),
    a: () => (d.getHours() < 12 ? "am" : "pm")
  };
  // 长的记号必须排在前面（MMMM 先于 MMM 先于 MM），否则会被短前缀截胡
  return jsFormat.replace(/MMMM|MMM|MM|DD|YYYY|HH|mm|ss|ddd|A|a/g, (tok) =>
    table[tok] ? table[tok]() : tok
  );
}

/** 按 Go 时间格式串渲染某一天（思源模板里的 `{{now | date "..."}}` 走这里） */
export function formatGoDate(day: string, goFormat: string): string {
  const d = parseLocalStamp(startOfDay(day));
  if (Number.isNaN(d.getTime())) return "";
  return formatByJsTokens(d, goDateFormatToJs(goFormat));
}

const GO_NOW_WITH_FORMAT = /\{\{\s*now\s*\|\s*date\s+"([^"]*)"\s*\}\}/g;
const GO_NOW_PLAIN = /\{\{\s*now\s*\}\}/g;

/**
 * 渲染思源笔记本设置里的「日记保存路径」模板。
 *
 * 典型形态：`/日记/{{now | date "2006-01-02"}}`；
 * 也支持**多层分段**（思源笔记本设置常见）`/daily note/{{now | date "2006"}}/{{now | date "01"}}/{{now | date "2006-01-02"}}`。
 * 认得两种写法：`{{now | date "格式"}}`（渲染成 day 那天的日期）与 `{{now}}`（ISO 日期）。
 *
 * 认不出的 `{{...}}` **一律返回空串**（而不是原样保留）：调用方拿空串走兜底分支，
 * 顶多退回「按标题找 + 根目录建」；若把半渲染的 `/daily note/{{now | date "2006-01-02"`
 * 拿去 `createDocWithMd`，会**创建出一个名字里带 `{{ }}` 的垃圾文档**，
 * 还得用户手动去删 —— 宁可写不进，也不制造垃圾。
 */
export function renderDailyNotePath(template: string, day: string): string {
  const raw = (template || "").trim();
  if (!raw) return "";
  const d = parseLocalStamp(startOfDay(day));
  if (Number.isNaN(d.getTime())) return "";
  const out = raw
    .replace(GO_NOW_WITH_FORMAT, (_m, fmt: string) => formatGoDate(day, fmt))
    .replace(GO_NOW_PLAIN, () => startOfDay(day))
    .trim();
  // 模板没认全（含残留的 {{ }}）：宁可返回空串走兜底，也不用半成品路径建文档
  if (!out || out.includes("{{") || out.includes("}}")) return "";
  if (!out.startsWith("/")) return "";
  return out;
}

/**
 * 日记文档的专属属性名。思源创建日记时自动打上（见 Issue #9807），
 * 是把「真日记」和「普通文档」区分开的唯一可靠凭据 —— 靠标题/路径猜会误伤。
 */
export function dailyNoteAttrName(day: string): string {
  return `custom-dailynote-${day.replace(/-/g, "")}`;
}

/**
 * 日记里某一条条目的时间前缀。
 *
 * 当日范围里所有条目都在同一天，写 `09:00` 就够；跨日范围（本周 / 本月 / 所有）
 * 必须带日期 —— 否则读者看到一串 09:00 根本分不清是哪天的条目。
 */
export function diaryWhenLabel(occ: string, timed: boolean, crossDay: boolean): string {
  const time = timed ? occ.slice(11, 16) : t("全天");
  return crossDay ? `${fmtDateCn(occ)} ${time}` : time;
}

/** SQL 字符串字面量转义 —— 日记路径来自用户设置，可能带引号 */
export function sqlText(s: string): string {
  return String(s).replace(/'/g, "''");
}

/** 取路径的最后一段（文档标题）；hpath 形如 `/日记/2026-10-14` */
export function baseNameOf(hPath: string): string {
  const parts = hPath.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
