/**
 * 任务块**增量扫描**单测（2026-10-30）。
 *
 * 背景：思源内核 `blocks` 表有 `updated` 字段（`YYYYMMDDHHmmss`，秒级、逐块更新），
 * 可以据此只查「改动过的」任务块，而不是每次全量。
 *
 * 覆盖五块：
 *   ① 增量扫描本身（只取 updated 晚于水位的块；updated 为空的老块永远命中）
 *   ② 水位线推进规则（推进 / 单文档不推进 / 被截断不推进 / 范围变了退回全量 / 24h 校准）
 *   ③ **服务端漂移**：服务端改了、块没动的条目要按 ID 捞回来对账（否则「手机端勾完成
 *      → 回写文档」这条链在增量模式下就断了）
 *   ④ 删除判定：块没了 → 删 VTODO（增量模式下同样成立）
 *   ⑤ 内核 SQL 的 64 行默认截断坑（存在性查询必须显式写 LIMIT）
 *
 * 用假 caller 模拟内核 SQL：只实现插件真正用到的那几种语句，
 * 但**如实还原内核的截断行为**（没写 LIMIT 时只回 64 行）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-blockscan");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/block-todo.ts src/core/block-api.ts ` +
    `src/core/block-sync.ts src/core/store.ts src/core/sync.ts src/core/secret.ts src/core/caldav.ts ` +
    `src/core/server-id.ts ` +
    `--outDir .test-blockscan --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const bt = require(path.join(outDir, "block-todo.js"));
const bapi = require(path.join(outDir, "block-api.js"));
const bsync = require(path.join(outDir, "block-sync.js"));
const StoreMod = require(path.join(outDir, "store.js"));
const T = require(path.join(outDir, "types.js"));

let pass = 0;
const pending = [];
/** 登记一个检查（支持 async：内部断言失败要能被捕获，不能变成未处理的 Promise 拒绝） */
const check = (name, fn) => pending.push({ name, fn });
const section = (title) => pending.push({ section: title });
const runAll = async () => {
  for (const c of pending) {
    if (c.section) {
      console.log(c.section);
      continue;
    }
    try {
      await c.fn();
      pass++;
      console.log("  ✓ " + c.name);
    } catch (e) {
      console.log("  ✗ " + c.name + "\n    " + (e && e.message));
      process.exitCode = 1;
    }
  }
  };

const CAL = "http://127.0.0.1:5232/cal/todo/";
const settings = (over = {}) => ({
  ...T.DEFAULT_SETTINGS,
  blockSyncEnabled: true,
  blockSyncScope: "all",
  blockSyncMarks: ["badge", "prefix"],
  blockSyncPrefix: "[文档]",
  accounts: [
    {
      id: "acc1",
      name: "A",
      enabled: true,
      serverUrl: "http://127.0.0.1:5232/",
      username: "u",
      password: "p",
      calendarPath: "",
      channel: "auto",
      conflict: "server",
      pastDays: 90,
      futureDays: 370,
      calendars: [{ url: CAL, displayName: "待办", enabled: true }]
    }
  ],
  ...over
});

/** 假的任务块（对齐内核 blocks 表的字段） */
const fakeBlock = (id, text, updated, over = {}) => ({
  id,
  content: text,
  markdown: `- [ ] ${text}`,
  root_id: "doc1",
  box: "box1",
  hpath: "/测试",
  updated,
  ...over
});
/**
 * 假内核调用：按语句求值。
 * ⚠️ **如实还原内核的截断行为**：没写 LIMIT 时只回 64 行（truncated=true）——
 *    这正是 2026-10-30 挖出来的那个「会删数据」的坑，必须在测试里也成立。
 */
