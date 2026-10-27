/**
 * 品牌图标放大取证（一次性脚本，不进 npm test 链）。
 * 用法：node scripts/shot-brand-icon.mjs
 * 产出：.review/brand-icon-zoom.png（22px 原尺寸 + 4x 放大对照）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, ".review");
const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");
const png = fs.readFileSync(path.join(root, "icon-design", "icon-warmA-cream-64.png")).toString("base64");

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>
 html,body{margin:0;background:#fff;font-family:system-ui,"Microsoft YaHei",sans-serif}
 .box{padding:16px;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
 .row{display:flex;align-items:center;gap:10px}
 .zoom{zoom:4;image-rendering:auto}
 .cap{font-size:12px;color:#666}
 .dark{background:#202124;color:#eee;padding:12px}
</style></head><body>
<div class="box">
  <div class="row"><span class="caldav-brand-icon"><img class="caldav-brand-icon-img" src="data:image/png;base64,${png}" alt=""/></span>
    <span style="font-weight:600;font-size:14px">日历任务管理</span><div class="cap">真实尺寸 22px（思源 Dock 品牌栏）</div></div>
  <div class="row"><span class="zoom caldav-brand-icon"><img class="caldav-brand-icon-img" src="data:image/png;base64,${png}" alt=""/></span><div class="cap">4 倍放大（看细节）</div></div>
  <div class="row dark"><span class="caldav-brand-icon"><img class="caldav-brand-icon-img" src="data:image/png;base64,${png}" alt=""/></span>
    <span style="font-weight:600;font-size:14px">日历任务管理</span><div class="cap" style="color:#999">深色背景下的观感</div></div>
</div></body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "brand-icon.html");
fs.writeFileSync(pagePath, html, "utf8");

const CANDIDATES = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[brand] 跳过：未找到 Edge"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9411 + Math.floor(Math.random() * 200);
const proc = spawn(browserPath, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--disable-extensions", "--disable-background-networking",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(outDir, "profile-brand")}`,
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
if (!wsUrl) { console.log("[brand] 连不上调试端口"); cleanup(); process.exit(1); }

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
await send("Emulation.setDeviceMetricsOverride", { width: 460, height: 230, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 60; i++) {
    await sleep(80);
    const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (st.result.value === "complete") { await sleep(300); break; }
}
const shot = await send("Page.captureScreenshot", { format: "png" });
const out = path.join(outDir, "brand-icon-zoom.png");
fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`[brand] 截图: ${out}`);
cleanup();
process.exit(0);
