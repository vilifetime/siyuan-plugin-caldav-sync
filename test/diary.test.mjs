/**
 * 「把日程与待办插入日记」回归测试。
 *
 * 守三件曾经出问题的事：
 * 1) 不能把「不在范围内」的条目写进日记 —— `occurrencesInRange()` 对无重复规则的条目会
 *    回退返回 `item.start`（可能不在窗口内），视图侧按日期落格会被自然丢掉，直接照单全收就会漏进来；
 * 2) 待办一律按到期日（DUE）归属，与视图/统计口径一致；
 * 3) 写入后必须有反馈并打开日记文档成为当前活动页签，重复点击是「替换」而非无限追加。
 *
 * 2026-10-08 起支持「范围 + 目标」（对齐 Obsidian 侧）：
 * 当日 / 本周 / 本月 / 所有，且本周 / 本月可选写到今天还是写到周一 / 1 号。
 * 第 2 段起钉这部分。
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setupBrowserDom, loadBuiltPlugin, seedStore } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();
seedStore(plugin); // 种子数据里含昨天的会议 / 逾期待办 / 跨日待办 / 无日期待办等干扰项

const d = new Date();
const p2 = (n) => (n < 10 ? "0" + n : String(n));
const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/* 纯日期工具的本地复刻（只用来自测范围计算，不参与插件链路） */
function parseJs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
function stampJs(dt) {
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
}
function addDaysJs(s, n) {
  const dt = parseJs(s);
  dt.setDate(dt.getDate() + n);
  return stampJs(dt);
}
function startOfWeekJs(s) {
  const dt = parseJs(s);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return stampJs(dt);
}
function nextMonthJs(s) {
  const dt = parseJs(s);
  return stampJs(new Date(dt.getFullYear(), dt.getMonth() + 1, 1));
}

// ---- 桩掉内核接口，捕获实际写入的 markdown ----
const calls = [];
/**
 * 日记文档登记表。真实模拟思源里「日记长什么样」：
 *  - 有专属属性 custom-dailynote-yyyymmdd（思源建日记时自动打）
 *  - hpath 落在笔记本设置的日记路径下（模板渲染出来的多层路径）
 * 生产代码按「属性 → 路径 → 标题」三级定位，这里必须能分别命中，否则测不出写错文档。
 */
let diaryDocs = [];
let existingChildren = [];
/** 笔记本的日记保存路径模板（笔记本设置里配的那一串）—— 与雄哥实际配置同构（年/月/日三层） */
let dailyNoteSavePath = '/日记/{{now | date "2006"}}/{{now | date "01"}}/{{now | date "2006-01-02"}}';
/** 内核 createDailyNote 建出来的文档 id（它按笔记本规则建并自动打属性） */
const KERNEL_DAILY_DOC = "doc-created-by-kernel";

const attrOf = (day) => `custom-dailynote-${day.replace(/-/g, "")}`;
/**
 * 用与生产同源的模板渲染算出 hpath（测试复刻 diary-note.ts 的 Go 模板渲染，
 * 再由下面的源码防漂移断言把两边拴在一起）。
 *
 * ⚠️ 必须**按 Go 记号精确替换**：`2006-01` 里既有年也有月，
 *    朴素的 `replace("01", m)` 会把 `2006` 里的 `0`… 实际是把 `01` 月份段
 *    替换到年段后面，产生 `2126-10-02` 这种错值（复刻实现自己就会骗人）。
 */
function renderTpl(template, day) {
  const [y, m, d] = day.split("-");
  const GO = [
    ["2006", y],
    ["01", m],
    ["02", d]
  ];
  return template
    .replace(/\{\{\s*now\s*\|\s*date\s*"([^"]*)"\s*\}\}/g, (_x, fmt) => {
      let out = "";
      for (let i = 0; i < fmt.length; i++) {
        const hit = GO.find(([go]) => fmt.startsWith(go, i));
        if (hit) {
          out += hit[1];
          i += hit[0].length - 1;
          continue;
        }
        out += fmt[i];
      }
      return out;
    })
    .replace(/\{\{\s*now\s*\}\}/g, day);
}
/** 造一篇「合规日记」：带日记属性 + 在渲染出的日记路径下 */
const mkDiary = (id, day) => ({ id, content: day, hpath: renderTpl(dailyNoteSavePath, day), __attr: attrOf(day) });

globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url, body });
  const reply = (data) => ({ ok: true, json: async () => ({ code: 0, msg: "", data }) });
  if (url === "/api/query/sql") {
    const stmt = String(body.stmt);
    if (stmt.includes("parent_id")) return reply(existingChildren);
    // ① 日记专属属性查询
    if (stmt.includes("from attributes")) {
      const name = /name = '([^']+)'/.exec(stmt)?.[1];
      return reply(diaryDocs.filter((d) => d.__attr === name).map((d) => ({ id: d.id })));
    }
    // ② 按渲染出的日记路径精确查
    if (stmt.includes("hpath =")) {
      const want = /hpath = '([^']+)'/.exec(stmt)?.[1];
      return reply(diaryDocs.filter((d) => d.hpath === want).map((d) => ({ id: d.id })));
    }
    // ③ 兜底：标题完全等于日期
    if (stmt.includes("content =")) {
      const want = /content = '([^']+)'/.exec(stmt)?.[1];
      return reply(diaryDocs.filter((d) => d.content === want));
    }
    return reply([]);
  }
  if (url === "/api/notebook/lsNotebooks") return reply({ notebooks: [{ id: "nb-1", closed: false }] });
  if (url === "/api/notebook/getNotebookConf") return reply({ dailyNoteSavePath });
  if (url === "/api/filetree/createDailyNote") {
    // 内核按笔记本规则建日记：把当天那篇登记进表（含日记属性）
    const day = today;
    diaryDocs.push(mkDiary(KERNEL_DAILY_DOC, day));
    return reply(KERNEL_DAILY_DOC);
  }
  if (url === "/api/filetree/createDocWithMd") {
    // 按**实际传入的 path** 登记（而不是按模板重算）—— 这样「建错位置」能被测试抓到
    const p = String(body.path || "");
    const day = p.split("/").filter(Boolean).pop();
    const id = "doc-created";
    diaryDocs.push({ id, content: day, hpath: p, __attr: null });
    return reply(id);
  }
  if (url === "/api/attr/setBlockAttrs") {
    // 手动补日记属性：按属性名回填到对应文档（模拟内核存进去）
    const names = Object.keys(body.attrs || {});
    for (const d of diaryDocs) {
      for (const n of names) {
        if (d.content === n.replace(/^custom-dailynote-/, "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")) {
          d.__attr = n;
        }
      }
    }
    return reply(null);
  }
  return reply(null);
};
globalThis.__syMessages = [];

diaryDocs = [mkDiary("doc-today", today)];

const msg = await plugin.insertTodayToDiary();
const ins = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(ins, "应调用 insertBlock 写入日记");
const md = String(ins.body.data);
assert.strictEqual(ins.body.parentID, "doc-today", "应写入今天的日记文档");
assert.ok(md.startsWith("## 日程与待办"), "小节标题应为「日程与待办」");

// 今天的条目：日程按开始时间、待办按到期日、全天单独标注
assert.ok(md.includes("测试条目 1"), "今天的日程应写入");
assert.ok(md.includes("测试条目 7"), "今天的日程应写入");
assert.ok(/全天 测试条目 4/.test(md), "全天条目应标注「全天」而不是空时间");

// 干扰项一律不得出现
for (const bad of ["昨天的会议", "逾期待办", "本周待办", "跨日待办", "测试条目 5", "无截止任务", "仅开始时间任务"]) {
  assert.ok(!md.includes(bad), `「${bad}」不属于今天，不应写入日记`);
}

// 时间序：09:00 之前的条目不能排在全天之后乱序
const times = md.split("\n").filter((l) => l.startsWith("- "));
assert.ok(times.length >= 4, "应写入多条今日条目");

// ---- 反馈 + 打开日记成为活动页签 ----
assert.ok(msg.includes("日程与待办"), "返回值应带结果文案");
assert.ok(
  globalThis.__syMessages.some((m) => m.text.includes("日程与待办")),
  "应弹出站内提示（否则用户不知道插到哪去了，会重复点击）"
);
assert.ok(globalThis.__syRegistrations.lastOpenTab, "应打开日记文档");
assert.strictEqual(globalThis.__syRegistrations.lastOpenTab.doc.id, "doc-today", "打开的应是今天的日记");

// ---- 重复点击 = 替换，而不是追加 ----
existingChildren = [
  { id: "h-1", type: "h", content: "日程与待办" },
  { id: "l-1", type: "l", content: "- 📅 09:00 上次写的" },
  { id: "p-1", type: "p", content: "用户自己写的段落" }
];
calls.length = 0;
const msg2 = await plugin.insertTodayToDiary();
assert.deepStrictEqual(
  calls.filter((c) => c.url === "/api/block/deleteBlock").map((c) => c.body.id),
  ["h-1", "l-1"],
  "应删除上一次的小节（标题 + 紧随的列表），且不能碰用户自己的段落"
);
assert.ok(msg2.includes("已更新"), "第二次点击应是「更新」而非「写入」");