function makeCaller(rows, opts = {}) {
  const stmts = [];
  /** 回写块的记录（updateBlock）—— 2026-10-30 的「块被批量取消勾选」事故就发生在这条路径上 */
  const writes = [];
  const parseIds = (s) => s.split(",").map((x) => x.trim().replace(/^'|'$/g, "")).filter(Boolean);
  const caller = async (url, body) => {
    if (url === "/api/block/updateBlock") {
      writes.push({ id: body.id, data: body.data, dataType: body.dataType });
      return { code: 0, msg: "", data: {} };
    }
    if (url !== "/api/query/sql") return { code: 0, msg: "", data: null };
    const stmt = body.stmt;
    stmts.push(stmt);
    // 去掉 skip 子查询（它不是普通的 IN 列表）
    // ⚠️ 必须吃到**配对的右括号**：原来的 `[^)]*` 会在子查询内部的第一个 `)` 处截断，
    //    留下 `WHERE name = 'xxx')` 的尾巴 → 后面 `root_id IN (...)` 的匹配被带偏 →
    //    单文档扫描时过滤条件「消失」→ 扫到 0 个块（2026-10-30 排查时踩到）。
    const clean = stmt.replace(/id NOT IN \(SELECT block_id FROM attributes[^)]*\)/, "");
    let out = rows.slice();
    const rootIn = /root_id IN \(([^)]*)\)/.exec(clean);
    if (rootIn) {
      const ids = parseIds(rootIn[1]);
      out = out.filter((r) => ids.includes(r.root_id));
    }
    const boxIn = /box IN \(([^)]*)\)/.exec(clean);
    if (boxIn) {
      const ids = parseIds(boxIn[1]);
      out = out.filter((r) => ids.includes(r.box));
    }
    const idIn = /id IN \(([^)]*)\)/.exec(clean);
    if (idIn) {
      const ids = parseIds(idIn[1]);
      out = out.filter((r) => ids.includes(r.id));
    }
    const upd = /updated > '(\d{14})'/.exec(stmt);
    if (upd) {
      // 空 updated（老数据/导入来的块）永远命中：SQL 里是 `OR updated IS NULL OR updated = ''`
      out = out.filter((r) => !r.updated || r.updated > upd[1]);
    }
    const cols = /^SELECT (.+?) FROM/.exec(stmt)[1].split(",").map((s) => s.trim());
    let data = out.map((r) => {
      const o = {};
      for (const c of cols) o[c] = r[c];
      return o;
    });
    const lim = /LIMIT (\d+)/.exec(stmt);
    const eff = lim ? Number(lim[1]) : 64; // 内核默认只回 64 行
    const truncated = data.length > eff;
    data = data.slice(0, eff);
    if (opts.forceTruncated) return { code: 0, msg: "", data, limit: eff, truncated: true };
    return { code: 0, msg: "", data, limit: truncated ? eff : 0, truncated };
  };
  return { caller, stmts, writes };
}

/** 假 store / sync */
function makeStore(s, items) {
  return {
    settings: s,
    items,
    getAll: () => items,
    blockScanWatermark: undefined,
    blockScanFullAt: undefined,
    blockScanScopeSig: undefined,
    dirty: 0,
    markStateDirty() {
      this.dirty++;
    }
  };
}
function makeSync() {
  const out = { created: [], updated: [], removed: [] };
  return {
    out,
    createItem: async (it) => {
      out.created.push(it);
    },
    updateItem: async (it) => {
      out.updated.push(it);
    },
    removeItem: async (it) => {
      out.removed.push(it);
    }
  };
}
const mappedItem = (over = {}) => ({
  uid: "u1",
  kind: "todo",
  calendarUrl: CAL,
  href: CAL + "a.ics",
  summary: "[文档]买牛奶",
  allDay: false,
  start: "2026-10-30T09:00:00",
  status: "NEEDS-ACTION",
  percent: 0,
  blockId: "b1",
  blockText: "买牛奶",
  blockChecked: false,
  ...over
});

section("[blockscan] ① 增量扫描本身");

check("带 since 时 SQL 加 updated 条件，且空 updated 的块永远命中", async () => {
  const { caller, stmts } = makeCaller([
    fakeBlock("b1", "旧的", "20260101000000"),
    fakeBlock("b2", "新的", "20261030095629"),
    fakeBlock("b3", "老数据", "")
  ]);
  const r = await bapi.scanTaskBlocks(caller, { scope: "all", since: "20261030090000" });
  assert.match(stmts[0], /updated > '20261030090000'/);
  assert.match(stmts[0], /updated IS NULL OR updated = ''/, "空 updated 必须兜底，否则永远扫不到");
  const ids = r.blocks.map((b) => b.id).sort();
  assert.deepStrictEqual(ids, ["b2", "b3"]);
});

check("不带 since（首次 / 全量）不加 updated 条件", async () => {
  const { caller, stmts } = makeCaller([fakeBlock("b1", "甲", "20260101000000")]);
  const r = await bapi.scanTaskBlocks(caller, { scope: "all" });
  assert.doesNotMatch(stmts[0], /updated >/);
  assert.strictEqual(r.blocks.length, 1);
});

check("blockStampOf 产出内核认的格式（YYYYMMDDHHmmss，本地时间）", () => {
  const d = new Date(2026, 9, 30, 9, 56, 29);
  assert.strictEqual(bapi.blockStampOf(d.getTime()), "20261030095629");
});

section("[blockscan] ② 内核 64 行截断坑");

check("存在性查询必须显式写 LIMIT（否则第 65 个块起被判成「没了」→ 删待办）", async () => {
  const { caller, stmts } = makeCaller([fakeBlock("b1", "甲", "20260101000000")]);
  await bapi.blocksExistById(caller, ["b1", "b2"]);
  assert.match(stmts[0], /LIMIT \d+/, "存在性查询不能没有 LIMIT");
});

