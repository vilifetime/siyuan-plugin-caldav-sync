/**
 * 周/日视图时间轴刻度不被裁剪的几何验证（手动跑：node test/verify-wk-axis.mjs）。
 *
 * 背景（用户报的 bug）：最上面的 00:00 只显示半个字符。
 * 根因：`.cal-wk-hour span` 用 `top:-7px` 把刻度文字垂直居中到整点线上，
 * 而它的祖先 `.cal-wk-main` 是滚动容器（`overflow-y:auto`）→ 溢出部分被裁掉，
 * 首行 00:00 恰好被切掉一半（文字高 14px，只剩 7px）。
 *
 * 修法（雄哥定的观感）：**只把 00:00 压回格内**（`.cal-wk-gutter > .cal-wk-hour:first-child span { top:0 }`），
 * 而不是给整块内容加 padding-top —— 后者会把时间格子线也推下去，格子就不"紧顶着上边界"了。
 * 其余整点刻度保持在各自的线上（否则每个标签都比对应横线低 7px）。
 *
 * 断言（对「有全天事件」与「无全天事件」两种分支都测）：
 *   1. 00:00 完整可见、且已下移（贴齐首行盒顶，不再溢出到滚动容器之外）
 *   2. 其余整点刻度仍居中在各自整点线上（-7px 偏移未被破坏）
 *   3. 时间格子线与 gutter 顶部贴齐内容区顶（无全天事件时应为 0：紧顶上边界）
 * 本机无 Edge/Chrome 时打印提示并退出 0。
 */
import { freeDebugPort } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-wk-axis");

const WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const DAYS = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"];

// 第 4 列标 is-today：必须覆盖「今天」圆圈那一支 ——
// 圆圈是唯一有背景+圆角+自增 padding 的元素，也是唯一会撑破表头 44px 高度的元素。
const dayHead = DAYS.map((d, i) =>
  `<div class="cal-wk-dayhead${i === 3 ? " is-today" : ""}" data-day="${d}">
     <span class="cal-wk-wd">${WEEK[i]}</span><span class="cal-wk-num">${+d.slice(8, 10)}</span></div>`
).join("");

const hours = [];
for (let h = 0; h < 24; h++) hours.push(`<div class="cal-wk-hour" style="height:44px"><span>${String(h).padStart(2, "0")}:00</span></div>`);

const cols = DAYS.map((d) => `<div class="cal-wk-col" data-day="${d}"></div>`).join("");
const allDayCells = DAYS.map((d) =>
  `<div class="cal-wk-allday-cell" data-day="${d}">${
    d === "2026-09-14"
      ? `<div class="cal-chip cal-chip-allday" data-open="x" style="--cal-color:#3b82f6"><span class="cal-chip-title">全天示例</span></div>`
      : ""
  }</div>`
).join("");

/** 与 view-week.ts 输出同构：全天栏是 .cal-wk-main 的兄弟节点，无事件时整行 .is-empty 收起 */
const buildPage = (withAllDay) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
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
  <div class="cal-wk-allday${withAllDay ? "" : " is-empty"}">
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
const pageNoAllDay = path.join(outDir, "wk-no-allday.html");
const pageAllDay = path.join(outDir, "wk-allday.html");
fs.writeFileSync(pageNoAllDay, buildPage(false), "utf8");
fs.writeFileSync(pageAllDay, buildPage(true), "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[wk-axis] 跳过：未找到 Edge/Chrome"); process.exit(0); }

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
if (!wsUrl) { console.log("[wk-axis] 连不上调试端口"); cleanup(); process.exit(1); }

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

/* 量「滚动到顶」时的几何关系。要点：
   - gridTopInContent / gutterTopInContent 必须为 0 → 时间格子线紧顶上边界（不回退成因留白而整体下移）
   - span0TopRelHour0 应为 0 → 00:00 被压回格内（不再溢出到滚动容器之外被裁）
   - span1TopRelHour1 应为 -7 → 其余整点刻度仍居中在各自整点线上
   注意 span 是 absolute，要按内容坐标算，故加回 scrollTop。 */
