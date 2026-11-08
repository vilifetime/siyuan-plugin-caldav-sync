/**
 * D 组「HTML 注释死键」清理回归锁（2026-11-08，雄哥「就把D组注释的改了吧」）。
 *
 * 背景：`src/ui/*.ts` 的 `<!-- -->` 设计笔记里塞了大量 `${_t("中文片段")}`。
 * 这些调用运行时照样求值，结果却永远不可见，还把 111 条机翻碎片塞进字典
 * （`Xionggge's revised version…` / `NowSync) ,` / `Three action dots per row` …）。
 *
 * 清理口径（清单建议，不是逐条改译文）：注释里的 `_t()` 还原成中文原文，
 * 字典里只服务于注释的死键删掉；21 个注释外也在用的共享 key
 * （新建 / 日程 / 待办 / 筛选 / 周 / …）保留。字典 921 → 810 键，en/zh 同步。
 *
 * 关键约束：**注释里不得再有 _t() 调用**，否则删掉的 key 会在英文界面回退成中文，
 * 且 `i18n-en.mjs` 会把注释内部行当成真实调用去查字典。
 *
 * 用法：node test/d-i18n.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const en = JSON.parse(read("src/i18n/en_US.json"));
const zh = JSON.parse(read("src/i18n/zh_CN.json"));

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const CALL_RE = /(?:\b_t|\bt)\(\s*(["'])([^"']+)\1/g;

function tsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(rel));
    else if (/\.ts$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** 把 TS 源码里的 `\n` 等转义求值成真实字符，才能和字典 key 对上 */
