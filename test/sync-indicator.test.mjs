/**
 * 「同步中」可见状态回归测试（2026-10-25 雄哥要求）
 *
 * 背景：雄哥要求「日程、待办新建或编辑变动后立即向服务器提交时，刷新按钮
 * 也要转一下，示意该条目已同步到服务器；同步完停止转动，规矩跟手动点同步一样」。
 *
 * 此前的行为：只有手动点「立即同步」（syncAll）才置 store.syncing，
 * 「保存即推」（createItem/updateItem/removeItem → pushAndPersist）不置位
 * → 按钮不转，用户以为改动还没提交。
 *
 * 覆盖：
 *   1. 保存即推三条路径（新建/编辑/删除）期间 store.syncing === true
 *   2. 推送结束（含失败）后复位为 false —— 按钮不能永远转
 *   3. 手动 syncAll 同样置位/复位
 *   4. **引用计数**：syncAll 与保存即推并存时，先结束的那条不抹掉另一条的转动
 *   5. 源码级断言：按钮 class 由 store.syncing 单一来源驱动（响应式），
 *      且不受 suppressRerender 抑制（快速勾选那条路径也要转）
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-syncindicator");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts src/core/store.ts src/core/sync.ts src/core/secret.ts ` +
  `--outDir .test-syncindicator --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "pipe" }
);

const require = createRequire(import.meta.url);
const storeMod = require(path.join(outDir, "store.js"));
const syncMod = require(path.join(outDir, "sync.js"));

let passed = 0;
const t = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n    ", e.message);
    process.exitCode = 1;
  }
};

// ---- 假 fetch ----
const fakeRes = (status, body = "", headers = {}) => ({
  status,
  text: async () => body,
  headers: { forEach: (fn) => Object.entries(headers).forEach(([k, v]) => fn(v, k)) }
});

function withFetch(router) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const req = { url: String(url), method: init?.method || "GET", body: String(init?.body || "") };
    calls.push(req);
    const r = router(req);
    return fakeRes(r.status, r.body ?? "", r.headers);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

/** 让出事件循环：确保已启动的推送真的把请求发出去了 */
const tick = () => new Promise((r) => setTimeout(r, 0));

const CAL_URL = "http://dav.test/cal/";
const cal = { url: CAL_URL, displayName: "工作", enabled: true, supportsEvent: true, supportsTodo: true };

async function mkStore(items = [], settings = {}) {
  const st = new storeMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  await st.load();
  st.settings = {
    ...st.settings,
    serverUrl: "http://dav.test/",
    username: "u",
    password: "p",
    calendars: [{ ...cal }],
    conflict: "server",
    syncIntervalMin: 0,
    ...settings
  };
  items.forEach((it) => st.put(it));
  return st;
}

const mkItem = (over = {}) => ({
  uid: "u1@test",
  kind: "todo",
  calendarUrl: CAL_URL,
  href: CAL_URL + "u1.ics",
  summary: "待办",
  allDay: false,
  start: "",
  end: "",
  dirty: true, // 默认造脏条目 → 会走推送
  ...over
});

/** 默认路由：PUT 成功（新条目无 etag → 直接 PUT），其余 200 */
const okRouter = () => (req) => {
  if (req.method === "PUT") return { status: 204, body: "" };
  return { status: 200, body: "" };
};

/**
 * 记录 PUT/DELETE 发出时的 syncing 快照。
 *
 * ⚠️ 断言必须**事后**做，不能在 fetch 桩里当场 assert：桩里抛出的错误会被
 * pushDirty 的 catch 吞掉（记进 report.errors），用例表面「通过」——假阴性。
 * 快照 + 事中断言才可靠（Obsidian 端同款，2026-10-25 实测过这个坑）。
 */
function recordSyncing(st, base) {
  const seen = [];
  return {
    seen,
    router: (req) => {
      const syncing = st.syncing; // 先快照，再放行请求
      const r = base(req);
      if (req.method === "PUT" || req.method === "DELETE") seen.push({ method: req.method, syncing });
      return r;
    }
  };
}