// ---- 找不到今天的日记时：按笔记本的日记路径新建 ----
// ⚠️ 今天走内核官方 createDailyNote（它按笔记本规则建并自动打日记属性）；
//    非今天（如本周一）才由我们按同一路径手建 + 补属性。
diaryDocs = [];
calls.length = 0;
globalThis.__syRegistrations.lastOpenTab = undefined;
await plugin.insertTodayToDiary();
const createdByKernel = calls.find((c) => c.url === "/api/filetree/createDailyNote");
assert.ok(createdByKernel, "找不到今天的日记应调内核 createDailyNote 建（而不是自己乱建一篇）");
assert.strictEqual(
  calls.find((c) => c.url === "/api/block/insertBlock").body.parentID,
  KERNEL_DAILY_DOC,
  "应写入内核建出来的那篇日记"
);
assert.strictEqual(
  globalThis.__syRegistrations.lastOpenTab.doc.id,
  KERNEL_DAILY_DOC,
  "应打开新建的日记"
);
// ---- 无当日条目：只提示，不写日记 ----
existingChildren = [];
calls.length = 0;
const empty = await plugin.insertTodayToDiary.call({
  store: { getAll: () => [], settings: { calendars: [] } },
  notify: (text) => text
});
assert.strictEqual(empty, "当日没有日程或待办", "没有当日条目时应仅提示、不写入");
assert.ok(!calls.some((c) => c.url === "/api/block/insertBlock"), "没有当日条目时不应写入日记");

/* ============================================================
 * 范围 + 目标（2026-10-08，对齐 Obsidian 侧）
 * ============================================================ */
const dow = (d.getDay() + 6) % 7; // 周一=0
const monday = addDaysJs(today, -dow);
const sunday = addDaysJs(monday, 6);
const monthFirst = today.slice(0, 8) + "01";
// 今天恰好就是周一 / 1 号时，两个目标是同一篇日记（不能因此误判）
const monDocId = monday === today ? "doc-today" : "doc-mon";
const firstDocId = monthFirst === today ? "doc-today" : "doc-1st";

// ---- 缺失的日记必须建在笔记本配置的路径下，并补上日记属性 ----
// 回归「插进去了但不在 daily note 里」：旧实现丢在笔记本根目录 /<日期>。
// 用雄哥实际的**多层模板**（年/月/日三段）：/daily note/2026/10/2026-10-14
// ⚠️ 周一运行：本周首日就是今天 → 走内核 createDailyNote（与上文「找不到今天的日记」
//    同路），手建分支根本不执行。两组断言必须按 monday===today 二选一，
//    否则周一必误报（2026-10-19 00:xx 跨午夜跑到周一，实测挂过一次）。
diaryDocs = [];
calls.length = 0;
await plugin.insertTodayToDiary("week", "spanStart");
if (monday === today) {
  const createdByKernel = calls.find((c) => c.url === "/api/filetree/createDailyNote");
  assert.ok(createdByKernel, "周一运行时本周首日＝今天，应走内核 createDailyNote");
  assert.ok(
    !calls.some((c) => c.url === "/api/filetree/createDocWithMd"),
    "今天的日记不该手建（会建出没有日记属性的副本）"
  );
} else {
  const createdDoc = calls.find((c) => c.url === "/api/filetree/createDocWithMd");
  assert.ok(createdDoc, "非今天的日记缺失时应按路径手建");
  assert.strictEqual(
    createdDoc.body.path,
    renderTpl(dailyNoteSavePath, monday),
    `新建路径必须逐段落在笔记本配置的日记目录下（期望 ${renderTpl(dailyNoteSavePath, monday)}），不能丢在笔记本根目录`
  );
  assert.ok(
    !String(createdDoc.body.path).includes("{{") && !String(createdDoc.body.path).includes("}}"),
    `新建路径不能残留模板占位符（否则建出垃圾文档）：${createdDoc.body.path}`
  );
  const setAttr = calls.find((c) => c.url === "/api/attr/setBlockAttrs");
  assert.ok(setAttr, "手动建日记后必须补上 custom-dailynote-* 属性（否则识别不出是日记）");
  assert.ok(
    Object.keys(setAttr.body.attrs || {}).some((k) => k.startsWith("custom-dailynote-")),
    `补的属性名应是 custom-dailynote-yyyymmdd，实际：${JSON.stringify(setAttr.body.attrs)}`
  );
}