const MEASURE = `(() => {
  const main = document.querySelector('.cal-wk-main');
  const mainR = main.getBoundingClientRect();
  const contentTop = mainR.top + main.clientTop;
  const viewBottom = contentTop + main.clientHeight;
  const grid = document.querySelector('.cal-wk-grid');
  const gutter = document.querySelector('.cal-wk-gutter');
  const hours = document.querySelectorAll('.cal-wk-hour');
  const h0 = hours[0], h1 = hours[1];
  const s0 = h0.querySelector('span'), s1 = h1 ? h1.querySelector('span') : null;
  const s0R = s0.getBoundingClientRect(), s0hR = h0.getBoundingClientRect();
  const s1R = s1 ? s1.getBoundingClientRect() : null, s1hR = h1 ? h1.getBoundingClientRect() : null;
  const visible = Math.max(0, Math.min(s0R.bottom, viewBottom) - Math.max(s0R.top, contentTop));
  return {
    span0Height: +s0R.height.toFixed(1),
    span0Visible: +visible.toFixed(1),
    gridTopInContent: +(grid.getBoundingClientRect().top - contentTop).toFixed(1),
    gutterTopInContent: +(gutter.getBoundingClientRect().top - contentTop).toFixed(1),
    span0TopRelHour0: +(s0R.top - s0hR.top).toFixed(1),
    span1TopRelHour1: s1R && s1hR ? +(s1R.top - s1hR.top).toFixed(1) : null,
    mainPaddingTop: getComputedStyle(main).paddingTop,
    scrollTop: main.scrollTop,
    header: (() => {
      // 「今天」圆圈不得压住表头下边界线。
      // 表头只有 44px 高，而「周几 + 日期圆圈」竖排要占 padding*2 + 周几 + gap + 圆圈高；
      // 装不下就会溢出（.cal-wk-dayhead 是 flex item 不会被压缩），圆圈底部越过
      // border-bottom，表现为「圆圈盖住下边界线」。这里量圆圈底到内容底边的净空。
      const hd = document.querySelector('.cal-wk-header');
      const today = hd.querySelector('.cal-wk-dayhead.is-today');
      if (!today) return null;
      const num = today.querySelector('.cal-wk-num');
      const hdCs = getComputedStyle(hd);
      const bb = parseFloat(hdCs.borderBottomWidth) || 0;
      const contentBottom = hd.getBoundingClientRect().bottom - bb;
      const nR = num.getBoundingClientRect();
      return {
        headerH: +hd.getBoundingClientRect().height.toFixed(1),
        circleBottom: +nR.bottom.toFixed(1),
        contentBottom: +contentBottom.toFixed(1),
        clearance: +(contentBottom - nR.bottom).toFixed(1),
        numH: +nR.height.toFixed(1),
        dayheadContentH: +today.scrollHeight
      };
    })()
  };
})()`;

const cases = [
  { name: "无全天事件（is-empty）", page: pageNoAllDay },
  // 有全天事件时，时间网格本来就在全天区下方；这里关注的是「滚动到顶后格子线贴顶」
  { name: "有全天事件（常驻全天栏）", page: pageAllDay }
];

let fails = 0;
for (const c of cases) {
  await send("Page.navigate", { url: "file:///" + c.page.replace(/\\/g, "/") });
  for (let i = 0; i < 50; i++) {
    await sleep(80);
    const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (st.result.value === "complete") { await sleep(220); break; }
  }
  await send("Runtime.evaluate", { expression: "document.querySelector('.cal-wk-main').scrollTop = 0", returnByValue: true });
  await sleep(120);
  const r = (await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true })).result.value;

  const ok = (cond, msg, extra = "") => {
    if (!cond) { fails++; console.log("  [FAIL] " + msg + (extra ? "  → " + extra : "")); }
    else console.log("  [ok]   " + msg);
  };
  console.log("=== " + c.name + " ===");
  console.log("  " + JSON.stringify(r));
  ok(r.span0Visible >= r.span0Height - 0.5, "00:00 完整可见（不被滚动容器裁掉）", `可见 ${r.span0Visible} / 高 ${r.span0Height}`);
  ok(Math.abs(r.span0TopRelHour0) <= 0.6, "00:00 已压回格内、往下让出 7px", `相对首行盒 ${r.span0TopRelHour0}px`);
  ok(Math.abs(r.span1TopRelHour1 + 7) <= 0.6, "其余整点刻度仍居中在各自整点线上", `01:00 相对 ${r.span1TopRelHour1}px`);
  // 滚动到顶后，时间格子线与 gutter 顶都应贴齐内容区顶（不因留白整体下移）
  ok(Math.abs(r.gridTopInContent - r.gutterTopInContent) <= 0.6,
     "时间轴与网格顶部对齐", `grid ${r.gridTopInContent} / gutter ${r.gutterTopInContent}`);
  if (c.name.includes("is-empty")) {
    ok(Math.abs(r.gridTopInContent) <= 0.6, "无全天事件时时间格子线紧顶上边界", `偏移 ${r.gridTopInContent}px`);
  }
  if (r.header) {
    const h = r.header;
    ok(h.clearance >= 2, "「今天」圆圈不压表头下边界线（净空 ≥2px）",
       `圆圈底 ${h.circleBottom} / 内容底 ${h.contentBottom} → 净空 ${h.clearance}px`);
    ok(h.dayheadContentH <= h.headerH + 0.6, "日期表头内容装得进表头高度（不溢出）",
       `内容 ${h.dayheadContentH} / 表头 ${h.headerH}`);
  } else {
    // 测试页若没渲染 is-today 单元格，断言会被静默跳过 —— 那等于没测。必须显式失败。
    ok(false, "测试页存在 .cal-wk-dayhead.is-today（否则圆圈断言被跳过）");
  }
}

console.log(fails === 0 ? "[wk-axis] 全部通过" : `[wk-axis] 失败 ${fails} 项`);
cleanup();
process.exit(fails === 0 ? 0 : 1);
