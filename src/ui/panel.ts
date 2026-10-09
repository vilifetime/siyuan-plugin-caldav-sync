/**
 * 面板骨架：
 *  - 主窗口页签形态：顶部工具栏（年/月/周/日 切换 + 导航 + 新增 + 日历筛选）+ 视图容器
 *  - 左侧 Dock：标题「日历任务管理」+ 一行 5 个按钮（新增、排序、日历视图、任务视图、刷新）
 * Dock 负责导航与新增/排序/刷新，主面板只呈现日历视图。
 */
import type { CalStore } from "../core/store";
import { keyOf } from "../core/store";
import type { SyncEngine } from "../core/sync";
import type { CalItem, CalKind, SortMode } from "../core/types";
import { DEFAULT_CATEGORIES, calEventColor, setTaskViewEventsShown } from "../core/types";
import { occurrencesInRange } from "../core/ics";
import { parseLocalStamp, stampOfMs, todayStamp, startOfWeek, addDays, isDateOnly, fmtTime, fmtDateCn, diffDays } from "../core/date";
import { icons } from "./icons";
import { isMobile } from "./device";
import { openEditor } from "./editor";
import { openSettingsDialog } from "./settings-dialog";
import { askDiaryRange } from "./diary-range-dialog";
import type { DiaryRange, DiaryTarget } from "./diary-range";
import { renderMonthView } from "./view-month";
import { renderWeekView } from "./view-week";
import { renderTaskView } from "./view-task";
import { renderYearView } from "./view-year";
import { todoDueOccurrences } from "./view-common";

export type ViewMode = "year" | "month" | "week" | "day" | "task";

export interface PanelCtx {
  store: CalStore;
  sync: SyncEngine;
  i18n: (key: string) => string;
  /**
   * 把日程与待办插入日记（由入口注入，依赖思源内核 API）。
   *
   * ⚠️ 必须收下 `range` / `target` 并透传 —— 无参版本会吞掉弹窗里选的范围，
   * 永远走默认「当日 + 今天」。
   */
  insertTodayToDiary: (range?: DiaryRange, target?: DiaryTarget) => Promise<string>;
  /** 发送一条测试提醒（由入口注入，用于自检提醒投递通道） */
  testReminder?: () => Promise<string>;
  /**
   * 手动触发一次同步（工具栏同步按钮），由入口注入。
   * 面板只负责触发，状态提示/重绘/重排提醒都在入口那侧统一做。
   */
  syncNow?: () => Promise<unknown>;
  /** 提醒状态摘要（由入口注入，显示已排程条数与带提醒时间的条目数） */
  reminderStatus?: () => string;
  /**
   * 让已打开的面板整体重渲染（由入口注入）。
   * 设置页保存后主面板不会自动刷新 —— 任务视图的两个开关若改了却不重渲染，
   * 用户会觉得「点了没生效」。故由设置页显式调一次。
   */
  refreshPanels?: () => void;
  unsaved: Set<string>; // 面板实例 key，防重复渲染
  viewMode: ViewMode;
  cursor: string; // 当前聚焦日期 YYYY-MM-DD
  /** 排序方式：开始/结束/优先级/完成/创建/分类/标题 */
  sortMode: SortMode;
  /** 视图内导航（年视图跳月/日用），由 renderPanel 注入 */
  navigate?: (mode: ViewMode, cursor?: string) => void;
}

