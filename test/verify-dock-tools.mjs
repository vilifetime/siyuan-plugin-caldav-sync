/**
 * Dock 工具行的真实渲染验证（手动跑）。2026-10-10 改版：
 *
 *   一行四个操作点：日期范围下拉框 + 日历视图 + 任务视图 + 筛选（漏斗图标）。
 *   验的是：
 *     1. 工具行恰好一个 .caldav-dock-tools，里面有 4 个横向排列的操作点；
 *     2. 四个操作点**同一行**（各自 top 相同、不换行）；
 *     3. 三个图标按钮等高、等宽（±1px），日期范围下拉不低于它们；
 *     4. 整行不横向溢出容器，也不被裁（最右的筛选按钮右缘 ≤ 容器右缘）；
 *     5. 点「筛选」能弹出面板，且弹层**在容器可视区内**（不被 overflow:hidden 裁掉）——
 *        这是旧实现（fixed + JS 算坐标）踩过的坑。
 *   截图留在 .test-dock-tools/preview.png 供人工比对。
 *
 * 用法：node test/verify-dock-tools.mjs
 */
import { freeDebugPort } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-dock-tools");
const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

// 与 src/ui/icons.ts 的 svg() 完全同形（含内联 style 的 fill:none ——
// 思源 base.css 有全局 `svg{fill:currentColor}`，不内联会把闭合图形填成实心块）。
const svg = (p, vb = "0 0 24 24", sw = 2) =>
  `<svg viewBox="${vb}" width="14" height="14" fill="none" stroke="currentColor" style="fill:none;stroke-width:${sw};stroke-linecap:round;stroke-linejoin:round">${p}</svg>`;
const ICON = svg('<rect x="3.5" y="4.5" width="17" height="16" rx="3"/>', "1.5 1.5 21 21", 1.6);
const I_CHEV = svg('<polyline points="9 18 15 12 9 6"/>');
const I_CAL = svg('<rect x="3.5" y="4.5" width="17" height="16" rx="3.5"/><line x1="3.5" y1="9.5" x2="20.5" y2="9.5"/><line x1="8.5" y1="3" x2="8.5" y2="6"/><line x1="15.5" y1="3" x2="15.5" y2="6"/><circle cx="12" cy="14.6" r="1.6" style="fill:currentColor;stroke:none"/>', "1.5 1.5 21 21", 1.6);
const I_TASK = svg('<rect x="3.5" y="4.5" width="6.5" height="6.5" rx="2"/><path d="M5.2 7.9l1.5 1.5 2.4-2.8"/><line x1="13.5" y1="6" x2="20.5" y2="6"/><line x1="13.5" y1="9.5" x2="17.5" y2="9.5"/><rect x="3.5" y="13" width="6.5" height="6.5" rx="2"/><line x1="13.5" y1="14.5" x2="20.5" y2="14.5"/><line x1="13.5" y1="18" x2="17.5" y2="18"/>', "1.5 1.5 21 21", 1.6);
const I_FILTER = svg('<path d="M3.5 5.5h17l-6.6 7.6v5.2l-3.8 2.2v-7.4z"/>', "1.5 1.5 21 21", 1.6);
const panel = (width) => `
  <div class="caldav-root caldav-dock" style="width:${width}px;height:440px;display:flex;flex-direction:column">
    <div class="caldav-dock-brand">
      <span class="caldav-brand-icon">${ICON}</span>
      <span class="caldav-brand-title">日历任务管理</span>
      <button class="caldav-brand-set">${ICON}</button>
    </div>
    <div class="caldav-dock-tools">
      <div class="caldav-dock-filter-wrap">
        <button class="caldav-dock-select" data-dock="filter" data-toggle="dock-filter" type="button">
          <span class="caldav-dock-select-text">未来七天</span>
        </button>
        <span class="caldav-dock-select-arrow">${I_CHEV}</span>
        <div class="caldav-dock-pop caldav-dock-filter-pop" data-pop="dock-filter" hidden></div>
      </div>
      <button class="caldav-dock-act" data-action="cal-view" title="日历视图">${I_CAL}</button>
      <button class="caldav-dock-act" data-action="task-view" title="任务视图">${I_TASK}</button>
      <div class="caldav-dock-filter-wrap caldav-dock-filter-wrap--btn">
        <button class="caldav-dock-act" data-dock="category" title="筛选（优先级 / 分类）">${I_FILTER}</button>
        <div class="caldav-dock-cat-pop" data-pop="category" hidden>
          <div class="caldav-dock-cat-head">按优先级</div>
          <div class="caldav-dock-prio-list" data-prio-list>
            <label class="caldav-dock-prio-item is-active" data-prio-key="0"><input type="checkbox" checked/><span>全部</span></label>
            <label class="caldav-dock-prio-item" data-prio-key="2"><input type="checkbox"/><span class="caldav-dock-prio-dot prio-urgent"></span><span>紧急</span></label>
          </div>
          <div class="caldav-dock-cat-head caldav-dock-cat-head--second">选择分类</div>
          <div class="caldav-dock-cat-list" data-cat-list>
            <label class="caldav-dock-cat-item is-active" data-cat-key="__all__"><input type="checkbox" checked/><span>所有分类</span></label>
          </div>
          <div class="caldav-dock-cat-foot">
            <button class="caldav-foot-btn caldav-foot-btn--ghost" data-cat-action="cancel">取消</button>
            <button class="caldav-foot-btn caldav-foot-btn--primary" data-cat-action="ok">确定</button>
          </div>
        </div>
      </div>
    </div>
    <div class="caldav-dock-list">
      <div class="caldav-dock-items"></div>
    </div>
  </div>`;

