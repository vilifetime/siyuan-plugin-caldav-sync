/**
 * 全天区高度几何验证（手动跑，不进正式 npm test）：
 *   注入 dist/index.css，用 Edge CDP 量：
 *   场景 A（无全天事件）：.cal-wk-main 不渲染全天区；grid 紧贴 main 顶（无空行）。
 *   场景 B（有全天事件）：.cal-wk-allday-cells 高度 == 44px == 单个 .cal-wk-hour 行高。
 *   场景 C（有全天事件 + 已滚到（当前时间-2h））：全天栏仍完整留在视口内。
 *         ——「自动滚动到当前时间」是按时间网格算的，全天栏占的是视口高度，
 *            不减掉它的话，nowMin>120 时全天栏会被滚出视口（用户报的「全天栏不见了」）。
 *            这里模拟 scrollTop 落点，断言全天栏未被滚走。
 *   本机无 Edge 时打印提示并退出 0。
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
const cols = DAYS.map((d) => `<div class="cal-wk-col" data-day="${d}"></div>`).join("");

const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

function page(withAllDay) {
  // 与 view-week.ts 输出保持一致：全天栏是 .cal-wk-main 的兄弟节点（常驻顶部不随滚动），
  // 无全天事件时整行加 .is-empty 收起。测试页必须同构，否则量的是旧结构。
  // ⚠️ 必须套 .caldav-root：--caldav-* 变量定义在该选择器上，缺了它 var() 全部失效，
  //    border-left 的 shorthand 会整条作废（计算成 0px），看起来像「线没画」。
  // ⚠️ 必须显式给 6px 滚动条并**不要**加 --hide-scrollbars：
  //    真实环境 .cal-wk-main 有竖直滚动条，会吃掉右侧宽度；靠 scrollbar-gutter: stable
  //    与 .cal-wk-allday 对齐。隐藏滚动条就量不到这个差异（曾因此漏掉宽度漂移 bug）。
  const alldayRow = DAYS.map((d) =>
    d === "2026-09-14"
      ? `<div class="cal-wk-allday-cell" data-day="${d}"><div class="cal-chip cal-chip-allday" data-open="x" style="--cal-color:#3b82f6"><span class="cal-chip-title">全天示例</span></div></div>`
      : `<div class="cal-wk-allday-cell" data-day="${d}"></div>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>html,body{margin:0;padding:0;font-family:system-ui,"Microsoft YaHei",sans-serif}
#box{width:1000px;height:720px;overflow:hidden}.caldav-root{height:100%}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-thumb{background:#c9ccd0;border-radius:3px}
::-webkit-scrollbar-track{background:transparent}</style></head><body>
<div id="box"><div class="caldav-root"><div class="cal-wk" style="--cols:7">
  <div class="cal-wk-header"><div class="cal-wk-gutterhead"></div><div class="cal-wk-days">${dayHead}</div></div>
  <div class="cal-wk-allday${withAllDay ? "" : " is-empty"}">
    <div class="cal-wk-allday-label">全天</div>
    <div class="cal-wk-allday-cells">${alldayRow}</div>
  </div>
  <div class="cal-wk-main">
    <div class="cal-wk-gutter">${hours.join("")}</div>
    <div class="cal-wk-grid" style="height:${24 * 44}px">${cols}</div>
  </div>
</div></div></div></body></html>`;
}

fs.mkdirSync(outDir, { recursive: true });
const aPath = path.join(outDir, "allday-none.html");
const bPath = path.join(outDir, "allday-yes.html");
fs.writeFileSync(aPath, page(false), "utf8");
fs.writeFileSync(bPath, page(true), "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[allday] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--no-first-run", "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(outDir, "profile-allday")}`, "about:blank"
], { stdio: "ignore" });
let killed = false;
const cleanup = () => { if (!killed) { killed = true; try { proc.kill(); } catch {} } };
process.on("exit", cleanup);

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(300);
  try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (t) wsUrl = t.webSocketDebuggerUrl; } catch {}
}
if (!wsUrl) { console.log("[allday] 连不上调试端口"); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
let nextId = 1; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 820, deviceScaleFactor: 1, mobile: false });

const MEASURE = `(() => {
  const main = document.querySelector('.cal-wk-main');
  const grid = document.querySelector('.cal-wk-grid');
  const alldayCells = document.querySelector('.cal-wk-allday-cells');
  const alldayRow = document.querySelector('.cal-wk-allday');
  const mainTop = main.getBoundingClientRect().top;
  const gridTop = grid.getBoundingClientRect().top;
  const rows = getComputedStyle(main).gridTemplateRows;
  const hasAllDayEls = !!alldayCells;
  let alldayH = null, hourH = null;
  if (alldayCells) alldayH = +alldayCells.getBoundingClientRect().height.toFixed(1);
  const h0 = document.querySelector('.cal-wk-hour');
  if (h0) hourH = +h0.getBoundingClientRect().height.toFixed(1);
  // 「全集行隐藏」的判定：整行 .cal-wk-allday 要么不存在、要么 display:none
  const alldayRowVisible = !!alldayRow && getComputedStyle(alldayRow).display !== "none";
  return { gridRows: rows, hasAllDayEls, alldayRowVisible,
           gapMainToGrid: +(gridTop - mainTop).toFixed(1), alldayH, hourH,
           clientH: main.clientHeight, scrollH: main.scrollHeight };
})()`;

/** 三处「日期列」的横向对齐：日期表头 / 全天栏 / 时间网格。
 *  踩过两次坑：
 *  ① .cal-wk-allday 只写 grid-template-columns 没写 grid-template-areas，
 *     子元素具名区域不存在 → 自动放置 + 凭空生成轨道（columns "48px 469px 0px 483px"），
 *     全天格子和「全天」标签全堆到最右侧。
 *  ② 只有 .cal-wk-main 是滚动容器，竖直滚动条吃掉约 6px 宽度，
 *     表头/全天栏不滚动 → 差 6px，竖线逐列漂移（第 7 列偏 5.1px）。
 *     修法是三者都声明 scrollbar-gutter: stable。
 *  所以这里**三处一起量**：任意两处的列左边界/列宽都必须一致。 */
