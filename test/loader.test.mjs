/**
 * 模拟思源 loader：加载 dist/index.js 并实例化插件，验证可正常初始化与渲染
 * 结构：无顶栏按钮；Dock = 标题 + 一行 5 按钮（新增/排序/日历视图/任务视图/刷新）；
 *       主日历页签 = 顶部 年/月/周/日 分段切换 + 视图容器。
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupBrowserDom, loadBuiltPlugin, seedStore, settle } from "./helpers.mjs";

setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
assert.ok(PluginClass, "应导出默认插件类");

const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();

const reg = globalThis.__syRegistrations;
assert.strictEqual(reg.topbar.length, 0, "不应注册顶栏按钮");
assert.strictEqual(reg.dock.length, 1, "应注册 Dock");
assert.strictEqual(reg.tab.length, 1, "应注册页签类型");
assert.ok(reg.icons[0].includes("iconCalDavSync"), "应注册图标");
assert.strictEqual(reg.commands.length, 4, "应注册 4 个命令");

const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

// 按钮等高是**纯 CSS** 的事，jsdom 不做布局，只能读源码断言
//（真正验几何的活儿交给 test/verify-toolbar-btns.mjs 的真浏览器测量）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(ROOT, "src", "index.css"), "utf8");

// ---- Dock 工具行（2026-10-10 改版：一行四个操作点）----
// 布局：日期范围下拉框 + 日历视图 + 任务视图 + 筛选（图标按钮）。
// 去掉的三个按钮：新建（主窗口工具栏已有）、刷新（同步按钮已有）、排序（任务视图已排序）。
seedStore(plugin);
const dockEl = document.createElement("div");
document.body.appendChild(dockEl);
const dockCustom = { element: dockEl, data: { key: "dock" } };
reg.dock[0].init.call(dockCustom, dockCustom);

assert.ok(dockEl.classList.contains("caldav-dock"), "Dock 应渲染精简面板");
assert.match(dockEl.querySelector(".caldav-brand-title")?.textContent || "", /日历任务管理/, "Dock 标题应为「日历任务管理」");
// 工具行里只剩 3 个图标按钮（日历视图 / 任务视图 / 筛选）—— 日期范围下拉不是 .caldav-dock-act
assert.strictEqual(dockEl.querySelectorAll(".caldav-dock-tools .caldav-dock-act").length, 3, "工具行应有 3 个图标按钮");
assert.ok(
  Array.from(dockEl.querySelectorAll(".caldav-dock-act")).every((b) => !b.querySelector("span") && !(b.textContent || "").trim()),
  "Dock 图标按钮应为纯图标（不含文字标签）"
);
// 反回归：新建 / 排序 / 刷新 三个按钮不得再出现
assert.strictEqual(dockEl.querySelectorAll(".caldav-dock-menu[data-menu]").length, 0, "「新建 / 排序」下拉菜单应已移除");
assert.ok(!dockEl.querySelector('[data-toggle="add"]'), "不应再有「新建」按钮");
assert.ok(!dockEl.querySelector('[data-toggle="sort"]'), "不应再有「排序」按钮");
assert.ok(!dockEl.querySelector('.caldav-dock-tools [data-action="sync"]'), "工具行不应再有「刷新」按钮");
assert.ok(!dockEl.querySelector(".caldav-dock-actions"), "旧的 5 按钮行 .caldav-dock-actions 应已移除");
// 「分类筛选」文字按钮升级为「筛选」图标按钮
assert.ok(!dockEl.querySelector(".caldav-dock-filter-btn"), "「分类筛选」文字按钮应已移除");
const filterBtn = dockEl.querySelector('.caldav-dock-tools [data-dock="category"]');
assert.ok(filterBtn, "工具行应有「筛选」按钮（data-dock=category）");
assert.match(filterBtn.getAttribute("title") || "", /筛选/, "筛选按钮应有 title");
assert.match(filterBtn.getAttribute("aria-label") || "", /筛选/, "筛选按钮应有 aria-label");
assert.ok(filterBtn.querySelector("svg"), "筛选按钮应为图标按钮");
assert.ok(dockEl.querySelector(".caldav-dock-tools .caldav-dock-filter-wrap"), "日期范围下拉应上移到工具行");
// 筛选弹层：按优先级 + 选择分类 两块（与 Obsidian 一致）。弹层内容是**点开时**才渲染的，
// 这里先点一下「筛选」按钮展开（与用户实际操作一致）。
click(filterBtn);
assert.strictEqual(dockEl.querySelectorAll("[data-prio-key]").length, 5, "优先级应有 1 全部 + 4 档共 5 项");
assert.ok(dockEl.querySelector('[data-prio-key="0"]'), "优先级应有「全部」项");
assert.strictEqual(dockEl.querySelectorAll("[data-cat-list] .caldav-dock-cat-item").length >= 1, true, "分类区应有选项");
assert.strictEqual(dockEl.querySelectorAll("[data-pop='category'] .caldav-dock-cat-head").length, 2, "筛选弹层应有「按优先级」「选择分类」两个区块标题");
// 筛选下拉必须是自定义控件：原生 <select> 的弹出列表由系统绘制，选中色永远是系统高亮色，
// 无法随主题变化（option:hover / :checked 会被浏览器忽略）。
assert.ok(!dockEl.querySelector("select[data-dock='filter']"), "筛选下拉不应再用原生 select");
assert.strictEqual(dockEl.querySelectorAll("[data-dock-filter]").length, 12, "筛选下拉应有 12 个自定义选项");

/** 选择某个筛选：先展开下拉，再点选项（与用户实际操作一致） */
const pickDockFilter = (key) => {
  click(dockEl.querySelector('[data-dock="filter"]'));
  click(dockEl.querySelector(`[data-dock-filter="${key}"]`));
};
assert.ok(!dockEl.querySelector(".caldav-dock-btn"), "不应再使用旧 nav 按钮");
assert.ok(!dockEl.querySelector(".caldav-app"), "Dock 不应渲染完整日历面板");
assert.ok(!dockEl.querySelector(".cal-month-grid"), "Dock 不应渲染月视图网格");
assert.ok(!dockEl.querySelector(".caldav-cal-item"), "Dock 不应包含日历列表");

// 回归保护：Dock 初始化后应延迟打开默认「日历」页签（编辑前因 init 阶段布局未就绪导致 openTab 被忽略）
await new Promise((r) => setTimeout(r, 450));
assert.ok(reg.lastOpenTab, "Dock 初始化后应默认在主窗口打开日历页签");
assert.strictEqual(reg.lastOpenTab.custom.title, "日历", "默认打开的页签标题应为「日历」");
assert.strictEqual(reg.lastOpenTab.custom.id, "siyuan-plugin-caldav-synccaldav-sync-tab", "默认页签 id 应为插件页签类型");

// Dock 下方最近任务/事件列表区
assert.ok(dockEl.querySelector(".caldav-dock-list"), "Dock 应显示最近任务/事件列表区");
assert.ok(dockEl.querySelector("[data-dock='filter']"), "Dock 应有筛选下拉");
// 搜索框已于 2026-10-09 移除（雄哥要求：Dock 只显示少量条目，搜索入口挪到任务视图），
// 反向断言防它被顺手加回来 —— 见 test/task-search.test.mjs 的完整契约。
assert.ok(!dockEl.querySelector("[data-dock='search']"), "Dock 不该再有搜索框（已挪到任务视图）");
assert.ok(dockEl.querySelector(".caldav-dock-items"), "Dock 应有任务列表容器");
assert.ok(dockEl.querySelectorAll(".caldav-dock-item").length >= 1, "默认「未来七天」筛选下 Dock 应渲染任务卡片");
assert.ok(dockEl.querySelector(".caldav-dock-tag"), "任务卡片应包含标签");

// ---- 筛选口径：日程按当前时刻判断（已结束的不显示），待办未完成即使逾期也显示 ----
const dockItemTexts = () => [...dockEl.querySelectorAll(".caldav-dock-item")].map((el) => el.textContent || "");
assert.ok(
  !dockItemTexts().some((t) => t.includes("昨天的会议")),
  "「未来七天」不应显示已经结束的日程事件"
);
assert.ok(
  !dockItemTexts().some((t) => t.includes("已结束的早会")),
  "「未来七天」不应显示日期在窗口内、但当天早已结束的日程（判断依据是当前时刻，不只是日期）"
);
const overdueItem = [...dockEl.querySelectorAll(".caldav-dock-item")].find((el) =>
  (el.textContent || "").includes("逾期待办")
);
assert.ok(overdueItem, "未完成的过期待办即使过期也应保留在「未来七天」中");
assert.ok(
  overdueItem.querySelector(".caldav-dock-tag--overdue")?.textContent?.includes("逾期 2 天"),
  "过期待办应带红色「逾期 2 天」标志"
);
assert.ok(
  overdueItem.querySelector(".caldav-dock-tag.prio-urgent"),
  "优先级 1 的任务标签应带 prio-urgent 类（按重要程度区分颜色）"
);
assert.ok(
  [...dockEl.querySelectorAll(".caldav-dock-tag")].some((t) => t.classList.contains("prio-high")),
  "优先级 3 的任务标签应带 prio-high 类"
);

