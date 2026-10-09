/**
 * 工具栏按钮的几何验证（手动跑：node test/verify-toolbar-btns.mjs）。
 *
 * 雄哥 2026-10-09 的反馈：新建按钮和日历筛选、视图切换这些图标按钮**高度不一致**、
 * 看起来没居中。这属于纯几何问题，jsdom 不做布局、也算不了层叠，只能真浏览器量。
 *
 * 关键在于**页面必须模拟宿主的 button 规则**：Obsidian 给 button 定了
 * `height: var(--input-height)`（约 30px），思源 base.css 也压了 line-height。
 * 正是这条宿主规则让「只靠 padding 撑高度」的文字按钮比定高的图标按钮矮一截。
 * 所以这里在页面里显式写出那条宿主规则 —— 不写就等于把bug 藏起来，测了个假象。
 *
 * DOM 来自**真实插件**（renderPanel），不是手写 HTML —— 手写会与实现漂移
 * （本仓库已经吃过一次亏：verify-allday / verify-wk 的测试页 HTML 忘了同步）。
 *
 * 断言：
 *   1. 一排按钮**严格等高**（|Δh| ≤ 0.5px）；
 *   2. 顶边与底边都对齐（不能只靠等高 + 各自居中蒙混）；
 *   3. 按钮内的文字 / 图标在自身盒子里**垂直居中**（上间隙≈下间隙）；
 *   4. 图标按钮是正方形（34×34），不因border-box 缺失而变高；
 *   5. 手动同步按钮存在，且紧跟在「新建」右边；
 *   6. 同步按钮有旋转动画定义（点了能看见反馈）。
 *
 * 本机无 Edge/Chrome 时打印提示并退出 0。
 */
import { setupBrowserDom, loadBuiltPlugin, seedStore, freeDebugPort } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-toolbar-btns");
const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

/* ---------- 1. 用真实插件生成工具栏 DOM ---------- */
// setupBrowserDom() 会把 globalThis.Event 换成 jsdom 的 Event —— 生成完DOM 必须还原，
// 否则后面 undici 的 WebSocket 内部 dispatchEvent 会因「不是同一个 Event 类」直接抛错。
const nativeEvent = globalThis.Event;
const nativeCustomEvent = globalThis.CustomEvent;
setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();
seedStore(plugin);

// 面板在插件里是通过 addTab 的 init 挂上去的，这里直接走同一入口拿实例，
// 保证量的是**真实渲染出来的**工具栏（手写 HTML 会与实现漂移）。
const reg = globalThis.__syRegistrations;
const tabEl = document.createElement("div");
document.body.appendChild(tabEl);
const tabCustom = { element: tabEl, data: { key: "tab" } };
reg.tab[0].init.call(tabCustom, tabCustom);
const toolbarHtml = tabEl.querySelector(".caldav-toolbar")?.outerHTML;
if (!toolbarHtml) throw new Error("未能拿到工具栏DOM");

// 还原 Node 原生事件类，交给后面的 CDP WebSocket 用
globalThis.Event = nativeEvent;
globalThis.CustomEvent = nativeCustomEvent;

/* ---------- 2. 落成页面：把宿主的 button 规则一并写进来 ---------- */
const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>
  html,body{margin:0;padding:0;background:#fff;font-family:system-ui,"Microsoft YaHei",sans-serif}
  #stage{width:760px;padding:12px}
  /* 宿主（思源 base.css / Obsidian app.css）给 button 的规则。
     ⚠️ 这段是本测试的关键：不写它就测不出「高度不一致」这个 bug。 */
  button {
    height: var(--host-input-height, 30px);
    line-height: 1;
    box-sizing: border-box;
    font-family: inherit;
  }
  /* 主题变量（思源侧） */
  #stage {
    --b3-theme-primary:#3575f0;
    --b3-theme-background:#fff;
    --b3-theme-background-light:#f6f8fa;
    --b3-theme-surface:#eef1f5;
    --b3-border-color:#e4e7ed;
    --b3-theme-on-background:#1f2329;
    --b3-theme-on-surface:#646a73;
  }
</style></head>
<body>
<div id="stage" class="caldav-root caldav-app caldav-app--flat">
  <main class="caldav-main">${toolbarHtml}<div class="caldav-view"></div></main>
</div>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "toolbar-btns.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

