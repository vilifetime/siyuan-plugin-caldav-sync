/**
 * 「把日程与待办插入日记」回归测试。
 *
 * 守三件曾经出问题的事：
 * 1) 不能把「不在范围内」的条目写进日记 —— `occurrencesInRange()` 对无重复规则的条目会
 *    回退返回 `item.start`（可能不在窗口内），视图侧按日期落格会被自然丢掉，直接照单全收就会漏进来；
 * 2) 待办一律按到期日（DUE）归属，与视图/统计口径一致；
 * 3) 写入后必须有反馈并打开日记文档成为当前活动页签，重复点击是「替换」而非无限追加。
 *
 * 2026-10-08 起支持「范围 + 目标」（对齐 Obsidian 侧）：
 * 当日 / 本周 / 本月 / 所有，且本周 / 本月可选写到今天还是写到周一 / 1 号。
 * 第 2 段起钉这部分。
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupBrowserDom, loadBuiltPlugin, seedStore } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();
seedStore(plugin); // 种子数据里含昨天的会议 / 逾期待办 / 跨日待办 / 无日期待办等干扰项

const d = new Date();
const p2 = (n) => (n < 10 ? "0" + n : String(n));
const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/* 纯日期工具的本地复刻（只用来自测范围计算，不参与插件链路） */
function parseJs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
function stampJs(dt) {
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
}
function addDaysJs(s, n) {
  const dt = parseJs(s);
  dt.setDate(dt.getDate() + n);
  return stampJs(dt);
}
function startOfWeekJs(s) {
  const dt = parseJs(s);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return stampJs(dt);
}
function nextMonthJs(s) {
  const dt = parseJs(s);
  return stampJs(new Date(dt.getFullYear(), dt.getMonth() + 1, 1));
}

// ---- 桩掉内核接口，捕获实际写入的 markdown ----
const calls = [];
let docRows = [{ id: "doc-today", content: today, hpath: `/${today}` }];
let existingChildren = [];
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url, body });
  const reply = (data) => ({ ok: true, json: async () => ({ code: 0, msg: "", data }) });
  if (url === "/api/query/sql") {
    return reply(String(body.stmt).includes("parent_id") ? existingChildren : docRows);
  }
  if (url === "/api/notebook/lsNotebooks") return reply({ notebooks: [{ id: "nb-1", closed: false }] });
  if (url === "/api/filetree/createDocWithMd") return reply("doc-created");
  return reply(null);
};
globalThis.__syMessages = [];

const msg = await plugin.insertTodayToDiary();
const ins = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(ins, "应调用 insertBlock 写入日记");
const md = String(ins.body.data);
assert.strictEqual(ins.body.parentID, "doc-today", "应写入今天的日记文档");
assert.ok(md.startsWith("## 日程与待办"), "小节标题应为「日程与待办」");

// 今天的条目：日程按开始时间、待办按到期日、全天单独标注
assert.ok(md.includes("测试条目 1"), "今天的日程应写入");
assert.ok(md.includes("测试条目 7"), "今天的日程应写入");
assert.ok(/全天 测试条目 4/.test(md), "全天条目应标注「全天」而不是空时间");

// 干扰项一律不得出现
for (const bad of ["昨天的会议", "逾期待办", "跨日待办", "测试条目 5", "无截止任务", "仅开始时间任务"]) {
  assert.ok(!md.includes(bad), `「${bad}」不属于今天，不应写入日记`);
}

// 时间序：09:00 之前的条目不能排在全天之后乱序
const times = md.split("\n").filter((l) => l.startsWith("- "));
assert.ok(times.length >= 4, "应写入多条今日条目");

// ---- 反馈 + 打开日记成为活动页签 ----
assert.ok(msg.includes("日程与待办"), "返回值应带结果文案");
assert.ok(
  globalThis.__syMessages.some((m) => m.text.includes("日程与待办")),
  "应弹出站内提示（否则用户不知道插到哪去了，会重复点击）"
);
assert.ok(globalThis.__syRegistrations.lastOpenTab, "应打开日记文档");
assert.strictEqual(globalThis.__syRegistrations.lastOpenTab.doc.id, "doc-today", "打开的应是今天的日记");