check("按 ID 取块（漂移用）也带 LIMIT", async () => {
  const { caller, stmts } = makeCaller([fakeBlock("b1", "甲", "20260101000000")]);
  await bapi.scanTaskBlocksByIds(caller, ["b1"], { scope: "all" });
  assert.match(stmts[0], /LIMIT \d+/);
});

section("[blockscan] ③ 水位线与模式判定");

const runOnce = async (over = {}) => {
  const rows = over.rows || [
    fakeBlock("b1", "买牛奶", "20260101000000"),
    fakeBlock("b2", "买酸奶", "20261030095629")
  ];
  const { caller: baseCaller, stmts, writes } = makeCaller(rows, over);
  // 允许外部包一层 caller（模拟内核报错 / 网络异常等异常路径）
  const caller = over.wrapCaller ? over.wrapCaller(baseCaller) : baseCaller;
  const items = over.items || [];
  const store = makeStore(over.settings || settings(), items);
  Object.assign(store, over.store || {});
  const sync = makeSync();
  const res = await bsync.runBlockSync({
    store,
    sync,
    caller,
    openDocIds: () => [],
    docIds: over.docIds,
    full: over.full,
    // 改动数量告警：由用例注入（不传 = 不告警，直接执行）
    confirm: over.confirm
  });
  return { res, store, sync, stmts, caller, writes };
};

check("有水位线 → 增量模式，SQL 里带 updated 条件", async () => {
  const { res, stmts } = await runOnce({
    store: { blockScanWatermark: Date.parse("2026-10-30T09:00:00Z"), blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["all", []]) }
  });
  assert.strictEqual(res.mode, "incremental");
  assert.ok(stmts.some((s) => /updated > /.test(s)), "增量扫描的语句里应有 updated 条件");
});

check("增量跑完推进水位线（且落盘）", async () => {
  const before = Date.now();
  const { store } = await runOnce({
    store: { blockScanWatermark: Date.parse("2026-10-30T09:00:00Z"), blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["all", []]) }
  });
  assert.ok(store.blockScanWatermark >= before, "水位线应推进到本轮开始时刻");
  assert.ok(store.dirty >= 1, "水位线变了要排期落盘");
});

check("单文档扫描不推进全局水位线（它没覆盖全库）", async () => {
  const { res, store } = await runOnce({
    docIds: ["doc1"],
    store: { blockScanWatermark: 12345, blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["all", []]) }
  });
  assert.strictEqual(res.mode, "full", "单文档按文档全量");
  assert.strictEqual(store.blockScanWatermark, 12345, "水位线不能被单文档扫描改写");
});

check("范围变了 → 退回全量（水位线不再覆盖新范围）", async () => {
  const { res, stmts } = await runOnce({
    settings: settings({ blockSyncScope: "notebooks", blockSyncNotebooks: ["box1"] }),
    store: { blockScanWatermark: Date.now(), blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["all", []]) }
  });
  assert.strictEqual(res.mode, "full");
  assert.ok(!stmts.some((s) => /updated > /.test(s)), "全量扫描不应带 updated 条件");
});

check("距上次全量超过 24 小时 → 强制全量校准", async () => {
  const { res } = await runOnce({
    store: {
      blockScanWatermark: Date.now(),
      blockScanFullAt: Date.now() - 25 * 3600 * 1000,
      blockScanScopeSig: JSON.stringify(["all", []])
    }
  });
  assert.strictEqual(res.mode, "full");
});

check("用户关掉增量 → 永远全量", async () => {
  const { res } = await runOnce({
    settings: settings({ blockSyncIncremental: false }),
    store: { blockScanWatermark: Date.now(), blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["all", []]) }
  });
  assert.strictEqual(res.mode, "full");
});

check("范围是「打开的文档」→ 永远全量，且不推进水位线（成员会变，推了就漏）", async () => {
  const { res, store } = await runOnce({
    settings: settings({ blockSyncScope: "open" }),
    store: { blockScanWatermark: 12345, blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["open", []]) }
  });
  assert.strictEqual(res.mode, "full");
  assert.strictEqual(store.blockScanWatermark, 12345, "成员会变的范围不能推进水位线");
});

check("范围是「仅日记」→ 永远全量，且不推进水位线", async () => {
  const { res, store } = await runOnce({
    settings: settings({ blockSyncScope: "daily" }),
    store: { blockScanWatermark: 12345, blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["daily", []]) }
  });
  assert.strictEqual(res.mode, "full");
  assert.strictEqual(store.blockScanWatermark, 12345);
});

