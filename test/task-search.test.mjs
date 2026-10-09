/**
 * 任务视图工具栏「快速添加 + 搜索」回归（npm run test:tasksearch）。
 *
 * 背景（2026-10-09 雄哥要求，思源与 Obsidian 同步）：
 *   ① 左侧 Dock 的搜索框**去掉** —— Dock 只显示少量条目，在那儿搜等于
 *      「搜一个看不见全貌的列表」，搜到了也看不到全貌；
 *   ② 快速添加框截成两段：**2/3 给快速添加、1/3 给搜索**。
 *
 * 风险不在视觉而在行为：
 *   - 输入时若整体重渲染 viewEl，输入框连同用户刚敲的字一起被换掉，
 *     表现为「每打一个字符框就清空一次」，输入根本打不完；
 *   - 搜索词若只放局部变量，重渲染后即丢失；
 *   - 搜索若排在筛选**之前**，下拉里的 (N) 计数会与列表对不上。
 * 所以下面用源码断言把这三条钉死，纯函数（匹配口径）则直接跑编译后的模块。
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

// ══════════════════════════════════════════════════════════════
// ①纯函数层：直接跑编译后的 matchesSearchQuery
// ══════════════════════════════════════════════════════════════
const OUT = path.join(ROOT, ".test-task-search");
fs.rmSync(OUT, { recursive: true, force: true });
const req = createRequire(import.meta.url);
// esbuild 是 CJS 包，用 createRequire 直接取。
// ⚠️ 别写成 `await import(path.join(...))` —— Windows 上绝对路径是 "D:\..."，
// ESM 加载器会当URL scheme 解析并抛 ERR_UNSUPPORTED_ESM_URL_SCHEME（要 file:// URL）。
const esbuild = req(path.join(ROOT, "node_modules", "esbuild", "lib", "main.js"));
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src", "ui", "view-common.ts")],
  bundle: true,
  format: "cjs",
  outfile: path.join(OUT, "view-common.cjs"),
  external: ["obsidian"],
  logLevel: "error"
});
// view-common 只用到 normalizePath（类型 import 编译后已擦除），给一个最小实现
const Module = req("module");
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "obsidian") {
    return { normalizePath: (p) => String(p).replace(/\\/g, "/").replace(/\/{2,}/g, "/") };
  }
  return origLoad.call(this, request, ...rest);
};
const VC = req(path.join(OUT, "view-common.cjs"));

const mkItem = (o = {}) => ({
  uid: "u1",
  kind: "todo",
  calendarUrl: "c",
  href: "c/1.ics",
  summary: "智慧食堂整改",
  allDay: false,
  start: "2026-09-24T09:00:00",
  end: "2026-09-24T09:00:00",
  priority: 0,
  status: "NEEDS-ACTION",
  percent: 0,
  createdAt: "2026-09-24T09:00:00",
  dirty: false,
  ...o
});

// ⚠️ createRequire 的 import 必须早于上面那次 require 调用 —— 上面是引用了
// 尚未声明的函数（函数声明会提升，但 import 是 const），所以这里统一改成
// 顶部一次性拿到 createRequire，代码顺序固定，不再出现前后依赖。
const m = VC.matchesSearchQuery;
assert.strictEqual(typeof m, "function", "view-common 应导出 matchesSearchQuery");
assert.strictEqual(m(mkItem(), ""), true, "空字符串应判为命中");
assert.strictEqual(m(mkItem(), "   "), true, "纯空格应判为命中（trim 后为空）");
assert.strictEqual(m(mkItem(), "食堂"), true, "标题命中");
assert.strictEqual(m(mkItem({ description: "跟进后勤处" }), "后勤"), true, "备注命中");
assert.strictEqual(m(mkItem({ location: "三楼" }), "三楼"), true, "地点命中");
assert.strictEqual(m(mkItem({ categories: ["工程", "安全"] }), "安全"), true, "分类命中");
assert.strictEqual(m(mkItem({ summary: "Warehouse Audit" }), "  audit  "), true,
  "应大小写不敏感且忽略首尾空格");
assert.strictEqual(m(mkItem(), "不存在的词"), false, "不匹配应判 false");
// 边界：summary 可能为空串 / undefined
assert.strictEqual(m(mkItem({ summary: "" }), "x"), false, "summary 为空串不应抛");
assert.strictEqual(m(mkItem({ summary: "", description: "", location: "", categories: [] }), "x"), false,
  "四个字段全空时不应抛");
assert.strictEqual(m(mkItem({ summary: undefined }), "x"), false, "summary 为 undefined 不应抛");
console.log("  ✓ matchesSearchQuery：四字段命中 / 大小写与空格 / 空字段不抛");

// ══════════════════════════════════════════════════════════════
// ② 源码契约层
// ══════════════════════════════════════════════════════════════
const panel = read("src/ui/panel.ts");
const panelCode = stripComments(panel);
const viewTask = read("src/ui/view-task.ts");
const css = read("src/index.css");

// ── Dock 搜索框彻底没了 ──
assert.ok(!/data-dock="search"/.test(panel), "Dock 不该再有 data-dock=\"search\" 的输入框");
assert.ok(!/caldav-dock-search/.test(panelCode), "panel.ts 不该再引用 .caldav-dock-search* 类");
assert.ok(!/caldav-dock-search/.test(css), "CSS 不该再有 .caldav-dock-search* 规则（留着就是死样式）");
assert.ok(!/dockSearch/.test(panelCode), "panel.ts 不该再有 dockSearch 状态");
assert.ok(!/onRootInput/.test(panelCode), "Dock 搜索框专属的 input 监听应随之删除");
assert.ok(!/function matchesDockSearch/.test(panelCode),
  "panel.ts 里的 matchesDockSearch 已挪到 view-common，不该留成孤儿函数");
console.log("  ✓ Dock 搜索框已彻底移除（DOM / CSS / 状态 / 事件 / 孤儿函数 五处）");

// ── filterbar 三元素顺序：下拉 → 快速添加 → 搜索 ──
// ⚠️ 切片别用 `cal-task-list` 定位：那个类名在注释里也出现，indexOf 会命中
// filterbar 之前的位置，切出空串。用 data-task-search 回溯到开标签。
const iSearchAttr = viewTask.indexOf("data-task-search");
const iBarOpen = viewTask.lastIndexOf('class="cal-task-filterbar"', iSearchAttr);
const barEnd = viewTask.indexOf("</div>", viewTask.indexOf("</div>", viewTask.indexOf("</div>", iSearchAttr) + 1) + 1);
assert.ok(iBarOpen >= 0 && iSearchAttr > iBarOpen && barEnd > iSearchAttr, "定位 filterbar 模板片段失败");
const bar = viewTask.slice(iBarOpen, barEnd);
const iFilter = bar.indexOf("data-filter");
const iQuick = bar.indexOf("data-quickadd");
const iSearch = bar.indexOf("data-task-search");
assert.ok(iFilter >= 0 && iQuick >= 0 && iSearch >= 0, "filterbar 里应同时有筛选下拉、快速添加框与搜索框");
assert.ok(iFilter < iQuick && iQuick < iSearch, `顺序应为 下拉 → 快速添加 → 搜索，实际 ${iFilter}/${iQuick}/${iSearch}`);
assert.ok(/cal-task-search-icon/.test(bar) && /icons\.search/.test(bar), "搜索框应带放大镜图标");
assert.ok(/value="\$\{escape\(searchQuery\(\)\)\}"/.test(bar),
  "搜索框的 value 必须从 searchQuery() 回填（重渲染后要保住用户输入）");
console.log("  ✓ filterbar 三元素顺序正确，搜索框带图标 + value 回填");

// ── 宽度 2:1 ──
assert.ok(/\.cal-task-quick\s*\{[^}]*flex:\s*2 1 0/.test(css), "快速添加框应占 2 份");
assert.ok(/\.cal-task-searchwrap\s*\{[^}]*flex:\s*1 1 0/.test(css),
  "搜索框应占 1 份 —— 包裹层承担 flex，input 本身不能设");
assert.ok(/\.cal-task-filterbar\s*\{[^}]*align-items:\s*center/.test(css),
  "filterbar 需要 align-items: center（包裹层两级嵌套，顶对齐会错位）");
assert.ok(/\.cal-task-quick\s*\{[^}]*min-width:\s*0/.test(css) &&
  /\.cal-task-searchwrap\s*\{[^}]*min-width:\s*0/.test(css),
  "两个框都要 min-width: 0，否则 flex 子项不肯收缩、2:1 会被内容撑破");
console.log("  ✓ 宽度按 2:1 分配，且补齐 align-items / min-width");

// ── 搜索行为：只重渲染列表、绝不整体重渲染 ──
const bind = (() => {
  const from = viewTask.indexOf('addEventListener("input"');
  const to = viewTask.indexOf("});", from);
  return viewTask.slice(from, to > 0 ? to : from + 400);
})();
assert.ok(/setSearchQuery\(searchInput\.value\)/.test(bind), "输入时应把值写进 searchQuery");
assert.ok(/\.cal-task-list/.test(bind), "输入时必须重渲染 .cal-task-list");
assert.ok(/listHtml\(curFilter\(\)\)/.test(bind), "输入时要用 curFilter() 现读筛选");
assert.ok(!/viewEl\.innerHTML\s*=/.test(bind),
  "⚠️ 输入时绝不能重渲染 viewEl 整体 —— 会把输入框连同刚敲的字一起换掉，" +
  "表现为「每打一个字符框就清空一次」");
console.log("  ✓ 搜索只重渲染列表、不动输入框，且用现读筛选");

// ── 搜索词存 dataset ──
assert.ok(/function searchQuery\(\)[\s\S]*?viewEl\.dataset\.taskQuery/.test(viewTask),
  "搜索词应从 viewEl.dataset.taskQuery 读");
assert.ok(/delete viewEl\.dataset\.taskQuery/.test(viewTask),
  "清空时要 delete 而不是写空串");
console.log("  ✓ 搜索词存 dataset.taskQuery，清空时 delete");

// ── 搜索必须排在筛选之后，且取 row.it ──
const listFn = viewTask.slice(viewTask.indexOf("function listHtml"));
const bodyEnd = (() => {
  const start = listFn.indexOf("{");
  let depth = 0;
  for (let i = start; i < listFn.length; i++) {
    if (listFn[i] === "{") depth++;
    else if (listFn[i] === "}") { depth--; if (depth === 0) return i; }
  }
  return listFn.length;
})();
const listBody = listFn.slice(0, bodyEnd);
assert.ok(/todos\.filter\(f\.match\)\.filter\(\s*\(row\)\s*=>\s*matchesSearchQuery/.test(listBody),
  "搜索必须接在筛选之后（顺序反了会让下拉里的 (N) 计数与列表对不上）");
assert.ok(/row\.it/.test(listBody),
  "匹配要传 row.it —— list 里是 Row 包装（{ it, due, isEvent }）不是裸 CalItem");
console.log("  ✓ 搜索接在筛选之后，且正确取 row.it");

// ── 空态区分两种「空」 ──
assert.ok(/没有匹配/.test(viewTask), "被搜索过滤光时应给「没有匹配…的任务」而不是笼统的「无结果」");
console.log("  ✓ 空态区分「筛选为空」与「搜索无匹配」");

// ── ★ 0.2.18 修复的回归（2026-10-10 雄哥实测，Obsidian 侧同款） ──

// ① 折叠重渲染不许用 current 常量（思源侧此前已修对，这里钉住防回退）
assert.ok(!/list\.innerHTML\s*=\s*listHtml\(current\)/.test(viewTask),
  "重渲染不许用 listHtml(current) —— 必须现读 curFilter()" +
  "（否则切筛选后点组头，列表退回旧筛选，已完成组「一点就消失」）");
assert.ok((viewTask.match(/listHtml\(curFilter\(\)\)/g) || []).length >= 3,
  "折叠 click/keydown 与搜索输入三处都应现读 curFilter()");
console.log("  ✓ 折叠重渲染一律现读 curFilter()（防「已完成组一点就消失」回退）");

// ② 放大镜不压字：padding-left 必须双类提特异性
assert.ok(/\.caldav-input\.cal-task-search\s*\{[^}]*padding-left:\s*30px/.test(css),
  "padding-left: 30px 必须写在 .caldav-input.cal-task-search 双类上" +
  "（单类会被后面 .caldav-input 的 padding 简写覆盖，放大镜压字）");
// ⚠️ 先剥掉双类规则再测负向：`.caldav-input.cal-task-search` 本身包含
// 子串 `.cal-task-search`，不剥的话这条负向断言会被刚写的正解误命中。
const cssNoDual = css.replace(/\.caldav-input\.cal-task-search/g, "");
assert.ok(!/\.cal-task-search\s*\{[^}]*padding-left/.test(cssNoDual),
  "不许再留单类 .cal-task-search 的 padding-left（会被覆盖，等于没写）");
console.log("  ✓ 放大镜 padding-left 走双类特异性（不再被 .caldav-input 覆盖）");

// ③ 占位文案
assert.ok(/placeholder="搜索\.\.\."/.test(viewTask), "中文占位应为「搜索...」（雄哥指定）");
console.log("  ✓ 占位文案 =「搜索...」");

fs.rmSync(OUT, { recursive: true, force: true });
console.log("[tasksearch] 任务视图搜索回归全部通过（Dock 搜索框已移除 / 匹配函数复用 / 2:1 三列 / 只重渲染列表 / 搜索词存 dataset / 搜索在筛选之后 / 空态区分）");
