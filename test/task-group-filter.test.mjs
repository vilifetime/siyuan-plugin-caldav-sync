/**
 * 任务视图「点组头折叠/展开后，日历筛选失效」回归（npm run test:taskgroup）。
 *
 * 症状（雄哥 2026-10-30 反馈）：
 *   日历筛选里只留「Baïkal Test Calendar」（把「Baïkal Calendar」隐藏），
 *   一切正常；但只要点一下分组名（逾期 / 今天 …）折叠或展开，
 *   列表里立刻又冒出已隐藏日历的条目 —— 筛选条件像是被丢掉了。
 *
 * 根因：`renderTaskView()` 每次渲染都在**同一个** `viewEl`（面板里持久的
 * `.caldav-view`）上 `addEventListener` 一对 click / keydown，且从不摘除。
 * 于是渲染 N 次就有 N 组监听，每组闭包各自捕获了**那一次渲染**的 `todos`
 * （当时按 `calendars[].enabled` 过滤出来的快照）。
 *
 * 点组头时 N 组监听依次跑：
 *   · 第 1 组（最老的那次渲染）先执行：用它那份**旧快照**重画列表
 *     → 已隐藏日历的条目回来了（症状所在）；
 *   · 随后各组想再画一次时，`toggleGroup` 里的 `viewEl.contains(head)`
 *     已经不成立了 —— 第 1 组刚把 `.cal-task-list` 的 innerHTML 整段换掉，
 *     事件里拿到的那个 `head` 已被换下 DOM —— 于是**全部提前 return**，
 *     再也没有人用新快照把列表纠正回来。
 *
 * 所以「越老的快照越说了算」，日历筛选（以及任何会触发重渲染的设置）都会被回退。
 *
 * 本测试钉住：折叠/展开组头之后，列表仍只含**当前启用日历**的条目。
 */
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupBrowserDom, loadBuiltPlugin, settle } from "./helpers.mjs";

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

const CAL_A = "http://127.0.0.1:5232/testuser/a/";
const CAL_B = "http://127.0.0.1:5232/testuser/b/";

const p = (n) => (n < 10 ? "0" + n : String(n));
const fmt = (x) => `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
const addD = (base, n) => {
  const x = new Date(base + "T00:00:00");
  x.setDate(x.getDate() + n);
  return fmt(x);
};
const TODAY = fmt(new Date());

const store = plugin.store;
store.settings = {
  syncIntervalMin: 0,
  defaultCalendarUrl: CAL_B,
  accounts: [
    {
      id: "acc-test",
      name: "测试账户",
      enabled: true,
      serverUrl: "http://127.0.0.1:5232/",
      username: "testuser",
      password: "testpass",
      calendarPath: "",
      channel: "direct",
      conflict: "server",
      pastDays: 90,
      futureDays: 370,
      calendars: [
        // 两个日历都先启用 —— 模拟「用户还没去日历筛选里关掉 A」的那一次渲染
        { url: CAL_A, displayName: "A日历", color: "#e05252", enabled: true, supportsEvent: true, supportsTodo: true },
        { url: CAL_B, displayName: "B日历", color: "#3b82f6", enabled: true, supportsEvent: true, supportsTodo: true }
      ]
    }
  ],
  showEventsInTaskView: false,
  showExpiredEventsInTaskView: false
};

let seq = 0;
const put = (cal, summary, due) => {
  const i = ++seq;
  store.put({
    uid: `tk-${i}@test`,
    kind: "todo",
    calendarUrl: cal,
    href: `${cal}tk-${i}.ics`,
    etag: `"v${i}"`,
    summary,
    allDay: false,
    start: `${due}T09:00:00`,
    end: `${due}T18:00:00`,
    status: "NEEDS-ACTION",
    percent: 0,
    dirty: false,
    deleted: false
  });
};
// 两个日历各放「逾期 / 今天 / 明天」三条 —— 保证任何一次渲染都至少有两组，组头一定存在
for (const [cal, tag] of [
  [CAL_A, "甲"],
  [CAL_B, "乙"]
]) {
  put(cal, `${tag}·逾期`, addD(TODAY, -3));
  put(cal, `${tag}·今天`, TODAY);
  put(cal, `${tag}·明天`, addD(TODAY, 1));
}

/* ---------- 第 1 次渲染：两个日历都启用 ---------- */
plugin.openPanelTab("task");
await settle();

const host = document.querySelector(".caldav-mobile-host");
assert.ok(host, "前置：应能拿到移动端面板宿主");

const titles = () => Array.from(host.querySelectorAll(".cal-task-title")).map((e) => e.textContent.trim());
const calNames = () =>
  Array.from(host.querySelectorAll(".cal-task-cal")).map((e) => e.textContent.trim());
const groupHead = (label) =>
  Array.from(host.querySelectorAll(".cal-task-group-head")).find(
    (h) => h.querySelector(".cal-task-group-label")?.textContent.trim() === label
  );

assert.ok(titles().some((t) => t.includes("甲")), "前置：两个日历都启用时，A 日历的条目应可见");
assert.ok(titles().some((t) => t.includes("乙")), "前置：两个日历都启用时，B 日历的条目应可见");

/* ---------- 第 2 次渲染：在「日历筛选」里关掉 A 日历 ---------- */
store.settings.accounts[0].calendars[0].enabled = false;
store.saveSettings();
await settle();

assert.ok(
  !titles().some((t) => t.includes("甲")),
  "关掉 A 日历后，列表里不该再有 A 日历的条目"
);
assert.ok(
  calNames().every((n) => n === "B日历"),
  `关掉 A 日历后，条目应全部标着 B日历，实际：${calNames().join("/")}`
);

/* ---------- 点「逾期」组头折叠，再点开 —— 筛选必须还在 ---------- */
const head = groupHead("逾期");
assert.ok(head, "前置：应能找到「逾期」组头");
head.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await settle();

assert.ok(
  !titles().some((t) => t.includes("甲")),
  "【回归】折叠「逾期」组后，不该把已隐藏的 A 日历条目带回来"
);
assert.ok(
  calNames().every((n) => n === "B日历"),
  `【回归】折叠「逾期」组后，条目应仍全部标着 B日历，实际：${calNames().join("/")}`
);

const head2 = groupHead("逾期");
assert.ok(head2, "折叠后组头仍应可点（用于展开）");
head2.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await settle();

assert.ok(
  !titles().some((t) => t.includes("甲")),
  "【回归】重新展开「逾期」组后，不该把已隐藏的 A 日历条目带回来"
);
assert.ok(
  calNames().every((n) => n === "B日历"),
  `【回归】重新展开「逾期」组后，条目应仍全部标着 B日历，实际：${calNames().join("/")}`
);

console.log("task-group-filter: 全部断言通过（组头折叠/展开不再回退日历筛选）");