check("扫描结果被内核截断 → 不推进水位线（没扫全，推了就永久漏块）", async () => {
  const { store } = await runOnce({
    forceTruncated: true,
    store: { blockScanWatermark: 12345, blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["all", []]) }
  });
  assert.strictEqual(store.blockScanWatermark, 12345, "截断时水位线必须原地不动");
});

check("手动「扫描全部」→ 全量", async () => {
  const { res } = await runOnce({
    full: true,
    store: { blockScanWatermark: Date.now(), blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["all", []]) }
  });
  assert.strictEqual(res.mode, "full");
});

section("[blockscan] ④ 服务端漂移 → 按 ID 捞回块");

check("服务端勾完成、块没动 → 增量模式下也要回写块的勾选", async () => {
  const it = mappedItem({ blockId: "b1", status: "COMPLETED", percent: 100 });
  const { res, sync } = await runOnce({
    items: [it],
    rows: [fakeBlock("b1", "买牛奶", "20260101000000")],
    store: { blockScanWatermark: Date.now(), blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["all", []]) }
  });
  assert.strictEqual(res.written, 1, "应回写块（手机端勾完成 → 文档里打勾）");
  assert.strictEqual(sync.out.updated.length, 1);
});

check("稳态（两边一致）→ 增量模式下无动作，也不去捞块", async () => {
  const it = mappedItem({ blockId: "b1" });
  const { res, sync, stmts } = await runOnce({
    items: [it],
    rows: [fakeBlock("b1", "买牛奶", "20260101000000")],
    store: { blockScanWatermark: Date.now(), blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["all", []]) }
  });
  assert.strictEqual(res.written, 0);
  assert.strictEqual(sync.out.updated.length, 0);
  assert.strictEqual(sync.out.removed.length, 0);
  assert.ok(
    !stmts.some((s) => /SELECT id, content, markdown[^\n]*id IN \(/.test(s)),
    "没漂移就不该按 ID 捞块（存在性查询是 SELECT id FROM，不能混为一谈）"
  );
});

check("漂移判据：缓存缺失（老数据）也算漂移 → 重新对账一次把缓存建起来", () => {
  assert.strictEqual(bt.blockItemDrift(mappedItem({ blockText: undefined, blockChecked: undefined }), settings()), true);
  assert.strictEqual(bt.blockItemDrift(mappedItem(), settings()), false);
  assert.strictEqual(
    bt.blockItemDrift(mappedItem({ status: "COMPLETED", percent: 100 }), settings()),
    true,
    "服务端完成 ≠ 缓存的未完成 → 漂移"
  );
});

section("[blockscan] ⑤ 删除判定");

check("块被删了 → 增量模式下也要删掉 VTODO", async () => {
  const it = mappedItem({ blockId: "b1" });
  const { res, sync } = await runOnce({
    items: [it],
    rows: [], // 库里已经没有这个块了
    store: { blockScanWatermark: Date.now(), blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["all", []]) }
  });
  assert.strictEqual(res.deleted, 1);
  assert.strictEqual(sync.out.removed.length, 1);
});

check("块还在（只是没改动）→ 不删", async () => {
  const it = mappedItem({ blockId: "b1" });
  const { res, sync } = await runOnce({
    items: [it],
    rows: [fakeBlock("b1", "买牛奶", "20260101000000")],
    store: { blockScanWatermark: Date.now(), blockScanFullAt: Date.now(), blockScanScopeSig: JSON.stringify(["all", []]) }
  });
  assert.strictEqual(res.deleted, 0);
  assert.strictEqual(sync.out.removed.length, 0);
});

section("[blockscan] ⑥ 范围签名");

check("范围签名随范围/笔记本变化而变", () => {
  const a = bt.blockScopeSig(settings({ blockSyncScope: "all" }));
  const b = bt.blockScopeSig(settings({ blockSyncScope: "daily" }));
  const c = bt.blockScopeSig(settings({ blockSyncScope: "notebooks", blockSyncNotebooks: ["b1"] }));
  const d = bt.blockScopeSig(settings({ blockSyncScope: "notebooks", blockSyncNotebooks: ["b1", "b2"] }));
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(c, d);
  assert.strictEqual(a, bt.blockScopeSig(settings({ blockSyncScope: "all" })), "同范围签名必须稳定");
});

section("[blockscan] ⑦ 服务端拉取不能抹掉对账缓存");

