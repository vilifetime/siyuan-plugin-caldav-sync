/**
 * 「幽灵条目对账」回归测试
 *
 * 背景（2026-10-08 实测）：思源里新建的一条任务在 Obsidian 永远看不到。
 * 根因不是上传失败，而是本地条目 `etag` 有值 ⇒ `dirty=false` ⇒ `pushDirty` 永不挑它；
 * 同时 `mergeServerItems` 只在 `deletedKeys` 里删本地，而 `deletedKeys` **只有增量
 * sync-collection 路径才产出**，全量回退时恒为空。于是服务端删掉的条目在本地永久残留。
 *
 * 覆盖：
 *   1. fileNameOf 的 basename 归一化（服务端给路径、本地存完整 URL，不归一化永远比不上）
 *   2. listResourceNames 的 207 解析（带命名空间 / 不带 / 非 .ics / 集合自身都要处理）
 *   3. 服务端优先 → 删本地；本地优先 → 置脏重传
 *   4. 三条安全约束：清单拿不到 → 跳过；清单空而本地有 → 跳过；脏条目不动
 *   5. 源码级断言，防止后续改 sync.ts 时把对账悄悄摘掉
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-reconcile");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts src/core/store.ts src/core/sync.ts src/core/secret.ts ` +
  `--outDir .test-reconcile --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
const caldav = require(path.join(outDir, "caldav.js"));
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

// ---- 假 fetch：按 method / body 分流 ----
/** 造一个最小的 Response 替身（viaDirect 只用到 status / text() / headers.forEach） */
const fakeRes = (status, body, headers = {}) => ({
  status,
  text: async () => body,
  headers: { forEach: (fn) => Object.entries(headers).forEach(([k, v]) => fn(v, k)) }
});

const multistatus = (hrefs) =>
  `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
  hrefs
    .map(
      (h) =>
        `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:getetag>"etag-${h}"</D:getetag></D:prop>` +
        `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    )
    .join("") +
  `</D:multistatus>`;

/**
 * @param {(req:{method:string,body:string,url:string}) => {status:number,body:string,headers?:object}} router
 */
function withFetch(router) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const req = { url: String(url), method: init?.method || "GET", body: String(init?.body || "") };
    const r = router(req);
    return fakeRes(r.status, r.body ?? "", r.headers);
  };
  return () => {
    globalThis.fetch = orig;
  };
}

/** 把一次请求打日志，便于断言「对账确实只发了一次 PROPFIND」 */
function withFetchLog(router) {
  const calls = [];
  const restore = withFetch((req) => {
    calls.push(req);
    return router(req);
  });
  return { calls, restore };
}

const CAL_URL = "http://dav.test/cal/";
const OTHER_URL = "http://dav.test/other/";
const cal = { url: CAL_URL, displayName: "工作", color: "#3b82f6", enabled: true, supportsEvent: true, supportsTodo: true };

const mkItem = (over) => ({
  uid: "u1@test",
  kind: "todo",
  calendarUrl: CAL_URL,
  href: CAL_URL + "u1.ics",
  summary: "待办",
  allDay: false,
  start: "",
  end: "",
  etag: '"server-etag"',
  dirty: false,
  ...over
});

