/**
 * 任务块 ⇄ VTODO **四态**映射单测（`npm run test:taskstate`）。
 *
 * 【背景】思源任务块有四种状态（待办 / 进行中 / 完成 / 放弃），
 *   RFC 5545 的 VTODO 也恰好有四个 STATVALUE-TODO
 *   （NEEDS-ACTION / IN-PROCESS / COMPLETED / CANCELLED），两者应当完全对应。
 *
 *   思源侧的状态**存在 markdown 第一行方括号里的那个字符**（marker），这是从
 *   思源内核源码读出来的确定结论（app/src/protyle/wysiwyg/taskStatusDialog.ts
 *   与 taskListMarker.ts），不是猜的：
 *     待办 `" "` → `- [ ]`    进行中 `"/"` → `- [/]`
 *     完成 `"X"` → `- [X]`    放弃 `"-"` → `- [-]`
 *
 * 【本套件钉住的】
 *   ① marker ⇄ 四态 ⇄ VTODO STATUS/PERCENT 的映射
 *   ② 回写块时的 marker 改写（只动一个字符，子块不动）
 *   ③ ⭐ 单向保险：服务端**只能把块往前推**，绝不把块往回拽
 *      （2026-10-30 用户实测踩中过一次：60 个已勾选的任务块被批量取消）
 *   ④ 对账层四态动作（create / push / writeback）
 *   ⑤ ICS 往返（写进去再读回来，四态不失真）
 *
 * 运行前用 tsc 把相关 core 文件编到 .test-taskstate（与 blocksync 同一套路）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-taskstate");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/task-state.ts ` +
    `src/core/block-todo.ts src/core/block-api.ts ` +
    `--outDir .test-taskstate --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const ts = require(path.join(outDir, "task-state.js"));
const bt = require(path.join(outDir, "block-todo.js"));
const bapi = require(path.join(outDir, "block-api.js"));
const ics = require(path.join(outDir, "ics.js"));
const T = require(path.join(outDir, "types.js"));

let pass = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log("  ✓ " + name);
  } catch (e) {
    console.log("  ✗ " + name + "\n    " + (e && e.message));
    process.exitCode = 1;
  }
};

const CAL = "http://127.0.0.1:5232/cal/todo/";
const baseSettings = (over = {}) => ({
  ...T.DEFAULT_SETTINGS,
  blockSyncEnabled: true,
  blockSyncMarks: ["badge", "prefix"],
  blockSyncPrefix: "[文档]",
  ...over
});
const item = (over = {}) => ({
  uid: "u-" + Math.random().toString(36).slice(2),
  kind: "todo",
  calendarUrl: CAL,
  href: CAL + "a.ics",
  summary: "[文档]买牛奶",
  allDay: false,
  start: "2026-10-28T09:00:00",
  status: "NEEDS-ACTION",
  percent: 0,
  ...over
});
/** 造一个任务块（state 显式给；marker 可给自定义值） */
const block = (id, text, state = "todo", marker) => ({
  id,
  text,
  state,
  checked: state === "done",
  marker: marker ?? (state === "done" ? "X" : state === "in-progress" ? "/" : state === "canceled" ? "-" : " "),
  markdown: `- [${marker ?? (state === "done" ? "X" : state === "in-progress" ? "/" : state === "canceled" ? "-" : " ")}] ${text}`
});
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

console.log("[taskstate] ① 思源 marker ⇄ 四态");