check("mergeServerItems 保留 blockText / blockChecked（否则服务端改动会被块盖回去）", async () => {
  const real = new StoreMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  await real.load();
  real.put(mappedItem({ uid: "u1", blockId: "b1", blockText: "买牛奶", blockChecked: false }));
  const incoming = {
    uid: "u1",
    kind: "todo",
    calendarUrl: CAL,
    href: CAL + "a.ics",
    summary: "[文档]买牛奶（手机端改的）",
    allDay: false,
    start: "2026-10-30T09:00:00",
    status: "COMPLETED",
    percent: 100,
    etag: "e2",
    blockId: "b1"
  };
  real.mergeServerItems([incoming]);
  const cur = real.get("u1");
  assert.ok(cur, "条目还在");
  assert.strictEqual(cur.status, "COMPLETED", "服务端的完成态要照收");
  assert.strictEqual(cur.blockText, "买牛奶", "对账缓存不能被拉取抹掉");
  assert.strictEqual(cur.blockChecked, false, "对账缓存不能被拉取抹掉");
  assert.strictEqual(cur.blockId, "b1", "blockId 必须保住（映射锚点）");
});

check("服务端回来的 ICS 没有 blockId 时，沿用本地那份（别把映射弄丢）", async () => {
  const real = new StoreMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  await real.load();
  real.put(mappedItem({ uid: "u2", blockId: "b2", blockText: "买酸奶", blockChecked: false }));
  real.mergeServerItems([
    {
      uid: "u2",
      kind: "todo",
      calendarUrl: CAL,
      href: CAL + "b.ics",
      summary: "[文档]买酸奶",
      allDay: false,
      start: "2026-10-30T09:00:00",
      status: "NEEDS-ACTION",
      percent: 0,
      etag: "e3"
    }
  ]);
  assert.strictEqual(real.get("u2").blockId, "b2", "blockId 丢了 → 映射断了 → 会重复建待办");
});

section("[blockscan] ⑧ ★回归：单文档扫描不得误删其它文档的 VTODO（2026-10-30 用户实测）");

check("★关闭文档时只扫该文档 → 其它文档的 100+ 条 VTODO 一条都不能删", async () => {
  // ── 复现用户的真实场景 ──
  // 「刷新」后有 100+ 条块来源 VTODO（分布在多篇文档里）→ 编辑其中一篇删掉几个任务块
  // → 关闭该文档 → 触发**单文档扫描** → 结果把其它文档的 VTODO 全删了。
  const rows = [];
  const items = [];
  // 3 篇文档，每篇 2 个任务块
  for (let d = 1; d <= 3; d++) {
    for (let i = 1; i <= 2; i++) {
      const id = `d${d}b${i}`;
      rows.push(fakeBlock(id, `任务${id}`, "20260101000000", { root_id: `doc${d}` }));
      items.push(mappedItem({ uid: `u-${id}`, blockId: id, summary: `[文档]任务${id}`, blockText: `任务${id}` }));
    }
  }
  // 用户在 doc1 里删掉了 d1b1 这个**块**（它已不在 rows 里 —— 块从数据库消失），
  // 但它对应的 VTODO **映射还在** store 里 —— 这正是「该删 VTODO」的场景。
  rows.splice(0, 1);
  // ⚠️ items 里**不能**删 d1b1 的映射：映射还在 = 需要判生死 = 该删它的 VTODO。

  const { res, sync } = await runOnce({
    items,
    rows,
    docIds: ["doc1"], // ← 关闭 doc1 → 单文档扫描
    full: true
  });

  assert.strictEqual(res.deleted, 1, `只该删 d1b1 一条，实际删了 ${res.deleted} 条`);
  assert.strictEqual(sync.out.removed.length, 1, "只该移除一条 VTODO");
  assert.strictEqual(sync.out.removed[0].blockId, "d1b1", "删的必须是本文档里被删掉的那个块");
  // 其它 4 条（doc2/doc3 的）必须原封不动
  const removedIds = sync.out.removed.map((x) => x.blockId);
  for (const keep of ["d1b2", "d2b1", "d2b2", "d3b1", "d3b2"]) {
    assert.ok(!removedIds.includes(keep), `${keep} 还在数据库里，不该被删`);
  }
});

check("★单文档扫描：本文档里「还在但没改动」的块也不能被删", async () => {
  const rows = [
    fakeBlock("d1b1", "保留", "20260101000000", { root_id: "doc1" }),
    fakeBlock("d2b1", "别的文档", "20260101000000", { root_id: "doc2" })
  ];
  const items = [
    mappedItem({ uid: "u1", blockId: "d1b1", summary: "[文档]保留", blockText: "保留" }),
    mappedItem({ uid: "u2", blockId: "d2b1", summary: "[文档]别的文档", blockText: "别的文档" })
  ];
  const { res, sync } = await runOnce({ items, rows, docIds: ["doc1"], full: true });
  assert.strictEqual(res.deleted, 0, "两个块都还在，一条都不该删");
  assert.strictEqual(sync.out.removed.length, 0);
});

