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
 * REPORT（calendar-query）的响应：ICS 正文直接放在 <calendar-data> 里返回，
 * 不会再发 GET（拉取走的整条路都是 REPORT，见 caldav.ts fetchCalendarItems）。
 */
const reportMultistatus = (href, etag, ics) =>
  `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
  `<D:response><D:href>${href}</D:href><D:propstat><D:prop>` +
  `<D:getetag>"${etag}"</D:getetag>` +
  `<D:calendar-data>${ics.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</D:calendar-data>` +
  `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>` +
  `</D:multistatus>`;

/**
 * @param {(req:{method:string,body:string,url:string}) => {status:number,body:string,headers?:object}} router
 */
function withFetch(router) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const req = { url: String(url), method: init?.method || "GET", body: String(init?.body || ""), headers: init?.headers || {} };
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

await t("发现日历的 PROPFIND 点名请求 supported-calendar-component-set", () => {
  // 这是 protected 属性：allprop 不带、不点名就永远拿不到 → supportsEvent/Todo 会停在
  // 缺省的 true，于是把 iCloud 的提醒事项集合误判成「也收 VEVENT」，互转必 403。
  assert.ok(
    /supported-calendar-component-set\/>/.test(srcCaldav),
    "不点名请求就拿不到能力，日历能力永远取缺省值"
  );
  assert.ok(/probeCalendarComponents/.test(srcCaldav), "缺单日历补探测入口（老配置要能补齐能力）");
  assert.ok(/ensureCalendarCapabilities/.test(srcSync), "syncAll 里没调能力补齐");
  assert.ok(/componentSetProbed/.test(srcTypes), "CalCalendar 缺 componentSetProbed 标记");
});

await t("403 降级顺序铁律：先 PUT 新地址，成功后再 DELETE 旧地址", () => {
  const i403 = srcSync.indexOf("=== 403) {");
  assert.ok(i403 > 0, "未找到 403 分支（条件已从 `403 && item.etag` 放宽为 `403`，别按旧串找）");
  const seg = srcSync.slice(i403, i403 + 2600);
  const iPut = seg.indexOf("const r = await putItem(");
  const iDel = seg.indexOf("await deleteItem(");
  assert.ok(iPut > 0 && iDel > 0, "403 分支里 PUT/DELETE 都要在");
  assert.ok(
    iPut < iDel,
    "必须先 PUT 新地址再 DELETE 旧地址 —— 反过来就是 2026-10-24 事故（旧资源已删、新资源建不回来，服务端那条直接没了）"
  );
});

await t("日历不支持目标类型时只报错，绝不动服务端旧资源", () => {
  assert.ok(/targetSupported/.test(srcSync), "403 分支要先判「集合是否接受该组件类型」");
  assert.ok(/movedFrom\?:/.test(srcTypes), "CalItem 缺 movedFrom（换日历搬家要留旧地址）");
});

await t("SyncReport 必须带 reconciled / requeued，三处构造都要补齐", () => {
  assert.ok(/reconciled: number/.test(srcSync) && /requeued: number/.test(srcSync), "报告字段缺失");
  const ctors = srcSync.match(/reconciled: 0/g) || [];
  assert.strictEqual(ctors.length, 3, "三处 SyncReport 字面量都要补字段，实际 " + ctors.length);
});

await t("pushAndPersist 明确不做对账（刚建的条目还没进服务端清单）", () => {
  // 2026-10-15：pushAndPersist 改成推送队列的壳，实体在 doPushAndPersist
  const i = srcSync.indexOf("private async doPushAndPersist");
  assert.ok(i > 0, "要能找到 doPushAndPersist（pushAndPersist 现在只是队列壳）");
  const body = srcSync.slice(i, i + 900);
  assert.ok(/不做对账/.test(body), "推送实体里要写明为什么不做对账");
  assert.ok(!/this\.reconcile\(/.test(body), "推送实体里不许调 reconcile");
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
  // 调用点现在是先接住返回值再取 .removed，不是链式直取
  assert.ok(
    /const merged = this\.store\.mergeServerItems\(items, deletedKeys\)/.test(srcSync),
    "mergeServerItems 的返回值必须先接住"
  );
  assert.ok(/report\.deleted \+= merged\.removed/.test(srcSync), "removed 要累加进 report.deleted");
  const recon = srcSync.slice(srcSync.indexOf("private async reconcile"), srcSync.indexOf("private async pushDirty"));
  assert.ok(
    /report\.reconciled\+\+;[\s\S]{0,200}?report\.deleted\+\+/.test(recon),
    "对账清理的条目也要计入 report.deleted（否则仍是「删除 0 条」）"
  );
});

await t("mergeServerItems 返回 removed / applied 计数（store 侧真的实现了吗）", () => {
  assert.ok(
    /mergeServerItems\(incoming: CalItem\[\], deletedKeys: string\[\] = \[\]\): \{ changed: boolean; removed: number; applied: number \}/.test(
      srcStore
    ),
    "签名要返回 { changed, removed, applied }"
  );
  const body = srcStore.slice(srcStore.indexOf("mergeServerItems(incoming"));
  assert.ok(/let removed = 0/.test(body), "要有 removed 计数");
  assert.ok(/let applied = 0/.test(body), "要有 applied 计数（拉取用）");
  assert.ok(
    /if \(this\.items\.has\(key\)\) \{\s*this\.items\.delete\(key\);\s*changed = true;\s*removed\+\+/.test(body),
    "deletedKeys 命中时才 removed++（命中不存在的 key 不能计数）"
  );
  assert.ok(/return \{ changed, removed, applied \}/.test(body), "要返回 removed + applied");
});

// ---- 2026-10-10 第三轮：新建一条显示「上传1 拉取1」——自环回显 ----

await t("fetched 取实际写入数，不能取 items.length（否则自环回显让拉取虚增）", () => {
  assert.ok(/report\.fetched \+= merged\.applied/.test(srcSync), "拉取要取 merged.applied");
  assert.ok(
    !/report\.fetched \+= items\.length/.test(srcSync),
    "绝不能再取 items.length —— 自己刚推的会被当变更推回，重复计入拉取"
  );
});

await t("applied 只在真写入时 ++（same 判定跳过的条目不能算拉取）", () => {
  const body = srcStore.slice(srcStore.indexOf("mergeServerItems(incoming"));
  // same → continue 必须排在 applied++ 之前，否则自环条目照样被计。
  // ⚠️ 判据只取 "if (same)"，不要写 "if (same) continue;" —— 2026-10-14 给 same
  // 分支加了 adoptRaw 自愈后它变成块结构，绑死单行会让这条断言假红。
  // 真正钉住行为的是下面那条跑真实对象的「自环回显」用例。
  const iSet = body.indexOf("this.items.set(keyOf(inc)");
  const iApplied = body.indexOf("applied++");
  const iSame = body.indexOf("if (same)");
  assert.ok(iSame > 0 && iSame < iSet, "same 判定要在写入之前（自环条目靠它挡掉）");
  assert.ok(iApplied > iSet, "applied++ 要紧跟在真写入之后");
});

// 这条是真正的守门员：逐字段比对会被服务端规范化的 raw 打败，
// 只有「etag 相同即跳过」能挡住自环回显。光有源码级断言不够 ——
// 源码里写了 etag 判定，也可能因为顺序/条件写错而实际不生效。
await t("自环回显：服务端推回同 etag、但 raw 被规范化过的条目 → 不写入、不算拉取", async () => {
  const local = mkItem({
    uid: "loop@test",
    href: CAL_URL + "loop.ics",
    summary: "我刚建的",
    etag: "server-etag",
    // 本地是生成的原文
    raw: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//local//EN\r\nEND:VCALENDAR\r\n"
  });
  const st = await mkStore([local]);
  // 服务端把它规范化后推回：uid/summary/etag 全一样，只有 raw 不同
  const echoed = {
    ...local,
    raw: "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//server//EN\nX-EXTRA:1\nEND:VCALENDAR\n"
  };
  const r = st.mergeServerItems([echoed], []);
  assert.strictEqual(
    r.applied,
    0,
    "etag 相同就该判定为无变化，不算拉取 —— 否则新建一条会显示「上传1 拉取1」"
  );
  assert.strictEqual(r.changed, false, "不该触发 emit/重渲染");
  // 本地内容保持原样（本地版本才是权威，不该被服务端的规范化版本覆盖）
  assert.strictEqual(st.getAll()[0].raw, local.raw, "本地 raw 不该被服务端版本覆盖");
});

await t("etag 不同 → 确实要写入并计入拉取（别把真实变更也挡掉）", async () => {
  const local = mkItem({ uid: "chg@test", href: CAL_URL + "chg.ics", summary: "旧标题", etag: "old-etag" });
  const st = await mkStore([local]);
  const r = st.mergeServerItems([{ ...local, summary: "新标题", etag: "new-etag" }], []);
  assert.strictEqual(r.applied, 1, "etag 变了就是真变更，必须计入拉取");
  assert.strictEqual(st.getAll()[0].summary, "新标题", "本地要跟着更新");
});

await t("etag 缺失时退回逐字段比对（老数据不能因此每轮都算拉取）", async () => {
  const local = mkItem({ uid: "noetag@test", href: CAL_URL + "noetag.ics", summary: "标题", etag: undefined });
  const st = await mkStore([local]);
  const r = st.mergeServerItems([{ ...local, etag: undefined, raw: "DIFFERENT" }], []);
  assert.strictEqual(
    r.applied,
    0,
    "没 etag 且字段都相同 → 不该写入（否则老数据每轮都虚报拉取 1）"
  );
});

// ---- 2026-10-19 雄哥实测：打勾完成即报「服务端已变更，本地改动已按策略丢弃」。根因是
//      多端/服务器重算让服务端 etag 变、但受管字段没变 → same 分支跳过时漏回写 etag →
//      本地 etag 滞后 → 下次编辑 PUT 带旧 etag 必 412 → 改动被丢弃。修法：same 分支回写 etag。 ----
await t("缺陷A：etag 变但受管字段没变 → same 分支必须回写 etag（否则本地滞后、下次编辑必 412）", async () => {
  const local = mkItem({ uid: "stale@test", href: CAL_URL + "stale.ics", summary: "标题", etag: "old-etag" });
  const st = await mkStore([local]);
  // 服务端把这条的 etag 改了（多端动过 DTSTAMP/ATTENDEE 等非受管字段），受管字段一个没变
  const r = st.mergeServerItems([{ ...local, etag: "new-etag", raw: "SERVER-NORMALIZED" }], []);
  assert.strictEqual(r.applied, 0, "受管字段没变就不算拉取，applied 不能虚增");
  assert.strictEqual(st.getAll()[0].etag, "new-etag", "关键：same 分支要把服务端新 etag 回写，绝让本地 etag 滞后");
});

await t("对账提示走 lastNote 中性通道，绝不塞进 lastError", () => {
  assert.ok(/this\.store\.lastNote = \[\.\.\.notes, \.\.\.report\.conflicts\]\.join\("; "\) \|\| undefined/.test(srcSync), "对账提示要写 lastNote（含冲突）");
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
  const iAssign = srcSync.indexOf("this.store.lastNote = [...notes");
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
  assert.ok(
    /} else if \(opts\.store\.lastNote\)/.test(srcPanel),
    "lastNote 分支必须在 lastError 分支之后，且不显示「同步失败」"
  );
  // 2026-10-15 页脚一行化：showNote/showError 两个独立渲染函数已删，提示并进
  // 状态按钮这一行。断言的意图不变——lastNote 分支必须保持中性（无错误前缀、
  // 不加 has-error），不能再按「有独立函数」断言。
  // ⚠️ 先剥注释再断言：分支上方的注释里就写着「不能复用『同步失败』的前缀」，
  //    不剥的话这句解释本身会被当成违规（铁律：断言先剥注释）。
  const i = srcPanel.indexOf("} else if (opts.store.lastNote)");
  assert.ok(i > 0, "要能定位 lastNote 分支");
  const raw = srcPanel.slice(i, i + 600);
  const body = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/同步失败/.test(body), "lastNote 分支不能出现「同步失败」前缀");
  assert.ok(!/add\("has-error"\)/.test(body), "中性提示不能加错误样式");
});

// ---- 2026-10-10 第二轮：即时推送（新建/编辑/删除单条）的计数被整个丢弃，
//      用户随后点全量同步看到「上传 0 · 删除 0」，以为改动没同步 ----

// ---- 2026-10-19 雄哥实测：同一事件打勾/编辑几次，同步就报「上传 N 条」——虚胖。
//      根因：pending 按推送轮次累加（pendingUploaded += report.uploaded），同一条目
//      推 N 次就计 N。修法：按条目 key 去重（markUploaded/markDeleted + 并集合并且）。 ----

await t("即时推送的成功要按条目 key 攒进 pending（去重，不能按轮次累加）", () => {
  // 实体在 doPushAndPersist（pushAndPersist 是 2026-10-15 加的队列壳）
  const body = srcSync.slice(srcSync.indexOf("private async doPushAndPersist"));
  assert.ok(
    /for \(const k of report\.uploadedKeys \?\? \[\]\) this\.store\.markUploaded\(k\)/.test(body),
    "上传要按 key 攒进 pendingUploadedKeys"
  );
  assert.ok(
    /for \(const k of report\.deletedKeys \?\? \[\]\) this\.store\.markDeleted\(k\)/.test(body),
    "删除要按 key 攒进 pendingDeletedKeys"
  );
  assert.ok(!/pendingUploaded \+=/.test(srcSync), "绝不许再按轮次累加计数（虚胖的根因）");
  // 攒了不合并 = 白攒
  assert.ok(/this\.store\.pendingUploadedKeys/.test(srcSync), "syncAll 要消费 pendingUploadedKeys");
  assert.ok(/this\.store\.pendingDeletedKeys/.test(srcSync), "syncAll 要消费 pendingDeletedKeys");
});

await t("pending 合并后必须清零（否则下一轮重复计数、key 越滚越多）", () => {
  const i = srcSync.indexOf("this.store.pendingUploadedKeys = []");
  assert.ok(i > 0, "先找到合并点");
  const body = srcSync.slice(i, i + 500);
  assert.ok(/pendingUploadedKeys = \[\]/.test(body), "合并后 pendingUploadedKeys 要清零");
  assert.ok(/pendingDeletedKeys = \[\]/.test(body), "合并后 pendingDeletedKeys 要清零");
});

await t("即时推送后立刻给反馈（用户点完删除要看得到「已上云」）", () => {
  const body = srcSync.slice(srcSync.indexOf("private async doPushAndPersist"));
  assert.ok(/已同步到服务端/.test(body), "要有即时反馈文案");
  assert.ok(/noteParts\.length\) this\.store\.lastNote = noteParts\.join/.test(body), "反馈写 lastNote 中性通道（含冲突）");
});

await t("pending 有完整的存取盘链路（重启就丢 = 计数凭空消失）", () => {
  assert.ok(/pendingUploadedKeys\?: string\[\]/.test(srcTypes), "SyncState 要有 pendingUploadedKeys");
  assert.ok(/pendingDeletedKeys\?: string\[\]/.test(srcTypes), "SyncState 要有 pendingDeletedKeys");
  assert.ok(
    /this\.pendingUploadedKeys = Array\.isArray\(data\.sync\?\.pendingUploadedKeys\)/.test(srcStore),
    "load 要读 pending keys"
  );
  assert.ok(/pendingUploadedKeys: this\.pendingUploadedKeys/.test(srcStore), "persist 要写 pending keys");
});

// ---- 2026-10-15 雄哥实测：任务测试Z 已从本地删除，远端那份 etag 对不上，
//      DELETE 带 If-Match → 412 → 旧代码什么都不做，条目卡在 deleted+dirty，
//      每轮同步重发 DELETE 再 412，「删除失败」永远报不完。 ----

await t("删除遇 412（etag 对不上）：服务端优先 → 撤销删除、恢复服务端版本", async () => {
  const gone = mkItem({
    uid: "z@test",
    href: CAL_URL + "z.ics",
    deleted: true,
    dirty: true,
    summary: "任务测试Z",
    etag: '"old-etag"'
  });
  const st = await mkStore([gone]); // 默认 conflict = server
  // 服务端那份被改过：清单里还在，但 etag 已是新值、内容也变了
  const serverIcs = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:z@test",
    "SUMMARY:服务端改过的版本",
    "DTSTAMP:20260101T000000Z",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const restore = withFetch((req) => {
    if (req.method === "DELETE") return { status: 412, body: "" };
    // 拉取走 REPORT：正文直接在 calendar-data 里，etag 已是新值
    if (req.method === "REPORT") return { status: 207, body: reportMultistatus("/cal/z.ics", "new-server-etag", serverIcs) };
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/z.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.deleted, 0, "删除没执行就不能计数，实际 " + rep.deleted);
    const left = st.getAll().find((i) => i.uid === "z@test");
    assert.ok(left, "服务端优先：条目必须留在本地（撤销删除），不能就这么消失");
    assert.strictEqual(left.deleted, false, "撤销删除标记");
    assert.strictEqual(left.dirty, false, "不再当脏条目反复重推");
    assert.strictEqual(left.summary, "服务端改过的版本", "应拉到服务端当前版本");
    assert.strictEqual(rep.errors.length, 0, "冲突不应计入 errors，实际 " + JSON.stringify(rep.errors));
    assert.ok(
      /服务端已变更/.test(rep.conflicts.join(";")),
      "要说清为什么删没执行、下一步怎么办，实际 " + JSON.stringify(rep.conflicts)
    );
  } finally {
    restore();
  }
});

await t("删除遇 412（etag 对不上）：本地优先 → 去掉 If-Match 无条件删", async () => {
  const gone = mkItem({
    uid: "z@test",
    href: CAL_URL + "z.ics",
    deleted: true,
    dirty: true,
    summary: "任务测试Z",
    etag: '"old-etag"'
  });
  const st = await mkStore([gone], { conflict: "local" });
  let deleteCalls = 0;
  const restore = withFetch((req) => {
    if (req.method === "DELETE") {
      deleteCalls++;
      return { status: deleteCalls === 1 ? 412 : 204, body: "" }; // 第二次（无条件）成功
    }
    if (req.method === "REPORT") return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
    // 放一条别的资源占位，保证清单非空（空清单会触发「查错地方 → 跳过」约束）
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/someone-else.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(deleteCalls, 2, "应补发一次不带 If-Match 的 DELETE，实际 " + deleteCalls);
    assert.strictEqual(rep.deleted, 1, "补删成功要计数，实际 " + rep.deleted);
    assert.ok(!st.getAll().some((i) => i.uid === "z@test"), "删除成功后条目应移出本地");
    assert.ok(
      !rep.errors.some((e) => /任务测试Z/.test(e)),
      "成功了就不该再留错误，实际 " + JSON.stringify(rep.errors)
    );
  } finally {
    restore();
  }
});

// ---- 2026-10-19 雄哥实测：打勾「关于开展外包风险专项排查的通知」→ 同步即报「服务端已变更，
//      本地改动已按策略丢弃」，且界面上的勾是假的（服务端并没改成完成）。上传 412 服务端优先
//      分支旧代码只清 dirty、不清 etag 也不回滚字段 → 下一轮拉取因「字段恰好相同」仍不纠正。
//      修法：丢弃时清 etag，让同一轮 syncAll 的拉取无条件以服务端版本覆盖、纠正假状态。 ----
await t("上传遇 412（etag 对不上）：服务端优先 → 丢弃改动 + 清 etag，本轮拉取把假完成态纠正回服务端版本", async () => {
  const it = mkItem({
    uid: "外包通知@test",
    href: CAL_URL + "u1.ics",
    summary: "关于开展外包风险专项排查的通知",
    percent: 100, // 本地打勾后的乐观值，还没推上去
    status: "COMPLETED",
    completedAt: "2026-10-19T10:00:00",
    dirty: true,
    etag: '"old-etag"' // 陈旧 etag：多端/服务器改过，本地没跟上
  });
  const st = await mkStore([it]); // 默认 conflict = server
  // 服务端那份 etag 已是新值，且还是未完成——本地打过勾但被 412 挡住
  const serverIcs = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:外包通知@test",
    "SUMMARY:关于开展外包风险专项排查的通知",
    "STATUS:NEEDS-ACTION",
    "PERCENT-COMPLETE:0",
    "DTSTAMP:20260101T000000Z",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const restore = withFetch((req) => {
    if (req.method === "PUT") return { status: 412, body: "" }; // 打勾推送被服务端拒（etag 对不上）
    if (req.method === "REPORT") return { status: 207, body: reportMultistatus("/cal/u1.ics", "new-server-etag", serverIcs) };
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/u1.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.errors.length, 0, "冲突不应计入 errors，实际 " + JSON.stringify(rep.errors));
    assert.ok(
      /服务端已变更/.test(rep.conflicts.join(";")),
      "要报清楚为什么打勾没同步上去，实际 " + JSON.stringify(rep.conflicts)
    );
    const left = st.getAll().find((i) => i.uid === "外包通知@test");
    assert.ok(left, "条目必须留在本地");
    assert.strictEqual(left.dirty, false, "不再当脏条目反复重推");
    assert.strictEqual(left.percent, 0, "假 100 必须被本轮拉取纠正回服务端未完成，实际 percent=" + left.percent);
    assert.strictEqual(left.etag, "new-server-etag", "拉取后 etag 应更新为服务端新值，实际 " + left.etag);
  } finally {
    restore();
  }
});

await t("上传 412 服务端优先分支要清 etag（源码防漂移，否则又留假状态）", () => {
  // 不剥全文件注释——sync.ts 里有正则/字符串含 /* 或 */，naive 块注释剥离会误配对、
  // 把目标代码段一起吃掉（2026-10-19 实测踩坑：剥完连 push 行都没了）。改为锚定
  // 「连续三条代码语句」：dirty=false → etag=undefined → push(「…本地改动已按策略丢弃」）。
  // 注释在上方独立行，夹不进这条序列，既能精确命中真实分支，也不被注释里的同款文案误伤。
  assert.ok(
    /item\.dirty = false;\s*item\.etag = undefined;\s*report\.conflicts\.push\(`[^`]*本地改动已按策略丢弃`\)/.test(srcSync),
    "上传 412 服务端优先分支必须 dirty=false + etag=undefined + 报「本地改动已按策略丢弃」——漏了 etag=undefined，下一轮拉取因字段相同走 same 分支仍不纠正，UI 挂假完成态"
  );
});

