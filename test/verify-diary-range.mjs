/**
 * 「插入日记」弹窗的几何 + 作用域验证（手动跑：node test/verify-diary-range.mjs）。
 *
 * 雄哥 2026-10-08 的要求：**子选项要跟在「本周 / 本月」右侧的同一行**，
 * 而不是单独占一段。于是顺手要钉住两件事：
 *
 *   A. 同行与右侧 —— 子选项与「本周」标签垂直对齐（差 ≤ 3px）、且整体在其右侧；
 *      两个范围行里的子选项右缘对齐（换范围时视觉不跳）；行内不得横向溢出。
 *   B. 变量作用域 —— 弹窗是 `new Dialog()` 挂到 **document.body** 的，
 *      祖先链里**没有 .caldav-root**（变量定义在那儿）。所以 `.caldav-range` 必须
 *      自带一份主题变量映射，否则 `var(--caldav-border)` 解析为空 → 边框退化成
 *      currentColor（深黑）而不是浅灰。这一条只能在真实浏览器里量，jsdom 没有层叠。
 *
 * DOM 来自**真实插件**：先用 jsdom 起环境、调 askInsertDiary()、切到「本周」，
 * 把 `.caldav-range` 的 outerHTML 原样搬到页面里 —— 手写 HTML 会与实现漂移。
 *
 * 本机无 Edge/Chrome 时打印提示并退出 0。
 */
import { setupBrowserDom, loadBuiltPlugin, freeDebugPort } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-diary-range");
const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

const DIALOG_W = 420; // 与 diary-range-dialog.ts 的桌面态 width 一致

/* ---------- 1. 用真实插件生成弹窗 DOM ---------- */
// setupBrowserDom() 会把 globalThis.Event 换成 jsdom 的 Event —— 生成完 DOM 必须还原，
// 否则后面 undici 的 WebSocket 内部 dispatchEvent 会因「不是同一个 Event 类」直接抛错。
const nativeEvent = globalThis.Event;
const nativeCustomEvent = globalThis.CustomEvent;
setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
plugin.askInsertDiary();

const range = document.querySelector(".caldav-range");
if (!range) throw new Error("未能生成弹窗 DOM");
// 切到「本周」：子选项此时才渲染
const weekRadio = Array.from(range.querySelectorAll('input[name="caldav-range"]')).find((r) => r.value === "week");
weekRadio.checked = true;
weekRadio.dispatchEvent(new window.Event("change", { bubbles: true }));
const rangeHtml = range.outerHTML;
if (!/caldav-range-target/.test(rangeHtml)) throw new Error("切到本周后应渲染出子选项");

// 还原 Node 原生事件类，交给后面的 CDP WebSocket 用
globalThis.Event = nativeEvent;
globalThis.CustomEvent = nativeCustomEvent;

