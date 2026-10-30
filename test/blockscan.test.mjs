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
    full: over.full
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

section("[blockscan] ⑨ 完成态回写的方向性（2026-10-30 用户实测踩中）");

// ★ 事故复现：
//   块在文档里是「已勾选」（markdown = "- [X] xxx"），
//   而服务端那条 VTODO 是「未完成」—— 实测 Baikal 会把 COMPLETED 降级回 NEEDS-ACTION，
//   store 里有 8 条「本地 COMPLETED / 服务端 raw 里 STATUS:NEEDS-ACTION」的活证据；
//   而 store 缓存里记着「块是勾选的」→ 旧逻辑判定成「服务端改了」→ 回写块取消勾选。
//   后果：用户 60 个已勾选的任务块被批量拍成 "- [ ]"。
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

check("★服务端说未完成、块已勾选 → 绝不回写取消勾选（主数据不许被派生数据覆盖）", async () => {
  const rows = [checkedRow("b1", "买牛奶")];
  const items = [
    mappedItem({ blockId: "b1", blockText: "买牛奶", blockChecked: true, status: "NEEDS-ACTION", percent: 0 })
  ];
  const { res, writes } = await runOnce({ rows, items, full: true });
  assert.strictEqual(res.written, 0, "不该有回写");
  assert.strictEqual(writes.length, 0, "绝不能调用 updateBlock 取消勾选");
  assert.strictEqual(res.updated, 1, "但要把完成态纠正回服务端（自愈）");
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

check("结构性保险：回写块只允许「勾上」，永不允许「取消勾选」", () => {
  const plan = bt.planBlockSync(
    [blockTask("b1", "买牛奶", true)],
    [mappedItem({ blockId: "b1", blockText: "买牛奶", blockChecked: true, status: "NEEDS-ACTION", percent: 0 })],
    settings(),
    { conflict: "server", existing: new Set(), checked: new Set() }
  );
  assert.strictEqual(plan.writebacks.length, 0, "不得回写取消勾选");
  for (const w of plan.writebacks) {
    assert.notStrictEqual(w.checked, false, "回写动作里不允许出现 checked=false");
  }
});

check("漂移检测只认「服务端完成、块未完成」这一个方向", () => {
  const downgraded = mappedItem({
    blockId: "b1",
    blockText: "买牛奶",
    blockChecked: true,
    status: "NEEDS-ACTION",
    percent: 0
  });
  assert.strictEqual(
    bt.blockItemDrift(downgraded, settings()),
    false,
    "服务端降级不该判成漂移（否则每轮都把所有条目捞回来对账）"
  );
  const serverDone = mappedItem({
    blockId: "b1",
    blockText: "买牛奶",
    blockChecked: false,
    status: "COMPLETED",
    percent: 100
  });
  assert.strictEqual(bt.blockItemDrift(serverDone, settings()), true, "服务端完成了、块没勾 → 该判漂移并回写");
});

check("服务端把完成态降级时，块来源条目保留本地完成态（不被污染）", async () => {
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
  assert.strictEqual(cur.status, "COMPLETED", "服务端降级不该污染本地完成态");
  assert.strictEqual(cur.percent, 100, "服务端降级不该污染本地完成态");
  assert.strictEqual(cur.blockChecked, true, "对账缓存也要保住");
});

await runAll();