await t("删除遇 412 按冲突策略分叉（源码防漂移）", () => {
  const i = srcSync.indexOf("// 删除");
  assert.ok(i > 0, "要能找到删除分支");
  const body = srcSync.slice(i, srcSync.indexOf("/** 新建条目"));
  assert.ok(/e\?\.status === 412/.test(body), "删除分支必须接 412 —— 不接就回到死循环");
  assert.ok(
    /conflict === "local"[\s\S]{0,400}?deleteItem\(\{ \.\.\.item, etag: undefined \}/.test(body),
    "本地优先：去掉 If-Match 无条件删"
  );
  assert.ok(
    /item\.deleted = false[\s\S]{0,240}?item\.dirty = false/.test(body),
    "服务端优先：撤销删除 + 清 dirty（否则每轮重推）"
  );
});

// ---- 2026-10-16 雄哥实测：主窗口点刷新，Dock 一直挂着上次的 412 红字、
//      按钮转几分钟后才弹本次失败。根因是两条同步入口对状态条的处理不一致
//      （Dock 自己的入口会立即写「同步中…」，主窗口的入口不动状态条），
//      且 syncAll 不清上次的遗留错误。修法：store.syncing 瞬时状态 +
//      syncAll 入口清错误，renderStatus 统一认。 ----

await t("syncAll 进行中：清掉上次的遗留错误并置 syncing", async () => {
  const st = await mkStore([]);
  st.lastError = "上次的旧错误（删除 任务测试Z: HTTP 412）";
  let seenError = "unset";
  let seenSyncing = "unset";
  const restore = withFetch((req) => {
    // 第一次网络请求时（同步已开始、拉取未结束）抓状态
    if (seenError === "unset") {
      seenError = st.lastError;
      seenSyncing = st.syncing;
    }
    if (req.method === "REPORT") return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND") return { status: 207, body: multistatus([]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.ok, true, "本轮应成功（空清单无错误），实际 " + JSON.stringify(rep.errors));
    assert.strictEqual(seenError, undefined, "同步开始后旧错误必须立即清掉，实际 " + seenError);
    assert.strictEqual(seenSyncing, true, "同步中 syncing 应为 true，实际 " + seenSyncing);
    assert.strictEqual(st.syncing, false, "结束后 syncing 必须复位，实际 " + st.syncing);
    assert.strictEqual(st.lastError, undefined, "成功同步后 lastError 应为空");
  } finally {
    restore();
  }
});

await t("syncAll 入口清遗留错误（源码防漂移）", () => {
  const i = srcSync.indexOf("this.syncing = true;");
  assert.ok(i > 0, "要能找到 syncAll 的入口闸");
  const body = srcSync.slice(i, i + 500);
  assert.ok(/this\.store\.lastError = undefined/.test(body), "入口必须清 lastError");
  assert.ok(/this\.store\.syncing = true/.test(body), "入口必须置 syncing");
  assert.ok(/this\.store\.notify\(\)/.test(body), "置位后要 notify，Dock 才能即时刷新");
});

await t("renderStatus 认同步中状态（两条入口表现一致）", () => {
  assert.ok(/store\.syncing/.test(srcPanel), "renderStatus 要读 store.syncing");
  assert.ok(/同步中…/.test(srcPanel), "同步中要有明确文案");
  const i = srcPanel.indexOf("if (opts.store.syncing)");
  assert.ok(i > 0, "要能找到 syncing 分支");
  const body = srcPanel.slice(i, i + 300);
  assert.ok(!/同步失败/.test(body), "同步中不能显示失败前缀");
});

// ---- 2026-10-19 雄哥实测：同一事件操作几次（打勾/编辑），全量同步就报「上传 N 条」
//      ——虚胖。根因：pending 按推送轮次累加，同一条目推 N 次计 N。修法：按 key 去重。 ----

/** 全绿的假服务器：PUT 201、REPORT 207 回一条、PROPFIND 清单含它 */
const okServer = (icsHref, ics) => (req) => {
  if (req.method === "PUT") return { status: 201, body: "" };
  if (req.method === "REPORT") return { status: 207, body: reportMultistatus(icsHref, "e-new", ics) };
  if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
  if (req.method === "PROPFIND") return { status: 207, body: multistatus([icsHref]) };
  return { status: 200, body: "" };
};

const todoIcs = (uid, summary) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    "DTSTAMP:20260101T000000Z",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");

await t("同一条目即时推送 3 次，全量同步只报上传 1 条（操作几次不能就报几次）", async () => {
  const it = mkItem({ uid: "dup@test", href: CAL_URL + "dup.ics", summary: "同一事件" });
  const st = await mkStore([it]);
  const restore = withFetch(okServer("/cal/dup.ics", todoIcs("dup@test", "同一事件")));
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    // 模拟用户对同一事件操作三次：每次编辑都走 updateItem → 即时推送（后台）
    for (let i = 0; i < 3; i++) {
      await eng.updateItem({ ...it, percent: 100, status: "COMPLETED", dirty: true });
    }
    assert.strictEqual(
      st.pendingUploadedKeys.length,
      1,
      "同一 key 只记一次，实际 " + JSON.stringify(st.pendingUploadedKeys)
    );
    const rep = await eng.syncAll();
    assert.strictEqual(rep.uploaded, 1, "三次编辑同一条目 → 同步应报上传 1 条，实际 " + rep.uploaded);
  } finally {
    restore();
  }
});

await t("两个不同条目各推一次，同步报上传 2 条（去重不能把不同条目合并掉）", async () => {
  const a = mkItem({ uid: "a@test", href: CAL_URL + "a.ics", summary: "事件A" });
  const b = mkItem({ uid: "b@test", href: CAL_URL + "b.ics", summary: "事件B" });
  const st = await mkStore([a, b]);
  const restore = withFetch((req) => {
    if (req.method === "PUT") return { status: 201, body: "" };
    if (req.method === "REPORT") return { status: 207, body: reportMultistatus("/cal/a.ics", "e-new", todoIcs("a@test", "事件A")) };
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/a.ics", "/cal/b.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.updateItem({ ...a, percent: 50, dirty: true });
    await eng.updateItem({ ...b, percent: 50, dirty: true });
    const rep = await eng.syncAll();
    assert.strictEqual(rep.uploaded, 2, "两个不同条目 → 上传 2 条，实际 " + rep.uploaded);
  } finally {
    restore();
  }
});

await t("即时推送成功后又编辑、本轮同步再推同一条目 → 并集只算 1 条", async () => {
  const it = mkItem({ uid: "u1@test", href: CAL_URL + "u1.ics", summary: "同一事件" });
  const st = await mkStore([it]);
  let putCount = 0;
  const restore = withFetch((req) => {
    if (req.method === "PUT") {
      putCount++;
      // 第二次 PUT（编辑后的后台推送）失败 → 条目留脏，交给本轮 syncAll 重推
      return putCount === 2 ? { status: 500, body: "" } : { status: 201, body: "" };
    }
    if (req.method === "REPORT") return { status: 207, body: reportMultistatus("/cal/u1.ics", "e-new", todoIcs("u1@test", "同一事件")) };
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/u1.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.updateItem({ ...it, percent: 30, dirty: true }); // 后台推送成功 → pending 记 key
    await eng.updateItem({ ...it, percent: 60, dirty: true }); // 后台推送失败 → 留脏
    const rep = await eng.syncAll(); // 本轮 pushDirty 重推成功 → 本轮 key 与 pending 同 key
    assert.strictEqual(rep.uploaded, 1, "同一条目跨轮推送只算 1 条，实际 " + rep.uploaded);
  } finally {
    restore();
  }
});

// ---- 2026-10-23 雄哥实测：待办转日程后「原任务没删除 + 同步出错」。根因两层： ----
//      ① keyOf 把 kind 编进主键 → 转换保存变成另立新条（uid|todo 残留、uid|event 带旧 href/etag）；
//      ② 多数 CalDAV 服务端把资源组件类型与 href 绑定校验，对已有 VTODO 资源 PUT VEVENT 回 403。
//      修法：主键去掉 kind（UID 在日历内本就唯一）+ 403 时自动「删旧资源→同 URI 重建」降级。

const EVENT_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  "UID:u1@test",
  "SUMMARY:测试任务",
  "DTSTART:20261023T070000Z",
  "DTEND:20261023T080000Z",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n");

await t("待办转日程保存：同 UID 覆盖同一条目，不另立新条（主键不含 kind）", async () => {
  const it = mkItem({ uid: "u1@test", href: CAL_URL + "u1.ics", summary: "测试任务" });
  const st = await mkStore([it]);
  const restore = withFetch((req) => {
    if (req.method === "PUT") return { status: 201, body: "", headers: { etag: '"conv-etag"' } };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    // 编辑器转换后的条目：kind 翻成 event、raw 换成 VEVENT、继承旧 href/etag、置脏
    await eng.updateItem({ ...it, kind: "event", summary: "测试任务", raw: EVENT_ICS, dirty: true });
    assert.strictEqual(st.getAll().length, 1, "转换后本地必须只剩 1 条，实际 " + st.getAll().length);
    const left = st.getAll()[0];
    assert.strictEqual(left.kind, "event", "留下的应是转换后的日程");
    assert.strictEqual(left.dirty, false, "上传成功后不应再脏");
    assert.strictEqual(left.etag, "conv-etag", "etag 应取上传响应的新值");
  } finally {
    restore();
  }
});

await t("待办转日程遇 403（服务端拒改组件类型）：非破坏性降级——先建新地址、成功再删旧", async () => {
  const it = mkItem({ uid: "u1@test", href: CAL_URL + "u1.ics", summary: "测试任务", etag: '"old-etag"' });
  const st = await mkStore([it]);
  const calls = [];
  let putCount = 0;
  const restore = withFetch((req) => {
    calls.push(req);
    if (req.method === "PUT") {
      putCount++;
      // 第一次 PUT（If-Match 改写既有 VTODO 资源）被服务端以 403 拒绝；
      // 降级后往**同集合的新地址** PUT（不带 If-Match）应成功
      return putCount === 1
        ? { status: 403, body: "" }
        : { status: 201, body: "", headers: { etag: '"new-etag"' } };
    }
    if (req.method === "DELETE") return { status: 204, body: "" };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.updateItem({ ...it, kind: "event", summary: "测试任务", raw: EVENT_ICS, dirty: true });
    assert.strictEqual(putCount, 2, "应恰好 PUT 两次（403 后换地址重试 1 次），实际 " + putCount);
    const puts = calls.filter((c) => c.method === "PUT");
    const deletes = calls.filter((c) => c.method === "DELETE");
    assert.strictEqual(deletes.length, 1, "只应 DELETE 旧地址 1 次，实际 " + deletes.length);
    assert.ok(puts[0].headers["If-Match"], "第一次 PUT 应带 If-Match（改写既有资源）");
    assert.ok(!puts[1].headers["If-Match"], "第二次 PUT（换地址新建）不应带 If-Match");
    assert.notStrictEqual(puts[1].url, puts[0].url, "重试必须换一个新地址，同 href 再 PUT 仍会被拒");
    assert.strictEqual(deletes[0].url, CAL_URL + "u1.ics", "删的应是旧地址");
    // ⚠️ 顺序铁律：先建后删。反过来的话（2026-10-24 事故）新建一失败，服务端那条就没了。
    assert.ok(
      calls.indexOf(deletes[0]) > calls.indexOf(puts[1]),
      "DELETE 必须排在换地址 PUT 成功之后，否则新建失败就丢数据"
    );
    const left = st.getAll()[0];
    assert.strictEqual(left.kind, "event", "降级上传成功后转换应生效");
    assert.strictEqual(left.dirty, false, "降级上传成功后不应再脏");
    assert.strictEqual(left.etag, "new-etag", "etag 应取第二次 PUT 响应的新值");
    assert.notStrictEqual(left.href, CAL_URL + "u1.ics", "条目应落在新地址上");
  } finally {
    restore();
  }
});

// ---- 2026-10-24：iCloud 日历/提醒事项是分开的集合，日历只收 VEVENT、提醒事项只收 VTODO ----
//      往不支持目标类型的集合里 PUT，RFC 4791 §5.2.3 规定必须报错（实测 403）。此时
//      换地址重试也是白搭，必须给出可操作提示，且**绝不能删服务端旧资源**。

await t("parseComponentSet：VEVENT-only / VTODO-only / 缺失 / 空集合 四种形态", async () => {
  const wrap = (inner) =>
    `<D:propstat><D:prop><C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav">${inner}</C:supported-calendar-component-set></D:prop></D:propstat>`;
  const evOnly = caldav.parseComponentSet(wrap(`<C:comp name="VEVENT"/>`));
  assert.deepStrictEqual([evOnly.supportsEvent, evOnly.supportsTodo], [true, false], "iCloud 日历：只收事件");
  const tdOnly = caldav.parseComponentSet(wrap(`<C:comp name="VTODO"/>`));
  assert.deepStrictEqual([tdOnly.supportsEvent, tdOnly.supportsTodo], [false, true], "iCloud 提醒事项：只收待办");
  const both = caldav.parseComponentSet(wrap(`<C:comp name="VEVENT"/><C:comp name="VTODO"/>`));
  assert.deepStrictEqual([both.supportsEvent, both.supportsTodo], [true, true], "Radicale/Baikal：两者都收");
  // 属性缺失 = 服务端不限制（RFC：absence ⇒ server MUST accept all），绝不能反过来全判 false
  const none = caldav.parseComponentSet(`<D:propstat><D:prop><D:displayname>x</D:displayname></D:prop></D:propstat>`);
  assert.deepStrictEqual([none.supportsEvent, none.supportsTodo], [true, true], "属性缺失应视为不限制");
  const empty = caldav.parseComponentSet(wrap(``));
  assert.deepStrictEqual([empty.supportsEvent, empty.supportsTodo], [true, true], "空集合同样视为不限制");
});

await t("403 + 日历不支持目标类型：给可操作提示，且绝不删服务端旧资源", async () => {
  const it = mkItem({ uid: "u1@test", href: CAL_URL + "u1.ics", summary: "测试任务", etag: '"old-etag"' });
  // 该集合只收 VTODO（iCloud 提醒事项），转出来的 VEVENT 必被拒
  const st = await mkStore([it], { calendars: [{ ...cal, supportsEvent: false, supportsTodo: true }] });
  const calls = [];
  const restore = withFetch((req) => {
    calls.push(req);
    if (req.method === "PUT") return { status: 403, body: "" };
    return { status: 204, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.updateItem({ ...it, kind: "event", summary: "测试任务", raw: EVENT_ICS, dirty: true });
    assert.strictEqual(
      calls.filter((c) => c.method === "DELETE").length,
      0,
      "目标类型不被支持时一个字节都不该删——删了就再也建不回来"
    );
    assert.strictEqual(calls.filter((c) => c.method === "PUT").length, 1, "明知不支持就别换地址白重试");
    assert.ok(
      /不支持日程/.test(st.lastError || ""),
      "错误要直说「不支持日程」而不是干巴巴的 403，实际：" + st.lastError
    );
  } finally {
    restore();
  }
});

await t("被降级清掉 etag 后仍 403（雄哥那条卡住的「测试任务」）：同样给明确提示", async () => {
  // 现状复刻：kind=event、etag 已被上一版降级清掉、dirty 常驻，每轮同步都撞 403
  const it = mkItem({ uid: "u1@test", href: CAL_URL + "u1.ics", summary: "测试任务", etag: undefined });
  const st = await mkStore([it], { calendars: [{ ...cal, supportsEvent: false, supportsTodo: true }] });
  const calls = [];
  const restore = withFetch((req) => {
    calls.push(req);
    if (req.method === "PUT") return { status: 403, body: "" };
    return { status: 204, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.updateItem({ ...it, kind: "event", raw: EVENT_ICS, dirty: true });
    assert.ok(
      /不支持日程/.test(st.lastError || ""),
      "没有 etag 也要走「不支持」分支给出可操作提示，实际：" + st.lastError
    );
    assert.strictEqual(calls.filter((c) => c.method === "DELETE").length, 0, "依然一个字节都不该删");
  } finally {
    restore();
  }
});

await t("403 + 无 etag（URL 归档污染）：也要换新地址重试，成功后清掉搬家残留", async () => {
  // 2026-10-24 实测：iCloud 对「先 DELETE 再 PUT 过另一种类型」的地址留归档记录，
  // 之后向它 PUT 新类型永远 403（invalid attempt to update record from type …），
  // 而搬家后的条目 etag 恰好是空的 —— 不能因 !etag 就放弃换地址重试（非破坏性）。
  const it = mkItem({
    uid: "u2@test",
    href: CAL_URL + "u2.ics",
    summary: "测试任务",
    etag: undefined,
    movedFrom: { href: CAL_URL + "old/u2.ics", calendarUrl: CAL_URL, etag: '"mv-etag"' }
  });
  const st = await mkStore([it]);
  const calls = [];
  const restore = withFetch((req) => {
    calls.push(req);
    if (req.method === "PUT") {
      // 原 u2.ics 已被污染 → 403；换到 altHref（u2-xxxx.ics）→ 201
      return /u2\.ics$/.test(req.url)
        ? { status: 403, body: "invalid attempt to update record from type 'EventArchiveV1' to 'ReminderArchiveV1'" }
        : { status: 201, body: "", headers: { etag: '"fresh-etag"' } };
    }
    return { status: 204, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const TODO_ICS = EVENT_ICS.replace(/u1@test/g, "u2@test").replace("BEGIN:VEVENT", "BEGIN:VTODO").replace("END:VEVENT", "END:VTODO").replace("DTEND:", "DUE:");
    await eng.updateItem({ ...it, kind: "todo", summary: "测试任务", raw: TODO_ICS, dirty: true });
    const puts = calls.filter((c) => c.method === "PUT");
    assert.strictEqual(puts.length, 2, "应 PUT 两次（污染地址 403 + 新地址成功），实际 " + puts.length);
    const left = st.getAll()[0];
    assert.notStrictEqual(left.href, CAL_URL + "u2.ics", "必须换到新地址");
    assert.match(left.href, /u2test-[a-z0-9]+\.ics$/, "新地址应是 altHrefOf 生成的文件名");
    assert.strictEqual(left.dirty, false, "重试成功后不应再脏");
    assert.strictEqual(left.etag, "fresh-etag", "etag 应取新地址 PUT 响应的值");
    assert.strictEqual(left.movedFrom, undefined, "成功后要清掉搬家残留");
    assert.strictEqual((st.lastError || "").length, 0, "重试成功就不该有错误，实际：" + st.lastError);
    const delUrls = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    assert.ok(delUrls.some((u) => /old\/u2\.ics$/.test(u)), "movedFrom 指向的原日历那份要被删掉");
  } finally {
    restore();
  }
});

await t("换日历搬家：先 PUT 新地址，成功后删掉原日历里那份（movedFrom）", async () => {
  const it = mkItem({
    uid: "u1@test",
    href: OTHER_URL + "u1.ics",
    calendarUrl: OTHER_URL,
    summary: "搬家的任务",
    movedFrom: { href: CAL_URL + "u1.ics", calendarUrl: CAL_URL, etag: '"old-etag"' }
  });
  const st = await mkStore([it]);
  const calls = [];
  const restore = withFetch((req) => {
    calls.push(req);
    if (req.method === "PUT") return { status: 201, body: "", headers: { etag: '"moved-etag"' } };
    return { status: 204, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.updateItem({ ...it, dirty: true });
    const puts = calls.filter((c) => c.method === "PUT");
    const dels = calls.filter((c) => c.method === "DELETE");
    assert.strictEqual(puts[0].url, OTHER_URL + "u1.ics", "应先 PUT 到新日历");
    assert.strictEqual(dels.length, 1, "随后删旧日历里那份，实际 " + dels.length);
    assert.strictEqual(dels[0].url, CAL_URL + "u1.ics", "删的是原地址");
    assert.ok(calls.indexOf(dels[0]) > calls.indexOf(puts[0]), "顺序必须是先建后删");
    assert.strictEqual(st.getAll()[0].movedFrom, undefined, "处理完要清掉 movedFrom，避免每轮重复删");
  } finally {
    restore();
  }
});

await t("搬家后旧资源删不掉：只记中性提示，不把同步报成失败", async () => {
  const it = mkItem({
    uid: "u1@test",
    href: OTHER_URL + "u1.ics",
    calendarUrl: OTHER_URL,
    summary: "搬家的任务",
    dirty: true,
    movedFrom: { href: CAL_URL + "u1.ics", calendarUrl: CAL_URL }
  });
  const st = await mkStore([it]);
  const restore = withFetch((req) => {
    if (req.method === "PUT") return { status: 201, body: "", headers: { etag: '"moved-etag"' } };
    if (req.method === "DELETE") return { status: 403, body: "" }; // 旧日历只读
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.errors.length, 0, "旧资源删不掉不该算错误，实际：" + rep.errors.join("; "));
    assert.ok(rep.ok, "同步整体仍应判定成功");
    assert.ok(
      (rep.notes || []).some((n) => /未能删除/.test(n)),
      "应给出「旧位置那份未能删除」的中性提示，实际 notes=" + JSON.stringify(rep.notes)
    );
    assert.strictEqual(st.getAll()[0].dirty, false, "新地址已落地，不该继续脏");
  } finally {
    restore();
  }
});

console.log(`\n[reconcile] ${passed} 项通过`);