check("★单文档扫描：本文档里被删的块要真删（别把真删除也一起放过）", async () => {
  const rows = [fakeBlock("d1b1", "还在的", "20260101000000", { root_id: "doc1" })];
  const items = [
    mappedItem({ uid: "u1", blockId: "d1b1", summary: "[文档]还在的", blockText: "还在的" }),
    mappedItem({ uid: "u2", blockId: "d1b2", summary: "[文档]被删的", blockText: "被删的" })
  ];
  const { res, sync } = await runOnce({ items, rows, docIds: ["doc1"], full: true });
  assert.strictEqual(res.deleted, 1, "d1b2 块已不存在 → 该删它的 VTODO");
  assert.strictEqual(sync.out.removed[0].blockId, "d1b2");
});

check("★查存在性失败（内核报错）→ 本轮一条都不能删（查询失败 ≠ 块没了）", async () => {
  const rows = [fakeBlock("b1", "甲", "20260101000000")];
  // ⚠️ 映射的块 b1 **本轮扫不到**（它在别的文档里）→ 才会走「查存在性」这条分支
  const items = [mappedItem({ blockId: "b1" })];
  const { res, sync } = await runOnce({
    items,
    rows,
    docIds: ["doc1"], // 只扫 doc1（b1 在 doc2）→ b1 落入 missing → 触发存在性查询
    full: true,
    // 假内核：存在性查询直接报错（内核返回 code!=0）
    wrapCaller: (base) => async (url, body) => {
      if (url === "/api/query/sql" && /SELECT id FROM blocks/.test(body.stmt)) {
        return { code: 1, msg: "boom", data: null };
      }
      return base(url, body);
    }
  });
  assert.strictEqual(res.deleted, 0, "查失败时删任何一条都是灾难");
  assert.strictEqual(sync.out.removed.length, 0);
  assert.ok(res.errors.some((e) => /存在性/.test(e)), "应报告存在性查询失败");
});

check("★白名单漏了也不该删（checked 双重保险：没查过存在性的块一律不动）", () => {
  // 直接调规划层：existing 传空（模拟白名单算错），checked 传空 → 一个都不该删
  const plan = bt.planBlockSync([], [mappedItem({ blockId: "b1" })], settings(), {
    existing: new Set(),
    checked: new Set()
  });
  assert.strictEqual(plan.deletions.length, 0, "没查过存在性的块不能进删除队列");
  // checked 有它、existing 没有它 → 该删（这才是「查过了，确实没了」）
  const plan2 = bt.planBlockSync([], [mappedItem({ blockId: "b1" })], settings(), {
    existing: new Set(),
    checked: new Set(["b1"])
  });
  assert.strictEqual(plan2.deletions.length, 1, "查过存在性且确认没了 → 该删");
});

section("[blockscan] ⑨ 完成态回写的方向性（2026-11-01 改为如实双向）");

// ★ 历史（2026-10-30）：用户「AI开发」文档里 60 个已勾选的任务块一夜之间全被拍成 "- [ ]"。
//   当时归因成「Baikal 把 COMPLETED 降级回 NEEDS-ACTION」，于是加了两道单向保险：
//     ① 对账层：服务端只能把块「往前推」，未完成永不取消块上的勾；
//     ② store 层：本地记着已完成、服务端说未完成 → 强行改回 COMPLETED。
//
// ⚠️ 那个归因是**错的**（2026-10-30 实测证伪，别再写回去）：Baikal 完整保留
//    STATUS:COMPLETED（新建→GET / 改回→GET / 等 3 秒→GET 四轮往返全对；199 条
//    COMPLETED 逐条 GET 与 REPORT 双路径读回一致）。那 8 条「本地 COMPLETED / raw 里
//    NEEDS-ACTION」是本地**陈旧 raw 快照**（上传成功也不刷新），不是服务端内容。
//    真因：插件 PUT 带 `If-Match: <本地 etag>` → 服务端已被别的客户端改过 → 返 **412**
//    → 按冲突策略（server）丢弃本地改动 → 完成态被覆盖。
//
//   真因既已定位，那两道保险就只剩坏处（把「别的客户端取消完成」这条正当链路永久挡住），
//   2026-11-01 按雄哥要求移除，改成**如实双向**；误改的兜底换成**改动数量告警**
//   （见 ⑩：一轮改动超过阈值就弹窗让用户确认）。
const checkedRow = (id, text) => fakeBlock(id, text, "20260101000000", { markdown: `- [X] ${text}` });
const blockTask = (id, text, checked, state) => ({
  id,
  text,
  markdown: checked ? `- [X] ${text}` : `- [ ] ${text}`,
  checked,
  // 四态（待办/进行中/完成/放弃）—— 不显式给 state 时按 checked 推导
  state: state ?? (checked ? "done" : "todo"),
  marker: checked ? "X" : " ",
  rootId: "doc1",
  box: "box1",
  hpath: "/测试"
});