console.log("[sync-indicator] 保存即推也要置「同步中」");

await t("新建条目推送期间 store.syncing === true，结束后 false", async () => {
  const st = await mkStore();
  const rec = recordSyncing(st, okRouter());
  const { restore } = withFetch(rec.router);
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.createItem(mkItem({ uid: "new@test" }));
    assert.ok(rec.seen.length > 0, "应发生过 PUT");
    assert.strictEqual(rec.seen[0].syncing, true, "推送期间 syncing 应为 true");
    assert.strictEqual(st.syncing, false, "推送结束后应复位");
  } finally {
    restore();
  }
});

await t("编辑条目推送期间置位、结束复位", async () => {
  const st = await mkStore([mkItem({ uid: "e@test", etag: '"e1"' })]);
  const rec = recordSyncing(st, okRouter());
  const { restore } = withFetch(rec.router);
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const it = st.get("e@test");
    it.summary = "改过的标题";
    await eng.updateItem(it);
    assert.ok(rec.seen.length > 0, "应发生过 PUT");
    assert.strictEqual(rec.seen[0].syncing, true, "推送期间应置位");
    assert.strictEqual(st.syncing, false, "推送结束后应复位");
    assert.strictEqual(it.summary, "改过的标题");
  } finally {
    restore();
  }
});

await t("删除条目推送期间置位、结束复位", async () => {
  const st = await mkStore([mkItem({ uid: "d@test", etag: '"e1"' })]);
  const rec = recordSyncing(st, okRouter());
  const { restore } = withFetch(rec.router);
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.removeItem(st.get("d@test"));
    assert.ok(rec.seen.length > 0, "应发生过 DELETE");
    assert.strictEqual(rec.seen[0].syncing, true, "推送期间应置位");
    assert.strictEqual(st.syncing, false, "推送结束后应复位");
  } finally {
    restore();
  }
});

await t("推送失败（PUT 500）也要复位 —— 按钮不能永远转下去", async () => {
  const st = await mkStore();
  const { restore } = withFetch((req) => (req.method === "PUT" ? { status: 500, body: "boom" } : { status: 200, body: "" }));
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.createItem(mkItem({ uid: "fail@test" }));
    assert.strictEqual(st.syncing, false, "失败也必须复位");
    assert.ok(st.lastError, "失败应留下错误提示");
  } finally {
    restore();
  }
});

console.log("[sync-indicator] 手动 syncAll 的置位/复位（原有规矩不变）");

await t("syncAll 期间置位、结束复位", async () => {
  const st = await mkStore();
  // 同上：快照而非当场断言（syncAll 的 PROPFIND/REPORT 冒泡同样会被吞）
  const seen = [];
  const { restore } = withFetch((req) => {
    const syncing = st.syncing;
    if (req.method !== "PUT") seen.push(syncing);
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.syncAll();
    assert.ok(seen.length > 0, "应发过非 PUT 请求");
    assert.strictEqual(seen[0], true, "同步期间 syncing 应为 true");
    assert.strictEqual(st.syncing, false, "同步结束后应复位");
  } finally {
    restore();
  }
});

console.log("[sync-indicator] 引用计数：并发的两条路径互不抹掉");

await t("syncAll 与保存即推并存：先结束的那条不抹掉另一条的转动", async () => {
  const st = await mkStore([mkItem({ uid: "c@test", etag: '"e1"' })]);
  // 闸门：PUT 先挂起，等两条路径都启动后再放行
  let releasePut = () => {};
  const putGate = new Promise((r) => (releasePut = r));
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = init?.method || "GET";
    if (method === "PUT") await putGate; // 挂住，直到外部放行
    return fakeRes(method === "PUT" ? 204 : 200, "");
  };
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const it = st.get("c@test");
    it.summary = "并存测试";

    // 路径 ①：保存即推（PUT 会被闸门挂住）
    const p1 = eng.updateItem(it);
    await tick();
    assert.strictEqual(st.syncing, true, "保存即推已启动 ⇒ 应置位");

    // 路径 ②：手动全量同步（第一步推送排在 ① 后面，但 beginSyncing 立即生效）
    const p2 = eng.syncAll();
    assert.strictEqual(st.syncing, true, "两条路径并存 ⇒ 仍应置位");

    // 放行 ①：它的 endSyncing 只把计数从 2 减到 1，**不能**复位
    releasePut();
    await p1;
    assert.strictEqual(st.syncing, true, "① 已结束但 ② 还在跑 ⇒ 必须继续转（这条是本次改动的核心）");

    // ② 收尾后才能真正复位
    await p2;
    assert.strictEqual(st.syncing, false, "两条都结束 ⇒ 复位");
  } finally {
    globalThis.fetch = orig;
  }
});