const MEASURE_ALIGN = `(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { l: +b.left.toFixed(1), w: +b.width.toFixed(1) }; };
  const set = (sel) => [...document.querySelector(sel).children].map(r);
  const headCells = set('.cal-wk-days');
  const adCells = set('.cal-wk-allday-cells');
  const gridCells = set('.cal-wk-grid');
  const n = Math.min(headCells.length, adCells.length, gridCells.length);
  const dl = [], dw = [];
  for (let i = 0; i < n; i++) {
    // 以日期表头为基准
    dl.push(+(adCells[i].l - headCells[i].l).toFixed(1), +(gridCells[i].l - headCells[i].l).toFixed(1));
    dw.push(+(adCells[i].w - headCells[i].w).toFixed(1), +(gridCells[i].w - headCells[i].w).toFixed(1));
  }
  const adRowCs = getComputedStyle(document.querySelector('.cal-wk-allday'));
  return {
    cols: n,
    headFirstL: headCells[0].l, adFirstL: adCells[0].l, gridFirstL: gridCells[0].l,
    headPitch: n > 1 ? +((headCells[n-1].l - headCells[0].l) / (n-1)).toFixed(2) : null,
    adPitch:   n > 1 ? +((adCells[n-1].l - adCells[0].l) / (n-1)).toFixed(2) : null,
    gridPitch: n > 1 ? +((gridCells[n-1].l - gridCells[0].l) / (n-1)).toFixed(2) : null,
    maxAbsLeftDelta: Math.max(...dl.map(Math.abs)),
    maxAbsWidthDelta: Math.max(...dw.map(Math.abs)),
    areas: adRowCs.gridTemplateAreas, cols_: adRowCs.gridTemplateColumns
  };
})()`;


/** 模拟 view-week.ts 的「滚动到当前时间」落点（nowMin=600 → 12:00），
 *  然后量全天栏是否仍在视口内。全天栏是滚动容器的兄弟节点，理应纹丝不动。 */
const SCROLL_AND_MEASURE = `(() => {
  const main = document.querySelector('.cal-wk-main');
  const alldayCells = document.querySelector('.cal-wk-allday-cells');
  const wk = document.querySelector('.cal-wk');
  const HOUR_H = 44, nowMin = 600;
  const before = alldayCells.getBoundingClientRect().top;
  const target = Math.max(0, ((nowMin - 120) / 1440) * 24 * HOUR_H);
  main.scrollTop = target;
  // 可见性用「周视图容器」的矩形判定 —— 全天栏在 .cal-wk-main 之外，
  // 拿 main 的矩形去夹它只会得到 0（那是测量口径错，不是真的不可见）。
  const wR = wk.getBoundingClientRect();
  const cR = alldayCells.getBoundingClientRect();
  const visible = Math.max(0, Math.min(cR.bottom, wR.bottom) - Math.max(cR.top, wR.top));
  return { target: +target.toFixed(1), scrollTop: +main.scrollTop.toFixed(1),
           alldayMovedBy: +(cR.top - before).toFixed(1),
           alldayVisiblePx: +visible.toFixed(1), alldayH: +cR.height.toFixed(1) };
})()`;

