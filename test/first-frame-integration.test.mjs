/**
 * 独立窗口乐观首帧 · 黑盒集成测试（issue #5 · L2）
 *
 * 把 dist/index.js 当成真正的「独立窗口」（window.html 的 URL）跑一遍 onload：
 *  - 预置一份脱敏快照到同源 localStorage；
 *  - 磁盘（siyuan 桩）放一份不同的完整数据；
 *  - 断言首帧吃到的是快照数据（证明 store.load 能接受脱敏骨架）、乐观期零落盘、
 *    随后后台校正回磁盘真实数据、且真实数据就位后落盘锁已解除。
 */
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { loadBuiltPlugin } from "./helpers.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/stage/build/app/window.html"
});
const w = dom.window;
const setGlobal = (k, v) => {
  try { globalThis[k] = v; } catch {
    try { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); } catch {}
  }
};
setGlobal("window", w);
setGlobal("document", w.document);
setGlobal("navigator", w.navigator);
setGlobal("MouseEvent", w.MouseEvent);
setGlobal("Event", w.Event);
setGlobal("HTMLElement", w.HTMLElement);
setGlobal("Element", w.Element);
setGlobal("Node", w.Node);
setGlobal("CustomEvent", w.CustomEvent);
setGlobal("MutationObserver", w.MutationObserver);
setGlobal("localStorage", w.localStorage);

const KEY = "siyuan-caldav-sync-first-frame-v1";
const item = (uid, summary) => ({
  uid, kind: "event", calendarUrl: "http://127.0.0.1:5232/testuser/work/",
  href: uid + ".ics", etag: "etag-" + uid,
  summary, allDay: false,
  start: "20261106T090000", end: "20261106T100000",
  createdAt: "20261101T000000", alarms: [], dirty: false, deleted: false
});
// 关键：快照里账户还在、但 password 键已被剔除；store.load 必须能接受这种骨架，
// 否则真机上会走「回退真实读盘」、乐观提速等于没做。
const settings = () => ({
  accounts: [{ url: "http://127.0.0.1:5232/", user: "u", enabled: true }],
  syncIntervalMin: 0, enableReminders: false,
  showHolidaysCN: false, showLunarCN: false, showTermCN: false,
  lastView: "month", defaultCalendarUrl: "http://127.0.0.1:5232/testuser/work/"
});

// 独立窗口首帧应吃到这份（无凭据、无 raw）
w.localStorage.setItem(KEY, JSON.stringify({
  v: 1, updatedAt: Date.now(),
  data: { items: [item("ff-1", "乐观首帧事件")], settings: settings(), sync: {} }
}));
// 磁盘上则是另一份完整数据（后台校正应换成它）
const diskData = {
  // keyring 在数据文件里是字符串（v3 密钥环密文），造对象会让 adoptKeyring 抛错
  keyring: "",
  settings: settings(),
  items: [item("disk-1", "磁盘完整事件")],
  purgeBackup: [], sync: {}
};

const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
plugin.__stores.set("caldav-sync.json", JSON.parse(JSON.stringify(diskData)));

let writes = 0;
const origSave = plugin.saveData.bind(plugin);
plugin.saveData = (k, d) => { writes++; return origSave(k, d); };

await plugin.onload();
assert.strictEqual(plugin.isSecondaryWindow, true, "测试必须真的跑在独立窗口分支上");

/* 1. 首帧吃到快照：store.load 能接受脱敏骨架，且条目可见 */
const first = plugin.store.getAll();
assert.ok(Array.isArray(first) && first.length > 0, "乐观首帧必须有条目，不能空白");
assert.ok(first.some((it) => it.uid === "ff-1" && it.summary === "乐观首帧事件"),
  "首帧应显示快照里的条目（若显示磁盘条目说明快照被回退了）");
assert.ok(!first.some((it) => it.uid === "disk-1"), "首帧不应等磁盘读完才渲染");
assert.strictEqual(writes, 0, "乐观期必须零落盘：绝不能把无凭据数据写回文件");

/* 2. 后台校正：换回磁盘真实数据 */
await wait(80); // 让 setTimeout(0) 的后台真实读盘校正跑完
const after = plugin.store.getAll();
assert.ok(after.some((it) => it.uid === "disk-1" && it.summary === "磁盘完整事件"),
  "后台真实读盘后应换成磁盘数据（凭据/raw 恢复）");
assert.ok(!after.some((it) => it.uid === "ff-1"), "校正后不应残留乐观条目");

/* 3. 校正成功后落盘锁解除：一次改动能真正写盘 */
plugin.store.markSettingsDirty();
await wait(1200); // 覆盖 store 的落盘去抖
assert.ok(writes > 0, "真实数据就位后必须解除落盘锁，否则独立窗口变只读");
const saved = plugin.__stores.get("caldav-sync.json");
assert.ok(saved && Array.isArray(saved.items) && saved.items.some((it) => it.uid === "disk-1"),
  "写回磁盘的必须是完整真实数据");

console.log("first-frame integration: 独立窗口乐观首帧 / 零落盘 / 后台校正 / 解锁落盘 全部通过");
