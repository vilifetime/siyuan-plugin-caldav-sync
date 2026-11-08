/**
 * 思源编辑弹窗「底部 5 按钮」布局回归锁（2026-11-08，雄哥截图）。
 *
 * 症状：英文界面事件弹窗（520px）里 Delete / Cancelled / To Event / Cancel / Save
 * 五个按钮排一行，Save 被容器右边界裁掉，只剩半截。
 *
 * 实测基线（本机 Edge --headless=new --dump-dom，加载真实 src/index.css +
 * 与 editor.ts 完全一致的页脚 DOM，桌面视口 1400×900 避开移动媒体查询）：
 *   改动前 英文 520px：按钮组右边界 561 / 内容右界 505 → 溢出 55.8px，
 *                     foot.scrollWidth-clientWidth = 42；中文在字距压力下溢出 1~6px。
 *   改动后 21 场景（中英 × 480/520/560 × 字距 0/1.2/1.6 + 3 个错误提示场景）：
 *                     over=0、scroll=0、rows=1，BAD=0；按钮 95×33 → 71×28。
 *   术语调整期 48 场景复测（中英 × 440/480/520/560 × 字距 0/1.2/1.6 ×
 *                     转日程/转待办）：中转态 To Schedule 在 440px 溢出 3.8px，
 *                     容器 gap 收 1px 后 BAD=0；定稿 To Event 更短，保留余量。
 *
 * 修法（移植 Obsidian 端 0.4.20 已验证方案 + 雄哥本轮「内边距再小一点」）：
 *   ① 页脚 gap 10→4（术语调整期 To Schedule 变长，5px 时 440px 极限窄溢出 3.8px；
 *      定稿 To Event 更短，保留 4px 余量）；
 *      padding 10px 14px 12px→8px 10px 10px，显式 nowrap + overflow-x:hidden；
 *   ② 弹性占位不再 grow（`flex:0 1 0`），改由「取消」margin-left:auto 推右侧按钮；
 *   ③ 仅编辑弹窗页脚内的按钮：横向 18→9、纵向 8→6、内部 gap 5→4、
 *      字号 13→12、图标 14→12。全局 .caldav-foot-btn 保持原尺寸，
 *      Dock / 设置页 / 分类管理器不受影响。
 *
 * 判据按声明行 `^\s*prop:...;$` 匹配，且只取行首（无缩进）的顶层规则块，
 * 避免误命中 @media 内的简写或注释里的字样；末尾有变异自测防假绿。
 *
 * 用法：node test/editor-foot.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const css = read("src/index.css");
const editorSrc = read("src/ui/editor.ts");

/** 取「行首无缩进」的顶层规则块内容（@media 内的规则有缩进，不会被误命中）。 */
function topBlock(sel, src = css) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}\\s*\\{([\\s\\S]*?)\\}`, "m");
  const m = re.exec(src);
  assert.ok(m, `找不到顶层规则块：${sel}`);
  return m[1];
}
/** 断言块内某条声明按行精确出现（注释里的同名字样不算）。 */
function decl(body, prop, value, label = "") {
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(body, new RegExp(`^\\s*${prop}:\\s*${esc}\\s*;`, "m"),
    `${label || prop} 缺声明 ${prop}: ${value};`);
}
const FOOT = ".caldav-editor-foot";
const BTN = ".caldav-editor-foot .caldav-foot-btn";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`  [OK] ${name}`); };

console.log("\n① 页脚容器：收紧间距 + 单行 + 绝不渲染横向滚动条");
check("flex-wrap: nowrap（5 按钮不换行）", () => decl(topBlock(FOOT), "flex-wrap", "nowrap"));
check("overflow-x: hidden（页脚不出横向滚动条）", () => decl(topBlock(FOOT), "overflow-x", "hidden"));
check("gap: 4px（原 10px；术语变长后再收 1px）", () => decl(topBlock(FOOT), "gap", "4px"));
check("padding: 8px 10px 10px（原 10px 14px 12px）", () => decl(topBlock(FOOT), "padding", "8px 10px 10px"));

console.log("\n② 弹性占位不吃宽度，右对齐交给「取消」");
check(".caldav-editor-foot .caldav-flex 为 flex: 0 1 0", () =>
  decl(topBlock(`${FOOT} .caldav-flex`), "flex", "0 1 0"));
check("ghost（取消）为 margin-left: auto", () =>
  decl(topBlock(`${FOOT} .caldav-foot-btn--ghost`), "margin-left", "auto"));

console.log("\n③ 页脚按钮小一号、图标/文字离边框更近");
check("padding: 6px 9px（原 8px 18px）", () => decl(topBlock(BTN), "padding", "6px 9px"));
check("内部 gap: 4px（原 5px）", () => decl(topBlock(BTN), "gap", "4px"));
check("font-size: 12px（原 13px）", () => decl(topBlock(BTN), "font-size", "12px"));
check("按钮仍不收缩且文案不换行", () => {
  const b = topBlock(BTN);
  decl(b, "flex", "0 0 auto");
  decl(b, "white-space", "nowrap");
});
check("页脚图标 12×12（原 14×14）", () => {
  const b = topBlock(`${BTN} svg`);
  decl(b, "width", "12px");
  decl(b, "height", "12px");
});

console.log("\n④ 缩小只作用于编辑弹窗页脚，其它按钮保持原尺寸");
check("全局 .caldav-foot-btn 仍是 padding: 8px 18px / font-size: 13px", () => {
  const b = topBlock(".caldav-foot-btn");
  decl(b, "padding", "8px 18px");
  decl(b, "font-size", "13px");
});
check("全局 .caldav-foot-btn svg 仍是 14px", () => {
  const b = topBlock(".caldav-foot-btn svg");
  decl(b, "width", "14px");
  decl(b, "height", "14px");
});
check("移动端 @media (max-width:768px) 仍允许页脚换行", () => {
  const i = css.indexOf("@media (max-width: 768px)");
  assert.ok(i > 0, "找不到 768px 媒体查询");
  const seg = css.slice(i, css.indexOf("\n}", i) + 2);
  assert.match(seg, /\.caldav-editor-foot\s*\{\s*flex-wrap:\s*wrap;\s*\}/,
    "移动端页脚换行规则被误删（窄屏会挤成一条）");
});

console.log("\n⑤ 页脚 DOM 结构：确实是 5 个按钮 + 占位 + 错误提示");
check("editor.ts 页脚含 delete/void/convert/cancel/save 与 spacer", () => {
  const i = editorSrc.indexOf('class="caldav-editor-foot"');
  assert.ok(i > 0, "找不到页脚模板");
  const tail = editorSrc.slice(i);
  const end = /\n<\/div>\s*<\/div>/.exec(tail);
  assert.ok(end, "找不到页脚模板结束标记");
  const foot = tail.slice(0, end.index); // 只取页脚块，避免命中 bindEvents 里的同名字样
  for (const a of ["delete", "void", "convert", "cancel", "save"])
    assert.match(foot, new RegExp(`data-action="${a}"`), `缺 ${a} 按钮`);
  assert.match(foot, /class="caldav-flex"/, "缺弹性占位");
  assert.match(foot, /class="caldav-editor-error"/, "缺错误提示位");
});

console.log("\n⑥ 判据自测：改回旧值 / 删掉关键声明必须判红（防假绿）");
check("页脚容器退回旧值时应判红", () => {
  const broken = topBlock(FOOT)
    .replace(/^(\s*)gap:\s*4px\s*;/m, "$1gap: 10px;")
    .replace(/^(\s*)padding:\s*8px 10px 10px\s*;/m, "$1padding: 10px 14px 12px;")
    .replace(/^\s*flex-wrap:\s*nowrap\s*;/m, "")
    .replace(/^\s*overflow-x:\s*hidden\s*;/m, "");
  assert.throws(() => decl(broken, "gap", "4px"));
  assert.throws(() => decl(broken, "padding", "8px 10px 10px"));
  assert.throws(() => decl(broken, "flex-wrap", "nowrap"));
  assert.throws(() => decl(broken, "overflow-x", "hidden"));
});
check("按钮退回旧尺寸时应判红", () => {
  const broken = topBlock(BTN)
    .replace(/^(\s*)padding:\s*6px 9px\s*;/m, "$1padding: 8px 18px;")
    .replace(/^(\s*)font-size:\s*12px\s*;/m, "$1font-size: 13px;");
  assert.throws(() => decl(broken, "padding", "6px 9px"));
  assert.throws(() => decl(broken, "font-size", "12px"));
});
check("占位重新参与 grow 时应判红", () => {
  const broken = topBlock(`${FOOT} .caldav-flex`).replace(/flex:\s*0 1 0\s*;/, "flex: 1 1 auto;");
  assert.throws(() => decl(broken, "flex", "0 1 0"));
});

console.log(`\neditor-foot: ${pass} 项断言全部通过（页脚 5 按钮单行不越界 / 尺寸小一号 / 其它按钮不受影响）`);
