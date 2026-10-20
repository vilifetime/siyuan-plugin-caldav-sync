/**
 * 「备注附件」标签页的浏览器实测（手动跑：node test/verify-note-attach.mjs）。
 *
 * 雄哥 2026-10-14 的三条反馈：
 *   1) 「任务备注」标签改名「备注附件」；
 *   2) 该标签页像「任务设置」那样分区块，区块标题分别是「备注」「附件」；
 *   3) 附件区块里回形针图标巨大化 —— icons.ts 的 svg 一律不写 width/height
 *      （ Obsidian 宿主全局 svg 规则会赢），浏览器把无尺寸内联 svg 当 100% 宽算，
 *      于是图标撑满整行。这条**只有真浏览器量 computed style 才现形**。
 *
 * DOM 来自**真实插件**（seedStore → 面板 → 任务视图点条目 → 编辑弹窗 → 切标签；
 * 设置弹窗走 Dock 齿轮 → openSettingsDialog），不是手写 HTML；几何与计算样式由 Edge 无头实测。
 *
 * 2026-10-15 增测：设置弹窗「同步」板块的「附件大小限制（MB）」「单个ICS文件限制（MB）」
 * 两个输入框（默认 5 / 10，同行排布）。
 *
 * 本机无 Edge/Chrome 时打印提示并退出 0。
 */
import { setupBrowserDom, loadBuiltPlugin, seedStore, freeDebugPort, settle } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-note-attach");
const cssRel = path.relative(outDir, path.join(root, "dist", "index.css")).replace(/\\/g, "/");

/* ---------- 1. 真实插件跑出编辑弹窗 DOM ---------- */
const nativeEvent = globalThis.Event;
const nativeCustomEvent = globalThis.CustomEvent;
setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();
seedStore(plugin);

// 造一个带附件的待办：1 个二进制内联件 + 1 个外链，两种行都要量
const d = new Date();
const p2 = (n) => (n < 10 ? "0" + n : String(n));
const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
plugin.store.put({
  uid: "attach-demo@test",
  kind: "todo",
  calendarUrl: "http://127.0.0.1:5232/testuser/work/",
  href: "http://127.0.0.1:5232/testuser/work/attach-demo.ics",
  etag: '"v-attach"',
  summary: "带附件的待办",
  description: "备注正文",
  allDay: false,
  start: `${today}T09:00:00`,
  end: `${today}T18:00:00`,
  percent: 0,
  status: "NEEDS-ACTION",
  dirty: false,
  deleted: false,
  attachments: [
    { name: "合同扫描件.pdf", b64: "JVBERi0xLjQKJeLjz9MKCg==" }, // 一小段真 base64（%PDF- 开头）
    { name: "需求文档.docx", uri: "https://example.com/files/需求文档.docx" }
  ]
});

const click = (el) => el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

const reg = globalThis.__syRegistrations;
const tabEl = document.createElement("div");
document.body.appendChild(tabEl);
const tabCustom = { element: tabEl, data: { key: "tab" } };
reg.tab[0].init.call(tabCustom, tabCustom);

// 切到任务视图 → 点中那条待办 → 编辑弹窗（与 loader.test.mjs 同一链路）
click(tabEl.querySelector('[data-action="toggle-view"]'));
const taskRow = [...tabEl.querySelectorAll(".cal-task[data-open]")].find((el) =>
  (el.textContent || "").includes("带附件的待办")
);
if (!taskRow) throw new Error("任务视图里找不到种子待办");
click(taskRow);
const editorEl = document.querySelector(".caldav-editor");
if (!editorEl) throw new Error("编辑弹窗没打开");

// 切到「备注附件」标签
click(editorEl.querySelector('.caldav-tab[data-tab="note"]'));
const editorHtml = editorEl.outerHTML;
if (!editorHtml.includes("备注附件")) throw new Error("标签名不是「备注附件」");
if (!editorHtml.includes("caldav-attach-row--bin")) throw new Error("附件区没有渲染二进制行");

// 设置弹窗：走 Dock 齿轮 → openSettingsDialog 真实链路（2026-10-15 加的两个上限输入框）
const dockEl = document.createElement("div");
document.body.appendChild(dockEl);
const dockCustom = { element: dockEl, data: { key: "dock" } };
reg.dock[0].init.call(dockCustom, dockCustom);
click(dockEl.querySelector("[data-dock-action='settings']"));
const settingsEl = document.querySelector(".caldav-settings");
if (!settingsEl) throw new Error("设置弹窗没打开");
const settingsHtml = settingsEl.outerHTML;
if (!settingsHtml.includes('data-s="attachMax"')) throw new Error("设置里没有「附件大小限制」输入框");
if (!settingsHtml.includes('data-s="icsMax"')) throw new Error("设置里没有「单个ICS文件限制」输入框");

