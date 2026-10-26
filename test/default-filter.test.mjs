/**
 * 两处筛选下拉的「默认值」可自定义 · 单测（2026-10-26 建立，2026-10-27 改造）
 *
 * 背景：左侧 Dock 默认写死「未来七天」、任务视图默认写死「所有未完成」，
 * 雄哥要求可改；设置里新增两项，默认「上次使用项」，
 * 并追加：无「上次使用项」记录时，Dock 的初始值也由「未来七天」改为「所有未完成」。
 *
 * ## 2026-10-27 重要修正：「上次使用项」的存储从 localStorage 改到配置
 *
 * 原实现把「上次用的筛选」记在 localStorage，结果永远记不住。实锤：
 * 思源每次启动的**内核端口是随机的**（实测 9905 / 11038 / 4008 / 8351 …），
 * 而 localStorage 按 origin —— **含端口** —— 隔离。记录写进去了（Electron 的
 * leveldb 里能看到一串不同端口下的记录），但下次启动是另一个 origin，一条也读不回来。
 * 表现就是「上次使用项」永远回落到默认值。
 *
 * 故按雄哥要求改存**配置**（`settings.lastDockFilter` / `lastTaskFilter` / `lastView` /
 * `lastCalendarView`），跟着 data.json 一起同步到其他设备。
 * 下面的用例因此全部改为「传 settings 对象」而不是「桩 localStorage」。
 *
 * 覆盖：
 *   ① DEFAULT_SETTINGS 两项默认都是 "last"
 *   ② 无记录时回落：Dock = undone / 任务视图 = allincomplete
 *   ③ 写了「上次使用项」后能读回（往返）
 *   ④ 设置固定成某一项时，忽略「上次使用项」直接用它
 *   ⑤ 脏数据 / 非法设置值视为无记录，不把面板卡死
 *   ⑥ 配置从别台设备同步过来时，记录照样读得回（本条即本次修复的核心）
 *   ⑦ 选项表与两个下拉同源（防加项时两边漂移）
 *   ⑧ 源码级护栏：UI 偏好的读写**不许再碰浏览器存储**（localStorage/IndexedDB 按
 *      origin 隔离，在随机端口的思源里等于每次都丢）
 *   ⑨ 接线：下拉选中时写进 settings 并触发落盘
 *
 * 用法：node test/default-filter.test.mjs
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import assert from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, ".test-deffilter");

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));

execSync(
  `npx tsc src/core/types.ts src/ui/filter-pref.ts ` +
    `--outDir ${outDir} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
// 两个源文件分属 src/core 与 src/ui，rootDir 算成 src，产物保留子目录
const prefPath = existsSync(join(outDir, "ui", "filter-pref.js"))
  ? join(outDir, "ui", "filter-pref.js")
  : join(outDir, "filter-pref.js");
const typesPath = existsSync(join(outDir, "core", "types.js"))
  ? join(outDir, "core", "types.js")
  : join(outDir, "types.js");
const P = require(prefPath);
const T = require(typesPath);

let pass = 0;
const failed = [];
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    failed.push(`${name}: ${e.message}`);
  }
}

const settings = (over) => Object.assign({}, T.DEFAULT_SETTINGS, over || {});

// ① 默认都是「上次使用项」
t('DEFAULT_SETTINGS 两项默认都是 "last"', () => {
  assert.strictEqual(T.DEFAULT_SETTINGS.defaultDockFilter, "last");
  assert.strictEqual(T.DEFAULT_SETTINGS.defaultTaskFilter, "last");
});

// ② 无记录回落（含雄哥要求的 Dock 由「未来七天」→「所有未完成」）
t("无记录：Dock 回落到 undone（所有未完成）", () => {
  assert.strictEqual(P.DEFAULT_DOCK_FILTER, "undone");
  assert.strictEqual(P.resolveDockFilter(settings()), "undone");
});
t("无记录：任务视图回落到 allincomplete（所有未完成）", () => {
  assert.strictEqual(P.DEFAULT_TASK_FILTER, "allincomplete");
  assert.strictEqual(P.resolveTaskFilter(settings()), "allincomplete");
});

// ③ 往返：save 写进 settings，load 读回，resolve 也用它
t("Dock：save 后能 load 回，resolve 也用它", () => {
  const s = settings();
  P.saveLastDockFilter(s, "thisweek");
  assert.strictEqual(P.loadLastDockFilter(s), "thisweek");
  assert.strictEqual(P.resolveDockFilter(s), "thisweek");
});
t("任务视图：save 后能 load 回，resolve 也用它", () => {
  const s = settings();
  P.saveLastTaskFilter(s, "overdue");
  assert.strictEqual(P.loadLastTaskFilter(s), "overdue");
  assert.strictEqual(P.resolveTaskFilter(s), "overdue");
});

// ④ 固定成某一项时忽略「上次使用项」
t("Dock 固定为 today 时，即使有上次记录也用 today", () => {
  const s = settings({ defaultDockFilter: "today", lastDockFilter: "thisweek" });
  assert.strictEqual(P.resolveDockFilter(s), "today");
});
t("任务视图固定为 doneall 时，即使有上次记录也用 doneall", () => {
  const s = settings({ defaultTaskFilter: "doneall", lastTaskFilter: "overdue" });
  assert.strictEqual(P.resolveTaskFilter(s), "doneall");
});

// ⑤ 脏数据 / 非法设置值
t("Dock 脏数据（不在合法集合内）视为无记录", () => {
  const s = settings({ lastDockFilter: "not-a-real-filter" });
  assert.strictEqual(P.loadLastDockFilter(s), null);
  assert.strictEqual(P.resolveDockFilter(s), "undone");
});
t("任务视图脏数据视为无记录", () => {
  const s = settings({ lastTaskFilter: "???" });
  assert.strictEqual(P.loadLastTaskFilter(s), null);
  assert.strictEqual(P.resolveTaskFilter(s), "allincomplete");
});
t("设置里存了非法筛选键时回落到默认值", () => {
  assert.strictEqual(P.resolveDockFilter(settings({ defaultDockFilter: "bogus" })), "undone");
  assert.strictEqual(P.resolveTaskFilter(settings({ defaultTaskFilter: "bogus" })), "allincomplete");
});

// ⑥ 本次修复的核心：配置从别台设备同步过来时，记录照样读得回
//
// 这正是 localStorage 做不到的地方 —— 它的记录锁在上一次启动时那个随机端口的
// origin 里，换设备/换端口都读不到。存配置则跟着 data.json 走。
t("配置里带着 lastDockFilter（同步自别的设备）时照样生效", () => {
  const s = settings({ lastDockFilter: "overdue" });
  assert.strictEqual(P.loadLastDockFilter(s), "overdue");
  assert.strictEqual(P.resolveDockFilter(s), "overdue");
});
t("配置里带着 lastTaskFilter 时照样生效", () => {
  const s = settings({ lastTaskFilter: "thisweek" });
  assert.strictEqual(P.resolveTaskFilter(s), "thisweek");
});

// ⑦ 选项表与两个下拉同源（防漂移）
t("Dock 选项表 12 项、任务视图 13 项，且都有文案", () => {
  assert.strictEqual(P.DOCK_FILTER_OPTIONS.length, 12);
  assert.strictEqual(P.TASK_FILTER_OPTIONS.length, 13);
  for (const o of P.DOCK_FILTER_OPTIONS) assert.ok(o.label, `Dock ${o.key} 缺文案`);
  for (const o of P.TASK_FILTER_OPTIONS) assert.ok(o.label, `Task ${o.key} 缺文案`);
});
{
  const srcPanel = readFileSync(join(root, "src/ui/panel.ts"), "utf8");
  const srcTask = readFileSync(join(root, "src/ui/view-task.ts"), "utf8");
  const srcSettings = readFileSync(join(root, "src/ui/settings-dialog.ts"), "utf8");
  t("panel.ts 的 Dock 下拉改用共享选项表（不再各写一份）", () => {
    assert.ok(/const DOCK_FILTERS = DOCK_FILTER_OPTIONS/.test(srcPanel));
    assert.ok(!/\{\s*key:\s*"next7",\s*label:\s*"未来七天"/.test(srcPanel), "panel.ts 不该再内联选项表");
  });
  t("view-task.ts 的文案走共享映射", () => {
    assert.ok(/TASK_FILTER_LABEL\./.test(srcTask));
    assert.ok(!/label:\s*"所有项目"/.test(srcTask), "view-task.ts 不该再内联文案");
  });
  t("设置页两项下拉的选项也取自共享表", () => {
    assert.ok(/DOCK_FILTER_OPTIONS\.map/.test(srcSettings));
    assert.ok(/TASK_FILTER_OPTIONS\.map/.test(srcSettings));
  });
}

// ⑧ 源码级护栏：UI 偏好不许再碰浏览器存储
//
// 思源每次启动端口随机，localStorage / IndexedDB / cookie 都按 origin（含端口）
// 隔离 —— 写进去的记录下次永远读不回来。谁再改回去就会复现「记不住」。
{
  const prefSrc = readFileSync(join(root, "src/ui/filter-pref.ts"), "utf8");
  const viewSrc = readFileSync(join(root, "src/ui/view-pref.ts"), "utf8");
  // 先剥掉注释再查 —— 否则「为什么不用 localStorage」的说明性注释会被误判成违规。
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const BROWSER_STORE = /localStorage|indexedDB/i;
  t("filter-pref.ts 不使用浏览器存储", () => {
    assert.ok(!BROWSER_STORE.test(stripComments(prefSrc)), "filter-pref 不该再碰 localStorage/IndexedDB");
  });
  t("view-pref.ts 不使用浏览器存储", () => {
    assert.ok(!BROWSER_STORE.test(stripComments(viewSrc)), "view-pref 不该再碰 localStorage/IndexedDB");
  });
  t("UI 偏好的记录字段在 CalSettings 里（随配置同步）", () => {
    const src = readFileSync(join(root, "src/core/types.ts"), "utf8");
    for (const f of ["lastDockFilter", "lastTaskFilter", "lastView", "lastCalendarView"]) {
      assert.ok(new RegExp(`${f}\\?:`).test(src), `CalSettings 缺 ${f}`);
    }
  });
  t("store 落盘带上 settings（记录才跟着走）", () => {
    const src = readFileSync(join(root, "src/core/store.ts"), "utf8");
    assert.ok(/settings: \{ \.\.\.this\.settings/.test(src));
    assert.ok(/markSettingsDirty/.test(src), "改了 settings 要有落盘入口");
  });
}

// ⑨ 接线：选中时写进 settings 并触发落盘
t("Dock 选中某项时写进 settings 并排期落盘", () => {
  const src = readFileSync(join(root, "src/ui/panel.ts"), "utf8");
  assert.ok(/saveLastDockFilter\(opts\.store\.settings, dockFilter\)/.test(src));
  assert.ok(/opts\.store\.markSettingsDirty\(\)/.test(src), "只改内存不落盘等于没记住");
});
t("任务视图切筛选时写进 settings 并排期落盘", () => {
  const src = readFileSync(join(root, "src/ui/view-task.ts"), "utf8");
  assert.ok(/saveLastTaskFilter\(ctx\.store\.settings, val\)/.test(src));
  assert.ok(/ctx\.store\.markSettingsDirty\(\)/.test(src));
});
t("Dock 初始化走设置解析（不再写死 next7）", () => {
  const src = readFileSync(join(root, "src/ui/panel.ts"), "utf8");
  assert.ok(/resolveDockFilter\(opts\.store\.settings\)/.test(src));
  assert.ok(!/let dockFilter: DockFilter = "next7"/.test(src), "不该再写死 next7");
});

if (failed.length) {
  console.error(`\n✗ default-filter ${failed.length} 项失败：`);
  for (const f of failed) console.error("  - " + f);
  process.exit(1);
} else {
  console.log(`\n✓ default-filter ${pass} 项通过`);
  process.exit(0);
}
