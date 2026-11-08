/**
 * 日期 / 月份 / 农历的英文界面回归锁（2026-11-08，雄哥两张截图）。
 *
 * 三个症状，根子都是「把日期格式逐字当单词翻译」：
 *   ① 左侧 Dock「9月24日」→ `9Month24Day`，应为 "September 24th"；
 *   ② 年视图 12 个小月历「1月…12月」→ `1 Month / 2 Month`，应为 January…December；
 *      工具栏月视图标题「2026年11月」→ `2026 Year 11 Month`，应为 "November 2026"；
 *   ③ 日历格农历「九月廿六」→ `九月month廿六` 半英半中。
 *      农历是中文专名，雄哥拍板**任何语言下都保持中文**，不走字典。
 *
 * 修法：core/i18n.ts 加 isEnglish()（按字典内容判语言，不依赖 window）；
 * core/date.ts 用月份名 + 序数整体换格式，而不是翻译「月」「日」两字；
 * 各 UI 拼接点统一走 fmtDateCn / monthLabel / ordinalEn。
 *
 * 测试分两层：esbuild 把 date.ts + i18n.ts + holiday-cn.ts 打进**同一个模块实例**，
 * 真跑 setI18n(zh/en) 后的输出；再加源码契约与变异自测防假绿。
 *
 * 用法：node test/date-i18n.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const zh = JSON.parse(read("src/i18n/zh_CN.json"));
const en = JSON.parse(read("src/i18n/en_US.json"));
const dateSrc = read("src/core/date.ts");
const i18nSrc = read("src/core/i18n.ts");
const lunarSrc = read("src/core/holiday-cn.ts");
const yearSrc = read("src/ui/view-year.ts");
const panelSrc = read("src/ui/panel.ts");
const popupSrc = read("src/ui/month-day-popup.ts");
const indexSrc = read("src/index.ts");
const editorSrc = read("src/ui/editor.ts");

/* ---------- 把三个模块打进同一个 bundle，保证 setI18n 影响的是同一个 i18n 单例 ---------- */
const outDir = path.join(ROOT, "dist-test");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "date-i18n.mjs");
await build({
  stdin: {
    contents: `
      export { fmtDateCn, monthLabel, ordinalEn, MONTH_NAMES_EN } from "./src/core/date.ts";
      export { setI18n, isEnglish } from "./src/core/i18n.ts";
      export { lunarFor } from "./src/core/holiday-cn.ts";
    `,
    resolveDir: ROOT,
    sourcefile: "date-i18n-entry.ts",
    loader: "ts"
  },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent"
});
const M = await import(pathToFileURL(out).href);

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`  [OK] ${name}`); };

console.log("\n① 中文字典：格式完全不变（zh_CN 恒等映射 / 字典未注入时回退中文）");
check("isEnglish() 为 false，短日期仍是「9月24日」「11月8日」", () => {
  M.setI18n(zh);
  assert.equal(M.isEnglish(), false);
  assert.equal(M.fmtDateCn("2026-09-24"), "9月24日");
  assert.equal(M.fmtDateCn("2026-11-08"), "11月8日");
});
check("月份标题仍是「1 月」「11 月」，农历仍是中文", () => {
  assert.equal(M.monthLabel(1), "1 月");
  assert.equal(M.monthLabel(11), "11 月");
  assert.match(M.lunarFor("2026-09-24").lunar, /月/);
});
check("字典未注入（测试桩 i18n:{}）时按中文处理，不白屏", () => {
  M.setI18n({});
  assert.equal(M.isEnglish(), false);
  assert.equal(M.fmtDateCn("2026-09-24"), "9月24日");
});

