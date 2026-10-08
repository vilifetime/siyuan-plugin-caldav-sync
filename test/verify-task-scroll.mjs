/**
 * 任务视图「双滚动条」几何验证（手动跑：node test/verify-task-scroll.mjs）。
 *
 * 用户报的现象：任务视图面板右侧出现**两条**竖向滚动条
 * （一条贴着 720px 内容列，一条贴着面板最右边）。
 *
 * 怀疑：插件自己的 DOM 里有两层嵌套滚动容器 ——
 *   `.caldav-view`  { flex:1; overflow:auto }          ← 视图槽
 *   `.cal-task-view`{ height:100%; overflow:auto }     ← 任务视图自身
 * 只要内层内容溢出，两层各画一条，就出现双条。
 *
 * 本脚本按 renderPanel() 的真实结构复刻页面（真 dist/index.css），
 * 枚举**所有**「可滚动且内容确实溢出」的元素，报告数量与位置。
 *
 * 断言：
 *   1. 全页处于溢出状态的纵向滚动容器**有且只有 1 个**；
 *   2. 它是 `.caldav-view`（视图槽），不是 `.cal-task-view`；
 *   3. `.cal-task-view` 不再自己滚动（scrollHeight ≈ clientHeight）；
 *   4. 唯一那条滚动条贴在面板右边缘（距 stage 右边 ≤ 20px）。
 *
 * 本机无 Edge/Chrome 时打印提示并退出 0。
 */
import { freeDebugPort } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-task-scroll");
const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

const STAGE_W = 1050;
const STAGE_H = 700;

/* ---------- 复刻 view-task.ts 的分组列表标记 ---------- */
const item = (i, extraCls = "") => `
<div class="cal-task is-todo ${extraCls}" data-open="t${i}" style="--cal-color:#3b82f6">
  <button class="cal-task-check" data-toggle="t${i}" title="标记完成"></button>
  <div class="cal-task-body">
    <div class="cal-task-title"><span class="cal-task-kind is-todo">待办</span>示例任务 ${i}</div>
    <div class="cal-task-meta">
      <span>逾期 ${i} 天</span>
      <span class="cal-task-cal"><i style="background:#3b82f6"></i>CalDAV</span>
    </div>
  </div>
</div>`;

const group = (key, label, color, n, cls) => `
<div class="cal-task-group" data-group="${key}">
  <div class="cal-task-group-head" data-toggle-group="${key}" role="button" tabindex="0"
       style="--group-color:${color}" aria-expanded="true" title="折叠">
    <span class="cal-task-group-caret" aria-hidden="true">▾</span>
    <span class="cal-task-group-dot" style="background:${color}"></span>
    <span class="cal-task-group-label">${label}</span>
    <span class="cal-task-group-count">${n}</span>
  </div>
  <div class="cal-task-group-body">${Array.from({ length: n }, (_, i) => item(`${key}-${i}`, cls)).join("")}</div>
</div>`;

const groups =
  group("overdue", "逾期", "#e5484d", 3, "is-overdue") +
  group("today", "今天", "#3575f0", 2) +
  group("tomorrow", "明天", "#5b8def", 3) +
  group("thisweek", "本周", "#8b8b8b", 3) +
  group("later", "下周后", "#8b8b8b", 4) +
  group("nodate", "无日期", "#a0a0a0", 5);

const stats = [
  ["cal-stat-total", "待办", 9],
  ["cal-stat-today", "今日", 0],
  ["cal-stat-overdue", "逾期", 3],
  ["cal-stat-future", "未来", 2],
  ["cal-stat-nodate", "无日期", 4],
  ["cal-stat-done", "已完成", 183]
]
  .map(([c, l, n]) => `<div class="cal-task-stat ${c}"><b>${n}</b><span>${l}</span></div>`)
  .join("");

