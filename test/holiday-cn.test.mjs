/**
 * 中国日历叠加层 · 数据层单测（2026-10-26）
 *
 * 只测 src/core/holiday-cn.ts（+ 其类型依赖 types.ts），不触碰含密钥的 core.test.mjs。
 * 网络相关逻辑用全局 fetch mock 覆盖：归一化、多源回退、自定义源占位符替换、缓存命中。
 * 农历/节气走内置算法（lunar-javascript），直接对已知日期断言。
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, ".test-holiday");

// 编译产物是 CJS，但仓库根 package.json 是 type:module，故在输出目录声明 cjs 上下文
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));

execSync(
  `npx tsc src/core/types.ts src/core/holiday-cn.ts ` +
    `--outDir ${outDir} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
const cn = require(join(outDir, "holiday-cn.js"));

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.error("✗", name, "\n   ", e.message);
  }
}
async function ta(name, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    console.error("✗", name, "\n   ", e.message);
  }
}

// ---- 农历 / 节气（内置算法，无网络）----
t("lunarFor 立春(2026-02-04)", () => {
  const r = cn.lunarFor("2026-02-04");
  assert.strictEqual(r.lunar, "腊十七");
  assert.strictEqual(r.jieqi, "立春");
});
t("lunarFor 冬至(2026-12-22)", () => {
  const r = cn.lunarFor("2026-12-22");
  assert.strictEqual(r.lunar, "冬十四");
  assert.strictEqual(r.jieqi, "冬至");
});
t("lunarFor 春节(2026-02-17)", () => {
  const r = cn.lunarFor("2026-02-17");
  assert.strictEqual(r.lunar, "正初一");
  assert.strictEqual(r.jieqi, "");
});
t("lunarFor 非法日期安全降级", () => {
  const r = cn.lunarFor("2026-13-40");
  assert.strictEqual(r.lunar, "");
  assert.strictEqual(r.jieqi, "");
});

// ---- 开关聚合 ----
t("chinaCalendarEnabled 任一开关开即真", () => {
  assert.strictEqual(cn.chinaCalendarEnabled({ showHolidaysCN: true }), true);
  assert.strictEqual(cn.chinaCalendarEnabled({ showLunarCN: true }), true);
  assert.strictEqual(cn.chinaCalendarEnabled({ showTermCN: true }), true);
});
t("chinaCalendarEnabled 全关即假", () => {
  assert.strictEqual(cn.chinaCalendarEnabled({}), false);
  assert.strictEqual(cn.chinaCalendarEnabled({ showHolidaysCN: false, showLunarCN: false, showTermCN: false }), false);
});

// ---- 数据源解析 ----
t("effectiveHolidaySource 默认 holiday-cn", () => {
  assert.strictEqual(cn.effectiveHolidaySource({}), "holiday-cn");
  assert.strictEqual(cn.effectiveHolidaySource({ holidayCnSource: "holiday-cn" }), "holiday-cn");
});
t("effectiveHolidaySource custom 取自定义 URL", () => {
  assert.strictEqual(
    cn.effectiveHolidaySource({ holidayCnSource: "custom", holidayCnCustomUrl: "https://x/{year}.json" }),
    "https://x/{year}.json"
  );
});
t("effectiveHolidaySource custom 未填 URL 退空", () => {
  assert.strictEqual(cn.effectiveHolidaySource({ holidayCnSource: "custom", holidayCnCustomUrl: "" }), "");
});

async function run() {
  const origFetch = globalThis.fetch;

  // ---- 归一化 + 缓存命中 + holidayFor 同步读 ----
  await ta("loadHolidayYear 归一化 + 缓存 + holidayFor", async () => {
    const data = [
      { date: "2099-10-01", name: "国庆节", isOffDay: true },
      { date: "2099-09-26", name: "调休补班", isOffDay: false }
    ];
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, json: async () => data };
    };
    const map = await cn.loadHolidayYear({ holidayCnSource: "holiday-cn" }, 2099);
    assert.ok(map, "应返回 map");
    assert.strictEqual(map["2099-10-01"].name, "国庆节");
    assert.strictEqual(map["2099-10-01"].off, true, "isOffDay=true → off=true(休)");
    assert.strictEqual(map["2099-09-26"].off, false, "isOffDay=false → off=false(班)");

    // holidayFor 命中缓存
    const h = cn.holidayFor("2099-10-01");
    assert.strictEqual(h.name, "国庆节");
    assert.strictEqual(h.off, true);
    const hw = cn.holidayFor("2099-09-26");
    assert.strictEqual(hw.off, false);

    // 二次调用命中缓存，不应再次 fetch
    const map2 = await cn.loadHolidayYear({ holidayCnSource: "holiday-cn" }, 2099);
    assert.strictEqual(calls, 1, "缓存命中不应再次拉取");
    assert.strictEqual(map2["2099-10-01"].name, "国庆节");
  });

  // ---- 多源回退：主源失败用镜像 ----
  await ta("多源回退：主源(cdn)失败、镜像(fastly)成功", async () => {
    let primaryCalled = false;
    let mirrorCalled = false;
    globalThis.fetch = async (url) => {
      if (url.includes("cdn.jsdelivr.net")) {
        primaryCalled = true;
        throw new Error("network down");
      }
      if (url.includes("fastly.jsdelivr.net")) {
        mirrorCalled = true;
        return { ok: true, json: async () => [{ date: "2098-01-01", name: "元旦", isOffDay: true }] };
      }
      throw new Error("unexpected url " + url);
    };
    const map = await cn.loadHolidayYear({ holidayCnSource: "holiday-cn" }, 2098);
    assert.ok(primaryCalled, "应请求主源");
    assert.ok(mirrorCalled, "主源失败后应使用镜像");
    assert.ok(map, "镜像成功应返回 map");
    assert.strictEqual(map["2098-01-01"].name, "元旦");
  });

  // ---- 自定义源 {year} 占位符替换 ----
  await ta("自定义源 {year} 占位符替换", async () => {
    globalThis.fetch = async (url) => {
      assert.ok(url.includes("2097"), "URL 应含年份 2097，实际: " + url);
      return { ok: true, json: async () => [{ date: "2097-05-01", name: "劳动节", isOffDay: true }] };
    };
    const map = await cn.loadHolidayYear({ holidayCnSource: "custom", holidayCnCustomUrl: "https://mirror.example.com/{year}.json" }, 2097);
    assert.strictEqual(map["2097-05-01"].name, "劳动节");
  });

  // ---- HTTP 失败静默降级（所有源失败 → null）----
  await ta("全部源失败 → 静默返回 null", async () => {
    globalThis.fetch = async () => {
      throw new Error("all down");
    };
    const map = await cn.loadHolidayYear({ holidayCnSource: "holiday-cn" }, 2096);
    assert.strictEqual(map, null);
    assert.strictEqual(cn.holidayFor("2096-01-01"), null, "未缓存时 holidayFor 返 null");
  });

  globalThis.fetch = origFetch;

  console.log(`\nholiday-cn tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