async function measure(file) {
  await send("Page.navigate", { url: "file:///" + file.replace(/\\/g, "/") });
  for (let i = 0; i < 50; i++) { await sleep(80); const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (st.result.value === "complete") { await sleep(200); break; } }
  const r = await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
  return r.result.value;
}

const ra = await measure(aPath);
const rb = await measure(bPath);
console.log("场景A(无全天):", JSON.stringify(ra));
console.log("场景B(有全天):", JSON.stringify(rb));

// 场景 C：有全天事件 + 已滚到 12:00，全天栏必须仍完整可见
await send("Page.navigate", { url: "file:///" + bPath.replace(/\\/g, "/") });
for (let i = 0; i < 50; i++) { await sleep(80); const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (st.result.value === "complete") { await sleep(200); break; } }
const rc = (await send("Runtime.evaluate", { expression: SCROLL_AND_MEASURE, returnByValue: true })).result.value;
console.log("场景C(有全天+滚到12:00):", JSON.stringify(rc));

// 场景 D：横向对齐（日期表头 / 全天栏 / 时间网格 三处的列边界必须一致）
await send("Page.navigate", { url: "file:///" + bPath.replace(/\\/g, "/") });
for (let i = 0; i < 50; i++) { await sleep(80); const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (st.result.value === "complete") { await sleep(200); break; } }
const rd = (await send("Runtime.evaluate", { expression: MEASURE_ALIGN, returnByValue: true })).result.value;
console.log("场景D(三处日期列对齐):", JSON.stringify(rd));

const okA = !ra.alldayRowVisible && Math.abs(ra.gapMainToGrid) < 1.5;
const okB = rb.alldayRowVisible && rb.alldayH === 44 && rb.hourH === 44 && Math.abs(rb.gapMainToGrid) < 1.5;
// 全天栏是固定行：滚动只动时间网格，全天栏必须纹丝不动且完整可见
const okC = Math.abs(rc.alldayMovedBy) <= 0.6 && rc.alldayVisiblePx >= rc.alldayH - 0.5 && rc.scrollTop > 0;
// 表头 / 全天栏 / 网格 三处列左边界与列宽必须一致，且全天栏显式声明了 grid-template-areas。
// 这里必须开着滚动条量——滚动条占宽差异正是第 7 列漂移 5.1px 的根因。
const okD = rd.adFirstL === rd.headFirstL && rd.gridFirstL === rd.headFirstL &&
            rd.maxAbsLeftDelta <= 0.6 && rd.maxAbsWidthDelta <= 0.6 &&
            rd.areas !== "none";
console.log("[A] 无事件时整行隐藏 + grid 贴顶:", okA ? "ok" : "FAIL");
console.log("[B] 有事件时全天区行高 44 == 单行:", okB ? "ok" : "FAIL");
console.log("[C] 滚到 12:00 后全天栏纹丝不动且完整可见:", okC ? "ok" : `FAIL (位移 ${rc.alldayMovedBy}, 可见 ${rc.alldayVisiblePx}/${rc.alldayH}, scrollTop ${rc.scrollTop})`);
console.log("[D] 表头/全天栏/网格三处日期列对齐:", okD ? "ok"
  : `FAIL (首列 表头 ${rd.headFirstL} / 全天 ${rd.adFirstL} / 网格 ${rd.gridFirstL}; 列距 ${rd.headPitch}/${rd.adPitch}/${rd.gridPitch}; 左偏差 ${rd.maxAbsLeftDelta}; 宽偏差 ${rd.maxAbsWidthDelta}; areas "${rd.areas}")`);
console.log(okA && okB && okC && okD ? "PASS ✅ 全天栏常驻顶部：无事件整行隐藏；有事件行高 44；滚动不会顶走它；三处日期列对齐" : "FAIL ❌");
cleanup();
process.exit(okA && okB && okC && okD ? 0 : 1);