export function renderPanel(root: HTMLElement, ctx: PanelCtx): { destroy: () => void; refresh: () => void } {
  root.classList.add("caldav-root");
  // 触摸形态标记：移动端日历格子里放不下「时间 + 标题」，只留标题（见 index.css .caldav-touch）。
  // 用类而不是媒体查询，桌面端把窗口拖窄时仍保留时间列。
  root.classList.toggle("caldav-touch", isMobile());
  root.innerHTML = `
<div class="caldav-app caldav-app--flat">
  <main class="caldav-main">
    <header class="caldav-toolbar">
      <div class="caldav-toolbar-left">
        <button class="caldav-icon-btn" data-action="prev" title="上一页">${icons.prev}</button>
        <button class="caldav-btn" data-action="today">今天</button>
        <button class="caldav-icon-btn" data-action="next" title="下一页">${icons.next}</button>
        <span class="caldav-cursor-title"></span>
      </div>
      <div class="caldav-toolbar-center">
        <div class="caldav-seg" role="tablist" aria-label="视图切换">
          <button class="caldav-seg-btn" data-view="year">年</button>
          <button class="caldav-seg-btn" data-view="month">月</button>
          <button class="caldav-seg-btn" data-view="week">周</button>
          <button class="caldav-seg-btn" data-view="day">日</button>
        </div>
      </div>
      <!--
        任务视图的统计条挂载点。放在 toolbar-right **之前** —— 任务视图时左中两块
        被 .is-task 隐藏，统计条自然靠左；日历视图时本元素为空（见 renderView 的清空），
        不占位。实际内容由 view-task.ts 渲染后写进来（统计数据的来源在那边）。
      -->
      <div class="caldav-toolbar-stats" data-slot="task-stats"></div>
      <div class="caldav-toolbar-right">
        <button class="caldav-btn caldav-btn-primary" data-action="new-event">${icons.plus} 日程</button>
        <button class="caldav-btn" data-action="new-todo">${icons.plus} 待办</button>
        <!--
          手动同步按钮（2026-10-09 雄哥要求，与 Obsidian 侧对齐）：
          原来只有 Dock 里的刷新键与命令面板里有同步入口，主面板工具栏没有 ——
          想立刻拉一次得先切到 Dock。图标用icons.sync。
        -->
        <button class="caldav-icon-btn" data-action="sync-now" title="立即同步 CalDAV"
                aria-label="立即同步 CalDAV">${icons.sync}</button>
        <div class="caldav-calfilter-wrap">
          <button class="caldav-icon-btn" data-action="calfilter" title="日历筛选">${icons.layers}</button>
          <div class="caldav-calfilter-pop" data-pop="calfilter" hidden>
            <div class="caldav-cal-head">日历筛选</div>
            <div class="caldav-cal-list"></div>
            <label class="caldav-switch-line caldav-switch-line--inline caldav-calfilter-opt">
              <span class="caldav-switch-label">日历视图中显示待办任务</span>
              <span class="caldav-switch">
                <input type="checkbox" data-opt="showTodos"/>
                <span class="caldav-switch-track"></span>
              </span>
            </label>
            <!--
              任务视图的两个开关（2026-10-08 对齐 Obsidian 侧：那边就放在这个浮层里）。
              **这是唯一入口** —— 设置弹窗里不再放同一对开关，避免两处都能改、
              改完互相打架。默认都是关的；第二层「显示过期日程」初始 hidden，
              主开关打开才出现，hidden 时整行不占位
              （display 由 CSS 类定为 flex，必须另写 [hidden] 规则）。
            -->
            <label class="caldav-switch-line caldav-switch-line--inline caldav-calfilter-opt">
              <span class="caldav-switch-label">任务视图中显示日程事件</span>
              <span class="caldav-switch">
                <input type="checkbox" data-opt="showEvents"/>
                <span class="caldav-switch-track"></span>
              </span>
            </label>
            <label class="caldav-switch-line caldav-switch-line--inline caldav-calfilter-opt caldav-switch-line--nested"
                   data-opt-row="showExpired" hidden>
              <span class="caldav-switch-label">任务视图中显示过期日程</span>
              <span class="caldav-switch">
                <input type="checkbox" data-opt="showExpired"/>
                <span class="caldav-switch-track"></span>
              </span>
            </label>
            <!--
              「过期」在任务视图里没有独立的「逾期」语义：分桶时直接归到「已完成」组。
              不写这句，用户会去「逾期」组里找这些日程、然后以为开关坏了。
              与主行同缩进、再小一档字号，视觉上属于上面那行的脚注。
            -->
            <div class="caldav-calfilter-note" data-note="showExpired" hidden>（过期按[已完成]处理）</div>
            <div class="caldav-calfilter-foot">
              <!-- 不再写死「今日」：点了先弹范围选择（当日/本周/本月/所有） -->
              <button class="caldav-link" data-action="insert-diary">把日程与待办插入日记</button>
            </div>
          </div>
        </div>
        <button class="caldav-icon-btn" data-action="toggle-view" title="切换到任务视图" aria-label="切换到任务视图"></button>
      </div>
    </header>
    <div class="caldav-view"></div>
  </main>
</div>
<div class="caldav-ctxmenu" hidden>
  <button class="caldav-ctxmenu-item" data-ctx="edit">${icons.pencil} 编辑</button>
  <button class="caldav-ctxmenu-item" data-ctx="delete">${icons.trash} 删除</button>
  <div class="caldav-ctxmenu-err" hidden></div>
</div>`;

  const app = root.querySelector(".caldav-app") as HTMLElement;
  const calListEl = root.querySelector(".caldav-cal-list") as HTMLElement;
  const calfilterPop = root.querySelector(".caldav-calfilter-pop") as HTMLElement;
  const showTodosInput = root.querySelector('[data-opt="showTodos"]') as HTMLInputElement;
  const showEventsInput = root.querySelector('[data-opt="showEvents"]') as HTMLInputElement;
  const showExpiredInput = root.querySelector('[data-opt="showExpired"]') as HTMLInputElement;
  const showExpiredRow = root.querySelector('[data-opt-row="showExpired"]') as HTMLElement;
  const showExpiredNote = root.querySelector('[data-note="showExpired"]') as HTMLElement;
  const viewEl = root.querySelector(".caldav-view") as HTMLElement;
  const cursorTitleEl = root.querySelector(".caldav-cursor-title") as HTMLElement;
  const ctxMenu = root.querySelector(".caldav-ctxmenu") as HTMLElement;
  const segBtns = Array.from(root.querySelectorAll(".caldav-seg-btn")) as HTMLElement[];
  const viewToggleBtn = root.querySelector('[data-action="toggle-view"]') as HTMLElement;
  const syncBtn = root.querySelector('[data-action="sync-now"]') as HTMLButtonElement;
  /** 同步按钮的「正在同步」闸：连点时直接忽略第二次 */
  let syncBusy = false;
  let destroyed = false;
  /** 右键菜单当前指向的条目 key */
  let ctxMenuKey: string | null = null;

  function renderCalList(): void {
    const cals = ctx.store.settings.calendars;
    if (!cals.length) {
      calListEl.innerHTML = `<div class="caldav-cal-empty">尚未配置服务器<br><button class="caldav-link" data-action="settings">去配置 →</button></div>`;
      return;
    }
    calListEl.innerHTML = cals
      .map(
        (c, i) => `
      <div class="caldav-cal-item ${c.enabled ? "" : "is-off"}" data-cal="${i}"
           title="${c.enabled ? "点击在视图中隐藏此日历" : "点击在视图中显示此日历"}">
        <span class="caldav-cal-dot" style="background:${calEventColor(c)}"></span>
        <span class="caldav-cal-name" title="${escapeAttr(c.url)}">${escapeHtml(c.displayName)}</span>
        <button class="caldav-icon-btn caldav-cal-toggle" type="button"
                aria-pressed="${c.enabled ? "true" : "false"}"
                title="${c.enabled ? "隐藏此日历" : "显示此日历"}"
                aria-label="${c.enabled ? "隐藏此日历" : "显示此日历"}">${c.enabled ? icons.eye : icons.eyeOff}</button>
      </div>`
      )
      .join("");
  }

  /**
   * 切换某个日历的启用状态（眼睛按钮 / 整行点击）。
   * 关掉后：日历视图、任务视图、Dock 列表与计数同时不再包含该日历的条目（都读 settings.calendars[].enabled）。
   * persist() 不触发 onChange，所以这里必须自己 renderAll()。
   */
  function toggleCalendar(idx: number): void {
    const cal = ctx.store.settings.calendars[idx];
    if (!cal) return;
    cal.enabled = !cal.enabled;
    void ctx.store.persist();
    renderAll();
  }

  /** 「日历视图中显示待办任务」开关：未设置过（老数据）按开启处理 */
  function todosShownInCalendar(): boolean {
    return ctx.store.settings.showTodosInCalendar !== false;
  }

  function renderFilterOpts(): void {
    showTodosInput.checked = todosShownInCalendar();
    // 任务视图的两个开关：主开关决定第二层是否出现（联动规则见 setTaskViewEventsShown）
    showEventsInput.checked = ctx.store.settings.showEventsInTaskView === true;
    showExpiredInput.checked = ctx.store.settings.showExpiredEventsInTaskView === true;
    // 脚注与它注解的那一行永远同进同出：主开关一关，两个都收起（不留孤零零一行说明）
    showExpiredRow.hidden = showExpiredNote.hidden = !showEventsInput.checked;
  }

  function cursorTitle(): string {
    const c = ctx.cursor;
    if (ctx.viewMode === "year") return `${+c.slice(0, 4)} 年`;
    if (ctx.viewMode === "month") return `${+c.slice(0, 4)} 年 ${+c.slice(5, 7)} 月`;
    if (ctx.viewMode === "week") {
      const ws = startOfWeek(c);
      const we = addDays(ws, 6);
      return `${fmtDateCn(ws)} – ${fmtDateCn(we)}`;
    }
    if (ctx.viewMode === "day") return `${+c.slice(0, 4)} 年 ${+c.slice(5, 7)} 月 ${+c.slice(8, 10)} 日`;
    return "待办任务";
  }

  function renderToolbarState(): void {
    segBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.view === ctx.viewMode));
    app.classList.toggle("is-task", ctx.viewMode === "task");
    cursorTitleEl.textContent = cursorTitle();
    renderViewToggle();
  }

  /** 视图切换按钮：图标表示「点击后将切换到的视图」，标题同步说明，随当前视图模式更新 */
  function renderViewToggle(): void {
    const toTask = ctx.viewMode !== "task";
    viewToggleBtn.innerHTML = toTask ? icons.taskList : icons.calCheck;
    const label = toTask ? "切换到任务视图" : "切换到日历视图";
    viewToggleBtn.title = label;
    viewToggleBtn.setAttribute("aria-label", label);
  }

  /** 当前启用日历下、时间窗内的展开实例（待办按到期日，见 view-common.todoDueOccurrences） */
  function visibleOccurrences(startMs: number, endMs: number): Map<CalItem, string[]> {
    const enabled = new Set(ctx.store.settings.calendars.filter((c) => c.enabled).map((c) => c.url));
    const showTodos = todosShownInCalendar();
    const out = new Map<CalItem, string[]>();
    for (const it of ctx.store.getAll()) {
      if (it.deleted) continue;
      if (!enabled.has(it.calendarUrl)) continue;
      // 只影响日历视图（年/月/周/日）：关掉开关后只留日程事件。
      // 任务视图自己收集待办（见 view-task.ts），不读这个开关，因此不受影响。
      if (!showTodos && it.kind === "todo") continue;
      const occ =
        it.kind === "todo" ? todoDueOccurrences(it, startMs, endMs) : occurrencesInRange(it, startMs, endMs);
      if (occ.length) out.set(it, occ);
    }
    return out;
  }

  function renderView(): void {
    renderToolbarState();
    // 切回日历视图时清空统计条挂载点，否则上一轮任务视图的六项数字会赖在工具条上。
    if (ctx.viewMode !== "task") {
      root.querySelector('[data-slot="task-stats"]')?.replaceChildren();
    }
    const args = { ctx, viewEl, occurrences: visibleOccurrences };
    if (ctx.viewMode === "year") renderYearView(args);
    else if (ctx.viewMode === "month") renderMonthView(args);
    else if (ctx.viewMode === "week") renderWeekView(args, 7);
    else if (ctx.viewMode === "day") renderWeekView(args, 1);
    else renderTaskView(args);
  }

  function renderAll(): void {
    if (destroyed) return;
    hideCtxMenu();
    renderCalList();
    renderFilterOpts();
    renderView();
  }

  // ---- 右键菜单（日历/任务视图上的条目） ----
  const ctxErrEl = ctxMenu.querySelector(".caldav-ctxmenu-err") as HTMLElement;
  const ctxDelBtn = ctxMenu.querySelector('[data-ctx="delete"]') as HTMLElement;
  let ctxDisarmTimer: ReturnType<typeof setTimeout> | null = null;

  function resetCtxDelete(): void {
    if (ctxDisarmTimer) {
      clearTimeout(ctxDisarmTimer);
      ctxDisarmTimer = null;
    }
    ctxDelBtn.classList.remove("is-armed");
    ctxDelBtn.innerHTML = `${icons.trash} 删除`;
  }

  function hideCtxMenu(): void {
    if (ctxMenu.hidden) return;
    ctxMenu.hidden = true;
    ctxMenuKey = null;
    resetCtxDelete();
    ctxErrEl.hidden = true;
    ctxErrEl.textContent = "";
  }

  /** 在鼠标位置展开菜单，并做视口边界收敛 */
  function showCtxMenu(key: string, x: number, y: number): void {
    ctxMenuKey = key;
    ctxErrEl.hidden = true;
    ctxErrEl.textContent = "";
    resetCtxDelete();
    ctxMenu.hidden = false;
    // 先显示再量尺寸，否则 offsetWidth 为 0
    const w = ctxMenu.offsetWidth;
    const h = ctxMenu.offsetHeight;
    const pad = 8;
    const left = Math.max(pad, Math.min(x, window.innerWidth - w - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - h - pad));
    ctxMenu.style.left = `${left}px`;
    ctxMenu.style.top = `${top}px`;
  }

  // ---- 条目菜单触发：桌面右键 / 触摸长按 ----
  // 触摸端长按是桌面右键的等价操作。不能只靠 contextmenu：iOS 的 WKWebView 不派发
  // contextmenu；Android WebView 长按则两者都触发，用时间戳去重避免菜单重复展开。
  const LONG_PRESS_MS = 480;
  const PRESS_MOVE_TOLERANCE = 10;
  let lastLongPressAt = 0;
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressPoint = { x: 0, y: 0 };
  let longPressFired = false;

  function clearPressTimer(): void {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  /**
   * 注册监听并登记撤销。
   * 面板根元素与右键菜单都可能被复用（移动端 Dock 容器长期存活、思源会重建侧栏），
   * 漏摘监听就会在同一元素上叠加处理器 —— 一次点击触发多次动作。
   */
  const offs: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    fn: (ev: HTMLElementEventMap[K]) => void,
    opts?: boolean | AddEventListenerOptions
  ): void => {
    el.addEventListener(type, fn as EventListener, opts);
    offs.push(() => el.removeEventListener(type, fn as EventListener, opts));
  };
  const offAll = (): void => offs.splice(0).forEach((off) => off());

  // 在条目上右键 → 展开菜单（阻止思源原生右键菜单）
  on(app, "contextmenu", (ev) => {
    const t = ev.target as HTMLElement;
    const openEl = t.closest("[data-open]") as HTMLElement | null;
    if (!openEl || !app.contains(openEl)) {
      hideCtxMenu();
      return;
    }
    const key = openEl.dataset.open!;
    if (!ctx.store.get(key)) return;
    ev.preventDefault();
    ev.stopPropagation();
    // 触摸端长按已展开过菜单，这里只挡掉系统菜单
    if (Date.now() - lastLongPressAt < 800) return;
    showCtxMenu(key, ev.clientX, ev.clientY);
  });

  // 触摸长按 → 等同于右键（命中区与右键一致：带 data-open 且 store 中存在的条目）
  on(app, "pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    const openEl = (ev.target as HTMLElement).closest("[data-open]") as HTMLElement | null;
    if (!openEl || !app.contains(openEl)) return;
    const key = openEl.dataset.open!;
    if (!ctx.store.get(key)) return;
    pressPoint = { x: ev.clientX, y: ev.clientY };
    longPressFired = false;
    clearPressTimer();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      longPressFired = true;
      lastLongPressAt = Date.now();
      showCtxMenu(key, pressPoint.x, pressPoint.y);
    }, LONG_PRESS_MS);
  });

  // 手指移动超过阈值视为滚动，取消长按
  on(app, "pointermove", (ev) => {
    if (!pressTimer || ev.pointerType !== "touch") return;
    if (
      Math.abs(ev.clientX - pressPoint.x) > PRESS_MOVE_TOLERANCE ||
      Math.abs(ev.clientY - pressPoint.y) > PRESS_MOVE_TOLERANCE
    ) {
      clearPressTimer();
    }
  });

  on(app, "pointerup", (ev) => {
    if (ev.pointerType !== "touch") return;
    clearPressTimer();
  });

  on(app, "pointercancel", clearPressTimer);

  // 长按已弹菜单时吞掉随之而来的 click —— pointerup 的 preventDefault 挡不住 click，
  // 不拦的话手指抬起会顺带触发条目的「打开编辑弹窗」。用捕获阶段抢在条目自身处理之前。
  on(
    app,
    "click",
    (ev) => {
      if (!longPressFired) return;
      longPressFired = false;
      ev.preventDefault();
      ev.stopPropagation();
    },
    true
  );

  on(ctxMenu, "click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("[data-ctx]") as HTMLElement | null;
    if (!btn || !ctxMenuKey) return;
    const key = ctxMenuKey;
    const item = ctx.store.get(key);
    if (!item) {
      hideCtxMenu();
      return;
    }
    ev.stopPropagation();

    if (btn.dataset.ctx === "edit") {
      hideCtxMenu();
      openEditor(ctx, { item });
      return;
    }
    if (btn.dataset.ctx !== "delete") return;

    // 二次点击确认：与编辑弹窗内删除保持一致，不用原生 confirm
    if (!btn.classList.contains("is-armed")) {
      btn.classList.add("is-armed");
      btn.innerHTML = `${icons.trash} 再点一次确认删除`;
      ctxDisarmTimer = setTimeout(resetCtxDelete, 4000);
      return;
    }
    resetCtxDelete();
    btn.setAttribute("disabled", "");
    btn.innerHTML = "删除中…";
    void ctx.sync
      .removeItem(item)
      .then(() => {
        if (ctx.store.get(key)) {
          // 仍留在本地 = 服务端 DELETE 未成功，会留待下次同步重试
          ctxErrEl.textContent = "服务器删除未成功，已记录，将在下次同步重试";
          ctxErrEl.hidden = false;
          btn.removeAttribute("disabled");
          btn.innerHTML = `${icons.trash} 删除`;
          return;
        }
        hideCtxMenu();
        renderCalList();
        renderView();
      })
      .catch((e: any) => {
        ctxErrEl.textContent = "删除失败：" + (e?.message || e);
        ctxErrEl.hidden = false;
        btn.removeAttribute("disabled");
        btn.innerHTML = `${icons.trash} 删除`;
      });
  });

  // 视图内导航（年视图跳月/日）
  ctx.navigate = (mode: ViewMode, cursor?: string) => {
    if (cursor) ctx.cursor = cursor;
    ctx.viewMode = mode;
    notifyViewChange(mode);
    renderAll();
  };

  // 勾选待办时就地更新可见视图，抑制本次 store 变更触发的整视图重渲染
  // （否则会闪烁、且周/日视图滚动位置被重置到默认当前时间）
  let suppressRerender = false;
  function updateTodoCheckDOM(root: HTMLElement, key: string, done: boolean): void {
    root
      .querySelectorAll<HTMLElement>(`[data-toggle="${key}"]`)
      .forEach((btn) => (btn.title = done ? "标记未完成" : "标记完成"));
    root
      .querySelectorAll<HTMLElement>(`[data-open="${key}"]`)
      .forEach((el) => el.classList.toggle("is-done", done));
  }

  // ---- 事件委托 ----
  on(app, "click", (ev) => {
    const t0 = ev.target as HTMLElement;

    // 待办快速勾选
    const toggleEl = t0.closest("[data-toggle]") as HTMLElement | null;
    if (toggleEl && app.contains(toggleEl)) {
      const item = ctx.store.get(toggleEl.dataset.toggle!);
      if (item && item.kind === "todo") {
        const nextDone = item.percent !== 100;
        item.percent = nextDone ? 100 : 0;
        item.status = nextDone ? "COMPLETED" : "NEEDS-ACTION";
        item.completedAt = nextDone ? new Date().toISOString().slice(0, 19) : undefined;
        const key = toggleEl.dataset.toggle!;
        updateTodoCheckDOM(app, key, nextDone);
        suppressRerender = true;
        // 兜底：万一同步 promise 一直挂着（网络挂起/等待解锁），最多抑制 10s，
        // 否则界面从此再也不刷新，表现出来就是「点了没反应」。
        const guard = setTimeout(() => (suppressRerender = false), 10000);
        void ctx.sync.updateItem(item).finally(() => {
          clearTimeout(guard);
          suppressRerender = false;
          // 同步收尾后按 store 里的真实状态校正一次：上面那次是乐观更新，
          // 若推送失败/被服务端覆盖而界面停留在乐观值，用户会以为「点了没用」。
          const real = ctx.store.get(key);
          if (real) updateTodoCheckDOM(app, key, real.percent === 100);
        });
        ev.stopPropagation();
        return;
      }
      ev.stopPropagation();
      return;
    }
    // 打开编辑
    const openEl = t0.closest("[data-open]") as HTMLElement | null;
    if (openEl && app.contains(openEl)) {
      const item = ctx.store.get(openEl.dataset.open!);
      if (item) openEditor(ctx, { item });
      return;
    }

    // 日历启用/禁用（眼睛按钮，或点击整行）。
    // ⚠️ 必须放在下面那句通用 target 解析**之前**：眼睛按钮自身不带 data-* 属性，
    // closest("[data-view],[data-action],[data-cal]") 会跳过它直接命中父级 .caldav-cal-item，
    // 于是后面那句 target.classList.contains("caldav-cal-toggle") 永远为 false —— 这正是
    // 「点了眼睛没任何反应」的原因（旧实现在此处静默失效）。
    const calItem = t0.closest(".caldav-cal-item") as HTMLElement | null;
    if (calItem && app.contains(calItem) && calItem.dataset.cal !== undefined) {
      toggleCalendar(+calItem.dataset.cal);
      ev.stopPropagation();
      return;
    }

    const target = t0.closest("[data-view],[data-action],[data-cal]") as HTMLElement | null;
    if (!target || !app.contains(target)) return;

    const view = target.dataset.view;
    if (view) {
      ctx.viewMode = view as ViewMode;
      notifyViewChange(ctx.viewMode);
      renderAll();
      return;
    }
    const action = target.dataset.action;
    if (action === "toggle-view") {
      // 日历视图（年/月/周/日）↔ 任务视图 互切；从任务视图返回时统一落回月视图
      ctx.viewMode = ctx.viewMode === "task" ? "month" : "task";
      notifyViewChange(ctx.viewMode);
      renderAll();
      return;
    }
    if (action === "prev" || action === "next") {
      const dir = action === "next" ? 1 : -1;
      ctx.cursor = stepCursor(ctx.cursor, ctx.viewMode, dir);
      renderAll();
      return;
    }
    if (action === "today") {
      ctx.cursor = todayStamp();
      renderAll();
      return;
    }
    if (action === "settings") {
      void openSettingsDialog(ctx).then(renderAll);
      return;
    }
    if (action === "insert-diary") {
      // 先问范围与目标，再插 —— 反馈与「打开日记页签」都在入口侧完成，这里不重复处理
      askDiaryRange((range, target) => void ctx.insertTodayToDiary(range, target));
      return;
    }
    if (action === "new-event" || action === "new-todo") {
      const kind: CalKind = action === "new-event" ? "event" : "todo";
      // 只给日期，时刻交给编辑弹窗补默认值（今天 = 下一个整点）
      openEditor(ctx, { kind, start: ctx.cursor });
      return;
    }
    if (action === "calfilter") {
      calfilterPop.hidden = !calfilterPop.hidden;
      return;
    }
    if (action === "sync-now") {
      // 防重复点击：同步中直接 return，否则连点会并发跑 syncAll
      //（引擎内部有 syncing闸，但用户看到的是「点了没反应」）。
      if (syncBusy || !ctx.syncNow) return;
      syncBusy = true;
      syncBtn.classList.add("is-syncing");
      syncBtn.disabled = true;
      void ctx
        .syncNow()
        .catch(() => undefined)
        .finally(() => {
          syncBusy = false;
          syncBtn.classList.remove("is-syncing");
          syncBtn.disabled = false;
        });
      return;
    }
  });

  // 「日历视图中显示待办任务」开关：写设置后走 saveSettings()（emit → 所有面板实例
  // 自动 renderAll + 落盘），不用在这里手动重渲染。
  showTodosInput.addEventListener("change", () => {
    ctx.store.settings.showTodosInCalendar = showTodosInput.checked;
    ctx.store.saveSettings();
  });

  /**
   * 任务视图的两个开关（浮层里，与设置弹窗同一对）。
   *
   * saveSettings() 会 emit → 本实例的 onChange → renderAll()，任务视图随即重渲染，
   * 所以「勾一下就立刻见效」。这里额外先调一次 renderFilterOpts()：
   * 让第二层那一行**当场**展开/收起，不依赖 emit 的时序。
   */
  showEventsInput.addEventListener("change", () => {
    setTaskViewEventsShown(ctx.store.settings, showEventsInput.checked, showExpiredInput.checked);
    renderFilterOpts();
    ctx.store.saveSettings();
  });
  showExpiredInput.addEventListener("change", () => {
    ctx.store.settings.showExpiredEventsInTaskView = showExpiredInput.checked;
    ctx.store.saveSettings();
  });

  // 点击面板其它区域时收起浮层（日历筛选 + 右键菜单）
  const onDocClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;
    if (!ctxMenu.hidden && !t.closest(".caldav-ctxmenu")) hideCtxMenu();
    if (calfilterPop.hidden) return;
    if (t.closest(".caldav-calfilter-wrap")) return;
    calfilterPop.hidden = true;
  };
  document.addEventListener("click", onDocClick, true);

  // Esc 关闭；滚动/窗口尺寸变化时菜单会与条目错位，直接收起
  const onKeydown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      hideCtxMenu();
      calfilterPop.hidden = true;
    }
  };
  const onReflow = () => hideCtxMenu();
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", onReflow);
  // 捕获阶段监听滚动（视图容器自身也可滚）
  document.addEventListener("scroll", onReflow, true);

  const unsub = ctx.store.onChange(() => {
    if (!suppressRerender) renderAll();
  });
  renderAll();

  return {
    destroy() {
      destroyed = true;
      // 摘掉挂在根元素/右键菜单上的监听（它们可能被复用，漏摘会叠加处理器）
      offAll();
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
      unsub();
      root.innerHTML = "";
    },
    refresh() {
      // 已销毁的面板可能还被人拿着引用（旧弹层、旧页签），刷新要变成空操作：
      // 让它去动已被清空的 DOM 只会徒增抛错风险（视图切换就调它）。
      if (destroyed) return;
      renderAll();
    }
  };
}

