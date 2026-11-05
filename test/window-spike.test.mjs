/**
 * SPIKE issue#5 契约测试：全局快捷键 → 独立窗口。
 *
 * 目的：把「闭环」里能在 jsdom 里静态验证的部分锁死，剩下的
 *（系统级 globalShortcut 是否真能在思源后台触发、新 electron 窗口能否
 * 重建插件自定义页签）由实机验证步骤覆盖。
 *
 * 锁住的四条：
 *  1. 注册了 langKey="openCalendarWindow" 的命令，hotkey 非空、callback 与
 *     globalCallback 都是函数（思源仅对带 globalCallback 且 custom 非空的命令
 *     注册系统级全局快捷键 —— hotkey 为空则 custom 为空、压根不会注册）。
 *  2. 触发 globalCallback / callback 后：先 openTab 取得 Tab 实例，再把该实例
 *     交给 openWindow，并带上 alwaysOnTop / width / height。
 *     openWindow 只认「openTab 返回的已存在 Tab 实例」，不能传裸参数。
 *  3. 桌面端限定：移动端 openWindow/openTab 是空实现，不应发起调用。
 *  4. i18n 两个字典 key 一致，且都含新命令键与中文文案键。
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupBrowserDom, loadBuiltPlugin, settle } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();

const reg = globalThis.__syRegistrations;

/* ---------- 1. 命令注册形态 ---------- */
const cmd = reg.commands.find((c) => c.langKey === "openCalendarWindow");
assert.ok(cmd, "应注册 openCalendarWindow 命令（SPIKE issue#5）");
assert.ok(typeof cmd.hotkey === "string" && cmd.hotkey.length > 0,
  "hotkey 必须非空：思源取 keymap.custom 作为系统级快捷键 accelerator");
assert.strictEqual(typeof cmd.callback, "function", "应用内触发需有 callback");
assert.strictEqual(typeof cmd.globalCallback, "function",
  "焦点不在应用内（后台/最小化）触发需有 globalCallback");
assert.strictEqual(cmd.langText, "在独立窗口打开日历", "命令显示文案走 _t() 本地化");

/* ---------- 2. globalCallback / callback → openTab → openWindow ---------- */
async function fireAndCapture(trigger) {
  delete reg.lastOpenTab;
  delete reg.lastOpenWindow;
  trigger();
  await settle(); // openTab 返回 Promise，then 里再调 openWindow
  return { openedTab: reg.lastOpenTab, win: reg.lastOpenWindow };
}

function assertWindowChain({ openedTab, win }, label) {
  assert.ok(openedTab, `${label}：应先 openTab 取得页签`);
  assert.ok(openedTab.custom && openedTab.custom.id, `${label}：openTab 应是带 id 的 custom 页签`);
  assert.ok(win, `${label}：应调用 openWindow 弹独立窗口`);
  assert.ok(win.tab, `${label}：openWindow 必须收到已存在的 Tab 实例`);
  assert.strictEqual(win.tab.id, openedTab.custom.id,
    `${label}：传给 openWindow 的必须是 openTab 返回的那个 Tab 实例`);
  assert.strictEqual(win.alwaysOnTop, true, `${label}：窗口应置顶`);
  assert.ok(win.width > 0 && win.height > 0, `${label}：应指定窗口尺寸`);
}

const gbResult = await fireAndCapture(cmd.globalCallback);
assertWindowChain(gbResult, "globalCallback 链路");
const cbResult = await fireAndCapture(cmd.callback);
assertWindowChain(cbResult, "callback 链路");

/* ---------- 3. 桌面端限定 ---------- */
process.env.SY_FRONTEND = "browser-mobile";
try {
  const r = await fireAndCapture(cmd.globalCallback);
  assert.strictEqual(r.openedTab, undefined, "移动端不应 openTab（空实现）");
  assert.strictEqual(r.win, undefined, "移动端不应 openWindow（空实现）");
} finally {
  delete process.env.SY_FRONTEND;
}

