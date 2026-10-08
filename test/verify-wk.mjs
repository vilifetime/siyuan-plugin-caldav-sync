/**
 * 周/日视图几何验证（不进正式 npm test，手动跑）：
 *   手造等价于 view-week.ts 输出的 .cal-wk 结构（7 列；周一 1 个全天事件；
 *   周三 1 个 09:00–10:00 定时事件），注入 dist/index.css，用 Edge CDP 量：
 *     - 表头 / 全天区 / 时间网格 三区的「第 0 列」左边界 x 是否一致（问题2 对齐）
 *     - 周三 09:00 事件块顶部 y 是否等于左侧 09:00 刻度 y（问题3 时间线对齐）
 *   本机无 Edge 时打印提示并退出 0。
 */
import { freeDebugPort } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-wk");

const WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const DAYS = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"];

const dayHead = DAYS.map((d, i) =>
  `<div class="cal-wk-dayhead ${d === "2026-09-20" ? "is-today" : ""}" data-day="${d}">
     <span class="cal-wk-wd">${WEEK[i]}</span><span class="cal-wk-num">${+d.slice(8, 10)}</span></div>`
).join("");

const hours = [];
for (let h = 0; h < 24; h++) hours.push(`<div class="cal-wk-hour" style="height:44px"><span>${String(h).padStart(2, "0")}:00</span></div>`);

// 全天事件仅在周一
const allDayCells = DAYS.map((d) => {
  const chips = d === "2026-09-14"
    ? `<div class="cal-chip cal-chip-allday" data-open="x" style="--cal-color:#3b82f6"><span class="cal-chip-title">全天示例</span></div>`
    : "";
  return `<div class="cal-wk-allday-cell" data-day="${d}">${chips}</div>`;
}).join("");

// 时间网格：周三放一个 09:00 事件
const cols = DAYS.map((d) => {
  const inner = d === "2026-09-16"
    ? `<div class="cal-wk-block" data-open="ev1" style="--cal-color:#3b82f6;top:${((9 * 60) / 1440) * 100}%;height:${((60) / 1440) * 100}%">
         <div class="cal-wk-block-time">09:00</div>
         <div class="cal-wk-block-title">晨会</div>
       </div>`
    : "";
  return `<div class="cal-wk-col" data-day="${d}">${inner}</div>`;
}).join("");

const pageHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/")}">
<style>html,body{margin:0;padding:0;font-family:system-ui,"Microsoft YaHei",sans-serif}
#box{width:1000px;height:720px;border:1px solid #ccc}
</style></head>
<body>
<div id="box">
<div class="cal-wk" style="--cols:7">
  <div class="cal-wk-header">
    <div class="cal-wk-gutterhead"></div>
    <div class="cal-wk-days">${dayHead}</div>
  </div>
  <div class="cal-wk-allday">
    <div class="cal-wk-allday-label">全天</div>
    <div class="cal-wk-allday-cells">${allDayCells}</div>
  </div>
  <div class="cal-wk-main">
    <div class="cal-wk-gutter">${hours.join("")}</div>
    <div class="cal-wk-grid" style="height:${24 * 44}px">${cols}</div>
  </div>
</div>
</div>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "wk.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[wk] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--no-first-run", "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(outDir, "profile")}`,
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
if (!wsUrl) { console.log("[wk] 连不上调试端口"); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let nextId = 1; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });

await send("Page.enable");
await send("Runtime.enable");

const MEASURE = `(() => {
  const L = (sel) => { const e = document.querySelector(sel); return e ? +e.getBoundingClientRect().left.toFixed(1) : null; };
  const T = (sel) => { const e = document.querySelector(sel); return e ? +e.getBoundingClientRect().top.toFixed(1) : null; };
  const dayheads = [...document.querySelectorAll('.cal-wk-dayhead')];
  const alldayCells = [...document.querySelectorAll('.cal-wk-allday-cell')];
  const cols = [...document.querySelectorAll('.cal-wk-col')];
  const hourSpans = [...document.querySelectorAll('.cal-wk-hour span')];
  const gutterHead = document.querySelector('.cal-wk-gutterhead');
  const gutter = document.querySelector('.cal-wk-gutter');
  const grid = document.querySelector('.cal-wk-grid');
  const block = document.querySelector('.cal-wk-block');
  const blockCol = block ? block.closest('.cal-wk-col') : null;
  // 周三 = index 2
  const wedsCol = cols[2];
  const day0 = dayheads[0]?.getBoundingClientRect().left;
  const all0 = alldayCells[0]?.getBoundingClientRect().left;
  const col0 = cols[0]?.getBoundingClientRect().left;
  const wedsDay = dayheads[2]?.getBoundingClientRect().left;
  const wedsAll = alldayCells[2]?.getBoundingClientRect().left;
  const wedsColX = wedsCol?.getBoundingClientRect().left;
  const h9 = hourSpans[9]?.getBoundingClientRect().top;      // 09:00 刻度
  const blockTop = block?.getBoundingClientRect().top;
  const gridTop = grid?.getBoundingClientRect().top;
  const gutterTop = gutter?.getBoundingClientRect().top;
  return {
    gutterW: gutterHead ? +gutterHead.getBoundingClientRect().width.toFixed(1) : null,
    day0, all0, col0,
    wedsDay, wedsAll, wedsColX,
    h9, blockTop, gridTop, gutterTop,
    gridH: grid ? +grid.getBoundingClientRect().height.toFixed(1) : null,
    // 关键差值
    alignHeaderVsGrid: day0 != null && col0 != null ? +(day0 - col0).toFixed(1) : null,
    alignAllDayVsGrid: all0 != null && col0 != null ? +(all0 - col0).toFixed(1) : null,
    // 事件顶相对 grid 顶 的偏移 vs 09:00 刻度相对 gutter 顶 的偏移
    blockOffsetInGrid: blockTop != null && gridTop != null ? +(blockTop - gridTop).toFixed(1) : null,
    h9OffsetInGutter: h9 != null && gutterTop != null ? +(h9 - gutterTop).toFixed(1) : null
  };
})()`;

await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 820, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 50; i++) { await sleep(80); const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (st.result.value === "complete") { await sleep(200); break; } }
const r = await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
cleanup();
process.exit(0);