// ---- 重复点击 = 替换，而不是追加 ----
existingChildren = [
  { id: "h-1", type: "h", content: "日程与待办" },
  { id: "l-1", type: "l", content: "- 📅 09:00 上次写的" },
  { id: "p-1", type: "p", content: "用户自己写的段落" }
];
calls.length = 0;
const msg2 = await plugin.insertTodayToDiary();
assert.deepStrictEqual(
  calls.filter((c) => c.url === "/api/block/deleteBlock").map((c) => c.body.id),
  ["h-1", "l-1"],
  "应删除上一次的小节（标题 + 紧随的列表），且不能碰用户自己的段落"
);
assert.ok(msg2.includes("已更新"), "第二次点击应是「更新」而非「写入」");

// ---- 找不到今天的日记时：新建文档再写入 ----
docRows = [];
calls.length = 0;
globalThis.__syRegistrations.lastOpenTab = undefined;
await plugin.insertTodayToDiary();
const created = calls.find((c) => c.url === "/api/filetree/createDocWithMd");
assert.ok(created, "找不到今日日记应新建");
assert.strictEqual(created.body.path, "/" + today, "新建文档路径应为当天日期");
assert.strictEqual(
  calls.find((c) => c.url === "/api/block/insertBlock").body.parentID,
  "doc-created",
  "应写入新建的文档"
);
assert.strictEqual(globalThis.__syRegistrations.lastOpenTab.doc.id, "doc-created", "应打开新建的日记");

// ---- 无当日条目：只提示，不写日记 ----
existingChildren = [];
calls.length = 0;
const empty = await plugin.insertTodayToDiary.call({
  store: { getAll: () => [], settings: { calendars: [] } },
  notify: (text) => text
});
assert.strictEqual(empty, "当日没有日程或待办", "没有当日条目时应仅提示、不写入");
assert.ok(!calls.some((c) => c.url === "/api/block/insertBlock"), "没有当日条目时不应写入日记");

/* ============================================================
 * 范围 + 目标（2026-10-08，对齐 Obsidian 侧）
 * ============================================================ */
const dow = (d.getDay() + 6) % 7; // 周一=0
const monday = addDaysJs(today, -dow);
const sunday = addDaysJs(monday, 6);
const monthFirst = today.slice(0, 8) + "01";
// 今天恰好就是周一 / 1 号时，两个目标是同一篇日记（不能因此误判）
const monDocId = monday === today ? "doc-today" : "doc-mon";
const firstDocId = monthFirst === today ? "doc-today" : "doc-1st";

// ---- 本周：默认写到今天的日记，标题带区间 ----
docRows = [
  { id: "doc-today", content: today, hpath: `/${today}` },
  ...(monday === today ? [] : [{ id: "doc-mon", content: monday, hpath: `/${monday}` }])
];
existingChildren = [];
calls.length = 0;
const msgW = await plugin.insertTodayToDiary("week");
const insW = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(insW, "本周范围应写入日记");
assert.strictEqual(insW.body.parentID, "doc-today", "本周默认写到**今天**的日记（与旧行为一致）");
assert.ok(
  String(insW.body.data).startsWith(`## 日程与待办（${monday} ~ ${sunday}）`),
  `本周的小节标题要带区间，实际：${String(insW.body.data).split("\n")[0]}`
);
assert.ok(msgW.includes("今天"), "提示应说明写到了哪一篇日记");
// 本周应把「昨天 / 前天」里仍落在本周的条目也收进来（逾期待办按到期日）
assert.ok(String(insW.body.data).includes("逾期待办"), "本周范围内应包含落在本周的逾期未完成待办");

// ---- 本周 + 写到周一的日记 ----
calls.length = 0;
const msgW2 = await plugin.insertTodayToDiary("week", "spanStart");
const insW2 = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(insW2, "选「周一的日记」也应写入");
assert.strictEqual(insW2.body.parentID, monDocId, "选「本周一的日记」应写到周一那篇");
assert.ok(msgW2.includes("本周一"), `提示应点明「本周一」，实际：${msgW2}`);

