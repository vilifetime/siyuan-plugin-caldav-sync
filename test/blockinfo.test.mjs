/**
 * 「文档任务块信息」页签单测（2026-10-31）。
 *
 * 背景：编辑弹窗要给**由文档任务块映射来的待办**多开一个只读页签，
 * 显示笔记本名称 / 文档名称 / 任务块名称 / 任务块 ID；普通待办不显示。
 *
 * 覆盖三块：
 *   ① `getBlockDetail` 的数据拼装（笔记本名靠 `box` → lsNotebooks；文档名靠 root 块 content；
 *      块文字要 trim —— 实测 content 带前导空格）
 *   ② 取不到的情况（块没了 / 笔记本列表接口挂了）不该编造，返回 undefined 或留空字段
 *   ③ 页签的显示条件：源码里必须是「待办 **且** 有 blockId」才渲染，别给普通待办也挂上
 *
 * 内核用假 caller 模拟（不启动思源）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-blockinfo");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/block-todo.ts src/core/block-api.ts ` +
    `src/core/task-state.ts src/core/server-id.ts ` +
    `--outDir .test-blockinfo --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const bapi = require(path.join(outDir, "block-api.js"));

let pass = 0;
const pending = [];
const check = (name, fn) => pending.push({ name, fn });
const section = (title) => pending.push({ section: title });
const runAll = async () => {
  for (const c of pending) {
    if (c.section) {
      console.log(c.section);
      continue;
    }
    try {
      await c.fn();
      pass++;
      console.log("  ✓ " + c.name);
    } catch (e) {
      console.log("  ✗ " + c.name + "\n    " + (e && e.message));
      process.exitCode = 1;
    }
  }
};

/** 假内核：按语句分派，如实回信封（code/data/truncated） */
function fakeKernel(opts = {}) {
  const stmts = [];
  const caller = async (url, body) => {
    if (url === "/api/notebook/lsNotebooks") {
      if (opts.notebooksFail) throw new Error("kernel down");
      return { code: 0, data: { notebooks: opts.notebooks || [] } };
    }
    const stmt = String(body?.stmt || "");
    stmts.push(stmt);
    if (/FROM blocks WHERE id = '20260101-aaa'/.test(stmt)) {
      return {
        code: 0,
        data: [
          {
            id: "20260101-aaa",
            content: " 买牛奶",
            markdown: "- [ ] 买牛奶",
            root_id: "20260101-doc",
            box: "20260101-box",
            hpath: "/daily note/2026/01/2026-01-01"
          }
        ]
      };
    }
    if (/FROM blocks WHERE id = '20260101-doc'/.test(stmt)) {
      return { code: 0, data: [{ id: "20260101-doc", content: "2026-01-01", type: "d" }] };
    }
    return { code: 0, data: [] };
  };
  return { caller, stmts };
}

section("① getBlockDetail 拼装归属信息");

check("笔记本名 = box → lsNotebooks 的 name（hpath 里没有笔记本名，不能拿第一段）", async () => {
  const { caller } = fakeKernel({ notebooks: [{ id: "20260101-box", name: "work工作" }] });
  const d = await bapi.getBlockDetail(caller, "20260101-aaa");
  assert.ok(d, "应查到块");
  assert.strictEqual(d.notebookName, "work工作");
  assert.strictEqual(d.box, "20260101-box");
});

check("文档名 = 文档块（root_id）的 content", async () => {
  const { caller } = fakeKernel({ notebooks: [{ id: "20260101-box", name: "work工作" }] });
  const d = await bapi.getBlockDetail(caller, "20260101-aaa");
  assert.strictEqual(d.docTitle, "2026-01-01");
  assert.strictEqual(d.rootId, "20260101-doc");
});

check("任务块名称要 trim（content 实测带前导空格）", async () => {
  const { caller } = fakeKernel({ notebooks: [{ id: "20260101-box", name: "work工作" }] });
  const d = await bapi.getBlockDetail(caller, "20260101-aaa");
  assert.strictEqual(d.text, "买牛奶");
  assert.strictEqual(d.id, "20260101-aaa");
  assert.strictEqual(d.markdown, "- [ ] 买牛奶");
});

check("每条 SQL 都显式写了 LIMIT（内核没写 LIMIT 只回 64 行）", async () => {
  const { caller, stmts } = fakeKernel({ notebooks: [{ id: "20260101-box", name: "work工作" }] });
  await bapi.getBlockDetail(caller, "20260101-aaa");
  assert.ok(stmts.length >= 2, "至少查了块 + 文档两条");
  for (const s of stmts) assert.ok(/LIMIT \d+/.test(s), "缺 LIMIT: " + s);
});

section("② 取不到时不编造");

check("块不存在 → undefined", async () => {
  const { caller } = fakeKernel({ notebooks: [{ id: "20260101-box", name: "work工作" }] });
  const d = await bapi.getBlockDetail(caller, "不存在的ID");
  assert.strictEqual(d, undefined);
});

check("空 ID 直接返回 undefined，不打内核", async () => {
  const { caller, stmts } = fakeKernel();
  const d = await bapi.getBlockDetail(caller, "");
  assert.strictEqual(d, undefined);
  assert.strictEqual(stmts.length, 0);
});

check("笔记本接口挂了 → 笔记本名留空，其余照常返回（不整条失败）", async () => {
  const { caller } = fakeKernel({ notebooksFail: true });
  const d = await bapi.getBlockDetail(caller, "20260101-aaa");
  assert.ok(d, "块信息仍应返回");
  assert.strictEqual(d.notebookName, undefined);
  assert.strictEqual(d.docTitle, "2026-01-01");
  assert.strictEqual(d.text, "买牛奶");
});

section("③ 页签显示条件（源码级断言，防后来者给普通待办也挂上）");

check("editor.ts：页签与面板的渲染条件都是「待办 且 有 blockId」", () => {
  const src = fs.readFileSync(path.join(root, "src/ui/editor.ts"), "utf8");
  const guard = /isTodo && it\.blockId/g;
  const hits = src.match(guard) || [];
  assert.ok(hits.length >= 2, `页签与面板都要带这个守卫，实际 ${hits.length} 处`);
  assert.ok(/data-tab="block"/.test(src), "缺新页签按钮");
  assert.ok(/data-panel="block"/.test(src), "缺新页签面板");
  // 只读：面板里不能出现可输入的控件
  const panel = src.slice(src.indexOf('data-panel="block"'));
  assert.ok(!/<input|<textarea|<select/.test(panel.slice(0, 1200)), "这一页必须是只读，别放输入控件");
});

check("panel.ts / index.ts：块详情由入口注入，UI 不自己去碰内核", () => {
  const p = fs.readFileSync(path.join(root, "src/ui/panel.ts"), "utf8");
  assert.ok(/blockDetail\?:/.test(p), "PanelCtx 缺 blockDetail 注入口");
  const i = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
  assert.ok(/blockDetail:\s*\(id\)/.test(i), "index.ts 没注入 blockDetail");
  assert.ok(/getBlockDetail\(this\.kernelCaller\(\), id\)/.test(i), "注入的不是 getBlockDetail");
});

await runAll();
console.log(`\n通过 ${pass} 项${process.exitCode ? "，有失败" : "，0 失败"}`);