async function mkStore(items, settings = {}) {
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

console.log("[reconcile] fileNameOf：服务端给路径、本地存完整 URL，必须归一化到同一个 basename");

await t("完整 URL / 纯路径 / 末尾斜杠 → 同一个文件名", () => {
  assert.strictEqual(caldav.fileNameOf("http://dav.test/cal/u1.ics"), "u1.ics");
  assert.strictEqual(caldav.fileNameOf("/dav/cal/u1.ics"), "u1.ics");
  // 集合自身的 href 取到的是目录名 —— 反正不以 .ics 结尾，会被清单过滤掉
  assert.strictEqual(caldav.fileNameOf("http://dav.test/cal/"), "cal");
  assert.strictEqual(caldav.fileNameOf(""), "", "空串不能抛错");
});

await t("URL 转义要还原（服务端常用 %40 表示 @）", () => {
  assert.strictEqual(caldav.fileNameOf("http://dav.test/cal/a%40b.ics"), "a@b.ics");
  assert.strictEqual(caldav.fileNameOf("/dav/cal/%E4%B8%AD%E6%96%87.ics"), "中文.ics");
});

await t("畸形转义不能直接抛错把整轮对账搞挂", () => {
  assert.strictEqual(caldav.fileNameOf("/dav/cal/%E0%A4%A.ics"), "%E0%A4%A.ics", "解不开时退回原文");
});

console.log("[reconcile] listResourceNames：207 清单解析");

await t("带/不带命名空间前缀的 href 都要认，非 .ics 与集合自身要滤掉", async () => {
  const restore = withFetch(() => ({
    status: 207,
    body: multistatus(["/dav/cal/", "/dav/cal/alive.ics", "/dav/cal/readme.txt"]).replace(
      "<D:href>/dav/cal/alive.ics</D:href>",
      "<href>/dav/cal/alive.ics</href>"
    )
  }));
  try {
    const names = await caldav.listResourceNames(cal, "direct", { username: "u", password: "p" });
    assert.deepStrictEqual(names.sort(), ["alive.ics"], "实际 " + JSON.stringify(names));
  } finally {
    restore();
  }
});

await t("清单请求失败必须抛错（绝不能被上层当成「服务端为空」）", async () => {
  const restore = withFetch((req) => ({
    status: req.method === "PROPFIND" ? 500 : 207,
    body: ""
  }));
  try {
    await assert.rejects(
      () => caldav.listResourceNames(cal, "direct", { username: "u", password: "p" }),
      (e) => e.status === 500 || /500/.test(e.message),
      "应抛出带状态码的错误"
    );
  } finally {
    restore();
  }
});

console.log("[reconcile] 对账主流程（服务端优先 → 删本地）");

await t("幽灵条目被清掉，服务端仍有的与无关条目不动", async () => {
  const ghost = mkItem({ uid: "ghost@test", href: CAL_URL + "ghost.ics", summary: "幽灵" });
  const alive = mkItem({ uid: "alive@test", href: CAL_URL + "alive.ics", summary: "还在" });
  const foreign = mkItem({ uid: "foreign@test", calendarUrl: OTHER_URL, href: OTHER_URL + "foreign.ics", summary: "别的日历" });
  const st = await mkStore([ghost, alive, foreign]);

  const { restore } = withFetchLog((req) => {
    if (req.method === "REPORT") return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/alive.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.reconciled, 1, "应清理 1 条，实际 " + rep.reconciled);
    assert.strictEqual(rep.requeued, 0);
    const uids = st.getAll().map((i) => i.uid);
    assert.ok(!uids.includes("ghost@test"), "幽灵条目应被清掉，实际剩 " + JSON.stringify(uids));
    assert.ok(uids.includes("alive@test"), "服务端还存在的必须保留");
    assert.ok(uids.includes("foreign@test"), "别的日历的条目不受本轮对账影响");
    // 2026-10-10 起：对账提示走 lastNote 中性通道，**不进 lastError**
    // （原先塞进 lastError 会让状态栏显示「同步失败」，把成功同步报成失败）
    assert.ok(/对账：已清理 1 条/.test(st.lastNote || ""), "清理动作要让用户看得见，实际 lastNote=" + st.lastNote);
    assert.strictEqual(st.lastError, undefined, "对账不是错误，lastError 必须为空，实际=" + st.lastError);
    assert.strictEqual(rep.deleted, 1, "本地少了一条，删除计数应为 1，实际 " + rep.deleted);
  } finally {
    restore();
  }
});

await t("已标记删除 / 无 href / 脏的条目一律不参与对账", async () => {
  const gone = mkItem({ uid: "gone@test", href: CAL_URL + "gone.ics", deleted: true, summary: "本地已删" });
  const noHref = mkItem({ uid: "nohref@test", href: "", summary: "还没上传过" });
  const dirty = mkItem({ uid: "dirty@test", href: CAL_URL + "dirty.ics", dirty: true, summary: "待上传" });
  const st = await mkStore([gone, noHref, dirty]);

  // PUT / DELETE 故意返回 500 —— 脏条目上传失败就会保持 dirty，
  // 已删除条目也走不到服务端，正好验证它们都不会被「对账」这条路径动到
  const restore = withFetch((req) => {
    if (req.method === "REPORT") return { status: 207, body: multistatus([]) };
    if (req.method === "PUT" || req.method === "DELETE") return { status: 500, body: "" };
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/nothing.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.reconciled, 0, "三条都不该被当成幽灵清掉，实际 " + rep.reconciled);
    const uids = st.getAll().map((i) => i.uid).sort();
    // gone@test 不在里面是另一条路径干的：mergeServerItems 收尾会扫掉
    // 「已标记删除且不脏」的条目。这里要保证的是**它没被计进 reconciled**。
    assert.deepStrictEqual(uids, ["dirty@test", "nohref@test"]);
  } finally {
    restore();
  }
});

console.log("[reconcile] 本地优先 → 置脏重传，而不是删掉");

await t("conflict=local 时把丢失的条目重新排队上传", async () => {
  const ghost = mkItem({ uid: "ghost@test", href: CAL_URL + "ghost.ics", summary: "服务端弄丢了" });
  const st = await mkStore([ghost], { conflict: "local" });
  const restore = withFetch((req) => {
    if (req.method === "REPORT") return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
    // 清单里放一条别的资源，保证「非空」—— 空清单会触发「查错地方 → 跳过」那条约束
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/someone-else.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.requeued, 1, "应重新排队 1 条，实际 " + rep.requeued);
    assert.strictEqual(rep.reconciled, 0);
    const left = st.getAll().find((i) => i.uid === "ghost@test");
    assert.ok(left, "本地条目必须还在");
    assert.strictEqual(left.dirty, true, "应被置脏，下一轮 pushDirty 才会带上它");
    assert.ok(/重新上传/.test(st.lastNote || ""), "实际 lastNote=" + st.lastNote);
    assert.strictEqual(st.lastError, undefined, "对账不是错误，lastError 必须为空，实际=" + st.lastError);
  } finally {
    restore();
  }
});

console.log("[reconcile] 三条安全约束（宁可漏判，不可误删）");

await t("清单拿不到（PROPFIND 500）→ 整轮跳过，本地一条不动", async () => {
  const ghost = mkItem({ uid: "ghost@test", href: CAL_URL + "ghost.ics" });
  const st = await mkStore([ghost]);
  const restore = withFetch((req) => {
    if (req.method === "REPORT") return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND") return { status: 500, body: "" };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.reconciled, 0, "拿不到清单不能清任何东西，实际 " + rep.reconciled);
    assert.strictEqual(st.getAll().length, 1, "本地条目必须原样保留");
  } finally {
    restore();
  }
});

await t("清单为空而本地有条目 → 判定为「查错地方」，跳过", async () => {
  const ghost = mkItem({ uid: "ghost@test", href: CAL_URL + "ghost.ics" });
  const st = await mkStore([ghost]);
  const restore = withFetch((req) => {
    if (req.method === "REPORT") return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND") return { status: 207, body: multistatus([]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.reconciled, 0, "空清单 + 本地有条目 = 多半打偏了，绝不能清空本地");
    assert.strictEqual(st.getAll().length, 1);
  } finally {
    restore();
  }
});

await t("对账只发一次清单请求，且不影响 fetched / uploaded 计数", async () => {
  const st = await mkStore([mkItem({ uid: "a@test", href: CAL_URL + "a.ics" })]);
  const { calls, restore } = withFetchLog((req) => {
    if (req.method === "REPORT") return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/a.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    const lists = calls.filter((c) => c.method === "PROPFIND" && /getetag/.test(c.body));
    assert.strictEqual(lists.length, 1, "对账清单请求应恰好一次，实际 " + lists.length);
    assert.strictEqual(rep.reconciled, 0, "服务端有就不用清");
    assert.strictEqual(rep.fetched, 0);
    assert.strictEqual(rep.uploaded, 0);
  } finally {
    restore();
  }
});

console.log("[reconcile] 源码级断言（防止后续重构把对账悄悄摘掉）");

const srcSync = fs.readFileSync(path.join(root, "src/core/sync.ts"), "utf8");
const srcCaldav = fs.readFileSync(path.join(root, "src/core/caldav.ts"), "utf8");
const srcStore = fs.readFileSync(path.join(root, "src/core/store.ts"), "utf8");
const srcTypes = fs.readFileSync(path.join(root, "src/core/types.ts"), "utf8");
const srcPanel = fs.readFileSync(path.join(root, "src/ui/panel.ts"), "utf8");

await t("syncAll 每个日历拉取成功后都要调 reconcile", () => {
  assert.ok(/await this\.reconcile\(cal, report\)/.test(srcSync), "缺 reconcile 调用");
  // 必须放在 mergeServerItems 之后：先合并再对账，否则会把刚拉到的新条目误判成幽灵
  const iMerge = srcSync.indexOf("mergeServerItems(items, deletedKeys)");
  const iRecon = srcSync.indexOf("await this.reconcile(cal, report)");
  assert.ok(iMerge > 0 && iRecon > iMerge, "reconcile 必须排在 mergeServerItems 之后");
});

await t("三条安全约束都写在源码里", () => {
  assert.ok(/if \(!onServer\.size && candidates\.length\)/.test(srcSync), "缺「清单为空而本地有条目 → 跳过」");
  assert.ok(/!it\.dirty/.test(srcSync), "缺「只处理不脏条目」");
  assert.ok(/!it\.deleted/.test(srcSync), "缺「跳过已标记删除的条目」");
  assert.ok(/catch \(e: any\)[\s\S]{0,200}return;/.test(srcSync.slice(srcSync.indexOf("listResourceNames("))), "清单拿不到要静默跳过而不是抛出去");
});

await t("冲突策略两个分支都在，且默认不是「删本地」以外的隐式行为", () => {
  assert.ok(/conflict === "local"/.test(srcSync), "缺本地优先分支");
  assert.ok(/report\.requeued\+\+/.test(srcSync), "本地优先要计数");
  assert.ok(/this\.store\.remove\(keyOf\(it\)\)/.test(srcSync), "服务端优先要真的删本地");
  assert.ok(/report\.reconciled\+\+/.test(srcSync), "服务端优先要计数");
});

await t("SyncReport 必须带 reconciled / requeued，三处构造都要补齐", () => {
  assert.ok(/reconciled: number/.test(srcSync) && /requeued: number/.test(srcSync), "报告字段缺失");
  const ctors = srcSync.match(/reconciled: 0/g) || [];
  assert.strictEqual(ctors.length, 3, "三处 SyncReport 字面量都要补字段，实际 " + ctors.length);
});

await t("pushAndPersist 明确不做对账（刚建的条目还没进服务端清单）", () => {
  const i = srcSync.indexOf("private async pushAndPersist");
  const body = srcSync.slice(i, i + 900);
  assert.ok(/不做对账/.test(body), "pushAndPersist 里要写明为什么不做对账");
  assert.ok(!/this\.reconcile\(/.test(body), "pushAndPersist 里不许调 reconcile");
});

await t("caldav.ts 暴露 fileNameOf / listResourceNames 且用 Depth:1 取全量", () => {
  assert.ok(/export function fileNameOf/.test(srcCaldav));
  assert.ok(/export async function listResourceNames/.test(srcCaldav));
  const i = srcCaldav.indexOf("export async function listResourceNames");
  const body = srcCaldav.slice(i, i + 900);
  assert.ok(/Depth: "1"/.test(body), "必须 Depth:1 才能拿到集合内全部资源");
  assert.ok(/\.ics\$/i.test(body), "只要 .ics，集合自身与非日历文件要滤掉");
});

// ---- 2026-10-10 实测回归：思源删一条 → Obsidian 同步显示「删除 0 条」，
//      且 Obsidian 侧报「同步失败：对账：已清理 1 条…」。思源侧是同构代码，同样要修。 ----

await t("服务端删除要计入 report.deleted（否则用户以为删除没同步过来）", () => {
  assert.ok(
    /report\.deleted \+= this\.store\.mergeServerItems\(items, deletedKeys\)\.removed/.test(srcSync),
    "mergeServerItems 的 removed 返回值必须累加进 report.deleted"
  );
  const recon = srcSync.slice(srcSync.indexOf("private async reconcile"), srcSync.indexOf("private async pushDirty"));
  assert.ok(
    /report\.reconciled\+\+;[\s\S]{0,200}?report\.deleted\+\+/.test(recon),
    "对账清理的条目也要计入 report.deleted（否则仍是「删除 0 条」）"
  );
});

await t("mergeServerItems 返回 removed 计数（store 侧真的实现了吗）", () => {
  assert.ok(
    /mergeServerItems\(incoming: CalItem\[\], deletedKeys: string\[\] = \[\]\): \{ changed: boolean; removed: number \}/.test(
      srcStore
    ),
    "签名要改成返回 { changed, removed }"
  );
  const body = srcStore.slice(srcStore.indexOf("mergeServerItems(incoming"));
  assert.ok(/let removed = 0/.test(body), "要有 removed 计数");
  assert.ok(
    /this\.items\.delete\(key\);\s*changed = true;\s*removed\+\+/.test(body),
    "deletedKeys 命中时必须 removed++"
  );
  assert.ok(/return \{ changed, removed \}/.test(body), "要返回 removed");
});

await t("对账提示走 lastNote 中性通道，绝不塞进 lastError", () => {
  assert.ok(/this\.store\.lastNote = notes\.join\("; "\) \|\| undefined/.test(srcSync), "对账提示要写 lastNote");
  assert.ok(
    /this\.store\.lastError = report\.errors\.join\("; "\) \|\| undefined/.test(srcSync),
    "lastError 只装真错误"
  );
  assert.ok(
    !/lastError = \[\.\.\.report\.errors, \.\.\.notes\]/.test(srcSync),
    "绝不能让对账说明混进 lastError（会把成功同步显示成「同步失败」）"
  );
});

await t("lastNote 有完整的存取盘链路（加了字段但没存 = 重启即丢）", () => {
  assert.ok(/lastNote\?: string/.test(srcTypes), "SyncState 要有 lastNote");
  assert.ok(/lastNote\?: string/.test(srcStore), "CalStore 要有 lastNote 字段");
  assert.ok(/this\.lastNote = data\.sync\?\.lastNote/.test(srcStore), "load 要读 lastNote");
  assert.ok(/lastNote: this\.lastNote/.test(srcStore), "persist 要写 lastNote");
});

await t("同步抛异常时要清掉过期 lastNote（否则报错后中性提示一直挂着）", () => {
  // 用 lastNote 赋值点定位兜底 catch —— 文件里有多处 catch，按序号数位置会随重构漂移
  const iAssign = srcSync.indexOf("this.store.lastNote = notes.join");
  assert.ok(iAssign > 0, "先找到正常路径的 lastNote 赋值点");
  const iCatch = srcSync.indexOf("} catch (e: any) {", iAssign);
  assert.ok(iCatch > iAssign, "正常路径之后应紧跟兜底 catch");
  assert.ok(
    /this\.store\.lastNote = undefined/.test(srcSync.slice(iCatch, iCatch + 600)),
    "异常路径要清 lastNote"
  );
});

await t("Dock 状态栏对 lastNote 用中性样式，不复用「同步失败」前缀", () => {
  assert.ok(/opts\.store\.lastNote/.test(srcPanel), "面板要消费 lastNote");
  assert.ok(/showNote/.test(srcPanel), "要有独立的中性提示渲染");
  assert.ok(
    /} else if \(opts\.store\.lastNote\)/.test(srcPanel),
    "lastNote 分支必须在 lastError 分支之后，且不显示「同步失败」"
  );
});

console.log(`\n[reconcile] ${passed} 项通过`);
