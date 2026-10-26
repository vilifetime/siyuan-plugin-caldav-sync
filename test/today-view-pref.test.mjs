/**
 * 「今天」单元格视觉 + 视图记忆单测（2026-10-20 雄哥两条需求，与 Obsidian 侧
 * test/today-view-pref.cjs 同构）
 *
 * 需求 1：月/周视图中「今天」所在单元格只要背景色，不要框线。
 *   原实现：月视图 .cal-month-cell.is-today 有 inset 2px 描边；周视图今日
 *   日期数字是实心圆点。现实现：月视图只留 background；周视图表头加同款
 *   淡 accent 底、数字改文字色强调。年视图本来就是纯底色（反向断言钉住）。
 *
 * 需求 2：记住日历视图当前选用的视图（年/月/周/日），从任务视图切回日历
 *   视图时不默认到月视图。
 *   原实现：panel.ts toggle-view 硬编码 `? "month" : "task"`，且 index.ts 的
 *   lastView 只有一个键（含 task）——进 task 时会把日历视图记录覆盖成 task，
 *   切回来读到的还是 task，死循环。现实现：view-pref.ts 双键分工，
 *   saveCalendarView 只记日历视图，toggle-view 用 loadCalendarView() ?? DEFAULT_VIEW。
 *
 * 运行前先用 tsc 把 src/ui/view-pref.ts 编译到 .test-viewpref。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import { rmrf } from "./fsx.mjs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
// 统一 normalize 行尾：本仓库是 CRLF，断言禁写死 \n
const readLF = (rel) => read(rel).replace(/\r\n/g, "\n");

const outDir = path.join(root, ".test-viewpref");
rmrf(outDir);
fs.mkdirSync(outDir, { recursive: true });
// view-pref.ts 的 import 用了 @/ 别名，命令行 tsc 不认 --paths → 落临时 tsconfig
fs.writeFileSync(
  path.join(outDir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "commonjs", target: "es2020", moduleResolution: "node",
      esModuleInterop: true, skipLibCheck: true, strict: false,
      baseUrl: "..", paths: { "@/*": ["src/*"] }, outDir: ".",
    },
    files: ["../src/ui/view-pref.ts"],
  })
);
execSync("npx tsc -p .test-viewpref/tsconfig.json", { cwd: root, stdio: "inherit" });

const require = createRequire(import.meta.url);
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
// view-pref.ts 的 ViewMode 是 type-only import（编译后消失），直接 require 安全。
// ⚠️ 产物在 ui/ 子目录下：type import 会把 panel.ts 拉进编译，rootDir 推断成 src/，
// 于是 .test-viewpref/ui/view-pref.js（不是 .test-viewpref/view-pref.js）。
const vp = require(path.join(outDir, "ui", "view-pref.js"));

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

/** 装一个内存 localStorage 桩，返回句柄以便检查落键情况。
 *  思源版 view-pref 走 globalThis.localStorage（沿用它原 index.ts 的写法），
 *   Obsidian 版走 window.localStorage —— 桩同时挂两处、指向同一对象，两端通用。 */
function stubStorage() {
  const store = new Map();
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.localStorage = ls;
  globalThis.window = { localStorage: ls };
  return store;
}

// ---------- 需求 1：今天单元格无框线 ----------
console.log("[today-view-pref] 今天单元格 CSS");

t("月视图 is-today 无框线（box-shadow/outline/border 全无）", () => {
  const css = readLF("src/index.css");
  const m = /\.cal-month-cell\.is-today\s*\{([^}]*)\}/.exec(css);
  assert.ok(m, "找不到 .cal-month-cell.is-today 规则");
  const body = m[1];
  assert.ok(!/box-shadow/.test(body), "月视图今日格仍有 box-shadow 框线");
  assert.ok(!/outline/.test(body), "月视图今日格有 outline");
  assert.ok(!/border/.test(body), "月视图今日格有 border");
  assert.ok(/background:/.test(body), "月视图今日格丢了背景色（应保留）");
});

t("月视图 is-today:hover 无框线", () => {
  const css = readLF("src/index.css");
  const m = /\.cal-month-cell\.is-today:hover\s*\{([^}]*)\}/.exec(css);
  assert.ok(m, "找不到 .cal-month-cell.is-today:hover 规则");
  assert.ok(!/box-shadow|outline/.test(m[1]), "hover 态带回框线");
  assert.ok(/background:/.test(m[1]), "hover 态丢了背景色");
});

