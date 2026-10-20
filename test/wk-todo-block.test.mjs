/**
 * 周/日视图待办色块高度回归（2026-10-19 雄哥截图报「行高太小」）
 *
 * 背景：待办在周/日视图的 occ 取到期日（DUE，见 view-common.todoDueOccurrences），
 * 而块高算法里 `end = it.end || occ` 也是 DUE → 算出来恒 0 分钟，只靠 15px 事件地板
 * 兜底 → 11px 高，「标题行 + 上下各 2px padding」都塞不下，文字溢出成一小条。
 * （15px 地板本身是对的：361957f 把 4%≈42px 的旧下限调小，修的是「15 分钟的事件被撑到
 * 57 分钟」；但待办没有时段，被这一并带塌。）
 *
 * 修复：view-week.ts 给待办加 1 小时（44px）保底 → 落进 wk-h-s 档位（标题 + 到期时间
 * 都显示），并贴底收口（top+height ≤ 100%，防 23:30 到期的待办块底越出 24:00 网格线）。
 *
 * 追加（同日第二、三轮，雄哥截图「其他对了，这一处还不对」连报两次）：
 * 第一轮：跨午夜日程 23:00→次日 00:00 被压成 15 分钟 —— 结束时间只取时分秒，
 * 「次日 00:00」解析成 0 分钟，Math.max(startMin+15, 0) 生效。按 endDayDiff
 * （天数差 ×1440）修好，但给重复条目埋下新雷。
 * 第二轮：重复条目的 it.end 属于首个实例（月度例会 base 9-17、occ 10-17），
 * endDayDiff 为负 → 又被 Math.max(startMin+15, 负数) 压成 15 分钟小条（雄哥
 * 第二张截图：人力资源管理系统每月核对任务 13:30→14:30 只剩一小条）。
 * 终版算法：事件按「开始 + 原时长」算结束分钟（原时长平移到当前 occ，跨午夜与
 * 重复条目一锅端，再由 Math.min(…, 1440) 收在 24:00 线）；待办仍走「occ 自己
 * 的时分 + floorMin 保底」。
 *
 * 日视图与周视图共用 renderWeekView（days=1/7），块高是完全相同的一条代码路径；
 * 仍按用户原话把两个视图各验一遍。
 *
 * ⚠️ jsdom 不做布局，量不了真实像素——这里断言行内样式的百分比高度（换算成 px 比较），
 * 真正验几何的活儿交给 test/verify-wk.mjs 这类真浏览器脚本。
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupBrowserDom, loadBuiltPlugin, seedStore, settle } from "./helpers.mjs";

setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
assert.ok(PluginClass, "应导出默认插件类");

const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();
const reg = globalThis.__syRegistrations;

seedStore(plugin);

// 补一条 23:30 到期的待办：1 小时保底会把块底推出 24:00 网格线约 21px，必须贴底收口。
// （必须在打开页签前入 store，页签 init 时一次渲染到位。）
const now = new Date();
const p2 = (n) => (n < 10 ? "0" + n : String(n));
const todayStamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
plugin.store.put({
  uid: "seed-late@test",
  kind: "todo",
  calendarUrl: "http://127.0.0.1:5232/testuser/work/",
  href: "http://127.0.0.1:5232/testuser/work/seed-late.ics",
  etag: '"v99"',
  summary: "深夜到期待办",
  allDay: false,
  start: `${todayStamp}T23:00:00`,
  end: `${todayStamp}T23:30:00`,
  status: "NEEDS-ACTION",
  percent: 0,
  dirty: false,
  deleted: false
});

// 再补一条跨午夜日程：今天 23:00 → 次日 00:00（复刻雄哥 2026-10-19 截图里
// Thunderbird 建的那条）。结束时间的时分秒是 00:00，比开始的 23:00 还「早」，
// 老算法只取时分秒 → Math.max(startMin+15, 0) 把 1 小时的日程压成 15 分钟一小条。
const tmr = new Date(now.getTime() + 86400000);
const nextStamp = `${tmr.getFullYear()}-${p2(tmr.getMonth() + 1)}-${p2(tmr.getDate())}`;
plugin.store.put({
  uid: "seed-midnight@test",
  kind: "event",
  calendarUrl: "http://127.0.0.1:5232/testuser/work/",
  href: "http://127.0.0.1:5232/testuser/work/seed-midnight.ics",
  etag: '"v98"',
  summary: "跨午夜日程",
  allDay: false,
  start: `${todayStamp}T23:00:00`,
  end: `${nextStamp}T00:00:00`,
  dirty: false,
  deleted: false
});

// 再补一条每日重复日程：base 昨天 13:30→14:30，今天 13:30 有实例。
// 重复条目的 it.end 属于首个实例（昨天），比当前 occ（今天）早一天 —— 曾按
// 「endDayDiff 为负 → Math.max(startMin+15, 负数)」把 1 小时的实例压成 15 分钟
// 小条（月度例会同款故障，雄哥第二张截图：人力资源管理系统每月核对任务）。
const ytd = new Date(now.getTime() - 86400000);
const ytdStamp = `${ytd.getFullYear()}-${p2(ytd.getMonth() + 1)}-${p2(ytd.getDate())}`;
plugin.store.put({
  uid: "seed-daily@test",
  kind: "event",
  calendarUrl: "http://127.0.0.1:5232/testuser/work/",
  href: "http://127.0.0.1:5232/testuser/work/seed-daily.ics",
  etag: '"v97"',
  summary: "每日重复日程",
  allDay: false,
  start: `${ytdStamp}T13:30:00`,
  end: `${ytdStamp}T14:30:00`,
  rrule: { freq: "DAILY", interval: 1, count: 60 },
  dirty: false,
  deleted: false
});

// ---- 打开周视图页签 ----
plugin.openPanelTab("week");
const tabEl = document.createElement("div");
document.body.appendChild(tabEl);
const tabCustom = { element: tabEl, data: reg.lastOpenTab.custom.data };
reg.tab[0].init.call(tabCustom, tabCustom);
await settle(2);

const HOUR_H = 44; // 与 view-week.ts 的常量一致（改那边要同步这里）
const pxOfHeight = (pctStr) => (parseFloat(pctStr) / 100) * 24 * HOUR_H;

// 每个视图都要过的三组断言（周/日共用一套逻辑，抽成函数各调一次）
function checkTodoBlocks(root, viewName) {
  assert.ok(root.querySelector(".cal-wk-grid"), `${viewName}：时间网格应渲染`);

  const todoBlocks = Array.from(root.querySelectorAll(".cal-wk-block-todo"));
  // seed 2/3/5（今天到期）+ 深夜待办（今天 23:30）必然在网内；跨日待办看运行星期可能不在
  assert.ok(todoBlocks.length >= 4, `${viewName}：网格里至少 4 个待办块，实际 ${todoBlocks.length}`);
  const LATE = "深夜到期待办";
  for (const blk of todoBlocks) {
    const px = pxOfHeight(blk.style.height);
    if ((blk.textContent || "").includes(LATE)) {
      // 深夜档是「贴底收口」的牺牲品：高度让位于不越出 24:00 网格线，允许掉到
      // wk-h-xs（只显示标题）—— 但不应低于旧的 15px 事件地板。
      assert.ok(px >= 15, `${viewName}：深夜待办块高也不该低于 15px 地板，实际 ${px.toFixed(1)}px`);
      continue;
    }
    assert.ok(
      px >= 34,
      `${viewName}：待办块高至少 34px（wk-h-s 档位，标题+时间都显示），实际 ${px.toFixed(1)}px —— ${blk.textContent?.trim()}`
    );
    assert.ok(
      !blk.classList.contains("wk-h-xs"),
      `${viewName}：待办块不该落进 wk-h-xs（到期时间会被藏）—— ${blk.textContent?.trim()}`
    );
  }

  // 对照组：15px 地板不许泄到日程上——30 分钟的日程仍按真实时长（22px / wk-h-xs）
  const shortEvents = Array.from(root.querySelectorAll(".cal-wk-block:not(.cal-wk-block-todo)")).filter(
    (b) => pxOfHeight(b.style.height) < 34
  );
  assert.ok(shortEvents.length >= 1, `${viewName}：种子里有 30 分钟日程（seed-1）与 0 分钟日程（seed-12），应保持矮块`);
  for (const b of shortEvents) {
    assert.ok(
      b.classList.contains("wk-h-xs"),
      `${viewName}：短日程应保持 wk-h-xs（按真实时长），实际 class="${b.className}"`
    );
  }

  // 贴底收口：23:30 到期的待办，块底不得越出 24:00 网格线
  const late = todoBlocks.find((b) => (b.textContent || "").includes("深夜到期待办"));
  assert.ok(late, `${viewName}：23:30 到期的待办应出现在网格里`);
  const top = parseFloat(late.style.top);
  const h = parseFloat(late.style.height);
  assert.ok(
    top + h <= 100.0001,
    `${viewName}：块底不得越出 24:00 网格线，实际 top ${top}% + height ${h}% = ${(top + h).toFixed(4)}%`
  );

  // 跨午夜日程：23:00 → 次日 00:00 必须画满 1 小时（44px）并收在 24:00 线上，
  // 不许被「结束时间只取时分秒」压成 15 分钟小条（2026-10-19 雄哥截图）。
  const midnight = Array.from(root.querySelectorAll(".cal-wk-block:not(.cal-wk-block-todo)")).find(
    (b) => (b.textContent || "").includes("跨午夜日程")
  );
  assert.ok(midnight, `${viewName}：跨午夜日程应出现在网格里`);
  const mpx = pxOfHeight(midnight.style.height);
  assert.ok(
    Math.abs(mpx - 44) < 0.5,
    `${viewName}：跨午夜日程应画满 1 小时（44px），实际 ${mpx.toFixed(1)}px —— 又是 15 分钟小条？`
  );
  assert.ok(
    !midnight.classList.contains("wk-h-xs"),
    `${viewName}：44px 的跨午夜日程不该落进 wk-h-xs（时间行会被藏），class="${midnight.className}"`
  );
  const mtop = parseFloat(midnight.style.top);
  const mh = parseFloat(midnight.style.height);
  assert.ok(
    mtop + mh <= 100.0001,
    `${viewName}：跨午夜日程块底必须收在 24:00 网格线，实际 ${(mtop + mh).toFixed(4)}%`
  );

  // 每日重复日程：it.end 属于昨天（首个实例），必须按「occ + 原时长」画满 1 小时
  // 并落在 13:30，不许被「endDayDiff 为负」压成 15 分钟小条（雄哥第二张截图）。
  const daily = Array.from(root.querySelectorAll(".cal-wk-block:not(.cal-wk-block-todo)")).find(
    (b) => (b.textContent || "").includes("每日重复日程")
  );
  assert.ok(daily, `${viewName}：每日重复日程应出现在网格里`);
  const dpx = pxOfHeight(daily.style.height);
  assert.ok(
    Math.abs(dpx - 44) < 0.5,
    `${viewName}：每日重复日程应画满 1 小时（44px），实际 ${dpx.toFixed(1)}px —— 又是 15 分钟小条？`
  );
  assert.ok(
    Math.abs(parseFloat(daily.style.top) - (810 / 1440) * 100) < 0.01,
    `${viewName}：每日重复日程应落在 13:30，实际 top ${daily.style.top}%`
  );
}

checkTodoBlocks(tabEl, "周视图");

// ---- 日视图：同一个 renderWeekView（days=1），切 viewMode + refresh 重渲 ----
plugin.mainCtx.viewMode = "day";
plugin.tabPanel?.refresh();
await settle(2);
checkTodoBlocks(tabEl, "日视图");

// ---- 源码防漂移：修复的两条核心逻辑不许被后人「顺手清理」 ----
// （字面量只出现在代码里，注释刻意不写这串，避免误配）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "src", "ui", "view-week.ts"), "utf8");
assert.ok(
  /const floorMin = b\.it\.kind === "todo" \? 60 : 15;/.test(src),
  "待办块必须有 1 小时保底（源码防漂移）：没有它又会缩回 11px 一小条"
);
assert.ok(
  /if \(top \+ height > 100\) height = Math\.max\(100 - top, \(15 \/ 1440\) \* 100\);/.test(src),
  "保底后必须贴底收口（源码防漂移）：否则 23:30 到期的待办块底越出网格线约 21px"
);
assert.ok(
  /endMin = startMin \+ durMin;/.test(src),
  "事件必须按「开始+原时长」算结束分钟（源码防漂移）：直接取 end 的时分/日期，跨午夜和重复条目都会被 Math.max(startMin+15, …) 压成 15 分钟小条"
);

console.log("\n[wk-todo-block] 全部通过");