// 无日期待办不能被静默隐藏（用户清空日期后曾反馈「记录不见了」）
const nodateHint = dockEl.querySelector(".caldav-dock-hint");
assert.ok(nodateHint, "默认筛选下应提示存在未显示的无日期待办");
assert.ok(/无日期待办/.test(nodateHint.textContent || ""), "提示文案应说明是无日期待办");
click(nodateHint);
assert.strictEqual(
  dockEl.querySelector(".caldav-dock-select-text").textContent,
  "无日期任务",
  "点击提示应切到「无日期」筛选（触发按钮文案同步）"
);
assert.ok(
  [...dockEl.querySelectorAll(".caldav-dock-item")].some((el) => el.textContent.includes("无截止任务")),
  "无日期筛选下应能看到无日期待办"
);
// 「今日任务」沿用同一口径
pickDockFilter("today");
const todayTexts = dockItemTexts();
assert.ok(
  todayTexts.some((t) => t.includes("逾期待办")),
  "「今日任务」也应显示未完成的过期待办"
);
assert.ok(
  !todayTexts.some((t) => t.includes("昨天的会议")),
  "「今日任务」不应显示已经结束的过去日程"
);

// 还原默认筛选，避免影响后续断言
pickDockFilter("next7");
assert.ok(dockEl.querySelector(".caldav-dock-hint"), "切回默认筛选后应再次提示无日期待办");

// Dock 分类筛选弹窗
const catBtn = dockEl.querySelector("[data-dock='category']");
assert.ok(catBtn, "Dock 应有分类筛选按钮");
click(catBtn);
const catPop = dockEl.querySelector("[data-pop='category']");
assert.ok(catPop && !catPop.hidden, "点击分类筛选应展开分类弹窗");
assert.ok(catPop.querySelector("[data-cat-key='__all__']"), "分类弹窗应含「所有分类」");
assert.ok(catPop.querySelector("[data-cat-key='__none__']"), "分类弹窗应含「无分类」");
assert.ok(catPop.querySelector("[data-cat-key='工作']"), "分类弹窗应含「工作」分类");
// 选择「工作」并确定
click(catPop.querySelector("[data-cat-key='工作'] input"));
click(catPop.querySelector("[data-cat-action='ok']"));
assert.ok(catPop.hidden, "确定后分类弹窗应收起");

// ---- 改了「服务器地址」却没重新发现日历：同步必须报错，而不是静默连旧地址「成功」----
// （用户实测反馈：地址填错保存后点刷新，Dock 仍显示同步成功）
// 2026-10-10 起 Dock 工具行里的「刷新」按钮已移除，同步入口改为点击页脚状态条
// （.caldav-dock-status，仍是 [data-action="sync"]）。
plugin.store.settings.serverUrl = "http://changed-host:9999/";
click(dockEl.querySelector('.caldav-dock-status[data-action="sync"]'));
// 同步是异步的，等状态栏从「同步中…」落定（轮询比固定 sleep 稳）
const dockStatus = dockEl.querySelector(".caldav-dock-status");
for (let i = 0; i < 50 && /同步中/.test(dockStatus.textContent || ""); i++) {
  await new Promise((r) => setTimeout(r, 10));
}
assert.match(
  String(plugin.store.lastError || ""),
  /服务器地址已变更/,
  "服务器地址变更后应记录明确错误，并提示重新「发现日历」"
);
assert.match(
  String(dockStatus.textContent || ""),
  /同步失败/,
  "Dock 状态栏应显示「同步失败」，而不是看起来像成功的「上次同步」"
);
// 还原，避免影响后续断言
plugin.store.settings.serverUrl = "http://127.0.0.1:5232/";
plugin.store.lastError = undefined;

