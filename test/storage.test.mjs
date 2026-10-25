/**
 * 数据文件名迁移回归测试（0.2.12 → 0.2.13：caldav-sync-dock → caldav-sync.json）
 *
 * 背景：插件数据存在 data/storage/petal/<插件名>/<storageName>，而思源**原样**使用
 * storageName 当文件名 —— 0.2.12 及更早直接复用了 Dock 的标识 "caldav-sync-dock"，
 * 于是数据文件没有扩展名，手动打开时系统不知道用什么程序，查看很不方便。
 * 本次把数据文件名改成 "caldav-sync.json"，并做一次无损迁移。
 *
 * 这里锁死五条不许再犯的规矩（都属于「静默丢数据」这一类，比崩溃危险得多）：
 *   1. 迁移必须是**原样搬运**：字段一个不少（含未来新增的未知字段）；
 *   2. 顺序不可颠倒：先写新文件，成功后才删旧文件；
 *   3. 写新文件失败 → 保留旧文件、仍用旧数据启动，**绝不出现新旧皆空**；
 *   4. 「读出错」不等于「文件不存在」：读异常必须抛出去，不能当成空数据去回退旧文件
 *      （否则会拿旧数据覆盖用户较新的数据，还顺手删掉好文件）；
 *   5. 新文件已在时，不去碰旧文件（迁移只跑一次）。
 *
 * 另外覆盖「更早期原型留下的空壳 caldav-data.json 会被顺手清掉」。
 */
import assert from "node:assert/strict";
import { setupBrowserDom, loadBuiltPlugin } from "./helpers.mjs";

setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
assert.ok(PluginClass, "应导出默认插件类");

const DATA_FILE = "caldav-sync.json";
const LEGACY_FILE = "caldav-sync-dock";
const STALE_FILE = "caldav-data.json";

/** 0.2.12 真正会读的那个文件里的内容（形状照抄真机） */
function legacyFixture(over = {}) {
  return {
    keyring: "POjsY05/Bgv+ngdCq2v7RSaiPr4aUaRRMfI6hBX7SD0=",
    settings: {
      serverUrl: "http://nas.bonebear.cn:5232/bonebear",
      username: "bonebear",
      password: "",
      calendarPath: "",
      channel: "auto",
      syncIntervalMin: 15,
      enableReminders: false,
      conflict: "server",
      pastDays: 90,
      futureDays: 370,
      defaultCalendarUrl: "http://nas.bonebear.cn:5232/bonebear/work/",
      calendars: [
        {
          url: "http://nas.bonebear.cn:5232/bonebear/work/",
          displayName: "工作",
          eventColor: "#3b82f6",
          todoColor: "#10b981",
          color: "#3b82f6",
          enabled: true,
          supportsEvent: true,
          supportsTodo: true
        }
      ],
      showTodosInCalendar: true
    },
    items: [
      {
        uid: "migrate-me@bonebear",
        kind: "event",
        calendarUrl: "http://nas.bonebear.cn:5232/bonebear/work/",
        href: "/bonebear/work/migrate-me.ics",
        etag: '"abc"',
        summary: "迁移前就存在的日程",
        allDay: false,
        start: "2026-09-25T09:00:00",
        end: "2026-09-25T10:00:00"
      }
    ],
    sync: { lastSync: "2026-09-25T12:00:00", lastError: "" },
    ...over
  };
}

/** 更早期原型留下的空壳（真机上 316 B，字段全空） */
const EMPTY_SHELL = {
  version: 1,
  settings: { serverUrl: "", username: "", password: "" },
  calendars: [],
  items: [],
  lastSynced: 0
};

/** 起一个插件实例：先把数据塞进桩的存储里，再走真实 onload 链路 */
async function boot(seed = {}, mutate = null) {
  const plugin = new PluginClass({
    app: { appId: "test" },
    name: "siyuan-plugin-caldav-sync",
    i18n: {}
  });
  for (const [name, value] of Object.entries(seed)) plugin.__stores.set(name, value);
  if (mutate) mutate(plugin);
  await plugin.onload();
  return plugin;
}

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log("  ✓ " + name);
    passed++;
  } catch (e) {
    console.error("  ✗ " + name + "\n      " + (e?.message || e));
    failed++;
  }
}

console.log("[storage] 数据文件名迁移");

// ---- 1. 文件名常量就该是带 .json 的那个（防被人「顺手」改回去） ----
await t("数据文件名为 caldav-sync.json，历史名为 caldav-sync-dock", async () => {
  const src = (await import("node:fs")).readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8"
  );
  assert.match(src, /const DATA_FILE = "caldav-sync\.json";/, "DATA_FILE 应为 caldav-sync.json");
  assert.match(
    src,
    /const LEGACY_DATA_FILE = "caldav-sync-dock";/,
    "LEGACY_DATA_FILE 必须是冻结的字面量（写成 = DOCK_TYPE 会随 DOCK_TYPE 一起漂走）"
  );
  // Dock 标识不能跟着数据文件名一起改：它决定思源侧栏布局记账，改了用户 Dock 会失配
  assert.match(src, /const DOCK_TYPE = "caldav-sync-dock";/, "DOCK_TYPE 不应被改动");
});

// ---- 2. 老用户：只有旧文件 → 原样搬到新文件并删掉旧文件 ----
await t("旧文件存在时无损迁移到新文件，并清掉旧文件与空壳", async () => {
  const legacy = legacyFixture();
  const plugin = await boot({ [LEGACY_FILE]: legacy, [STALE_FILE]: EMPTY_SHELL });

  assert.ok(plugin.__stores.has(DATA_FILE), "迁移后应存在新数据文件");
  assert.deepStrictEqual(
    plugin.__stores.get(DATA_FILE),
    legacy,
    "必须原样搬运：字段（含未知字段）一个都不能少、不能变"
  );
  assert.ok(!plugin.__stores.has(LEGACY_FILE), "迁移成功后应删除旧文件");
  assert.ok(!plugin.__stores.has(STALE_FILE), "更早期原型的空壳文件应一并清掉");
});

