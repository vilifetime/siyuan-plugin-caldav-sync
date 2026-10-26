/**
 * 两处筛选下拉的「默认值」可自定义 · 单测（2026-10-26）
 *
 * 背景：左侧 Dock 默认写死「未来七天」、任务视图默认写死「所有未完成」，
 * 雄哥要求可改；设置里新增两项，默认「上次使用项」（本机 localStorage 记住），
 * 并追加：无「上次使用项」记录时，Dock 的初始值也由「未来七天」改为「所有未完成」。
 *
 * 覆盖：
 *   ① DEFAULT_SETTINGS 两项默认都是 "last"
 *   ② 无记录时回落：Dock = undone / 任务视图 = allincomplete
 *   ③ 写了「上次使用项」后能读回（往返）
 *   ④ 设置固定成某一项时，忽略「上次使用项」直接用它
 *   ⑤ 脏数据 / 非法设置值视为无记录，不把面板卡死
 *   ⑥ localStorage 抛异常或不存在时降级，不崩
 *   ⑦ 选项表与两个下拉同源（防加项时两边漂移）
 *   ⑧ 下拉被选中时确实写进了 localStorage；Dock 初始化走设置解析
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

/** 极简 localStorage 桩；throwOnAccess=true 用来验降级 */
function makeStorage(throwOnAccess = false) {
  const m = new Map();
  return {
    getItem(k) {
      if (throwOnAccess) throw new Error("localStorage denied");
      return m.has(k) ? m.get(k) : null;
    },
    setItem(k, v) {
      if (throwOnAccess) throw new Error("localStorage denied");
      m.set(k, String(v));
    },
  };
}

const settings = (over) => Object.assign({}, T.DEFAULT_SETTINGS, over || {});

// ① 默认都是「上次使用项」
t('DEFAULT_SETTINGS 两项默认都是 "last"', () => {
  assert.strictEqual(T.DEFAULT_SETTINGS.defaultDockFilter, "last");
  assert.strictEqual(T.DEFAULT_SETTINGS.defaultTaskFilter, "last");
});

// ② 无记录回落（含雄哥要求的 Dock 由「未来七天」→「所有未完成」）
t("无记录：Dock 回落到 undone（所有未完成）", () => {
  globalThis.localStorage = makeStorage();
  assert.strictEqual(P.DEFAULT_DOCK_FILTER, "undone");
  assert.strictEqual(P.resolveDockFilter(settings()), "undone");
});
t("无记录：任务视图回落到 allincomplete（所有未完成）", () => {
  globalThis.localStorage = makeStorage();
  assert.strictEqual(P.DEFAULT_TASK_FILTER, "allincomplete");
  assert.strictEqual(P.resolveTaskFilter(settings()), "allincomplete");
});

// ③ 往返
t("Dock：save 后能 load 回，resolve 也用它", () => {
  globalThis.localStorage = makeStorage();
  P.saveLastDockFilter("thisweek");
  assert.strictEqual(P.loadLastDockFilter(), "thisweek");
  assert.strictEqual(P.resolveDockFilter(settings({ defaultDockFilter: "last" })), "thisweek");
});
t("任务视图：save 后能 load 回，resolve 也用它", () => {
  globalThis.localStorage = makeStorage();
  P.saveLastTaskFilter("overdue");
  assert.strictEqual(P.loadLastTaskFilter(), "overdue");
  assert.strictEqual(P.resolveTaskFilter(settings({ defaultTaskFilter: "last" })), "overdue");
});

// ④ 固定成某一项时忽略「上次使用项」
t('Dock 固定为 today 时，即使有上次记录也用 today', () => {
  globalThis.localStorage = makeStorage();
  P.saveLastDockFilter("thisweek");
  assert.strictEqual(P.resolveDockFilter(settings({ defaultDockFilter: "today" })), "today");
});
t("任务视图固定为 doneall 时，即使有上次记录也用 doneall", () => {
  globalThis.localStorage = makeStorage();
  P.saveLastTaskFilter("overdue");
  assert.strictEqual(P.resolveTaskFilter(settings({ defaultTaskFilter: "doneall" })), "doneall");
});

// ⑤ 脏数据 / 非法设置值
t("Dock 脏数据（不在合法集合内）视为无记录", () => {
  const st = makeStorage();
  st.setItem("caldav-dock-filter", "not-a-real-filter");
  globalThis.localStorage = st;
  assert.strictEqual(P.loadLastDockFilter(), null);
  assert.strictEqual(P.resolveDockFilter(settings()), "undone");
});
t("任务视图脏数据视为无记录", () => {
  const st = makeStorage();
  st.setItem("caldav-task-filter", "???");
  globalThis.localStorage = st;
  assert.strictEqual(P.loadLastTaskFilter(), null);
  assert.strictEqual(P.resolveTaskFilter(settings()), "allincomplete");
});
t("设置里存了非法筛选键时回落到默认值", () => {
  globalThis.localStorage = makeStorage();
  assert.strictEqual(P.resolveDockFilter(settings({ defaultDockFilter: "bogus" })), "undone");
  assert.strictEqual(P.resolveTaskFilter(settings({ defaultTaskFilter: "bogus" })), "allincomplete");
});

// ⑥ localStorage 异常 / 缺失
t("localStorage 抛异常时读写都不崩，走默认值", () => {
  globalThis.localStorage = makeStorage(true);
  assert.strictEqual(P.resolveDockFilter(settings()), "undone");
  assert.strictEqual(P.resolveTaskFilter(settings()), "allincomplete");
  P.saveLastDockFilter("today");
  P.saveLastTaskFilter("today");
});
t("localStorage 根本不存在时也不崩", () => {
  delete globalThis.localStorage;
  assert.strictEqual(P.resolveDockFilter(settings()), "undone");
  assert.strictEqual(P.resolveTaskFilter(settings()), "allincomplete");
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

// ⑧ 接线
t("Dock 选中某项时调用 saveLastDockFilter", () => {
  const src = readFileSync(join(root, "src/ui/panel.ts"), "utf8");
  assert.ok(/saveLastDockFilter\(dockFilter\)/.test(src));
});
t("任务视图切筛选时调用 saveLastTaskFilter", () => {
  const src = readFileSync(join(root, "src/ui/view-task.ts"), "utf8");
  assert.ok(/saveLastTaskFilter\(val\)/.test(src));
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
