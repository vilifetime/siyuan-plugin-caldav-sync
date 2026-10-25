/**
 * 回归测试：设置页「本地数据」区块的**真实渲染**校验（2026-10-24）
 *
 * 背景（雄哥截图实锤）：「立即清理」按钮显示成一串
 *   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="fill:none;...">`
 * 的源码文字。
 *
 * 根因：图标是 SVG **源码字符串**（icons.ts 的 `svg()` 返回 `<svg ...>...</svg>`），
 * 而按钮文案用 `btn.textContent = \`${icons.trash} 清理 N 条\`` 写入。
 * `textContent` **不解析 HTML** —— 整段 SVG 源码被当纯文本插进按钮。
 * （「恢复」按钮当时是好的：它的图标写在 HTML 模板里，JS 没碰过。）
 *
 * 修法：图标与文字分开 —— 模板里 `<button>${icons.trash}<span data-xxx-label>文字</span></button>`，
 * JS 只改 span 的 textContent，SVG 元素原样保留。
 *
 * 本测试**真的把 settingsHtml() 渲染进 jsdom** 再断言 DOM，
 * 而不是只做源码正则匹配 —— 源码匹配挡不住「图标与文字写在一起但恰好没被 JS 改」这类情况。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-purgeui");

// 用临时 tsconfig 编译：需要项目 tsconfig 的 paths（"@/*" → "src/*"），
// 且 CLI 不支持 --paths，只能走 -p。
const tsCfg = path.join(root, "tsconfig.purgeui.json");
fs.writeFileSync(
  tsCfg,
  JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "commonjs",
      moduleResolution: "node",
      esModuleInterop: true,
      skipLibCheck: true,
      strict: false,
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
      outDir: ".test-purgeui",
      rootDir: "src"
    },
    include: ["src/ui/settings-dialog.ts"]
  }, null, 2)
);
try {
  execSync(`npx tsc -p tsconfig.purgeui.json`, { cwd: root, stdio: "pipe" });
} finally {
  fs.rmSync(tsCfg, { force: true });
}

const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));

// 运行时把 "@/xxx" 别名解析到编译产物目录；
// "siyuan" 包只有 .d.ts 没有运行时入口（exports 里没给 default），require 会抛
// ERR_PACKAGE_PATH_NOT_EXPORTED —— 给个空桩即可（settingsHtml 不碰宿主 API）。
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(outDir, request.slice(2));
  if (request === "siyuan" || request.startsWith("siyuan/")) {
    return path.join(outDir, "siyuan-stub.js");
  }
  return origResolve.call(this, request, ...rest);
};
fs.writeFileSync(path.join(outDir, "siyuan-stub.js"), `"use strict";\nmodule.exports = {};\n`);

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n    ", e.message);
    process.exitCode = 1;
  }
}

// 宿主环境（settings-dialog 顶部的模块级代码会碰 document/window）
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try { globalThis.navigator = dom.window.navigator; } catch {}
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;

const { settingsHtml } = require(path.join(outDir, "ui", "settings-dialog.js"));

const settings = {
  serverType: "icloud",
  serverUrl: "https://caldav.icloud.com",
  username: "u",
  password: "",
  calendarPath: "",
  channel: "auto",
  syncIntervalMin: 10,
  conflict: "server",
  pastDays: 7,
  futureDays: 30,
  attachSizeMaxMB: 5,
  icsSizeMaxMB: 10,
  enableReminders: true,
  includeOverdueTodos: false,
  purgeOtherServerOnSwitch: false,
  calendars: []
};

const doc = new JSDOM(`<body>${settingsHtml(settings, false)}</body>`).window.document;
const nowBtn = doc.querySelector("[data-action='purge-now']");
const restoreBtn = doc.querySelector("[data-action='purge-restore']");
const nowLabel = doc.querySelector("[data-purge-now-label]");
const restoreLabel = doc.querySelector("[data-purge-restore-label]");

console.log("[purge-ui] 「本地数据」区块渲染");

t("两个按钮都渲染出来了", () => {
  assert.ok(nowBtn, "应有「立即清理」按钮");
  assert.ok(restoreBtn, "应有「恢复」按钮");
});

t("图标是真正的 svg 元素，不是文本", () => {
  assert.ok(nowBtn.querySelector("svg"), "清理按钮应含 svg 元素");
  assert.ok(restoreBtn.querySelector("svg"), "恢复按钮应含 svg 元素");
});

t("按钮可见文字里不含 <svg 源码", () => {
  assert.ok(!nowBtn.textContent.includes("<svg"), "清理按钮文字含 SVG 源码");
  assert.ok(!restoreBtn.textContent.includes("<svg"), "恢复按钮文字含 SVG 源码");
});

t("默认文案正确", () => {
  // 多账户（2026-10-25）后文案改为「其他服务器」（不属于任何已配置账户的本地条目）
  assert.strictEqual(nowBtn.textContent.trim(), "立即清理其他服务器的本地条目");
  assert.strictEqual(restoreBtn.textContent.trim(), "恢复上次清理的条目");
});

t("图标与文字分成两个节点（JS 只改文字节点）", () => {
  assert.ok(nowLabel, "清理按钮应有独立的文字节点");
  assert.ok(restoreLabel, "恢复按钮应有独立的文字节点");
});

t("改文案后 svg 元素仍在、文字正确", () => {
  nowLabel.textContent = "清理 227 条旧服务器条目";
  assert.ok(nowBtn.querySelector("svg"), "改文案后 svg 元素应保留");
  assert.strictEqual(nowBtn.textContent.trim(), "清理 227 条旧服务器条目");
  assert.ok(!nowBtn.textContent.includes("<svg"));
});

t("二次点击确认文案后 svg 元素仍在", () => {
  nowLabel.textContent = "再点一次确认清理 227 条";
  assert.ok(nowBtn.querySelector("svg"), "改文案后 svg 元素应保留");
  assert.strictEqual(nowBtn.textContent.trim(), "再点一次确认清理 227 条");
});

t("恢复按钮带条数后 svg 元素仍在", () => {
  restoreLabel.textContent = "恢复上次清理的 12 条";
  assert.ok(restoreBtn.querySelector("svg"), "改文案后 svg 元素应保留");
  assert.strictEqual(restoreBtn.textContent.trim(), "恢复上次清理的 12 条");
});

t("整页没有把 SVG 源码当文字输出的地方", () => {
  // 任何 .textContent 赋值里内嵌 <svg 都会在界面上露出源码
  const bodyText = doc.body.textContent;
  assert.ok(!bodyText.includes("<svg"), "页面文本里出现了 SVG 源码");
  assert.ok(!bodyText.includes("viewBox"), "页面文本里出现了 viewBox 字面量");
});

console.log(`\n[purge-ui] 通过 ${passed} 项`);
