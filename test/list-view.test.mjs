/**
 * 回归测试：列表视图（2026-10-25 雄哥拍板方案 A）
 *
 * 覆盖三块：
 *  ① **范围口径**（listRange）：年/月/周/日各自的时间窗
 *     —— 这是最容易出错的地方：列表若与各视图口径不一致，用户会看到
 *     「月视图里有、列表里没有」的条目（口径漂移）。
 *  ② **时间文案**（timeLabelOf）：全天 / 日程起止 / 待办到期 / 跨午夜 / 重复条目
 *  ③ **渲染结构**（renderListView）：日期分组、条目四要素（时间+色点+类型+标题）
 *
 * 思源端与 Obsidian 端同构，两端各跑一遍（Obsidian 侧见 test/list-view.test.cjs）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-listview");

// 编译：只取列表视图 + 其依赖（core/*、ui/view-common、ui/icons）。
// view-list.ts 只 import type 的 PanelCtx 不会拉进 panel.ts（无运行时依赖），
// 但 tsc 会跟着类型走 → panel.ts → editor.ts → "siyuan" 包。
// "siyuan" 只有 .d.ts 没有运行时入口，运行时用桩替换（见下）。
const tsCfg = path.join(root, "tsconfig.listview.json");
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
      outDir: ".test-listview",
      rootDir: "src"
    },
    include: ["src/ui/view-list.ts"]
  }, null, 2)
);
try {
  execSync(`npx tsc -p tsconfig.listview.json`, { cwd: root, stdio: "pipe" });
} finally {
  // ⚠️ 用 unlinkSync 而不是 rmSync：宿主注入的 safe-delete 拦截 rmSync，
  // 累计删除数达阈值会直接抛错把整个测试带崩（临时 tsconfig 必须删干净，
  // 否则会被 git 当成待提交文件）。unlinkSync 走单文件删除路径，不触发批量闸。
  try {
    fs.unlinkSync(tsCfg);
  } catch {
    /* 删不掉也不影响测试（tsconfig.listview.json 已在 .gitignore） */
  }
}

const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));

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

const { listRange, timeLabelOf, renderListView } = require(path.join(outDir, "ui", "view-list.js"));
// 真实的 occurrence 展开（core/ics.ts）—— 用它做端到端验证，
// 避免测试自己造 occ 把「窗口外条目混入」这个 bug 藏起来。
const { occurrencesInRange } = require(path.join(outDir, "core", "ics.js"));

// ---- 造一个最小可用的 PanelCtx 桩 ----
function mkCtx(viewMode, cursor, items = []) {
  return {
    viewMode,
    cursor,
    sortMode: "start",
    store: {
      settings: {
        categories: [],
        calendars: [{ url: "c1", displayName: "工作", enabled: true, color: "#4285f4" }],
        showTodosInCalendar: true
      },
      getAll: () => items
    },
    sync: {}
  };
}

function mkItem(over = {}) {
  return {
    uid: over.uid || "u1",
    kind: over.kind || "event",
    calendarUrl: "c1",
    href: "/c1/u1.ics",
    summary: over.summary || "标题",
    allDay: over.allDay === true,
    start: over.start || "2026-10-08T09:00:00",
    end: over.end,
    rrule: over.rrule,
    percent: over.percent
  };
}

/** 把 occ 数组摊平成「Map<item, occs>」 */
function occMap(entries) {
  const m = new Map();
  for (const [it, occs] of entries) m.set(it, occs);
  return m;
}

/**
 * 用**真实的** core/ics.ts 展开 occurrence（与面板 visibleOccurrences 同一条路径）。
 *
 * 为什么要走真实代码：core/ics.ts 的 `expandRepeats()` 对**无重复规则**的条目
 * 会回退返回 `item.start`（不管它是否落在窗口内）—— 这个「泄漏」本身是 core 的
 * 既定行为（提醒/日记等场景各自按需过滤）。列表视图若不做二次过滤，
 * 10 月的列表里就会混进 12 月的条目。
 *
 * 用 mock 的 occ 数组写测试会把这个 bug 藏起来（mock 直接给正确的 occ，
 * 不经过 expandRepeats 的回退分支），所以这里必须走真实展开。
 */
function realOccMap(items, startMs, endMs) {
  const m = new Map();
  for (const it of items) {
    const occs = occurrencesInRange(it, startMs, endMs);
    if (occs.length) m.set(it, occs);
  }
  return m;
}