/** 视图切换事件：Dock 导航与主面板页签联动 */
export const VIEW_CHANGE_EVENT = "caldav-view-change";

export function notifyViewChange(mode: ViewMode): void {
  document.dispatchEvent(new CustomEvent(VIEW_CHANGE_EVENT, { detail: mode }));
}

/**
 * Dock 面板：标题「日历任务管理」（右侧带设置图标按钮）+ 一行 5 个按钮。
 * 新增 / 排序 为下拉菜单；日历视图 / 任务视图 打开主窗口页签；刷新 触发重新同步。
 * 设置入口从主面板「日历筛选」浮层迁到这里 —— 浮层只留过滤相关的动作，职责更单一。
 */
type DockFilter =
  | "today" | "tomorrow" | "next7" | "thisweek" | "future"
  | "overdue" | "past7" | "undone" | "nodate"
  | "doneToday" | "doneYesterday" | "done";

/**
 * Dock 筛选下拉的选项（数组顺序即下拉中的顺序）。
 * 下拉是**自定义**的而非原生 <select>：原生弹出列表由操作系统绘制，
 * 选中项永远是系统高亮色（蓝），CSS 无法让它跟随主题（option:hover / :checked 会被忽略）。
 */
const DOCK_FILTERS: Array<{ key: DockFilter; label: string }> = [
  { key: "next7", label: "未来七天" },
  { key: "today", label: "今日任务" },
  { key: "tomorrow", label: "明日任务" },
  { key: "thisweek", label: "本周任务" },
  { key: "future", label: "未来任务" },
  { key: "overdue", label: "过期任务" },
  { key: "past7", label: "过去七天" },
  { key: "undone", label: "所有未完成" },
  { key: "nodate", label: "无日期任务" },
  { key: "doneToday", label: "今日已完成" },
  { key: "doneYesterday", label: "昨日已完成" },
  { key: "done", label: "已完成" }
];

