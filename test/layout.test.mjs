/**
 * 移动端「日期时间」行的排版回归。
 *
 * 为什么不能用 jsdom：jsdom 没有布局引擎，scrollWidth 恒等于 clientWidth，
 * 「时间框被挤出卡片、清除按钮被顶到屏幕外」这类问题在 jsdom 里**完全看不见**。
 *
 * 做法（两步，保证与源码不脱节）：
 *   1. 用 jsdom 走真实加载链路打开编辑弹窗，取 `.caldav-editor` 的 outerHTML
 *      —— 标记由 editor.ts 生成，不手写、不会漂移；
 *   2. 把这段标记 + build 出的 dist/index.css 放进无头浏览器，用 CDP 的
 *      Emulation.setDeviceMetricsOverride 模拟真实手机视口（Edge/Chrome 无头窗口
 *      有 ~466px 最小宽度限制，靠 --window-size 到不了 360/390），逐宽度量：
 *        · 行与输入区不得横向溢出
 *        · 两个清除按钮必须都在卡片内容区内（这是用户报的「清除图标看不见」）
 *        · 日期与时间文字不得被截
 *   本机找不到 Edge/Chrome 时**跳过**（打印提示、不阻断 npm test）。
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setupBrowserDom, loadBuiltPlugin, seedStore, freeDebugPort } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-layout");

/* jsdom 会覆盖 globalThis.Event 等构造器，而 Node 内置的 WebSocket 在建立连接时
   要 new Event(...) ——被换成 jsdom 的 Event 后 undici 会抛
   `ERR_INVALID_ARG_TYPE: The "event" argument must be an instance of Event`。
   所以先把原生构造器存起来，做完 jsdom 那半段再还原。 */
const NATIVE = {};
for (const k of ["WebSocket", "Event", "EventTarget", "MessageEvent", "CloseEvent", "Blob"]) {
  NATIVE[k] = globalThis[k];
}

/* ---------- 1. 用 jsdom 拿到真实的编辑器标记 ---------- */
setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();

const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

seedStore(plugin);
const dockEl = document.createElement("div");
document.body.appendChild(dockEl);
const dockCustom = { element: dockEl, data: { key: "dock" } };
globalThis.__syRegistrations.dock[0].init.call(dockCustom, dockCustom);

// 打开编辑弹窗取真实标记。2026-10-10 起 Dock 的「新建」按钮已移除，
// 改走主面板工具栏的「+日程」按钮 —— 先打开主窗口页签，再点它。
// Dock init 后是**延迟**打开默认页签的（见 loader.test 的 450ms 等待），这里同样稍等。
await new Promise((r) => setTimeout(r, 450));
assert.ok(globalThis.__syRegistrations.lastOpenTab, "Dock 初始化后应默认打开页签");
const tabEl = document.createElement("div");
document.body.appendChild(tabEl);
const tabCustom = { element: tabEl, data: globalThis.__syRegistrations.lastOpenTab.custom.data };
globalThis.__syRegistrations.tab[0].init.call(tabCustom, tabCustom);
click(tabEl.querySelector('[data-action="new-event"]'));
const editorEl = document.querySelector(".caldav-editor");
assert.ok(editorEl, "应能打开编辑弹窗以取得真实标记");
const editorHtml = editorEl.outerHTML;
assert.ok(/caldav-datetime-row/.test(editorHtml), "编辑器里应有日期时间行");
assert.ok(
  (editorHtml.match(/caldav-input-clear/g) || []).length >= 4,
  "开始/结束两行应各有日期与时间的清除按钮"
);

/* ---------- 2. 还原原生构造器，找无头浏览器 ---------- */
Object.assign(globalThis, NATIVE);

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

if (!browserPath) {
  console.log("[layout] 跳过：本机未找到 Edge/Chrome，无法做真实排版量测");
  process.exit(0);
}

/* ---------- 3. 写被测页面 ---------- */
const cssHref = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");
fs.mkdirSync(outDir, { recursive: true });
const pageHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${cssHref}">
<style>
  html,body{margin:0;padding:0;font-family:system-ui,"Microsoft YaHei",sans-serif}
  /* 真实 .b3-dialog__container 是纵向 flex，这里补齐以免布局与真机不一致 */
  .b3-dialog__container{display:flex;flex-direction:column}
</style></head>
<body>
<div class="b3-dialog b3-dialog--open">
  <div class="b3-dialog__scrim"></div>
  <div class="b3-dialog__container caldav-mobile-dialog" style="width:100vw;height:100vh">
    <svg class="b3-dialog__close"></svg>
    <div class="b3-dialog__header"><div class="b3-dialog__title">新建日程</div></div>
    <div class="b3-dialog__body">${editorHtml}</div>
  </div>
</div>
</body></html>`;
const pagePath = path.join(outDir, "editor.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

/* ---------- 4. CDP ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(
  browserPath,
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--disable-extensions", "--disable-background-networking",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(outDir, "profile")}`,
    "about:blank"
  ],
  { stdio: "ignore" }
);

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
assert.ok(wsUrl, "应能连上无头浏览器的调试端口");

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
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
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Runtime.enable");