check("待办 `- [ ]` → todo", () => {
  assert.strictEqual(ts.taskStateOfMarkdown("- [ ] 待办1").state, "todo");
});
check("进行中 `- [/]` → in-progress", () => {
  assert.strictEqual(ts.taskStateOfMarkdown("- [/] 进行中").state, "in-progress");
});
check("完成 `- [X]` → done", () => {
  assert.strictEqual(ts.taskStateOfMarkdown("- [X] 完成").state, "done");
});
check("完成的小写 `- [x]` 也算 done（大小写不敏感）", () => {
  assert.strictEqual(ts.taskStateOfMarkdown("- [x] 完成").state, "done");
});
check("放弃 `- [-]` → canceled", () => {
  assert.strictEqual(ts.taskStateOfMarkdown("- [-] 放弃").state, "canceled");
});
check("自定义任务状态 `- [!]` → 保守归为 todo", () => {
  assert.strictEqual(ts.taskStateOfMarkdown("- [!] 自定义").state, "todo");
});
check("缩进的任务块照样认得", () => {
  assert.strictEqual(ts.taskStateOfMarkdown("\t- [X] 缩进的完成").state, "done");
});
check("子块不影响父块的状态判定（只看第一行）", () => {
  const md = "- [ ] 父任务\n  - [X] 子任务";
  assert.strictEqual(ts.taskStateOfMarkdown(md).state, "todo");
});
check("不是任务行 → todo", () => {
  assert.strictEqual(ts.taskStateOfMarkdown("普通段落 [文字]").state, "todo");
});
check("旧的二态接口 blockCheckedOf 仍然只认「完成」", () => {
  assert.strictEqual(bt.blockCheckedOf("- [X] 完成"), true);
  assert.strictEqual(bt.blockCheckedOf("- [/] 进行中"), false);
  assert.strictEqual(bt.blockCheckedOf("- [-] 放弃"), false);
  assert.strictEqual(bt.blockCheckedOf("- [ ] 待办"), false);
});

console.log("[taskstate] ② 状态 → VTODO STATUS/PERCENT");

check("四态 → STATUS/PERCENT-COMPLETE", () => {
  assert.deepStrictEqual(ts.statusFields("todo"), { status: "NEEDS-ACTION", percent: 0 });
  assert.deepStrictEqual(ts.statusFields("in-progress"), { status: "IN-PROCESS", percent: 0 });
  assert.deepStrictEqual(ts.statusFields("done"), { status: "COMPLETED", percent: 100 });
  assert.deepStrictEqual(ts.statusFields("canceled"), { status: "CANCELLED", percent: 0 });
});
check("STATUS → 状态（服务端读回）", () => {
  assert.strictEqual(ts.stateOfStatus("NEEDS-ACTION"), "todo");
  assert.strictEqual(ts.stateOfStatus("IN-PROCESS"), "in-progress");
  assert.strictEqual(ts.stateOfStatus("COMPLETED"), "done");
  assert.strictEqual(ts.stateOfStatus("CANCELLED"), "canceled");
  assert.strictEqual(ts.stateOfStatus("cancelled"), "canceled", "大小写不敏感");
});
check("服务端给非法 STATUS → 按 NEEDS-ACTION 兜底", () => {
  assert.strictEqual(ts.stateOfStatus("CONFIRMED"), "todo");
  assert.strictEqual(ts.stateOfStatus(undefined, 100), "done", "只写 PERCENT-COMPLETE:100 也算完成（旧口径兼容）");
});
check("归一：非法值绝不原样写回服务端", () => {
  assert.strictEqual(ts.normalizeTodoStatus("CONFIRMED"), "NEEDS-ACTION");
  assert.strictEqual(ts.normalizeTodoStatus("IN-PROCESS"), "IN-PROCESS");
  assert.strictEqual(ts.normalizeTodoStatus("CANCELLED"), "CANCELLED");
});

console.log("[taskstate] ③ 回写块：只动方括号里那一个字符");

