/**
 * 任务视图：模仿思源「任务笔记管理」插件的下拉筛选风格。
 * 顶部一个筛选下拉（13 个维度 + 计数），下方展示当前筛选下的列表。
 *
 * ## 列表按时间轴分组（2026-10-08，从 Obsidian 侧回馈）
 *
 * 此前是**平铺**且**无排序** —— 顺序取决于服务器返回，190 条待办里
 * 「逾期 18 天」与「无日期」混在一起，扫不出轻重缓急。
 * 现按「逾期 / 今天 / 明天 / 本周 / 下周后 / 无日期 / 已完成」分桶，
 * 组头带计数、可折叠（已完成默认折叠）。
 *
 * 纯粹是**渲染层的分桶**，不改动 CalItem、不涉及同步逻辑。
 *
 * ## 日程事件混入（可选）
 *
 * 默认只列待办。设置里打开「任务视图中显示日程事件」后，日程也进同一列表；
 * 此时才再出现「任务视图中显示过期日程」这一层开关（嵌套联动）。
 *
 * 日程没有「完成」语义：勾选框换成圆点标记、不显示优先级、加「日程」角标；
 * 已过期的日程归入「已完成」组（时间过去了就等于结束，而非「逾期」）。
 */
import { addDays, defaultStartStamp, diffDays, parseLocalStamp, startOfWeek, todayStamp } from "../core/date";
import { occurrencesInRange } from "../core/ics";
import type { CalItem } from "../core/types";
import { calEventColor } from "../core/types";
import { calColorOf, escape, keyOfItem, matchesSearchQuery, todoDueOccurrences, type ViewArgs } from "./view-common";
import { icons } from "./icons";

type FilterKey =
  | "allitems"
  | "today"
  | "tomorrow"
  | "next7"
  | "thisweek"
  | "future"
  | "overdue"
  | "past7"
  | "allincomplete"
  | "nodate"
  | "todaydone"
  | "yesterdaydone"
  | "doneall";

/**
 * 列表里的一行。`due` 为归属日期（YYYY-MM-DD），无日期为空串；
 * `expired` 仅日程有 —— 过期日程按「已完成」处理（见 isDone）。
 */
type Row = { it: CalItem; due: string; isEvent: boolean; expired?: boolean };

interface TaskFilter {
  key: FilterKey;
  label: string;
  /**
   * 筛选判定。**收整个 Row 而非 (it, due)** ——
   * 「已完成」有两条路径（percent===100 / 过期日程），只在 `it` 上判断会漏掉后者，
   * 导致**筛选数字与分组数字对不上**（Obsidian 侧 2026-10-07 实测反馈）。
   * 收 Row 后可与 GROUPS 共用同一个 `isDone(row)`，两处口径永远一致。
   */
  match: (row: Row) => boolean;
}

function completedOn(it: CalItem, dateStr: string): boolean {
  return it.percent === 100 && !!it.completedAt && it.completedAt.slice(0, 10) === dateStr;
}