// ⚠️ 切换视图会留下一个 350ms 的 openPanelTab 定时器（index.ts 的
// setTimeout(() => self.openPanelTab(...), 350)）。它触发时要 dispatch 一个
// jsdom Event —— 必须赶在下面还原 globalThis.Event **之前**让它跑完，
// 否则还原成 Node 原生 Event 后，jsdom 的 dispatchEvent 会直接 TypeError。
await settle(20);

globalThis.Event = nativeEvent;
globalThis.CustomEvent = nativeCustomEvent;

/* ---------- 2. 落成页面 ---------- */
const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssRel}">
<style>
  html,body{margin:0;padding:0;background:#fff;font-family:system-ui,"Microsoft YaHei",sans-serif}
  #stage{width:620px;padding:16px}
  #stage2{width:620px;padding:16px}
  /* 宿主（思源 base.css）给 button 的规则 —— 不写就等于把 bug 藏起来 */
  button {
    height: var(--host-input-height, 30px);
    line-height: 1;
    box-sizing: border-box;
    font-family: inherit;
  }
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
<div id="stage">${editorHtml}</div>
<div id="stage2"><div class="caldav-dialog-wrap" style="width:520px">${settingsHtml}</div></div>
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const pagePath = path.join(outDir, "note-attach.html");
fs.writeFileSync(pagePath, pageHtml, "utf8");

/* ---------- 3. Edge 实测 ---------- */
const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser"
];
const browserPath = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!browserPath) { console.log("[note-attach] 跳过：未找到 Edge/Chrome"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freeDebugPort();
const proc = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--disable-extensions", "--disable-background-networking",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(outDir, "profile-note-attach")}`,
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
if (!wsUrl) { console.log("[note-attach] 连不上调试端口"); cleanup(); process.exit(1); }

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
await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
for (let i = 0; i < 60; i++) {
  await sleep(80);
  const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
  if (st.result.value === "complete") { await sleep(300); break; }
}
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

const MEASURE = String.raw`(() => {
  const q = (s) => document.querySelector(s);
  const noteTab = q('.caldav-tab[data-tab="note"]');
  const basicTab = q('.caldav-tab[data-tab="basic"]');
  const panel = q('[data-panel="note"]');
  const cards = Array.from(panel.querySelectorAll(':scope > .caldav-section--card'));
  const binRow = q('.caldav-attach-row--bin');
  const uriRow = q('.caldav-attach-row:not(.caldav-attach-row--bin)');
  const svg = binRow?.querySelector('.caldav-attach-bin svg');
  const svgCs = svg ? getComputedStyle(svg) : null;
  const nameEl = binRow?.querySelector('.caldav-attach-bin-name');
  const delBtn = binRow?.querySelector('[data-attach-del]');
  const dlBtn = binRow?.querySelector('[data-attach-dl]');
  const rb = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  return {
    tabLabels: { basic: basicTab?.textContent?.trim(), note: noteTab?.textContent?.trim() },
    cardCount: cards.length,
    cardTitles: cards.map((c) => c.querySelector('.caldav-section-title')?.textContent?.trim()),
    cardBoxes: cards.map(rb),
    bin: {
      rowBox: binRow ? rb(binRow) : null,
      iconBox: svg ? rb(svg) : null,
      iconCss: svgCs ? { w: svgCs.width, h: svgCs.height, flex: svgCs.flex } : null,
      nameText: nameEl?.textContent?.trim(),
      nameBox: nameEl ? rb(nameEl) : null,
      nameClipped: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : null,
      delText: delBtn?.textContent?.trim(),
      delBox: delBtn ? rb(delBtn) : null,
      // 2026-10-19：已有附件的下载（雄哥报「编辑待办里附件没法下载」）
      dlText: dlBtn?.textContent?.trim(),
      dlBox: dlBtn ? rb(dlBtn) : null,
      sameRowDl: dlBtn && delBtn ? Math.abs(rb(dlBtn).top - rb(delBtn).top) < 20 : null,
      // 图标、文件名、删除按钮是否在同一行（纵向应基本重叠）
      sameRow: svg && delBtn ? Math.abs(rb(svg).top - rb(delBtn).top) < 20 : null
    },
    uri: {
      inputExists: !!uriRow?.querySelector('[data-attach-uri]'),
      inputValue: uriRow?.querySelector('[data-attach-uri]')?.value,
      delExists: !!uriRow?.querySelector('[data-attach-del]'),
      dlExists: !!uriRow?.querySelector('[data-attach-dl]')
    },
    actions: {
      upload: !!q('[data-attach-upload]'),
      add: !!q('[data-attach-add]'),
      hint: q('.caldav-attach-hint')?.textContent?.includes('内联进待办'),
      // 2026-10-15：提示文案要先把硬上限说清楚，别等用户传了个 74MB 才被拒
      hintMax: q('.caldav-attach-hint')?.textContent?.includes('单个文件上限')
    },
    // 设置弹窗「同步」板块的两个上限输入框（2026-10-15）
    settings: (() => {
      const s2 = document.querySelector('.caldav-settings');
      if (!s2) return null;
      const attach = s2.querySelector('[data-s="attachMax"]');
      const icsMax = s2.querySelector('[data-s="icsMax"]');
      const labelOf = (inp) => inp?.closest('.caldav-field')?.querySelector('.caldav-field-label')?.textContent?.trim();
      const rowOf = (inp) => inp?.closest('.caldav-field-row');
      return {
        attachLabel: labelOf(attach),
        attachValue: attach?.value,
        attachType: attach?.type,
        icsLabel: labelOf(icsMax),
        icsValue: icsMax?.value,
        icsType: icsMax?.type,
        // 两个输入框应在同一行（field-row），与「同步过去/未来」同构
        sameRow: attach && icsMax ? rowOf(attach) === rowOf(icsMax) : null,
        rowCount: s2.querySelectorAll('.caldav-field-row').length,
        hint: s2.querySelector('.caldav-set-hint')?.textContent?.includes('base64 内联')
      };
    })()
  };
})()`;

const m = await evalJs(MEASURE);
console.log("=== 实测 ===");
console.log(JSON.stringify(m, null, 1));

/* ---------- 4. 断言 ---------- */
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || detail === undefined ? "" : " —— " + detail}`);
  if (!ok) fail++;
};

check("待办第二个标签叫「备注附件」", m.tabLabels.note === "备注附件", `实际「${m.tabLabels.note}」`);
check("第一个标签仍叫「任务设置」", m.tabLabels.basic === "任务设置", `实际「${m.tabLabels.basic}」`);
check("标签页内是 2 个卡片区块", m.cardCount === 2, `实际 ${m.cardCount} 个`);
check("区块标题依次是「备注」「附件」", JSON.stringify(m.cardTitles) === JSON.stringify(["备注", "附件"]), `实际 ${JSON.stringify(m.cardTitles)}`);
check("二进制行图标 computed 尺寸是 14px", m.bin.iconCss && m.bin.iconCss.w === "14px" && m.bin.iconCss.h === "14px", JSON.stringify(m.bin.iconCss));
check("二进制行图标不再是巨化（渲染宽 < 24px）", m.bin.iconBox && m.bin.iconBox.width < 24 && m.bin.iconBox.height < 24, JSON.stringify(m.bin.iconBox));
check("文件名正常显示", m.bin.nameText === "合同扫描件.pdf", `实际「${m.bin.nameText}」`);
check("文件名未溢出裁剪（或优雅省略）", m.bin.nameClipped === false || m.bin.nameClipped === null, `scrollWidth>clientWidth`);
check("删除按钮与图标同一行", m.bin.sameRow === true, `Δtop=${m.bin.sameRow}`);
check("删除按钮文字含「删除」", (m.bin.delText || "").includes("删除"), `实际「${m.bin.delText}」`);
check("二进制行带「下载」按钮", (m.bin.dlText || "").includes("下载"), `实际「${m.bin.dlText}」`);
check("下载与删除按钮同一行", m.bin.sameRowDl === true, `Δtop=${m.bin.sameRowDl}`);
check("外链行没有下载按钮（外链没有可下载的内容）", m.uri.dlExists === false, `实际 ${m.uri.dlExists}`);
check("外链行仍是输入框 + 删除", m.uri.inputExists && m.uri.delExists && m.uri.inputValue === "https://example.com/files/需求文档.docx");
check("上传/添加链接按钮仍在", m.actions.upload && m.actions.add);
check("提示文案说明内联", m.actions.hint === true);
check("提示文案写明单文件硬上限", m.actions.hintMax === true, "上限不说清楚，用户还会传大文件试");

// 设置弹窗：同步板块的两个上限输入框
const st = m.settings;
check("设置弹窗渲染出了「同步」板块", !!st);
check("「附件大小限制（MB）」标签与默认值 5", st && st.attachLabel === "附件大小限制（MB）" && st.attachValue === "5", `标签=${st && st.attachLabel} 值=${st && st.attachValue}`);
check("「单个ICS文件限制（MB）」标签与默认值 10", st && st.icsLabel === "单个ICS文件限制（MB）" && st.icsValue === "10", `标签=${st && st.icsLabel} 值=${st && st.icsValue}`);
check("两个都是 number 输入框", st && st.attachType === "number" && st.icsType === "number");
check("两个输入框在同一行（与过去/未来同构）", st && st.sameRow === true);
check("设置里有说明文案", st && st.hint === true);

if (fail) { console.log(`[note-attach] ${fail} 项未过`); cleanup(); process.exit(1); }

// 留一张截图：几何数字之外，也让人眼能直接看排版（整页，设置板块在下方）
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
fs.writeFileSync(path.join(outDir, "note-attach.png"), Buffer.from(shot.data, "base64"));
console.log("[note-attach] 截图：" + path.join(outDir, "note-attach.png"));

console.log("[note-attach] 备注附件标签页实测通过（标签名 / 两卡片分区 / 小图标行）");
cleanup();
