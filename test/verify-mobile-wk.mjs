/**
 * 移动端周视图几何验证：
 *   用真实 view-week.ts 的产物结构（7 列；周一 1 个全天事件；周三 09:00 定时事件），
 *   包在 .caldav-root.caldav-mobile-host > .caldav-app > .caldav-main > .caldav-view 里，
 *   注入 dist/index.css，用 Edge CDP（mobile 视口 390x780）量：
 *     - .cal-wk-main 高度是否为正、是否铺满视图
 *     - .cal-wk-grid 高度（应为 1056px）
 *     - 定时事件块是否存在、是否在可视区（top 在 main 内部、height>0）
 *     - 无全天时“全天”标签是否渲染（应为 0）
 */
import { freeDebugPort } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
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
const allDayCells = DAYS.map((d) => {
  const chips = d === "2026-09-14"
    ? `<div class="cal-chip cal-chip-allday is-done" data-open="t1" style="--cal-color:#3b82f6"><button class="cal-chip-check" data-toggle="t1">✓</button><span class="cal-chip-title">全天任务</span></div>`
    : "";
  return `<div class="cal-wk-allday-cell" data-day="${d}">${chips}</div>`;
}).join("");
const cols = DAYS.map((d) => {
  const inner = d === "2026-09-16"
    ? `<div class="cal-wk-block cal-wk-block-todo is-done" data-open="ev1" style="--cal-color:#3b82f6;top:${((9 * 60) / 1440) * 100}%;height:${((60) / 1440) * 100}%">
         <div class="cal-wk-block-head"><button class="cal-chip-check" data-toggle="ev1">✓</button><div class="cal-wk-block-title">晨会</div></div>
         <div class="cal-wk-block-time">09:00</div>
       </div>`
    : "";
  return `<div class="cal-wk-col" data-day="${d}">${inner}</div>`;
}).join("");

const pageHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/")}">
<style>html,body{margin:0;padding:0;font-family:system-ui,"Microsoft YaHei",sans-serif}</style></head>
<body>
<div class="caldav-root caldav-touch caldav-mobile-host">
  <div class="caldav-app caldav-app--flat">
    <main class="caldav-main">
      <header class="caldav-toolbar"></header>
      <div class="caldav-view">
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
    </main>
  </div>
</div>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "mwk.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[mwk] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--no-first-run", "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(outDir, "profile-m")}`,
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
if (!wsUrl) { console.log("[mwk] 连不上调试端口"); cleanup(); process.exit(1); }

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
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 780, deviceScaleFactor: 1, mobile: true, isTouch: true });

const MEASURE = `(() => {
  const main = document.querySelector('.cal-wk-main');
  const grid = document.querySelector('.cal-wk-grid');
  const block = document.querySelector('.cal-wk-block');
  const view = document.querySelector('.caldav-view');
  const label = document.querySelector('.cal-wk-allday-label');
  const alldayCells = document.querySelectorAll('.cal-wk-allday-cell');
  const rect = (e) => e ? e.getBoundingClientRect() : null;
  const mr = rect(main), vr = rect(view), gr = rect(grid), br = rect(block), lr = rect(label);
  return {
    viewH: vr ? +vr.height.toFixed(1) : null,
    mainH: mr ? +mr.height.toFixed(1) : null,
    mainTop: mr ? +mr.top.toFixed(1) : null,
    mainScrollH: main ? +main.scrollHeight.toFixed(1) : null,
    gridH: gr ? +gr.height.toFixed(1) : null,
    blockTop: br ? +br.top.toFixed(1) : null,
    blockH: br ? +br.height.toFixed(1) : null,
    blockVisibleInView: br && vr ? (br.top >= vr.top - 1 && br.bottom <= vr.bottom + 1) : null,
    labelCount: document.querySelectorAll('.cal-wk-allday-label').length,
    labelTop: lr ? +lr.top.toFixed(1) : null,
    alldayCellsWithChips: [...alldayCells].filter(c => c.querySelector('.cal-chip')).length
  };
})()`;

await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 50; i++) { await sleep(80); const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (st.result.value === "complete") { await sleep(200); break; } }
const r = await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
cleanup();
process.exit(0);
