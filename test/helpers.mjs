/** 测试公共工具：jsdom 环境 + 加载 dist 产物（带 siyuan 桩） */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

export function setupBrowserDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const w = dom.window;
  globalThis.window = w;
  globalThis.document = w.document;
  try { globalThis.navigator = w.navigator; } catch {}
  globalThis.MouseEvent = w.MouseEvent;
  globalThis.Event = w.Event;
  globalThis.HTMLElement = w.HTMLElement;
  globalThis.Element = w.Element;
  globalThis.Node = w.Node;
  globalThis.CustomEvent = w.CustomEvent;
  // jsdom 有 MutationObserver，但插件代码跑在 Node 上下文里，得显式透出来
  globalThis.MutationObserver = w.MutationObserver;
}

/**
 * 等异步收尾落地。
 * 思源的 Dialog.destroy() 是「先摘 b3-dialog--open 淡出，一个 timeout 之后才
 * 移除元素并回调 destroyCallback」（桩里同样如此，见 siyuan-stub.cjs）。
 * 所以断言「弹层已消失」「清理回调已跑」之前必须等一等。
 */
export async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 20));
}

/**
 * 取一个「系统真的允许监听」的本地端口，交给 CDP（无头浏览器调试端口）用。
 *
 * **不要把端口写死。** Windows 会把成段的端口保留给 Hyper-V / WSL / Docker 之类
 * （`netsh int ipv4 show excludedportrange protocol=tcp` 能查到；本机一度整段保留了
 * 8984-9483，正好吃掉所有测试用的 93xx），落进保留段监听只会得到 EACCES ——
 * 表现是「应能连上无头浏览器的调试端口」断言失败，且**所有** CDP 脚本一起挂。
 * 让系统分配就没事：内核挑临时端口时会自己避开保留段。
 */
export async function freeDebugPort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function loadBuiltPlugin() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dist = path.join(root, "dist", "index.js");
  if (!fs.existsSync(dist)) throw new Error("dist/index.js 不存在，请先构建");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sy-loader-"));
  fs.mkdirSync(path.join(tmp, "node_modules", "siyuan"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "node_modules", "siyuan", "package.json"), JSON.stringify({ name: "siyuan", main: "index.js" }));
  fs.copyFileSync(path.join(root, "test", "stubs", "siyuan-stub.cjs"), path.join(tmp, "node_modules", "siyuan", "index.js"));
  fs.copyFileSync(dist, path.join(tmp, "index.js"));

  const require = createRequire(path.join(tmp, "index.js"));
  const Mod = require(path.join(tmp, "index.js"));
  return Mod;
}

