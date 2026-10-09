/**
 * 移动端适配回归：把 getFrontend() 切成 mobile，验证
 *  1) 声明并注册移动端入口（顶栏 → 移动端归入「插件」菜单）
 *  2) 不再走 addTab / openTab（思源移动端里二者是空实现，移动端也没有页签栏）
 *  3) 日历与任务视图改由全屏 Dialog 承载，且复用单例、可切换视图
 *  4) 触摸长按（pointerdown + 480ms）能展开条目菜单，替代桌面右键
 *  5) 产物与 plugin.json 确实带上了移动端声明
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupBrowserDom, loadBuiltPlugin, seedStore, settle } from "./helpers.mjs";

// 必须在加载产物之前设置：桩的 getFrontend() 读取该变量
process.env.SY_FRONTEND = "mobile";

setupBrowserDom();

// 思源移动端侧栏骨架（#sidebar / #sidebarRight）。插件靠观察它们来补挂 Dock 面板，
// 所以必须在 onload 之前就位（真实环境里这段 HTML 在 index.html 里）。
const DOCK_KEY = "siyuan-plugin-caldav-sync" + "caldav-sync-dock";
["sidebar", "sidebarRight"].forEach((id) => {
  const panel = document.createElement("div");
  panel.id = id;
  panel.className = "side-panel fn__flex-column";
  panel.innerHTML =
    `<div class="toolbar toolbar--border"><div class="toolbar__scroll"></div></div>` +
    `<div class="fn__flex-1 b3-list--mobile"></div>`;
  document.body.appendChild(panel);
});

/** 按思源 syncMobilePluginDockElements 的方式造一个插件 Dock 的内容容器 */
function makeDockContainer(attachTo = document.getElementById("sidebar").querySelector(".fn__flex-1")) {
  const el = document.createElement("div");
  el.className = "fn__flex-column fn__none";
  el.dataset.type = `sidebar-${DOCK_KEY}`;
  el.dataset.mobilePluginDockContent = DOCK_KEY;
  if (attachTo) attachTo.appendChild(el);
  return el;
}

/**
 * 造一个「上一版代码遗留」的插件全屏层：DOM 结构同思源 Dialog，
 * 但不属于当前插件实例。覆盖安装 / 集市热更新只换 JS，页面上这些弹层会原样留下，
 * 新代码的任何数组都不认识它们 —— 用户遇到的「关掉一层下面还压着一层」即此。
 */
function makeLeftover(kind) {
  const wrap = document.createElement("div");
  const box = document.createElement("div");
  box.className = "b3-dialog";
  const scrim = document.createElement("div");
  scrim.className = "b3-dialog__scrim";
  const container = document.createElement("div");
  container.className = "b3-dialog__container caldav-mobile-dialog";
  container.innerHTML = `<div class="b3-dialog__body"><div class="${
    kind === "sheet" ? "caldav-editor" : "caldav-mobile-host"
  }"></div></div>`;
  box.append(scrim, container);
  wrap.appendChild(box);
  wrap.classList.add("b3-dialog--open");
  document.body.appendChild(wrap);
  return wrap;
}

// 装新版本时页面上还留着旧版本的全屏层（正是「要连点 5 次关闭」的来源）
makeLeftover("page");
makeLeftover("page");
makeLeftover("sheet");

const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
assert.ok(PluginClass, "应导出默认插件类");

const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();
// 加载即清场：覆盖安装/热更新留下的旧层不该继续压在整屏上
assert.strictEqual(document.querySelectorAll(".b3-dialog").length, 0, "插件加载时应把上一版代码遗留的全屏层清干净");

const reg = globalThis.__syRegistrations;

// ---- 入口注册 ----
assert.strictEqual(reg.topbar.length, 1, "移动端应注册顶栏入口（移动端归入「插件」菜单）");
assert.strictEqual(reg.dock.length, 1, "Dock 仍应注册（移动端渲染为侧栏抽屉）");
assert.strictEqual(reg.tab.length, 1, "addTab 仍会注册（桌面端用），但移动端不会调用 openTab");
assert.strictEqual(reg.commands.length, 4, "命令数量不受移动端影响");
assert.strictEqual(reg.topbar[0].title, "CalDAV日历任务", "顶栏入口标题要带插件名，避免与其他日历插件撞名");

