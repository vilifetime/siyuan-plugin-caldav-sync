/** 月视图：5 行 x 7 列（周一起始，以今天为锚的滑动窗口） */
import { addDays, dateStampOfMs, todayStamp } from "../core/date";
import { monthChipHtml, calColorOf, chinaDayBarHTML, type ViewArgs } from "./view-common";
import { openDateAddMenu } from "./date-add-menu";
import { openMonthDayPopup, closeMonthDayPopup, schedulePopupClose, cancelPopupClose } from "./month-day-popup";

const WEEK_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function renderMonthView(args: ViewArgs): void {
  const { ctx, viewEl, occurrences } = args;
  const cursor = ctx.cursor;
  const y = +cursor.slice(0, 4);
  const m = +cursor.slice(5, 7);

  // 「以今天为锚的 5 周滑动窗口」：今天所在月时锚定今天，翻到其他月时锚定该月 15 号（居中），
  // 保证翻月有意义且窗口恒为 5 行。若锚落在标准 6 行月历的第 5/6 行，则窗口后移一周。
  const cursorYM = `${y}-${String(m).padStart(2, "0")}`;
  const todayYM = todayStamp().slice(0, 7);
  const todayDate = new Date();
  const anchor = cursorYM === todayYM ? todayDate : new Date(y, m - 1, 15);
  const monthFirst = new Date(y, m - 1, 1);
  const aStart = new Date(monthFirst);
  aStart.setDate(1 - ((monthFirst.getDay() + 6) % 7)); // 当月1号所在周一对齐 = 标准 6 行月历起点
  const R = Math.floor((anchor.getTime() - aStart.getTime()) / 86400000 / 7) + 1; // 锚在标准 6 行月历中的行号 1..6
  const startWeek = R >= 5 ? 1 : 0; // 今天在第 5/6 行 → 窗口后移显示第 2~6 行；否则第 1~5 行。恒为 5 行。
  const w = new Date(aStart);
  w.setDate(w.getDate() + startWeek * 7);
  const windowStartMs = w.getTime();
  const totalCells = 35;
  const totalWeeks = 5;

  const startMs = windowStartMs;
  const endMs = startMs + totalCells * 86400000;
  const occMap = occurrences(startMs, endMs);
  const today = todayStamp();

  // 当前本地时间戳，用于「超过 3 个时优先显示当前时间之后最靠前的条目」
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const nowStamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

  // 按日期分桶
  const buckets = new Map<string, { it: import("../core/types").CalItem; occ: string }[]>();
  for (const [it, occs] of occMap) {
    for (const occ of occs) {
      const day = occ.slice(0, 10);
      if (!buckets.has(day)) buckets.set(day, []);
      buckets.get(day)!.push({ it, occ });
    }
  }

  const rowTemplate = `grid-template-rows: repeat(${totalWeeks}, 1fr);`;

  const MAX_CHIPS = 3;
  const html: string[] = [];
  /** 每天的**完整**条目表：默认只渲染前 3 条，放不下时浮层里按需取全部 */
  const dayEntries = new Map<string, { it: import("../core/types").CalItem; occ: string }[]>();
  html.push(`<div class="cal-month"><div class="cal-month-weeks">${WEEK_LABELS.map((w) => `<div class="cal-month-weeklabel">${w}</div>`).join("")}</div><div class="cal-month-grid" ${rowTemplate ? `style="${rowTemplate}"` : ""}>`);
  for (let i = 0; i < totalCells; i++) {
    const day = addDays(dateStampOfMs(startMs), i);
    const inMonth = +day.slice(5, 7) === m;
    const isToday = day === today;
    const fullList = (buckets.get(day) || []).sort((a, b) => a.occ.localeCompare(b.occ));
    // 超过 3 个时，优先显示当前时间之后最靠前的 3 个；
    // 若当前时间之后不足 3 个，则回退到当天最靠前的 3 个，保证格子始终尽量填满。
    let shown = fullList;
    if (fullList.length > MAX_CHIPS) {
      const future = fullList.filter(({ occ }) => occ >= nowStamp);
      shown = future.length >= MAX_CHIPS ? future.slice(0, MAX_CHIPS) : fullList.slice(0, MAX_CHIPS);
    }
    const chips = shown
      .slice(0, MAX_CHIPS)
      .map(({ it, occ }) => monthChipHtml(it, occ, calColorOf(ctx, it)))
      .join("");
    const more = fullList.length - shown.length;
    // 每天的完整条目挂 data-* 上：悬停/点击展开浮层时直接取，不必重新查一遍
    html.push(`<div class="cal-month-cell ${inMonth ? "" : "is-out"} ${isToday ? "is-today" : ""}" data-day="${day}" data-more="${more}">
      <div class="cal-month-daynum">${isToday ? `<span class="cal-today-badge">${+day.slice(8, 10)}</span>` : +day.slice(8, 10)}${chinaDayBarHTML(ctx, day)}</div>
      <div class="cal-month-chips">${chips}${more > 0 ? `<div class="cal-chip-more" title="悬停或点击查看全部 ${fullList.length} 项">还有 ${more} 项…</div>` : ""}</div>
    </div>`);
    // 完整条目暂存到 map：浮层按需渲染全部（默认仍截断，保持月视图清爽）
    dayEntries.set(day, fullList);
  }
  html.push(`</div></div>`);
  viewEl.innerHTML = html.join("");

  // ---- 悬停展开「某日全部条目」浮层（**只由悬停触发**）----
  // ⚠️ 刻意**不做**格内滚动：格内滚动会劫持滚轮（26 格各滚各的，整个月视图推不动），
  //    触摸板双指滚动也会被吃掉。要看全时用浮层，月视图的「整月概览」定位不丢。
  // ⚠️ 也**不做**点击触发（2026-10-14 雄哥实测后取消）：单击空白处弹浮层，
  //    再单击同一处既不会关（悬停逻辑已展开过）又语义别扭 —— 点击空白处
  //    本就该留给「双击新建」用，别抢它的地盘。浮层一律由悬停进出。
  const HOVER_DELAY = 220; // 掠过时给一点延迟，避免扫过一格就弹浮层
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  const clearHover = (): void => {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
  };
  const showFor = (cell: HTMLElement): void => {
    const day = cell.dataset.day || "";
    const list = dayEntries.get(day) || [];
    // 只有放不下时才需要浮层；一条不差时不必打扰用户
    if (!list.length) return;
    // ⚠️ 锚点用**格子本身**，不用「还有 N 项…」那一行：
    // 格子是 `overflow: hidden`，放不下的 chip 与 more 行会被裁在可视区之外，
    // 它的 getBoundingClientRect().bottom 比格子真实底边偏上 —— 于是浮层会
    // 浮在「半空」里，与格子下边留出一道明显的缝（2026-10-14 雄哥实测截图）。
    // 贴格子底边才是「紧挨着这格」。
    // cell 作为「保持区」：指针在它或浮层内都不收起（传 viewEl 会永远收不掉）
    // owner 作为「点不关」范围：点月视图内别的格子时交给格子自己的 click 切换
    openMonthDayPopup(ctx, day, list, cell, () => renderMonthView(args), cell, viewEl);
  };
  // 切换视图 / 卸载 / 浮层开着时重绘，都要把浮层收掉，否则它会挂在已销毁的格子上
  closeMonthDayPopup();
  viewEl.querySelectorAll<HTMLElement>(".cal-month-cell").forEach((cell) => {
    cell.addEventListener("mouseenter", () => {
      if (Number(cell.dataset.more || "0") <= 0) return; // 全放得下 → 不出浮层
      cancelPopupClose(); // 指针回到格子：取消上一轮倒计时
      clearHover();
      hoverTimer = setTimeout(() => showFor(cell), HOVER_DELAY);
    });
    // 移出格子 → 开始倒计时。指针划向紧贴的浮层（间隙 0）期间一旦落到
    // 浮层上（mouseenter）就取消；停在浮层上则一直保留（雄哥定的规则）。
    cell.addEventListener("mouseleave", () => {
      clearHover();
      if (document.querySelector(".caldav-month-pop")) schedulePopupClose();
    });
  });

  // 日期单元格双击：弹出新增事件/任务
  viewEl.querySelectorAll<HTMLElement>(".cal-month-cell").forEach((cell) => {
    cell.addEventListener("dblclick", (ev) => {
      if ((ev.target as HTMLElement).closest(".cal-chip")) return; // 双击已有事件本身则不新建
      openDateAddMenu(ctx, ev.clientX, ev.clientY, cell.dataset.day!);
    });
  });
}