/* ---------- 4. i18n 字典一致 ---------- */
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "i18n", "zh_CN.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "i18n", "en_US.json"), "utf8"));
assert.deepStrictEqual(Object.keys(zh).sort(), Object.keys(en).sort(),
  "zh_CN / en_US 字典 key 必须完全一致");
assert.ok(zh.openCalendarWindow && en.openCalendarWindow, "应含命令 stock 键 openCalendarWindow");
assert.ok(zh["在独立窗口打开日历"] && en["在独立窗口打开日历"], "应含中文文案键");

/* ---------- 5. 独立窗口时序契约（首轮实机白屏的根因防线） ----------
 * 思源新窗口 loadPlugins() 默认不 await 插件的 async onload()，布局恢复会先跑。
 * 若 addTab 写在第一个 await 之后，plugin.models 还没注册，newModelByInitData
 * 找不到工厂 → 抛错冒泡到 getEmojiConf 回调 → layoutReady 永不 resolve
 * → 新窗口永远停在 #loading 转圈（issue#5 首轮实测现象）。
 * 故 addTab 必须同步注册在 onload 最前面，且 init 必须容错 + 延迟补渲染。
 */
const src = fs.readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
const onloadAt = src.indexOf("async onload(): Promise<void>");
assert.ok(onloadAt > 0, "应能定位 onload");
const afterOnload = src.slice(onloadAt);
const addTabAt = afterOnload.indexOf("this.addTab({");
const firstAwaitAt = afterOnload.search(/\bawait\s+[A-Za-z_$]/);
assert.ok(addTabAt > 0 && firstAwaitAt > 0, "应能定位 addTab 与首个 await 语句");
assert.ok(addTabAt < firstAwaitAt,
  "addTab 必须在 onload 第一个 await 之前同步注册（否则独立窗口布局恢复时 models 未注册 → 白屏转圈）");