check("写回完成：`- [ ]` → `- [X]`", () => {
  assert.strictEqual(ts.withMarkerMarkdown("- [ ] 买牛奶", "X"), "- [X] 买牛奶");
});
check("写回进行中：`- [ ]` → `- [/]`", () => {
  assert.strictEqual(ts.withMarkerMarkdown("- [ ] 买牛奶", "/"), "- [/] 买牛奶");
});
check("写回放弃：`- [ ]` → `- [-]`", () => {
  assert.strictEqual(ts.withMarkerMarkdown("- [ ] 买牛奶", "-"), "- [-] 买牛奶");
});
check("写回待办：`- [X]` → `- [ ]`", () => {
  assert.strictEqual(ts.withMarkerMarkdown("- [X] 买牛奶", " "), "- [ ] 买牛奶");
});
check("子块原样带回（只改第一行）", () => {
  const md = "- [ ] 父任务\n  - [X] 子任务";
  assert.strictEqual(ts.withMarkerMarkdown(md, "X"), "- [X] 父任务\n  - [X] 子任务");
});
check("不是任务行 → 拒绝改写（返回 null，防毁数据）", () => {
  assert.strictEqual(ts.withMarkerMarkdown("普通段落", "X"), null);
});
check("block-api 的 withStateMarkdown 按四态写回", () => {
  assert.strictEqual(bapi.withStateMarkdown("- [ ] 买牛奶", "in-progress"), "- [/] 买牛奶");
  assert.strictEqual(bapi.withStateMarkdown("- [ ] 买牛奶", "canceled"), "- [-] 买牛奶");
});

console.log("[taskstate] ④ ⭐ 单向保险：服务端只能把块往前推");

check("服务端「完成」→ 可以推进（任何块状态）", () => {
  assert.strictEqual(ts.mergeServerState("todo", "done"), "done");
  assert.strictEqual(ts.mergeServerState("in-progress", "done"), "done");
  assert.strictEqual(ts.mergeServerState("canceled", "done"), "done");
});
check("服务端「进行中」→ 只推进待办", () => {
  assert.strictEqual(ts.mergeServerState("todo", "in-progress"), "in-progress");
});
check("服务端「放弃」→ 推进待办与进行中", () => {
  assert.strictEqual(ts.mergeServerState("todo", "canceled"), "canceled");
  assert.strictEqual(ts.mergeServerState("in-progress", "canceled"), "canceled");
});
check("⛔ 服务端「待办」→ 永不覆盖块（2026-10-30 事故的根因）", () => {
  assert.strictEqual(ts.mergeServerState("done", "todo"), "done");
  assert.strictEqual(ts.mergeServerState("in-progress", "todo"), "in-progress");
  assert.strictEqual(ts.mergeServerState("canceled", "todo"), "canceled");
});
check("⛔ 服务端「进行中/放弃」→ 不撤销已完成的块", () => {
  assert.strictEqual(ts.mergeServerState("done", "in-progress"), "done");
  assert.strictEqual(ts.mergeServerState("done", "canceled"), "done");
});
check("⛔ 服务端「待办」→ 不撤销已放弃的块", () => {
  assert.strictEqual(ts.mergeServerState("canceled", "todo"), "canceled");
});
check("canWriteState 与 mergeServerState 同口径（函数级保险）", () => {
  assert.strictEqual(ts.canWriteState("todo", "done"), true);
  assert.strictEqual(ts.canWriteState("todo", "in-progress"), true);
  assert.strictEqual(ts.canWriteState("todo", "canceled"), true);
  assert.strictEqual(ts.canWriteState("done", "todo"), false);
  assert.strictEqual(ts.canWriteState("done", "in-progress"), false);
  assert.strictEqual(ts.canWriteState("done", "canceled"), false);
  assert.strictEqual(ts.canWriteState("canceled", "todo"), false);
});

console.log("[taskstate] ⑤ 对账层四态动作");