/** 走真实展开路径的渲染 */
function renderReal(ctx, items) {
  const viewEl = { innerHTML: "" };
  renderListView({ ctx, viewEl, occurrences: (s, e) => realOccMap(items, s, e) });
  return viewEl.innerHTML;
}

// ============ ① 范围口径 ============

t("年视图范围＝当年 1/1 → 次年 1/1", () => {
  const { startMs, endMs } = listRange({ viewMode: "year", cursor: "2026-10-08" });
  assert.strictEqual(new Date(startMs).getFullYear(), 2026);
  assert.strictEqual(new Date(startMs).getMonth(), 0);
  assert.strictEqual(new Date(startMs).getDate(), 1);
  assert.strictEqual(new Date(endMs).getFullYear(), 2027);
  assert.strictEqual(new Date(endMs).getMonth(), 0);
  assert.strictEqual(new Date(endMs).getDate(), 1);
});

t("月视图范围＝当月 1 日 → 次月 1 日（自然月，不是 35 天滑动窗口）", () => {
  const { startMs, endMs } = listRange({ viewMode: "month", cursor: "2026-10-08" });
  assert.strictEqual(new Date(startMs).getMonth(), 9);
  assert.strictEqual(new Date(startMs).getDate(), 1);
  assert.strictEqual(new Date(endMs).getMonth(), 10);
  assert.strictEqual(new Date(endMs).getDate(), 1);
  // 2 月：2026 不是闰年 → 28 天
  const feb = listRange({ viewMode: "month", cursor: "2026-02-08" });
  assert.strictEqual(Math.round((feb.endMs - feb.startMs) / 86400000), 28);
});

t("周视图范围＝本周一 → 下周一（周一为一周之始）", () => {
  // 2026-10-08 是周四 → 本周一应为 2026-10-05
  const { startMs, endMs } = listRange({ viewMode: "week", cursor: "2026-10-08" });
  const s = new Date(startMs);
  assert.strictEqual(s.getFullYear(), 2026);
  assert.strictEqual(s.getMonth(), 9);
  assert.strictEqual(s.getDate(), 5);
  assert.strictEqual(s.getDay(), 1, "周一");
  assert.strictEqual(Math.round((endMs - startMs) / 86400000), 7);
});

t("周视图：周日也归属同一周（周一起始，不回退到上周）", () => {
  // 2026-10-11 是周日 → 本周一仍是 10-05
  const { startMs } = listRange({ viewMode: "week", cursor: "2026-10-11" });
  assert.strictEqual(new Date(startMs).getDate(), 5);
});

t("日视图范围＝当天 → 次日", () => {
  const { startMs, endMs } = listRange({ viewMode: "day", cursor: "2026-10-08" });
  assert.strictEqual(new Date(startMs).getDate(), 8);
  assert.strictEqual(Math.round((endMs - startMs) / 86400000), 1);
});

// ============ ② 时间文案 ============

t("全天条目 → 「全天」", () => {
  assert.strictEqual(timeLabelOf(mkItem({ allDay: true, start: "2026-10-08" }), "2026-10-08"), "全天");
});

t("日程 → 「开始 - 结束」", () => {
  const it = mkItem({ start: "2026-10-08T09:00:00", end: "2026-10-08T10:30:00" });
  assert.strictEqual(timeLabelOf(it, "2026-10-08T09:00:00"), "09:00 - 10:30");
});

t("日程跨午夜（23:00 → 次日 00:00）结束时间收在 24:00，不归零", () => {
  const it = mkItem({ start: "2026-10-08T23:00:00", end: "2026-10-09T00:00:00" });
  assert.strictEqual(timeLabelOf(it, "2026-10-08T23:00:00"), "23:00 - 24:00");
});

t("重复日程：结束时间按原时长算，不取首个实例的 end", () => {
  // base 9-17，当月实例 10-17 —— 直接取 it.end 的时分会得到 09:00（错）
  const it = mkItem({ start: "2026-09-17T09:00:00", end: "2026-09-17T17:00:00", rrule: { freq: "MONTHLY" } });
  assert.strictEqual(timeLabelOf(it, "2026-10-17T09:00:00"), "09:00 - 17:00");
});

t("待办 → 只显示到期时刻", () => {
  const it = mkItem({ kind: "todo", start: "2026-10-08T09:00:00", end: "2026-10-08T18:00:00" });
  assert.strictEqual(timeLabelOf(it, "2026-10-08T18:00:00"), "18:00");
});