const MEASURE = `(() => {
  const row = document.querySelector(".caldav-datetime-row");
  const card = row.closest(".caldav-section--card");
  const cs = getComputedStyle(card);
  const cardRight = card.getBoundingClientRect().right - parseFloat(cs.paddingRight);
  const cv = document.createElement("canvas").getContext("2d");
  // 用 canvas 按元素真实字体量文字宽度。
  // 不能靠 scrollWidth 判「文字被截」：<input type=date> 的内部编辑区不会反映溢出，
  // 框窄到只剩几十像素时 scrollWidth 依然等于 clientWidth（漏判）。
  const textW = (el, sample) => {
    const s = getComputedStyle(el);
    cv.font = s.fontWeight + " " + s.fontSize + " " + s.fontFamily;
    return cv.measureText(sample).width;
  };
  const contentW = (el) => {
    const s = getComputedStyle(el);
    return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
  };
  const out = { rows: [], cardInnerW: +(card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)).toFixed(1) };
  document.querySelectorAll(".caldav-datetime-row").forEach((r) => {
    const box = r.querySelector(".caldav-datetime-inputs");
    const d = r.querySelector(".caldav-date-input");
    const t = r.querySelector(".caldav-time-text");
    const clears = [...r.querySelectorAll(".caldav-input-clear")].filter((c) => c.offsetParent !== null);
    // 日期框右侧 Chrome 会为自带日历选择器图标预留约 20px
    const dateNeed = textW(d, "2026/09/20") + 20;
    const timeNeed = textW(t, "16:00");
    out.rows.push({
      label: r.querySelector(".caldav-datetime-label").textContent.trim(),
      rowOverflow: r.scrollWidth > r.clientWidth + 0.5,
      inputsOverflow: box.scrollWidth > box.clientWidth + 0.5,
      dateClipped: contentW(d) < dateNeed,
      timeClipped: contentW(t) < timeNeed,
      dateRoom: contentW(d).toFixed(0) + "/" + dateNeed.toFixed(0),
      timeRoom: contentW(t).toFixed(0) + "/" + timeNeed.toFixed(0),
      clearsInside: clears.every((c) => c.getBoundingClientRect().right <= cardRight + 0.5),
      clearCount: clears.length,
      widths: [...box.children].filter((e) => e.offsetParent !== null)
        .map((e) => e.getBoundingClientRect().width.toFixed(0)).join("/")
    });
  });
  return out;
})()`;

async function measureAt(width) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
  for (let i = 0; i < 50; i++) {
    await sleep(80);
    const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (st.result.value === "complete") { await sleep(200); break; }
  }
  const r = await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
  return r.result.value;
}

// 主流手机宽度：全项断言（含文字不被截）
const STRICT = [360, 375, 390, 414, 430];
// 极窄屏（iPhone SE 一代 / 老安卓）：只要求不溢出、清除按钮在卡内。
// 原生日期框右侧的日历选择器图标会与末位数字贴得很近，故不断言文字宽度。
const NARROW = [320];

const report = [];
for (const w of [...NARROW, ...STRICT]) {
  const m = await measureAt(w);
  const strict = STRICT.includes(w);
  for (const row of m.rows) {
    assert.ok(
      !row.rowOverflow && !row.inputsOverflow,
      `${w}px「${row.label}」行横向溢出（卡片内容宽 ${m.cardInnerW}px，控件宽 ${row.widths}）——` +
        `时间框或清除按钮会被顶出卡片外`
    );
    assert.ok(
      row.clearsInside,
      `${w}px「${row.label}」行的清除按钮超出了卡片右缘（清除图标会被裁掉看不见）`
    );
    assert.strictEqual(
      row.clearCount, 2,
      `${w}px「${row.label}」行应能看到 2 个清除按钮（日期 + 时间）`
    );
    if (strict) {
      assert.ok(
        !row.dateClipped,
        `${w}px「${row.label}」行的日期文字放不下（可用 ${row.dateRoom}，含右侧原生选择器图标预留 20px）`
      );
      assert.ok(
        !row.timeClipped,
        `${w}px「${row.label}」行的时间文字放不下（可用 ${row.timeRoom}）`
      );
    }
  }
  report.push(`${w}px ✓ 控件宽 ${m.rows[0].widths}（卡片内容 ${m.cardInnerW}）`);
}

ws.close();
cleanup();
// 直接用原生 rd 清理（绕过 WorkBuddy 的 trash 二进制 —— 删除大目录时该二进制会超时卡死）
try {
  execFileSync(process.env.ComSpec || "cmd", ["/c", "rd", "/s", "/q", outDir], { stdio: "ignore" });
} catch {
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 临时目录，清理失败不影响结论 */ }
}

for (const line of report) console.log("  ✓ " + line);
console.log("[layout] 移动端日期时间行排版回归通过（360~430 一行收住，清除按钮未被顶出）");