// ---- Dock 初始化不应自动打开面板 ----
seedStore(plugin);
const dockEl = makeDockContainer();
const dockCustom = { element: dockEl, data: { key: "dock" } };
reg.dock[0].init.call(dockCustom, dockCustom);
await new Promise((r) => setTimeout(r, 500));
assert.strictEqual(reg.lastOpenTab, undefined, "移动端不应自动调用 openTab（移动端是空实现）");
assert.ok(dockEl.classList.contains("caldav-touch"), "移动端 Dock 也应带 caldav-touch 标记（抽屉里的格子同样放不下时间）");
assert.ok(dockEl.querySelector(".caldav-dock-brand"), "Dock 面板应挂进侧栏容器");

// ---- Dock 生命周期：思源移动端再次激活只调 update（不调 init），必须实现 ----
assert.strictEqual(typeof reg.dock[0].update, "function", "必须提供 update：思源 updateDock 只在有 update 时才响应再次激活");

// 模拟思源重建侧栏容器：旧容器被丢掉、新容器就位，而缓存的 custom 仍指向旧元素。
// 断言紧随同步调用 —— 此时观察器的回调还没机会跑，能挂上就只能是 update 干的。
const staleEl = dockEl;
const staleCustom = { element: staleEl, data: { key: "dock" } };
staleEl.remove();
const freshEl = makeDockContainer();
reg.dock[0].update.call(staleCustom, staleCustom);
assert.ok(
  freshEl.querySelector(".caldav-dock-brand"),
  "update 应把面板重新挂到当前活着的容器上（否则侧栏重建后永远一片空白）"
);

// ---- 补挂：容器由侧栏布局创建出来、从未经过 init/update ----
freshEl.remove();
const orphanEl = makeDockContainer();
await new Promise((r) => setTimeout(r, 0));
assert.ok(orphanEl.querySelector(".caldav-dock-brand"), "空容器出现后应被自动补挂，而不是留一片空白");

// ---- 移动端全屏层不叠加：从 Dock 连点几个入口后只留一层 ----
// 思源的每个 Dialog 都是独立元素 + 独立遮罩 + 递增 z-index，彼此没有互斥；
// 以前从 Dock 点「新增 / 日历 / 任务」会叠出好几层全屏页面，
// 用户得连点好几次右上角关闭才回得到 Dock。
const clickIn = (root, sel) => {
  const el = root.querySelector(sel);
  assert.ok(el, `Dock 上应存在 ${sel}`);
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
};
/**
 * 一个「层」= 弹层最外层那个元素（思源里是无类名的壳，里面才是 .b3-dialog）。
 * 把它找出来，才能按 `b3-dialog--open` 判断这一层是否真的显示着 ——
 * 显形开关就是它（base.css：`.b3-dialog__scrim{opacity:0}`、
 * `.b3-dialog--open .b3-dialog__container{opacity:1}`），而 destroy() 只摘这个类、
 * 元素还要等一个 timeout 才移除，被顶掉的层则会被 display:none 藏起来。
 */
const layerBoxes = () =>
  Array.from(document.querySelectorAll(".b3-dialog")).map((el) => {
    let n = el;
    while (n.parentElement && n.parentElement !== document.body) n = n.parentElement;
    return n;
  });
const isShown = (box) => {
  if (!box.isConnected || !box.classList.contains("b3-dialog--open")) return false;
  for (let n = box; n && n.nodeType === 1; n = n.parentElement) {
    if (n.style && n.style.display === "none") return false;
  }
  return true;
};
/** 用户此刻要按几次「关闭」才退得回去 = 真正显示着的层数（这就是用户说的「点了 5 次」） */
const visibleLayers = () => layerBoxes().filter(isShown);
const allLayers = () => layerBoxes().length;

// 2026-10-10 起 Dock 的「新建」入口已移除，改用「日历视图 / 任务视图」两个入口
// 验证同一件事（连点入口不叠层）。
clickIn(orphanEl, '[data-action="cal-view"]');
assert.strictEqual(visibleLayers().length, 1, "从 Dock 点「日历视图」应只开一层（全屏面板）");

clickIn(orphanEl, '[data-action="task-view"]');
assert.strictEqual(visibleLayers().length, 1, "再点「任务视图」应替换掉上一层，而不是叠成第二层");
await settle(); // 思源销毁弹层是异步的（先淡出、后移除并回调）
assert.strictEqual(allLayers(), 1, "被替换的层应被真正销毁，不留残壳");