await t("syncing 不落盘（瞬时状态不该写进数据文件）", async () => {
  const st = await mkStore();
  const saved = [];
  st.env = { loadData: async () => undefined, saveData: async (d) => { saved.push(d); } };
  const { restore } = withFetch(okRouter());
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.createItem(mkItem({ uid: "p@test" }));
    assert.ok(saved.length > 0, "应发生过落盘");
    for (const d of saved) {
      assert.ok(!("syncing" in d), "顶层不该有 syncing");
      assert.ok(!(d.sync && "syncing" in d.sync), "sync 段不该有 syncing");
    }
  } finally {
    restore();
  }
});

console.log("[sync-indicator] 源码级断言：按钮由 store.syncing 单一来源驱动");

await t("panel.ts：onChange 里按 store.syncing 切 is-syncing，且不受 suppress 抑制", async () => {
  const src = fs.readFileSync(path.join(root, "src/ui/panel.ts"), "utf8");
  assert.ok(
    /syncBtn\.classList\.toggle\("is-syncing", !!ctx\.store\.syncing\)/.test(src),
    "onChange 应响应式切 is-syncing"
  );
  // 手动加/减 class 的旧写法必须去掉（否则两条路径并存时会互相抹掉）
  assert.ok(!/syncBtn\.classList\.add\("is-syncing"\)/.test(src), "不应再手动加 class");
  assert.ok(!/syncBtn\.classList\.remove\("is-syncing"\)/.test(src), "不应再手动减 class");
  // 必须挂在 suppressRerender 判断**之前**（快速勾选那条路径也要转）
  // ⚠️ 仓库是 CRLF，行尾禁写死 \n（用 \s* 兼容）；且注释里也出现
  // "suppressRerender" 字样，必须锚定到真正的判断语句 `if (!suppressRerender)`。
  const m = /const unsub = ctx\.store\.onChange\(\(\) => \{([\s\S]*?)\}\);\s*renderAll\(\);/.exec(src);
  assert.ok(m, "应能找到 onChange 订阅块");
  const body = m[1];
  assert.ok(
    body.indexOf('classList.toggle("is-syncing"') < body.indexOf("if (!suppressRerender)"),
    "is-syncing 的同步必须在 suppressRerender 判断之前（勾选路径不被抑制）"
  );
});

await t("sync.ts：保存即推入口置位（beginSyncing）", async () => {
  const src = fs.readFileSync(path.join(root, "src/core/sync.ts"), "utf8");
  assert.ok(/private syncDepth = 0;/.test(src), "应有引用计数");
  assert.ok(/private beginSyncing\(\)/.test(src), "应有 beginSyncing");
  assert.ok(/private endSyncing\(\)/.test(src), "应有 endSyncing");
  // doPushAndPersist（保存即推）里必须调 beginSyncing
  const m = /private async doPushAndPersist\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(m, "应能找到 doPushAndPersist");
  assert.ok(/this\.beginSyncing\(\)/.test(m[1]), "保存即推必须置位 syncing");
  assert.ok(/this\.endSyncing\(\)/.test(m[1]), "保存即推必须复位 syncing");
});

console.log(`\n[sync-indicator] 通过 ${passed} 项`);
process.exit(process.exitCode ?? 0);
