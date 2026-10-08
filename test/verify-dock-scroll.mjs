/**
 * Dock 滚动条 + 「日历视图中显示待办任务」开关的真实渲染验证（手动跑）。
 *
 * 为什么必须用真浏览器：::-webkit-scrollbar 系列伪元素 jsdom 完全不认，
 * 「平时透明、悬停显形」只能靠 Chromium 的计算样式 / 截图来验。
 * 本机无 Edge/Chrome 时跳过。
 *
 * 覆盖：
 *   1. 滚动条轨道透明、滑块默认透明、两端箭头 display:none；
 *   2. 强制 :hover 后滑块变成半透明主题色（显形）；
 *   3. 开关行落在浮层里、单行不换行、开关贴右、浮层不横向溢出；
 *   4. 浮层里第二层联动开关（「任务视图中显示过期日程」）：hidden 时真的是
 *      display:none（`.caldav-switch-line{display:flex}` 会盖掉 UA 的 [hidden]，必须自证）、
 *      展开后缩进 18px 且文字变淡 —— 缩进要防 `.caldav-calfilter-opt` 的
 *      padding 简写把 padding-left 吃掉（Obsidian 侧就是这么坏的）。
 */
import { freeDebugPort } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-dock-scroll");
const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

const items = Array.from({ length: 12 }, (_, i) => `<div class="t-item">任务条目 ${i + 1}</div>`).join("");