console.log("\n② 英文字典：日期用月份名 + 序数，月份标题用 January…December");
check("isEnglish() 为 true，9月24日 → September 24th、11月8日 → November 8th", () => {
  M.setI18n(en);
  assert.equal(M.isEnglish(), true);
  assert.equal(M.fmtDateCn("2026-09-24"), "September 24th");
  assert.equal(M.fmtDateCn("2026-11-08"), "November 8th");
  assert.ok(!/Month|Day/i.test(M.fmtDateCn("2026-09-24")), "不得再出现 9Month24Day");
});
check("12 个月标题逐月正确（1=January / 2=February / 9=September / 12=December）", () => {
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  assert.deepEqual([...M.MONTH_NAMES_EN], names);
  for (let m = 1; m <= 12; m++) assert.equal(M.monthLabel(m), names[m - 1], `${m} 月译名`);
  assert.ok(!/^\d+ Month/.test(M.monthLabel(1)), "不得再出现 1 Month");
});
check("序数后缀边界：1st/2nd/3rd/4th/11th/12th/13th/21st/22nd/23rd/30th/31st", () => {
  const cases = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 11: "11th", 12: "12th", 13: "13th",
    21: "21st", 22: "22nd", 23: "23rd", 24: "24th", 30: "30th", 31: "31st" };
  for (const [d, want] of Object.entries(cases)) assert.equal(M.ordinalEn(+d), want, `${d} 日`);
});
check("英文字典下农历仍为中文，且不含 month 字样", () => {
  for (const day of ["2026-09-24", "2026-10-01", "2026-11-08", "2026-01-01"]) {
    const { lunar } = M.lunarFor(day);
    assert.match(lunar, /[\u4e00-\u9fff]+月[\u4e00-\u9fff]+/, `${day} 农历应为中文`);
    assert.ok(!/month/i.test(lunar), `${day} 农历被译成英文`);
  }
});