assert.ok(/(self\.)?ctxReady\.then|\.readyPromise\.then/.test(src) && /mountTabPanel\(/.test(src),
  "init 必须在上下文未就绪时等渲染就绪信号（ctxReady）后补渲染");
const initBody = afterOnload.slice(addTabAt, firstAwaitAt);
assert.ok(/try\s*\{/.test(initBody) && /catch\s*\(/.test(initBody),
  "页签 init 必须 try/catch，绝不能抛错阻断思源 layoutReady");
// 回归锁：独立窗口页签在窗口间迁移时元素会短暂 disconnected，绝不能用 isConnected 门控挂载，
// 否则 mountTabPanel 被永久跳过 → 整窗空白（第五轮换不同 tab id 后出现的空白回归）。
assert.ok(!/if\s*\(live\s*&&\s*live\.isConnected\)\s*self\.mountTabPanel/.test(src),
  "页签 init 不得用 isConnected 门控 mountTabPanel（迁移瞬间断开会永久跳过挂载 → 空白）");
assert.ok(/self\.mountTabPanel\(el\)/.test(src),
  "页签 init 必须直接挂载到实时 this.element（断开时渲染内容待连上即显）");

/* ---------- 6. 多窗口数据变更不得卸载插件 + 独立窗口可写回（第二轮/第三轮实机） ----------
 * 思源 `shouldReloadOnDataChange = p.onDataChanged === Plugin.prototype.onDataChanged`；
 * 未覆写时数据变更走 teardown/reload → onunload → closePanelTabs → 独立窗口唯一
 * 页签被关 → 窗口被思源自动关掉（第二轮实测）。覆写后只走本钩子、不卸载。
 *
 * 第三轮修正：独立窗口必须能正常落盘（勾待办 / 改设置写回），否则唤出独立窗口无意义；
 * 但覆写 onDataChanged 后思源不再重载数据，故本钩子必须主动 store.load() + refreshPanels()，
 * 否则对端内存是旧值、下次写盘会覆盖对方改动（落盘了又丢）。load 只读取不写盘，不循环。
 * 独立窗口不启动自动同步 / 提醒等定时写盘任务（避免重复调度），但用户手动交互仍落盘。
 */
assert.ok(Object.prototype.hasOwnProperty.call(PluginClass.prototype, "onDataChanged"),
  "必须覆写 onDataChanged，否则思源会因数据变更卸载/重载整个插件");
const odIdx = src.indexOf("onDataChanged():");
assert.ok(odIdx > 0, "应能定位 onDataChanged 覆写");
assert.ok(/void\s+this\.reloadFromDisk\(\)/.test(src.slice(odIdx)),
  "onDataChanged 必须汇入 reloadFromDisk（兜底路径；真正可靠的跨窗口同步由 setupCrossWindowSync 补齐）");
assert.ok(!/saveData:\s*\(d\)\s*=>\s*this\.isSecondaryWindow\s*\?\s*Promise\.resolve\(\)/.test(src),
  "独立窗口必须正常落盘（saveData 不得 no-op），否则唤出独立窗口无意义");
assert.ok(/if\s*\(!this\.isSecondaryWindow\)\s*\{[^}]*this\.closePanelTabs\(\)/.test(src),
  "onunload 在独立窗口里不得关闭唯一页签（否则窗口被思源自动关掉）");
assert.ok(/if\s*\(!this\.isSecondaryWindow\)\s*\{[\s\S]*?startAutoSync/.test(src),
  "独立窗口不得启动自动同步等定时写盘任务（避免重复调度，手动交互仍落盘）");

/* ---------- 7. 跨窗口实时同步（第四轮实机：独立窗口改动主窗口看不到，必须点同步） ---------- */
// 思源内置 dataChange 广播在「另一 BrowserWindow 写入」场景不可靠，故显式双通道通知：
// BroadcastChannel + localStorage storage 事件，任一窗口落盘即通知对端 reloadFromDisk。
assert.ok(/setupCrossWindowSync/.test(src), "必须建立跨窗口通知");
assert.ok(/window\.BroadcastChannel\(["']siyuan-caldav-sync-data["']\)/.test(src),
  "跨窗口通知主通道必须是 window.BroadcastChannel（同源 Electron 窗口可达；用 window. 而非裸全局，避免 Node 测试环境挂起）");
assert.ok(/addEventListener\(["']storage["']/.test(src) && /siyuan-caldav-sync-bump/.test(src),
  "必须兜底监听 localStorage storage 事件（Electron 跨窗口可靠兜底；写入方不收到自己的事件，天然不回环）");
const rdIdx = src.indexOf("private async reloadFromDisk");
assert.ok(rdIdx > 0, "应能定位 reloadFromDisk");
const rdSrc = src.slice(rdIdx);
assert.ok(/await\s+this\.store\.load\(\)/.test(rdSrc) && /this\.refreshPanels\(\)/.test(rdSrc),
  "reloadFromDisk 必须重新 load 最新数据并刷新 UI（否则对端内存旧值会覆盖落盘改动）");
assert.ok(/applyingRemote/.test(rdSrc) && /applyingRemote\s*=\s*false/.test(rdSrc),
  "reloadFromDisk 必须用 applyingRemote 在窗口期内抑制广播，避免回环");
assert.ok(/saveDataAndNotify/.test(src) && /bumpCrossWindow/.test(src),
  "落盘必须经由 saveDataAndNotify → bumpCrossWindow 广播（否则对端收不到通知）");

/* ---------- 8. store.load 清掉排队写盘，防竞态覆盖（第四轮根因之一） ---------- */
const storeSrc = fs.readFileSync(path.join(ROOT, "src", "core", "store.ts"), "utf8");
const loadIdx = storeSrc.indexOf("async load(): Promise<void>");
assert.ok(loadIdx > 0, "应能定位 store.load");
const loadBody = storeSrc.slice(loadIdx, storeSrc.indexOf("const data =", loadIdx));
assert.ok(/clearTimeout\(this\.saveTimer\)/.test(loadBody) && /this\.saveTimer\s*=\s*null/.test(loadBody),
  "store.load 必须清掉排队的 persistSoon，否则会把它之前的旧数据写回、覆盖对端更新");

/* ---------- 9. 独立窗口复用主窗口同 id（避免不同 id 迁移空白）+ 存活感知单例 ---------- */
// ① 独立窗口 openCalendarWindow 必须用与主窗口 openPanelTab **相同**的 tab id（this.name + TAB_TYPE）：
//    思源对同 id 的 custom 页签聚焦已存在实例，openWindow 把它整体「搬」到独立窗口，元素一路
//    isConnected=true → 渲染稳定。第五~七轮反复证明「不同 id 新建实例迁移」会导致页签空白，故锁死同 id。
assert.ok(cbResult.openedTab && cbResult.openedTab.custom && typeof cbResult.openedTab.custom.id === "string",
  "独立窗口 openTab 应带 id");
const secId = cbResult.openedTab.custom.id;
assert.ok(secId.endsWith("caldav-sync-tab"), "独立窗口页签 id 坚持以 caldav-sync-tab 结尾");
assert.ok(!secId.endsWith("-win"),
  "独立窗口不得用独立后缀 id：不同 id 新建实例迁移时页签会空白（第五~七轮反复踩过），必须复用主窗口同 id");
assert.ok(!/SECONDARY_TAB_ID_SUFFIX/.test(src),
  "源码不得再保留不同 id 后缀常量（不同 id 迁移会空白，是第七轮前的回归源）");
const ocIdx = src.indexOf("private async openCalendarWindow");
assert.ok(ocIdx > 0 && /id:\s*this\.name\s*\+\s*TAB_TYPE\s*\n/.test(src.slice(ocIdx)),
  "openCalendarWindow 必须用与主窗口相同的 id（this.name + TAB_TYPE），复用/搬移主窗口页签以保证渲染稳定");

// ② 单例改为「BroadcastChannel ping/pong 存活感知」，而非纯 localStorage 硬锁：
//    窗口崩溃/空白/未按 onunload 退出会残留 localStorage 标记，旧方案会把热键永久锁死。
//    新方案：openCalendarWindow 发 ping，存活的窗口回 pong；探不到就清陈旧标记并重开。
assert.ok(/winAliveCheck/.test(src), "openCalendarWindow 必须做存活探活（winAliveCheck）");
assert.ok(/onCrossWindowMessage/.test(src) && /\{?\s*t:\s*["']ping["']\s*\}?/.test(src) && /\{?\s*t:\s*["']pong["']\s*\}?/.test(src),
  "跨窗口消息必须含 ping/pong 以实现存活探活（独立窗口收到 ping 回 pong）");
assert.ok(/if\s*\(this\.isSecondaryWindow\)\s*\{[^}]*postMessage\(\{\s*t:\s*["']pong["']/.test(src),
  "只有存活的独立窗口才应答 pong（主窗口发的 ping 自己收不到，不会自答）");
assert.ok(/pendingWinAlive/.test(src), "必须有 pendingWinAlive 把 pong 解给探活等待");
assert.ok(/openingWindow/.test(src) && /this\.openingWindow\s*=\s*true/.test(src),
  "必须有 openingWindow 防连按重复开窗口");
assert.ok(/await\s+this\.winAliveCheck\(\)/.test(src),
  "openCalendarWindow 必须 await 探活结果再决定是否开窗口");
// localStorage 标记保留为软提示/启动清理用，不再是硬锁
assert.ok(/secondaryWindowOpen/.test(src) && /SECONDARY_WIN_KEY/.test(src) && /siyuan-caldav-sync-win/.test(src),
  "独立窗口存在态仍以 localStorage 标记（跨窗口共享同源 storage）作软提示/启动清理");
assert.ok(/markSecondaryWindowOpen/.test(src) && /clearSecondaryWindowOpen/.test(src),
  "独立窗口须在 onload 标记、onunload 清除存在态标记；主窗口 onload 亦清陈旧标记");

console.log("window-spike: all assertions passed (命令形态 / 弹窗链路 / 桌面端限定 / i18n 一致 / 独立窗口时序 / 多窗口写回 / 跨窗口实时同步 / load 竞态修复 / 独立窗口复用主窗口同id+存活感知单例)");
