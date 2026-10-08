/**
 * 移动端周视图「标题不截断」验证：
 *   同 verify-mobile-wk.mjs 的宿主结构（.caldav-touch 触摸形态），
 *   周三放一个 60 分钟块：超长标题 + 地点（view-week.ts 新结构：
 *   标题内含 .cal-wk-block-loc-inline，独立行 .cal-wk-block-loc 不再渲染在触摸端）。
 *   用 Edge CDP（390x780 mobile）量：
 *     - 标题 white-space 应为 normal（能换行），无省略号行为
 *     - 标题实际渲染行数 > 1（长标题换行了）
 *     - .cal-wk-block-loc-inline display 为 inline，且位于标题文本之后（同一容器）
 *     - 独立行 .cal-wk-block-loc 不存在
 *     - 标题高度被块 overflow 裁住（title 底部不超出块底部太多——允许裁切，但不能撑破布局）
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
const allDayCells = DAYS.map(() => `<div class="cal-wk-allday-cell" data-day="x"></div>`).join("");

// 长标题 + 地点，复刻 view-week.ts 的产物结构
const longTitle = "联通大厦季度预算复审与项目组全员对齐会议";
const loc = "太湖办公大楼";
const block = `<div class="cal-wk-block cal-wk-block-todo" data-open="ev1" style="--cal-color:#d9534f;top:${((9 * 60) / 1440) * 100}%;height:${((60) / 1440) * 100}%">
  <div class="cal-wk-block-head"><button class="cal-chip-check" data-toggle="ev1">✓</button><div class="cal-wk-block-title">${longTitle}<span class="cal-wk-block-loc-inline">📍 ${loc}</span></div></div>
  <div class="cal-wk-block-time">09:00</div>
  <div class="cal-wk-block-loc">📍 ${loc}</div>
</div>`;
const cols = DAYS.map((d, i) => `<div class="cal-wk-col" data-day="${d}">${i === 2 ? block : ""}</div>`).join("");

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
const pagePath = path.join(outDir, "mwk-clip.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[wkclip] 跳过：未找到 Edge"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--no-first-run", "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(outDir, "profile-clip2")}`,
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
if (!wsUrl) { console.log("[wkclip] 连不上调试端口"); cleanup(); process.exit(1); }

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
  const block = document.querySelector('.cal-wk-block');
  const title = document.querySelector('.cal-wk-block-title');
  const inline = document.querySelector('.cal-wk-block-loc-inline');
  const standalone = document.querySelector('.cal-wk-block-loc');
  const cs = title ? getComputedStyle(title) : null;
  const ics = inline ? getComputedStyle(inline) : null;
  const br = block ? block.getBoundingClientRect() : null;
  const tr = title ? title.getBoundingClientRect() : null;
  // 行数：用 Range 逐行数比较麻烦，用 title 高度 / 行高 估算
  const lh = cs ? parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 : 0;
  const lines = lh ? Math.round(tr.height / lh) : 0;
  // inline 地点必须在标题容器内、且位于标题文本之后
  const inlineInTitle = inline ? title.contains(inline) && [...title.childNodes].some(n => n.nodeType === 3 && n.textContent.includes(${JSON.stringify(longTitle)})) : false;
  // 块内容左边界（不含 padding/border）
  const blockStyle = block ? getComputedStyle(block) : null;
  const contentLeft = block && blockStyle
    ? br.left + (parseFloat(blockStyle.paddingLeft) || 0) + (parseFloat(blockStyle.borderLeftWidth) || 0)
    : null;
  // 用 Range 取标题文本的每一行，检查第二行是否对齐到块内容最左侧
  let secondLineLeft = null;
  if (title) {
    const range = document.createRange();
    range.selectNodeContents(title);
    const rects = Array.from(range.getClientRects());
    const lineRects = [];
    for (const r of rects) {
      if (!lineRects.length || Math.abs(r.top - lineRects[lineRects.length - 1].top) > 2) lineRects.push(r);
    }
    secondLineLeft = lineRects[1] ? +lineRects[1].left.toFixed(1) : null;
  }
  return {
    whiteSpace: cs ? cs.whiteSpace : null,
    textOverflow: cs ? cs.textOverflow : null,
    overflowWrap: cs ? cs.overflowWrap : null,
    inlineDisplay: ics ? ics.display : null,
    inlineColor: ics ? ics.color : null,
    standaloneLocCount: document.querySelectorAll('.cal-wk-block-loc').length,
    standaloneDisplay: standalone ? getComputedStyle(standalone).display : null,
    titleLines: lines,
    titleH: tr ? +tr.height.toFixed(1) : null,
    blockH: br ? +br.height.toFixed(1) : null,
    titleClippedByBlock: tr && br ? tr.bottom > br.bottom - 1 : null,
    inlineInTitle,
    headAlign: getComputedStyle(document.querySelector('.cal-wk-block-head')).alignItems,
    // 悬挂对齐：浮动圆圈应让标题第二行起对齐到块内容最左侧
    headDisplay: getComputedStyle(document.querySelector('.cal-wk-block-head')).display,
    checkFloat: getComputedStyle(document.querySelector('.cal-chip-check')).cssFloat,
    contentLeft,
    secondLineLeft,
    lines
  };
})()`;

await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 50; i++) { await sleep(80); const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }); if (st.result.value === "complete") { await sleep(200); break; } }
const r = await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
if (r.exceptionDetails) { console.log("EXC", JSON.stringify(r.exceptionDetails).slice(0, 800)); }
const v = r.result.value;
console.log(JSON.stringify(v, null, 2));

const ok = v.whiteSpace === "normal" && v.textOverflow === "clip"
  && v.standaloneDisplay === "none" && v.inlineDisplay === "inline"
  && v.titleLines >= 2 && v.inlineInTitle
  && v.headDisplay === "block" && v.checkFloat === "left"
  && v.secondLineLeft !== null && Math.abs(v.secondLineLeft - v.contentLeft) < 2;
console.log(ok
  ? "[wkclip] PASS：标题换行不截断，第二行起对齐到块最左侧，地点行内跟随"
  : "[wkclip] FAIL");
cleanup();
process.exit(ok ? 0 : 1);