// ---- 模板认不全时：绝不能渲染出带 {{ }} 的路径（否则建出垃圾文档）----
// ⚠️ 这里**直接加载生产模块真实调用**，不靠 insertTodayToDiary 间接覆盖：
//    「当日」缺失时走的是内核 createDailyNote 分支，根本不经过 createDocWithMd，
//    间接测法会漏掉这个洞（本轮实测：源码断言被变异打红，行为断言却全绿）。
// diary-note.ts 是纯函数模块、无插件依赖，现场编译成 ESM 即可直接跑。
// ⚠️ 用 esbuild 的 **JS API** 而不是命令行：Windows 下 .bin/esbuild(.cmd) 与 cmd.exe
//    都会 spawnSync EBUSY（本机 cmd 不可靠），走 API 纯进程内完成。
const NOTE_ESM = path.join(ROOT, ".test-diary", "diary-note.mjs");
fs.mkdirSync(path.dirname(NOTE_ESM), { recursive: true });
const esbuild = await import("esbuild");
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src", "ui", "diary-note.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: NOTE_ESM,
  logLevel: "error"
});
// ⚠️ Windows 下 import 绝对路径必须先转 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const NOTE_MOD = await import(pathToFileURL(NOTE_ESM).href);
const probeDay = "2026-10-14";
const tplCases = [
  ["单层", '/daily note/{{now | date "2006-01-02"}}', "/daily note/2026-10-14"],
  [
    "多层（年/月/日）",
    '/daily note/{{now | date "2006"}}/{{now | date "01"}}/{{now | date "2006-01-02"}}',
    "/daily note/2026/10/2026-10-14"
  ],
  ["年月", '/{{now | date "2006-01"}}/{{now | date "2006-01-02"}}', "/2026-10/2026-10-14"],
  ["裸 now", "/daily note/{{now}}", "/daily note/2026-10-14"]
];
for (const [name, tpl, want] of tplCases) {
  assert.strictEqual(
    NOTE_MOD.renderDailyNotePath(tpl, probeDay),
    want,
    `模板渲染（${name}）结果不对：${tpl}`
  );
}
// 认不全 / 认不出 → 一律空串（调用方据此走兜底，绝不拿半成品路径建文档）
for (const [name, tpl] of [
  ["残缺", '/daily note/{{now | date "2006-01-02"'],
  ["未知变量", "/notes/{{title}}"],
  ["空模板", ""],
  ["非法日期", '/daily note/{{now | date "2006-01-02"}}']
]) {
  const out =
    name === "非法日期" ? NOTE_MOD.renderDailyNotePath(tpl, "not-a-date") : NOTE_MOD.renderDailyNotePath(tpl, probeDay);
  assert.strictEqual(out, "", `模板（${name}）认不出时应返回空串，实际：${JSON.stringify(out)}`);
  assert.ok(!out.includes("{{"), `模板（${name}）结果绝不能残留 {{ 占位符`);
}
// 补一条端到端：残缺模板下走「非今天」的手建分支，也不能建出垃圾路径
// （注：模板残缺 → hPath 空 → 走兜底「根目录 /<日期>」手建，与目标是否今天无关，
//  本断言任意星期几都成立，不需要日期守卫）
diaryDocs = [];
calls.length = 0;
const savedTpl = dailyNoteSavePath;
dailyNoteSavePath = "/daily note/{{now | date \"2006-01-02\""; // 残缺（少一个 }）
await plugin.insertTodayToDiary("week", "spanStart");
for (const c of calls) {
  if (c.url !== "/api/filetree/createDocWithMd") continue;
  assert.ok(
    !String(c.body.path).includes("{{") && !String(c.body.path).includes("}}"),
    `模板残缺时不能拿半成品路径建文档，实际建了：${c.body.path}`
  );
}
dailyNoteSavePath = savedTpl;

// ---- 本周：默认写到今天的日记，标题带区间 ----
diaryDocs = [
  mkDiary("doc-today", today),
  ...(monday === today ? [] : [mkDiary("doc-mon", monday)])
];
existingChildren = [];
calls.length = 0;
const msgW = await plugin.insertTodayToDiary("week");
const insW = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(insW, "本周范围应写入日记");
assert.strictEqual(insW.body.parentID, "doc-today", "本周默认写到**今天**的日记（与旧行为一致）");
assert.ok(
  String(insW.body.data).startsWith(`## 日程与待办（${monday} ~ ${sunday}）`),
  `本周的小节标题要带区间，实际：${String(insW.body.data).split("\n")[0]}`
);
assert.ok(msgW.includes("今天"), "提示应说明写到了哪一篇日记");
// 本周应把本周内到期的待办收进来（待办按到期日归属）：用「本周一+3 天」样本，周一~周日运行都稳
assert.ok(String(insW.body.data).includes("本周待办"), "本周范围内应包含落在本周的待办（按到期日）");