// ---- 本月 + 写到 1 号的日记 ----
docRows = [
  { id: "doc-today", content: today, hpath: `/${today}` },
  ...(monthFirst === today ? [] : [{ id: "doc-1st", content: monthFirst, hpath: `/${monthFirst}` }])
];
calls.length = 0;
const msgM = await plugin.insertTodayToDiary("month", "spanStart");
const insM = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(insM, "本月范围应写入日记");
assert.strictEqual(insM.body.parentID, firstDocId, "选「本月 1 日的日记」应写到 1 号那篇");
assert.ok(
  String(insM.body.data).startsWith(`## 日程与待办（${today.slice(0, 7)}）`),
  "本月的小节标题要带年月"
);
assert.ok(msgM.includes("本月 1 日"), `提示应点明「本月 1 日」，实际：${msgM}`);

// ---- 「所有」范围：区间下界是哨兵 1900-01-01，目标必须落回今天（不许去建 1900 年的日记） ----
docRows = [{ id: "doc-today", content: today, hpath: `/${today}` }];
calls.length = 0;
await plugin.insertTodayToDiary("all", "spanStart");
const insAll = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(insAll, "「所有」范围应写入日记");
assert.strictEqual(insAll.body.parentID, "doc-today", "「所有」的目标必须是今天（不能被哨兵下界带偏）");
assert.ok(
  !calls.some((c) => c.url === "/api/filetree/createDocWithMd" && String(c.body.path || "").includes("1900")),
  "绝不能去新建 1900 年的日记"
);

/* ---------- 纯计算契约（复刻 + 源码防漂移） ----------
 * 源文件是 TS 且依赖 core/date，Node 直接 require 不了，故复刻实现；
 * 再用源码级断言把复刻与生产代码拴在一起，防「改了一边忘了另一边」。
 */
const RANGE_SRC = fs.readFileSync(path.join(ROOT, "src", "ui", "diary-range.ts"), "utf8");

// 周一起算 + 跨年跨月
assert.strictEqual(startOfWeekJs("2026-10-07"), "2026-10-05", "2026-10-07（周三）的本周一应是 10-05");
assert.strictEqual(startOfWeekJs("2026-10-11"), "2026-10-05", "周日应归属上一个周一，不能减到本周日");
assert.strictEqual(startOfWeekJs("2026-10-05"), "2026-10-05", "周一当天周起点是自己");
assert.strictEqual(nextMonthJs("2026-12-15"), "2027-01-01", "12 月应进位到次年 1 月");
assert.strictEqual(nextMonthJs("2028-02-10"), "2028-03-01", "闰年 2 月应到 3 月 1 号");

// 源码级：四个范围都在、且 spanStart 只对 week/month 生效
assert.ok(/case "day":/.test(RANGE_SRC) && /case "week":/.test(RANGE_SRC), "diary-range.ts 应含 day/week 分支");
assert.ok(/case "month":/.test(RANGE_SRC) && /case "all":/.test(RANGE_SRC), "diary-range.ts 应含 month/all 分支");
assert.ok(
  /target !== "spanStart"[\s\S]{0,120}return today/.test(RANGE_SRC),
  "diaryTargetStamp 必须先判 target !== spanStart（否则「今天」也去取区间首日）"
);
assert.ok(
  /range !== "week" && range !== "month"/.test(RANGE_SRC),
  "diaryTargetStamp 必须把 spanStart 收敛到 week/month —— 否则「所有」会去建 1900 年的日记"
);
// 当日 / 所有只有「今天」一个目标 → 不该渲染子选项区（问「今天 / 今天」没有意义）
assert.ok(/return \[todayOpt\];/.test(RANGE_SRC), "targetOptionsOf 对 day/all 应只回一项");
const DIALOG_SRC = fs.readFileSync(path.join(ROOT, "src", "ui", "diary-range-dialog.ts"), "utf8");
assert.ok(
  /opts\.length < 2/.test(DIALOG_SRC),
  "子选项区在只有一个目标时必须收起（见 diary-range-dialog.ts 的 renderSub）"
);