const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>
  html,body{margin:0;padding:0;background:#fff;font-family:system-ui,"Microsoft YaHei",sans-serif}
  #stage{padding:16px;display:flex;gap:24px;align-items:flex-start}
  .t-item{padding:10px 8px;border-bottom:1px solid #eee;font-size:13px}
  #popwrap{position:relative;width:280px}
  #dockbox{width:240px;height:220px;display:flex;flex-direction:column;border:1px solid #ddd}
</style></head>
<body>
<div id="stage">
  <div id="popwrap" class="caldav-root caldav-app">
    <div class="caldav-calfilter-wrap">
      <div class="caldav-calfilter-pop">
        <div class="caldav-cal-head">日历筛选</div>
        <div class="caldav-cal-list">
          <div class="caldav-cal-item" data-cal="0">
            <span class="caldav-cal-dot" style="background:#3b82f6"></span>
            <span class="caldav-cal-name">工作</span>
            <button class="caldav-icon-btn caldav-cal-toggle" type="button">👁</button>
          </div>
          <div class="caldav-cal-item" data-cal="1">
            <span class="caldav-cal-dot" style="background:#10b981"></span>
            <span class="caldav-cal-name">个人</span>
            <button class="caldav-icon-btn caldav-cal-toggle" type="button">👁</button>
          </div>
        </div>
        <label class="caldav-switch-line caldav-switch-line--inline caldav-calfilter-opt" id="opt">
          <span class="caldav-switch-label">日历视图中显示待办任务</span>
          <span class="caldav-switch">
            <input type="checkbox" data-opt="showTodos" checked>
            <span class="caldav-switch-track" id="track"></span>
          </span>
        </label>
        <!-- 任务视图的两个开关（与 panel.ts 模板同构；第三行初始 hidden） -->
        <label class="caldav-switch-line caldav-switch-line--inline caldav-calfilter-opt" id="optEvents">
          <span class="caldav-switch-label">任务视图中显示日程事件</span>
          <span class="caldav-switch">
            <input type="checkbox" data-opt="showEvents">
            <span class="caldav-switch-track"></span>
          </span>
        </label>
        <label class="caldav-switch-line caldav-switch-line--inline caldav-calfilter-opt caldav-switch-line--nested"
               id="optExpired" data-opt-row="showExpired" hidden>
          <span class="caldav-switch-label">任务视图中显示过期日程</span>
          <span class="caldav-switch">
            <input type="checkbox" data-opt="showExpired">
            <span class="caldav-switch-track"></span>
          </span>
        </label>
        <div class="caldav-calfilter-foot" id="foot">
          <button class="caldav-link" data-action="insert-diary">把今日日程与待办插入日记</button>
        </div>
      </div>
    </div>
  </div>
  <div id="dockbox" class="caldav-dock">
    <div class="caldav-dock-list" id="list">${items}</div>
  </div>
</div>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "dock-scroll.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[dock-scroll] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  // 注意：这里**不能**加 --hide-scrollbars，否则滚动条根本不渲染，验了个寂寞
  "--no-first-run", "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(outDir, "profile-dock-scroll")}`,
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
if (!wsUrl) { console.log("[dock-scroll] 连不上调试端口"); cleanup(); process.exit(1); }

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
await send("DOM.enable");
await send("CSS.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 420, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 60; i++) {
  await sleep(80);
  const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
  if (st.result.value === "complete") { await sleep(250); break; }
}

// DOM.getDocument 只能调一次：nodeId 绑定在这次调用上，重复调用会让旧 id 失效
const { root: docRoot } = await send("DOM.getDocument");
const nodeIdOf = async (sel) => (await send("DOM.querySelector", { nodeId: docRoot.nodeId, selector: sel })).nodeId;

const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

/** 取某个滚动条伪元素的计算样式（Chromium 支持第二参数传伪元素） */
const sbStyle = async (sel, pseudo, prop) =>
  evalJs(`getComputedStyle(document.querySelector('${sel}'), '${pseudo}').${prop}`);

console.log("=== 滚动条伪元素计算样式 ===");
const trackBg = await sbStyle("#list", "::-webkit-scrollbar-track", "backgroundColor");
const thumbBg = await sbStyle("#list", "::-webkit-scrollbar-thumb", "backgroundColor");
const btnDisplay = await sbStyle("#list", "::-webkit-scrollbar-button", "display");
const sbWidth = await sbStyle("#list", "::-webkit-scrollbar", "width");
console.log("track      :", trackBg);
console.log("thumb      :", thumbBg);
console.log("button     :", btnDisplay);
console.log("bar width  :", sbWidth);

// 强制 :hover 再取一次滑块颜色（`.caldav-dock-list:hover::-webkit-scrollbar-thumb`）
const listId = await nodeIdOf("#list");
await send("CSS.forcePseudoState", { nodeId: listId, forcedPseudoClasses: ["hover"] });
await sleep(120);
const thumbHoverBg = await sbStyle("#list", "::-webkit-scrollbar-thumb", "backgroundColor");
await send("CSS.forcePseudoState", { nodeId: listId, forcedPseudoClasses: [] });
console.log("thumb+hover:", thumbHoverBg);

// 思源外层容器同款规则（这里用一个自造的滚动容器模拟 .caldav-scroll-host）
await evalJs(`(() => {
  const d = document.createElement('div');
  d.id = 'host'; d.className = 'caldav-scroll-host';
  d.style.cssText = 'width:200px;height:120px;overflow-y:auto';
  d.innerHTML = '${items.replace(/'/g, "\\'")}';
  document.getElementById('stage').appendChild(d);
})()`);
const hostThumb = await sbStyle("#host", "::-webkit-scrollbar-thumb", "backgroundColor");
const hostBtn = await sbStyle("#host", "::-webkit-scrollbar-button", "display");
console.log("host thumb :", hostThumb, "| host button:", hostBtn);
const hostId = await nodeIdOf("#host");
await send("CSS.forcePseudoState", { nodeId: hostId, forcedPseudoClasses: ["hover"] });
await sleep(120);
const hostThumbHover = await sbStyle("#host", "::-webkit-scrollbar-thumb", "backgroundColor");
await send("CSS.forcePseudoState", { nodeId: hostId, forcedPseudoClasses: [] });
console.log("host thumb+hover:", hostThumbHover);

// ---- 开关行几何 ----
const geom = await evalJs(`(() => {
  const pop = document.querySelector('.caldav-calfilter-pop');
  const opt = document.getElementById('opt');
  const track = document.getElementById('track');
  const foot = document.getElementById('foot');
  const list = document.querySelector('.caldav-cal-list');
  const pr = pop.getBoundingClientRect();
  const or = opt.getBoundingClientRect();
  const tr = track.getBoundingClientRect();
  const fr = foot.getBoundingClientRect();
  const lr = list.getBoundingClientRect();
  const cs = getComputedStyle(pop);
  const inner = pr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return {
    popW: pr.width, inner: inner,
    optLeft: or.left - pr.left - parseFloat(cs.paddingLeft),
    optW: or.width, optH: or.height,
    trackRight: tr.right - pr.left - parseFloat(cs.paddingRight),
    trackRightGap: (pr.right - parseFloat(cs.paddingRight)) - tr.right,
    order: (lr.bottom <= or.top + 0.5) && (or.bottom <= fr.top + 0.5),
    overflowX: pop.scrollWidth - pop.clientWidth,
    labelLines: or.height
  };
})()`);
console.log("=== 开关行几何 ===");
console.log(JSON.stringify(geom, null, 2));

// ---- 第二层联动开关：hidden 是否真生效 + 缩进有没有被 padding 简写吃掉 ----
const nested = await evalJs(`(() => {
  const row = document.getElementById('optExpired');
  const pop = document.querySelector('.caldav-calfilter-pop');
  const hiddenDisplay = getComputedStyle(row).display;   // 仍带 hidden
  row.hidden = false;                                    // 展开看一眼真实样式
  const cs = getComputedStyle(row);
  const out = {
    hiddenDisplay,
    shownDisplay: cs.display,
    paddingLeft: cs.paddingLeft,
    color: cs.color,
    labelFont: getComputedStyle(row.querySelector('.caldav-switch-label')).fontSize,
    mainPaddingLeft: getComputedStyle(document.getElementById('opt')).paddingLeft,
    mainColor: getComputedStyle(document.getElementById('opt')).color,
    overflowX: pop.scrollWidth - pop.clientWidth
  };
  row.hidden = true;                                     // 复原，不影响别的断言
  return out;
})()`);
console.log("=== 第二层联动开关 ===");
console.log(JSON.stringify(nested, null, 2));

const isTransparent = (v) => /^rgba\(0,\s*0,\s*0,\s*0\)$/i.test(v) || v === "transparent" || v === "";
/**
 * 注意：Chromium 把 color-mix() 序列化成 `color(srgb r g b / a)`（分量是 0~1 的小数），
 * 不是 rgba()。只认 rgba 会把「显形后的滑块」误判成不透明 → 断言假阴性。
 */
const alpha = (v) => {
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (rgba) {
    const p = rgba[1].split(",").map((s) => parseFloat(s));
    return p.length > 3 ? p[3] : 1;
  }
  const col = /^color\(([^)]+)\)$/i.exec(v);
  if (col) {
    const slash = col[1].split("/");
    return slash.length > 1 ? parseFloat(slash[1]) : 1;
  }
  return 1;
};

const checks = [
  ["滚动条宽度被接管（8px）", sbWidth === "8px"],
  ["轨道透明", isTransparent(trackBg)],
  ["滑块默认透明（平时看不见）", isTransparent(thumbBg) || alpha(thumbBg) === 0],
  ["两端箭头已隐藏", btnDisplay === "none"],
  ["悬停后滑块显形（半透明色）", !isTransparent(thumbHoverBg) && alpha(thumbHoverBg) > 0 && alpha(thumbHoverBg) < 1],
  ["思源外层容器滑块默认透明", isTransparent(hostThumb) || alpha(hostThumb) === 0],
  ["思源外层容器悬停显形", !isTransparent(hostThumbHover) && alpha(hostThumbHover) > 0],
  ["思源外层容器箭头也隐藏", hostBtn === "none"],
  ["开关行排在列表之后、页脚之前", geom.order === true],
  ["开关是单行（高度 < 40px）", geom.optH > 0 && geom.optH < 40],
  ["开关贴浮层右侧（右间隙 ≤ 2px）", geom.trackRightGap >= -0.5 && geom.trackRightGap <= 2],
  ["浮层无横向溢出", geom.overflowX <= 1],
  ["第二层带 hidden 时 display 真的是 none（flex 没盖掉 UA 规则）", nested.hiddenDisplay === "none"],
  ["展开后 display 为 flex", nested.shownDisplay === "flex"],
  ["展开后缩进 18px（没被 .caldav-calfilter-opt 的 padding 简写吃掉）", nested.paddingLeft === "18px"],
  ["缩进确实比主行深", parseFloat(nested.mainPaddingLeft) === 0 && parseFloat(nested.paddingLeft) > 0],
  ["第二层文字比主行淡（从属关系）", nested.color !== nested.mainColor],
  ["三行全展开时浮层仍无横向溢出", nested.overflowX <= 1]
];

let pass = true;
console.log("=== 断言 ===");
for (const [name, ok] of checks) {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) pass = false;
}
console.log(pass ? "PASS ✅ Dock 滚动条与筛选开关渲染符合预期" : "FAIL ❌");
cleanup();
process.exit(pass ? 0 : 1);
