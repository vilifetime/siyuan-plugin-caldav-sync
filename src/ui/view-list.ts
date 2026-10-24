/**
 * 列表视图：把「当前时间段（年/月/周/日）内的条目」按日期分组铺成一条列表。
 *
 * ## 它是**正交开关**，不是新的 ViewMode
 *
 * 工具栏的「年 / 月 / 周 / 日」决定**范围**，「列表」决定**呈现方式**：
 *   - 「月」+ 列表 → 本月所有条目的列表
 *   - 「周」+ 列表 → 本周所有条目的列表
 *   - 切范围时列表自动换范围，不必再点一次「列表」
 * 这样工具栏保持 5 个按钮（不挤），也不会出现「列表里再选年/月/周/日」的二级选择器。
 *
 * ## 范围口径与各视图保持一致
 *
 * 复用各视图**已经算好的时间窗**，而不是另起一套 —— 否则会出现
 * 「月视图里看得到、列表里没有」的条目（口径漂移是这类功能最常见的坑）。
 *
 * ## 条目内容
 *
 * 每行：时间区间 + 日历颜色点 + 条目类型图标（待办/日程）+ 标题。
 * 待办的「时间」取**到期时间**（与日历视图一致，见 view-common.todoDueOccurrences）。
 */
import type { CalItem } from "../core/types";
import { addDays, isDateOnly, parseLocalStamp, startOfWeek } from "../core/date";
import { calColorOf, escape, keyOfItem, occComparator, type ViewArgs } from "./view-common";
import { icons } from "./icons";

/** 星期中文名（周一起始，与周/月视图一致） */
const WEEK_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/**
 * 当前视图对应的时间窗（毫秒区间，左闭右开）。
 *
 * 与各视图**逐一对齐**：
 *  - 年：1 月 1 日 → 次年 1 月 1 日
 *  - 月：当月 1 日 → 次月 1 日
 *  - 周：本周一 → 下周一
 *  - 日：当天 → 次日
 *
 * ⚠️ 月视图在 UI 上是「5 行滑动窗口」（可能跨月），但**列表按自然月**取范围 ——
 * 用户在「2026 年 10 月」的标题下期望看到的就是 10 月这一个月，
 * 而不是一个从 9 月 28 日起算的 35 天窗口。
 */
export function listRange(ctx: { viewMode: string; cursor: string }): { startMs: number; endMs: number } {
  const c = ctx.cursor;
  const y = +c.slice(0, 4);
  const m = +c.slice(5, 7);
  if (ctx.viewMode === "year") {
    return { startMs: new Date(y, 0, 1).getTime(), endMs: new Date(y + 1, 0, 1).getTime() };
  }
  if (ctx.viewMode === "month") {
    return { startMs: new Date(y, m - 1, 1).getTime(), endMs: new Date(y, m, 1).getTime() };
  }
  if (ctx.viewMode === "week") {
    const ws = startOfWeek(c);
    return { startMs: parseLocalStamp(ws).getTime(), endMs: parseLocalStamp(addDays(ws, 7)).getTime() };
  }
  // 日视图
  return { startMs: parseLocalStamp(c.slice(0, 10)).getTime(), endMs: parseLocalStamp(addDays(c.slice(0, 10), 1)).getTime() };
}

/**
 * 条目在列表里的时间文案。
 *
 * - 全天条目 → 「全天」
 * - 日程 → 「开始 - 结束」（只有开始则只显示开始）
 * - 待办 → 到期时间（无时刻则「全天」）
 *
 * ⚠️ 日程的结束时间不能直接取 `it.end` 的时分 —— 跨午夜（23:00 → 次日 00:00）
 * 会被解析成 0 分钟、重复条目的 `it.end` 属于首个实例（比当前 occurrence 早一个月）。
 * 与周视图同一套算法：按「开始 + 原时长」算，收在 24:00。
 */
export function timeLabelOf(it: CalItem, occ: string): string {
  if (it.allDay || isDateOnly(occ)) return "全天";
  const startMin = (+occ.slice(11, 13) || 0) * 60 + (+occ.slice(14, 16) || 0);
  if (it.kind === "todo") {
    // 待办只有「到期时刻」这一个时间点
    return occ.slice(11, 16);
  }
  const durMs = it.start && it.end ? parseLocalStamp(it.end).getTime() - parseLocalStamp(it.start).getTime() : 0;
  const durMin = Number.isFinite(durMs) && durMs > 0 ? Math.round(durMs / 60000) : 0;
  if (durMin <= 0) return occ.slice(11, 16);
  const endMin = Math.min(startMin + durMin, 1440);
  const fmt = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${fmt(startMin)} - ${fmt(endMin)}`;
}

/** 一行条目 */
function rowHtml(ctx: ViewArgs["ctx"], it: CalItem, occ: string): string {
  const k = keyOfItem(it);
  const done = it.kind === "todo" && it.percent === 100;
  const check = it.kind === "todo" ? `<button class="cal-chip-check" data-toggle="${k}" title="${done ? "标记未完成" : "标记完成"}">✓</button>` : "";
  const kindIcon = it.kind === "todo" ? icons.tasks : icons.calendar;
  const kindLabel = it.kind === "todo" ? "待办" : "日程";
  const repeat = it.rrule ? '<span class="cal-list-repeat" title="重复">↻</span>' : "";
  return `<div class="cal-list-row ${done ? "is-done" : ""}" data-open="${k}" data-kind="${it.kind}" style="--cal-color:${calColorOf(ctx, it)}">
    <span class="cal-list-time">${escape(timeLabelOf(it, occ))}</span>
    <span class="cal-list-dot"></span>
    <span class="cal-list-kind" title="${kindLabel}">${kindIcon}</span>
    <span class="cal-list-title">${repeat}${escape(it.summary || "(无标题)")}</span>
    ${check}
  </div>`;
}

export function renderListView({ ctx, viewEl, occurrences }: ViewArgs): void {
  const { startMs, endMs } = listRange(ctx);
  const occMap = occurrences(startMs, endMs);

  // 按日期分组（组内按当前排序方式排）
  const byDay = new Map<string, { it: CalItem; occ: string }[]>();
  for (const [it, occs] of occMap) {
    for (const occ of occs) {
      const day = occ.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push({ it, occ });
    }
  }

  const cmp = occComparator(ctx.sortMode);
  const days = Array.from(byDay.keys()).sort();
  const total = days.reduce((n, d) => n + byDay.get(d)!.length, 0);

  if (!total) {
    viewEl.innerHTML = `<div class="cal-list"><div class="cal-list-empty">该时间段内暂无日程或待办</div></div>`;
    return;
  }

  const blocks = days
    .map((day) => {
      const list = byDay.get(day)!.slice().sort(cmp);
      const wd = WEEK_LABELS[(parseLocalStamp(day).getDay() + 6) % 7];
      const rows = list.map(({ it, occ }) => rowHtml(ctx, it, occ)).join("");
      return `<div class="cal-list-day">
        <div class="cal-list-date"><span class="cal-list-md">${+day.slice(5, 7)}/${+day.slice(8, 10)}</span><span class="cal-list-wd">${wd}</span><span class="cal-list-count">${list.length} 项</span></div>
        <div class="cal-list-items">${rows}</div>
      </div>`;
    })
    .join("");

  viewEl.innerHTML = `<div class="cal-list">
    <div class="cal-list-head">共 ${total} 项</div>
    ${blocks}
  </div>`;
}
