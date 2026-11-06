/**
 * 新建日程/待办编辑弹窗「初始焦点落在标题框」回归（jsdom + 真实插件链路）。
 *
 * 2026-11-06 雄哥要求：新建时不用再拿鼠标点进标题输入框，直接就能打字。
 * 钉死四件事：
 *   ① 新建日程 → 焦点在 `input[data-f="summary"]`
 *   ② 新建待办 → 同上
 *   ③ 编辑已有条目 → 不抢焦点（用户可能正想改日期/备注）
 *   ④ 移动端 → 不自动聚焦（会立刻唤起软键盘盖住弹窗）
 *
 * 走真实链路：seedStore → 注册页签 init → 面板上的新建/已有条目按钮 → 思源 Dialog 桩。
 * 思源 Dialog 构造会同步把焦点放到 container，实现里用 setTimeout(0) 覆盖，故断言前要 settle。
 */
import assert from "node:assert/strict";
import { setupBrowserDom, loadBuiltPlugin, seedStore, settle } from "./helpers.mjs";

setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();
seedStore(plugin);

const click = (el) => el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
const reg = globalThis.__syRegistrations;
const tabEl = document.createElement("div");
document.body.appendChild(tabEl);
const tabCustom = { element: tabEl, data: { key: "tab" } };
reg.tab[0].init.call(tabCustom, tabCustom);

const editor = () => document.querySelector(".caldav-editor");
const titleInput = () => editor()?.querySelector('input[data-f="summary"]');
const closeEditor = async () => {
  globalThis.__lastDialogInstance?.destroy();
  await settle(4); // 桩的 Dialog.destroy 是异步淡出（默认 15ms）
};

let pass = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  pass++;
};

// ① 新建日程
click(tabEl.querySelector('[data-action="new-event"]'));
// 真实思源 Dialog 构造时会同步 focus `.b3-dialog__container`，桩没模拟这一步，
// 这里补上：实现必须能把焦点从这个 container 抢到标题输入框，才叫真的生效。
const container = document.querySelector(".b3-dialog__container");
container?.setAttribute("tabindex", "-1");
container?.focus();
ok(document.activeElement === container, "前置条件：思源 Dialog 会先把焦点放在 container");
await settle(2);
ok(!!editor(), "新建日程应打开编辑弹窗");
ok(document.activeElement === titleInput(), "新建日程：初始焦点应覆盖 container 落在事件标题输入框");

// ② 新建待办
await closeEditor();
click(tabEl.querySelector('[data-action="new-todo"]'));
await settle(2);
ok(!!editor(), "新建待办应打开编辑弹窗");
ok(document.activeElement === titleInput(), "新建待办：初始焦点应在待办标题输入框");

// ③ 编辑已有条目不该抢焦点（与 attach-confirm.mjs 同一条链路）
await closeEditor();
click(tabEl.querySelector('[data-action="toggle-view"]'));
const taskRow = [...tabEl.querySelectorAll(".cal-task[data-open]")].find((el) => (el.textContent || "").includes("测试条目 2"));
ok(!!taskRow, "任务视图里应能找到已有待办");
if (taskRow) {
  click(taskRow);
  await settle(2);
  ok(!!editor(), "点已有待办应打开编辑弹窗");
  ok(document.activeElement !== titleInput(), "编辑已有条目：不应自动把焦点抢到标题框");
}

// ④ 移动端不自动聚焦（避免唤起软键盘）
await closeEditor();
process.env.SY_FRONTEND = "mobile";
try {
  click(tabEl.querySelector('[data-action="new-event"]'));
  await settle(2);
  ok(!!editor(), "移动端新建日程应打开编辑弹窗");
  ok(document.activeElement !== titleInput(), "移动端新建：不应自动聚焦标题框（会唤起软键盘）");
} finally {
  delete process.env.SY_FRONTEND;
}

console.log(`editor-autofocus tests: ${pass} passed, 0 failed`);