clickIn(orphanEl, '[data-action="task-view"]');
assert.strictEqual(visibleLayers().length, 1, "再点「任务视图」应复用同一层，仍然只有一层");
assert.ok(document.querySelector(".caldav-mobile-host .cal-task"), "最后一层应是任务视图");
// 旧层的 destroyCallback 是**异步**的：若它把新一层的引用清掉，这一步之后页面就空了
await settle();
assert.ok(
  document.querySelector(".caldav-mobile-host .cal-task"),
  "异步回调不得波及被复用的页面层（否则切一次视图就变空白，且守卫失效后每点一次都会新建一层）"
);
assert.strictEqual(visibleLayers().length, 1, "复用页面层后仍应只有一层");

// ---- 历史遗留层必须被收掉：不在账上的层才是「关不掉」的真凶 ----
makeLeftover("page");
makeLeftover("page");
makeLeftover("sheet");
assert.strictEqual(visibleLayers().length, 4, "先摆出「当前页 + 两个残留页面 + 一个残留编辑层」的现场");
clickIn(orphanEl, '[data-action="cal-view"]');
assert.strictEqual(visibleLayers().length, 1, "点一次入口就该把残留层收干净，只剩当前这一层");
await settle();
assert.strictEqual(allLayers(), 1, "残留层应被摘掉，而不是留在 DOM 里等着顶上来");

// ---- 关闭后立刻再点入口：思源销毁要等一个 timeout，这期间引用还指着那一层 ----
// （不识别「正在销毁」就会复用一个已经不可见的层 —— 用户看到的是「点了没反应」）
const dyingPage = globalThis.__lastDialogInstance;
dyingPage.destroy();
assert.strictEqual(visibleLayers().length, 0, "点关闭后这一层应立刻不可见");
plugin.openPanelTab("month");
assert.strictEqual(visibleLayers().length, 1, "紧接着再点入口应立刻出新的页面层，而不是没反应");
await settle();
assert.strictEqual(allLayers(), 1, "正在销毁的旧层应一并清掉，不留多余的层");

// ---- 打开面板：走全屏 Dialog 承载 ----
plugin.openPanelTab("month");
const dialogWrap = document.querySelector(".b3-dialog");
assert.ok(dialogWrap, "移动端应通过 Dialog 承载面板");
const container = dialogWrap.querySelector(".b3-dialog__container");
assert.ok(container?.classList.contains("caldav-mobile-dialog"), "承载弹层应带 caldav-mobile-dialog 标记");
assert.strictEqual(globalThis.__lastDialog.options.width, "100vw", "承载弹层应占满视口宽度");
assert.strictEqual(globalThis.__lastDialog.options.height, "100vh", "承载弹层应占满视口高度");

const host = dialogWrap.querySelector(".caldav-mobile-host");
assert.ok(host, "Dialog 内应有承载容器");
assert.ok(host.classList.contains("caldav-root"), "承载容器应被 renderPanel 接管");
assert.ok(host.querySelector(".cal-month-grid"), "应在 Dialog 内渲染月视图");
assert.strictEqual(reg.lastOpenTab, undefined, "承载面板不应退回 openTab");
assert.ok(host.classList.contains("caldav-touch"), "移动端面板应带 caldav-touch 标记（据以隐藏格子里的时间）");

// ---- 移动端视图切换同样生效，且不新建弹层 ----
plugin.openPanelTab("task");
assert.ok(document.querySelector(".caldav-mobile-host .cal-task"), "切到任务视图应渲染任务列表");
assert.strictEqual(document.querySelectorAll(".caldav-mobile-dialog").length, 1, "切换视图应复用同一弹层");

// ---- 从页面点条目编辑：允许叠一层（关掉编辑正好回到该页面） ----
const openEntry = document.querySelector(".caldav-mobile-host [data-open]");
assert.ok(openEntry, "页面里应有可点击的条目");
openEntry.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
assert.strictEqual(visibleLayers().length, 2, "从页面点条目编辑应叠在当前页面之上（关掉即回到该页面）");
assert.ok(document.querySelector(".caldav-editor"), "第二层应是编辑弹窗");
globalThis.__lastDialogInstance.destroy();
assert.strictEqual(visibleLayers().length, 1, "关掉编辑弹窗后应回到日历/任务页面");
await settle();
assert.strictEqual(allLayers(), 1, "关掉的编辑弹窗应被真正移除，不留残壳");
assert.ok(document.querySelector(".caldav-mobile-host"), "留下的应是原来的页面层");

