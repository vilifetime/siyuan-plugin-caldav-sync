/**
 * 周 / 日视图：时间轴网格（周一起始，N 列），当前时间红线，全天条
 */
import { addDays, dateStampOfMs, isDateOnly, parseLocalStamp, startOfWeek, todayStamp } from "../core/date";
import { calColorOf, escape, keyOfItem, occComparator, repeatMark, type ViewArgs } from "./view-common";
import { openDateAddMenu } from "./date-add-menu";

const HOUR_H = 44; // 每小时像素
// 顶部全天栏行高由 index.css 的 .cal-wk-allday-cells min/max-height 决定（44px），
// DOM 里只写类名、不写内联高度，避免两处硬编码打架。

interface Block {
  it: import("../core/types").CalItem;
  occ: string;
  day: string;
  startMin: number;
  endMin: number;
}

export function renderWeekView({ ctx, viewEl, occurrences }: ViewArgs, days: number): void {
  const cursor = ctx.cursor;
  const firstDay = days === 7 ? startOfWeek(cursor) : cursor.slice(0, 10);
  const dayList: string[] = [];
  for (let i = 0; i < days; i++) dayList.push(addDays(firstDay, i));
  const rangeStartMs = parseLocalStamp(dayList[0]).getTime();
  const rangeEndMs = rangeStartMs + days * 86400000;
  const occMap = occurrences(rangeStartMs, rangeEndMs);
  const today = todayStamp();

  // 分桶：全天 / 定时
  const allDay: { it: import("../core/types").CalItem; occ: string }[] = [];
  const blocks: Block[] = [];
  for (const [it, occs] of occMap) {
    for (const occ of occs) {
      const day = occ.slice(0, 10);
      if (!dayList.includes(day)) continue;
      if (it.allDay || isDateOnly(occ)) {
        allDay.push({ it, occ });
      } else {
        // 统一从时间戳字符串解析 HH:mm，确保标签、位置、结束时间同源
        const timeRe = /T(\d{2}):(\d{2}):\d{2}$/;
        const startMatch = timeRe.exec(occ);
        const startMin = startMatch ? +startMatch[1] * 60 + +startMatch[2] : 0;
        const end = it.end || occ;
        const endMatch = timeRe.exec(end) || startMatch;
        const endMin = Math.max(startMin + 15, endMatch ? +endMatch[1] * 60 + +endMatch[2] : startMin + 60);
        blocks.push({ it, occ, day, startMin, endMin: Math.min(endMin, 1440) });
      }
    }
  }

  const dayHead = dayList
    .map((d) => {
      const wd = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][(parseLocalStamp(d).getDay() + 6) % 7];
      return `<div class="cal-wk-dayhead ${d === today ? "is-today" : ""}" data-day="${d}">
        <span class="cal-wk-wd">${wd}</span><span class="cal-wk-num">${+d.slice(8, 10)}</span></div>`;
    })
    .join("");

  const hours: string[] = [];
  for (let h = 0; h < 24; h++) {
    hours.push(`<div class="cal-wk-hour" style="height:${HOUR_H}px"><span>${String(h).padStart(2, "0")}:00</span></div>`);
  }

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const showNowLine = dayList.includes(dateStampOfMs(now.getTime()));

  const allDayRow = dayList
    .map((d) => {
      const chips = allDay
        .filter((b) => b.occ.slice(0, 10) === d)
        .sort(occComparator(ctx.sortMode))
        .map(({ it }) => {
          const k = keyOfItem(it);
          const done = it.kind === "todo" && it.percent === 100;
          const check = it.kind === "todo" ? `<button class="cal-chip-check" data-toggle="${k}">✓</button>` : "";
          return `<div class="cal-chip cal-chip-allday ${done ? "is-done" : ""}" data-open="${k}" style="--cal-color:${calColorOf(ctx, it)}">${check}<span class="cal-chip-title">${it.rrule ? "↻" : ""}${escape(it.summary || "(无标题)")}</span></div>`;
        })
        .join("");
      return `<div class="cal-wk-allday-cell" data-day="${d}">${chips}</div>`;
    })
    .join("");

  const gridCols = dayList
    .map((d) => {
      const inner = blocks
        .filter((b) => b.day === d)
        .map((b) => {
          const k = keyOfItem(b.it);
          const top = (b.startMin / 1440) * 100;
          const height = Math.max(((b.endMin - b.startMin) / 1440) * 100, 4);
          const startLabel = `${String(b.startMin / 60 | 0).padStart(2, "0")}:${String(b.startMin % 60).padStart(2, "0")}`;
          const done = b.it.kind === "todo" && b.it.percent === 100;
          const check = b.it.kind === "todo"
            ? `<button class="cal-chip-check" data-toggle="${k}" title="${done ? "标记未完成" : "标记完成"}">✓</button>`
            : "";
          return `<div class="cal-wk-block ${b.it.kind === "todo" ? "cal-wk-block-todo" : ""} ${done ? "is-done" : ""}" data-open="${k}"
            style="--cal-color:${calColorOf(ctx, b.it)};top:${top}%;height:${height}%">
            <div class="cal-wk-block-head">${check}<div class="cal-wk-block-title">${repeatMark(b.it)}${escape(b.it.summary || "(无标题)")}${b.it.location ? `<span class="cal-wk-block-loc-inline">📍 ${escape(b.it.location)}</span>` : ""}</div></div>
            <div class="cal-wk-block-time">${startLabel}</div>
            ${b.it.location ? `<div class="cal-wk-block-loc">📍 ${escape(b.it.location)}</div>` : ""}
          </div>`;
        })
        .join("");
      return `<div class="cal-wk-col" data-day="${d}">${inner}${showNowLine && d === today ? `<div class="cal-wk-nowline" style="top:${(nowMin / 1440) * 100}%"></div>` : ""}</div>`;
    })
    .join("");

  const hasAllDay = allDay.length > 0;

  viewEl.innerHTML = `
<div class="cal-wk ${days === 1 ? "is-day" : ""}" style="--cols:${days}">
  <div class="cal-wk-header">
    <div class="cal-wk-gutterhead"></div>
    <div class="cal-wk-days">${dayHead}</div>
  </div>
  <div class="cal-wk-allday${hasAllDay ? "" : " is-empty"}">
    <div class="cal-wk-allday-label">全天</div>
    <div class="cal-wk-allday-cells">${allDayRow}</div>
  </div>
  <div class="cal-wk-main">
    <div class="cal-wk-gutter">${hours.join("")}</div>
    <div class="cal-wk-grid" style="height:${24 * HOUR_H}px">${gridCols}</div>
  </div>
</div>`;

  // 安全性兜底：全天栏在 DOM 上是 .cal-wk-main 的兄弟，任何情况下都不该消失。
  // 若渲染后它被压成 0 高（父级 flex/overflow 挤压、宿主样式污染等），强制恢复成一行，
  // 免得又出现「全天事件看不见」这种只能靠肉眼发现的问题。
  if (hasAllDay) {
    const ad = viewEl.querySelector<HTMLElement>(".cal-wk-allday");
    if (ad && ad.getBoundingClientRect().height < 1) ad.style.flex = "0 0 44px";
  }

  // 全天栏是独立于滚动容器的固定行（同 .cal-wk-header），所以这里可以按整条时间网格
  // 的高度算滚动量，全天栏不会被滚走。留 120 分钟余量，让当前时间线不至于贴死顶边。
  const sc = viewEl.querySelector<HTMLElement>(".cal-wk-main");
  if (sc) {
    const target = Math.max(0, ((nowMin - 120) / 1440) * 24 * HOUR_H);
    setTimeout(() => (sc.scrollTop = target), 0);
  }
  // 日期单元格/全天区双击：弹出新增事件/任务
  viewEl.querySelectorAll<HTMLElement>(".cal-wk-col,.cal-wk-allday-cell").forEach((col) => {
    col.addEventListener("dblclick", (ev) => {
      if ((ev.target as HTMLElement).closest(".cal-chip")) return; // 双击已有事件本身则不新建
      const day = col.dataset.day!;
      let startEvent = day; // 只给日期；具体时刻由编辑弹窗补（今天 = 下一个整点）
      if (col.classList.contains("cal-wk-col") && ev.target === col) {
        const rect = col.getBoundingClientRect();
        const mins = Math.floor(((ev.clientY - rect.top) / rect.height) * 1440 / 30) * 30;
        startEvent = `${day}T${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;
      }
      openDateAddMenu(ctx, ev.clientX, ev.clientY, day, startEvent);
    });
  });
}