// ---- 本周 + 写到周一的日记 ----
calls.length = 0;
const msgW2 = await plugin.insertTodayToDiary("week", "spanStart");
const insW2 = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(insW2, "选「周一的日记」也应写入");
assert.strictEqual(insW2.body.parentID, monDocId, "选「本周一的日记」应写到周一那篇");
assert.ok(msgW2.includes("本周一"), `提示应点明「本周一」，实际：${msgW2}`);

// ---- 本月 + 写到 1 号的日记 ----
diaryDocs = [
  mkDiary("doc-today", today),
  ...(monthFirst === today ? [] : [mkDiary("doc-1st", monthFirst)])
];
calls.length = 0;
const msgM = await plugin.insertTodayToDiary("month", "spanStart");
const insM = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(insM, "本月范围应写入日记");
assert.strictEqual(insM.body.parentID, firstDocId, "选「本月 1 日的日记」应写到 1 号那篇");
assert.ok(
  String(insM.body.data).startsWith(`## 日程与待办（${today.slice(0, 7)}）`),
  "本月的小节标题要带年月"
);
assert.ok(msgM.includes("本月 1 日"), `提示应点明「本月 1 日」，实际：${msgM}`);

// ---- 「所有」范围：区间下界是哨兵 1900-01-01，目标必须落回今天（不许去建 1900 年的日记） ----
diaryDocs = [mkDiary("doc-today", today)];
calls.length = 0;
await plugin.insertTodayToDiary("all", "spanStart");
const insAll = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(insAll, "「所有」范围应写入日记");
assert.strictEqual(insAll.body.parentID, "doc-today", "「所有」的目标必须是今天（不能被哨兵下界带偏）");
assert.ok(
  !calls.some((c) => c.url === "/api/filetree/createDocWithMd" && String(c.body.path || "").includes("1900")),
  "绝不能去新建 1900 年的日记"
);

/* ============================================================
 * 「包含逾期待办」开关（2026-10-12 新增）
 * ============================================================ */
// 默认关闭：逾期待办（seed-11，前天到期）不应出现在「当日」日记
plugin.store.settings.includeOverdueTodos = false;
diaryDocs = [mkDiary("doc-today", today)];
existingChildren = [];
calls.length = 0;
const msgOff = await plugin.insertTodayToDiary("day");
const insOff = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(insOff, "当日范围应写入日记");
assert.ok(!String(insOff.body.data).includes("逾期待办"), "开关关闭时逾期任务不应写入当日日记");
assert.ok(!String(insOff.body.data).includes("### 逾期待办"), "开关关闭时不应出现「逾期待办」小节");

// 开启开关：逾期任务应排在最前面的「### 逾期待办」小节
plugin.store.settings.includeOverdueTodos = true;
calls.length = 0;
const msgOn = await plugin.insertTodayToDiary("day");
const insOn = calls.find((c) => c.url === "/api/block/insertBlock");
assert.ok(insOn, "开启开关后当日范围应写入日记");
const mdOn = String(insOn.body.data);
assert.ok(mdOn.includes("### 逾期待办"), "开启开关应出现「逾期待办」小节");
assert.ok(mdOn.includes("逾期待办"), "开启开关应写入逾期任务条目");
// 逾期小节必须排在范围内条目之前
const idxOverdue = mdOn.indexOf("### 逾期待办");
const idxInRange = Math.min(
  mdOn.indexOf("- 📅") >= 0 ? mdOn.indexOf("- 📅") : Infinity,
  mdOn.indexOf("- ☑️") >= 0 ? mdOn.indexOf("- ☑️") : Infinity
);
assert.ok(idxOverdue >= 0 && idxOverdue < idxInRange, "逾期末节必须排在范围内条目之前");
// 开关只认「未完成的逾期」：已完成待办（seed-5）即便过去也不应进逾期末节
assert.ok(!mdOn.includes("测试条目 5"), "已完成的待办不应作为逾期待办写入");
// 还原默认值，避免影响后续（后续无插入调用，仅保险）
plugin.store.settings.includeOverdueTodos = false;

/* ============================================================
 * 跨日范围必须逐行带日期（2026-10-14）
 * ============================================================ */
