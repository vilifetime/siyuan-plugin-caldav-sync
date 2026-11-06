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
  assert.strictEqual(r.lunar, "腊月十七");
  assert.strictEqual(r.jieqi, "立春");
});
t("lunarFor 冬至(2026-12-22)", () => {
  const r = cn.lunarFor("2026-12-22");
  assert.strictEqual(r.lunar, "冬月十四");
  assert.strictEqual(r.jieqi, "冬至");
});
t("lunarFor 春节(2026-02-17)", () => {
  const r = cn.lunarFor("2026-02-17");
  assert.strictEqual(r.lunar, "正月初一");
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
    const before = calls;
    const map2 = await cn.loadHolidayYear({ holidayCnSource: "holiday-cn" }, 2099);
    assert.strictEqual(calls, before, "缓存命中不应再次拉取");
    assert.strictEqual(map2["2099-10-01"].name, "国庆节");
  });

  // ---- 多源回退：主源(fastly)失败用镜像(cdn/ghproxy/raw) ----
  await ta("多源回退：主源(fastly)失败、镜像(cdn)成功", async () => {
    let primaryCalled = false;
    let mirrorCalled = false;
    globalThis.fetch = async (url) => {
      if (url.includes("fastly.jsdelivr.net")) {
        primaryCalled = true;
        throw new Error("network down");
      }
      if (url.includes("cdn.jsdelivr.net")) {
        mirrorCalled = true;
        return { ok: true, json: async () => [{ date: "2098-01-01", name: "元旦", isOffDay: true }] };
      }
      throw new Error("unexpected url " + url);
    };
    const map = await cn.loadHolidayYear({ holidayCnSource: "holiday-cn" }, 2098);
    assert.ok(primaryCalled, "应请求主源 fastly");
    assert.ok(mirrorCalled, "主源失败后应使用镜像 cdn");
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
  await ta("全部源失败 → 静默返回 null + 记录失败原因", async () => {
    globalThis.fetch = async () => {
      throw new Error("all down");
    };
    const map = await cn.loadHolidayYear({ holidayCnSource: "holiday-cn" }, 2096);
    assert.strictEqual(map, null);
    assert.strictEqual(cn.holidayFor("2096-01-01"), null, "未缓存时 holidayFor 返 null");
    assert.ok(cn.getLastHolidayError(), "应记录失败原因（设置页回显用）");
  });

  // ---- timor.tech 源（国内部署，结构 {holiday:{date,name,holiday}}）----
  await ta("timor.tech 源归一化：休息/补班 正确", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        holiday: {
          "10-01": { holiday: true, name: "国庆节", date: "2026-10-01" },
          "10-02": { holiday: false, name: "国庆后补班", date: "2026-10-02" }
        }
      })
    });
    const map = await cn.loadHolidayYear({ holidayCnSource: "timor" }, 2026);
    assert.strictEqual(map["2026-10-01"].name, "国庆节");
    assert.strictEqual(map["2026-10-01"].off, true, "timor holiday:true → 休");
    assert.strictEqual(map["2026-10-02"].off, false, "timor holiday:false → 班");
  });

  // ---- holiday-cn 源的 timor 兜底：jsdelivr 全挂、timor 成功 ----
  await ta("holiday-cn 源：jsdelivr 全挂时自动用 timor.tech 兜底", async () => {
    globalThis.fetch = async (url) => {
      if (url.includes("timor.tech")) {
        return { ok: true, json: async () => ({ code: 0, holiday: { "09-01": { holiday: true, name: "测试节", date: "2095-09-01" } } }) };
      }
      throw new Error("jsdelivr down");
    };
    const map = await cn.loadHolidayYear({ holidayCnSource: "holiday-cn" }, 2095);
    assert.strictEqual(map["2095-09-01"].name, "测试节", "应经 timor.tech 兜底拿到数据");
  });

  // ---- 跨窗口共享缓存 / 独立窗口零联网 / 换源不复用 / 失败冷却（issue #5 · C 项）----
  // 用可注入的 runtime + 内存 storage 模拟「主窗口写、独立窗口读」，不污染全局环境。
  const sharedStore = new Map();
  const memStorage = {
    getItem: (k) => (sharedStore.has(k) ? sharedStore.get(k) : null),
    setItem: (k, v) => sharedStore.set(k, String(v))
  };
  const SHARED_KEY = "siyuan-caldav-sync-holiday-cache-v1";
  const holidaySettings = { showHolidaysCN: true, holidayCnSource: "timor" };

  await ta("主窗口拉取成功后写入跨窗口共享快照", async () => {
    cn.setHolidayRuntime({ hostEnabled: true, networkAllowed: true, sharedStorage: memStorage });
    cn.setHolidayTransport(async () => ({
      ok: true,
      data: { code: 0, holiday: { "01-01": { holiday: true, name: "元旦", date: "2094-01-01" } } }
    }));
    const map = await cn.loadHolidayYear(holidaySettings, 2094, true);
    assert.ok(map && map["2094-01-01"].name === "元旦", "应拿到节假日数据");
    assert.ok(sharedStore.has(SHARED_KEY), "成功结果应写入共享快照供其它窗口复用");
    const snap = JSON.parse(sharedStore.get(SHARED_KEY));
    assert.ok(snap.years.some((e) => e.year === 2094 && e.source === "timor"), "快照须记录年份与数据源");
  });

  await ta("独立窗口 hydrate 共享快照后零联网，节假日立即可读", async () => {
    // 手工放一个「本进程内存里没有」的年份，模拟主窗口写、独立窗口读
    sharedStore.set(SHARED_KEY, JSON.stringify({
      v: 1,
      years: [{ year: 2091, source: "timor", updatedAt: Date.now(), map: { "2091-05-01": { name: "劳动节", off: true } } }]
    }));
    cn.setHolidayRuntime({ hostEnabled: true, networkAllowed: false, sharedStorage: memStorage });
    let netCalls = 0;
    cn.setHolidayTransport(async () => { netCalls++; return { ok: false, error: "不应联网" }; });
    const changed = await cn.warmChinaCalendar(holidaySettings, [2090, 2091, 2092]);
    assert.strictEqual(changed, true, "灌入共享缓存应请求一次重绘补出徽标");
    assert.strictEqual(netCalls, 0, "独立窗口绝不发起任何网络拉取");
    assert.strictEqual(cn.holidayFor("2091-05-01").name, "劳动节", "节假日应立即可读");
    assert.strictEqual(cn.holidayFor("2090-01-01"), null, "快照里没有的年份保持为空（严格不联网）");
    assert.strictEqual(await cn.warmChinaCalendar(holidaySettings, [2091]), false,
      "快照未变时不再 hydrate、不重绘（避免渲染循环）");
    assert.strictEqual(netCalls, 0);
  });

  await ta("换数据源后不复用旧快照（避免格式不兼容）", async () => {
    sharedStore.set(SHARED_KEY, JSON.stringify({
      v: 1,
      years: [{ year: 2089, source: "timor", updatedAt: Date.now(), map: { "2089-01-01": { name: "元旦", off: true } } }]
    }));
    cn.setHolidayRuntime({ hostEnabled: true, networkAllowed: false, sharedStorage: memStorage });
    let calls = 0;
    cn.setHolidayTransport(async () => { calls++; return { ok: false, error: "不应联网" }; });
    const changed = await cn.warmChinaCalendar({ showHolidaysCN: true, holidayCnSource: "holiday-cn" }, [2089]);
    assert.strictEqual(changed, false, "源不匹配不应灌入");
    assert.strictEqual(cn.holidayFor("2089-01-01"), null);
    assert.strictEqual(calls, 0);
  });

  await ta("全候选失败后进入冷却，短期内不再重发请求", async () => {
    sharedStore.clear();
    cn.setHolidayRuntime({ hostEnabled: true, networkAllowed: true, sharedStorage: memStorage });
    let calls = 0;
    cn.setHolidayTransport(async () => { calls++; return { ok: false, error: "TLS timeout" }; });
    const s = { showHolidaysCN: true, holidayCnSource: "chinese-days" };
    await cn.warmChinaCalendar(s, [2092]);
    const first = calls;
    assert.ok(first > 0, "首次应确实尝试拉取");
    await cn.warmChinaCalendar(s, [2092]);
    assert.strictEqual(calls, first, "冷却期内不得重复联网（否则切月/筛选必刷屏）");
  });

  globalThis.fetch = origFetch;

  console.log(`\nholiday-cn tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