// ---- 触摸长按 = 桌面右键 ----
const item = host.querySelector("[data-open]");
assert.ok(item, "月视图里应有可交互条目");
const down = new window.MouseEvent("pointerdown", { bubbles: true, clientX: 30, clientY: 30 });
Object.defineProperty(down, "pointerType", { value: "touch" });
item.dispatchEvent(down);
const menu = host.querySelector(".caldav-ctxmenu");
assert.ok(menu?.hidden !== false, "长按未达阈值时菜单不应展开");

await new Promise((r) => setTimeout(r, 620));
assert.strictEqual(menu.hidden, false, "长按条目应展开菜单（触摸端替代右键）");

// ---- 设置页：点一次「关闭」就该回到 Dock ----
// 设置页以前没有登记进层管理：它既收不掉下面的层，自己也不被后续开层认领，
// 于是用户点开设置后要连点好几次关闭才退得回去。
const closeTop = () => {
  const box = visibleLayers().at(-1);
  assert.ok(box, "此刻应有一层可关");
  box
    .querySelector(".b3-dialog__close")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
};
closeTop();
await settle();
assert.strictEqual(allLayers(), 0, "先清空现场");

makeLeftover("page");
makeLeftover("sheet");
assert.strictEqual(visibleLayers().length, 2, "摆出「设置页下面压着上一版残留层」的现场");
clickIn(orphanEl, ".caldav-brand-set");
assert.ok(document.querySelector(".caldav-settings"), "Dock 标题栏的齿轮应打开设置页");
assert.strictEqual(visibleLayers().length, 1, "设置页打开时应把残留层收干净，只剩这一层");
await settle();
assert.strictEqual(allLayers(), 1, "残留层应被摘掉，而不是留在下面等着顶上来");
closeTop();
assert.strictEqual(visibleLayers().length, 0, "点一次关闭就该回到 Dock（不必连点好几次）");
await settle();
assert.strictEqual(allLayers(), 0, "设置页应被真正销毁，不留残壳");

// ---- 从日历页面开设置：叠一层，关掉回该页面 ----
plugin.openPanelTab("month");
assert.strictEqual(visibleLayers().length, 1, "先只打开日历页面");
plugin.openSetting();
assert.ok(document.querySelector(".caldav-settings"), "设置页应打开");
assert.strictEqual(visibleLayers().length, 2, "设置页应叠在日历页面之上，而不是把它顶掉");
closeTop();
assert.strictEqual(visibleLayers().length, 1, "关掉设置页应回到日历页面");
await settle();
assert.ok(document.querySelector(".caldav-mobile-host"), "留下的应是日历页面");

// ---- 分类管理：从编辑弹窗里再开的次级弹窗，必须保住编辑弹窗 ----
const pageEl = document.querySelector(".caldav-mobile-host");
pageEl
  .querySelector("[data-open]")
  .dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
assert.strictEqual(visibleLayers().length, 2, "页面 + 编辑弹窗");
const editorDialog = globalThis.__lastDialogInstance;
// 编辑弹窗开着时，页面上再冒出一个上一版的残留层 ——
// 只有「每次开层都扫一遍」才收得掉它；漏了登记就会原地留下、变成「关了还得再点」
makeLeftover("page");
assert.strictEqual(visibleLayers().length, 3, "页面 + 编辑弹窗 + 残留层");
const catBtn = document.querySelector(".caldav-editor [data-action='cat-manage']");
assert.ok(catBtn, "编辑弹窗里应有「分类管理」入口");
catBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
assert.ok(document.querySelector(".caldav-catmgr"), "应打开分类管理弹窗");
assert.strictEqual(visibleLayers().length, 3, "分类管理应叠在编辑弹窗之上，并顺手收掉残留层");
assert.ok(editorDialog.element.isConnected, "编辑弹窗必须留着 —— 分类管理不能把没保存的修改顶掉");
closeTop();
assert.strictEqual(visibleLayers().length, 2, "关掉分类管理应回到编辑弹窗");
await settle();
assert.ok(document.querySelector(".caldav-editor:not(.caldav-catmgr)"), "留下的应是编辑弹窗");
assert.ok(!document.querySelector(".caldav-catmgr"), "分类管理应被真正移除");