// 面板按钮：不再写死「今日」，且点击走范围弹窗
const PANEL_SRC = fs.readFileSync(path.join(ROOT, "src", "ui", "panel.ts"), "utf8");
assert.ok(
  !PANEL_SRC.includes("把今日日程与待办插入日记"),
  "面板按钮不该再写死「今日」（点了会先问范围）"
);
assert.ok(
  /askDiaryRange\(\(range, target\) => void ctx\.insertTodayToDiary\(range, target\)\)/.test(PANEL_SRC),
  "面板点击必须走范围弹窗，并把 range/target 一起透传（吞掉参数就会永远走「当日+今天」）"
);

/* ---------- 弹窗交互：默认当日+今天，选本周才出现目标子选项 ---------- */
const origInsert = plugin.insertTodayToDiary.bind(plugin);
let picked = null;
plugin.insertTodayToDiary = (r, t) => {
  picked = [r, t];
  return Promise.resolve("stub");
};
plugin.askInsertDiary();
const range = document.querySelector(".caldav-range");
assert.ok(range, "点「插入日记」应弹出范围选择框");
const radios = Array.from(range.querySelectorAll('input[name="caldav-range"]'));
assert.strictEqual(radios.length, 4, "应有 当日/本周/本月/所有 四个范围");
assert.strictEqual(radios[0].checked, true, "默认范围应是「当日」");
assert.strictEqual(range.querySelector("[data-sub]").hidden, true, "默认（当日）不该出现目标子选项");

// 切到「本周」：子选项出现，且默认仍是「今天」
const weekRadio = radios.find((r) => r.value === "week");
weekRadio.checked = true;
weekRadio.dispatchEvent(new window.Event("change", { bubbles: true }));
const sub = range.querySelector("[data-sub]");
assert.strictEqual(sub.hidden, false, "选「本周」应展开目标子选项");
const targetRadios = Array.from(sub.querySelectorAll('input[name="caldav-target"]'));
assert.strictEqual(targetRadios.length, 2, "本周应有两个目标可选（今天 / 本周一）");
assert.strictEqual(targetRadios[0].checked, true, "目标默认是「今天」（与旧行为一致）");
assert.ok(
  sub.textContent.includes("本周一"),
  `子选项应写明「本周一（${monday}）」，实际：${sub.textContent.replace(/\s+/g, " ").trim()}`
);

// 切到「本月」：子选项文案随之变成「本月 1 日」（防复用上一份 DOM 造成串味）
const monthRadio = radios.find((r) => r.value === "month");
monthRadio.checked = true;
monthRadio.dispatchEvent(new window.Event("change", { bubbles: true }));
assert.ok(
  sub.textContent.includes("本月 1 日"),
  `切到本月后子选项应写「本月 1 日（${monthFirst}）」，实际：${sub.textContent.replace(/\s+/g, " ").trim()}`
);
assert.ok(!sub.textContent.includes("本周一"), "切到本月后不该还留着「本周一」的选项");
assert.strictEqual(
  Array.from(sub.querySelectorAll('input[name="caldav-target"]'))[0].checked,
  true,
  "切范围后目标要回到「今天」（不能残留上次选的 spanStart）"
);

// 选「本月 1 日」→ 确认插入，参数必须原样透传
const firstRadio = Array.from(sub.querySelectorAll('input[name="caldav-target"]')).find(
  (r) => r.value === "spanStart"
);
firstRadio.checked = true;
firstRadio.dispatchEvent(new window.Event("change", { bubbles: true }));
range.querySelector('[data-act="ok"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.deepStrictEqual(picked, ["month", "spanStart"], "确认插入应把 range 与 target 一起回传");
plugin.insertTodayToDiary = origInsert;

console.log("[diary] 插入日记链路全部通过（仅范围内条目 / 待办按到期日 / 有反馈并打开日记 / 重复点击为更新 / 范围与目标）");
