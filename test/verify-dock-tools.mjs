/**
 * Dock 工具行的真实渲染验证（手动跑）。2026-10-10 / 0.2.19 改版：
 *
 *   一行三个操作点：日期范围下拉框（占 2.7fr）+ 筛选（漏斗图标）+ 打开视图（打勾日历图标）。
 *   日历视图 / 任务视图两个按钮已合并为「打开视图」，点击打开主窗口上次用的视图；
 *   腾出的空间让日期范围下拉框能完整显示文案。筛选与打开视图左右已互换（筛选靠前）。
 *
 *   筛选弹层（.caldav-dock-cat-pop）现为 **body 级、position:fixed**，由 JS 算坐标定位，
 *   默认贴按钮右侧；右侧放不下时自动翻到左侧（自动检测视口边距）。本脚本验的是：
 *     1. 工具行恰好一个 .caldav-dock-tools，里面有 3 个横向排列的操作点；
 *     2. 三个操作点**同一行**（各自 top 相同、不换行）；
 *     3. 两个图标按钮等高、等宽（±1px），日期范围下拉不低于它们；
 *     4. 整行不横向溢出容器，也不被裁（最右的操作点右缘 ≤ 工具行右缘）；
 *     5. 弹层挂在 body、position:fixed，且能拿到 --d-* 变量（否则边框退化成 currentColor）；
 *     6. 翻转动向正确：
 *        - 左侧 Dock（右侧有富余）→ 弹层落在按钮**右侧**、且整体在视口内；
 *        - 右侧 Dock（右侧放不下）→ 弹层自动翻到按钮**左侧**、且整体在视口内。
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
// 合并后的「打开视图」按钮：打勾的日历（icons.calCheck）——勾为描边折线
const I_CALCHECK = svg('<rect x="3.5" y="4.5" width="17" height="16" rx="3.5"/><line x1="3.5" y1="9.5" x2="20.5" y2="9.5"/><line x1="8.5" y1="3" x2="8.5" y2="6"/><line x1="15.5" y1="3" x2="15.5" y2="6"/><polyline points="8.8 15.1 10.9 17.2 15.2 12.6"/>', "1.5 1.5 21 21", 1.6);
const I_FILTER = svg('<path d="M3.5 5.5h17l-6.6 7.6v5.2l-3.8 2.2v-7.4z"/>', "1.5 1.5 21 21", 1.6);

// 单个 Dock 面板（不含筛选弹层 —— 弹层是 body 级，单独挂）。
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
      <div class="caldav-dock-filter-wrap caldav-dock-filter-wrap--btn">
        <button class="caldav-dock-act" data-dock="category" title="筛选（优先级 / 分类）" aria-label="筛选">${I_FILTER}</button>
      </div>
      <button class="caldav-dock-act" data-action="open-view" title="打开上次视图" aria-label="打开上次视图">${I_CALCHECK}</button>
    </div>
    <div class="caldav-dock-list">
      <div class="caldav-dock-items"></div>
    </div>
  </div>`;

// body 级筛选弹层（同 panel.ts 的产物：position:fixed，变量块挂在 .caldav-dock-cat-pop 上）
const bodyPop = `
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
  </div>`;

// 左侧 Dock（右侧有富余，弹层应向右）；右侧 Dock 用 absolute 贴到视口右边（右侧放不下，弹层应翻左）。
const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>
  html,body{margin:0;background:#eff1f4;font-family:system-ui,"Microsoft YaHei",sans-serif}
  #stage{position:relative;display:flex;gap:14px;padding:14px;align-items:flex-start}
  .right-col{position:absolute;top:14px;right:10px}
</style></head>
<body><div id="stage">${panel(300)}<div class="right-col">${panel(300)}</div></div>${bodyPop}</body></html>`;

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

// 工具行布局探针（复用 loader.test 的口径）
const probe = await evalJs(`(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  return Array.from(document.querySelectorAll('.caldav-dock')).map((p) => {
    const tools = p.querySelector('.caldav-dock-tools');
    const select = tools.querySelector('.caldav-dock-select');
    const iconBtns = Array.from(tools.querySelectorAll('.caldav-dock-act'));
    const tr = rect(tools);
    const items = [
      { kind: 'date', r: rect(select) },
      ...iconBtns.map((b, i) => ({ kind: 'icon' + i, r: rect(b) }))
    ];
    const tops = items.map((it) => it.r.y);
    const pop = document.querySelector('.caldav-dock-cat-pop');
    const popCs = getComputedStyle(pop);
    return {
      toolsCount: p.querySelectorAll('.caldav-dock-tools').length,
      actCount: iconBtns.length,
      wrapCount: p.querySelectorAll('.caldav-dock-tools .caldav-dock-filter-wrap').length,
      hasOpenView: !!tools.querySelector('[data-action="open-view"]'),
      toolW: tr.w, toolRight: tr.right,
      itemCount: items.length,
      sameRow: Math.max(...tops) - Math.min(...tops) <= 1,
      // 左右顺序：日期范围 < 筛选 < 打开视图（筛选与打开视图已互换）
      orderOk: items[0].r.x < items[1].r.x && items[1].r.x < items[2].r.x,
      toolH: tr.h,
      itemW: items.map((it) => it.r.w),
      itemH: items.map((it) => it.r.h),
      maxRight: Math.max(...items.map((it) => it.r.right)),
      minLeft: Math.min(...items.map((it) => it.r.x)),
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      popOnBody: pop.parentElement === document.body,
      popPosition: popCs.position,
      popVarDborder: popCs.getPropertyValue('--d-border').trim()
    };
  });
})()`);

console.log("=== Dock 工具行渲染 ===");
console.log(JSON.stringify(probe, null, 2));

// 翻转动向：把 body 弹层按真实 placeCatPop() 定位到每个 Dock 的筛选按钮，再量实测矩形。
// 复刻 panel.ts 的 placeCatPop：默认贴右，右侧放不下翻左，两侧都不够夹在视口内。
const flip = await evalJs(`(() => {
  const POP_GAP = 8, VIEW_PAD = 8;
  function place(btn) {
    const pop = document.querySelector('.caldav-dock-cat-pop');
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let left = r.right + POP_GAP;
    if (left + w > vw - VIEW_PAD) {
      const onLeft = r.left - POP_GAP - w;
      left = onLeft >= VIEW_PAD ? onLeft : Math.max(VIEW_PAD, vw - VIEW_PAD - w);
    }
    let top = r.top;
    if (top + h > vh - VIEW_PAD) top = vh - VIEW_PAD - h;
    if (top < VIEW_PAD) top = VIEW_PAD;
    // 应用并实测
    pop.hidden = false;
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
    const pr = pop.getBoundingClientRect();
    return {
      btnRight: Math.round(r.right), btnLeft: Math.round(r.left),
      estLeft: Math.round(left),
      popLeft: Math.round(pr.left), popRight: Math.round(pr.right), popTop: Math.round(pr.top), popBottom: Math.round(pr.bottom),
      vw: vw, vh: vh
    };
  }
  const docks = Array.from(document.querySelectorAll('.caldav-dock'));
  return docks.map((d) => { const b = d.querySelector('[data-dock="category"]'); return place(b); });
})()`);

console.log("=== 筛选弹层翻转定位 ===");
console.log(JSON.stringify(flip, null, 2));

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(outDir, "preview.png"), Buffer.from(shot.data, "base64"));

// ---- 断言 ----
const left = probe[0];                 // 左侧 Dock：右侧有富余
const rightDock = probe[1];            // 右侧 Dock：贴视口右缘，右侧放不下
const leftFlip = flip[0];
const rightFlip = flip[1];

const checks = [
  ["每块 Dock 恰好一个工具行", probe.every((p) => p.toolsCount === 1)],
  ["工具行恰有 2 个图标按钮（打开视图 / 筛选）", probe.every((p) => p.actCount === 2)],
  ["工具行恰有 3 个操作点（日期范围 + 2 图标）", probe.every((p) => p.itemCount === 3)],
  ["存在合并后的「打开视图」按钮", probe.every((p) => p.hasOpenView)],
  ["操作点左右顺序为 日期范围 → 筛选 → 打开视图", probe.every((p) => p.orderOk)],
  ["三个操作点同一行（top 对齐）", probe.every((p) => p.sameRow)],
  ["两个图标按钮等宽（±1px）", Math.max(...left.itemW.slice(1)) - Math.min(...left.itemW.slice(1)) <= 1],
  ["两个图标按钮等高（±1px）", Math.max(...left.itemH.slice(1)) - Math.min(...left.itemH.slice(1)) <= 1],
  ["日期范围下拉不低于图标按钮（高度 ≥ 图标高 - 1）", left.itemH[0] >= Math.max(...left.itemH.slice(1)) - 1],
  ["整行不横向溢出容器（最右缘 ≤ 工具行右缘 + 1）", left.maxRight <= left.toolRight + 1],
  ["最左缘不越界（≥ 工具行左缘 - 1）", left.minLeft >= Math.min(...probe.map((p) => p.minLeft)) - 1],
  ["页面无横向滚动（文档不溢出）", probe.every((p) => p.docScrollW <= p.docClientW + 1)],
  ["筛选弹层挂在 body（脱离 overflow 裁剪链）", probe.every((p) => p.popOnBody)],
  ["筛选弹层为 position:fixed", probe.every((p) => p.popPosition === "fixed")],
  ["筛选弹层能拿到 --d-* 变量（边框用 --d-border，不退化为 currentColor）", probe.every((p) => p.popVarDborder.length > 0)],
  // 翻转：左侧 Dock 弹层落右侧、整体在视口内
  ["左侧 Dock：弹层贴按钮右侧（estLeft ≈ btnRight + 8）", leftFlip.estLeft === leftFlip.btnRight + 8],
  ["左侧 Dock：弹层整体在视口内（右缘 ≤ vw - 8 + 1、左缘 ≥ 8 - 1）", leftFlip.popRight <= leftFlip.vw - 8 + 1 && leftFlip.popLeft >= 8 - 1],
  // 翻转：右侧 Dock 弹层翻到左侧、整体在视口内
  ["右侧 Dock：弹层翻到按钮左侧（estLeft ≈ btnLeft - 8 - popW）", rightFlip.estLeft === Math.round(rightFlip.btnLeft - 8 - (rightFlip.popRight - rightFlip.popLeft))],
  ["右侧 Dock：弹层整体在视口内（左缘 ≥ 8 - 1、右缘 ≤ btnLeft + 1）", rightFlip.popLeft >= 8 - 1 && rightFlip.popRight <= rightFlip.btnLeft + 1]
];

let pass = true;
console.log("=== 断言 ===");
for (const [name, good] of checks) {
  console.log(`${good ? "✅" : "❌"} ${name}`);
  if (!good) pass = false;
}
console.log(`==> 渲染截图: ${path.join(outDir, "preview.png")}`);
console.log(pass ? "PASS ✅ Dock 工具行三操作点 + 筛选弹层翻转定位符合预期" : "FAIL ❌");
cleanup();
process.exit(pass ? 0 : 1);
