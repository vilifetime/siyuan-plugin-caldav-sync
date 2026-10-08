/**
 * 任务视图「时间轴分组」回归（npm run test:task）。
 *
 * 背景：改造前任务视图是**平铺且无排序** —— 顺序取决于服务器返回，190 条待办里
 * 「逾期 18 天」与「无日期」混在一起，扫不出轻重缓急。现在按
 * 「逾期 / 今天 / 明天 / 本周 / 下周后 / 无日期 / 已完成」分桶，组头带计数、可折叠。
 *
 * 分组顺序错了很难肉眼发现 —— 尤其「下周后」与「无日期」的先后、
 * 以及「已完成」必须沉底且默认折叠。所以这里钉住三件事：
 *   ① 组的先后顺序 = 轻重缓急
 *   ② 组内排序（日期升序 → 同日期优先级高的在前）
 *   ③ 折叠默认值与用户状态不能混在一个字段（已完成默认折叠、点开展开后要留住）
 *
 * 另有源码级断言：分组定义只存在于 view-task.ts，测试若照抄一份，
 * 生产代码改了测试不会发现 —— 故断言源码里的 GROUPS 顺序与折叠实现。
 *
 * 走移动端全屏 Dialog 链路拿真实 DOM：桌面端依赖内核建页签 DOM，测试桩里拿不到。
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupBrowserDom, loadBuiltPlugin, settle } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "src", "ui", "view-task.ts"), "utf8");

// 必须在加载产物之前设置：桩的 getFrontend() 读取该变量
process.env.SY_FRONTEND = "mobile";

setupBrowserDom();

// 移动端侧栏骨架（插件靠观察它们补挂 Dock），须在 onload 之前就位
["sidebar", "sidebarRight"].forEach((id) => {
  const panel = document.createElement("div");
  panel.id = id;
  panel.className = "side-panel fn__flex-column";
  panel.innerHTML =
    `<div class="toolbar toolbar--border"><div class="toolbar__scroll"></div></div>` +
    `<div class="fn__flex-1 b3-list--mobile"></div>`;
  document.body.appendChild(panel);
});

globalThis.fetch = async () => ({
  ok: true,
  status: 204,
  statusText: "No Content",
  headers: new Map(),
  text: async () => "",
  json: async () => ({})
});

const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();

const CAL = "http://127.0.0.1:5232/testuser/work/";

/* ---------- 日期工具：不写死日期，任何一天跑都对 ---------- */
const p = (n) => (n < 10 ? "0" + n : String(n));
const fmt = (x) => `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
const addD = (base, n) => {
  const x = new Date(base + "T00:00:00");
  x.setDate(x.getDate() + n);
  return fmt(x);
};
const TODAY = fmt(new Date());
const TOMORROW = addD(TODAY, 1);
// 自然周周一起算（与 core/date.startOfWeek 同口径）
const dow = (new Date(TODAY + "T00:00:00").getDay() + 6) % 7; // 0 = 周一
const WEEK_END = addD(TODAY, 6 - dow);
// 「本周」= 明天之后到本周日：今天若是周六/周日，这段区间为空（设计如此，非 bug）
const HAS_THISWEEK = WEEK_END > TOMORROW;

/* ---------- 造数据：每组至少一条，且能验组内排序 ---------- */
const store = plugin.store;
store.settings = {
  serverUrl: "http://127.0.0.1:5232/",
  username: "testuser",
  password: "testpass",
  calendarPath: "",
  channel: "direct",
  syncIntervalMin: 0,
  conflict: "server",
  pastDays: 90,
  futureDays: 370,
  defaultCalendarUrl: CAL,
  calendars: [{ url: CAL, displayName: "工作", color: "#3b82f6", enabled: true, supportsEvent: true, supportsTodo: true }],
  showEventsInTaskView: false,
  showExpiredEventsInTaskView: false
};

let seq = 0;
const put = (over) => {
  const i = ++seq;
  store.put({
    uid: `tk-${i}@test`,
    kind: "todo",
    calendarUrl: CAL,
    href: `${CAL}tk-${i}.ics`,
    etag: `"v${i}"`,
    summary: `条目 ${i}`,
    allDay: false,
    start: "",
    end: undefined,
    status: "NEEDS-ACTION",
    percent: 0,
    dirty: false,
    deleted: false,
    ...over
  });
};
const todo = (summary, due, over = {}) =>
  put({ summary, start: `${due || TODAY}T09:00:00`, end: due ? `${due}T18:00:00` : undefined, ...over });
const event = (summary, day) =>
  put({ kind: "event", summary, start: `${day}T10:00:00`, end: `${day}T11:00:00` });

// 逾期两条：更早的必须排在前
todo("逾期十八天", addD(TODAY, -18));
todo("逾期两天", addD(TODAY, -2));
// 今天两条：同日期，优先级高的（数字小）必须排在前
todo("今天·低优先级", TODAY, { priority: 9 });
todo("今天·紧急", TODAY, { priority: 1 });
todo("明天到期", TOMORROW);
if (HAS_THISWEEK) todo("本周内到期", WEEK_END);
todo("很久以后", addD(TODAY, 20));
todo("无日期任务", "");
todo("已完成待办", addD(TODAY, -1), { percent: 100, status: "COMPLETED", completedAt: `${TODAY}T08:00:00` });
// 两个日程：一个未来、一个已过期
const FUTURE_EVENT = "未来日程";
const PAST_EVENT = "过期日程";
event(FUTURE_EVENT, addD(TODAY, 3));
event(PAST_EVENT, addD(TODAY, -5));

const EXPECTED = [
  "逾期",
  "今天",
  "明天",
  ...(HAS_THISWEEK ? ["本周"] : []),
  "下周后",
  "无日期",
  "已完成"
];

/* ---------- 打开任务视图 ---------- */
plugin.openPanelTab("task");
await settle();

const host = document.querySelector(".caldav-mobile-host");
assert.ok(host, "前置：应能拿到移动端面板宿主");

const groupsOf = () =>
  Array.from(host.querySelectorAll(".cal-task-group-head .cal-task-group-label")).map((e) => e.textContent.trim());
const groupEl = (label) =>
  Array.from(host.querySelectorAll(".cal-task-group")).find(
    (g) => g.querySelector(".cal-task-group-label")?.textContent.trim() === label
  );
const titlesOf = (label) => {
  const g = groupEl(label);
  return g ? Array.from(g.querySelectorAll(".cal-task-title")).map((e) => e.textContent.trim()) : null;
};

/* ---------- 1. 默认筛选「所有未完成」下不该出现已完成组 ---------- */
assert.ok(
  !groupEl("已完成"),
  "默认筛选是「所有未完成」—— 进任务视图先看该做的，已完成不该混进来"
);
assert.deepStrictEqual(
  groupsOf(),
  EXPECTED.filter((x) => x !== "已完成"),
  "默认筛选下分组应为 逾期/今天/明天/本周/下周后/无日期"
);

/* ---------- 2. 切到「所有项目」后才看全七组 ---------- */
const filterSel = host.querySelector(".cal-task-filter");
assert.ok(filterSel, "应有筛选下拉");
filterSel.value = "allitems";
filterSel.dispatchEvent(new window.Event("change", { bubbles: true }));
await settle();

assert.deepStrictEqual(groupsOf(), EXPECTED, `分组顺序应为 ${EXPECTED.join(" / ")}`);

/* ---------- 3. 组内排序 ---------- */
const overdueTitles = titlesOf("逾期");
assert.deepStrictEqual(
  overdueTitles.map((t) => (t.includes("十八天") ? "old" : "new")),
  ["old", "new"],
  "逾期组内：更早到期的应排在前"
);
const todayTitles = titlesOf("今天");
assert.ok(
  todayTitles.findIndex((t) => t.includes("紧急")) < todayTitles.findIndex((t) => t.includes("低优先级")),
  "同日期内：优先级高的（iCal 数字小）应排在前"
);

/* ---------- 4. 已完成组默认折叠，点一下展开 ---------- */
const doneGroup = groupEl("已完成");
assert.ok(doneGroup, "应有「已完成」组");
const doneHead = doneGroup.querySelector(".cal-task-group-head");
assert.strictEqual(doneHead.getAttribute("aria-expanded"), "false", "「已完成」组应默认折叠");
assert.ok(!doneGroup.querySelector(".cal-task-group-body"), "折叠时不应渲染组内容");
assert.ok(doneGroup.querySelector(".cal-task-group-count"), "组头应带计数");

doneHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await settle();
assert.strictEqual(
  groupEl("已完成").querySelector(".cal-task-group-head").getAttribute("aria-expanded"),
  "true",
  "点一下组头应展开（回归：默认值与用户状态混在一个字段 → 点了没反应）"
);
assert.ok(groupEl("已完成").querySelector(".cal-task-group-body"), "展开后应渲染组内容");

/* ---------- 5. 折叠别的组后，「已完成」的展开状态不能被静默判回折叠 ---------- */
const overdueHead = groupEl("逾期").querySelector(".cal-task-group-head");
overdueHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await settle();
assert.strictEqual(
  groupEl("逾期").querySelector(".cal-task-group-head").getAttribute("aria-expanded"),
  "false",
  "「逾期」组应被折叠"
);
assert.strictEqual(
  groupEl("已完成").querySelector(".cal-task-group-head").getAttribute("aria-expanded"),
  "true",
  "折叠别的组后，「已完成」仍应保持用户展开的状态（回归：被静默判成展开/折叠）"
);

/* ---------- 6. 统计条：六项，挂在工具条槽位上 ---------- */
const slot = host.querySelector('[data-slot="task-stats"]');
assert.ok(slot, "工具条里应有统计条挂载点");
assert.strictEqual(slot.querySelectorAll(".cal-task-stat").length, 6, "统计条应为一行六项");
const statLabels = Array.from(slot.querySelectorAll(".cal-task-stat span")).map((e) => e.textContent.trim());
assert.deepStrictEqual(
  statLabels,
  ["待办", "今日", "逾期", "未来", "无日期", "已完成"],
  "统计条六项顺序应为 待办/今日/逾期/未来/无日期/已完成"
);

/* ---------- 7. 日程混入：两级开关 ---------- */
// 重开面板会重建 viewEl，筛选回到默认的「所有未完成」，故每次都要切回「所有项目」
const reopenAll = async () => {
  plugin.openPanelTab("task");
  await settle();
  const sel = host.querySelector(".cal-task-filter");
  assert.ok(sel, "重开后应仍有筛选下拉");
  sel.value = "allitems";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
};

await reopenAll();
assert.ok(
  !Array.from(host.querySelectorAll(".cal-task-title")).some((e) => e.textContent.includes(FUTURE_EVENT)),
  "默认（未开「显示日程事件」）时列表里不应出现日程"
);

store.settings.showEventsInTaskView = true;
await reopenAll();
const titlesWithEvents = Array.from(host.querySelectorAll(".cal-task-title")).map((e) => e.textContent.trim());
assert.ok(titlesWithEvents.some((t) => t.includes(FUTURE_EVENT)), "打开主开关后，未来日程应进入列表");
assert.ok(
  !titlesWithEvents.some((t) => t.includes(PAST_EVENT)),
  "第二层开关未开时，已过期的日程不应进列表"
);
const evTask = Array.from(host.querySelectorAll(".cal-task")).find((e) =>
  e.querySelector(".cal-task-title")?.textContent.includes(FUTURE_EVENT)
);
assert.ok(evTask.classList.contains("is-event"), "日程条目应带 is-event 标记");
assert.ok(evTask.querySelector(".cal-task-check--event"), "日程用圆点标记，不是勾选框");
assert.ok(!evTask.querySelector("[data-toggle]"), "日程没有「完成」语义，不应有勾选按钮");
assert.ok(evTask.querySelector(".cal-task-kind.is-event"), "日程应带「日程」类型角标");

store.settings.showExpiredEventsInTaskView = true;
await reopenAll();
const pastEv = Array.from(host.querySelectorAll(".cal-task")).find((e) =>
  e.querySelector(".cal-task-title")?.textContent.includes(PAST_EVENT)
);
assert.ok(pastEv, "打开第二层开关后，已过期的日程应进列表");
assert.ok(
  pastEv.closest(".cal-task-group")?.querySelector(".cal-task-group-label")?.textContent.trim() === "已完成",
  "过期日程应归入「已完成」组（日程没有「完成」语义，时间过去即结束）"
);

/* ---------- 8. 源码级断言：防止测试照抄的副本与生产代码漂移 ---------- */
// 只取 GROUPS 那一块：filters 数组里也有 key: "today" 之类，全文件匹配会把两者混起来
const gStart = SRC.indexOf("const GROUPS");
assert.ok(gStart > 0, "源码里应能定位到 GROUPS 定义");
const gBlock = SRC.slice(gStart, SRC.indexOf("];", gStart));
const groupKeys = (gBlock.match(/key: "(\w+)"/g) || []).map((s) => s.match(/"(\w+)"/)[1]);
assert.deepStrictEqual(
  groupKeys,
  ["overdue", "today", "tomorrow", "thisweek", "later", "nodate", "done"],
  "view-task.ts 的 GROUPS 顺序变了 —— 本测试的副本必须同步（顺序即轻重缓急）"
);
assert.ok(/const EXPANDED_KEY = "__none__"/.test(SRC), "应保留 EXPANDED_KEY 显式展开标记");
// 剥掉注释后再查：注释里会引用这段历史，直接查字面量会误伤
const noComment = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
assert.ok(
  !/gkey !== "done"/.test(noComment),
  "isCollapsed 里不得再有 gkey !== \"done\" 特判（那是把默认值错当权限限制，会锁死其他分组）"
);

console.log("[task] 任务视图分组回归全部通过（组顺序 / 组内排序 / 折叠三态 / 统计条六项 / 日程两级开关 / 源码防漂移）");
