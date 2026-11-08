/**
 * 星期几英文界面回归锁（2026-11-08，雄哥截图：月/周/日视图仍显示「周一、周二」）。
 *
 * 根因不是字典漏翻，而是 5 个 UI 文件各自把中文星期数组写死，且是**模块顶层常量**：
 *   view-month.ts / view-week.ts / view-list.ts → ["周一",…,"周日"]
 *   view-year.ts / editor.ts                   → ["一",…,"日"]
 * 宿主在插件 init 才 setI18n(字典)，顶层常量早在 import 阶段求值成中文，
 * 英文界面永远显示中文。修法：core/date.ts 的 weekdayLabel() 在**渲染时**
 * 按 isEnglish() 取 Monday…Sunday / 「周一…周日」，短名 Mon…Sun / 「一…日」。
 *
 * 布局副作用：英文全称比中文宽 3 倍，会撑破 7 等分网格（headless 实测 280px
 * 面板横向溢出 182px）。CSS 三件套：minmax(0,1fr) 防撑破 + container-type
 * 按面板宽自适应切缩写（<480px 出 Mon…Sun）+ overflow-x 隐藏兜底。
 *
 * 两层验证：esbuild 把逻辑模块与视图模块分别打进同一实例真跑中英字典并**真实渲染**
 * 月/周/年视图 HTML；再加源码/CSS 契约与变异自测防假绿。
 *
 * 用法：node test/weekday-i18n.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const zh = JSON.parse(read("src/i18n/zh_CN.json"));
const en = JSON.parse(read("src/i18n/en_US.json"));

const FILES = {
  date: "src/core/date.ts",
  i18n: "src/core/i18n.ts",
  common: "src/ui/view-common.ts",
  month: "src/ui/view-month.ts",
  week: "src/ui/view-week.ts",
  list: "src/ui/view-list.ts",
  year: "src/ui/view-year.ts",
  editor: "src/ui/editor.ts",
  css: "src/index.css"
};
const src = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, read(p)]));

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`  [OK] ${name}`); };

/* ─────────── ① 真实逻辑：同实例 bundle，中英字典切换 ─────────── */
const outDir = path.join(ROOT, "dist-test");
fs.mkdirSync(outDir, { recursive: true });
const logicOut = path.join(outDir, "weekday-i18n-logic.mjs");
await build({
  stdin: {
    contents: `
      export { weekdayLabel, weekdayLabels, WEEKDAY_NAMES_EN, WEEKDAY_SHORT_EN } from "./src/core/date.ts";
      export { setI18n, isEnglish } from "./src/core/i18n.ts";
      export { weekdayCellHtml } from "./src/ui/view-common.ts";
    `,
    resolveDir: ROOT, sourcefile: "weekday-logic-entry.ts", loader: "ts"
  },
  bundle: true, format: "esm", platform: "node", outfile: logicOut, logLevel: "silent"
});
const L = await import(pathToFileURL(logicOut).href);