export function renderTaskView({ ctx, viewEl }: ViewArgs): void {
  const today = todayStamp();
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);
  const in7 = addDays(today, 7);
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 6);
  const past7Start = addDays(today, -7);

  /**
   * 「是否算已完成」的**唯一判定**。
   *
   * 两种情况：
   * 1. 待办 percent === 100 —— 本来就做完了
   * 2. **过期的日程** —— 日程没有「完成」语义，时间过去了就等于结束
   *
   * ⚠️ 统计条与分组**必须共用这一个判定**，否则会出现「已完成 +2 但待办总数
   * 没减」这种自相矛盾的数字（分组与统计是两处独立代码，最容易漂移）。
   *
   * ⚠️ 必须用**函数声明**而非箭头函数 —— 下面的 filters 在它之前就引用了，
   * 而 `const f = () => {}` 不会被提升，届时直接 ReferenceError。
   */
  function isDone(r: Row): boolean {
    return done(r.it) || r.expired === true;
  }

  const filters: TaskFilter[] = [
    // 「所有项目」= 不做任何过滤。此时列表内容与统计栏基数相同，数字必然一致。
    { key: "allitems", label: "所有项目", match: () => true },
    { key: "today", label: "今日", match: (r) => !isDone(r) && r.due === today },
    { key: "tomorrow", label: "明日", match: (r) => !isDone(r) && r.due === tomorrow },
    {
      key: "next7",
      label: "未来七天",
      match: (r) => !isDone(r) && r.due > tomorrow && r.due <= in7
    },
    {
      key: "thisweek",
      label: "本周",
      match: (r) => !isDone(r) && r.due >= weekStart && r.due <= weekEnd
    },
    { key: "future", label: "未来", match: (r) => !isDone(r) && r.due > in7 },
    { key: "overdue", label: "过期", match: (r) => !isDone(r) && !!r.due && r.due < today },
    {
      key: "past7",
      label: "过去七天",
      match: (r) => !isDone(r) && !!r.due && r.due >= past7Start && r.due < today
    },
    { key: "allincomplete", label: "所有未完成", match: (r) => !isDone(r) },
    { key: "nodate", label: "无日期", match: (r) => !isDone(r) && !r.due },
    { key: "todaydone", label: "今日已完成", match: ({ it }) => completedOn(it, today) },
    { key: "yesterdaydone", label: "昨日已完成", match: ({ it }) => completedOn(it, yesterday) },
    { key: "doneall", label: "已完成", match: (r) => isDone(r) }
  ];

  // 收集启用日历下的条目。默认只有待办（VTODO）；
  // 设置里打开「任务视图中显示日程事件」后，日程（VEVENT）也进同一列表。
  const enabled = new Set(ctx.store.settings.calendars.filter((c) => c.enabled).map((c) => c.url));
  const showEvents = ctx.store.settings.showEventsInTaskView === true;
  const showExpired = ctx.store.settings.showExpiredEventsInTaskView === true;
  const rows: Row[] = [];
  const endMs = parseLocalStamp(addDays(today, 400)).getTime();
  const startMs = parseLocalStamp(addDays(today, -400)).getTime();
  for (const it of ctx.store.getAll()) {
    if (it.deleted) continue;
    if (it.kind !== "todo" && it.kind !== "event") continue;
    if (!enabled.has(it.calendarUrl)) continue;
    if (it.kind === "event" && !showEvents) continue;

    if (it.kind === "todo") {
      // 待办的归属时间段一律以「到期日期」为准（无到期日则进「无日期」）
      const dueSrc = it.end;
      if (!dueSrc) {
        rows.push({ it, due: "", isEvent: false });
        continue;
      }
      const occs = todoDueOccurrences(it, parseLocalStamp(today).getTime(), endMs);
      rows.push({ it, due: occs.length && occs[0] ? occs[0].slice(0, 10) : dueSrc.slice(0, 10), isEvent: false });
      continue;
    }

    // 日程：取时间窗内最近一次发生；已过期是否收进列表取决于第二层开关。
    const occs = occurrencesInRange(it, startMs, endMs);
    let due = "";
    if (occs.length) {
      // occurrencesInRange 按时间升序，取第一个尚未过去的；全在过去则取最后一个
      const future = occs.find((o) => o.slice(0, 10) >= today);
      due = (future ?? occs[occs.length - 1]).slice(0, 10);
    } else {
      due = it.start.slice(0, 10);
    }
    const isPast = due !== "" && due < today;
    // 「显示过期日程」未开启时，过期日程不进列表（没有「完成」语义，
    // 默认显示只会污染待办列表）。注意是 continue 不是 break —— 还要继续遍历。
    if (isPast && !showExpired) continue;
    // 过期日程**归入「已完成」组**：日程没有「完成」语义，时间过去了就等于结束。
    // 而非塞进「逾期」—— 逾期是给「没做完且过期」的待办用的，对日程不适用。
    rows.push({ it, due, isEvent: true, expired: isPast });
  }
  const todos = rows;

  const countOf = (f: TaskFilter) => todos.filter(f.match).length;
  // 默认「所有未完成」：进任务视图先看该做的，已完成折叠着沉在下面。
  //
  // 注：早先默认是「所有项目」，为的是让统计栏与组头计数基数一致。
  // 两者的差异只在这一个筛选下成立 —— 「所有项目」时基数相同、数字必然对得上；
  // 切到别的筛选时组头是「当前筛选内」的计数、统计栏仍是全局概览。
  const current: FilterKey = (viewEl.dataset.filter || "allincomplete") as FilterKey;

  /** iCal PRIORITY（1 最高、9 最低）→ 文案与配色级别；覆盖 1~9 全部取值 */
  const priorityMeta = (p?: number): { label: string; cls: string } => {
    if (!p || p <= 0) return { label: "", cls: "" };
    if (p <= 2) return { label: "紧急", cls: "prio-urgent" };
    if (p <= 4) return { label: "高", cls: "prio-high" };
    if (p <= 6) return { label: "中", cls: "prio-mid" };
    return { label: "低", cls: "prio-low" };
  };

  /**
   * 时间轴分组。
   *
   * 顺序即「轻重缓急」：逾期的最该做，无日期的沉到最后。
   * 「本周」= **明天之后到本周日**（自然周，周一起算）。
   *  故它的跨度随「今天是周几」浮动：周一进来是 6 天，周二进来只剩 4 天。
   * 「下周后」= weekEnd 之后（含更远）；无日期 = 未设到期日。
   *
   * 组头用 --group-color 承载该组紧迫度色，点一下可折叠；只有一组时不显示组头
   * （避免「今天到期」这类筛选下多出一层无用标题）。
   */
  const GROUPS: { key: string; label: string; color: string; match: (r: Row) => boolean }[] = [
    { key: "overdue", label: "逾期", color: "var(--caldav-danger)", match: (r) => !isDone(r) && r.due !== "" && r.due < today },
    { key: "today", label: "今天", color: "#BA7517", match: (r) => !isDone(r) && r.due === today },
    { key: "tomorrow", label: "明天", color: "#378ADD", match: (r) => !isDone(r) && r.due === tomorrow },
    { key: "thisweek", label: "本周", color: "#1D9E75", match: (r) => !isDone(r) && r.due > tomorrow && r.due <= weekEnd },
    { key: "later", label: "下周后", color: "#888780", match: (r) => !isDone(r) && r.due > weekEnd },
    { key: "nodate", label: "无日期", color: "#B4B2A9", match: (r) => !isDone(r) && r.due === "" },
    { key: "done", label: "已完成", color: "#1D9E75", match: (r) => isDone(r) }
  ];

  /** 把筛选后的列表按组切分；每组内部按「日期升序 → 有优先级的在前」排 */
  function bucketize(list: Row[]): { g: (typeof GROUPS)[number]; items: Row[] }[] {
    const out: { g: (typeof GROUPS)[number]; items: Row[] }[] = [];
    for (const g of GROUPS) {
      const items = list.filter(g.match);
      if (!items.length) continue;
      items.sort((a, b) => {
        // 逾期的排最前（更早的更急），无日期恒沉底
        if (a.due === "" || b.due === "") return a.due === "" ? 1 : -1;
        if (a.due !== b.due) return a.due < b.due ? -1 : 1;
        // 同一天：优先级高的（数字小）排前
        const pa = a.it.priority || 9;
        const pb = b.it.priority || 9;
        return pa - pb;
      });
      out.push({ g, items });
    }
    return out;
  }

  /** 「已完成」被用户**显式展开**的标记 —— 解决「默认值与用户状态混在一个字段」的问题 */
  const EXPANDED_KEY = "__none__";

  /**
   * 该分组是否处于折叠态。
   *
   * 折叠状态存 `viewEl.dataset.collapsedGroups`（逗号分隔的分组 key），
   * **所有分组一视同仁** —— 任何组都能点组头折叠 / 展开。
   *
   * ⚠️ Obsidian 侧连修三次才定型的坑，这里直接采用最终解法（别再走回头路）：
   *
   * ① 写成 `if (gkey !== "done") return false;`（只有已完成组可折叠）——
   *    把「已完成默认折叠」这个**默认值**错当成**权限限制**，
   *    其他分组永远返回 false，写了状态也读不回来，等于锁死。
   *
   * ② 只存「折叠了哪些」无法表达「用户明确要求展开已完成」：
   *    展开时删掉 key → 读回时又走默认值判成折叠 → 点一下没反应。
   *
   * ③ 更隐蔽的：把默认值和用户状态混在**同一个字段**里 ——
   *    一旦用户折叠了别的组（如逾期），字段就非空，
   *    「已完成」便不再走默认值，被**静默判成展开**（用户点过展开的意图丢失）。
   *
   * 正解：**默认值只认「字段未设置」这一种情况**，
   * 一旦用户动过任何分组，就完全以显式列表为准。
   */
  function isCollapsed(gkey: string): boolean {
    // 仅在「从未被操作过」时用默认值（181 条不该和待办抢注意力）
    if (!viewEl.dataset.collapsedGroups) return gkey === "done";
    const set = viewEl.dataset.collapsedGroups.split(",");
    // 已完成且被显式展开 → 永不折叠（其余分组不受影响）
    if (gkey === "done" && set.includes(EXPANDED_KEY)) return false;
    return set.includes(gkey);
  }

  function setCollapsed(gkey: string, collapsed: boolean): void {
    const cur = (viewEl.dataset.collapsedGroups || "").split(",").filter(Boolean);
    let next: string[];
    if (collapsed) {
      // 折叠：写入本组；若折的是「已完成」，同时移除「显式展开」标记
      next = [...new Set([...cur.filter((x) => x !== EXPANDED_KEY), gkey])];
    } else {
      // 展开：移除本组
      next = cur.filter((x) => x !== gkey);
      // 展开「已完成」要留下显式标记，否则会被默认值判回折叠（缺陷②）
      if (gkey === "done" && !next.includes(EXPANDED_KEY)) next.push(EXPANDED_KEY);
    }
    if (next.length) viewEl.dataset.collapsedGroups = next.join(",");
    else delete viewEl.dataset.collapsedGroups;
  }

  /**
   * 当前搜索词。
   *
   * 存`viewEl.dataset.taskQuery`，与折叠状态同一套路：**每次重渲染都会重建
   * `viewEl.innerHTML`**，若把搜索词只放局部变量，用户每输入一个字符
   * 触发一次重渲染后就把词丢了（框被清空、列表也刷回全量）。
   */
  function searchQuery(): string {
    return viewEl.dataset.taskQuery || "";
  }

  function setSearchQuery(q: string): void {
    if (q) viewEl.dataset.taskQuery = q;
    else delete viewEl.dataset.taskQuery;
  }

  /** 单条渲染；抽成函数是为了让「分组列表」与「不分组的扁平列表」共用同一份标记 */
  function itemHtml({ it, due, isEvent, expired }: Row): string {
    const k = keyOfItem(it);
    // 复用外层的 isDone（含「过期日程算已完成」），不另写一份
    const finished = isDone({ it, due, isEvent, expired });
    const overdue = !finished && !!due && due < today;
    const pr = priorityMeta(it.priority);
    const cal = ctx.store.settings.calendars.find((c) => c.url === it.calendarUrl);
    const kindLabel = isEvent ? "日程" : "待办";
    const dueText = finished
      ? it.completedAt
        ? "完成于 " + it.completedAt.slice(5, 10)
        : expired
        ? "已过期"
        : "已完成"
      : !due
      ? "无日期"
      : due === today
      ? "今天"
      : due === tomorrow
      ? "明天"
      : overdue
      ? `逾期 ${Math.abs(diffDays(due, today))} 天`
      : due.slice(5);
    // 日程没有「完成」语义：勾选框改为圆点标记，且不显示优先级（VEVENT 无 PRIORITY）。
    // 注意过期日程虽归入「已完成」组，但仍走圆点分支 —— 它并没有真的被勾选。
    const check = isEvent
      ? `<span class="cal-task-check cal-task-check--event" title="${kindLabel}"></span>`
      : `<button class="cal-task-check" data-toggle="${k}" title="${finished ? "标记未完成" : "标记完成"}">${finished ? "✓" : ""}</button>`;
    const prio = !isEvent && pr.label ? `<span class="cal-task-priority ${pr.cls}">${pr.label}</span>` : "";
    return `
<div class="cal-task ${finished ? "is-done" : ""} ${overdue ? "is-overdue" : ""} ${isEvent ? "is-event" : "is-todo"}" data-open="${k}" style="--cal-color:${calColorOf(ctx, it)}">
  ${check}
  <div class="cal-task-body">
    <div class="cal-task-title"><span class="cal-task-kind ${isEvent ? "is-event" : "is-todo"}">${kindLabel}</span>${it.rrule ? "↻ " : ""}${escape(it.summary || "(无标题)")}
      ${prio}</div>
    <div class="cal-task-meta">
      <span class="${overdue ? "cal-task-overdue" : ""}">${dueText}</span>
      ${it.description ? `<span class="cal-task-desc" title="${escape(it.description)}">${escape(it.description).slice(0, 40)}</span>` : ""}
      <span class="cal-task-cal"><i style="background:${calEventColor(cal)}"></i>${escape(cal?.displayName || "")}</span>
    </div>
  </div>
</div>`;
  }

  function listHtml(filterKey: FilterKey): string {
    const f = filters.find((x) => x.key === filterKey)!;
    // 搜索在筛选**之后**再过一道 —— 顺序反了的话，
    // 「所有未完成 (17)」这类计数会与列表对不上（计数是按筛选算的，不含搜索）。
    // 注意传的是 `row.it`：list 里的元素是 Row 包装（{ it, due, isEvent }），不是裸 CalItem。
    const list = todos.filter(f.match).filter((row) => matchesSearchQuery(row.it, searchQuery()));
    if (!list.length) {
      // 区分「筛选下没东西」与「筛选有、被搜索过滤光了」——
      // 后者若也报「暂无任务」，用户会以为数据没了。
      const q = searchQuery();
      return `<div class="cal-task-empty">${q ? `没有匹配「${escape(q)}」的任务` : "该筛选下暂无任务"}</div>`;
    }
    /**
     * 只返回列表**内层**内容；外层 `.cal-task-list` 由模板提供。
     * （曾在这里又套一层 `<div class="cal-task-list">`，会与模板里的
     *   外层嵌套 —— 折叠时重渲染的是外层，内层多包一级虽不出错但结构冗余。）
     */
    // 按时间轴分组渲染；只有一组时不显示组头（避免「所有未完成」下多余的一层标题）
    const buckets = bucketize(list);
    if (buckets.length <= 1) {
      return list.map(itemHtml).join("");
    }
    return buckets
      .map(({ g, items }) => {
        const collapsed = isCollapsed(g.key);
        const caret = collapsed ? "▸" : "▾";
        return `
<div class="cal-task-group" data-group="${g.key}">
  <div class="cal-task-group-head" data-toggle-group="${g.key}" role="button" tabindex="0"
       style="--group-color:${g.color}"
       aria-expanded="${collapsed ? "false" : "true"}" title="${collapsed ? "展开" : "折叠"}">
    <span class="cal-task-group-caret" aria-hidden="true">${caret}</span>
    <span class="cal-task-group-dot" style="background:${g.color}"></span>
    <span class="cal-task-group-label">${g.label}</span>
    <span class="cal-task-group-count">${items.length}</span>
  </div>
  ${collapsed ? "" : `<div class="cal-task-group-body">${items.map(itemHtml).join("")}</div>`}
</div>`;
      })
      .join("");
  }

  /**
   * 统计条：原先 4 张大卡片（各占 1/4 宽），现改为**一行 6 项**紧凑排列。
   *
   * ⚠️ 计数**复用 GROUPS 的 match**，不要另写一套 —— 两处口径容易漂移
   * （统计说 190 待办、分组加起来却不是 190）。
   */
  const undone = todos.filter((t) => !isDone(t));
  const countBy = (key: string): number => {
    const g = GROUPS.find((x) => x.key === key);
    return g ? todos.filter(g.match).length : 0;
  };
  const statHtml = [
    { cls: "cal-stat-total", label: "待办", n: undone.length },
    { cls: "cal-stat-today", label: "今日", n: countBy("today") },
    { cls: "cal-stat-overdue", label: "逾期", n: countBy("overdue") },
    // 「未来」= 明天之后的全部未完成（明天 / 本周 / 下周后 三组合并）
    { cls: "cal-stat-future", label: "未来", n: undone.filter((t) => t.due !== "" && t.due > today).length },
    { cls: "cal-stat-nodate", label: "无日期", n: undone.filter((t) => t.due === "").length },
    { cls: "cal-stat-done", label: "已完成", n: countBy("done") }
  ]
    .map((s) => `<div class="cal-task-stat ${s.cls}"><b>${s.n}</b><span>${s.label}</span></div>`)
    .join("");

  const optsHtml = filters
    .map((f) => `<option value="${f.key}" ${f.key === current ? "selected" : ""}>${f.label} (${countOf(f)})</option>`)
    .join("");

  viewEl.innerHTML = `
<div class="cal-task-view">
  <div class="cal-task-filterbar">
    <select class="cal-task-filter" data-filter title="按条件筛选">${optsHtml}</select>
    <input class="caldav-input cal-task-quick" placeholder="快速添加待办，回车保存（默认今天）…" data-quickadd/>
    <!--
      搜索框（2026-10-09 雄哥要求）：原先搜索框在左侧 Dock 里，
      但Dock 只显示少量条目、在那儿搜等于「搜一个看不见全貌的列表」。
      挪到任务视图 —— 这里才是完整清单，搜到了立刻看得见。
      宽度按 2:1 分给快速添加（flex:2）与搜索（flex:1）：
      快速添加是高频操作、需要能看清标题全文；搜索是「临时过滤」用途。
    -->
    <span class="cal-task-searchwrap">
      <span class="cal-task-search-icon">${icons.search}</span>
      <input class="caldav-input cal-task-search" placeholder="搜索..." data-task-search
             value="${escape(searchQuery())}" />
    </span>
  </div>
  <div class="cal-task-list">${listHtml(current)}</div>
</div>`;

  /**
   * 统计条**挂进工具条**（从 Obsidian 侧回馈）。
   *
   * 原先它在列表上方独占一行。任务视图时工具条的左（导航）与中（年/月/周/日）
   * 两块本来就被 `.is-task` 隐藏、只剩右侧「新建/筛选/切换」—— 正好有地方放。
   *
   * 为什么用挂载点而非直接把 DOM 挪过去：统计条每轮重渲染都会重建，
   * 留在工具条里能让它跟着重渲染走，不会与列表的渲染时机脱节。
   *
   * 挂载点在 `panel.ts` 的模板里（`[data-slot="task-stats"]`），
   * 它与 `viewEl` 是兄弟节点，故要从 `viewEl` 往上找父级。
   */
  const statsSlot = viewEl.closest(".caldav-main")?.querySelector<HTMLElement>('[data-slot="task-stats"]');
  if (statsSlot) statsSlot.innerHTML = statHtml;

  const select = viewEl.querySelector<HTMLSelectElement>("[data-filter]");
  select?.addEventListener("change", () => {
    const val = select.value as FilterKey;
    viewEl.dataset.filter = val;
    const list = viewEl.querySelector<HTMLElement>(".cal-task-list");
    if (list) list.innerHTML = listHtml(val);
  });

  /**
   * 当前生效的筛选项。
   *
   * ⚠️ 不能复用上面的 `current` 常量 —— 它是**渲染那一刻**算出来的，
   * 用户之后切了筛选它不会变。折叠重渲染若用它，列表会退回旧筛选
   * （表现为：切到「所有项目」后点一下组头，已完成组凭空消失）。
   * 折后重渲染一律现读 dataset。
   */
  const curFilter = (): FilterKey => (viewEl.dataset.filter || "allincomplete") as FilterKey;

  /**
   * 搜索框：每输入一个字符就过滤一次列表。
   *
   * ⚠️ 只重渲染 `.cal-task-list`，**绝不重渲染 viewEl 整体** ——
   * 整体重渲染会把输入框连同用户刚敲进去的字一起换掉，
   * 于是「每打一个字符框就清空一次」，输入根本打不完（这是最直白的坑）。
   * 同理不用 `viewEl.innerHTML = ...` 重走模板。
   *
   * 搜索词写进 dataset 是为了跨重渲染存活（见 searchQuery 处说明）。
   */
  const searchInput = viewEl.querySelector<HTMLInputElement>("[data-task-search]");
  searchInput?.addEventListener("input", () => {
    setSearchQuery(searchInput.value);
    const list = viewEl.querySelector<HTMLElement>(".cal-task-list");
    if (list) list.innerHTML = listHtml(curFilter());
  });

  /**
   * 组头折叠 / 展开。
   *
   * 绑在 `viewEl` 上做事件委托而非逐个组头绑 —— 折叠会让列表整体重渲染，
   * 逐个绑定就得每次重新挂，漏挂一处就点不动。
   */
  const toggleGroup = (head: HTMLElement | null): void => {
    if (!head || !viewEl.contains(head)) return;
    const gkey = head.dataset.toggleGroup!;
    setCollapsed(gkey, !isCollapsed(gkey));
    const list = viewEl.querySelector<HTMLElement>(".cal-task-list");
    if (list) list.innerHTML = listHtml(curFilter());
  };

  viewEl.addEventListener("click", (ev) => {
    toggleGroup((ev.target as HTMLElement).closest<HTMLElement>("[data-toggle-group]"));
  });
  // 键盘可达：组头是 role=button，Enter / Space 等同点击
  viewEl.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    toggleGroup((ev.target as HTMLElement).closest<HTMLElement>("[data-toggle-group]"));
  });

  const input = viewEl.querySelector<HTMLInputElement>("[data-quickadd]");
  input?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && input.value.trim()) {
      const title = input.value.trim();
      const cal = ctx.store.settings.calendars.find((c) => c.enabled && c.supportsTodo !== false) || ctx.store.settings.calendars[0];
      void ctx.sync
        .createItem({
          uid: genUid(),
          kind: "todo",
          calendarUrl: cal.url,
          href: cal.url.replace(/\/+$/, "") + "/" + genUid() + ".ics",
          summary: title,
          allDay: false,
          // 快速添加同样落在「下一个整点」，而不是固定 9:00
          start: defaultStartStamp(today),
          end: defaultStartStamp(today),
          priority: 0,
          status: "NEEDS-ACTION",
          percent: 0,
          createdAt: today + "T09:00:00",
          dirty: true
        })
        .then(() => {
          input.value = "";
          // 补刷一次列表：新条目可能在当前搜索词下不匹配（用户往往正搜着别的），
          // 但统计条与下拉计数已经是全量口径，不刷会出现「计数涨了、列表没动」。
          const list = viewEl.querySelector<HTMLElement>(".cal-task-list");
          if (list) list.innerHTML = listHtml(curFilter());
        });
    }
  });
}

function done(it: CalItem): boolean {
  return it.percent === 100;
}

export function genUid(): string {
  return "sy-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