/** 组装测试数据 */
export function seedStore(plugin) {
  const store = plugin.store;
  store.settings = {
    serverUrl: "http://127.0.0.1:5232/",
    username: "testuser",
    password: "testpass",
    calendarPath: "",
    channel: "direct",
    syncIntervalMin: 0,
    conflict: "server",
    pastDays: 90,
    futureDays: 370,
    defaultCalendarUrl: "http://127.0.0.1:5232/testuser/work/",
    calendars: [
      { url: "http://127.0.0.1:5232/testuser/work/", displayName: "工作", color: "#3b82f6", enabled: true, supportsEvent: true, supportsTodo: true },
      { url: "http://127.0.0.1:5232/testuser/personal/", displayName: "个人", color: "#10b981", enabled: true, supportsEvent: true, supportsTodo: true }
    ]
  };
  const today = new Date();
  const p = (n) => (n < 10 ? "0" + n : String(n));
  const todayStamp = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  const tmr = new Date(today.getTime() + 86400000);
  const tomorrowStamp = `${tmr.getFullYear()}-${p(tmr.getMonth() + 1)}-${p(tmr.getDate())}`;
  const mk = (i, over) => ({
    uid: `seed-${i}@test`,
    kind: "event",
    calendarUrl: "http://127.0.0.1:5232/testuser/work/",
    href: `http://127.0.0.1:5232/testuser/work/seed-${i}.ics`,
    etag: `"v${i}"`,
    summary: `测试条目 ${i}`,
    allDay: false,
    start: `${todayStamp}T0${i}:00:00`,
    end: `${todayStamp}T0${i}:30:00`,
    dirty: false,
    deleted: false,
    ...over
  });
  store.put(mk(1, {}));
  store.put(mk(2, { kind: "todo", status: "NEEDS-ACTION", percent: 0, priority: 3, end: `${todayStamp}T18:00:00` }));
  store.put(mk(3, { kind: "todo", end: `${todayStamp}T09:00:00`, summary: "逾期任务" }));
  store.put(mk(4, { allDay: true, start: todayStamp, end: todayStamp }));
  store.put(mk(5, { kind: "todo", percent: 100, status: "COMPLETED", end: `${todayStamp}T12:00:00` }));
  store.put(mk(6, { summary: "无截止任务", kind: "todo", start: "", end: undefined }));
  store.put(mk(7, { start: `${todayStamp}T14:00:00`, end: `${todayStamp}T15:00:00`, location: "线上会议" }));
  // 只有开始时间、无到期日：待办一律以到期日归属，故应算「无日期」
  store.put(mk(8, { summary: "仅开始时间任务", kind: "todo", start: `${todayStamp}T07:00:00`, end: undefined }));
  // 开始日与到期日跨天：日历/统计一律按到期日（明天）归属
  store.put(
    mk(9, { summary: "跨日待办", kind: "todo", start: `${todayStamp}T09:00:00`, end: `${tomorrowStamp}T18:00:00` })
  );

  const dayBack = (n) => {
    const d = new Date(today.getTime() - n * 86400000);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  // 正向偏移（含未来）：用于构造「确定落在本周」的样本，避免测试对运行星期产生依赖
  const shift = (n) => {
    const d = new Date(today.getTime() + n * 86400000);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const dow = (today.getDay() + 6) % 7; // 周一=0，周三=2…
  const monday = shift(-dow);
  // 本周内确定的一天（周一~周日任意天运行都落在 [周一,周日]）。
  // ⚠️ 还必须**永不为今天**：它是「当日日记不该收它」的干扰样本，
  //    今天恰好是周四时 midWeek 会等于今天，「本周待办」就真的属于当日，
  //    diary.test.mjs 的干扰项断言会误报（2026-10-15 周四实测踩到，
  //    表现为「本周待办不属于今天，不应写入日记」）。
  let midWeek = shift(-dow + 3); // 周四
  if (midWeek === todayStamp) midWeek = shift(-dow + 4); // 今天就是周四 → 顺延到周五（仍在本周内）
  // 明确已经结束的过去事件：用于验证「当前时间以前的日程不显示」
  store.put(mk(10, { summary: "昨天的会议", start: `${dayBack(1)}T09:00:00`, end: `${dayBack(1)}T10:00:00` }));
  // 日期在窗口内、但当天早已结束的日程：这才是「按当前时刻判断」与「只按日期判断」的分水岭
  // （零点整结束，除极端边界外恒为“已结束”）
  store.put(mk(12, { summary: "已结束的早会", start: `${todayStamp}T00:00:00`, end: `${todayStamp}T00:00:00` }));
  // 逾期未完成的待办（前天到期、优先级最高）：过期也必须留在列表里，并标红「逾期 2 天」
  store.put(
    mk(11, {
      summary: "逾期待办",
      kind: "todo",
      percent: 0,
      status: "NEEDS-ACTION",
      priority: 1,
      start: `${dayBack(2)}T09:00:00`,
      end: `${dayBack(2)}T18:00:00`
    })
  );
  // 本周内确定到期（midWeek）的待办：用于验证「本周」范围把周内到期待办收进来。
  // 用「本周一 + 3 天」而非「前天」，避免周一/周二运行时样本越出本周导致测试误报。
  store.put(
    mk(13, {
      summary: "本周待办",
      kind: "todo",
      percent: 0,
      status: "NEEDS-ACTION",
      priority: 3,
      start: `${midWeek}T09:00:00`,
      end: `${midWeek}T18:00:00`
    })
  );
}
