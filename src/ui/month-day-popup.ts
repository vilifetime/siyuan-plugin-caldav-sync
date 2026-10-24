/**
 * 月视图「某一天的���部条目」浮层（2026-10-14）。
 *
 * 为什么是浮层而不是格内滚动：
 *  1. 月视图的价值是「一眼看清整月分布」，一格塞十几条彩色卡片会变成色块墙；
 *  2. **格内滚动会劫持滚轮** —— 26 个格子各滚各的，整个月视图就推不动了，
 *     触摸板双指滚动也会被吃掉；月视图本身是嵌在整体可滚动面板里的。
 * 所以默认仍截断（每格 3 条 + 「还有 N 项…」），**悬停或点击才浮层展开**，
 * 既保住了清爽，也看得全。
 *
 * 交互沿用 date-add-menu.ts 的浮层约定：挂 body、点外部 / Esc 关闭、
 * 延迟一帧再绑监听（避免本次点击立即触发关闭）、定位夹紧在视口内。
 *
 * ⚠️ 本浮层挂在 body 上，**祖先链里没有 `.caldav-root`**，`--caldav-*` / `--d-*`
 * 全部取不到值 → 必须在 `.caldav-month-pop` 自身重新声明一遍变量映射
 * （与 `.caldav-dock-cat-pop`、`.caldav-editor` 等 body 级弹层同一套做法）。
 */
import type { PanelCtx } from "./panel";
import { toggleTodoDone } from "./panel";
import { openEditor } from "./editor";
import { monthChipHtml, calColorOf, keyOfItem } from "./view-common";
import type { CalItem } from "../core/types";

export interface MonthDayEntry {
  it: CalItem;
  occ: string;
}

/**
 * 「点这些容器内部不关闭浮层」的容器集合（由 openMonthDayPopup 填入）。
 * 月视图把格子所在的视图容器登记进来：点在格子上时，格子自己的 click 会接管
 * （开新的 / 切换），不该被「点外部关闭」抢先关掉上一个浮层。
 */
const ANCHOR_CONTAINERS: HTMLElement[] = [];

/** 当前打开的浮层（同一时刻最多一个），便于外部关闭 */
let opened: HTMLElement | null = null;

/**
 * 「指针对着它就别收起」的判定范围：触发它的那一个格子 + 浮层自身。
 *
 * ⚠️ 这里**必须且只能是「触发的那一个格子」**，绝不能传整个视图容器
 * （2026-10-14 雄哥两次打回才想明白）：
 *  - 传格子太大 → 指针在整个月视图里都算「在内」→ **永远收不掉**；
 *  - 只判浮层不判格子 → 指针从格子移向浮层的路上必然先离开格子，
 *    立即收就**点不到任何条目**。
 * 配 CLOSE_DELAY 延迟刚好：指针从格子划到紧贴的浮层（间隙 0）在该窗口内，
 * 期间落在浮层上就取消收起；停在浮层上就一直保留。
 */
let hoverZone: HTMLElement | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

/** 指针是否落在「触发格子 ∪ 浮层」内 */
function pointerInsideZone(e: MouseEvent): boolean {
  const t = e.target as Node | null;
  if (!t) return false;
  if (opened && opened.contains(t)) return true;
  if (hoverZone && hoverZone.contains(t)) return true;
  return false;
}

/** 取消待收起（指针进入格子或浮层时调用） */
export function cancelPopupClose(): void {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = null;
}

/**
 * 延迟收起（雄哥定的 0.6 秒）。
 *
 * 为什么要有这段延迟：指针从格子划向浮层的途中会短暂「既不在格子、也不在浮层」，
 * 立即关的话浮层在指针到达前就没了。这段延迟给了足够时间跨过去；
 * 期间一旦落到浮层上（mouseenter）就取消。
 */
export function schedulePopupClose(delay = CLOSE_DELAY): void {
  cancelPopupClose();
  closeTimer = setTimeout(() => {
    closeTimer = null;
    closeMonthDayPopup();
  }, delay);
}

/** 悬停/点击浮层的收起延迟（毫秒）—— 雄哥指定 0.6 秒 */
const CLOSE_DELAY = 600;

/**
 * 关掉已打开的浮层。
 *
 * 关闭时机：**指针移出「格子 ∪ 浮层」延迟后 / 点外部 / 按 Esc / 切视图重绘**。
 * 指针停在浮层上则一直保留，直到点某个条目（进编辑器时随之关闭）。
 */
export function closeMonthDayPopup(): void {
  cancelPopupClose();
  opened?.remove();
  opened = null;
  hoverZone = null;
  document.removeEventListener("mousedown", onDocMouseDown, true);
  document.removeEventListener("keydown", onDocKeyDown, true);
  document.removeEventListener("mouseover", onDocMouseOver, true);
}

/**
 * 兜底：指针移到「触发格子 ∪ 浮层」**之外**时开始/取消延迟收起。
 *
 * ⚠️ 为什么必须在 document 上兜一层（不能只靠格子与浮层各自的 mouseleave）：
 * 指针移到第三方面板元素（工具栏、月历空白处）时，那儿**不会**冒出我们关心的
 * 任何 mouseleave，事件只冒泡到 document —— 只绑在格子/浮层上的话，
 * 指针移出月视图后浮层会一直残留。
 */
function onDocMouseOver(e: MouseEvent): void {
  if (!opened) return;
  if (pointerInsideZone(e)) {
    cancelPopupClose(); // 指针还在范围内 → 不收
    return;
  }
  schedulePopupClose(); // 指针已移出 → 开始倒计时
}