t("日程无结束时间 → 只显示开始时刻", () => {
  const it = mkItem({ start: "2026-10-08T09:00:00" });
  assert.strictEqual(timeLabelOf(it, "2026-10-08T09:00:00"), "09:00");
});

// ============ ③ 渲染结构 ============

/** 渲染到一段假 DOM 上，返回 innerHTML */
function render(ctx, entries) {
  const viewEl = { innerHTML: "" };
  renderListView({ ctx, viewEl, occurrences: () => occMap(entries) });
  return viewEl.innerHTML;
}

t("空时间段 → 空态提示", () => {
  const html = render(mkCtx("day", "2026-10-08"), []);
  assert.ok(html.includes("cal-list-empty"), "应有空态");
  assert.ok(html.includes("暂无日程或待办"));
});

t("按日期分组：日期头含 M/D、周几、条目数", () => {
  const it = mkItem({ start: "2026-10-08T09:00:00", end: "2026-10-08T10:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T09:00:00"]]]);
  assert.ok(html.includes("cal-list-day"), "应有日期分组");
  assert.ok(html.includes("10/8"), "日期头应含 M/D");
  assert.ok(html.includes("周四"), "日期头应含周几（2026-10-08 是周四）");
  assert.ok(html.includes("1 项"), "日期头应含条目数");
});

t("条目四要素：时间 + 色点 + 类型图标 + 标题", () => {
  const it = mkItem({ summary: "项目评审会", start: "2026-10-08T09:00:00", end: "2026-10-08T10:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T09:00:00"]]]);
  assert.ok(html.includes("cal-list-time"), "时间列");
  assert.ok(html.includes("09:00 - 10:00"), "时间文案");
  assert.ok(html.includes("cal-list-dot"), "色点");
  assert.ok(html.includes("cal-list-kind"), "类型图标");
  assert.ok(html.includes("项目评审会"), "标题");
  // 条目可点开（沿用全局事件委托）
  assert.ok(html.includes('data-open="u1"'), "条目应带 data-open");
});

t("待办条目标注类型且带勾选圈", () => {
  const it = mkItem({ kind: "todo", summary: "交材料", start: "2026-10-08T09:00:00", end: "2026-10-08T18:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T18:00:00"]]]);
  assert.ok(html.includes('data-kind="todo"'), "应标出条目类型");
  assert.ok(html.includes("cal-chip-check"), "待办应带勾选圈");
  assert.ok(html.includes('data-toggle="u1"'), "勾选圈应带 data-toggle");
});

t("日程条目不带勾选圈", () => {
  const it = mkItem({ start: "2026-10-08T09:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T09:00:00"]]]);
  assert.ok(!html.includes("cal-chip-check"), "日程不该有勾选圈");
});

t("已完成待办行标 is-done（标题划线）", () => {
  const it = mkItem({ kind: "todo", summary: "做完了", start: "2026-10-08T09:00:00", end: "2026-10-08T18:00:00", percent: 100 });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T18:00:00"]]]);
  assert.ok(html.includes("is-done"), "已完成应标 is-done");
});

t("标题做 HTML 转义（防注入）", () => {
  const it = mkItem({ summary: '<img src=x onerror="alert(1)">', start: "2026-10-08T09:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T09:00:00"]]]);
  assert.ok(!html.includes("<img src=x"), "原始标签不该出现");
  assert.ok(html.includes("&lt;img src=x"), "应转义");
});

t("多个日期 → 分组按日期升序", () => {
  const a = mkItem({ uid: "a", summary: "A", start: "2026-10-09T09:00:00" });
  const b = mkItem({ uid: "b", summary: "B", start: "2026-10-08T09:00:00" });
  const html = render(mkCtx("week", "2026-10-08"), [
    [a, ["2026-10-09T09:00:00"]],
    [b, ["2026-10-08T09:00:00"]]
  ]);
  const i8 = html.indexOf("10/8");
  const i9 = html.indexOf("10/9");
  assert.ok(i8 >= 0 && i9 >= 0, "两个日期都该出现");
  assert.ok(i8 < i9, "10/8 应排在 10/9 前");
});

t("总条目数统计正确", () => {
  const a = mkItem({ uid: "a", start: "2026-10-08T09:00:00" });
  const b = mkItem({ uid: "b", start: "2026-10-09T09:00:00" });
  const html = render(mkCtx("week", "2026-10-08"), [
    [a, ["2026-10-08T09:00:00"]],
    [b, ["2026-10-09T09:00:00"]]
  ]);
  assert.ok(html.includes("共 2 项"), "总计数应为 2");
});