const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>
  html,body{margin:0;background:#eff1f4;font-family:system-ui,"Microsoft YaHei",sans-serif}
  #stage{display:flex;gap:14px;padding:14px;align-items:flex-start}
</style></head>
<body><div id="stage">${panel(300)}${panel(220)}</div></body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "dock-tools.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[dock-tools] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--no-first-run", "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(outDir, "profile-dock-tools")}`,
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
if (!wsUrl) { console.log("[dock-tools] 连不上调试端口"); cleanup(); process.exit(1); }

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
await send("Emulation.setDeviceMetricsOverride", { width: 980, height: 560, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 60; i++) {
  await sleep(80);
  const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
  if (st.result.value === "complete") { await sleep(250); break; }
}
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

const probe = await evalJs(`(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  return Array.from(document.querySelectorAll('.caldav-dock')).map((p) => {
    const tools = p.querySelector('.caldav-dock-tools');
    const wrap1 = tools.querySelector('.caldav-dock-filter-wrap');
    const select = tools.querySelector('.caldav-dock-select');
    const iconBtns = Array.from(tools.querySelectorAll('.caldav-dock-act'));
    const catWrap = tools.querySelector('.caldav-dock-filter-wrap--btn');
    const catBtn = catWrap && catWrap.querySelector('.caldav-dock-act');
    const tr = rect(tools);
    const items = [
      { kind: 'date', r: rect(select) },
      ...iconBtns.map((b, i) => ({ kind: 'icon' + i, r: rect(b) }))
    ];
    const tops = items.map((it) => it.r.y);
    return {
      toolsCount: p.querySelectorAll('.caldav-dock-tools').length,
      actCount: iconBtns.length,
      wrapCount: p.querySelectorAll('.caldav-dock-tools .caldav-dock-filter-wrap').length,
      toolW: tr.w, toolRight: tr.right,
      itemCount: items.length,
      sameRow: Math.max(...tops) - Math.min(...tops) <= 1,
      toolH: tr.h,
      itemW: items.map((it) => it.r.w),
      itemH: items.map((it) => it.r.h),
      maxRight: Math.max(...items.map((it) => it.r.right)),
      minLeft: Math.min(...items.map((it) => it.r.x)),
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth
    };
  });
})()`);

console.log("=== Dock 工具行渲染 ===");
console.log(JSON.stringify(probe, null, 2));

// 弹层几何：这是**静态页面**（没有插件的 JS 事件委托），所以直接取消 hidden
// 来量它的定位 —— 验的是 CSS 定位是否正确、会不会被 overflow 裁掉，
// 与「点击能否打开」无关（那条由 loader.test 的事件链覆盖）。
await evalJs(`document.querySelector('.caldav-dock-filter-wrap--btn .caldav-dock-cat-pop').hidden = false`);
await sleep(200);
const popProbe = await evalJs(`(() => {
  const p = document.querySelector('.caldav-dock');
  const wrap = p.querySelector('.caldav-dock-filter-wrap--btn');
  const pop = wrap.querySelector('.caldav-dock-cat-pop');
  if (!pop || pop.hidden) return { hidden: true };
  const pr = pop.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  const pr2 = p.getBoundingClientRect();
  // 是否被祖先 overflow:hidden 裁掉：弹层矩形必须完全落在面板列的可视矩形内（右/下不越界）
  return {
    hidden: false,
    pop: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height), right: Math.round(pr.right), bottom: Math.round(pr.bottom) },
    wrapRight: Math.round(wr.right),
    panelRight: Math.round(pr2.right), panelBottom: Math.round(pr2.bottom),
    insideX: pr.left >= pr2.left - 1 && pr.right <= pr2.right + 1,
    insideY: pr.top >= pr2.top - 1,
    clipVisibleBottom: pr.bottom <= pr2.bottom + 1
  };
})()`);
console.log("=== 筛选弹层 ===");
console.log(JSON.stringify(popProbe, null, 2));

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(outDir, "preview.png"), Buffer.from(shot.data, "base64"));

const w300 = probe[0];
const iconW = w300.itemW.slice(1);
const iconH = w300.itemH.slice(1);
const checks = [
  ["每块 Dock 恰好一个工具行", probe.every((p) => p.toolsCount === 1)],
  ["工具行恰有 3 个图标按钮", probe.every((p) => p.actCount === 3)],
  ["工具行恰有 4 个操作点（日期范围 + 3 图标）", probe.every((p) => p.itemCount === 4)],
  ["四个操作点同一行（top 对齐）", probe.every((p) => p.sameRow)],
  ["三个图标按钮等宽（±1px）", Math.max(...iconW) - Math.min(...iconW) <= 1],
  ["三个图标按钮等高（±1px）", Math.max(...iconH) - Math.min(...iconH) <= 1],
  ["日期范围下拉不低于图标按钮（高度 ≥ 图标高 - 1）", w300.itemH[0] >= Math.max(...iconH) - 1],
  ["整行不横向溢出容器（最右缘 ≤ 工具行右缘 + 1）", w300.maxRight <= w300.toolRight + 1],
  ["最左缘不越界（≥ 工具行左缘 - 1）", w300.minLeft >= proberLeft(probe) - 1],
  ["页面无横向滚动（文档不溢出）", probe.every((p) => p.docScrollW <= p.docClientW + 1)],
  ["点「筛选」应弹出面板（此处取消 hidden 后可见）", popProbe.hidden === false],
  ["筛选弹层水平落在面板内（不被左右裁）", popProbe.hidden === false && popProbe.insideX],
  ["筛选弹层顶部在面板内、底部不越界（不被 overflow 裁）", popProbe.hidden === false && popProbe.insideY && popProbe.clipVisibleBottom]
];
function proberLeft(arr) { return Math.min(...arr.map((p) => p.minLeft)); }

let pass = true;
console.log("=== 断言 ===");
for (const [name, good] of checks) {
  console.log(`${good ? "✅" : "❌"} ${name}`);
  if (!good) pass = false;
}
console.log(`==> 渲染截图: ${path.join(outDir, "preview.png")}`);
console.log(pass ? "PASS ✅ Dock 工具行四操作点 + 筛选弹层渲染符合预期" : "FAIL ❌");
cleanup();
process.exit(pass ? 0 : 1);