// ---- 3. 迁移后的数据真的进了内存（不只是搬了文件） ----
await t("迁移后的设置、条目、同步时间都正常载入", async () => {
  const plugin = await boot({ [LEGACY_FILE]: legacyFixture() });
  // 2026-10-25 多账户重构后，平铺字段由 migrateToAccounts 迁进 accounts[0]
  assert.strictEqual(
    plugin.store.settings.accounts[0].serverUrl,
    "http://nas.bonebear.cn:5232/bonebear",
    "服务器地址应载入（迁进 accounts[0]）"
  );
  assert.strictEqual(plugin.store.settings.accounts[0].calendars.length, 1, "日历列表应载入");
  assert.strictEqual(plugin.store.getAll().length, 1, "条目应载入");
  assert.strictEqual(plugin.store.lastSync, "2026-09-25T12:00:00", "上次同步时间应载入");
  assert.strictEqual(plugin.store.keyring, "POjsY05/Bgv+ngdCq2v7RSaiPr4aUaRRMfI6hBX7SD0=", "密钥应随数据载入");
});

// ---- 4. 未来新增的未知字段也必须活着搬过去 ----
await t("未知字段原样保留（将来加字段不用再写迁移）", async () => {
  const legacy = legacyFixture({ futureThing: { keep: ["me"] }, version: 9 });
  const plugin = await boot({ [LEGACY_FILE]: legacy });
  assert.deepStrictEqual(plugin.__stores.get(DATA_FILE), legacy);
});

// ---- 5. 新文件已在 → 不碰旧文件（迁移只跑一次） ----
await t("新文件已存在时优先新文件，且不动旧文件", async () => {
  const fresh = legacyFixture({
    settings: { ...legacyFixture().settings, username: "新文件名里的用户" },
    items: []
  });
  const plugin = await boot({ [DATA_FILE]: fresh, [LEGACY_FILE]: legacyFixture() });
  assert.strictEqual(plugin.store.settings.accounts[0].username, "新文件名里的用户", "应以新文件为准");
  assert.ok(plugin.__stores.has(LEGACY_FILE), "新文件已在时不该去动旧文件");
});

// ---- 6. 写新文件失败 → 本轮仍用旧数据，且绝不删旧文件 ----
await t("写新文件失败时保留旧文件并照常载入旧数据", async () => {
  const legacy = legacyFixture();
  const plugin = await boot({ [LEGACY_FILE]: legacy }, (p) => {
    p.saveData = async () => {
      throw new Error("disk full");
    };
  });
  assert.strictEqual(
    plugin.store.settings.accounts[0].serverUrl,
    legacy.settings.serverUrl,
    "写失败也要把旧数据交给内存，本次会话照常可用"
  );
  assert.ok(plugin.__stores.has(LEGACY_FILE), "迁移失败绝不能删旧文件");
  assert.ok(!plugin.__stores.has(DATA_FILE), "写失败时不应留下半成品新文件");
});

// ---- 7. 「读出错」必须响亮失败，不能当成空数据 ----
await t("读新文件异常时抛出（绝不静默当成无数据去回退旧文件）", async () => {
  const legacy = legacyFixture();
  const plugin = new PluginClass({
    app: { appId: "test" },
    name: "siyuan-plugin-caldav-sync",
    i18n: {}
  });
  plugin.__stores.set(LEGACY_FILE, legacy);
  plugin.loadData = async (k) => {
    if (k === DATA_FILE) throw new Error("kernel busy");
    return plugin.__stores.get(k);
  };
  await assert.rejects(plugin.onload(), /kernel busy/, "读异常应抛出，而不是被吞成空数据");
  assert.ok(
    plugin.__stores.has(LEGACY_FILE),
    "读出错时绝不能动旧文件（否则会拿旧数据覆盖较新的数据）"
  );
});

// ---- 8. 全新安装：不凭空写文件，空壳也不残留 ----
await t("全新安装不写出数据文件", async () => {
  const plugin = await boot({ [STALE_FILE]: EMPTY_SHELL });
  assert.strictEqual(plugin.store.settings.accounts.length, 0, "全新安装应是默认设置（没有任何账户）");
  assert.ok(!plugin.__stores.has(DATA_FILE), "没有数据就不该写文件");
  assert.ok(!plugin.__stores.has(LEGACY_FILE), "更不该写历史文件名");
  assert.ok(!plugin.__stores.has(STALE_FILE), "空壳文件应被清掉");
});

// ---- 9. 保存走的是新文件名（否则迁移完又会在旧名上长出新数据） ----
await t("后续保存写入新文件名，不再产生旧文件", async () => {
  const plugin = await boot({ [LEGACY_FILE]: legacyFixture() });
  plugin.store.settings.accounts[0].username = "改过了";
  await plugin.store.persist();
  assert.ok(plugin.__stores.has(DATA_FILE), "保存应写入新文件名");
  assert.strictEqual(
    plugin.__stores.get(DATA_FILE).settings.accounts[0].username,
    "改过了",
    "新文件应包含最新改动"
  );
  assert.ok(!plugin.__stores.has(LEGACY_FILE), "保存不应再生成旧文件名");
});

console.log(`[storage] 通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ""}`);
process.exit(failed ? 1 : 0);