console.log("\n③ 源码契约：所有 UI 拼接点都走新格式函数");
check("date.ts 有 12 个英文月份名且 fmtDateCn 按 isEnglish 分支", () => {
  assert.match(dateSrc, /MONTH_NAMES_EN\s*=\s*\[/);
  assert.match(dateSrc, /if \(isEnglish\(\)\) return `\$\{MONTH_NAMES_EN\[m - 1\]/);
  assert.match(dateSrc, /export function ordinalEn/);
});
check("i18n.ts 的 isEnglish 按字典内容判定，不依赖 window", () => {
  assert.match(i18nSrc, /export function isEnglish\(\): boolean \{\s*return t\("日历"\) !== "日历";/);
  assert.ok(!/window/.test(i18nSrc.slice(i18nSrc.indexOf("export function isEnglish"))));
});
check("lunarFor 直接输出中文，不再经字典模板", () => {
  const body = lunarSrc.slice(lunarSrc.indexOf("export function lunarFor"), lunarSrc.indexOf("export function chinaCalendarEnabled"));
  assert.ok(!/_t\(/.test(body), "农历不得再调用 _t()");
  assert.match(body, /getMonthInChinese\(\)\}月\$\{l\.getDayInChinese\(\)/);
});
check("view-year.ts 月标题用 monthLabel，年视图 head 英文不带 Year", () => {
  assert.match(yearSrc, /\$\{monthLabel\(m \+ 1\)\}/);
  assert.match(yearSrc, /\$\{y\}\$\{isEnglish\(\) \? "" : ` \$\{_t\("年"\)\}`\}/);
  assert.ok(!/\$\{m \+ 1\} \$\{_t\("月"\)\}/.test(yearSrc), "旧逐字拼接仍在");
});
check("panel.ts 工具栏标题按语言整体换格式", () => {
  assert.match(panelSrc, /isEnglish\(\)\s*\? `\$\{monthLabel\(m\)\} \$\{y\}`/);
  assert.match(panelSrc, /monthLabel\(m\)\} \$\{ordinalEn\(d\)\}, \$\{y\}/);
  assert.ok(!/\$\{\+c\.slice\(0, 4\)\} \$\{_t\("年"\)\}/.test(panelSrc), "旧逐字拼接仍在");
});
check("month-day-popup.ts 标题用 fmtDateCn(day)", () => {
  assert.match(popupSrc, /class="caldav-month-pop-title">\$\{fmtDateCn\(day\)\}/);
  assert.ok(!/\$\{\+m\}\$\{_t\("月"\)\}/.test(popupSrc));
});
check("index.ts dateCn、editor.ts 重复频率单位都已英文化", () => {
  assert.match(indexSrc, /isEnglish\(\)\s*\? `\$\{fmtDateCn\(stamp\)\}, \$\{stamp\.slice\(0, 4\)\}`/);
  assert.match(editorSrc, /MONTHLY: "months"/);
  assert.match(editorSrc, /const unit = isEnglish\(\)/);
});
check("视图切换按钮仍保留 Year/Month/Day（正确用法，别被误删）", () => {
  assert.match(panelSrc, /data-view="month">\$\{_t\("月"\)\}/);
  assert.match(panelSrc, /data-view="year">\$\{_t\("年"\)\}/);
});

console.log("\n④ 字典与变异自测：判据必须能抓到回退（防假绿）");
check("死键 {0}月{1} 已从两字典删除，en_US 不再有 {0}month{1}", () => {
  assert.ok(!("{0}月{1}" in zh) && !("{0}月{1}" in en));
  assert.ok(!Object.values(en).some(v => /\{0\}month\{1\}/.test(String(v))));
});
check("语言判定键稳定：zh 恒等、en 为 Calendar", () => {
  assert.equal(zh["日历"], "日历");
  assert.equal(en["日历"], "Calendar");
});
check("变异：判定键被改坏时降级为中文，绝不退化成 9Month24Day", () => {
  M.setI18n({ ...en, "日历": "日历" });
  assert.equal(M.isEnglish(), false);
  const degraded = M.fmtDateCn("2026-09-24");
  assert.equal(degraded, "9月24日");
  assert.ok(!/Month|Day/i.test(degraded), "中文分支不得经 t() 拼出半英半中");
  M.setI18n(en);
  assert.equal(M.fmtDateCn("2026-09-24"), "September 24th");
});
check("变异：源码改回旧逐字拼接时，上面每条判据都会判红", () => {
  const brokenPopup = popupSrc.replace(/\$\{fmtDateCn\(day\)\}/, '${+m}${_t("月")}${+d}${_t("日")}');
  assert.ok(/\$\{\+m\}\$\{_t\("月"\)\}/.test(brokenPopup));
  const brokenYear = yearSrc.replace(/\$\{monthLabel\(m \+ 1\)\}"/, '${m + 1} ${_t("月")}"');
  assert.ok(/\$\{m \+ 1\} \$\{_t\("月"\)\}/.test(brokenYear));
  const brokenLunar = lunarSrc.replace(
    /return \{ lunar: `\$\{l\.getMonthInChinese\(\)\}月\$\{l\.getDayInChinese\(\)\}`, jieqi: l\.getJieQi\(\) \};/,
    'return { lunar: _t("{0}月{1}", l.getMonthInChinese(), l.getDayInChinese()), jieqi: l.getJieQi() };');
  assert.ok(/_t\("\{0\}月\{1\}"/.test(brokenLunar), "判据必须能抓到农历回退");
});

console.log("\n⑤ 真实渲染年视图：12 个小月历的 HTML 必须真出现 January…December");
const yearOut = path.join(outDir, "date-i18n-year.mjs");
await build({
  stdin: {
    contents: `
      export { setI18n } from "./src/core/i18n.ts";
      export { renderYearView } from "./src/ui/view-year.ts";
    `,
    resolveDir: ROOT, sourcefile: "date-i18n-year-entry.ts", loader: "ts"
  },
  bundle: true, format: "esm", platform: "node", outfile: yearOut, logLevel: "silent"
});
const Y = await import(pathToFileURL(yearOut).href);
const renderYear = (dict) => {
  Y.setI18n(dict);
  const viewEl = { innerHTML: "", querySelector: () => null };
  Y.renderYearView({
    ctx: { cursor: "2026-01-01", store: { settings: { showHolidaysCN: false } } },
    viewEl,
    occurrences: () => new Map()
  });
  return viewEl.innerHTML;
};
const MONTH_HEAD = /<div class="cal-year-month-head"[^>]*>([^<]*)<\/div>/g;
check("英文字典：12 个标题为 January…December，head 无「2026 Year」", () => {
  const html = renderYear(en);
  const heads = [...html.matchAll(MONTH_HEAD)].map(m => m[1]);
  assert.equal(heads.length, 12, "年视图应有 12 个小月历");
  assert.equal(heads[0], "January");
  assert.equal(heads[1], "February");
  assert.equal(heads[8], "September");
  assert.equal(heads[11], "December");
  assert.ok(!/1 Month|2026 Year/.test(html), "旧逐字直译仍出现在真实 HTML 里");
  assert.match(html, /<div class="cal-year-head">2026 · Total/);
});
check("中文字典：12 个标题仍是「1 月」…「12 月」，head 带「年」", () => {
  const html = renderYear(zh);
  const heads = [...html.matchAll(MONTH_HEAD)].map(m => m[1]);
  assert.equal(heads[0], "1 月");
  assert.equal(heads[11], "12 月");
  assert.match(html, /<div class="cal-year-head">2026 年 · 共/);
});

console.log(`\ndate-i18n: ${pass} 项断言全部通过（英文日期/月份名 + 农历保持中文 + 中文不回退 + 年视图真实渲染）`);