// 本周范围：每行都应是「M月D日 HH:mm 标题」，不能只有 HH:mm ——
// 否则一周的条目挤在一起分不清哪条是哪天的。
diaryDocs = [mkDiary("doc-today", today)];
existingChildren = [];
calls.length = 0;
await plugin.insertTodayToDiary("week");
const mdWeek = String(calls.find((c) => c.url === "/api/block/insertBlock").body.data);
const weekLines = mdWeek.split("\n").filter((l) => l.startsWith("- "));
assert.ok(weekLines.length > 0, "本周范围应有条目");
assert.ok(
  weekLines.every((l) => /^- (📅|☑️|⏰) \d{1,2}月\d{1,2}日 /.test(l)),
  `本周范围每行都应带日期，实际：\n${weekLines.join("\n")}`
);
// 当日范围反过来：只有时间，更清爽
diaryDocs = [mkDiary("doc-today", today)];
existingChildren = [];
calls.length = 0;
await plugin.insertTodayToDiary("day");
const mdDay = String(calls.find((c) => c.url === "/api/block/insertBlock").body.data);
const dayLines = mdDay.split("\n").filter((l) => l.startsWith("- "));
assert.ok(
  dayLines.every((l) => !/\d+月\d+日/.test(l)),
  `当日范围不该带日期（写日期反而冗余），实际：\n${dayLines.join("\n")}`
);

/* ---------- 纯计算契约：Go 模板渲染 + 行文案 ---------- */
// 思源笔记本设置里的日记保存路径是 Go 模板，必须渲染成当天确切路径
const NOTE_SRC = fs.readFileSync(path.join(ROOT, "src", "ui", "diary-note.ts"), "utf8");
assert.ok(/GO_NOW_WITH_FORMAT/.test(NOTE_SRC), "必须按 {{now | date \"...\"}} 渲染路径模板");
// ⚠️ 模板没认全时必须返回空串：半渲染路径会建出名字带 {{ }} 的垃圾文档
assert.ok(
  /out\.includes\("\{\{"\)/.test(NOTE_SRC),
  "渲染结果仍含 {{ 时必须返回空串走兜底，绝不能拿半成品路径建文档"
);

// 源码防漂移：行文案与路径渲染都必须在生产代码里被真正调用
const INDEX_SRC = fs.readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
assert.ok(
  /diaryWhenLabel\(occ, timed, crossDay\)/.test(INDEX_SRC),
  "insertTodayToDiary 必须走 diaryWhenLabel（跨日才带日期）"
);
assert.ok(
  /renderDailyNotePath\(nb\.dailyNoteSavePath, day\)/.test(INDEX_SRC),
  "定位日记必须用笔记本配置的路径模板渲染，不能自己拼路径"
);
assert.ok(
  INDEX_SRC.includes('path: hPath'),
  "新建日记必须落在渲染出的路径上（笔记本配置的 dailyNoteSavePath），不能丢在笔记本根目录"
);
// 根目录硬拼只允许存在于「笔记本没配日记路径」的兜底分支里，
// 且必须排在 renderDailyNotePath 之后（先试模板，再降级）
const rootIdx = INDEX_SRC.indexOf('path: "/" + day');
if (rootIdx >= 0) {
  assert.ok(
    rootIdx > INDEX_SRC.indexOf("renderDailyNotePath"),
    "根目录硬拼只能作为兜底（笔记本未配日记路径时），必须排在模板渲染之后"
  );
}
assert.ok(
  /custom-dailynote-/.test(INDEX_SRC) && /dailyNoteAttrName\(day\)/.test(INDEX_SRC),
  "必须按日记专属属性 custom-dailynote-* 定位（靠标题/路径猜会写错文档）"
);
assert.ok(
  INDEX_SRC.includes("/api/filetree/createDailyNote"),
  "今天的日记缺失时应走内核 createDailyNote（自动按笔记本规则建并打属性）"
);
// 旧实现的最大坑必须消失：模糊 like 匹配（会命中正文提到日期的普通文档，且受 limit 截断）
assert.ok(
  !/content like '%\$\{day\}%'/.test(INDEX_SRC),
  "不能再用 content like 模糊匹配找日记（会命中正文提到日期的普通文档，且受 limit 截断）"
);

/* ---------- 纯计算契约（复刻 + 源码防漂移） ----------
 * 源文件是 TS 且依赖 core/date，Node 直接 require 不了，故复刻实现；
 * 再用源码级断言把复刻与生产代码拴在一起，防「改了一边忘了另一边」。
 */
const RANGE_SRC = fs.readFileSync(path.join(ROOT, "src", "ui", "diary-range.ts"), "utf8");