check("★服务端说未完成、块已勾选 → 如实回写取消勾选（双向，2026-11-01）", async () => {
  const rows = [checkedRow("b1", "买牛奶")];
  const items = [
    mappedItem({ blockId: "b1", blockText: "买牛奶", blockChecked: true, status: "NEEDS-ACTION", percent: 0 })
  ];
  const { res, writes } = await runOnce({
    rows,
    items,
    full: true,
    // 阈值给大一点，避免弹窗路径影响本用例（告警单独在 ⑩ 测）
    settings: settings({ blockSyncChangeAlert: 999 })
  });
  assert.strictEqual(res.written, 1, "服务端未完成 → 块该被如实取消勾选");
  assert.ok(/^- \[ \]/.test(writes[0].data || ""), "回写内容应是未勾选态");
});

check("反向能力不能坏：服务端说已完成、块还没勾 → 仍要回写把块勾上", async () => {
  const rows = [fakeBlock("b1", "买牛奶", "20260101000000")]; // markdown = "- [ ] 买牛奶"
  const items = [
    mappedItem({ blockId: "b1", blockText: "买牛奶", blockChecked: false, status: "COMPLETED", percent: 100 })
  ];
  const { res, writes } = await runOnce({ rows, items, full: true });
  assert.strictEqual(res.written, 1, "服务端完成了，块该被勾上");
  assert.ok(/^- \[X\]/.test(writes[0].data || ""), "回写内容应是勾选态");
});

check("不再有「只许勾上」的方向保险：两个方向都通（2026-11-01 移除单向保险）", () => {
  const st = settings();
  const down = bt.planBlockSync(
    [blockTask("b1", "买牛奶", true)],
    [mappedItem({ blockId: "b1", blockText: "买牛奶", blockChecked: true, status: "NEEDS-ACTION", percent: 0 })],
    st,
    { conflict: "server", existing: new Set(), checked: new Set() }
  );
  assert.strictEqual(down.writebacks.length, 1, "服务端未完成 → 如实取消勾选");
  assert.strictEqual(down.writebacks[0].checked, false);
  const up = bt.planBlockSync(
    [blockTask("b1", "买牛奶", false)],
    [mappedItem({ blockId: "b1", blockText: "买牛奶", blockChecked: false, status: "COMPLETED", percent: 100 })],
    st,
    { conflict: "server", existing: new Set(), checked: new Set() }
  );
  assert.strictEqual(up.writebacks.length, 1, "服务端完成 → 如实勾上");
  assert.strictEqual(up.writebacks[0].checked, true);
});

check("漂移检测两个方向都认（服务端与缓存不一致就是漂移）", () => {
  const downgraded = mappedItem({
    blockId: "b1",
    blockText: "买牛奶",
    blockChecked: true,
    status: "NEEDS-ACTION",
    percent: 0
  });
  assert.strictEqual(
    bt.blockItemDrift(downgraded, settings()),
    true,
    "服务端取消完成 → 也是漂移，要按 ID 捞回来对账"
  );
  const serverDone = mappedItem({
    blockId: "b1",
    blockText: "买牛奶",
    blockChecked: false,
    status: "COMPLETED",
    percent: 100
  });
  assert.strictEqual(bt.blockItemDrift(serverDone, settings()), true, "服务端完成了、块没勾 → 该判漂移并回写");
  const same = mappedItem({
    blockId: "b1",
    blockText: "买牛奶",
    blockChecked: true,
    status: "COMPLETED",
    percent: 100
  });
  assert.strictEqual(bt.blockItemDrift(same, settings()), false, "两边一致 → 不漂移");
});

check("服务端说未完成 → 本地条目**以服务端为准**（不再自我保护完成态）", async () => {
  const real = new StoreMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  await real.load();
  real.put(
    mappedItem({
      uid: "u9",
      blockId: "b9",
      blockText: "买牛奶",
      blockChecked: true,
      status: "COMPLETED",
      percent: 100
    })
  );
  real.mergeServerItems([
    {
      uid: "u9",
      kind: "todo",
      calendarUrl: CAL,
      href: CAL + "c.ics",
      summary: "[文档]买牛奶",
      allDay: false,
      start: "2026-10-30T09:00:00",
      status: "NEEDS-ACTION",
      percent: 0,
      etag: "e9",
      blockId: "b9"
    }
  ]);
  const cur = real.get("u9");
  // 如实双向：服务端说未完成 → 本地就记未完成（不再自我保护），
  // 对账据此把块取消勾选；误改的兜底是执行层的「改动数量告警」。
  assert.strictEqual(cur.status, "NEEDS-ACTION", "服务端未完成 → 以服务端为准（不再强行改回 COMPLETED）");
  assert.strictEqual(cur.percent, 0);
  assert.strictEqual(cur.blockChecked, true, "对账缓存仍是上次同步时的块态（下一轮据此判漂移）");
});