check("块进行中 → creates 带 in-progress", () => {
  const plan = bt.planBlockSync([block("b1", "买牛奶", "in-progress")], [], baseSettings());
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.creates[0].state, "in-progress");
});
check("块放弃 → creates 带 canceled", () => {
  const plan = bt.planBlockSync([block("b1", "买牛奶", "canceled")], [], baseSettings());
  assert.strictEqual(plan.creates[0].state, "canceled");
});
check("块进行中（缓存是待办）→ pushes 把服务端条目置 IN-PROCESS", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false, blockState: "todo" });
  const plan = bt.planBlockSync([block("b1", "买牛奶", "in-progress")], [it], baseSettings());
  assert.strictEqual(plan.pushes.length, 1);
  assert.strictEqual(plan.pushes[0].item.status, "IN-PROCESS");
  assert.strictEqual(plan.pushes[0].item.percent, 0);
});
check("块放弃（缓存是待办）→ pushes 把服务端条目置 CANCELLED", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false, blockState: "todo" });
  const plan = bt.planBlockSync([block("b1", "买牛奶", "canceled")], [it], baseSettings());
  assert.strictEqual(plan.pushes[0].item.status, "CANCELLED");
});
check("服务端「进行中」+ 块待办 → 回写块成 in-progress", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false, blockState: "todo", status: "IN-PROCESS" });
  const plan = bt.planBlockSync([block("b1", "买牛奶", "todo")], [it], baseSettings());
  assert.strictEqual(plan.writebacks.length, 1);
  assert.strictEqual(plan.writebacks[0].state, "in-progress");
});
check("服务端「放弃」+ 块待办 → 回写块成 canceled", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false, blockState: "todo", status: "CANCELLED" });
  const plan = bt.planBlockSync([block("b1", "买牛奶", "todo")], [it], baseSettings());
  assert.strictEqual(plan.writebacks.length, 1);
  assert.strictEqual(plan.writebacks[0].state, "canceled");
});
check("⛔ 服务端「待办」+ 块已完成 → 一个字都不许回写", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: true, blockState: "done", status: "NEEDS-ACTION" });
  const plan = bt.planBlockSync([block("b1", "买牛奶", "done")], [it], baseSettings());
  assert.strictEqual(plan.writebacks.length, 0, "不得把用户勾好的待办取消掉");
});
check("⛔ 服务端「进行中」+ 块已完成 → 不许回写（不撤销完成）", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: true, blockState: "done", status: "IN-PROCESS" });
  const plan = bt.planBlockSync([block("b1", "买牛奶", "done")], [it], baseSettings());
  assert.strictEqual(plan.writebacks.length, 0);
});
check("⛔ 服务端「放弃」+ 块已完成 → 不许回写（不撤销完成）", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: true, blockState: "done", status: "CANCELLED" });
  const plan = bt.planBlockSync([block("b1", "买牛奶", "done")], [it], baseSettings());
  assert.strictEqual(plan.writebacks.length, 0);
});
check("反向能力不能坏：服务端「完成」+ 块未完成 → 仍要回写勾上", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false, blockState: "todo", status: "COMPLETED", percent: 100 });
  const plan = bt.planBlockSync([block("b1", "买牛奶", "todo")], [it], baseSettings());
  assert.strictEqual(plan.writebacks.length, 1);
  assert.strictEqual(plan.writebacks[0].state, "done");
});
check("老数据只有 blockChecked（无 blockState）→ 仍能正确对账", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: true, status: "NEEDS-ACTION" });
  const plan = bt.planBlockSync([block("b1", "买牛奶", "done")], [it], baseSettings());
  assert.strictEqual(plan.writebacks.length, 0, "服务端未完成 + 块已完成 → 仍不许回写");
});
check("自定义任务状态的块：状态没变就不该被改写", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false, blockState: "todo", status: "NEEDS-ACTION" });
  const plan = bt.planBlockSync([block("b1", "买牛奶", "todo", "!")], [it], baseSettings());
  assert.strictEqual(plan.writebacks.length, 0, "自定义状态不该被插件改掉");
});
check("漂移检测：服务端「完成」+ 块未完成 → 漂移（要把块勾上）", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false, blockState: "todo", status: "COMPLETED", percent: 100 });
  assert.strictEqual(bt.blockItemDrift(it, baseSettings()), true);
});
check("漂移检测：服务端「待办」+ 块已完成 → 不漂移（否则每轮白跑）", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: true, blockState: "done", status: "NEEDS-ACTION" });
  assert.strictEqual(bt.blockItemDrift(it, baseSettings()), false);
});
check("漂移检测：服务端「进行中/放弃」+ 块已完成 → 不漂移", () => {
  const a = item({ blockId: "b1", blockText: "买牛奶", blockChecked: true, blockState: "done", status: "IN-PROCESS" });
  const b = item({
    uid: "u-b2",
    blockId: "b2",
    blockText: "买酸奶",
    summary: "[文档]买酸奶",
    blockChecked: true,
    blockState: "done",
    status: "CANCELLED"
  });
  assert.strictEqual(bt.blockItemDrift(a, baseSettings()), false);
  assert.strictEqual(bt.blockItemDrift(b, baseSettings()), false);
});