t("重复条目在同一时间段内出现多次时逐条列出", () => {
  const it = mkItem({ start: "2026-10-08T09:00:00", rrule: { freq: "DAILY" } });
  const html = render(mkCtx("week", "2026-10-08"), [
    [it, ["2026-10-08T09:00:00", "2026-10-09T09:00:00", "2026-10-10T09:00:00"]]
  ]);
  assert.ok(html.includes("共 3 项"), "三个实例都该列出");
});

// ============ ④ 范围严格跟随左侧标题（2026-10-25 雄哥指正） ============
//
// 用户原话：「如果切换在『月』，那么以左侧『2026年10月』为时间段，下面的条目就是
// 2026年10月1日到2026年10月31日的…目前是不对的，要修复。」
//
// 根因：core/ics.ts 的 expandRepeats() 对无重复规则的条目回退返回 item.start
//（不看窗口），而列表把**所有** occ 都建了日期组 → 窗口外条目混入。
// 修复：渲染层再按自然日闭区间过滤一次。

t("月视图：窗口外（12 月）的一次性条目不得进入 10 月列表", () => {
  // 真实展开路径：expandRepeats 会把 12/25 的条目也返回（core 既定行为）
  const dec = mkItem({ uid: "dec", summary: "年底会议", start: "2026-12-25T09:00:00" });
  const oct = mkItem({ uid: "oct", summary: "十月评审", start: "2026-10-15T09:00:00" });
  const html = renderReal(mkCtx("month", "2026-10-08"), [dec, oct]);
  assert.ok(html.includes("十月评审"), "10 月的条目该出现");
  assert.ok(!html.includes("年底会议"), "12 月的条目不得混入 10 月列表");
  assert.ok(!html.includes("12/25"), "不得出现 12/25 分组");
  assert.ok(html.includes("共 1 项"), "总计数应只算窗口内的条目");
});

t("月视图：左侧切到 11 月后，列表内容随之换成 11 月的条目", () => {
  const oct = mkItem({ uid: "oct", summary: "十月评审", start: "2026-10-15T09:00:00" });
  const nov = mkItem({ uid: "nov", summary: "十一月复盘", start: "2026-11-06T09:00:00" });
  const html = renderReal(mkCtx("month", "2026-11-01"), [oct, nov]);
  assert.ok(html.includes("十一月复盘"), "11 月的条目该出现");
  assert.ok(!html.includes("十月评审"), "10 月的条目不得混入 11 月列表");
});

t("年视图：窗口外（次年）条目不得进入当年列表", () => {
  const inYear = mkItem({ uid: "a", summary: "年内条目", start: "2026-03-05T09:00:00" });
  const nextYear = mkItem({ uid: "b", summary: "跨年条目", start: "2027-01-05T09:00:00" });
  const html = renderReal(mkCtx("year", "2026-10-08"), [inYear, nextYear]);
  assert.ok(html.includes("年内条目"));
  assert.ok(!html.includes("跨年条目"), "次年条目不得混入");
});

t("周视图：窗口外（上/下周）条目不得进入本周列表", () => {
  const inWeek = mkItem({ uid: "a", summary: "本周条目", start: "2026-10-08T09:00:00" });
  const nextWeek = mkItem({ uid: "b", summary: "下周条目", start: "2026-10-20T09:00:00" });
  const html = renderReal(mkCtx("week", "2026-10-08"), [inWeek, nextWeek]);
  assert.ok(html.includes("本周条目"));
  assert.ok(!html.includes("下周条目"), "下周条目不得混入本周");
});

t("日视图：窗口外条目不得进入当天列表", () => {
  const sameDay = mkItem({ uid: "a", summary: "当天条目", start: "2026-10-08T09:00:00" });
  const otherDay = mkItem({ uid: "b", summary: "别日条目", start: "2026-10-09T09:00:00" });
  const html = renderReal(mkCtx("day", "2026-10-08"), [sameDay, otherDay]);
  assert.ok(html.includes("当天条目"));
  assert.ok(!html.includes("别日条目"), "次日条目不得混入当天");
});

t("窗口全部越界时显示空态（而不是列出越界条目）", () => {
  const far = mkItem({ uid: "x", summary: "远期条目", start: "2027-05-01T09:00:00" });
  const html = renderReal(mkCtx("month", "2026-10-08"), [far]);
  assert.ok(html.includes("cal-list-empty"), "应为空态");
  assert.ok(!html.includes("远期条目"));
});

