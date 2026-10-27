/**
 * 文档任务块 ⇄ VTODO（issue #2）单测。
 *
 * 覆盖三块：
 *   ① ICS 层：X-SIYUAN-BLOCK-ID 的写入 / 读回 / 编辑后不丢也不重复
 *   ② 对账层：create / push / writeback / delete 四类动作与完成优先、范围存在性判据
 *   ③ 辅助：块 markdown 改写、文字清洗、前缀、默认截止时间
 * 外加源码级防漂移：设置区控件、总开关守卫、skip 属性名。
 *
 * 运行前用 tsc 把相关 core 文件编到 .test-blocksync（与 core.test 同一套路）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-blocksync");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/block-todo.ts src/core/block-api.ts ` +
    `--outDir .test-blocksync --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const ics = require(path.join(outDir, "ics.js"));
const bt = require(path.join(outDir, "block-todo.js"));
const bapi = require(path.join(outDir, "block-api.js"));
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
const block = (id, text, checked = false) => ({
  id,
  text,
  checked,
  markdown: `- [${checked ? "X" : " "}] ${text}`
});
const item = (over = {}) => ({
  uid: "u-" + Math.random().toString(36).slice(2),
  kind: "todo",
  calendarUrl: CAL,
  href: CAL + "a.ics",
  summary: "买牛奶",
  allDay: false,
  start: "2026-10-28T09:00:00",
  status: "NEEDS-ACTION",
  percent: 0,
  ...over
});

console.log("[blocksync] ① ICS：X-SIYUAN-BLOCK-ID");

check("新建序列化写出 X-SIYUAN-BLOCK-ID", () => {
  const text = ics.itemToNewICS(item({ blockId: "20261028-abc" }));
  assert.match(text, /X-SIYUAN-BLOCK-ID:20261028-abc/);
});

check("解析能读回 blockId", () => {
  const text = ics.itemToNewICS(item({ blockId: "20261028-abc" }));
  const items = ics.itemsFromICS(text, CAL, CAL + "a.ics", "etag1");
  assert.strictEqual(items[0].blockId, "20261028-abc");
});

check("编辑（带 raw）后属性不丢、也不重复", () => {
  const text = ics.itemToNewICS(item({ blockId: "20261028-abc" }));
  const it = ics.itemsFromICS(text, CAL, CAL + "a.ics", "etag1")[0];
  it.summary = "改后的标题";
  const out = ics.itemToEditedICS(it);
  const n = (out.match(/X-SIYUAN-BLOCK-ID/g) || []).length;
  assert.strictEqual(n, 1, "X- 属性必须恰好一份（进 MANAGED 才不会重复）");
  assert.match(out, /X-SIYUAN-BLOCK-ID:20261028-abc/);
});

check("没有 blockId 时不写这个属性", () => {
  assert.ok(!/X-SIYUAN-BLOCK-ID/.test(ics.itemToNewICS(item())));
});

console.log("[blocksync] ② 对账：四类动作");

check("陌生块 → creates（落默认日历、标题带前缀）", () => {
  const plan = bt.planBlockSync([block("b1", "买牛奶")], [], baseSettings());
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.creates[0].summary, "[文档]买牛奶");
  assert.strictEqual(plan.creates[0].completed, false);
});

check("块打勾 → pushes（条目置完成）", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false });
  const plan = bt.planBlockSync([block("b1", "买牛奶", true)], [it], baseSettings());
  assert.strictEqual(plan.pushes.length, 1);
  assert.strictEqual(plan.pushes[0].item.status, "COMPLETED");
  assert.strictEqual(plan.pushes[0].item.percent, 100);
  assert.strictEqual(plan.writebacks.length, 0);
});

check("服务端完成、块未勾 → writebacks（回写块勾选）", () => {
  const it = item({
    blockId: "b1",
    blockText: "买牛奶",
    blockChecked: false,
    status: "COMPLETED",
    percent: 100
  });
  const plan = bt.planBlockSync([block("b1", "买牛奶", false)], [it], baseSettings());
  assert.strictEqual(plan.writebacks.length, 1);
  assert.strictEqual(plan.writebacks[0].checked, true);
});

check("块文字改了 → pushes 且以块为准（服务端标题被覆盖）", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false, summary: "[文档]买牛奶" });
  const plan = bt.planBlockSync([block("b1", "买酸奶")], [it], baseSettings());
  assert.ok(plan.pushes.length >= 1);
  assert.strictEqual(plan.pushes[0].item.summary, "[文档]买酸奶");
  assert.strictEqual(plan.writebacks.length, 0, "文字不回写块（避免拍平富文本）");
});

check("块没了且确实不存在 → deletions", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false });
  const plan = bt.planBlockSync([], [it], baseSettings(), { existing: new Set() });
  assert.strictEqual(plan.deletions.length, 1);
});

check("块没了但仍在库里（只是不在扫描范围）→ 不删", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false });
  const plan = bt.planBlockSync([], [it], baseSettings(), { existing: new Set(["b1"]) });
  assert.strictEqual(plan.deletions.length, 0, "范围外 ≠ 已删除");
});

check("两边都动了 → 完成优先（不会来回翻转）", () => {
  const it = item({
    blockId: "b1",
    blockText: "买牛奶",
    blockChecked: false,
    status: "COMPLETED",
    percent: 100
  });
  const plan = bt.planBlockSync([block("b1", "买牛奶", true)], [it], baseSettings());
  // 块勾上（块动了）+ 服务端已完成（服务端动了）→ 维持完成，不再回写「未勾」
  assert.strictEqual(plan.writebacks.length, 0);
  assert.strictEqual(plan.pushes[0].item.status, "COMPLETED");
});

check("稳态（两边一致）→ 无动作", () => {
  const it = item({
    blockId: "b1",
    blockText: "买牛奶",
    blockChecked: false,
    summary: "[文档]买牛奶"
  });
  const plan = bt.planBlockSync([block("b1", "买牛奶", false)], [it], baseSettings());
  assert.strictEqual(plan.creates.length + plan.pushes.length + plan.writebacks.length + plan.deletions.length, 0);
  assert.strictEqual(plan.unchanged, 1);
});

check("映射缺失但服务端有锚点 → 不重复新建（按 blockId 认亲）", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false });
  const plan = bt.planBlockSync([block("b1", "买牛奶")], [it], baseSettings());
  assert.strictEqual(plan.creates.length, 0);
});

console.log("[blocksync] ③ 辅助函数");

check("blockCheckedOf 认 `- [X]`（含大小写与缩进）", () => {
  assert.strictEqual(bt.blockCheckedOf("- [X] 完成"), true);
  assert.strictEqual(bt.blockCheckedOf("- [x] 完成"), true);
  assert.strictEqual(bt.blockCheckedOf("- [ ] 未完成"), false);
  assert.strictEqual(bt.blockCheckedOf("  - [X] 缩进的"), true);
});

check("回写勾选只动第一行，子块原样带回", () => {
  const md = "- [ ] 待办\n  - 子块内容";
  const out = bapi.withCheckedMarkdown(md, true);
  assert.strictEqual(out, "- [X] 待办\n  - 子块内容");
  assert.strictEqual(bapi.withCheckedMarkdown("- [X] x", false), "- [ ] x");
  assert.strictEqual(bapi.withCheckedMarkdown("不是任务块", true), null, "非任务块行必须拒绝改写");
});

check("块文字清洗：trim + 去同步前缀", () => {
  assert.strictEqual(bt.cleanBlockText("  买牛奶  "), "买牛奶");
  assert.strictEqual(bt.cleanBlockText("[文档]买牛奶", "[文档]"), "买牛奶");
});

check("前缀：设置里没勾 prefix 就不加", () => {
  assert.strictEqual(bt.withPrefix("买牛奶", baseSettings({ blockSyncMarks: ["badge"] })), "买牛奶");
  assert.strictEqual(bt.withPrefix("买牛奶", baseSettings({ blockSyncMarks: ["prefix"] })), "[文档]买牛奶");
  assert.strictEqual(bt.stripPrefix("[文档]买牛奶", baseSettings()), "买牛奶");
});

check("默认结束时间：与新建待办一致 → 开始 +8h；空 → 不写 DUE", () => {
  const s8 = baseSettings({ blockSyncDefaultEnd: "sameAsTodo", todoDefaultEnd: "plus8h" });
  assert.strictEqual(bt.blockDefaultEnd(s8, "2026-10-28T09:00:00"), "2026-10-28T17:00:00");
  const s1 = baseSettings({ blockSyncDefaultEnd: "sameAsTodo", todoDefaultEnd: "plus1h" });
  assert.strictEqual(bt.blockDefaultEnd(s1, "2026-10-28T09:00:00"), "2026-10-28T10:00:00");
  assert.strictEqual(bt.blockDefaultEnd(baseSettings({ blockSyncDefaultEnd: "none" }), "2026-10-28T09:00:00"), undefined);
});

check("角标默认开（未配置或含 badge）", () => {
  assert.strictEqual(bt.blockBadgeOn(baseSettings({ blockSyncMarks: undefined })), true);
  assert.strictEqual(bt.blockBadgeOn(baseSettings({ blockSyncMarks: ["badge", "prefix"] })), true);
  assert.strictEqual(bt.blockBadgeOn(baseSettings({ blockSyncMarks: ["prefix"] })), false);
});

console.log("[blocksync] ④ 源码级防漂移");

const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const settingsSrc = read("src/ui/settings-dialog.ts");
const indexSrc = read("src/index.ts");
const apiSrc = read("src/core/block-api.ts");
const typesSrc = read("src/core/types.ts");

check("设置区有「思源任务块识别与映射」段与总开关", () => {
  assert.match(settingsSrc, /思源任务块识别与映射/);
  assert.match(settingsSrc, /data-s="blockSyncEnabled"/);
});
check("设置区四个配置项齐全（日历 / 结束时间 / 范围 / 标记）", () => {
  for (const k of ["data-s=\"blockSyncCal\"", "data-s=\"blockSyncEnd\"", "data-s=\"blockSyncScope\"", "data-s=\"blockSyncMarkBadge\"", "data-s=\"blockSyncMarkPrefix\""]) {
    assert.ok(settingsSrc.includes(k), "缺 " + k);
  }
});
check("范围含四项（打开的文档 / 仅日记 / 笔记本 / 全部文档）", () => {
  for (const v of ['value="open"', 'value="daily"', 'value="notebooks"', 'value="all"']) {
    assert.ok(settingsSrc.includes(v), "缺范围 " + v);
  }
});
check("设置区有「立即扫描」与「一键清理」两个按钮", () => {
  assert.match(settingsSrc, /data-action="blocks-scan"/);
  assert.match(settingsSrc, /data-action="blocks-clear"/);
});
check("总开关守卫：没启用就不跑对账 / 不挂块菜单", () => {
  assert.match(indexSrc, /if \(!s\.blockSyncEnabled\) return;/);
  assert.match(indexSrc, /if \(!this\.store\.settings\.blockSyncEnabled\) return/);
  assert.match(indexSrc, /open-menu-content/);
});
check("扫块排除 skip 标记用的是 attributes 子查询（不是逐块调 API）", () => {
  assert.match(apiSrc, /id NOT IN \(SELECT block_id FROM attributes WHERE name = '\$\{BLOCK_SKIP_ATTR\}'\)/);
});
check("删除判生死走 blocksExistById（不靠扫描范围）", () => {
  assert.match(read("src/core/block-sync.ts"), /blocksExistById/);
});
check("取消同步必须打 skip 标记（否则下轮会被重建）", () => {
  const bs = read("src/core/block-sync.ts");
  assert.match(bs, /unsyncBlock[\s\S]{0,400}setBlockSkip/);
});
check("默认设置：总开关默认关、范围默认全部、标记默认角标", () => {
  assert.strictEqual(T.DEFAULT_SETTINGS.blockSyncEnabled, false);
  assert.strictEqual(T.DEFAULT_SETTINGS.blockSyncScope, "all");
  assert.deepStrictEqual(T.DEFAULT_SETTINGS.blockSyncMarks, ["badge"]);
  assert.strictEqual(T.DEFAULT_SETTINGS.blockSyncDefaultEnd, "sameAsTodo");
});
check("CalItem 有 blockId / blockText / blockChecked 三个字段", () => {
  assert.match(typesSrc, /blockId\?: string;/);
  assert.match(typesSrc, /blockText\?: string;/);
  assert.match(typesSrc, /blockChecked\?: boolean;/);
});

console.log(`\n[blocksync] 合计 ${pass} 项通过`);