/* ---------- 2. 落成页面：宿主是「挂 body 的 Dialog」，祖先里没有 .caldav-root ---------- */
const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>
  html,body{margin:0;padding:0;background:#fff;font-family:system-ui,"Microsoft YaHei",sans-serif}
  /* 只搭出 Dialog 的骨架，不提供任何 --caldav-* —— 与真实宿主一致 */
  .b3-dialog{position:fixed;inset:0;display:flex;align-items:flex-start;justify-content:center;padding-top:20px}
  .b3-dialog__container{width:${DIALOG_W}px;background:#fff;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.2)}
  .b3-dialog__header{padding:10px 15px}
  .b3-dialog__title{font-size:14px;font-weight:500}
  .b3-dialog__body{padding:12px 15px 14px}
</style></head>
<body>
<div class="b3-dialog">
  <div class="b3-dialog__container">
    <div class="b3-dialog__header"><div class="b3-dialog__title">插入日记</div></div>
    <div class="b3-dialog__body">${rangeHtml}</div>
  </div>
</div>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "diary-range.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

/* ---------- 3. 起 Edge 量几何 ---------- */
const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[diary-range] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(outDir, "profile-diary-range")}`,
  "about:blank"
], { stdio: "ignore" });
let killed = false;
const cleanup = () => { if (!killed) { killed = true; try { proc.kill(); } catch {} } };
process.on("exit", cleanup);

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
    if (t) wsUrl = t.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { console.log("[diary-range] 连不上调试端口"); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 760, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 60; i++) {
  await sleep(80);
  const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
  if (st.result.value === "complete") { await sleep(250); break; }
}
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

const MEASURE = String.raw`(() => {
  const q = (s) => document.querySelector(s);
  const all = (s) => Array.from(document.querySelectorAll(s));
  const r = (el) => { const b = el.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}; };
  const weekRow = q('[data-range-row="week"]');
  const label = weekRow.querySelector(".caldav-range-opt-label");
  const inline = weekRow.querySelector("[data-inline]");
  const targets = all('[data-range-row="week"] .caldav-range-target');
  const emptyInline = all('[data-inline]').filter((n) => n !== inline).map((n) => r(n));
  const rowR = r(weekRow);
  const cs = getComputedStyle(weekRow);
  return {
    label: r(label),
    inline: r(inline),
    targets: targets.map(r),
    targetText: targets.map((t) => t.textContent.trim()),
    emptyInlineWidths: emptyInline.map((x) => x.width),
    emptyInlineDisplays: all('[data-inline]').filter((n) => n !== inline).map((n) => getComputedStyle(n).display),
    row: rowR,
    rowScrollWidth: weekRow.scrollWidth,
    rowClientWidth: weekRow.clientWidth,
    borderColor: cs.borderTopColor,
    uncheckedBorder: getComputedStyle(q('[data-range-row="month"]')).borderTopColor,
    targetCheckedColor: getComputedStyle(targets[0]).color,
    textColor2: getComputedStyle(label).color,
    varBorder: cs.getPropertyValue("--caldav-border").trim(),
    varAccent: cs.getPropertyValue("--caldav-accent").trim(),
    rangeScroll: (() => { const e = q(".caldav-range"); return { sw: e.scrollWidth, cw: e.clientWidth }; })()
  };
})()`;

const m = await evalJs(MEASURE);
const near = (a, b, t) => Math.abs(a - b) <= t;
const checks = [
  ["子选项渲染出两项（今天 / 本周一）", m.targets.length === 2],
  ["子选项与「本周」标签同一行（垂直中心差 ≤ 3px）", near((m.targets[0].top + m.targets[0].bottom) / 2, (m.label.top + m.label.bottom) / 2, 3)],
  ["子选项整体在「本周」标签右侧", m.targets[0].left >= m.label.right - 1],
  ["子选项右缘贴住行内右侧（距行右缘 ≤ 14px）", m.row.right - m.targets[m.targets.length - 1].right <= 14],
  ["子选项未溢出所在行", m.targets[m.targets.length - 1].right <= m.row.right + 0.5],
  ["行内无横向溢出", m.rowScrollWidth <= m.rowClientWidth + 1],
  ["弹窗整体无横向溢出", m.rangeScroll.sw <= m.rangeScroll.cw + 1],
  ["其余范围行的子选项槽被收起（宽度 0 / display:none）", m.emptyInlineWidths.every((w) => w === 0) && m.emptyInlineDisplays.every((d) => d === "none")],
  // 变量作用域：祖先没有 .caldav-root，只能靠 .caldav-range 自带
  ["--caldav-border 在弹窗作用域可解析", m.varBorder !== ""],
  ["--caldav-accent 在弹窗作用域可解析", m.varAccent !== ""],
  ["未选中行的边框是主题浅灰（不是退化成 currentColor 的黑）", m.uncheckedBorder === "rgb(228, 231, 237)"],
  ["选中行边框取强调色（--caldav-accent 生效）", m.borderColor === "rgb(53, 117, 240)"],
  ["选中子选项的文字用强调色（灰字/强调都没退化成黑）", m.targetCheckedColor === "rgb(53, 117, 240)"]
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) bad++;
}
if (bad) {
  console.log("\n实测值：", JSON.stringify(m, null, 1));
  console.log(`[diary-range] 失败 ${bad} 项`);
  cleanup();
  process.exit(1);
}
console.log("\n实测：子选项文案 =", m.targetText.join(" / "));
console.log(`实测：子选项左缘 ${m.targets[0].left.toFixed(0)} / 「本周」标签右缘 ${m.label.right.toFixed(0)} / 行右缘 ${m.row.right.toFixed(0)}`);
console.log(`实测：边框色 ${m.borderColor}（--caldav-border = ${m.varBorder || "(空)"}）`);

// 顺带留一张截图，方便人工核对观感
try {
  await send("Emulation.setDeviceMetricsOverride", { width: 520, height: 400, deviceScaleFactor: 2, mobile: false });
  await sleep(150);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(outDir, "diary-range.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("截图：", shotPath);
} catch {}

console.log("[diary-range] 弹窗几何与作用域验证通过");
cleanup();
process.exit(0);