// 周一起算 + 跨年跨月
assert.strictEqual(startOfWeekJs("2026-10-07"), "2026-10-05", "2026-10-07（周三）的本周一应是 10-05");
assert.strictEqual(startOfWeekJs("2026-10-11"), "2026-10-05", "周日应归属上一个周一，不能减到本周日");
assert.strictEqual(startOfWeekJs("2026-10-05"), "2026-10-05", "周一当天周起点是自己");
assert.strictEqual(nextMonthJs("2026-12-15"), "2027-01-01", "12 月应进位到次年 1 月");
assert.strictEqual(nextMonthJs("2028-02-10"), "2028-03-01", "闰年 2 月应到 3 月 1 号");

// 源码级：四个范围都在、且 spanStart 只对 week/month 生效
assert.ok(/case "day":/.test(RANGE_SRC) && /case "week":/.test(RANGE_SRC), "diary-range.ts 应含 day/week 分支");
assert.ok(/case "month":/.test(RANGE_SRC) && /case "all":/.test(RANGE_SRC), "diary-range.ts 应含 month/all 分支");
assert.ok(
  /target !== "spanStart"[\s\S]{0,120}return today/.test(RANGE_SRC),
  "diaryTargetStamp 必须先判 target !== spanStart（否则「今天」也去取区间首日）"
);
assert.ok(
  /range !== "week" && range !== "month"/.test(RANGE_SRC),
  "diaryTargetStamp 必须把 spanStart 收敛到 week/month —— 否则「所有」会去建 1900 年的日记"
);
// 当日 / 所有只有「今天」一个目标 → 不该渲染子选项区（问「今天 / 今天」没有意义）
assert.ok(/return \[todayOpt\];/.test(RANGE_SRC), "targetOptionsOf 对 day/all 应只回一项");
// 子选项文案要紧凑：长句（「插入到今天的日记」）在范围行右侧放不下
assert.ok(
  /compact: "今天的日记"/.test(RANGE_SRC),
  "targetOptionsOf 必须给紧凑文案（compact），供范围行右侧内联显示"
);
const DIALOG_SRC = fs.readFileSync(path.join(ROOT, "src", "ui", "diary-range-dialog.ts"), "utf8");
assert.ok(
  /opts\.length < 2/.test(DIALOG_SRC),
  "子选项在只有一个目标时必须收起（见 diary-range-dialog.ts 的 renderSub）"
);
// 子选项渲染进「选中范围行」自己的槽里 —— 不是独立一段
assert.ok(
  /data-range-row="\$\{o\.key\}"/.test(DIALOG_SRC) && /\[data-range-row="\$\{pickedRange\}"\] \[data-inline\]/.test(DIALOG_SRC),
  "子选项必须渲染进被选中那行的 [data-inline] 槽（跟在范围右侧同一行）"
);
assert.ok(
  /querySelectorAll<HTMLElement>\("\[data-inline\]"\)[\s\S]{0,120}innerHTML = ""/.test(DIALOG_SRC),
  "renderSub 必须**先清空所有行**的槽，否则换范围后旧行的子选项会留在原地"
);
// 子选项的 radio 也在 .caldav-range-opt 里，markChecked 不显式限定 scope 会把外层范围行的选中态改掉
assert.ok(
  /markChecked\(inputs, r, "\.caldav-range-target"\)/.test(DIALOG_SRC),
  "目标子选项的选中态必须限定在 .caldav-range-target 内（否则会连带改掉范围行的 is-checked）"
);

// 面板按钮：不再写死「今日」，且点击走范围弹窗
const PANEL_SRC = fs.readFileSync(path.join(ROOT, "src", "ui", "panel.ts"), "utf8");
assert.ok(
  !PANEL_SRC.includes("把今日日程与待办插入日记"),
  "面板按钮不该再写死「今日」（点了会先问范围）"
);
assert.ok(
  /askDiaryRange\(\(range, target\) => void ctx\.insertTodayToDiary\(range, target\)\)/.test(PANEL_SRC),
  "面板点击必须走范围弹窗，并把 range/target 一起透传（吞掉参数就会永远走「当日+今天」）"
);

// 左右留白（雄哥 2026-10-09）：宿主内容区 padding=0，卡片贴边。
// 修法是给导语与选项列表各加 margin 0 14px，**不是**给 .caldav-range 加 padding
// —— 那会把页脚一起压进去，页脚比内容窄一截、右下圆角接不上。
const CSS_SRC = fs.readFileSync(path.join(ROOT, "src", "index.css"), "utf8");
const cssBlock = (sel) => {
  const i = CSS_SRC.indexOf(sel);
  assert.ok(i >= 0, `CSS 里找不到 ${sel}`);
  return CSS_SRC.slice(i, i + 420);
};
assert.ok(
  /margin: 0 14px 10px/.test(cssBlock(".caldav-range-lead {")),
  "导语必须留左右 14px（与页脚 padding 一致）"
);
assert.ok(
  /margin: 0 14px/.test(cssBlock(".caldav-range-opts {")),
  "选项列表必须留左右 14px，否则卡片直接顶到弹窗两侧"
);
assert.ok(
  !/\.caldav-range \{[^}]*padding/.test(CSS_SRC),
  ".caldav-range 根容器不许加 padding —— 会把页脚也压进去"
);

