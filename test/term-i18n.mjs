/**
 * 术语约定回归锁（2026-11-08 雄哥二次拍板）。
 *
 *  思源 / Obsidian **两端统一**：日程 = Event、待办 = To-do
 *
 *  中途曾定过「思源 Schedule/To-do、Obsidian Event/Task，各用一套」，
 *  雄哥随后改主意，要求不管哪一端全部统一成 Event 和 To-do。
 *  本测试锁死这个最终约定，防止再退回两套叫法。
 *
 * 边界（两端一致，不算混用）：
 *   ① 中文原文就叫「任务」的功能名 —— 任务视图 / 任务块 / 任务设置 /
 *      搜索任务 / 日历与任务 —— 保留 Task，它不是「待办」实体名；
 *   ② 「已排程 / 提醒排程」里的 Scheduled / Schedule 表示「排程」，
 *      也不是日程实体名。这两类按 key 精确豁免。
 *
 * 顺带锁住上一轮修好的一批机翻粘连（SyncthisTaskto CalDAV、
 * This time period insideNoScheduleorTo-do 等），别让它复活。
 *
 * 用法：node test/term-i18n.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const en = JSON.parse(read("src/i18n/en_US.json"));
const zh = JSON.parse(read("src/i18n/zh_CN.json"));

let pass = 0;
const check = (name, fn) => {
  fn();
  pass++;
  console.log(`  [OK] ${name}`);
};

// 只扫 value；key 是中文原文（含「事件」「待办」），不算污染。
// `\btodos?\b` 不会误伤 `To-do` / `to-dos`（连字符把词断开了）。
const FORBIDDEN = /\b(schedules?|todos?)\b/i;
const ALLOWED_KEYS = new Set(["已排程", "提醒排程"]);
const dirty = (dict) => Object.entries(dict)
  .filter(([k, v]) => !ALLOWED_KEYS.has(k) && typeof v === "string" && FORBIDDEN.test(v))
  .map(([k, v]) => `${k} = ${v}`);

const ANCHORS = {
  "日程": "Event",
  "待办": "To-do",
  "新建日程": "New Event",
  "新建待办": "New To-do",
  "编辑{0}": "Edit {0}",
  "事件标题": "Event Title",
  "新增事件": "Add Event",
  "请输入事件标题": "Please enter the event title",
  "{0} 转日程": "{0} To Event",
  "{0} 转待办": "{0} To To-do",
  "日程与待办": "Events & To-dos",
  "今天的日程与待办": "Today's Events & To-dos",
  "没有日程或待办": "No event or to-do",
  "该时间段内暂无日程或待办": "No events or to-dos in this period",
  "任务视图中显示日程事件": "Show events in Task View",
  "任务视图中显示过期日程": "Show expired events in Task View",
  "要把哪个范围的日程与待办写入日记？": "Which range of events and to-dos should be written into the daily note?",
  "日程设置": "Event Settings",
  "待办提醒时间": "To-do reminder time",
  "待办在日历单元格的显示位置": "To-do position in calendar cells",
};

const GLUED = {
  "把日程与待办插入日记": "Insert Events & To-dos into Daily Note",
  "insertToday": "Insert Events & To-dos into Daily Note",
  "日历视图中显示待办任务": "Show to-dos in Calendar View",
  "取消同步（删除对应的 CalDAV 待办）": "Cancel sync (delete the corresponding CalDAV to-do)",
  "同步此任务到 CalDAV": "Sync this task to CalDAV",
  "打开日历与任务": "Open Calendar with Tasks",
  "扫描任务块（全部）": "Scan Task Blocks (All)",
  "扫描任务块（当前文档）": "Scan Task Blocks (Current Document)",
  "已扫描全部文档的任务块": "Scanned task blocks in all documents",
  "已扫描当前文档的任务块": "Scanned task blocks in the current document",
  "文档任务块同步：": "Document task-block sync:",
};
const GLUE_MARKS = /insideNoSchedule|Viewshown|putSchedule|SyncthisTask|CancelSync \(Delete|OpenCalendarwith|ScanTask Block|AlreadyScan|Documenttask/;

const termClean = (dict) => dirty(dict).length === 0;
const anchorsOk = (dict) => Object.entries(ANCHORS).every(([k, v]) => dict[k] === v);
const glueClean = (dict) =>
  Object.entries(GLUED).every(([k, v]) => dict[k] === v) &&
  !GLUE_MARKS.test(JSON.stringify(dict));

// 两端一致性：同一实体在两端必须逐字相同（思源转换按钮带 {0} 图标占位符）。
const CROSS_PAIRS = [
  ["日程", "addmenu.event", "Event"],
  ["待办", "addmenu.todo", "To-do"],
  ["新建日程", "editor.newEvent", "New Event"],
  ["新建待办", "editor.newTodo", "New To-do"],
  ["该时间段内暂无日程或待办", "list.empty", "No events or to-dos in this period"],
];
const crossOk = (sy, ob) => {
  for (const [sk, ok, expect] of CROSS_PAIRS) {
    if (sy[sk] !== expect || ob[ok] !== expect) return false;
  }
  return sy["{0} 转日程"].replace("{0} ", "") === ob["editor.convertToEvent"] &&
         sy["{0} 转待办"].replace("{0} ", "") === ob["editor.convertToTodo"];
};

console.log("\n① 思源英文字典：Event / To-do，零 Schedule / 零裸 Todo");
check(`en_US ${Object.keys(en).length} 条 value 里没有 Schedule / Todo（排程类除外）`, () => {
  assert.deepEqual(dirty(en), [], "英文界面仍有旧术语：\n  " + dirty(en).join("\n  "));
});
check(`${Object.keys(ANCHORS).length} 条术语锚点逐条命中 Event / To-do`, () => {
  for (const [k, v] of Object.entries(ANCHORS)) {
    assert.equal(en[k], v, `${JSON.stringify(k)} 应为 ${JSON.stringify(v)}，实为 ${JSON.stringify(en[k])}`);
  }
});
check("zh_CN / en_US key 集合仍一致、中文端未被动过", () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.equal(zh["日程"], "日程");
  assert.equal(zh["待办"], "待办");
});
check("排程类词保留：已排程 / 提醒排程", () => {
  assert.equal(en["已排程"], "Scheduled");
  assert.equal(en["提醒排程"], "Reminder Schedule");
});

console.log("\n② 机翻粘连：上一轮修好的几条不许回退");
check(`${Object.keys(GLUED).length} 条粘连译文逐条命中`, () => {
  for (const [k, v] of Object.entries(GLUED)) {
    assert.equal(en[k], v, `${JSON.stringify(k)} 仍是粘连机翻：${JSON.stringify(en[k])}`);
  }
  assert.equal(glueClean(en), true);
});

console.log("\n③ 两端统一：思源 ≡ Obsidian（对端仓库存在时才比对）");
const obPath = path.resolve(ROOT, "../ObsidianCaldav/src/i18n/en_US.json");
const obDict = fs.existsSync(obPath) ? JSON.parse(fs.readFileSync(obPath, "utf8")) : null;
check("5 组实体名 + 2 个转换按钮，两端逐字一致", () => {
  if (!obDict) {
    console.log("    (对端仓库不在同机，跳过跨端比对)");
    return;
  }
  assert.equal(crossOk(en, obDict), true);
});

console.log("\n④ 判据自测：改回旧写法必须判红（防假绿）");
check("把「日程」译回 Schedule → 禁词与锚点判据都应失败", () => {
  const bad = { ...en, "日程": "Schedule" };
  assert.equal(termClean(bad), false);
  assert.equal(anchorsOk(bad), false);
});
check("把「待办」译回 Task → 锚点判据必须失败", () => {
  assert.equal(anchorsOk({ ...en, "待办": "Task" }), false);
});
check("恢复一条裸 Todo → 禁词判据必须失败", () => {
  assert.equal(termClean({ ...en, "待办提醒时间": "Todo reminder time" }), false);
});
check("恢复一条粘连机翻 → 粘连判据必须失败", () => {
  assert.equal(glueClean({ ...en, "同步此任务到 CalDAV": "SyncthisTaskto CalDAV" }), false);
});
check("删掉一条术语键 → 锚点判据必须失败", () => {
  const bad = { ...en };
  delete bad["新建日程"];
  assert.equal(anchorsOk(bad), false);
});
check("把对端「待办」改回 Task → 跨端一致性判据必须失败", () => {
  if (!obDict) {
    console.log("    (对端仓库不在同机，跳过)");
    return;
  }
  assert.equal(crossOk(en, { ...obDict, "addmenu.todo": "Task" }), false);
  assert.equal(crossOk(en, { ...obDict, "editor.newTodo": "New task" }), false);
});

console.log(`\n[term-i18n] ${pass} 项全部通过\n`);
