/**
 * 回归锁：编辑弹窗标题在英文界面不得中英混排（2026-11-08 雄哥拍板）
 *
 * 症状：「Edit 日程 / Edit 待办」——字典 key 是「编辑{0}」，英文 value 写成
 * "Edit{0}"，而调用处把第二个参数硬编码成中文 "日程" / "待办"，
 * `_t()` 只替换占位符、不会翻译参数，于是英文界面拼出半英半中标题。
 *
 * 修法：参数也走字典（中文恒等映射，中文界面一字不变），英文 value 补空格。
 * 顺带修「拉取失败」的中文兜底 "未知原因" 与两处粘连英文（NewTo-do / CompletedEdit）。
 *
 * 测试用 esbuild 把 core/i18n.ts 打进真模块实例，并**把 editor.ts 里的 title
 * 表达式原样取出来执行**，避免「测的是复刻代码、源码却没改」的假绿。
 *
 * 用法：node test/editor-title-i18n.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const zh = JSON.parse(read("src/i18n/zh_CN.json"));
const en = JSON.parse(read("src/i18n/en_US.json"));
const editorSrc = read("src/ui/editor.ts");
const settingsSrc = read("src/ui/settings-dialog.ts");
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

const outDir = path.join(ROOT, "dist-test");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "editor-title-i18n.mjs");
await build({
  stdin: {
    contents: `export { setI18n, t } from "./src/core/i18n.ts";`,
    resolveDir: ROOT,
    sourcefile: "editor-title-i18n-entry.ts",
    loader: "ts"
  },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent"
});
const M = await import(pathToFileURL(out).href);

/* 从真实源码取出 `title: …` 表达式执行，源码一改测试立刻跟着变 */
const titleLine = editorSrc.split("\n").find((l) => /^\s*title:\s*isNew/.test(l));
assert.ok(titleLine, "editor.ts 里找不到标题表达式");
const expr = /title:\s*(.*),\s*$/.exec(titleLine)[1];
const titleOf = new Function("_t", "isNew", "isTodo", `return (${expr});`);

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`  [OK] ${name}`); };

console.log("\n① 中文界面：标题一字不变");
check("zh_CN：编辑待办 / 编辑日程 / 新建待办 / 新建日程", () => {
  M.setI18n(zh);
  assert.equal(titleOf(M.t, false, true), "编辑待办");
  assert.equal(titleOf(M.t, false, false), "编辑日程");
  assert.equal(titleOf(M.t, true, true), "新建待办");
  assert.equal(titleOf(M.t, true, false), "新建日程");
});

console.log("\n② 英文界面：纯英文、无 CJK、Edit 后有空格");
check("en_US：Edit To-do / Edit Event / New To-do / New Event", () => {
  M.setI18n(en);
  const titles = [
    titleOf(M.t, false, true),
    titleOf(M.t, false, false),
    titleOf(M.t, true, true),
    titleOf(M.t, true, false)
  ];
  assert.deepEqual(titles, ["Edit To-do", "Edit Event", "New To-do", "New Event"]);
  for (const s of titles) {
    assert.ok(!CJK.test(s), `标题仍夹中文：${s}`);
    assert.ok(!/Edit[^ ]/.test(s), `Edit 后缺空格：${s}`);
  }
});
check("「拉取失败」的中文兜底也走字典，英文为 Pull failed: Unknown reason", () => {
  M.setI18n(en);
  const msg = M.t("拉取失败：{0}", M.t("未知原因"));
  assert.equal(msg, "Pull failed: Unknown reason");
  assert.ok(!CJK.test(msg));
  assert.match(settingsSrc, /_t\("拉取失败：\{0\}", \(err \|\| _t\("未知原因"\)\)\)/,
    "settings-dialog.ts 的兜底仍是硬编码中文");
});

console.log("\n③ 字典与源码契约");
check("「编辑{0}」英文为 Edit {0}，中文仍是 编辑{0}", () => {
  assert.equal(en["编辑{0}"], "Edit {0}");
  assert.equal(zh["编辑{0}"], "编辑{0}");
});
check("新增「未知原因」键两端齐全、英文无中文；zh/en key 集合一致", () => {
  assert.equal(zh["未知原因"], "未知原因");
  assert.equal(en["未知原因"], "Unknown reason");
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});
check("两处粘连英文已修（NewTo-do / CompletedEdit）", () => {
  assert.equal(en["新建待办"], "New To-do");
  assert.equal(en["完成编辑"], "Finish editing");
  for (const k of ["新建待办", "完成编辑"]) assert.ok(!/[a-z][A-Z]/.test(en[k]), `${k} 仍是粘连英文`);
});
check("editor.ts 不再把中文字符串直接塞进 _t() 参数", () => {
  assert.ok(!/_t\("编辑\{0\}", \(isTodo \? "待办" : "日程"\)\)/.test(editorSrc),
    "又退回硬编码中文参数");
  assert.match(editorSrc, /_t\("编辑\{0\}", isTodo \? _t\("待办"\) : _t\("日程"\)\)/,
    "参数必须逐个走字典");
});

console.log("\n④ 变异自测（防止判据假绿）");
check("把参数改回硬编码中文，英文标题必须重新出现 CJK", () => {
  M.setI18n(en);
  const broken = expr.replace(/_t\("待办"\)/g, '"待办"').replace(/_t\("日程"\)/g, '"日程"');
  const badTitle = new Function("_t", "isNew", "isTodo", `return (${broken});`);
  assert.ok(CJK.test(badTitle(M.t, false, true)), "硬编码中文参数必须被 CJK 判据抓到");
});
check("把 value 改回 Edit{0}，标题必须丢掉空格被判红", () => {
  const badDict = { ...en, "编辑{0}": "Edit{0}" };
  M.setI18n(badDict);
  assert.equal(titleOf(M.t, false, true), "EditTo-do");
  assert.ok(!/^Edit /.test(titleOf(M.t, false, true)), "缺空格必须被判据抓到");
  M.setI18n(en);
});
check("删掉「未知原因」键，t() 回退中文必须被判红", () => {
  const badDict = { ...en };
  delete badDict["未知原因"];
  M.setI18n(badDict);
  assert.equal(M.t("未知原因"), "未知原因");
  assert.ok(CJK.test(M.t("拉取失败：{0}", M.t("未知原因"))), "缺 key 必须被判据抓到");
  M.setI18n(en);
});

console.log(`\neditor-title-i18n: ${pass} 项断言全部通过（中英标题 / 字典 / 源码契约 / 变异自测）\n`);