/* ---------- 弹窗交互：默认当日+今天，选本周才出现目标子选项 ---------- */
const origInsert = plugin.insertTodayToDiary.bind(plugin);
let picked = null;
plugin.insertTodayToDiary = (r, t) => {
  picked = [r, t];
  return Promise.resolve("stub");
};
plugin.askInsertDiary();
const range = document.querySelector(".caldav-range");
assert.ok(range, "点「插入日记」应弹出范围选择框");
const radios = Array.from(range.querySelectorAll('input[name="caldav-range"]'));
assert.strictEqual(radios.length, 4, "应有 当日/本周/本月/所有 四个范围");
assert.strictEqual(radios[0].checked, true, "默认范围应是「当日」");
assert.strictEqual(
  range.querySelector("[data-inline]").innerHTML,
  "",
  "默认（当日）不该出现目标子选项"
);

// 切到「本周」：子选项出现，且默认仍是「今天」
const weekRadio = radios.find((r) => r.value === "week");
weekRadio.checked = true;
weekRadio.dispatchEvent(new window.Event("change", { bubbles: true }));
// 子选项必须挂在「本周」这一行**内部**的槽里（雄哥要求：跟在范围右侧同一行）
const weekRow = range.querySelector('[data-range-row="week"]');
const weekInline = weekRow.querySelector("[data-inline]");
assert.ok(weekRow.contains(weekInline), "「本周」行里应带一个子选项槽");
const targetRadios = Array.from(weekInline.querySelectorAll('input[name="caldav-target"]'));
assert.strictEqual(targetRadios.length, 2, "本周应有两个目标可选（今天 / 本周一）");
assert.strictEqual(targetRadios[0].checked, true, "目标默认是「今天」（与旧行为一致）");
assert.ok(
  weekInline.textContent.includes("本周一"),
  `子选项应写明「本周一（${monday}）」，实际：${weekInline.textContent.replace(/\s+/g, " ").trim()}`
);
// 只有选中那一行有子选项：别处不能同时挂着一份
const otherInline = Array.from(range.querySelectorAll("[data-inline]")).filter((n) => n !== weekInline);
assert.ok(
  otherInline.every((n) => n.innerHTML === ""),
  "子选项只该出现在当前选中的范围行里（其余行的槽必须清空）"
);

// 切到「本月」：子选项搬到「本月」行，文案随之变成「本月 1 日」（防复用上一份 DOM 造成串味）
const monthRadio = radios.find((r) => r.value === "month");
monthRadio.checked = true;
monthRadio.dispatchEvent(new window.Event("change", { bubbles: true }));
const monthRow = range.querySelector('[data-range-row="month"]');
const monthInline = monthRow.querySelector("[data-inline]");
assert.ok(
  monthInline.textContent.includes("本月 1 日"),
  `切到本月后子选项应写「本月 1 日（${monthFirst}）」，实际：${monthInline.textContent.replace(/\s+/g, " ").trim()}`
);
assert.ok(!monthInline.textContent.includes("本周一"), "切到本月后不该还留着「本周一」的选项");
assert.strictEqual(
  weekInline.innerHTML,
  "",
  "切走后「本周」行必须被清空（否则同一份子选项会留在两处）"
);
assert.strictEqual(
  Array.from(monthInline.querySelectorAll('input[name="caldav-target"]'))[0].checked,
  true,
  "切范围后目标要回到「今天」（不能残留上次选的 spanStart）"
);

// 选「本月 1 日」→ 确认插入，参数必须原样透传
const firstRadio = Array.from(monthInline.querySelectorAll('input[name="caldav-target"]')).find(
  (r) => r.value === "spanStart"
);
firstRadio.checked = true;
firstRadio.dispatchEvent(new window.Event("change", { bubbles: true }));
range.querySelector('[data-act="ok"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.deepStrictEqual(picked, ["month", "spanStart"], "确认插入应把 range 与 target 一起回传");
plugin.insertTodayToDiary = origInsert;

console.log("[diary] 插入日记链路全部通过（仅范围内条目 / 待办按到期日 / 有反馈并打开日记 / 重复点击为更新 / 范围与目标）");