function evalKey(raw) {
  try { return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`); } catch { return raw; }
}

/** 按字符位置区分「HTML 注释内」与「注释外」的 _t()/t() 调用 */
function scan(src) {
  const spans = [...src.matchAll(COMMENT_RE)].map((m) => [m.index, m.index + m[0].length]);
  const inside = [], outside = [];
  for (const m of src.matchAll(CALL_RE)) {
    const k = evalKey(m[2]);
    (spans.some(([a, b]) => m.index >= a && m.index < b) ? inside : outside).push(k);
  }
  return { inside, outside, spans };
}

const scanned = tsFiles("src").map((p) => ({ p, ...scan(read(p)) }));
const commentCalls = scanned.flatMap((x) => x.inside);
const outsideKeys = new Set(scanned.flatMap((x) => x.outside));

// 这 11 个 key 本来就不通过 `_t("…")` 引用（命令 id、HTML 片段、内核兜底文案），
// 属白名单；任何**新增**的「字典里有、源码里没调用」的 key 都应当判红。
const ALLOWED_UNUSED = [
  '<div class="caldav-cal-empty">该账户还没有发现日历</div>',
  '<span class="cal-chip-repeat" title="重复">↻</span>',
  '<span class="cal-list-repeat" title="重复">↻</span>',
  '<span class="caldav-cal-group-state">已停用</span>',
  "OUTGOING ICS (长 {0}):\n{1}\n\nSERVER RESPONSE BODY:\n{2}",
  "addTask", "insertToday", "openCalendarWindow", "openPanel", "syncNow",
  "内核未加载（请重载插件）",
];

// 清单里点名的最扎眼机翻死键（含 4 处「雄哥」被拼成 Xionggge 的）
const DEAD_SAMPLES = [
  "雄哥改版，同日二次调整）：", "雄哥拍板方案", "雄哥要求，与", "下行日期范围",
  "一行三个操作点", "分类筛选）", "打开视图（", "页脚状态条也能点击同步；",
  "立即同步），", "）与搜索（", "主窗口工具栏已有（", "筛选弹层见下方",
  "刷新", "排序", "正交开关",
];

// 注释里出现过、但可见界面也在用的 key —— 一个都不能删
const SHARED = [
  "——", "。", "周", "对齐", "年", "待办", "新建", "日", "日历视图", "日程", "月",
  "本周", "本月", "的", "筛选", "（", "）", "），", "）：", "，", "：",
];

let pass = 0;
const check = (name, fn) => {
  fn();
  pass++;
  console.log(`  [OK] ${name}`);
};

console.log("\n① HTML 注释不再调用 _t()（设计笔记回归纯中文）");
check("src 下所有 .ts 的 <!-- --> 内零 _t()/t() 调用", () => {
  assert.deepEqual(commentCalls, [], `注释里仍有调用：${commentCalls.slice(0, 5).join(" / ")}`);
});
check("判据自测：把一个 ${_t(...)} 塞回注释必须被抓到", () => {
  const broken = "<!--\n  ${_t(\"立即同步），\")}\n-->";
  const r = scan(broken);
  assert.ok(r.inside.includes("立即同步），"), "变异样本必须能被扫描判据抓到");
});
check("设计笔记内容仍在（没有顺手把注释整段删掉）", () => {
  const panel = read("src/ui/panel.ts");
  const settings = read("src/ui/settings-dialog.ts");
  assert.match(panel, /Dock 工具行（2026-10-10 雄哥改版，同日二次调整）：/);
  assert.match(panel, /筛选弹层见下方 catPop 的注释/);
  assert.match(settings, /「扫描清理」：段标题 \+ 两个动作按钮/);
});

console.log("\n② 字典瘦身：921 → 810，两端一致，死键不回流");
check("en/zh 均 810 键、键集合一致、en value 无 CJK", () => {
  assert.strictEqual(Object.keys(en).length, 810);
  assert.strictEqual(Object.keys(zh).length, 810);
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
  for (const [k, v] of Object.entries(en)) assert.ok(!CJK.test(String(v)), `${k} 仍是中文`);
});
check("15 条点名死键已从两端字典彻底删除", () => {
  for (const k of DEAD_SAMPLES) {
    assert.ok(!Object.prototype.hasOwnProperty.call(en, k), `en_US 又冒出死键 ${k}`);
    assert.ok(!Object.prototype.hasOwnProperty.call(zh, k), `zh_CN 还留着死键 ${k}`);
  }
});
check("21 个注释/界面共享 key 全部保留", () => {
  for (const k of SHARED) {
    assert.ok(Object.prototype.hasOwnProperty.call(en, k), `误删在用 key ${k}`);
    assert.ok(Object.prototype.hasOwnProperty.call(zh, k), `zh_CN 误删 ${k}`);
  }
});
check("字典里没有「源码零调用」的新 key（防止注释死键换皮回流）", () => {
  const unused = Object.keys(en).filter((k) => !outsideKeys.has(k));
  const extra = unused.filter((k) => !ALLOWED_UNUSED.includes(k));
  assert.deepEqual(extra, [], `未调用的新 key：${extra.slice(0, 8).join(" / ")}`);
  for (const k of ALLOWED_UNUSED) {
    assert.ok(Object.prototype.hasOwnProperty.call(en, k), `白名单 key 被误删：${k}`);
  }
});
check("判据自测：把死键塞回字典、或误删共享 key 都必须判红", () => {
  const revived = { ...en, "立即同步），": "NowSync) ," };
  const unused = Object.keys(revived).filter((k) => !outsideKeys.has(k));
  assert.ok(unused.some((k) => !ALLOWED_UNUSED.includes(k)), "死键回流必须被未调用判据抓到");
  assert.throws(() => {
    const broken = { ...en };
    delete broken["新建"];
    for (const k of SHARED) assert.ok(Object.prototype.hasOwnProperty.call(broken, k));
  });
});

console.log("\n③ 可见文案不受影响");
check("可见区域的 _t() 调用原样保留（抽查 Dock 品牌/工具行/C 组拼接）", () => {
  const panel = read("src/ui/panel.ts");
  const settings = read("src/ui/settings-dialog.ts");
  assert.match(panel, /title="\$\{_t\("设置"\)\}" aria-label="\$\{_t\("设置"\)\}"/);
  assert.match(panel, /data-action="new-event">\$\{icons\.plus\} \$\{_t\("日程"\)\}/);
  assert.match(settings, /title="\$\{_t\("点击选择该日历「"\)\}\$\{label\}\$\{_t\("」的默认颜色"\)\}"/);
});
check("A/B/C 组定稿译文未被本轮波及", () => {
  assert.strictEqual(en["未完成（未开始）"], "Incomplete(Not started)");
  assert.strictEqual(en["未在标题中识别到日期时间。"], "No date or time recognized in the title.");
  assert.strictEqual(en["条"], "item(s)");
  assert.strictEqual(en["账户「"], "Account '");
  assert.strictEqual(en["」："], "': ");
});

console.log(`\n[PASS] d-i18n：${pass} 项全通过`);