/* ---------- 3. 起 Edge 量几何 ---------- */
const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[toolbar-btns] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(outDir, "profile-toolbar-btns")}`,
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
if (!wsUrl) { console.log("[toolbar-btns] 连不上调试端口"); cleanup(); process.exit(1); }

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
await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 320, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 60; i++) {
  await sleep(80);
  const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
  if (st.result.value === "complete") { await sleep(250); break; }
}
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

const MEASURE = String.raw`(() => {
  const all = (s) => Array.from(document.querySelectorAll(s));
  const r = (el) => { const b = el.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}; };
  // ⚠️ 只取工具栏这一排**排布上的一级按钮**：
  // .caldav-calfilter-wrap 里还有若干 .caldav-cal-toggle（浮层内的日历眼睛），
  // 它们同属 .caldav-icon-btn 但此刻浮层是 hidden、尺寸全 0，混进来会把等高断言打挂。
  const btns = all('.caldav-toolbar-right > .caldav-btn, .caldav-toolbar-right > .caldav-icon-btn, .caldav-calfilter-wrap > .caldav-icon-btn')
    .filter((el) => el.getBoundingClientRect().width > 0);
  return {
    items: btns.map((el) => {
      const box = r(el);
      const cs = getComputedStyle(el);
      // 内容（文字节点 or svg）的实际占位，用来验「内容在盒子里居中」
      const svg = el.querySelector('svg');
      const content = svg ? r(svg) : null;
      let textBox = null;
      if (!svg) {
        // 用 Range 量纯文字节点
        const range = document.createRange();
        range.selectNodeContents(el);
        const rb = range.getBoundingClientRect();
        textBox = { top: rb.top, bottom: rb.bottom, height: rb.height };
      }
      return {
        action: el.dataset.action,
        cls: el.className,
        ...box,
        borderTop: cs.borderTopWidth,
        boxSizing: cs.boxSizing,
        content,
        textBox,
        // 上下留白差：>1px 就是没居中
        padTop: content ? content.top - box.top : textBox ? textBox.top - box.top : null,
        padBottom: content ? box.bottom - content.bottom : textBox ? box.bottom - textBox.bottom : null
      };
    }),
    syncExists: !!document.querySelector('.caldav-toolbar-right [data-action="sync-now"]'),
    syncPrevAction: document.querySelector('.caldav-toolbar-right [data-action="sync-now"]')?.previousElementSibling?.dataset.action || null,
    spinner: (() => {
      const b = document.querySelector('[data-action="sync-now"]');
      if (!b) return null;
      // ⚠️ 必须先关掉 transition：.caldav-icon-btn 有 transition: all .15s，
      // 其中包含 opacity —— 加了类立刻读，拿到的还是过渡起点的 1，测出来是假象。
      const prevTransition = b.style.transition;
      b.style.transition = 'none';
      b.classList.add('is-syncing');
      const anim = getComputedStyle(b.querySelector('svg')).animationName;
      const dur = getComputedStyle(b.querySelector('svg')).animationDuration;
      const opacity = getComputedStyle(b).opacity;
      b.classList.remove('is-syncing');
      b.style.transition = prevTransition;
      return { anim, dur, opacity };
    })()
  };
})()`;

const m = await evalJs(MEASURE);
console.log("=== 实测 ===");
console.log(JSON.stringify(m, null, 1));

const near = (a, b, t) => Math.abs(a - b) <= t;
const items = m.items;
const heights = items.map((i) => i.height);
const tops = items.map((i) => i.top);
const bottoms = items.map((i) => i.bottom);
const H = heights[0];

const checks = [
  ["工具栏右侧至少 4 个按钮（新建/同步/筛选/视图切换）", items.length >= 4],
  ["手动同步按钮已渲染", m.syncExists],
  ["同步按钮紧跟在「新建待办」右边", m.syncPrevAction === "new-todo"],
  ["所有按钮严格等高（|Δh| ≤ 0.5px）", heights.every((h) => near(h, H, 0.5))],
  ["所有按钮顶边对齐（|Δtop| ≤ 0.5px）", tops.every((t) => near(t, tops[0], 0.5))],
  ["所有按钮底边对齐（|Δbottom| ≤ 0.5px）", bottoms.every((b) => near(b, bottoms[0], 0.5))],
  ["每个按钮都用了 border-box（否则 34px + 边框会高 2px）", items.every((i) => i.boxSizing === "border-box")],
  ["内容在按钮内垂直居中（上下留白差 ≤ 1px）", items.every((i) => i.padTop !== null && near(i.padTop, i.padBottom, 1))],
  ["图标按钮是正方形（宽=高=34px）", items.filter((i) => i.cls.includes("caldav-icon-btn")).every((i) => near(i.width, i.height, 0.5) && near(i.width, 34, 0.5))],
  ["同步按钮有旋转动画反馈", !!m.spinner && m.spinner.anim !== "none" && m.spinner.dur !== "0s"],
  ["同步中按钮被禁用（透明度 < 1）", !!m.spinner && parseFloat(m.spinner.opacity) < 1]
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) bad++;
}

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(outDir, "preview.png"), Buffer.from(shot.data, "base64"));

if (bad) {
  console.log(`\n[toolbar-btns] 失败 ${bad} 项`);
  cleanup();
  process.exit(1);
}
console.log(`\n实测：按钮高度 ${heights.map((h) => h.toFixed(1)).join(" / ")} px`);
console.log(`实测：顺序 ${items.map((i) => i.action).join(" → ")}`);
console.log(`截图：${path.join(outDir, "preview.png")}`);
console.log("[toolbar-btns] 工具栏按钮几何验证通过");
cleanup();
process.exit(0);