export interface DockPanelOpts {
  store: CalStore;
  onNav: (mode: ViewMode) => void;
  /** 返回 Promise 才能被 .finally/.catch 链（写成 () => unknown 会在调用处报 TS2571） */
  onSync: () => Promise<unknown>;
  onSettings: () => void;
  onAddEvent: () => void;
  onAddTask: () => void;
  onSort: (mode: SortMode) => void;
  onOpenEditor: (item: CalItem) => void;
  onToggleDone: (item: CalItem) => void | Promise<void>;
}

export function renderDockPanel(
  root: HTMLElement,
  opts: DockPanelOpts
): { refresh: () => void; destroy: () => void } {
  root.classList.add("caldav-dock");
  root.classList.toggle("caldav-touch", isMobile());
  root.innerHTML = `
<div class="caldav-dock-brand">
  <span class="caldav-brand-icon">${icons.calendar}</span>
  <span class="caldav-brand-title">日历任务管理</span>
  <button class="caldav-brand-set" data-dock-action="settings" title="设置" aria-label="设置">${icons.gear}</button>
</div>
<div class="caldav-dock-actions">
  <div class="caldav-dock-menu" data-menu="add">
    <button class="caldav-dock-act" data-toggle="add" title="新增事件、任务" aria-label="新增">${icons.plusThin}</button>
    <div class="caldav-dock-pop" data-pop="add" hidden>
      <button class="caldav-dock-popitem" data-action="add-event">新增事件</button>
      <button class="caldav-dock-popitem" data-action="add-task">新增任务</button>
    </div>
  </div>
  <div class="caldav-dock-menu" data-menu="sort">
    <button class="caldav-dock-act" data-toggle="sort" title="排序" aria-label="排序">${icons.sortDown}</button>
    <div class="caldav-dock-pop" data-pop="sort" hidden>
      <button class="caldav-dock-popitem" data-action="sort-priority">按优先级排序</button>
      <button class="caldav-dock-popitem" data-action="sort-start">按开始时间排序</button>
      <button class="caldav-dock-popitem" data-action="sort-end">按结束时间排序</button>
      <button class="caldav-dock-popitem" data-action="sort-completed">按完成时间排序</button>
      <button class="caldav-dock-popitem" data-action="sort-created">按创建时间排序</button>
      <button class="caldav-dock-popitem" data-action="sort-category">按分类排序</button>
      <button class="caldav-dock-popitem" data-action="sort-title">按标题排序</button>
    </div>
  </div>
  <button class="caldav-dock-act" data-action="cal-view" title="日历视图" aria-label="日历">${icons.calCheck}</button>
  <button class="caldav-dock-act" data-action="task-view" title="任务视图" aria-label="任务">${icons.taskList}</button>
  <button class="caldav-dock-act" data-action="sync" title="刷新（重新同步）" aria-label="刷新">${icons.refreshThin}</button>
</div>
<div class="caldav-dock-list">
  <div class="caldav-dock-list-head">
    <div class="caldav-dock-filter-wrap">
      <button class="caldav-dock-select" data-dock="filter" data-toggle="dock-filter" type="button">
        <span class="caldav-dock-select-text"></span>
      </button>
      <span class="caldav-dock-select-arrow">${icons.chevron}</span>
      <div class="caldav-dock-pop caldav-dock-filter-pop" data-pop="dock-filter" hidden>
        ${DOCK_FILTERS.map(
          (f) => `<button class="caldav-dock-popitem" data-dock-filter="${f.key}" type="button">${f.label}</button>`
        ).join("")}
      </div>
    </div>
    <button class="caldav-dock-filter-btn" data-dock="category">分类筛选</button>
    <div class="caldav-dock-cat-pop" data-pop="category" hidden>
      <div class="caldav-dock-cat-head">选择分类</div>
      <div class="caldav-dock-cat-list" data-cat-list></div>
      <div class="caldav-dock-cat-foot">
        <button class="caldav-foot-btn caldav-foot-btn--ghost" data-cat-action="cancel">取消</button>
        <button class="caldav-foot-btn caldav-foot-btn--primary" data-cat-action="ok">确定</button>
      </div>
    </div>
  </div>
  <div class="caldav-dock-search-wrap">
    <span class="caldav-dock-search-icon">${icons.search}</span>
    <input class="caldav-dock-search" data-dock="search" placeholder="搜索任务..." />
  </div>
  <div class="caldav-dock-items" data-dock="items"></div>
</div>
<div class="caldav-dock-foot">
  <button class="caldav-dock-status" data-action="sync">未同步</button>
  <div class="caldav-dock-error" data-dock="error" hidden></div>
</div>`;

  const statusEl = root.querySelector(".caldav-dock-status") as HTMLElement;
  const errorEl = root.querySelector("[data-dock='error']") as HTMLElement | null;
  const listEl = root.querySelector("[data-dock='items']") as HTMLElement;
  const pops = Array.from(root.querySelectorAll<HTMLElement>(".caldav-dock-pop"));
  let localSort: SortMode = "start";
  let destroyed = false;

  function closePops(): void {
    pops.forEach((p) => (p.hidden = true));
    const catPop = root.querySelector<HTMLElement>("[data-pop='category']");
    if (catPop) catPop.hidden = true;
    root.querySelectorAll(".caldav-dock-act.is-open").forEach((b) => b.classList.remove("is-open"));
  }

  function openCategoryPop(): void {
    pendingCategoryFilter = [...dockCategoryFilter];
    renderCategoryPop();
    const catPop = root.querySelector<HTMLElement>("[data-pop='category']");
    const btn = root.querySelector<HTMLElement>("[data-dock='category']");
    if (catPop) {
      catPop.hidden = false;
      if (btn) {
        const r = btn.getBoundingClientRect();
        catPop.style.top = `${r.top}px`;
        catPop.style.left = `${r.right + 8}px`;
      }
    }
  }

  function togglePop(name: string): void {
    const pop = pops.find((p) => p.dataset.pop === name);
    const open = !pop?.hidden;
    closePops();
    if (open) return;
    if (pop) pop.hidden = false;
    const btn = root.querySelector(`[data-toggle="${name}"]`);
    btn?.classList.add("is-open");
  }

  function renderSortActive(): void {
    root.querySelectorAll<HTMLElement>(".caldav-dock-popitem[data-action^='sort-']").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.action === `sort-${localSort}`);
    });
  }

  /** 同步筛选触发按钮上的文案，并高亮下拉里的当前项 */
  function syncDockFilterLabel(): void {
    const label = DOCK_FILTERS.find((f) => f.key === dockFilter)?.label || "";
    const textEl = root.querySelector<HTMLElement>(".caldav-dock-select-text");
    if (textEl) textEl.textContent = label;
    root.querySelectorAll<HTMLElement>("[data-dock-filter]").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.dockFilter === dockFilter);
    });
  }

  function renderStatus(): void {
    if (destroyed) return;
    const s = opts.store.settings;
    const err = opts.store.lastError;
    const cred = opts.store.credentialsIssue();
    const time = opts.store.lastSync || "—";

    // 凭据问题优先提示：这类错误原来只写在控制台，用户完全看不到
    if (cred) {
      statusEl.textContent = "同步不可用 · 凭据异常";
      statusEl.title = cred;
      statusEl.classList.add("has-error");
      showError(cred);
      return;
    }
    if (!s.serverUrl) {
      statusEl.textContent = "未配置服务器";
      statusEl.title = "点击打开设置";
      statusEl.classList.remove("has-error");
      showError("");
      return;
    }
    if (err) {
      statusEl.textContent = `同步失败 · ${time}`;
      statusEl.title = `错误: ${err}`;
      statusEl.classList.add("has-error");
      showError(err);
    } else {
      statusEl.textContent = `上次同步 ${time}`;
      statusEl.title = "点击立即同步";
      statusEl.classList.remove("has-error");
      showError("");
    }
  }

  /** 页脚错误行：把错误正文摊开显示，而不是只放在悬停提示里 */
  function showError(text: string): void {
    if (!errorEl) return;
    if (!text) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = text.length > 90 ? text.slice(0, 90) + "…" : text;
    errorEl.title = text;
  }

  let dockFilter: DockFilter = "next7";
  let dockSearch = "";
  let dockCategoryFilter: string[] = []; // 空 = 所有分类；"__none__" = 无分类

  /** 勾选待办时抑制整列表重建：改状态只改这一行的 class/复选框，列表不闪、滚动不复位 */
  let suppressDockRerender = false;

  function isEnabledCalendar(it: CalItem): boolean {
    return opts.store.settings.calendars.some((c) => c.enabled && c.url === it.calendarUrl);
  }

  /** 条目用于「归属时间段」的日期：待办取到期日（DUE），事件取开始时间 */
  function dateKeyOf(it: CalItem): string {
    return (it.kind === "todo" ? it.end : it.start)?.slice(0, 10) || "";
  }

  function matchesDockFilter(it: CalItem, filter: DockFilter): boolean {
    if (it.deleted) return false;
    if (!isEnabledCalendar(it)) return false;

    const today = todayStamp();
    const date = dateKeyOf(it);
    const diff = diffDays(date, today);
    const weekStart = startOfWeek(today);
    const weekEnd = addDays(weekStart, 6).slice(0, 10);
    const isTodo = it.kind === "todo";
    const isDone = isTodo && it.percent === 100;
    /** 已过期但尚未完成的待办 —— 这类条目即使过期也要留在列表里 */
    const overdue = isTodo && !isDone && !!date && diff < 0;
    // 事件是否已结束：按**结束时间**与当前时刻比较（进行中的保留，只有真正结束的才隐藏）。
    // 全天事件只有日期，按日期比较，避免当天事件过了 00:00 就被藏掉。
    const evEnd = it.end || it.start || "";
    const ended = !isTodo && !!evEnd && (isDateOnly(evEnd) ? evEnd < today : evEnd < stampOfMs(Date.now()));

    /**
     * 时间窗筛选统一口径：
     *  - 待办：命中窗口，或者「已过期且未完成」（没完成的过期任务照样显示）
     *  - 事件：命中窗口，且尚未结束（当前时间以前的不显示）
     */
    const inWindow = (hit: boolean): boolean => (isTodo ? hit || overdue : hit && !ended);

    switch (filter) {
      case "today":
        return inWindow(date === today);
      case "tomorrow":
        return inWindow(date === addDays(today, 1).slice(0, 10));
      case "next7":
        return inWindow(diff >= 0 && diff <= 6);
      case "thisweek":
        return inWindow(date >= weekStart && date <= weekEnd);
      case "future":
        return inWindow(diff >= 0);
      case "overdue":
        return overdue;
      case "past7":
        // 回顾用：保留过去 7 天（含已经结束的事件），不套用 inWindow
        return diff >= -6 && diff < 0;
      case "undone":
        return isTodo && !isDone;
      case "nodate":
        return isTodo && !date;
      case "doneToday":
        return isDone && !!it.completedAt && it.completedAt.slice(0, 10) === today;
      case "doneYesterday":
        return isDone && !!it.completedAt && it.completedAt.slice(0, 10) === addDays(today, -1).slice(0, 10);
      case "done":
        return isDone;
      default:
        return true;
    }
  }

  function matchesDockSearch(it: CalItem, q: string): boolean {
    if (!q.trim()) return true;
    const s = q.trim().toLowerCase();
    return (
      it.summary.toLowerCase().includes(s) ||
      (it.description || "").toLowerCase().includes(s) ||
      (it.location || "").toLowerCase().includes(s) ||
      (it.categories || []).some((c) => c.toLowerCase().includes(s))
    );
  }

  function matchesDockCategoryFilter(it: CalItem, filter: string[]): boolean {
    if (!filter.length) return true;
    const hasNone = filter.includes("__none__");
    const cats = filter.filter((f) => f !== "__none__");
    const itemCats = it.categories || [];
    if (hasNone && itemCats.length === 0) return true;
    if (cats.length && itemCats.some((c) => cats.includes(c))) return true;
    return false;
  }

  function formatDockTimeRange(it: CalItem): string {
    if (it.allDay) return "全天";
    if (it.kind === "event" && it.end) return `${fmtTime(it.start)} - ${fmtTime(it.end)}`;
    // 待办以到期时间为准，不再展示开始时间
    if (it.kind === "todo" && it.end) return isDateOnly(it.end) ? "" : fmtTime(it.end);
    if (!isDateOnly(it.start)) return fmtTime(it.start);
    return "";
  }

  /**
   * iCal PRIORITY（1 最高、9 最低）→ 文案与配色级别。
   * 覆盖 1~9 全部取值，不只认 1/3/5/9 这四个数字。
   */
  function prioMeta(p: number): { label: string; cls: string } {
    if (p <= 2) return { label: "紧急", cls: "prio-urgent" };
    if (p <= 4) return { label: "高", cls: "prio-high" };
    if (p <= 6) return { label: "中", cls: "prio-mid" };
    return { label: "低", cls: "prio-low" };
  }

  function buildDockTags(it: CalItem): string {
    const tags: string[] = [];
    const today = todayStamp();
    const date = dateKeyOf(it);
    const diff = diffDays(date, today);
    const isDoneTodo = it.kind === "todo" && it.percent === 100;
    // 逾期天数：只有「未完成且到期日已过」的待办才算逾期（完成的过往条目不该标红）
    const overdueDays = it.kind === "todo" && !isDoneTodo && !!date && diff < 0 ? -diff : 0;

    // 主时间标签：逾期的待办直接标成红色「逾期 N 天」
    // （原来的「N 天前」说的正是同一件事，改成红色标志更醒目，也避免同一行出现两个重复标签）
    let timeLabel = "";
    let timeCls = "caldav-dock-tag--primary";
    if (overdueDays > 0) {
      timeLabel = `逾期 ${overdueDays} 天`;
      timeCls = "caldav-dock-tag--overdue";
    } else if (isDoneTodo) timeLabel = "已完成";
    else if (!date) timeLabel = "无日期";
    else if (diff === 0) timeLabel = "今天";
    else if (diff === 1) timeLabel = "明天";
    else if (diff > 1) timeLabel = `${diff}天后开始`;
    else if (diff === -1) timeLabel = "昨天";
    else timeLabel = `${-diff}天前`;
    tags.push(`<span class="caldav-dock-tag ${timeCls}">${timeLabel}</span>`);

    // 类型 / 优先级
    if (it.kind === "event") {
      tags.push(`<span class="caldav-dock-tag caldav-dock-tag--secondary">${icons.calendar}日程</span>`);
    } else if (it.priority) {
      const pm = prioMeta(it.priority);
      tags.push(`<span class="caldav-dock-tag caldav-dock-tag--secondary ${pm.cls}">${icons.flag}${pm.label}</span>`);
    } else {
      tags.push(`<span class="caldav-dock-tag caldav-dock-tag--secondary">${icons.tasks}任务</span>`);
    }

    // 自定义分类
    if (it.categories) {
      for (const c of it.categories) {
        tags.push(`<span class="caldav-dock-tag caldav-dock-tag--ghost">${icons.tag}${escapeHtml(c)}</span>`);
      }
    }

    return tags.join("");
  }

  let pendingCategoryFilter: string[] = [];

  function renderCategoryPop(): void {
    const pop = root.querySelector("[data-pop='category']") as HTMLElement;
    const listEl = pop.querySelector("[data-cat-list]") as HTMLElement;
    const cats = opts.store.settings.categories?.length ? opts.store.settings.categories : DEFAULT_CATEGORIES;
    const filter = pendingCategoryFilter;
    const isAll = filter.length === 0;

    const items = [
      { key: "__all__", label: "所有分类", icon: "", color: "" },
      { key: "__none__", label: "无分类", icon: "", color: "" },
      ...cats.map((c) => ({ key: c.name, label: c.name, icon: c.icon, color: c.color }))
    ];

    listEl.innerHTML = items
      .map((item) => {
        const checked = item.key === "__all__" ? isAll : filter.includes(item.key);
        const iconHtml = item.icon
          ? `<span class="caldav-dock-cat-icon" style="background:${escapeAttr(item.color)}">${escapeHtml(item.icon)}</span>`
          : "";
        return `<label class="caldav-dock-cat-item ${checked ? "is-active" : ""}" data-cat-key="${escapeAttr(item.key)}">
      <input type="checkbox" ${checked ? "checked" : ""}/>
      ${iconHtml}<span>${escapeHtml(item.label)}</span>
    </label>`;
      })
      .join("");
  }

  function dockSort(a: CalItem, b: CalItem): number {
    const sv = (it: CalItem): string | number => {
      switch (localSort) {
        case "end":
          // 待办以到期日为准；无到期日的排最后
          return it.kind === "todo" ? it.end || "9999-12-31T23:59:59" : it.end || it.start;
        case "priority":
          return it.priority && it.priority > 0 ? it.priority : 9; // 无优先级视为最低
        case "completed":
          return it.completedAt || "9999-12-31T23:59:59"; // 未完成排最后
        case "created":
          return it.createdAt || it.start;
        case "category":
          return (it.categories && it.categories[0]) || "";
        case "title":
          return (it.summary || "").toLowerCase();
        case "start":
        default:
          // 待办按到期时间排序（与时间归属口径一致）
          return dateKeyOf(it) + "T" + (it.kind === "todo" ? it.end || "" : it.start).slice(11);
      }
    };
    const av = sv(a);
    const bv = sv(b);
    if (av < bv) return -1;
    if (av > bv) return 1;
    // 并列回退：开始时间 → 标题
    if (a.start !== b.start) return a.start.localeCompare(b.start);
    return (a.summary || "").localeCompare(b.summary || "", "zh");
  }

  /**
   * 当前筛选下被隐藏的无日期未完成待办数量。
   * 用户在编辑弹窗里清空日期后，这类条目会落在「无日期」里，
   * 若不提示，看起来就像「记录消失了」（实测用户就是这么反馈的）。
   */
  function hiddenNodateCount(): number {
    if (dockFilter === "nodate" || dockFilter === "undone" || dockFilter.startsWith("done")) return 0;
    const q = dockSearch.toLowerCase().trim();
    return opts.store
      .getAll()
      .filter((it) => it.kind === "todo" && !it.deleted && it.percent !== 100)
      .filter((it) => isEnabledCalendar(it))
      .filter((it) => !dateKeyOf(it))
      .filter((it) => matchesDockCategoryFilter(it, dockCategoryFilter))
      .filter((it) => matchesDockSearch(it, q)).length;
  }

  function renderDockList(): void {
    if (destroyed) return;
    const q = dockSearch.toLowerCase().trim();
    const items = opts.store
      .getAll()
      .filter((it) => matchesDockFilter(it, dockFilter))
      .filter((it) => matchesDockCategoryFilter(it, dockCategoryFilter))
      .filter((it) => matchesDockSearch(it, q))
      .sort(dockSort)
      .slice(0, 50);

    const nodateHidden = hiddenNodateCount();
    const nodateHint = nodateHidden
      ? `<button class="caldav-dock-hint" data-dock-action="show-nodate">另有 ${nodateHidden} 条无日期待办未显示 · 点此查看</button>`
      : "";

    if (!items.length) {
      listEl.innerHTML = `<div class="caldav-dock-empty">暂无匹配条目</div>${nodateHint}`;
      return;
    }

    listEl.innerHTML = items
      .map((it) => {
        const key = keyOf(it);
        const date = it.kind === "todo" ? it.end : it.start;
        const dateStr = date ? fmtDateCn(date) : "无日期";
        const timeStr = formatDockTimeRange(it);
        const tags = buildDockTags(it);
        const isDoneTodo = it.kind === "todo" && it.percent === 100;
        return `
      <div class="caldav-dock-item ${isDoneTodo ? "is-done" : ""}" data-open="${key}">
        <span class="caldav-dock-check" data-toggle="${key}">
          ${it.kind === "todo"
            ? `<input type="checkbox" ${isDoneTodo ? "checked" : ""}/>`
            : `<span class="caldav-dock-kind">${icons.calendar}</span>`}
        </span>
        <div class="caldav-dock-item-main">
          <div class="caldav-dock-item-title">${escapeHtml(it.summary)}</div>
          <div class="caldav-dock-item-meta">
            <span class="caldav-dock-item-date">
              ${it.kind === "todo" ? icons.tasks : icons.calendar}
              ${dateStr}${timeStr ? " " + timeStr : ""}
            </span>
          </div>
          <div class="caldav-dock-item-tags">${tags}</div>
        </div>
      </div>`;
      })
      .join("") + nodateHint;
  }

  // ⚠️ 必须具名：移动端这个容器元素是**长期存活**的（思源的 removeMobilePluginDock
  // 只清 innerHTML，元素本身留着；侧栏重建也只搬运它），重挂时若不摘掉旧监听，
  // 就会在同一元素上叠加多个处理器 —— 一次点击触发多次动作，
  // 症状就是「点一次设置弹出两个设置窗口」（且随每次插件热更新越叠越多）。
  const onRootClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;

    // 标题栏右侧设置图标按钮
    const brandSet = t.closest("[data-dock-action='settings']");
    if (brandSet && root.contains(brandSet)) {
      opts.onSettings();
      return;
    }

    // 「另有 N 条无日期待办」提示：直接切到无日期筛选
    const nodateBtn = t.closest("[data-dock-action='show-nodate']");
    if (nodateBtn) {
      dockFilter = "nodate";
      syncDockFilterLabel();
      renderDockList();
      ev.stopPropagation();
      return;
    }

    // Dock 列表内部：复选框 / 卡片打开
    const toggleEl = t.closest("[data-toggle]") as HTMLElement | null;
    if (toggleEl && listEl.contains(toggleEl)) {
      const item = opts.store.get(toggleEl.dataset.toggle!);
      if (item && item.kind === "todo") {
        // 就地更新：只改这一行的完成态，不重建列表（否则整列闪烁、滚动位置复位）
        const nextDone = item.percent !== 100;
        const row = toggleEl.closest(".caldav-dock-item") as HTMLElement | null;
        row?.classList.toggle("is-done", nextDone);
        const cb = toggleEl.querySelector<HTMLInputElement>("input[type=checkbox]");
        if (cb) cb.checked = nextDone;
        const key = toggleEl.dataset.toggle!;
        suppressDockRerender = true;
        const guard = setTimeout(() => (suppressDockRerender = false), 10000);
        void Promise.resolve(opts.onToggleDone(item)).finally(() => {
          clearTimeout(guard);
          suppressDockRerender = false;
          // 与日历视图同理：同步收尾后按 store 真实值校正这一行
          const real = opts.store.get(key);
          if (real) {
            const done = real.percent === 100;
            row?.classList.toggle("is-done", done);
            if (cb) cb.checked = done;
          }
        });
      }
      ev.stopPropagation();
      return;
    }
    const openEl = t.closest("[data-open]") as HTMLElement | null;
    if (openEl && listEl.contains(openEl)) {
      const item = opts.store.get(openEl.dataset.open!);
      if (item) opts.onOpenEditor(item);
      return;
    }

    // 下拉内的动作
    const popItem = t.closest("[data-action]") as HTMLElement | null;
    if (popItem && root.contains(popItem)) {
      const a = popItem.dataset.action!;
      closePops();
      if (a === "add-event") return opts.onAddEvent();
      if (a === "add-task") return opts.onAddTask();
      if (a.startsWith("sort-")) {
        localSort = a.slice(5) as SortMode;
        renderSortActive();
        renderDockList();
        return opts.onSort(localSort);
      }
      if (a === "cal-view") return opts.onNav("month");
      if (a === "task-view") return opts.onNav("task");
      if (a === "sync") {
        statusEl.textContent = "同步中…";
        void opts.onSync().finally(() => {
          renderStatus();
          renderDockList();
        });
        return;
      }
    }

    // 分类筛选弹层
    const catPopEl = root.querySelector<HTMLElement>("[data-pop='category']");
    const catItem = t.closest(".caldav-dock-cat-item") as HTMLElement | null;
    const catAction = t.closest("[data-cat-action]") as HTMLElement | null;
    if (catPopEl && !catPopEl.hidden && (catItem || catAction)) {
      if (catAction) {
        if (catAction.dataset.catAction === "ok") {
          dockCategoryFilter = pendingCategoryFilter;
          renderDockList();
        }
        closePops();
        return;
      }
      if (catItem) {
        const key = catItem.dataset.catKey!;
        if (key === "__all__") {
          pendingCategoryFilter = [];
        } else {
          const set = new Set(pendingCategoryFilter);
          if (set.has(key)) set.delete(key);
          else set.add(key);
          pendingCategoryFilter = Array.from(set);
        }
        renderCategoryPop();
        return;
      }
    }
    if (t.closest("[data-dock='category']")) {
      const catPopEl2 = root.querySelector<HTMLElement>("[data-pop='category']");
      if (catPopEl2?.hidden) openCategoryPop();
      else closePops();
      return;
    }

    // 筛选下拉：选中某一项
    const filterItem = t.closest("[data-dock-filter]") as HTMLElement | null;
    if (filterItem && root.contains(filterItem)) {
      dockFilter = filterItem.dataset.dockFilter as DockFilter;
      syncDockFilterLabel();
      renderDockList();
      closePops();
      return;
    }

    // 菜单展开/收起
    const toggle = t.closest("[data-toggle]") as HTMLElement | null;
    if (toggle && root.contains(toggle)) {
      togglePop(toggle.dataset.toggle!);
      return;
    }
  };
  root.addEventListener("click", onRootClick);

  // 筛选下拉已改为自定义控件（原生 <select> 的 change 监听随之移除）

  const onRootInput = (ev: Event) => {
    const target = ev.target as HTMLElement;
    if (target.dataset.dock === "search") {
      dockSearch = (target as HTMLInputElement).value;
      renderDockList();
    }
  };
  root.addEventListener("input", onRootInput);

  const onDocClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;
    if (!root.contains(t)) closePops();
  };
  document.addEventListener("click", onDocClick, true);

  const listScrollEl = root.querySelector<HTMLElement>(".caldav-dock-list");
  const onScrollClose = () => closePops();
  listScrollEl?.addEventListener("scroll", onScrollClose);
  window.addEventListener("resize", onScrollClose);

  const unsub = opts.store.onChange(() => {
    // 勾选引发的变更跳过重建：DOM 已就地更新，重建只会闪一下并把滚动打回顶部
    if (suppressDockRerender) return;
    renderStatus();
    renderDockList();
  });
  renderStatus();
  renderSortActive();
  syncDockFilterLabel();
  renderDockList();

  return {
    /** 只重画数据，不重建 DOM —— 移动端侧栏复用面板时用（见 index.ts: mountDock） */
    refresh() {
      if (destroyed) return;
      renderStatus();
      renderSortActive();
      syncDockFilterLabel();
      renderDockList();
    },
    destroy() {
      destroyed = true;
      // 先摘掉挂在容器自身上的监听：容器可能被复用（移动端 Dock），
      // 漏掉就会叠加处理器，一次点击触发多次（见 onRootClick 处说明）。
      root.removeEventListener("click", onRootClick);
      root.removeEventListener("input", onRootInput);
      document.removeEventListener("click", onDocClick, true);
      listScrollEl?.removeEventListener("scroll", onScrollClose);
      window.removeEventListener("resize", onScrollClose);
      unsub();
      root.innerHTML = "";
    }
  };
}

/**
 * 勾选待办（Dock 走这条）：返回 Promise，便于调用方在同步完成后再解除重渲染抑制。
 * 这里只负责「改状态 + 落库同步」，DOM 由调用方就地更新（避免整列表重建导致闪烁/滚动复位）。
 */
export function toggleTodoDone(ctx: PanelCtx, item: CalItem): Promise<void> {
  if (item.kind !== "todo") return Promise.resolve();
  const done = item.percent === 100;
  item.percent = done ? 0 : 100;
  item.status = done ? "NEEDS-ACTION" : "COMPLETED";
  if (!done) item.completedAt = new Date().toISOString().slice(0, 19);
  else item.completedAt = undefined;
  return ctx.sync.updateItem(item);
}

export function stepCursor(cursor: string, mode: ViewMode, dir: number): string {
  const d = parseLocalStamp(cursor);
  if (mode === "year") {
    d.setFullYear(d.getFullYear() + dir);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (mode === "month") {
    d.setDate(1);
    d.setMonth(d.getMonth() + dir);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (mode === "week") return addDays(cursor, dir * 7);
  return addDays(cursor, dir);
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

export { fmtTime, isDateOnly, parseLocalStamp };