t("周视图今日表头有背景色、无圆点无框线", () => {
  const css = readLF("src/index.css");
  const head = /\.cal-wk-dayhead\.is-today\s*\{([^}]*)\}/.exec(css);
  assert.ok(head, "找不到 .cal-wk-dayhead.is-today 规则");
  assert.ok(/background:/.test(head[1]), "周视图今日表头缺背景色");
  assert.ok(!/box-shadow|outline/.test(head[1]), "周视图今日表头有框线");
  const num = /\.cal-wk-dayhead\.is-today \.cal-wk-num\s*\{([^}]*)\}/.exec(css);
  assert.ok(num, "找不到 .cal-wk-dayhead.is-today .cal-wk-num 规则");
  assert.ok(!/background/.test(num[1]), "日期数字又是实心圆点（background 底）");
  assert.ok(!/border-radius/.test(num[1]), "日期数字保留圆形");
  assert.ok(/color:/.test(num[1]), "日期数字丢了文字色强调");
});

t("年视图 is-today 本来就是纯底色，未被误改", () => {
  const css = readLF("src/index.css");
  const m = /\.cal-year-cell\.is-today\s*\{([^}]*)\}/.exec(css);
  assert.ok(m, "找不到 .cal-year-cell.is-today 规则");
  assert.ok(/background:/.test(m[1]), "年视图今日格丢了背景色");
  assert.ok(!/box-shadow|outline|border/.test(m[1]), "年视图今日格被加上了框线");
});

// ---------- 需求 2：视图记忆 ----------
console.log("[today-view-pref] 视图记忆逻辑");

t("saveCalendarView(task) 不写日历视图键", () => {
  const store = stubStorage();
  vp.saveCalendarView("task");
  assert.strictEqual(vp.loadCalendarView(), null, "task 竟被记进日历视图");
  assert.ok(![...store.keys()].some((k) => k.includes("calendar-view")), "task 落进了日历视图键");
});

t("saveCalendarView(week) → loadCalendarView() 读回 week", () => {
  stubStorage();
  vp.saveCalendarView("week");
  assert.strictEqual(vp.loadCalendarView(), "week", "日历视图键读写不一致");
});

t("saveViewMode(task) 不影响 loadCalendarView", () => {
  stubStorage();
  vp.saveCalendarView("day");
  vp.saveViewMode("task"); // 模拟进入任务视图
  assert.strictEqual(vp.loadCalendarView(), "day", "进 task 覆盖了日历视图记录（会死循环）");
  assert.strictEqual(vp.loadViewMode(), "task", "当前视图键没记到 task");
});

t("loadCalendarView 脏值回落 null", () => {
  const store = stubStorage();
  store.set("caldav-calendar-view", "garbage");
  assert.strictEqual(vp.loadCalendarView(), null, "脏值没被拒");
});

t("localStorage 抛异常不炸（try 兜底）", () => {
  const boom = {
    getItem() { throw new Error("privacy mode"); },
    setItem() { throw new Error("privacy mode"); },
    removeItem() {},
  };
  globalThis.localStorage = boom;
  globalThis.window = { localStorage: boom };
  assert.strictEqual(vp.loadCalendarView(), null, "读失败应回落 null");
  vp.saveCalendarView("week"); // 不抛即过
  assert.strictEqual(vp.loadViewMode(), null, "读失败应回落 null");
});

// ---------- 源码断言 ----------
console.log("[today-view-pref] 源码断言");

t("panel.ts toggle-view 不再硬编码落回月视图", () => {
  const src = readLF("src/ui/panel.ts");
  assert.ok(
    src.includes('ctx.viewMode = ctx.viewMode === "task" ? loadCalendarView() ?? DEFAULT_VIEW : "task"'),
    "toggle-view 仍硬编码 month 或没用 loadCalendarView"
  );
  assert.ok(!/=== "task" \? "month" : "task"/.test(src), "旧硬编码写法残留");
  assert.ok(/import \{[^}]*loadCalendarView[^}]*\} from "\.\/view-pref"/.test(src), "panel.ts 没 import loadCalendarView");
});

t("index.ts viewChangeHandler 记日历视图", () => {
  const src = readLF("src/index.ts");
  // 剥注释后确认调用存在（注释里出现函数名不算）
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const seg = bare.slice(bare.indexOf("viewChangeHandler"));
  assert.ok(/saveCalendarView\(/.test(seg), "viewChangeHandler 里没调 saveCalendarView");
  assert.ok(/writeLastView\(/.test(seg), "viewChangeHandler 里丢了 writeLastView");
});

t("view-pref.ts 双键分工正确", () => {
  const src = readLF("src/ui/view-pref.ts");
  assert.ok(src.includes('"siyuan-plugin-caldav-sync:last-view"'), "旧 key 被换掉（老用户丢记录）");
  assert.ok(src.includes('"caldav-calendar-view"'), "缺日历视图专用键");
  assert.ok(/VALID_CALENDAR/.test(src), "缺日历视图合法集合");
  assert.ok(/if \(!VALID_CALENDAR\.includes\(mode\)\) return;/.test(src), "saveCalendarView 没过滤非日历视图");
});

console.log(`\n[today-view-pref] ${passed} 项通过${process.exitCode ? "，有失败" : ""}`);
