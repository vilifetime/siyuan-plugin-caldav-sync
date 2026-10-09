/** 视图渲染公共类型 */
import type { CalItem, SortMode } from "../core/types";
import { DEFAULT_CATEGORIES, calEventColor, calTodoColor } from "../core/types";
import type { PanelCtx } from "./panel";
import { occurrencesInRange } from "../core/ics";
import { parseLocalStamp, stampOfMs } from "../core/date";

export interface ViewArgs {
  ctx: PanelCtx;
  viewEl: HTMLElement;
  occurrences: (startMs: number, endMs: number) => Map<CalItem, string[]>;
}

/**
 * 待办的时间归属一律取「到期日期」（DUE），不看开始日期（DTSTART）。
 * - 日历显示、周/月视图落位、Dock 与任务视图的时间段统计都走这里
 * - 无到期日期时返回空数组，该待办归入「无日期」
 * - 重复待办：先按开始时间展开实例，再整体平移到到期日
 */
export function todoDueOccurrences(it: CalItem, startMs: number, endMs: number): string[] {
  if (!it.end) return [];
  if (!it.rrule) {
    const ms = parseLocalStamp(it.end).getTime();
    return ms >= startMs && ms <= endMs ? [it.end] : [];
  }
  const anchor = it.start || it.end;
  const occs = occurrencesInRange({ ...it, start: anchor }, startMs, endMs);
  const delta = it.start ? parseLocalStamp(it.end).getTime() - parseLocalStamp(it.start).getTime() : 0;
  return occs.filter(Boolean).map((s) => stampOfMs(parseLocalStamp(s).getTime() + delta));
}

export function keyOfItem(it: CalItem): string {
  return it.recurId ? `${it.uid}|${it.recurId}|${it.kind}` : `${it.uid}|${it.kind}`;
}

/**
 * 按关键词匹配一个条目（标题 / 备注 / 地点 / 分类，大小写与首尾空格都不敏感）。
 *
 * 抽到 view-common 是因为**两处**都要用：任务视图工具栏的搜索框，以及
 * （历史上）Dock 的搜索框。原先它在 panel.ts 里是局部函数、Dock 搜索框
 * 移除后就成了孤儿 —— 那种「实现挪走、原函数忘了删」的残留最后都变成
 * 死代码，两份匹配口径各写一遍还会漂移（一处加字段一处没加）。
 *
 * 空关键词一律判为命中 —— 调用方不必自己先判空。
 */
export function matchesSearchQuery(it: CalItem, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return (
    (it.summary || "").toLowerCase().includes(s) ||
    (it.description || "").toLowerCase().includes(s) ||
    (it.location || "").toLowerCase().includes(s) ||
    (it.categories || []).some((c) => c.toLowerCase().includes(s))
  );
}

/**
 * 月视图专用 chip：两行显示。
 * - 第一行：复选框（待办）+ 标题；标题单行，超出直接裁切（无省略号）。
 * - 第二行：开始/到期时间；全天事件/任务不显示时间行。
 */
export function monthChipHtml(it: CalItem, occ: string, calColor: string): string {
  const k = keyOfItem(it);
  const done = it.kind === "todo" && it.percent === 100;
  const check = it.kind === "todo" ? `<button class="cal-chip-check" data-toggle="${k}" title="${done ? "标记未完成" : "标记完成"}">✓</button>` : "";
  const timeRow = it.allDay
    ? ""
    : `<div class="cal-chip-row cal-chip-row-time"><span class="cal-chip-time">${occ.slice(11, 16)}</span></div>`;
  return `<div class="cal-chip cal-chip-month ${done ? "is-done" : ""}" data-open="${k}" style="--cal-color:${calColor}">
    <div class="cal-chip-row">${check}<span class="cal-chip-title">${repeatMark(it)}${escape(it.summary || "(无标题)")}</span></div>
    ${timeRow}
  </div>`;
}

export function repeatMark(it: CalItem): string {
  return it.rrule ? '<span class="cal-chip-repeat" title="重复">↻</span>' : "";
}

export function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 条目在日历视图上显示的颜色：
 *  - 优先用「分类颜色」：条目带分类，且能在本地分类定义里按「名称」匹配到颜色；
 *  - 否则回退到所属「日历的默认颜色」——待办取 todoColor、日程取 eventColor；
 *  - 两者皆无（无分类且日历未在设置里）再给一个中性灰。
 * 这是「日历视图按分类着色」的唯一切口，月/周/年/任务视图共用，改这里即可全局生效。
 * 分类优先于默认色的规则保持不变：只要条目命中了分类，就看不出本次拆分。
 */
export function calColorOf(ctx: PanelCtx, it: CalItem): string {
  const cats = ctx.store.settings.categories?.length
    ? ctx.store.settings.categories
    : DEFAULT_CATEGORIES;
  if (it.categories?.length) {
    for (const name of it.categories) {
      const def = cats.find((c) => c.name === name);
      if (def?.color) return def.color;
    }
  }
  const cal = ctx.store.settings.calendars.find((c) => c.url === it.calendarUrl);
  return it.kind === "todo" ? calTodoColor(cal) : calEventColor(cal);
}

/** 条目某排序键的取值（用于比较；字符串统一字典序比较） */
function sortValueOf(mode: SortMode, it: CalItem, occ: string): string | number {
  switch (mode) {
    case "end":
      // 待办以到期日为准；无到期日的排到最后
      return it.kind === "todo" ? it.end || "9999-12-31T23:59:59" : it.end || occ;
    case "priority":
      return it.priority && it.priority > 0 ? it.priority : 9; // 无优先级视为最低（9）
    case "completed":
      return it.completedAt || "9999-12-31T23:59:59"; // 未完成/无完成时间排最后
    case "created":
      return it.createdAt || it.start;
    case "category":
      return (it.categories && it.categories[0]) || "";
    case "title":
      return (it.summary || "").toLowerCase();
    case "start":
    default:
      return occ;
  }
}

/**
 * 事件排序比较器，支持 7 种模式：
 * start 开始时间 / end 结束时间 / priority 优先级 / completed 完成时间 /
 * created 创建时间 / category 分类 / title 标题。
 * 用于月视图单元格、周视图全天行等列表；并列时回退展开实例开始时间。
 */
export function occComparator(mode: SortMode) {
  return (a: { it: CalItem; occ: string }, b: { it: CalItem; occ: string }): number => {
    const av = sortValueOf(mode, a.it, a.occ);
    const bv = sortValueOf(mode, b.it, b.occ);
    if (av < bv) return -1;
    if (av > bv) return 1;
    // 并列回退：开始时间 → 标题
    if (a.occ !== b.occ) return a.occ < b.occ ? -1 : 1;
    return (a.it.summary || "").localeCompare(b.it.summary || "", "zh");
  };
}