/* 与 panel.ts renderPanel() 同构 */
const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>
  html,body{margin:0;padding:0;background:#fff;font-family:system-ui,"Microsoft YaHei",sans-serif}
  #stage{width:${STAGE_W}px;height:${STAGE_H}px;position:relative;border:1px solid #ccc}
</style></head>
<body>
<div id="stage">
<div class="caldav-root">
  <div class="caldav-app caldav-app--flat is-task">
    <main class="caldav-main">
      <header class="caldav-toolbar">
        <div class="caldav-toolbar-left">
          <button class="caldav-icon-btn" data-action="prev">‹</button>
          <button class="caldav-btn" data-action="today">今天</button>
          <span class="caldav-cursor-title"></span>
        </div>
        <div class="caldav-toolbar-center">
          <div class="caldav-seg" role="tablist">
            <button class="caldav-seg-btn" data-view="year">年</button>
            <button class="caldav-seg-btn" data-view="month">月</button>
            <button class="caldav-seg-btn is-active" data-view="week">周</button>
            <button class="caldav-seg-btn" data-view="day">日</button>
          </div>
        </div>
        <div class="caldav-toolbar-stats" data-slot="task-stats">${stats}</div>
        <div class="caldav-toolbar-right">
          <button class="caldav-btn caldav-btn-primary" data-action="new-event">+ 日程</button>
          <button class="caldav-btn" data-action="new-todo">+ 待办</button>
          <button class="caldav-icon-btn" data-action="calfilter" title="日历筛选">▤</button>
          <button class="caldav-icon-btn" data-action="toggle-view" title="切换到任务视图"></button>
        </div>
      </header>
      <div class="caldav-view">
        <div class="cal-task-view">
          <div class="cal-task-filterbar">
            <select class="cal-task-filter" data-filter title="按条件筛选">
              <option selected>所有未完成 (9)</option>
            </select>
            <input class="caldav-input cal-task-quick" placeholder="快速添加待办，回车保存（默认今天）…" data-quickadd/>
          </div>
          <div class="cal-task-list">${groups}</div>
        </div>
      </div>
    </main>
  </div>
</div>
</div>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "task-scroll.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[task-scroll] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  // 不能加 --hide-scrollbars：那会让滚动条不渲染，验了个寂寞
  "--no-first-run", "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(outDir, "profile-task-scroll")}`,
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
if (!wsUrl) { console.log("[task-scroll] 连不上调试端口"); cleanup(); process.exit(1); }

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
await send("Emulation.setDeviceMetricsOverride", {
  width: STAGE_W + 40, height: STAGE_H + 40, deviceScaleFactor: 1, mobile: false
});
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 60; i++) {
  await sleep(80);
  const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
  if (st.result.value === "complete") { await sleep(250); break; }
}
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

/* 枚举所有「overflow 可滚动 且 内容确实超出」的元素 */
const report = await evalJs(`(() => {
  const stage = document.getElementById('stage').getBoundingClientRect();
  const out = [];
  document.querySelectorAll('#stage *').forEach((el) => {
    const cs = getComputedStyle(el);
    const scrollable = /auto|scroll/.test(cs.overflowY);
    if (!scrollable) return;
    const r = el.getBoundingClientRect();
    out.push({
      sel: el.className || el.tagName,
      overflowY: cs.overflowY,
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      overflowing: el.scrollHeight > el.clientHeight + 1,
      right: Math.round(r.right),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      distToStageRight: Math.round(stage.right - r.right)
    });
  });
  const tv = document.querySelector('.cal-task-view');
  const cv = document.querySelector('.caldav-view');
  return {
    stageRight: Math.round(stage.right),
    scrollContainers: out,
    overflowing: out.filter((x) => x.overflowing),
    taskView: { scrollH: tv.scrollHeight, clientH: tv.clientHeight },
    caldavView: { scrollH: cv.scrollHeight, clientH: cv.clientHeight }
  };
})()`);

console.log("=== 页面里的滚动容器 ===");
for (const c of report.scrollContainers) {
  console.log(
    `${c.overflowing ? "溢出 ✗" : "未溢出  "} ${c.sel}` +
    `  scrollH=${c.scrollH} clientH=${c.clientH}` +
    `  overflowY=${c.overflowY}  右缘=${c.right}(距面板右 ${c.distToStageRight}px)`
  );
}
console.log("");
console.log(`溢出中的滚动容器数量：${report.overflowing.length}`);
console.log(`.caldav-view   : scrollH=${report.caldavView.scrollH} clientH=${report.caldavView.clientH}`);
console.log(`.cal-task-view : scrollH=${report.taskView.scrollH} clientH=${report.taskView.clientH}`);

const problems = [];
if (report.overflowing.length !== 1) {
  problems.push(`应有且只有 1 个溢出的滚动容器，实际 ${report.overflowing.length} 个：${report.overflowing.map((x) => x.sel).join(" + ")}`);
} else if (!String(report.overflowing[0].sel).includes("caldav-view")) {
  problems.push(`唯一的滚动容器应是 .caldav-view，实际是 ${report.overflowing[0].sel}`);
}
if (report.taskView.scrollH > report.taskView.clientH + 1) {
  problems.push(`.cal-task-view 不应自己滚动（scrollH=${report.taskView.scrollH} > clientH=${report.taskView.clientH}）`);
}
if (report.overflowing.length === 1 && report.overflowing[0].distToStageRight > 20) {
  problems.push(`唯一滚动条应贴面板右缘，实际距右缘 ${report.overflowing[0].distToStageRight}px`);
}

console.log("");
if (problems.length) {
  console.log("❌ 失败：");
  for (const p of problems) console.log("  - " + p);
} else {
  console.log("✅ 通过：单条滚动条，贴在面板右缘，任务视图自身不滚动");
}
cleanup();
process.exit(problems.length ? 1 : 0);