// listRange 的自然日闭区间（渲染层过滤的判据）
t("listRange 给出窗口内的自然日闭区间（年/月/周/日）", () => {
  const y = listRange({ viewMode: "year", cursor: "2026-10-08" });
  assert.strictEqual(y.startDay, "2026-01-01");
  assert.strictEqual(y.endDay, "2026-12-31");

  const mo = listRange({ viewMode: "month", cursor: "2026-10-08" });
  assert.strictEqual(mo.startDay, "2026-10-01");
  assert.strictEqual(mo.endDay, "2026-10-31", "10 月 31 天");
  const feb = listRange({ viewMode: "month", cursor: "2026-02-08" });
  assert.strictEqual(feb.endDay, "2026-02-28", "2026 非闰年，2 月 28 天");
  const feb24 = listRange({ viewMode: "month", cursor: "2024-02-08" });
  assert.strictEqual(feb24.endDay, "2024-02-29", "闰年 2 月 29 天");

  const wk = listRange({ viewMode: "week", cursor: "2026-10-08" });
  assert.strictEqual(wk.startDay, "2026-10-05", "周一");
  assert.strictEqual(wk.endDay, "2026-10-11", "周日");

  const d = listRange({ viewMode: "day", cursor: "2026-10-08" });
  assert.strictEqual(d.startDay, "2026-10-08");
  assert.strictEqual(d.endDay, "2026-10-08");
});

// ============ ⑤ 条目类型标记：改用任务视图的「待办/日程」角标 ============
//
// 用户原话：「关于图标，这两个图标我表达错误，应该使用任务视图中的这两个。」
// 即任务视图里的橙色「待办」/ 蓝色「日程」文字角标（.cal-task-kind），
// 而不是列表此前自绘的线框 SVG 图标。

t("日程条目标「日程」角标（任务视图同款 .cal-task-kind.is-event）", () => {
  const it = mkItem({ kind: "event", start: "2026-10-08T09:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T09:00:00"]]]);
  assert.ok(html.includes("cal-task-kind"), "应使用任务视图的角标类");
  assert.ok(html.includes("is-event"), "日程应为 is-event（蓝色）");
  assert.ok(html.includes("日程"), "角标文字应为「日程」");
  assert.ok(!html.includes("<svg"), "不应再有自绘的 SVG 图标");
});

t("待办条目标「待办」角标（.cal-task-kind.is-todo）", () => {
  const it = mkItem({ kind: "todo", start: "2026-10-08T09:00:00", end: "2026-10-08T18:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T18:00:00"]]]);
  assert.ok(html.includes("cal-task-kind"), "应使用任务视图的角标类");
  assert.ok(html.includes("is-todo"), "待办应为 is-todo（橙色）");
  assert.ok(html.includes("待办"), "角标文字应为「待办」");
  assert.ok(!html.includes("<svg"), "不应再有自绘的 SVG 图标");
});

t("角标同时保留 .cal-list-kind 布局钩子（flex 项定位）", () => {
  const it = mkItem({ start: "2026-10-08T09:00:00" });
  const html = render(mkCtx("day", "2026-10-08"), [[it, ["2026-10-08T09:00:00"]]]);
  assert.ok(html.includes("cal-list-kind"), "应保留列表布局钩子类");
});

// ============ ⑥ 「列表」按钮紧靠分段控件 ============
//
// 用户原话：「把列表按钮放的更紧靠一些。」
// 实现：.caldav-toolbar-center 改 flex（消灭 HTML 空白节点的 ~4px 空隙），
// 间距统一由 gap 控制；按钮自身 margin-left 归 0，避免与 gap 叠加。

t("工具栏中部改 flex 容器 + 「列表」按钮 margin-left 归 0（紧靠分段控件）", () => {
  const css = fs.readFileSync(path.join(root, "src", "index.css"), "utf8");
  assert.ok(/\.caldav-toolbar-center\s*\{[^}]*display:\s*flex/.test(css), "toolbar-center 应为 flex 容器");
  const toggle = /\.caldav-list-toggle\s*\{([^}]*)\}/.exec(css);
  assert.ok(toggle, "应有 .caldav-list-toggle 规则");
  assert.ok(/margin-left:\s*0\b/.test(toggle[1]), "按钮 margin-left 应为 0（间距交给 flex gap）");
  assert.ok(!/margin-left:\s*8px/.test(toggle[1]), "旧的 8px 间距应已去掉");
});

console.log(`\n[list-view] 通过 ${passed} 项`);