/**
 * 「点外部关闭」—— 靠**事件落在谁身上**判定：
 * 落在浮层内部、或落在月视图容器内（点另一个格子 → 由格子自己的 click 切换）都不关，
 * 其余（点到工具栏、空白、其它区域）立即关。
 *
 * ⚠️ 这里刻意**不用**「打开时记一个布尔/时间戳、第一次 mousedown 放过」那套：
 *  - 布尔标记：打开浮层的点击未必伴随 mousedown（键盘回车、touch 端就没有），
 *    标记会一直挂着，把用户**下一次真实的点击外部**也吞掉 → 浮层关不掉；
 *  - 时间戳：`event.timeStamp` 与 `Date.now()` 基准未必一致（jsdom 就不同），
 *    比较结果不可靠。
 */
function onDocMouseDown(e: MouseEvent): void {
  const pop = opened;
  if (!pop) return;
  const t = e.target as Node | null;
  if (t && pop.contains(t)) return; // 点浮层内部：不关
  if (t && ANCHOR_CONTAINERS.some((c) => c.contains(t))) return; // 点月视图格子：交给格子自己的 click
  closeMonthDayPopup();
}
function onDocKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") closeMonthDayPopup();
}

/**
 * 在锚点元素旁弹出某一天的全部条目。
 *
 * @param ctx     面板上下文（打开编辑器 / 勾选完成都要用）
 * @param day     YYYY-MM-DD
 * @param entries 当天全部条目（已按发生时间排序）
 * @param anchor  锚点（格子里的「还有 N 项…」或格子本身），用来定位
 * @param onDone  条目在别处被改动后的回调（让调用方重绘）
 * @param cell    **触发它的那一个格子**：指针留在它或浮层内都不收起（见 hoverZone）
 * @param owner   格子所在的视图容器：点在它内部不触发「点外部关闭」（见 ANCHOR_CONTAINERS）
 */
export function openMonthDayPopup(
  ctx: PanelCtx,
  day: string,
  entries: MonthDayEntry[],
  anchor: HTMLElement,
  onDone?: () => void,
  cell?: HTMLElement | null,
  owner?: HTMLElement | null
): void {
  closeMonthDayPopup();
  if (!entries.length) return;
  ANCHOR_CONTAINERS.length = 0;
  if (owner) ANCHOR_CONTAINERS.push(owner);
  // 保持区 = 触发它的那一个格子（**不是整个视图容器**，见 hoverZone 注释）
  hoverZone = cell || null;

  const pop = document.createElement("div");
  pop.className = "caldav-month-pop";
  const [, m, d] = day.split("-");
  pop.innerHTML = `
    <div class="caldav-month-pop-head">
      <span class="caldav-month-pop-title">${+m}月${+d}日</span>
      <span class="caldav-month-pop-count">${entries.length} 项</span>
    </div>
    <div class="caldav-month-pop-list">
      ${entries.map(({ it, occ }) => monthChipHtml(it, occ, calColorOf(ctx, it))).join("")}
    </div>
  `;
  document.body.appendChild(pop);
  opened = pop;

  // 定位：**紧贴**锚点，间隙 0（2026-10-14 雄哥两次反馈：2px 仍嫌大，要「紧挨」）。
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const GAP = 0;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - pw - 8));
  let top = r.bottom + GAP;
  if (top + ph > window.innerHeight - 8) {
    const above = r.top - ph - GAP;
    // 上下都放不下时，取「能露出更多」的那一侧
    top = above >= 8 ? above : Math.max(8, window.innerHeight - ph - 8);
  }
  pop.style.left = left + "px";
  pop.style.top = top + "px";

  // 浮层自身的 hover：进入则取消倒计时，离开则重新开始倒计时。
  // 指针停在浮层上时 document 兜底也会判「在范围内」而取消，这里是双保险
  // （mouseover 在指针快速掠过浮层时不一定逐个元素都冒泡到）。
  pop.addEventListener("mouseenter", cancelPopupClose);
  pop.addEventListener("mouseleave", () => schedulePopupClose());

  // 立刻绑定关闭监听（不学 date-add-menu 用 setTimeout 延迟）：
  // 延迟绑定会留一个「监听还没挂上」的窗口，用户手快按 Esc 时就关不掉。
  document.addEventListener("mousedown", onDocMouseDown, true);
  document.addEventListener("keydown", onDocKeyDown, true);
  document.addEventListener("mouseover", onDocMouseOver, true);

  // 条目交互：点勾选框切完成、点其余部分进编辑器
  pop.querySelectorAll<HTMLElement>(".cal-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      const key = chip.dataset.open || "";
      // ⚠️ 必须用 view-common 导出的 keyOfItem（uid|recurId，不含 kind），别自己另写一套 ——
      //    月视图 chip 的 data-open 就是这个口径的键，自写会一个都匹配不上。
      const target = ctx.store.getAll().find((x) => keyOfItem(x) === key);
      if (!target) return;
      if ((e.target as HTMLElement).closest(".cal-chip-check")) {
        e.stopPropagation();
        void toggleTodoDone(ctx, target).then(() => {
          // 浮层里那一行就地改状态，不必整个重建（重建会把滚动位置与浮层位置都弄丢）
          const done = target.percent === 100;
          chip.classList.toggle("is-done", done);
          const box = chip.querySelector(".cal-chip-check");
          if (box) box.textContent = done ? "✓" : "";
          onDone?.();
        });
        return;
      }
      e.stopPropagation();
      closeMonthDayPopup();
      openEditor(ctx, { item: target });
    });
  });
}