/** 把页面上所有层收干净，给下一段用例一个干净现场 */
const clearAllLayers = async () => {
  let guard = 0;
  while (visibleLayers().length && guard++ < 20) {
    const box = visibleLayers().at(-1);
    const closeBtn = box.querySelector(".b3-dialog__close");
    if (closeBtn) closeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    else box.remove();
    await settle(2);
  }
  await settle();
};

// ---- Dock 容器被原样复用（热更新 / 侧栏重建）时，监听器不得叠加 ----
// 思源移动端 removeMobilePluginDock 只清 element.innerHTML，容器元素本身留着；
// 覆盖安装 / 集市热更新换掉 JS 后，插件会把面板重新挂到**同一个元素**上。
// 若 destroy 不摘掉旧监听，同一元素上就会叠出多个 click 处理器 ——
// 一次点击触发多次动作，用户看到的就是「点一次『设置』弹出两个窗口」。
// （下面直接把「当前活着的 Dock 容器」换成被测容器，独占 liveDockElement() 的结果。）
orphanEl.remove();
await settle(1);
const reuseEl = makeDockContainer();
// 记名统计容器自身上的 click 处理器：叠加则集合变大
const clickFns = new Set();
const origAdd = reuseEl.addEventListener;
const origRem = reuseEl.removeEventListener;
reuseEl.addEventListener = function (type, fn, opts) {
  if (type === "click") clickFns.add(fn);
  return origAdd.call(this, type, fn, opts);
};
reuseEl.removeEventListener = function (type, fn, opts) {
  if (type === "click") clickFns.delete(fn);
  return origRem.call(this, type, fn, opts);
};
const reuseCustom = { element: reuseEl, data: { key: "dock" } };
reg.dock[0].init.call(reuseCustom, reuseCustom);
assert.ok(reuseEl.querySelector(".caldav-dock-brand"), "复用容器应挂上 Dock 面板");
assert.strictEqual(clickFns.size, 1, "初次挂载应只在容器上注册一个 click 处理器");
// 模拟思源清空容器内容后再激活（update）—— 插件把面板重挂到同一元素
reuseEl.innerHTML = "";
reg.dock[0].update.call(reuseCustom, reuseCustom);
assert.ok(reuseEl.querySelector(".caldav-dock-brand"), "重挂后应再次出现 Dock 面板");
assert.strictEqual(clickFns.size, 1, "重挂后 click 处理器不得叠加（叠加 = 一次点击触发多次）");
await settle(1);
assert.strictEqual(clickFns.size, 1, "观察器补挂后仍不得叠加处理器");

// 行为层面再兜一次：一次点击只开一个设置窗口
await clearAllLayers();
clickIn(reuseEl, ".caldav-brand-set");
assert.strictEqual(document.querySelectorAll(".caldav-settings").length, 1, "一次点击只应开出一个设置窗口");
await clearAllLayers();

// ---- 设置页单例：入口被触发几次，设置窗口都只能有一个 ----
plugin.openSetting();
plugin.openSetting();
assert.strictEqual(document.querySelectorAll(".caldav-settings").length, 1, "重复触发设置入口应只开一个设置窗口（否则关一个还剩一个）");
assert.strictEqual(visibleLayers().length, 1, "设置页只应有一层可见");
// 关掉后还能再打开（单例不能在销毁后一直拦着）
await clearAllLayers();
plugin.openSetting();
assert.ok(document.querySelector(".caldav-settings"), "关掉设置页后应能重新打开");
await clearAllLayers();

// ---- 引用悬空：页面层被外部摘出 DOM 后，再点入口必须能重开 ----
// 只判 destroying 不够：层被别处摘出 DOM（或还没连上）时 destroying 仍为 false，
// 抱着它当「可复用」就会永远 return —— 用户看到的就是「点了入口什么也不出来」。
plugin.openPanelTab("month");
plugin.openPanelTab("month"); // 复用同一层
const dangling = globalThis.__lastDialogInstance;
assert.strictEqual(visibleLayers().length, 1, "先只有一层日历页面");
dangling.element.remove(); // 层被外部摘出 DOM（引用还在、destroying 仍为 false）
assert.strictEqual(visibleLayers().length, 0, "摘出后页面上已无可见层");
plugin.openPanelTab("month");
assert.strictEqual(visibleLayers().length, 1, "层被摘出 DOM 后再点入口应重开一层，而不是「点了没反应」");
await settle();
assert.strictEqual(allLayers(), 1, "悬空的旧引用应被彻底丢弃，不留残壳");
await clearAllLayers();

