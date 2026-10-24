/**
 * 周 / 日视图：时间轴网格（周一起始，N 列），当前时间红线，全天条
 */
import { addDays, dateStampOfMs, isDateOnly, parseLocalStamp, startOfWeek, todayStamp } from "../core/date";
import { calColorOf, escape, keyOfItem, occComparator, repeatMark, type ViewArgs } from "./view-common";
import { openDateAddMenu } from "./date-add-menu";

const HOUR_H = 44; // 每小时像素
// 顶部全天栏行高由 index.css 的 .cal-wk-allday-cells min/max-height 决定（44px），
// DOM 里只写类名、不写内联高度，避免两处硬编码打架。

// 文字行数分档阈值（像素高）：矮块少显示几行，避免内容被裁。
// 必须与 index.css 里 .cal-wk-block.wk-h-* 的说明保持一致，改一处要改两处。
const TIER_XS_MAX = 34; // < 34px（约 46 分钟以内）→ 只显示标题
const TIER_S_MAX = 54; // < 54px（约 73 分钟以内）→ 标题 + 时间，再高才显示地点

/** 按块的实际像素高度算出文字行数档位 class（空串 = 全显示） */
function tierClassOf(heightPct: number): string {
  const px = (heightPct / 100) * 24 * HOUR_H;
  if (px < TIER_XS_MAX) return " wk-h-xs";
  if (px < TIER_S_MAX) return " wk-h-s";
  return "";
}

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
        // 结束分钟算法（2026-10-19 雄哥两张截图逼出来的两步修复，别合并回去）：
        // ① 待办：occ 就是到期日本身，end 也是到期日 → 时长恒 0，只取 end 的时分
        //    （与开始同一时刻），真实时长保底交给渲染层的 floorMin（待办 1 小时）。
        // ② 事件：按「开始 + 原时长」算，绝不直接取 end 的时分/日期——
        //    - 非重复跨午夜（23:00→次日 00:00）：只取时分会把「次日 00:00」解析成
        //      0 分钟，Math.max(startMin+15, 0) 把 1 小时的日程压成 15 分钟小条；
        //    - 重复条目：it.end 属于首个实例，月度例会的 it.end 比当前 occ 早整整
        //      一个月（base 9-17、occ 10-17），拿它算天数差得负数，同样被
        //      Math.max(startMin+15, …) 压成 15 分钟小条（雄哥第二张截图）。
        //    原时长平移到当前 occ 后一步都对，再由 Math.min(…, 1440) 收在 24:00 线。
        let endMin: number;
        if (it.kind === "todo") {
          endMin = Math.max(startMin + 15, endMatch ? +endMatch[1] * 60 + +endMatch[2] : startMin + 60);
        } else {
          const durMs = it.start && it.end ? parseLocalStamp(it.end).getTime() - parseLocalStamp(it.start).getTime() : 0;
          const durMin = Number.isFinite(durMs) && durMs > 0 ? Math.round(durMs / 60000) : 15;
          endMin = startMin + durMin;
        }
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
          return `<div class="cal-chip cal-chip-allday ${done ? "is-done" : ""}" data-open="${k}" data-kind="${it.kind}" style="--cal-color:${calColorOf(ctx, it)}">${check}<span class="cal-chip-title">${it.rrule ? "↻" : ""}${escape(it.summary || "(无标题)")}</span></div>`;
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
          // 极短事件（不足 15 分钟）保底 15px 高，保证还能看见、点得到。
          // ⚠️ 下限必须用绝对像素换算，不能写百分比：原来 Math.max(…, 4) 的 4% ≈ 42px ≈ 57 分钟，
          // 会把所有 42 分钟以内的事件都撑到 42px —— 色块直接超出真实时段（与 padding 那 4px 同类问题）。
          //
          // 待办另有一档保底：待办没有「时段」可言 —— occ 取到期日（DUE），end 也是 DUE，
          // 算出来恒 0 分钟，只靠 15px 地板兜底 → 11px 高，「标题行 + 上下各 2px padding」
          // 都塞不下，文字溢出成一小条（2026-10-19 雄哥截图：周/日视图待办「行高太小」）。
          // 按 1 小时保底 → 44px，落进 wk-h-s 档位，标题 + 到期时间都显示得下；
          // 真有时长的待办仍按真实时长（max 取大者）。
          const floorMin = b.it.kind === "todo" ? 60 : 15;
          let height = Math.max(((b.endMin - b.startMin) / 1440) * 100, (floorMin / 1440) * 100);
          // 贴底收口：保底后块底越出 24:00 网格线时压低高度（深夜到期的待办必然触发，
          // 23:30 到期会溢出约 21px）。再兜一层 15px 地板：23:45 之后到期的待办
          // 也不至于比旧版事件地板还矮。
          if (top + height > 100) height = Math.max(100 - top, (15 / 1440) * 100);
          const startLabel = `${String(b.startMin / 60 | 0).padStart(2, "0")}:${String(b.startMin % 60).padStart(2, "0")}`;
          const done = b.it.kind === "todo" && b.it.percent === 100;
          const check = b.it.kind === "todo"
            ? `<button class="cal-chip-check" data-toggle="${k}" title="${done ? "标记未完成" : "标记完成"}">✓</button>`
            : "";
          return `<div class="cal-wk-block ${b.it.kind === "todo" ? "cal-wk-block-todo" : ""} ${done ? "is-done" : ""}${tierClassOf(height)}" data-open="${k}" data-kind="${b.it.kind}"
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