// ---- 新建默认开始时间：落在当前时间的「下一个整点」，不再是固定 9:00 ----
// 2026-10-10 起 Dock 里的「新建」按钮已移除（主窗口工具栏已有「+日程 / +待办」），
// 因此这条测试改在**主面板工具栏**的 new-event 按钮上验（见下方页签初始化之后）。
const nextHourHH = (offset) => {
  const d = new Date();
  d.setHours(d.getHours() + 1 + offset, 0, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:00`;
};

// ---- Dock「日历视图」按钮 → 在主窗口打开页签 ----
click(dockEl.querySelector('[data-action="cal-view"]'));
assert.ok(reg.lastOpenTab, "点击「日历视图」应调用 openTab 打开主窗口页签");
assert.ok(String(reg.lastOpenTab.custom.id).includes("caldav-sync-tab"), "页签 id 应为插件页签类型");
// 回归保护：openTab 的 custom.data 必须可序列化且不得放入插件实例
// （否则思源在构建/保存布局时 JSON.stringify 抛循环引用错误，导致页签打不开）
assert.doesNotThrow(() => JSON.stringify(reg.lastOpenTab.custom.data), "custom.data 必须可 JSON 序列化");
assert.strictEqual(reg.lastOpenTab.custom.data?.plugin, undefined, "custom.data 不得包含插件实例（plugin），须改用闭包访问");

// 模拟主窗口页签初始化
const tabEl = document.createElement("div");
document.body.appendChild(tabEl);
const tabCustom = { element: tabEl, data: reg.lastOpenTab.custom.data };
reg.tab[0].init.call(tabCustom, tabCustom);

assert.ok(tabEl.querySelector(".caldav-app"), "页签应渲染完整日历面板");
assert.ok(tabEl.querySelector(".cal-month-grid"), "默认月视图应渲染");
assert.strictEqual(tabEl.querySelectorAll(".caldav-seg-btn").length, 4, "应有 年/月/周/日 四个分段按钮");
assert.strictEqual(tabEl.querySelectorAll(".caldav-cal-item").length, 2, "页签日历筛选应包含 2 个日历");
// 今日单元格应唯一标记（样式靠 .is-today 加深底色与描边）
assert.strictEqual(tabEl.querySelectorAll(".cal-month-cell.is-today").length, 1, "月视图应恰好一个今日单元格");

// ---- 新建默认开始时间：落在当前时间的「下一个整点」，不再是固定 9:00 ----
// 走主面板工具栏的「+日程」按钮（Dock 的「新建」已移除）。
click(tabEl.querySelector('[data-action="new-event"]'));
const newStartInput = document.querySelector('[data-f="startTime"]');
assert.ok(newStartInput, "点击主面板「日程」应打开编辑弹窗");
assert.strictEqual(newStartInput.value, nextHourHH(0), "新建日程的开始时间应为当前时间的下一个整点");
assert.strictEqual(
  document.querySelector('[data-f="endTime"]').value,
  nextHourHH(1),
  "新建日程的结束时间应为开始时间 + 1 小时"
);
assert.ok(
  !document.querySelector('.caldav-editor-foot [data-action="delete"]'),
  "新建弹窗不应有删除按钮"
);
document.querySelectorAll(".caldav-editor").forEach((e) => e.remove());

// 待办在日历上按「到期日」落位：跨日待办（开始今天/到期明天）不应落在今天
const cellsWithCross = [...tabEl.querySelectorAll(".cal-month-cell")].filter((c) =>
  c.textContent.includes("跨日待办")
);
assert.strictEqual(cellsWithCross.length, 1, "跨日待办应只落在一天（按到期日，不重复）");
assert.ok(!cellsWithCross[0].classList.contains("is-today"), "跨日待办不应落在开始日（今天）");
assert.ok(tabEl.querySelector(".cal-month-cell.is-today .cal-today-badge"), "今日单元格应有日期徽标");

// ---- 年视图 ----
click(tabEl.querySelector('[data-view="year"]'));
assert.ok(tabEl.querySelector(".cal-year"), "年视图应渲染");
assert.strictEqual(tabEl.querySelectorAll(".cal-year-month").length, 12, "年视图应有 12 个月");
// 点击某月标题 → 跳转到月视图
click(tabEl.querySelector(".cal-year-month-head"));
assert.ok(tabEl.querySelector(".cal-month-grid"), "点击月份标题应跳转到月视图");

// ---- 工具栏「视图切换」按钮：日历视图 ↔ 任务视图 互切 ----
const viewToggle = tabEl.querySelector('[data-action="toggle-view"]');
assert.ok(viewToggle, "工具栏应有视图切换按钮");
// 工具栏右侧按钮顺序：新建日程 / 新建待办 / 手动同步 / 日历筛选 / 视图切换
const rightGroup = tabEl.querySelector(".caldav-toolbar-right");
assert.strictEqual(
  rightGroup.lastElementChild,
  viewToggle,
  "视图切换按钮应是工具栏右侧最后一个（筛选在它左边）"
);
assert.deepStrictEqual(
  Array.from(rightGroup.children).map(
    (n) => n.dataset.action || n.querySelector("[data-action]")?.dataset.action
  ),
  ["new-event", "new-todo", "sync-now", "calfilter", "toggle-view"],
  "工具栏右侧按钮顺序应为：新建日程 / 新建待办 / 手动同步 / 日历筛选 / 视图切换"
);
// 手动同步按钮：必须在「新建」右边紧邻（用户要求加在新建按钮右边），
// 且图标按钮与文字按钮共用同一个高度变量，否则同一排会高低不齐。
const syncBtn = tabEl.querySelector('[data-action="sync-now"]');
assert.ok(syncBtn, "工具栏应有手动同步按钮");
assert.strictEqual(
  syncBtn.previousElementSibling?.dataset.action,
  "new-todo",
  "同步按钮应紧跟在「新建待办」右边"
);
assert.ok(/height:\s*var\(--caldav-btn-h\)/.test(css), "图标按钮必须用 --caldav-btn-h 定高");
assert.ok(
  /\.caldav-btn\s*\{[^}]*height:\s*var\(--caldav-btn-h\)/.test(css),
  "文字按钮必须用同一个 --caldav-btn-h（否则与图标按钮不等高）"
);
assert.ok(/box-sizing:\s*border-box/.test(css), "按钮必须 border-box（否则 34px + 边框 = 36px）");
assert.ok(
  !tabEl.classList.contains("caldav-touch") && !dockEl.classList.contains("caldav-touch"),
  "桌面端不应带 caldav-touch（把窗口拖窄也应保留条目时间）"
);
assert.strictEqual(plugin.mainCtx.viewMode, "month", "前置状态应为月视图");
assert.strictEqual(viewToggle.title, "切换到任务视图", "日历视图下按钮提示应指向任务视图");
assert.ok(viewToggle.innerHTML.includes("5.2 7.9l1.5"), "日历视图下按钮图标应为任务清单");
click(viewToggle);
assert.strictEqual(plugin.mainCtx.viewMode, "task", "点击后应切到任务视图");
assert.ok(tabEl.querySelector(".cal-task-view"), "点击后应渲染任务视图");
assert.strictEqual(viewToggle.title, "切换到日历视图", "任务视图下按钮提示应指向日历视图");
assert.ok(viewToggle.innerHTML.includes("14.6"), "任务视图下按钮图标应为日历");
click(viewToggle);
assert.strictEqual(plugin.mainCtx.viewMode, "month", "再次点击应切回日历视图");
assert.ok(tabEl.querySelector(".cal-month-grid"), "切回后应渲染月视图");
assert.strictEqual(viewToggle.title, "切换到任务视图", "切回后按钮提示应再次指向任务视图");

// ---- 任务视图（通过 Dock「任务视图」按钮进入）+ 下拉筛选 ----
click(dockEl.querySelector('[data-action="task-view"]'));
assert.ok(tabEl.querySelector(".cal-task-view"), "任务视图应渲染");
assert.ok(tabEl.querySelector(".cal-task"), "应有任务条目");
assert.ok(tabEl.querySelector(".caldav-app").classList.contains("is-task"), "任务视图应隐藏分段控件");

const filterSel = tabEl.querySelector(".cal-task-filter");
assert.ok(filterSel, "任务视图应有筛选下拉框");
assert.strictEqual(filterSel.value, "allincomplete", "任务视图默认应为「所有未完成」筛选");
assert.ok(
  [...tabEl.querySelectorAll(".cal-task")].some((t) => t.textContent.includes("无截止任务")),
  "「所有未完成」下应能看到无日期待办（清空日期后不至于「消失」）"
);
const nodateOpt = Array.from(filterSel.options).find((o) => o.value === "nodate");
assert.ok(nodateOpt, "筛选下拉框应含「无日期」选项");
filterSel.value = "nodate";
filterSel.dispatchEvent(new Event("change", { bubbles: true }));
const nodateTasks = tabEl.querySelectorAll(".cal-task");
assert.ok(nodateTasks.length >= 1, "「无日期」筛选应有任务");
assert.ok([...nodateTasks].some((t) => t.textContent.includes("无截止任务")), "应含无截止任务");
assert.ok(
  [...nodateTasks].some((t) => t.textContent.includes("仅开始时间任务")),
  "只有开始时间、无到期日的待办应归入「无日期」（待办按到期日归属）"
);
assert.ok(![...nodateTasks].some((t) => t.textContent.includes("测试条目 2")), "不应含带日期的任务");
filterSel.value = "today";
filterSel.dispatchEvent(new Event("change", { bubbles: true }));
assert.ok(tabEl.querySelectorAll(".cal-task").length >= 1, "「今日」筛选应有任务");
assert.ok(
  ![...tabEl.querySelectorAll(".cal-task")].some((t) => t.textContent.includes("仅开始时间任务")),
  "只有开始时间的待办不应算「今日」"
);
// 跨日待办：开始在今天、到期在明天 → 应归「明日」而不是「今日」
assert.ok(
  ![...tabEl.querySelectorAll(".cal-task")].some((t) => t.textContent.includes("跨日待办")),
  "跨日待办不应按开始日归到「今日」"
);
filterSel.value = "tomorrow";
filterSel.dispatchEvent(new Event("change", { bubbles: true }));
assert.ok(
  [...tabEl.querySelectorAll(".cal-task")].some((t) => t.textContent.includes("跨日待办")),
  "跨日待办应按到期日归到「明日」"
);
filterSel.value = "allincomplete";
filterSel.dispatchEvent(new Event("change", { bubbles: true }));

// ---- 周/日视图 ----
click(tabEl.querySelector('[data-action="today"]'));
click(tabEl.querySelector('[data-view="week"]'));
assert.ok(tabEl.querySelector(".cal-wk"), "周视图应渲染");
assert.strictEqual(tabEl.querySelectorAll(".cal-wk-col").length, 7, "周视图应 7 列");
assert.ok(tabEl.querySelector(".cal-wk-nowline"), "应有当前时间线");

click(tabEl.querySelector('[data-view="day"]'));
assert.strictEqual(tabEl.querySelectorAll(".cal-wk-col").length, 1, "日视图应 1 列");
const dayWk = tabEl.querySelector(".cal-wk");
assert.ok(/--cols:\s*1\b/.test(dayWk?.getAttribute("style") || ""), "日视图应把网格列数 --cols 设为 1（避免单列被压成 1/7 宽）");

// ---- 月视图，点击条目 chip 打开编辑弹窗 ----
click(tabEl.querySelector('[data-view="month"]'));
// 月视图按日期顺序排布，过去日期的条目会排在前面，这里按标题定位到目标条目
const chip = [...tabEl.querySelectorAll("[data-open]")].find((el) =>
  (el.textContent || "").includes("测试条目")
);
assert.ok(chip, "月视图应有「测试条目」chip");
click(chip);
assert.ok(document.querySelector(".caldav-editor"), "编辑弹窗应打开");
assert.ok(document.querySelector('[data-f="summary"]').value.includes("测试条目"), "弹窗应载入标题");
assert.ok(document.querySelector(".caldav-section--card"), "编辑弹窗应使用卡片分组");
// 编辑既有条目必须能看到删除入口（此前误加了 it.raw 条件，从服务器拉取的条目无 raw → 按钮消失）
const delBtn = document.querySelector('.caldav-editor-foot [data-action="delete"]');
assert.ok(delBtn, "编辑既有条目应显示删除按钮");
// 删除走「再点一次确认」，不依赖思源原生 confirm（在插件 iframe 里点确认无响应）
const countBeforeArm = plugin.store.getAll().length;
click(delBtn);
assert.ok(delBtn.classList.contains("is-armed"), "首次点击删除应进入确认态");
assert.match(delBtn.textContent || "", /确认删除/, "确认态文案应提示再点一次");
assert.strictEqual(plugin.store.getAll().length, countBeforeArm, "仅进入确认态时不应改动数据");
assert.ok(document.querySelector('[data-f="startDate"]'), "应拆分为开始日期输入");
assert.ok(document.querySelector('[data-f="startTime"]'), "应拆分为开始时间输入");

// ---- 时间选择器：同样不能用原生 <input type="time">（其弹出面板选中色固定为系统蓝，跟不了主题）----
assert.ok(!document.querySelector('input[type="time"]'), "时间输入不应再用原生 input[type=time]");
const timeTrigger = document.querySelector('[data-time="startTime"]');
assert.ok(timeTrigger, "开始时间应有自定义触发按钮");
const timePop = document.querySelector('[data-time-pop="startTime"]');
assert.ok(timePop && timePop.hidden, "时间弹层默认应收起");
assert.strictEqual(timePop.querySelectorAll(".caldav-time-col").length, 0, "未展开时弹层内容为空（按需生成）");
click(timeTrigger);
assert.ok(!timePop.hidden, "点击时间应展开自定义弹层");
assert.strictEqual(timePop.querySelectorAll(".caldav-time-col").length, 2, "弹层应含「时」「分」两列");
assert.strictEqual(
  timePop.querySelectorAll('.caldav-time-col[data-col="h"] .caldav-time-item').length,
  24,
  "小时列应有 24 项"
);
assert.ok(
  timePop.querySelector('.caldav-time-col[data-col="h"] .caldav-time-item.is-active'),
  "弹层应高亮当前小时"
);
click(timePop.querySelector('.caldav-time-col[data-col="h"] [data-time-val="15"]'));
const startTimeInput = document.querySelector('[data-f="startTime"]');
assert.ok(String(startTimeInput.value).startsWith("15:"), "点选小时后应写入开始时间");
assert.strictEqual(
  document.querySelector('[data-time-text="startTime"]').textContent,
  startTimeInput.value,
  "触发按钮上的文字应与时间值同步"
);
assert.ok(!timePop.hidden, "选完一项后弹层保持展开，便于接着选分钟");

// 时间框必须给左侧绝对定位的时钟图标留出内边距，否则数字会从最左端开始、与图标叠在一起
const timeCss = fs.readFileSync(path.resolve("dist/index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
// 必须带 .caldav-input 前缀（双类选择器）：单类规则会被文件更靠后的 `.caldav-input { padding: 8px 11px }`
// 整体覆盖，左侧内边距失效 → 时间数字会被绝对定位的时钟图标压住（这个坑真实踩过两次）
assert.match(
  timeCss,
  /\.caldav-input\.caldav-time-trigger\s*\{[^}]*padding:\s*8px 11px 8px 30px/,
  "时间触发按钮必须用双类选择器保留左侧内边距（单类会被 .caldav-input 的 padding 覆盖）"
);
// 时间框：桌面上保持 128px，但**必须可收缩**并给出下限。
// 曾经是 flex: 0 0 128px（完全不可收缩）—— 窄屏上它把整行撑破，
// 时间框和两个清除按钮被顶出卡片外（手机端截图报过）。下限 74px 仍能完整显示 "16:00"。
assert.match(
  timeCss,
  /\.caldav-input-wrap--time\s*\{[^}]*flex:\s*0 1 128px[^}]*min-width:\s*74px/,
  "时间框应 flex: 0 1 128px + min-width: 74px（可收缩但有下限），写成 0 0 128px 会在窄屏撑破整行"
);

// 静态匹配看不出「规则被后面的同类规则覆盖」，这里把产物 CSS 真的注入文档、
// 让浏览器算一遍层叠结果 —— 这才是这条 padding 到底生效没有的判定依据
const probeStyle = document.createElement("style");
probeStyle.textContent = timeCss;
document.head.appendChild(probeStyle);
const probe = document.createElement("button");
probe.className = "caldav-input caldav-time-trigger";
document.body.appendChild(probe);
assert.strictEqual(
  window.getComputedStyle(probe).paddingLeft,
  "30px",
  "时间按钮的实际左内边距必须是 30px —— 否则时间数字会被时钟图标压住"
);
probe.remove();
probeStyle.remove();
// ---- 开始时间变化后的结束时间联动 ----
// 该条目原结束时间 01:30 早于新的开始时间 15:00 → 应被改写为「开始 + 1 小时」
assert.strictEqual(
  document.querySelector('[data-f="endTime"]').value,
  "16:00",
  "开始时间晚于已有结束时间时，结束时间应自动改为开始时间 + 1 小时"
);
assert.strictEqual(
  document.querySelector('[data-f="endDate"]').value,
  document.querySelector('[data-f="startDate"]').value,
  "同日联动时结束日期应与开始日期保持一致"
);
const calInput = document.querySelector('input[data-f="calendar"]');
assert.ok(calInput && calInput.type === "hidden", "编辑弹窗应用隐藏 input 保存日历值（自定义下拉）");
const calTrigger = document.querySelector(".caldav-editor .caldav-cal-trigger");
const calHead = document.querySelector(".caldav-editor .caldav-cal-head");
assert.ok(calHead, "编辑弹窗应有「日历选择」分组标题");
assert.ok(/日历选择/.test(calHead.textContent || ""), "分组标题应为「日历选择」");
assert.ok(calTrigger, "编辑弹窗应保留日历自定义下拉触发按钮（有多个日历时可切换）");
assert.ok(calTrigger.closest(".caldav-input-wrap").querySelector(".caldav-cal-icon"), "日历下拉左侧图标应为日历颜色图标");
const calPop = document.querySelector(".caldav-editor .caldav-cal-pop");
assert.ok(calPop && calPop.hidden, "日历下拉弹层应存在且默认收起");
assert.ok(calPop.querySelectorAll(".caldav-cal-option").length >= 1, "日历下拉弹层应渲染日历选项");
// 点击触发按钮展开弹层，点选另一项后隐藏 input 值应更新
calTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
assert.ok(!calPop.hidden, "点击触发按钮应展开日历弹层");
const opt2 = calPop.querySelectorAll(".caldav-cal-option")[1];
if (opt2) {
  const prev = calInput.value;
  opt2.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  assert.notStrictEqual(calInput.value, prev, "点选选项应更新日历值");
  assert.ok(calPop.hidden, "点选后弹层应收起");
}
// 不应再渲染独立的“日历”字段标签（去掉冗余的「日历」文字行，下拉保留）
assert.ok(!document.querySelector(".caldav-editor .caldav-cal-head .caldav-field-label"), "「日历选择」分组下不应再渲染独立的“日历”字段标签");
const calTitleRow = document.querySelector(".caldav-editor .caldav-title-head");
assert.ok(calTitleRow, "编辑弹窗应有标题头部行（标题 + 开关同一行）");
assert.ok(calTitleRow.querySelector('[data-f="aiParse"]'), "标题头部行应包含「粘贴自动识别日期」开关");
// 任务分类药丸：默认分类渲染、点选写入隐藏 input、无分类清空
const catHidden = document.querySelector('input[data-f="categories"]');
assert.ok(catHidden && catHidden.type === "hidden", "分类值应存于隐藏 input");
const pills = Array.from(document.querySelectorAll(".caldav-cat-pill"));
assert.ok(pills.length >= 4, "分类药丸应含 无分类 + 默认分类");
assert.ok(pills[0].classList.contains("caldav-cat-pill--none"), "第一个药丸应为 无分类");
assert.ok(pills[0].classList.contains("is-active"), "默认应选中 无分类");
const workPill = pills.find((p) => p.dataset.cat === "工作");
assert.ok(workPill, "默认分类应包含 工作");
workPill.dispatchEvent(new MouseEvent("click", { bubbles: true }));
assert.strictEqual(catHidden.value, "工作", "点选分类药丸应写入分类名");
assert.ok(workPill.classList.contains("is-active"), "点选后药丸应高亮");
assert.ok(!pills[0].classList.contains("is-active"), "选择分类后 无分类 应取消高亮");
pills[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
assert.strictEqual(catHidden.value, "", "点 无分类 应清空分类");
// 管理分类按钮应打开分类管理弹窗
document.querySelector('[data-action="cat-manage"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
const mgr = document.querySelector(".caldav-catmgr");
assert.ok(mgr, "点 管理分类 应打开分类管理弹窗");
assert.ok(mgr.querySelector('[data-mgr="add"]'), "分类管理应有 添加新分类 按钮");
assert.ok(mgr.querySelector('[data-mgr="reset"]'), "分类管理应有 重置为默认 按钮");
assert.ok(mgr.querySelectorAll(".caldav-catmgr-row").length >= 3, "分类管理应列出默认分类");
// 添加新分类 → 出现编辑行；保存写回 store
mgr.querySelector('[data-mgr="add"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
const nameInput = mgr.querySelector('[data-edit="name"]');
assert.ok(nameInput, "添加新分类后应出现名称编辑框");
nameInput.value = "测试分类";
mgr.querySelector('.caldav-catmgr-row.is-editing [data-mgr="edit"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
mgr.querySelector('[data-action="save"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
await settle(); // 弹层销毁是异步的（先淡出、后移除并回调）
assert.ok(!document.querySelector(".caldav-catmgr"), "保存后分类管理弹窗应关闭");
assert.ok(document.querySelector(".caldav-editor"), "编辑弹窗应仍在");
assert.ok(document.querySelector(".caldav-foot-btn--primary"), "保存按钮应使用新样式");
assert.ok(document.querySelector(".caldav-foot-btn--ghost"), "取消按钮应使用新样式");
click(document.querySelector('[data-action="cancel"]'));
await settle();
assert.ok(!document.querySelector(".caldav-editor"), "弹窗应关闭");

// ---- Dock 排序下拉已移除（2026-10-10，雄哥要求）----
// 原来这里有 7 种排序 + 高亮 + 排序正确性的断言。现在 Dock 固定按时间轴排序，
// 反向断言防它被加回来。
assert.strictEqual(dockEl.querySelectorAll('[data-action^="sort-"]').length, 0, "Dock 不应再有排序选项");

// ---- Dock 筛选面板：优先级 + 分类，且执行「确定」后生效 ----
// 打开筛选面板（工具栏「筛选」图标按钮）
click(dockEl.querySelector("[data-dock='category']"));
const prioPop = dockEl.querySelector("[data-pop='category']");
assert.ok(prioPop && !prioPop.hidden, "点击「筛选」应展开筛选面板");
// 先选「全部」优先级 + 「所有分类」，重置为不过滤
click(prioPop.querySelector('[data-prio-key="0"] input'));
click(prioPop.querySelector("[data-cat-key='__all__'] input"));
click(prioPop.querySelector("[data-cat-action='ok']"));
assert.ok(prioPop.hidden, "确定后筛选面板应收起");
// 若此前步骤留了筛选，重置后列表应恢复
assert.ok(dockEl.querySelectorAll(".caldav-dock-item").length >= 1, "清空筛选后列表应正常渲染");

// ---- Dock 新增下拉已移除（2026-10-10）----
// 新建入口改到主面板工具栏（见上方 new-event 测试）。Dock 里不应再有「新建」下拉。
assert.strictEqual(dockEl.querySelectorAll('[data-toggle="add"]').length, 0, "Dock 不应再有「新建」下拉");

// ---- Dock 刷新按钮已移除（2026-10-10）----
// 同步入口改为主面板工具栏的 sync-now 与页脚状态条。Dock 工具行里不应再有刷新图标。
assert.strictEqual(
  dockEl.querySelectorAll('.caldav-dock-tools [data-action="sync"]').length,
  0,
  "Dock 工具行不应再有「刷新」按钮"
);

// ---- 页签已打开时，Dock「日历视图」应直接切回日历（不重复渲染） ----
click(dockEl.querySelector('[data-action="cal-view"]'));
assert.ok(tabEl.querySelector(".cal-month-grid"), "Dock 点击「日历视图」应切回月视图");

// ---- 日历筛选浮层：标题文案 + 设置入口已迁至 Dock 标题栏 ----
click(tabEl.querySelector('[data-action="calfilter"]'));
assert.ok(!tabEl.querySelector('[data-pop="calfilter"]').hidden, "日历筛选浮层应展开");
assert.strictEqual(
  tabEl.querySelector(".caldav-cal-head")?.textContent?.trim(),
  "日历筛选",
  "浮层标题应为「日历筛选」"
);
assert.ok(
  !tabEl.querySelector('.caldav-calfilter-pop [data-action="settings"]'),
  "浮层内不应再有「设置」菜单项"
);
assert.ok(
  tabEl.querySelector('.caldav-calfilter-pop [data-action="insert-diary"]'),
  "「插入日记」菜单项应保留"
);

// ---- 「日历视图中显示待办任务」开关：关掉后日历视图只留日程，任务视图不受影响 ----
// 关键字形：keyOf() 产出 "<uid>|<kind>"（重复实例多一段 recurId），所以用后缀选 kind。
const todoChips = () => tabEl.querySelectorAll('.caldav-view [data-open$="|todo"]').length;
const eventChips = () => tabEl.querySelectorAll('.caldav-view [data-open$="|event"]').length;
const showTodosBox = () => tabEl.querySelector('.caldav-calfilter-pop [data-opt="showTodos"]');
const setShowTodos = (on) => {
  const box = showTodosBox();
  box.checked = on;
  box.dispatchEvent(new Event("change", { bubbles: true }));
};

assert.ok(showTodosBox(), "日历筛选浮层应有「日历视图中显示待办任务」开关");
assert.strictEqual(showTodosBox().checked, true, "开关默认应为开启");
const todosBefore = todoChips();
assert.ok(todosBefore > 0, "默认月视图应同时显示待办");

setShowTodos(false);
assert.strictEqual(plugin.store.settings.showTodosInCalendar, false, "关掉开关应写入设置");
assert.strictEqual(todoChips(), 0, "关掉后月视图不应再显示待办");
assert.ok(eventChips() > 0, "关掉后日程事件仍应照常显示");

// 周 / 日视图共用同一份 occurrences，必须一致生效
click(tabEl.querySelector('[data-view="week"]'));
assert.strictEqual(todoChips(), 0, "关掉后周视图同样不应显示待办");
click(tabEl.querySelector('[data-view="day"]'));
assert.strictEqual(todoChips(), 0, "关掉后日视图同样不应显示待办");
click(tabEl.querySelector('[data-view="month"]'));

// 任务视图自己收集待办（view-task.ts），不该被这个日历开关连坐
click(tabEl.querySelector('[data-action="toggle-view"]'));
assert.ok(tabEl.querySelector(".cal-task"), "关掉开关后任务视图仍应显示任务");
click(tabEl.querySelector('[data-action="toggle-view"]'));

setShowTodos(true);
assert.strictEqual(plugin.store.settings.showTodosInCalendar, true, "重新打开应写回设置");
assert.strictEqual(todoChips(), todosBefore, "重新打开后待办数量应复原");
assert.strictEqual(showTodosBox().checked, true, "重渲染后开关应保持勾选状态");

// ---- 眼睛按钮 / 整行点击：切换该日历在视图中的显示与隐藏 ----
// 防回归：旧实现的通用 target 解析句子是 closest("[data-view],[data-action],[data-cal]")，
// 而眼睛按钮自身不带 data-* 属性 → closest 直接跳过它命中父级 .caldav-cal-item，
// 于是 target.classList.contains("caldav-cal-toggle") 恒为 false，点了完全静默无反应。
const calRow0 = () => tabEl.querySelector('.caldav-cal-item[data-cal="0"]');
const calEye0 = () => calRow0()?.querySelector(".caldav-cal-toggle");
const seedVisible = () =>
  [...tabEl.querySelectorAll("[data-open]")].some((el) => (el.textContent || "").includes("测试条目"));

assert.ok(calRow0(), "浮层应有第 1 个日历行");
assert.ok(seedVisible(), "初始应能看到该日历的条目");
assert.strictEqual(calEye0()?.getAttribute("aria-label"), "隐藏此日历", "启用态眼睛按钮文案应为「隐藏此日历」");

// 点眼睛 → 关闭该日历
click(calEye0());
assert.strictEqual(plugin.store.settings.calendars[0].enabled, false, "点眼睛应把该日历置为关闭");
assert.ok(calRow0().classList.contains("is-off"), "关闭后该行应带 is-off");
assert.strictEqual(calEye0()?.getAttribute("aria-label"), "显示此日历", "关闭态眼睛按钮文案应变为「显示此日历」");
assert.ok(!seedVisible(), "关掉的日历，其条目应从视图中消失");

// 点整行（名称）→ 恢复
click(calRow0().querySelector(".caldav-cal-name"));
assert.strictEqual(plugin.store.settings.calendars[0].enabled, true, "点整行应恢复该日历");
assert.ok(!calRow0().classList.contains("is-off"), "恢复后 is-off 应移除");
assert.ok(seedVisible(), "恢复后条目应重新出现");

// ---- Dock 标题栏设置按钮 → 设置弹窗 ----
assert.ok(dockEl.querySelector('[data-dock-action="settings"]'), "Dock 标题栏应有设置按钮");
click(dockEl.querySelector('[data-dock-action="settings"]'));
const settingsEl = document.querySelector(".caldav-settings");
assert.ok(settingsEl, "设置弹窗应打开");
assert.ok(settingsEl.querySelector(".caldav-section--card"), "设置弹窗应使用卡片分组");
assert.ok(settingsEl.querySelector('[data-action="save"].caldav-foot-btn--primary'), "设置弹窗保存按钮应为新主按钮风格");
assert.ok(settingsEl.querySelector('[data-action="cancel"].caldav-foot-btn--ghost'), "设置弹窗取消按钮应为新幽灵按钮风格");
// 空 URL 时测试连接应直接提示错误，不应显示成功
const serverInput = settingsEl.querySelector("input[data-s='server']");
if (serverInput) serverInput.value = "";
click(settingsEl.querySelector("[data-action='test']"));
const testMsg = settingsEl.querySelector("[data-msg]");
assert.ok(testMsg && testMsg.textContent.includes("服务器地址不能为空"), "空 URL 测试连接应提示服务器地址不能为空");

// ---- 日历颜色：单一 color 迁移成 eventColor/todoColor；「任务」「日程」药丸即取色器 ----
const calRows = Array.from(settingsEl.querySelectorAll(".caldav-set-cal"));
assert.ok(calRows.length >= 1, "设置弹窗应列出已配置的日历");
const row0 = calRows[0];
const cal0 = plugin.store.settings.calendars[0];
// 老数据（seedStore 只给了 color）渲染时就地升级：两色都继承原色，存量条目观感不变
assert.strictEqual(cal0.eventColor, "#3b82f6", "旧 color 应迁移为日程默认色 eventColor");
assert.strictEqual(cal0.todoColor, "#3b82f6", "旧 color 应同时迁移为待办默认色 todoColor（不改变观感）");
// 原来左侧那个独立的日历颜色方块必须去掉
assert.strictEqual(
  Array.from(row0.children).filter((e) => e.tagName === "INPUT" && e.type === "color").length,
  0,
  "日历行不应再有独立于「任务/日程」的左侧颜色方块"
);

const colorPills = Array.from(row0.querySelectorAll(".caldav-set-cal-tag"));
assert.strictEqual(colorPills.length, 2, "「任务」「日程」两个药丸都应保留");
const roleOf = (p) => p.querySelector("input[type=color]")?.dataset.role;
const pillByRole = (r) => colorPills.find((p) => roleOf(p) === r);
const todoPill = pillByRole("todoColor");
const evPill = pillByRole("eventColor");
assert.ok(todoPill && evPill, "两个药丸应分别绑定 todoColor / eventColor 取色输入");
assert.deepStrictEqual(
  colorPills.map(roleOf),
  ["eventColor", "todoColor"],
  "药丸顺序应为「日程」在前、「任务」在后"
);
assert.ok(
  (todoPill.textContent || "").includes("任务") && (evPill.textContent || "").includes("日程"),
  "药丸文字应仍为「任务」「日程」"
);
assert.strictEqual(
  todoPill.style.getPropertyValue("--tag-color").trim(),
  "#3b82f6",
  "药丸底色应显示该日历当前的默认色"
);
// 原生取色输入就铺在药丸里：点药丸=直接点在 input[type=color] 上，弹的是系统取色器
const todoInput = todoPill.querySelector("input[type=color]");
todoInput.value = "#00c853";
todoInput.dispatchEvent(new Event("input", { bubbles: true }));
assert.strictEqual(
  todoPill.style.getPropertyValue("--tag-color").trim(),
  "#00c853",
  "拖动取色器时药丸底色应实时跟随"
);
const evInput = evPill.querySelector("input[type=color]");
evInput.value = "#ff5252";
evInput.dispatchEvent(new Event("input", { bubbles: true }));

click(settingsEl.querySelector("[data-action='save']"));
await settle(6);
assert.strictEqual(cal0.todoColor, "#00c853", "保存后待办默认色应落库");
assert.strictEqual(cal0.eventColor, "#ff5252", "保存后日程默认色应落库");
assert.strictEqual(cal0.color, "#ff5252", "旧 color 字段应镜像 eventColor（旧版本端回读同一份数据不变灰）");

// ---- 颜色按条目类型解析：待办走 todoColor、日程走 eventColor ----
click(tabEl.querySelector('[data-view="month"]'));
const chipStyle = (key) =>
  (tabEl.querySelector(`.cal-chip-month[data-open="${key}"]`)?.style.getPropertyValue("--cal-color") || "").trim();
// ⚠️ 这里**不要绑定到具体条目**：月视图每个格子只渲染前 3 条（其余收进「还有 N 项…」），
// 而排序会把「已结束的日程」压到后面 —— 于是「seed-1 可见不可见」会随跑测试的时刻变化，
// 上午跑和深夜跑结论不同（深夜时当天日程全已结束，排序结果不一样）。按类型取任意一条
// 可见的 chip，断言的意图（日程取 eventColor、待办取 todoColor）完全一致，且不再看时钟脸色。
const chipStyleOfKind = (kind) =>
  (tabEl.querySelector(`.cal-chip-month[data-open$="|${kind}"]`)?.style.getPropertyValue("--cal-color") || "").trim();
assert.strictEqual(chipStyleOfKind("event"), "#ff5252", "无分类的日程应使用日历的日程默认色");
assert.strictEqual(chipStyleOfKind("todo"), "#00c853", "无分类的待办应使用日历的待办默认色");
assert.notStrictEqual(chipStyleOfKind("event"), chipStyleOfKind("todo"), "同一日历下日程/待办默认色应互相独立");

// ---- 「分类色优先于默认日程/待办色」这条老规则不能被本次改动破坏 ----
const catItem = plugin.store.getAll().find((it) => it.uid === "seed-11@test");
catItem.categories = ["工作"]; // 工作 = #e05a4c
plugin.store.putAndEmit(catItem);
click(tabEl.querySelector('[data-view="month"]'));
assert.strictEqual(
  chipStyle("seed-11@test|todo"),
  "#e05a4c",
  "命中分类的待办仍取分类颜色，不应被 todoColor 覆盖"
);
catItem.categories = undefined;
plugin.store.putAndEmit(catItem);
click(tabEl.querySelector('[data-view="month"]'));
assert.strictEqual(chipStyle("seed-11@test|todo"), "#00c853", "去掉分类后应回落到待办默认色");

document.querySelector(".b3-dialog .b3-dialog--close")?.remove();
settingsEl?.closest(".b3-dialog")?.remove();

// ---- 右键菜单：日历/任务视图上右击条目 → 编辑 / 删除 ----
const rclick = (el, x = 200, y = 200) =>
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
const ctxMenuEl = tabEl.querySelector(".caldav-ctxmenu");
assert.ok(ctxMenuEl, "日历面板应渲染右键菜单容器");
assert.ok(ctxMenuEl.hidden, "右键菜单默认应收起");
assert.ok(ctxMenuEl.querySelector('[data-ctx="edit"]'), "右键菜单应有「编辑」项");
assert.ok(ctxMenuEl.querySelector('[data-ctx="delete"]'), "右键菜单应有「删除」项");

const rcTarget = tabEl.querySelector(".cal-chip[data-open], .cal-task[data-open]");
assert.ok(rcTarget, "应能找到一个条目做右击测试");
const rcKey = rcTarget.dataset.open;
// 非条目区域右击不应展开菜单
rclick(tabEl.querySelector(".caldav-view"));
assert.ok(ctxMenuEl.hidden, "在空白处右击不应展开菜单");
// 条目上右击 → 展开，且阻止浏览器原生菜单
const rcEv = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 180, clientY: 160 });
rcTarget.dispatchEvent(rcEv);
assert.ok(rcEv.defaultPrevented, "在条目上右击应阻止原生右键菜单");
assert.ok(!ctxMenuEl.hidden, "在条目上右击应展开菜单");
assert.ok(/\d+px/.test(ctxMenuEl.style.left) && /\d+px/.test(ctxMenuEl.style.top), "菜单应定位到鼠标位置");
// 「编辑」应打开编辑弹窗并收起菜单
click(ctxMenuEl.querySelector('[data-ctx="edit"]'));
assert.ok(document.querySelector(".caldav-editor"), "右键菜单「编辑」应打开编辑弹窗");
assert.ok(ctxMenuEl.hidden, "点击「编辑」后菜单应收起");
click(document.querySelector('[data-action="cancel"]'));
await settle();
assert.ok(!document.querySelector(".caldav-editor"), "弹窗应关闭");
// 右击 → Esc 收起
rclick(rcTarget, 220, 180);
assert.ok(!ctxMenuEl.hidden, "再次右击应展开菜单");
document.dispatchEvent(new (globalThis.window.KeyboardEvent)("keydown", { key: "Escape", bubbles: true }));
assert.ok(ctxMenuEl.hidden, "Esc 应收起右键菜单");
// 右击 → 点外部区域收起
rclick(rcTarget, 220, 180);
assert.ok(!ctxMenuEl.hidden, "第三次右击应展开菜单");
click(tabEl.querySelector(".caldav-view"));
assert.ok(ctxMenuEl.hidden, "点击菜单外部应收起右键菜单");

// ---- 右键删除：首次点击进入确认态，再次点击才真正删除 ----
rclick(rcTarget, 240, 200);
const ctxDel = ctxMenuEl.querySelector('[data-ctx="delete"]');
assert.ok(ctxDel && !ctxMenuEl.hidden, "右键菜单删除项应可见");
click(ctxDel);
assert.ok(ctxDel.classList.contains("is-armed"), "右键删除首次点击应进入确认态");
assert.ok(plugin.store.get(rcKey), "确认态下条目不应被删除");
click(ctxDel);
await new Promise((r) => setTimeout(r, 80));
const rcAfter = plugin.store.get(rcKey);
assert.ok(
  !rcAfter || rcAfter.deleted === true,
  "右键删除第二次点击应执行删除（本地移除或标记为待删除）"
);
assert.ok(ctxMenuEl.hidden, "删除成功后菜单应收起");

// ---- 删除流程：首次点击进入确认态，再次点击才真正删除 ----
const anyOpen = tabEl.querySelector(".cal-chip[data-open], .cal-task[data-open]");
assert.ok(anyOpen, "应能点开一个条目做删除测试");
const targetKey = anyOpen.dataset.open;
click(anyOpen);
const delBtn2 = document.querySelector('.caldav-editor-foot [data-action="delete"]');
assert.ok(delBtn2, "删除测试用的编辑弹窗应有删除按钮");
click(delBtn2);
assert.ok(delBtn2.classList.contains("is-armed"), "首次点击应进入确认态");
assert.ok(plugin.store.get(targetKey), "确认态下条目不应被删除");
click(delBtn2);
await new Promise((r) => setTimeout(r, 80));
const afterDelete = plugin.store.get(targetKey);
assert.ok(
  !afterDelete || afterDelete.deleted === true,
  "第二次点击应执行删除（本地移除或标记为待删除）"
);

// ---- 待办的时间联动：开始/结束都允许为空；仅当结束早于开始时才顺延 ----
// 注意用例必须挑「有开始日期」的待办 —— 只有时间、没有日期时无法算出绝对时刻，联动会跳过
document.querySelectorAll(".caldav-editor").forEach((e) => e.remove()); // 清掉上一步残留的弹窗
click(dockEl.querySelector('[data-action="task-view"]'));
const openTodo = (title) => {
  const chip = [...tabEl.querySelectorAll(".cal-task[data-open]")].find((el) =>
    (el.textContent || "").includes(title)
  );
  assert.ok(chip, `任务视图应能定位到待办：${title}`);
  click(chip);
};
const setStartHour = (hh) => {
  click(document.querySelector('[data-time="startTime"]'));
  click(document.querySelector(`[data-time-pop="startTime"] [data-col="h"] [data-time-val="${hh}"]`));
};

// A. 结束时间为空 → 改开始时间后仍保持为空（待办允许结束留空）
openTodo("仅开始时间任务");
assert.strictEqual(document.querySelector('[data-f="endTime"]').value, "", "无结束时间的待办打开时结束时间应为空");
setStartHour("20");
assert.strictEqual(
  document.querySelector('[data-f="endTime"]').value,
  "",
  "待办改开始时间后，原本为空的结束时间应保持为空"
);

// B. 结束时间早于新的开始时间 → 顺延为「开始 + 1 小时」
document.querySelectorAll(".caldav-editor").forEach((e) => e.remove());
openTodo("测试条目 2");
assert.strictEqual(document.querySelector('[data-f="endTime"]').value, "18:00", "前置：该待办结束时间为 18:00");
setStartHour("20");
assert.strictEqual(
  document.querySelector('[data-f="endTime"]').value,
  "21:00",
  "待办结束时间早于新的开始时间时，应顺延为开始时间 + 1 小时"
);

// ---- 自定义提醒时间：多提醒列表（「添加提醒时间」/「添加预设」过去点了没反应）----
// 根因：这两个按钮从首个提交起就只有 HTML、**没有任何处理器**；且编辑器保存时只写 alarms[0]，
// 从别处同步来的多个提醒一保存就被丢掉。底层数据模型与提醒引擎一直支持多个提醒，这里把编辑器补齐并锁死。
const alarmKey = [...tabEl.querySelectorAll(".cal-task[data-open]")]
  .find((el) => (el.textContent || "").includes("测试条目 2"))?.dataset.open;
assert.ok(alarmKey, "前置：应能定位到待办「测试条目 2」的键");
assert.ok(!document.querySelector('[data-f="alarm"]'), "旧的单提醒下拉应已移除（它会把多个提醒砍成一个）");

const addAlarmBtn = document.querySelector('[data-action="add-alarm"]');
const addPresetBtn = document.querySelector('[data-action="add-preset"]');
assert.ok(addAlarmBtn, "应有「添加提醒时间」按钮");
assert.ok(addPresetBtn, "应有「添加预设」按钮");

const alarmRows = () => [...document.querySelectorAll("[data-alarm-list] .caldav-alarm-row")];
const alarmValues = () => alarmRows().map((r) => +r.querySelector("select[data-alarm]").value);
const alarmEmpty = () => document.querySelector("[data-alarm-empty]");

// 先清空（该条目原本可能已有提醒）
[...document.querySelectorAll('[data-action="del-alarm"]')].forEach(click);
assert.strictEqual(alarmRows().length, 0, "逐行删除后应一行不剩");
assert.ok(!alarmEmpty().hidden, "没有提醒时应显示「未设置提醒时间」提示");

click(addAlarmBtn);
assert.strictEqual(alarmRows().length, 1, "「添加提醒时间」必须真的加出一行（此前点了没反应）");
assert.strictEqual(alarmValues()[0], 15, "新行默认「提前 15 分钟」");
assert.ok(alarmEmpty().hidden, "有提醒后应隐藏空提示");
click(addAlarmBtn);
assert.strictEqual(alarmRows().length, 2, "再点一次应再加一行");
assert.notStrictEqual(alarmValues()[0], alarmValues()[1], "新行应自动避开已用过的提前量");

// 「添加预设」：展开常用组合浮层，点一项整组加入
const presetPop = document.querySelector("[data-alarm-presets]");
assert.ok(presetPop && presetPop.hidden, "预设浮层默认应收起");
click(addPresetBtn);
assert.ok(!presetPop.hidden, "点「添加预设」应展开浮层（此前点了没反应）");
assert.strictEqual(presetPop.querySelectorAll("[data-preset]").length, 3, "应列出 3 组常用组合");
click(presetPop.querySelectorAll("[data-preset]")[0]); // 提前 1 天 + 提前 1 小时 + 到点时
assert.ok(presetPop.hidden, "选中后浮层应收起");
const afterPreset = alarmValues();
assert.ok(afterPreset.includes(1440) && afterPreset.includes(0), "预设里的「提前 1 天 / 到点时」应被加入");
assert.strictEqual(afterPreset.length, 4, "已存在的提前量应被跳过（2 行 + 预设净增 2 个）");
assert.strictEqual(new Set(afterPreset).size, afterPreset.length, "不应出现重复的提醒时间");

// 行尾删除
click(alarmRows()[0].querySelector('[data-action="del-alarm"]'));
assert.strictEqual(alarmRows().length, 3, "行尾删除按钮应移除该行");

// 保存：多个提醒必须全部写回（旧实现 `it.alarms = [{...alarms[0]}]` 只留第一个）
const expectAlarms = alarmValues().sort((a, b) => a - b);
plugin.sync.updateItem = async (item) => {
  plugin.store.putAndEmit(item); // 离线桩：只落本地，不发请求
};
click(document.querySelector('.caldav-editor-foot [data-action="save"]'));
await settle(); // 弹窗销毁是异步的（先淡出、后移除）
const savedAlarms = (plugin.store.get(alarmKey)?.alarms || []).map((a) => a.minutesBefore).sort((a, b) => a - b);
assert.deepStrictEqual(savedAlarms, expectAlarms, "保存应写入全部提醒（旧实现只留第一个）");
assert.ok(!document.querySelector(".caldav-editor"), "保存成功后编辑弹窗应关闭");

// ---- 卸载：应主动关闭主窗口里已打开的「日历」自定义页签 ----
// 思源在禁用/卸载插件时只摘掉自己接管的注册项（Dock / 顶栏 / 工具栏），不会关闭页签，
// 于是主窗口会残留一个空白「日历」页签，且布局被写进 conf，重启后依然在。
const openTabs = (reg.customModels || []).map((m) => m.tab);
assert.ok(openTabs.length >= 1, "前置：主窗口应至少打开过一个日历自定义页签");
assert.ok(openTabs.every((t) => !t.closed), "前置：页签在卸载前应处于打开状态");
plugin.onunload();
assert.ok(openTabs.every((t) => t.closed), "卸载插件时应关闭所有残留的「日历」页签");
assert.ok(
  openTabs.every((t) => (reg.closedTabs || []).includes(t.id)),
  "关闭必须走 Tab.close()（内部 parent.removeTab → saveLayout），否则布局里仍会留下这条页签"
);
// uninstall 会在 onunload 之后由思源再调一次，必须幂等且不报错
plugin.uninstall();

// ---- CSS 防回归：对话框圆角在悬停时不应抖动 ----
const builtCss = fs.readFileSync(path.resolve("dist/index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(
  !/\.caldav-foot-btn:hover\s*\{[^}]*filter\s*:/.test(builtCss),
  "页脚按钮 hover 不应使用 filter（会生成合成层，导致对话框圆角短暂变方角）"
);
assert.ok(
  !/\.caldav-foot-btn\s*\{[^}]*transition:\s*all/.test(builtCss),
  "页脚按钮不应使用 transition: all（会把合成属性纳入过渡，引发重绘抖动）"
);
assert.ok(
  /\.caldav-editor-foot\s*\{[^}]*border-radius:\s*0\s+0/.test(builtCss),
  "对话框页脚应自带底部圆角，避免直角背景盖住容器圆角"
);
// 主按钮 hover 不能变成浅色底（--b3-theme-primary-light 是浅色调），否则白字看不清
assert.ok(
  !/\.caldav-foot-btn--primary:hover\s*\{[^}]*background:\s*var\(--caldav-accent-2\)/.test(builtCss),
  "主按钮 hover 不应使用浅色 --caldav-accent-2（白字配浅底不可读）"
);
assert.ok(
  /\.caldav-foot-btn--primary:hover\s*\{[^}]*color:\s*#fff/.test(builtCss),
  "主按钮 hover 必须保持白色文字，保证与加深底色对比度"
);

// ---- 日历筛选浮层：标题与菜单项字号应与其他弹窗同档，不能退回 11/12px 的小字 ----
assert.ok(
  /\.caldav-cal-head\s*\{[^}]*font-size:\s*14px/.test(builtCss),
  "「日历筛选」浮层标题应为 14px（与 Dock「选择分类」弹层标题一致）"
);
assert.ok(
  /\.caldav-calfilter-foot\s+\.caldav-link\s*\{[^}]*font-size:\s*13px/.test(builtCss),
  "浮层菜单项应为 13px（原 12px 偏小）"
);
assert.ok(
  /\.caldav-brand-set\s*\{[^}]*width:\s*26px/.test(builtCss),
  "Dock 标题栏设置按钮应有稳定的点击区域"
);
// 手机/平板没有 :hover，眼睛按钮若只靠 hover 显形就永远看不见 —— 必须在无悬停设备上常驻
assert.ok(
  /@media\s*\(hover:\s*none\)\s*\{[^}]*\.caldav-cal-toggle\s*\{\s*opacity:\s*1/.test(builtCss),
  "无悬停设备上眼睛按钮应常驻可见（否则触摸端根本发现不了这个开关）"
);

// ---- Dock 滚动条：透明背景 + 平时隐身 + 悬停显形 ----
assert.ok(
  /\.caldav-dock-list::-webkit-scrollbar-track[^{]*\{[^}]*background:\s*transparent/.test(builtCss),
  "Dock 列表滚动条轨道必须透明（否则右侧常驻一条灰色竖杠）"
);
assert.ok(
  /\.caldav-dock-list::-webkit-scrollbar-thumb[^{]*\{[^}]*background:\s*transparent/.test(builtCss),
  "Dock 列表滚动条滑块默认应完全透明（平时看不见）"
);
assert.ok(
  /\.caldav-dock-list:hover::-webkit-scrollbar-thumb[^{]*\{[^}]*background:\s*color-mix/.test(builtCss),
  "悬停时应把滑块显出来（color-mix 半透明主题色）"
);
assert.ok(
  /\.caldav-dock-list::-webkit-scrollbar-button[^{]*\{[^}]*display:\s*none/.test(builtCss),
  "必须显式隐藏滚动条两端的箭头按钮（Windows 下不隐藏就是那两条三角）"
);
// 思源给插件 Dock 套的滚动容器：靠运行时打标记，样式必须成对存在
assert.ok(
  /\.caldav-scroll-host::-webkit-scrollbar\s*\{/.test(builtCss) &&
    /\.caldav-scroll-host:hover::-webkit-scrollbar-thumb\s*\{/.test(builtCss),
  "思源 Dock 外层滚动容器也应有同款滚动条处理（.caldav-scroll-host）"
);

// ---- Dock 页脚：去掉分割线，改成一枚胶囊状态条 + 前置状态圆点 ----
assert.ok(
  !/\.caldav-dock-foot\s*\{[^}]*border-top/.test(builtCss),
  "Dock 页脚不应再有分割线（border-top）"
);
assert.ok(
  /\.caldav-dock-status\s*\{[^}]*border-radius:\s*999px/.test(builtCss) &&
    /\.caldav-dock-status\s*\{[^}]*background:\s*transparent/.test(builtCss) &&
    /\.caldav-dock-status\s*\{[^}]*opacity:\s*\.68/.test(builtCss),
  "状态条默认应极低调（胶囊形但无底色 + 压低不透明度），不能常驻抢眼"
);
assert.ok(
  /\.caldav-dock-status:hover\s*\{[^}]*background:\s*var\(--caldav-bg-3\)/.test(builtCss),
  "悬停时才显出胶囊底（提示这条可点即同步）"
);
assert.ok(
  /\.caldav-dock-status::before\s*\{[^}]*border-radius:\s*50%[^}]*background:\s*var\(--caldav-text-2\)/.test(builtCss),
  "正常态状态灯应为不抢眼的小暗点"
);
assert.ok(
  /\.caldav-dock-status\.has-error::before\s*\{[^}]*background:\s*var\(--caldav-danger\)/.test(builtCss) &&
    !/\.caldav-dock-status\.has-error\s*\{[^}]*background:\s*color-mix/.test(builtCss),
  "同步失败时只转红字红点，不铺红底（保持低调）"
);

// ---- 图标防回归：宿主 base.css 有全局规则 svg{fill:currentColor}，
//      presentation 属性 fill="none" 优先级低会被覆盖，导致 rect/圆/闭合 path 被填成实心黑块。
//      必须用内联 style 强制描边；日历里的日期点则用内联 style 保持实心。 ----
const builtJs = fs.readFileSync(path.resolve("dist/index.js"), "utf8");
assert.ok(
  builtJs.includes("getOpenedTab"),
  "卸载清理应通过官方 getOpenedTab() 找到本插件的自定义页签（否则主窗口会残留空白「日历」页签）"
);
assert.ok(
  builtJs.includes('style="fill:none'),
  "图标 svg 必须用内联 style 声明 fill:none（属性形式会被思源 base.css 的 svg{fill:currentColor} 覆盖，闭合图形会变成实心黑块）"
);
assert.ok(
  builtJs.includes('style="fill:currentColor;stroke:none"'),
  "日历图标内的日期点应保持实心（用内联 style，避免被父级 fill:none 继承覆盖）"
);

// ---- Dock 图标比例防回归：视觉大小 = 画布像素尺寸 × 图形在 viewBox 中的占比。
//      两侧都不能缩水：画布不足 20px、或 viewBox 退回 24 网格留白，都会让图标显得小。 ----
assert.match(
  builtCss,
  /\.caldav-dock-act svg\s*\{[^}]*width:\s*20px/,
  "Dock 操作按钮的图标画布应为 20px（按钮高 38px，过小会显得图标局促）"
);
assert.match(
  builtCss,
  /\.caldav-dock-tools\s*\{[^}]*display:\s*grid/,
  "Dock 工具行必须用 grid 定位：flex 下日期范围下拉框会把剩余宽度吃光，后三个图标按钮被挤到行尾"
);
// 工具行四列：日期范围（1.7fr）+ 日历视图 / 任务视图 / 筛选（各 1fr）
assert.match(
  builtCss,
  /\.caldav-dock-tools\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.7fr\)\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
  "Dock 工具行应为「日期范围 1.7fr + 三个图标按钮各 1fr」四列等距布局"
);
// 注：plusThin / refreshThin 两个图标随「新建」「刷新」按钮一起从 Dock 移除后
// 已被摇树掉，不再断言；此处只钉仍在用的「日历视图 / 任务视图 / 筛选」三个 Dock 图标
// 的 viewBox（"1.5 1.5 21 21"）。新增的 filter 图标也用同一套收紧策略。
assert.ok(
  builtJs.includes("1.5 1.5 21 21"),
  "Dock 图标应使用按图形收紧的 viewBox「1.5 1.5 21 21」（退回 0 0 24 24 会让图形四周留白、视觉变小）"
);
console.log("[loader] 模拟思源加载链路全部通过（Dock 工具行四操作点 + 下拉 + 年视图 + 分段切换 + 筛选面板 + 编辑弹窗）");