section("[blockscan] ⑩ 改动数量告警（2026-11-01 取代单向保险的兜底）");

// 三个块都已映射，服务端状态与缓存不一致 → 3 条回写（服务端「未完成」→ 块取消勾选）
const alertRows = ["b1", "b2", "b3"].map((id) => checkedRow(id, "任务" + id.slice(-1)));
const alertItems = ["b1", "b2", "b3"].map((id) =>
  mappedItem({
    uid: "u-" + id,
    blockId: id,
    blockText: "任务" + id.slice(-1),
    blockChecked: true,
    status: "NEEDS-ACTION",
    percent: 0
  })
);

check("改动数 ≤ 阈值 → 不打扰用户（confirm 一次都不调）", async () => {
  let asked = 0;
  const { res } = await runOnce({
    rows: alertRows,
    items: alertItems,
    full: true,
    settings: settings({ blockSyncChangeAlert: 3 }),
    confirm: async () => {
      asked++;
      return true;
    }
  });
  assert.strictEqual(asked, 0, "3 条改动、阈值 3 → 不该弹窗");
  assert.strictEqual(res.written, 3, "照常执行");
});

check("改动数 > 阈值 → 先问用户；用户**取消**则一条都不动", async () => {
  let asked = null;
  const { res, store, sync, writes } = await runOnce({
    rows: alertRows,
    items: alertItems,
    full: true,
    settings: settings({ blockSyncChangeAlert: 2 }),
    confirm: async (info) => {
      asked = info;
      return false;
    }
  });
  assert.ok(asked, "必须弹窗询问");
  assert.strictEqual(asked.total, 3, "改动条数要如实告诉用户");
  assert.strictEqual(asked.written, 3);
  assert.strictEqual(asked.threshold, 2);
  assert.strictEqual(res.cancelled, true);
  assert.strictEqual(res.written, 0, "取消了就不能写块");
  assert.strictEqual(writes.length, 0, "一个 updateBlock 都不能发");
  assert.strictEqual(sync.out.created.length + sync.out.updated.length + sync.out.removed.length, 0, "服务端也不能动");
  assert.strictEqual(store.blockScanWatermark, undefined, "取消了连水位线都不推进");
});

check("用户在告警里点「继续」→ 照常执行", async () => {
  const { res, writes } = await runOnce({
    rows: alertRows,
    items: alertItems,
    full: true,
    settings: settings({ blockSyncChangeAlert: 1 }),
    confirm: async () => true
  });
  assert.strictEqual(res.cancelled, undefined);
  assert.strictEqual(res.written, 3);
  assert.strictEqual(writes.length, 3);
});

check("「仅补缓存」的推送不算改动（否则首次扫描必弹窗）", async () => {
  // 两边完全一致，但 store 里没记过 blockText/blockState → 只会补缓存
  const rows = [checkedRow("b1", "买牛奶")];
  const items = [
    mappedItem({
      blockId: "b1",
      blockText: undefined,
      blockChecked: undefined,
      blockState: undefined,
      status: "COMPLETED",
      percent: 100
    })
  ];
  let asked = null;
  const { res } = await runOnce({
    rows,
    items,
    full: true,
    settings: settings({ blockSyncChangeAlert: 0 }), // 阈值 0 = 有 1 条改动就问
    confirm: async (info) => {
      asked = info;
      return true;
    }
  });
  assert.strictEqual(asked, null, "补缓存不是改动，不该弹窗");
  assert.strictEqual(res.written, 0);
});

check("阈值留空（undefined）→ 不告警，直接执行", async () => {
  let asked = 0;
  const { res } = await runOnce({
    rows: alertRows,
    items: alertItems,
    full: true,
    settings: settings({ blockSyncChangeAlert: undefined }),
    confirm: async () => {
      asked++;
      return false; // 即便「拒绝」也不该被问到
    }
  });
  assert.strictEqual(asked, 0);
  assert.strictEqual(res.written, 3, "没配阈值就照常执行");
});

check("没注入 confirm（如无人值守的环境）→ 不卡住，照常执行", async () => {
  const { res } = await runOnce({
    rows: alertRows,
    items: alertItems,
    full: true,
    settings: settings({ blockSyncChangeAlert: 1 })
  });
  assert.strictEqual(res.cancelled, undefined);
  assert.strictEqual(res.written, 3);
});

await runAll();