// ---- 凭据安全：密码框留空不得覆盖已存密码（「总是丢密码」的直接原因之一） ----
const buildJs = fs.readFileSync(
  path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "dist", "index.js"),
  "utf8"
);
assert.ok(buildJs.includes("留空则保持不变"), "密码框必须提示「留空则保持不变」（留空即覆盖是丢密码的直接原因）");
assert.ok(
  buildJs.includes("密码解不开：这段密文由另一台设备写入"),
  "解密失败时应说明密文来自另一台设备，而不是含糊地说「密钥丢失」"
);
assert.ok(buildJs.includes("密码待解密（密钥尚未就绪）"), "密钥未就绪必须是可重试的独立状态，不能等同密码损坏");
assert.ok(
  !buildJs.includes("本地密钥已丢失"),
  "旧的误导性提示必须消失（它让用户以为密码没了，实际只是密钥来源不同）"
);

// ---- 产物断言：移动端样式与插件声明 ----
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(root, "dist", "index.css"), "utf8");
assert.ok(css.includes(".caldav-mobile-dialog"), "产物 CSS 应包含移动端全屏承载样式");
assert.ok(css.includes("-webkit-touch-callout"), "产物 CSS 应禁用条目长按的系统呼出");
assert.ok(css.includes("@media (max-width: 768px)"), "产物 CSS 应包含窄屏布局");
// 触摸形态隐藏条目时间（月视图 chip 与周/日视图块）。
// 双保险：除 .caldav-touch 外，移动端全屏弹层（.caldav-mobile-dialog）里也一律隐藏，
// 免得某个页面不是按当时那份 isMobile() 判定渲染时又把时间挤回来。
assert.ok(
  /\.caldav-touch \.cal-chip-time[^{]*\{[^}]*display:\s*none/.test(css),
  "产物 CSS 应在 caldav-touch 下隐藏月视图条目的时间"
);
assert.ok(
  /\.caldav-touch \.cal-wk-block-time[^{]*\{[^}]*display:\s*none/.test(css),
  "产物 CSS 应在 caldav-touch 下隐藏周/日视图块的时间"
);
assert.ok(
  /\.caldav-mobile-dialog \.cal-chip-time[^{]*\{[^}]*display:\s*none/.test(css),
  "产物 CSS 应在移动端全屏弹层里也隐藏条目的时间（不依赖渲染时的 isMobile() 快照）"
);
// 窄屏工具栏：动作按钮组必须占满整行，否则右对齐无从生效
assert.ok(
  /\.caldav-toolbar-right\s*\{[^}]*flex:\s*1 1 100%/.test(css),
  "窄屏下动作按钮组应占满整行（右对齐的前提）"
);
assert.ok(
  /\.caldav-toolbar-right\s*\{[^}]*justify-content:\s*flex-end/.test(css),
  "窄屏下动作按钮组应右对齐"
);
// 窄屏「日历筛选」浮层：改由工具栏定位并铺满整行，避免向左溢出被裁掉
assert.ok(
  /\.caldav-calfilter-wrap\s*\{\s*position:\s*static/.test(css),
  "窄屏下筛选浮层应改由工具栏定位"
);
// 页脚按钮不得换行
assert.ok(
  /\.caldav-editor-foot \.caldav-foot-btn\s*\{[^}]*white-space:\s*nowrap/.test(css),
  "页脚按钮应禁止换行（窄屏下「取消」「保存」会被压成两行）"
);

const pj = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
assert.ok(pj.frontends.includes("mobile"), "plugin.json 应声明支持 mobile 前端");
assert.ok(pj.frontends.includes("browser-mobile"), "plugin.json 应声明支持 browser-mobile 前端");

// ---- 卸载清理应安全退化：移动端没有页签栏，getOpenedTab 返回空，不得抛错 ----
plugin.onunload();

console.log(
  "[mobile] 移动端适配回归全部通过（顶栏入口 / Dialog 承载 / 不走 openTab / 视图切换 / 长按菜单 / 隐藏条目时间 / 工具栏右对齐 / 页脚不换行 / 窄屏样式 / 前端声明）"
);