console.log("\n① 中英字典真跑：星期名按语言整体换");
check("英文：Monday…Sunday，短名 Mon…Sun", () => {
  L.setI18n(en);
  assert.equal(L.isEnglish(), true);
  assert.deepEqual(L.weekdayLabels(), ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  assert.deepEqual(L.weekdayLabels(true), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.equal(L.weekdayLabel(0), "Monday");
  assert.equal(L.weekdayLabel(6), "Sunday");
  assert.equal(L.WEEKDAY_NAMES_EN.length, 7);
  assert.equal(L.WEEKDAY_SHORT_EN.length, 7);
});
check("中文：周一…周日 / 单字，且完全不变", () => {
  L.setI18n(zh);
  assert.equal(L.isEnglish(), false);
  assert.deepEqual(L.weekdayLabels(), ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
  assert.deepEqual(L.weekdayLabels(true), ["一", "二", "三", "四", "五", "六", "日"]);
});
check("字典未注入（宿主 import 阶段）按中文处理，之后注入英文能即时生效", () => {
  L.setI18n({});
  assert.equal(L.weekdayLabel(2), "周三");
  L.setI18n(en);
  assert.equal(L.weekdayLabel(2), "Wednesday", "渲染时求值：不能是模块顶层常量");
});
check("mon0 越界归一化：7→周一、-1→周日", () => {
  L.setI18n(en);
  assert.equal(L.weekdayLabel(7), "Monday");
  assert.equal(L.weekdayLabel(-1), "Sunday");
  L.setI18n(zh);
  assert.equal(L.weekdayLabel(7), "周一");
});
check("变异：英文字典把「日历」改回中文 → 星期名回退中文（语言判定失效不半英半中）", () => {
  L.setI18n({ ...en, "日历": "日历" });
  assert.equal(L.isEnglish(), false);
  assert.equal(L.weekdayLabel(2), "周三");
  assert.equal(L.weekdayCellHtml(2), "周三", "中文界面不得输出 full/short 双 span");
  L.setI18n(en);
  assert.equal(L.weekdayLabel(2), "Wednesday");
});
check("weekdayCellHtml：英文输出 full+short 双 span，中文只输出「周三」", () => {
  L.setI18n(en);
  assert.equal(L.weekdayCellHtml(2),
    '<span class="cal-wd-full">Wednesday</span><span class="cal-wd-short">Wed</span>');
  L.setI18n(zh);
  assert.equal(L.weekdayCellHtml(2), "周三");
});

/* ─────────── ② 真实渲染：月 / 周 / 年视图 HTML ─────────── */
/* view-month.ts 的依赖链会拉到 editor.ts / dialog.ts，它们 import 宿主 "siyuan"。
   esbuild 无法解析该模块，用虚拟桩替代（只做模块求值，桩函数不会被调用）。 */
const siyuanStub = {
  name: "siyuan-stub",
  setup(b) {
    b.onResolve({ filter: /^siyuan$/ }, () => ({ path: "siyuan", namespace: "siyuan-stub" }));
    b.onLoad({ filter: /.*/, namespace: "siyuan-stub" }, () => ({
      contents: `
        export const Dialog = class {};
        export const Plugin = class {};
        export const openTab = () => {};
        export const openWindow = () => {};
        export const openMobileFileById = () => {};
        export const showMessage = () => {};
        export const getFrontend = () => "desktop";
        export const fetchPost = async () => ({});
        export const fetchSyncPost = () => ({});
        export const client = { fetch: async () => ({}) };
        export const Constants = {};
      `,
      loader: "js"
    }));
  }
};
const renderOut = path.join(outDir, "weekday-i18n-render.mjs");
await build({
  stdin: {
    contents: `
      export { setI18n } from "./src/core/i18n.ts";
      export { renderMonthView } from "./src/ui/view-month.ts";
      export { renderWeekView } from "./src/ui/view-week.ts";
      export { renderYearView } from "./src/ui/view-year.ts";
    `,
    resolveDir: ROOT, sourcefile: "weekday-render-entry.ts", loader: "ts"
  },
  bundle: true, format: "esm", platform: "node", outfile: renderOut, logLevel: "silent",
  plugins: [siyuanStub]
});
const dom = new JSDOM("<!doctype html><body></body>");
for (const k of ["document", "window", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MutationObserver"])
  globalThis[k] = dom.window[k] ?? dom.window;
const R = await import(pathToFileURL(renderOut).href);

const mkArgs = () => {
  const viewEl = dom.window.document.createElement("div");
  const ctx = {
    cursor: "2026-11-08",
    sortMode: "time",
    store: { settings: { showHolidaysCN: false, showLunarCN: false, showTermCN: false } },
    navigate: () => {}
  };
  return { ctx, viewEl, occurrences: () => new Map() };
};
const render = (kind) => {
  const a = mkArgs();
  if (kind === "month") R.renderMonthView(a);
  else if (kind === "week") R.renderWeekView(a, 7);
  else R.renderYearView(a);
  return a.viewEl.innerHTML;
};
const EN_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ZH_DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

console.log("\n② 真实渲染：月 / 周 / 年视图（同一模块实例切换语言）");
check("先中文后英文：顶层常量会在这里暴露（两次渲染结果必须不同）", () => {
  R.setI18n(zh);
  const zhMonth = render("month");
  R.setI18n(en);
  const enMonth = render("month");
  assert.match(zhMonth, /周一/);
  assert.ok(!zhMonth.includes("Monday"), "中文界面不该出现英文星期");
  assert.match(enMonth, /Monday/);
  assert.ok(!enMonth.includes("周"), `英文月视图残留中文：${enMonth.slice(0, 300)}`);
  assert.notEqual(zhMonth, enMonth);
});
check("英文月视图：7 个全称 + 7 个短名双 span，无中文", () => {
  R.setI18n(en);
  const html = render("month");
  for (const d of EN_DAYS) assert.ok(html.includes(`class="cal-wd-full">${d}</span>`), `缺 ${d}`);
  for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) assert.ok(html.includes(`class="cal-wd-short">${d}</span>`), `缺 ${d}`);
  assert.ok(!/[周一][一二三四五六日]/.test(html), "英文月视图残留中文星期");
});
check("英文周/日视图：表头 7 天全称 + title，无中文", () => {
  R.setI18n(en);
  const html = render("week");
  assert.ok(html.includes('class="cal-wk-wd" title="Monday"'), "周视图表头缺 Monday");
  assert.ok(html.includes('class="cal-wd-full">Wednesday</span>'), "周视图表头缺 Wednesday");
  assert.ok(!/周[一二三四五六日]/.test(html), "英文周视图残留中文星期");
});
check("英文年视图：12 个小月历表头是 Mon…Sun（格子窄，用短名），title 有全称", () => {
  R.setI18n(en);
  const html = render("year");
  assert.ok(html.includes('title="Monday">Mon</span>'), "年视图缺 Monday 短名格");
  assert.ok(html.includes('title="Sunday">Sun</span>'), "年视图缺 Sunday 短名格");
  assert.ok(!/周[一二三四五六日]/.test(html), "英文年视图残留中文星期");
  assert.ok(html.includes("January") && html.includes("December"), "月份标题回归（上一轮修复）不能坏");
});
check("中文渲染全部保持「周一…周日」，且不输出双 span", () => {
  R.setI18n(zh);
  for (const kind of ["month", "week", "year"]) {
    const html = render(kind);
    assert.ok(ZH_DAYS.some((d) => html.includes(d)) || html.includes("一"), `${kind} 中文星期消失`);
    assert.ok(!html.includes("cal-wd-full"), `${kind} 中文界面不该输出 full/short 双 span`);
  }
});

/* ─────────── ③ 源码 / CSS 契约 ─────────── */
console.log("\n③ 源码与 CSS 契约（含变异自测）");
const HARD_ARRAY = /\[\s*"(?:周一|一)"\s*,\s*"(?:周二|二)"/;
function block(css, selector) {
  const at = css.indexOf(selector + " {");
  assert.ok(at >= 0, `缺 CSS 选择器 ${selector}`);
  return css.slice(at, css.indexOf("}", at) + 1);
}
function assertContracts(s) {
  // 5 个 UI 文件不得再出现硬编码中文星期数组
  for (const k of ["month", "week", "list", "year", "editor"])
    assert.ok(!HARD_ARRAY.test(s[k]), `${k} 又出现硬编码中文星期数组`);
  // 都改成渲染时调用（含函数名，不是残留的字面量）
  assert.ok(/weekdayLabels\(\)/.test(s.month) && /weekdayCellHtml\(i\)/.test(s.month), "月视图未用 weekdayCellHtml");
  assert.ok(/weekdayLabel\(mon0\)/.test(s.week) && /weekdayCellHtml\(mon0\)/.test(s.week), "周视图未用 weekdayCellHtml");
  assert.ok(/weekdayLabel\(\(parseLocalStamp\(day\)/.test(s.list), "列表视图未用 weekdayLabel");
  assert.ok(/weekdayLabels\(true\)/.test(s.year), "年视图未用短名 weekdayLabels(true)");
  assert.ok(/weekdayLabel\(i, true\)/.test(s.editor), "编辑弹窗 BYDAY 未用短名 weekdayLabel");
  // 顶层常量只能在 date.ts 一处
  assert.ok(/WEEKDAY_NAMES_ZH/.test(s.date) && /WEEKDAY_SHORT_ZH/.test(s.date), "date.ts 缺中文星期表");
  assert.ok(/isEnglish\(\)/.test(s.date), "date.ts 未按语言判定");
  assert.ok(!/WEEK_LABELS\s*=/.test(s.month + s.week + s.list + s.year), "顶层常量死灰复燃");
  // view-common helper 中文分支不输出双 span
  assert.ok(/if \(!isEnglish\(\)\) return full;/.test(s.common), "weekdayCellHtml 中文分支被改坏");
  // CSS：防撑破 + 双容器 + 自适应规则
  const mw = block(s.css, ".cal-month-weeks");
  const wd = block(s.css, ".cal-wk-days");
  const wk = block(s.css, ".cal-wk");
  assert.match(mw, /grid-template-columns:\s*repeat\(7,\s*minmax\(0, 1fr\)\)/, "月视图 7 等分未用 minmax(0,1fr)");
  assert.match(wd, /repeat\(var\(--cols, 7\),\s*minmax\(0, 1fr\)\)/, "周视图 7 等分未用 minmax(0,1fr)");
  assert.match(mw, /container-type:\s*inline-size/, "月视图表头缺 inline-size 容器");
  assert.match(wk, /container-type:\s*inline-size/, "周视图根缺 inline-size 容器");
  assert.match(s.css, /\.cal-wd-short\s*\{\s*display:\s*none;/, "短名默认应隐藏");
  assert.match(s.css, /@container \(max-width: 479px\)\s*\{[\s\S]*?\.cal-wd-full\s*\{\s*display:\s*none;\s*\}[\s\S]*?\.cal-wd-short\s*\{\s*display:\s*inline;/,
    "缺窄面板切换 full→short 的 @container 规则");
}
check("当前源码与 CSS 满足全部契约", () => assertContracts(src));
check("变异自测①：把 minmax(0,1fr) 改回裸 1fr 必须判红", () => {
  const broken = { ...src, css: src.css.replace("grid-template-columns: repeat(7, minmax(0, 1fr));", "grid-template-columns: repeat(7, 1fr);") };
  assert.throws(() => assertContracts(broken), /minmax/, "判据未抓到 1fr 回归");
});
check("变异自测②：去掉 @container 切换规则必须判红", () => {
  const broken = { ...src, css: src.css.replace(/\.cal-wd-full \{ display: none; \}/, ".cal-wd-full { display: inline; }") };
  assert.throws(() => assertContracts(broken), /@container/, "判据未抓到缩写切换缺失");
});
check("变异自测③：把月视图改回硬编码中文数组必须判红", () => {
  const broken = { ...src, month: src.month.replace(/weekdayLabels\(\)\.map\(\(w, i\)/,
    '(["周一", "周二", "周三", "周四", "周五", "周六", "周日"]).map((w, i)') };
  assert.throws(() => assertContracts(broken), /硬编码中文星期数组/, "判据未抓到硬编码回归");
});
check("变异自测④：周视图改回字面中文 title 必须判红", () => {
  const broken = { ...src, week: src.week.replace('const wd = weekdayLabel(mon0);', 'const wd = "周一";') };
  assert.throws(() => assertContracts(broken), /周视图/, "判据未抓到周视图回归");
});

console.log(`\nweekday-i18n: ${pass} 项断言全部通过（星期几英文全称 / 窄面板缩写 / 中文不变 / 真实渲染）`);