console.log("[taskstate] ⑥ ICS 往返");

check("写进服务端：IN-PROCESS", () => {
  const text = ics.itemToNewICS(item({ status: "IN-PROCESS", percent: 0 }));
  assert.match(text, /STATUS:IN-PROCESS/);
});
check("写进服务端：CANCELLED", () => {
  const text = ics.itemToNewICS(item({ status: "CANCELLED", percent: 0 }));
  assert.match(text, /STATUS:CANCELLED/);
  assert.doesNotMatch(text, /PERCENT-COMPLETE/, "放弃不是部分完成，不写进度");
});
check("写进服务端：COMPLETED 带 PERCENT-COMPLETE:100 与 COMPLETED", () => {
  const text = ics.itemToNewICS(item({ status: "COMPLETED", percent: 100 }));
  assert.match(text, /STATUS:COMPLETED/);
  assert.match(text, /PERCENT-COMPLETE:100/);
  assert.match(text, /COMPLETED:/);
});
check("写进服务端：非法 STATUS 被归一（绝不原样回写）", () => {
  const text = ics.itemToNewICS(item({ status: "CONFIRMED", percent: 0 }));
  assert.match(text, /STATUS:NEEDS-ACTION/);
  assert.doesNotMatch(text, /STATUS:CONFIRMED/);
});
check("读回服务端：四态不失真", () => {
  for (const [status, expect] of [
    ["NEEDS-ACTION", "todo"],
    ["IN-PROCESS", "in-progress"],
    ["COMPLETED", "done"],
    ["CANCELLED", "canceled"]
  ]) {
    const text = ics.itemToNewICS(item({ status, percent: status === "COMPLETED" ? 100 : 0 }));
    const parsed = ics.itemsFromICS(text, CAL, CAL + "a.ics");
    assert.strictEqual(parsed.length, 1, status + " 应解析出一条");
    assert.strictEqual(ts.stateOfStatus(parsed[0].status, parsed[0].percent), expect, status);
  }
});

console.log("[taskstate] ⑦ 源码级防漂移");

check("回写块的保险必须走 canWriteState（函数级，不是特判）", () => {
  const src = read("src/core/block-todo.ts");
  assert.match(src, /stateDiffers && canWriteState\(b\.state, nextState\)/);
});
check("状态映射只允许一处实现（core/task-state.ts）", () => {
  const src = read("src/core/task-state.ts");
  assert.match(src, /MARKER_IN_PROGRESS = "\/"/);
  assert.match(src, /MARKER_CANCELED = "-"/);
  assert.match(src, /STATUS_IN_PROCESS = "IN-PROCESS"/);
  assert.match(src, /STATUS_CANCELLED = "CANCELLED"/);
  // 旧的二态判定不许再出现「服务端未完成就取消勾选」的老写法
  assert.doesNotMatch(src, /wouldUncheck/);
});
check("store 的对账缓存要保留 blockState", () => {
  const src = read("src/core/store.ts");
  assert.match(src, /blockState: inc\.blockState \?\? keep\?\.blockState/);
});

console.log(`\n[taskstate] 合计 ${pass} 项通过`);
