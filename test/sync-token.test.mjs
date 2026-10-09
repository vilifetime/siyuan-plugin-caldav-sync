/**
 * 「sync-token 护栏」回归测试（2026-10-09新增）
 *
 * 背景：雄哥问backup.json 里 `http://radicale.org/ns/sync/47c08d...` 是干什么的，
 * 查着查着发现一个真实的坑。
 *
 * sync-token 是**服务端发的增量游标**（RFC 6578），语义是
 * 「服务端截至该 token 时刻的全量，我本地已经全都有了」。前缀
 * `http://radicale.org/ns/sync/` 只是**命名空间**（防不同厂商的 token 混淆，
 * 客户端原样回传、从不解析），后面那串 hex 才是游标。
 *
 * 坑：备份**故意不含 items**（只存 settings + keyring），于是恢复出来的状态
 * 自相矛盾 —— 拿着「本地全都有」的凭证，本地却是空的。后果不是报错而是
 * **静默空白**：增量拉取如实返回 0 条，日历空的，而且不会自愈（只要服务端
 * 没再变动，那个 token 一直有效、一直返回 0 条）。reconcile 也兜不住，它只清理
 * 「本地有 href 而服务端没有」的幽灵条目。
 *
 * 雄哥拍板走**方案 A**：恢复时清token + 加通用护栏（本地为空则忽略 token，
 * 强制全量拉一次）。理由是他要多端并用同一台CalDAV，全量以服务端为准更保险。
 *
 * 覆盖：
 *   1. store.isCalendarLocallyEmpty 的语义（含 deleted 待删项不算「空」）
 *   2. 本地为空 + 有 token ⇒ 必须全量拉，条目能回来
 *   3. 本地有数据 + 有 token ⇒ 仍走增量（不许把优化一刀砍掉）
 *   4. 全量之后 token 被重新写回 ⇒ 下一轮恢复增量，不至于每轮都全量
 *   5. 源码级断言：护栏与清 token不许被改回去
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-synctoken");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts src/core/store.ts src/core/sync.ts src/core/secret.ts ` +
  `--outDir .test-synctoken --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
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

// ---- 假 fetch：按 method / body 分流 ----
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

/** calendar-query 的 REPORT 响应（带 ICS 正文） */
const calQuery = (entries) =>
  `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
  entries
    .map(
      (e) =>
        `<D:response><D:href>${e.href}</D:href><D:propstat><D:prop><D:getetag>"${e.etag}"</D:getetag>` +
        `<C:calendar-data>${e.ics}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    )
    .join("") +
  `</D:multistatus>`;

/** sync-collection 的 REPORT 响应：变化项 + 新 token */
const syncCollectionRes = (changed, deleted, newToken) =>
  `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
  changed
    .map(
      (h) =>
        `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:getetag>"e-${h}"</D:getetag></D:prop>` +
        `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    )
    .join("") +
  deleted
    .map(
      (h) =>
        `<D:response><D:href>${h}</D:href><D:propstat><D:prop/>` +
        `<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>`
    )
    .join("") +
  `<D:sync-token>${newToken}</D:sync-token></D:multistatus>`;

function withFetchLog(router) {
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

const CAL_URL = "http://dav.test/cal/";
const TOKEN_OLD = "http://radicale.org/ns/sync/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_NEW = "http://radicale.org/ns/sync/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const mkIcs = (uid, summary) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:${uid}\r\nSUMMARY:${summary}\r\n` +
  `DTSTAMP:20260101T000000Z\r\nEND:VTODO\r\nEND:VCALENDAR`;

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

const cal = { url: CAL_URL, displayName: "工作", enabled: true, supportsEvent: true, supportsTodo: true };

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

console.log("[synctoken] store.isCalendarLocallyEmpty 的语义");

await t("没有任何条目 ⇒ 空", async () => {
  const st = await mkStore([]);
  assert.strictEqual(st.isCalendarLocallyEmpty(CAL_URL), true);
  assert.strictEqual(st.isCalendarLocallyEmpty("http://dav.test/other/"), true, "别的日历也不该有");
});

await t("有普通条目 ⇒ 非空", async () => {
  const st = await mkStore([mkItem({})]);
  assert.strictEqual(st.isCalendarLocallyEmpty(CAL_URL), false);
});

await t("只有 deleted 待删项 ⇒ 仍算非空（本地确实有状态，token 可信）", async () => {
  // 这是刻意的：deleted 条目即便 DELETE 这轮失败，也仍占着本地位置、
  // 说明本地掌握着这个日历的状态。若把它算成「空」，就会在用户
  // 「正清空某个日历」的当口触发无谓的全量重拉。
  const st = await mkStore([mkItem({ deleted: true })]);
  assert.strictEqual(st.isCalendarLocallyEmpty(CAL_URL), false);
});

await t("别的日历有条目不算本日历有（按 calendarUrl 精确匹配）", async () => {
  const st = await mkStore([mkItem({ calendarUrl: "http://dav.test/other/", href: "http://dav.test/other/x.ics" })]);
  assert.strictEqual(st.isCalendarLocallyEmpty(CAL_URL), true, "本日历确实一条都没有");
  assert.strictEqual(st.isCalendarLocallyEmpty("http://dav.test/other/"), false);
});

console.log("[synctoken] 本地为空 + 有 token ⇒ 必须全量拉（这次的 bug）");

await t("恢复场景：本地空、有 token，服务端有 2 条 ⇒ 必须全量拉回来", async () => {
  const st = await mkStore([], { calendars: [{ ...cal, syncToken: TOKEN_OLD }] });

  const { calls, restore } = withFetchLog((req) => {
    // sync-collection：只回变化项（这里服务端说「没变化」）+ 新 token
    if (req.method === "REPORT" && /sync-collection/.test(req.body)) {
      return { status: 207, body: syncCollectionRes([], [], TOKEN_NEW) };
    }
    // calendar-query：全量，两个条目
    if (req.method === "REPORT") {
      return {
        status: 207,
        body: calQuery([
          { href: "/cal/a.ics", etag: "ea", ics: mkIcs("a@test", "甲") },
          { href: "/cal/b.ics", etag: "eb", ics: mkIcs("b@test", "乙") }
        ])
      };
    }
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) {
      return { status: 207, body: multistatus([]).replace("</D:multistatus>", `<D:sync-token>${TOKEN_NEW}</D:sync-token></D:multistatus>`) };
    }
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/a.ics", "/cal/b.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();

    // 关键断言：绝对不能只发 sync-collection 就完事（那正是「静默空白」的成因）
    const usedSyncCollection = calls.some((c) => c.method === "REPORT" && /sync-collection/.test(c.body));
    const usedCalQuery = calls.some((c) => c.method === "REPORT" && /calendar-query/.test(c.body));
    assert.ok(!usedSyncCollection, "本地为空时不该用 sync-collection 走增量");
    assert.ok(usedCalQuery, "必须回退到 calendar-query 全量拉");

    const uids = st.getAll().map((i) => i.uid).sort();
    assert.deepStrictEqual(uids, ["a@test", "b@test"], "条目应全部拉回来，实际 " + JSON.stringify(uids));
    assert.ok(rep.fetched >= 2, "report.fetched 应统计到条目，实际 " + rep.fetched);
  } finally {
    restore();
  }
});

await t("全量之后 token 被重新写回 ⇒ 下一轮恢复增量（不是每轮都全量）", async () => {
  const st = await mkStore([], { calendars: [{ ...cal, syncToken: TOKEN_OLD }] });
  const { calls, restore } = withFetchLog((req) => {
    if (req.method === "REPORT" && /sync-collection/.test(req.body)) {
      return { status: 207, body: syncCollectionRes([], [], TOKEN_NEW) };
    }
    if (req.method === "REPORT") {
      return { status: 207, body: calQuery([{ href: "/cal/a.ics", etag: "ea", ics: mkIcs("a@test", "甲") }]) };
    }
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) {
      return { status: 207, body: multistatus([]).replace("</D:multistatus>", `<D:sync-token>${TOKEN_NEW}</D:sync-token></D:multistatus>`) };
    }
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/a.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    await eng.syncAll();
    assert.ok(st.settings.calendars[0].syncToken, "全量后应写回新 token");
    assert.strictEqual(st.getAll().length, 1, "本地此时有数据了");

    calls.length = 0;
    await eng.syncAll();
    assert.ok(
      calls.some((c) => c.method === "REPORT" && /sync-collection/.test(c.body)),
      "本地已有数据 ⇒ 第二轮必须走增量，别把优化一刀砍掉"
    );
  } finally {
    restore();
  }
});

console.log("[synctoken] 本地有数据 + 有 token ⇒ 仍走增量（不许退化）");

await t("正常增量路径不受护栏影响", async () => {
  const st = await mkStore([mkItem({ uid: "a@test", href: CAL_URL + "a.ics" })], {
    calendars: [{ ...cal, syncToken: TOKEN_OLD }]
  });
  const { calls, restore } = withFetchLog((req) => {
    if (req.method === "REPORT" && /sync-collection/.test(req.body)) {
      return {
        status: 207,
        body: syncCollectionRes(["/cal/new.ics"], ["/cal/gone.ics"], TOKEN_NEW)
      };
    }
    if (req.method === "REPORT") {
      return { status: 207, body: calQuery([{ href: "/cal/new.ics", etag: "en", ics: mkIcs("new@test", "新") }]) };
    }
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) {
      return { status: 207, body: multistatus([]).replace("</D:multistatus>", `<D:sync-token>${TOKEN_NEW}</D:sync-token></D:multistatus>`) };
    }
    if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/a.ics", "/cal/new.ics"]) };
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.ok(
      calls.some((c) => c.method === "REPORT" && /sync-collection/.test(c.body)),
      "本地有数据时必须走增量"
    );
    assert.ok(
      !calls.some((c) => c.method === "REPORT" && /calendar-query/.test(c.body)),
      "不该有多余的全量查询"
    );
    assert.strictEqual(rep.deleted, 0, "删除走 deletedHrefs，不计入 report.deleted");
    const uids = st.getAll().map((i) => i.uid).sort();
    assert.deepStrictEqual(uids, ["a@test", "new@test"], "增量新增的条目要进来");
  } finally {
    restore();
  }
});

console.log("[synctoken] 源码级防漂移");

{
  const syncSrc = fs.readFileSync(path.join(root, "src/core/sync.ts"), "utf8");
  const storeSrc = fs.readFileSync(path.join(root, "src/core/store.ts"), "utf8");

  await t("护栏必须在 sync.ts 里，且在增量分支之前", () => {
    assert.ok(
      /if \(cal\.syncToken && this\.store\.isCalendarLocallyEmpty\(cal\.url\)\)/.test(syncSrc),
      "sync.ts 必须有「本地为空则丢弃 token」的护栏（多端/恢复/云同步覆盖都靠它）"
    );
    const guardAt = syncSrc.indexOf("isCalendarLocallyEmpty");
    const incAt = syncSrc.indexOf("if (cal.syncToken) {");
    assert.ok(guardAt > 0 && incAt > 0 && guardAt < incAt, "护栏必须排在增量分支之前，否则不生效");
  });

  await t("store.isCalendarLocallyEmpty 只按 calendarUrl 判空，不看 deleted", () => {
    const m = /isCalendarLocallyEmpty\(calendarUrl: string\): boolean \{([\s\S]*?)\n {2}\}/.exec(storeSrc);
    assert.ok(m, "store.ts 里应有 isCalendarLocallyEmpty");
    assert.ok(
      /it\.calendarUrl === calendarUrl/.test(m[1]),
      "应按 calendarUrl 匹配条目"
    );
    assert.ok(
      !/it\.deleted/.test(m[1]),
      "刻意**不**排除 deleted：待删项也说明本地有状态，把它算成空会触发无谓全量"
    );
  });
}

console.log(`[synctoken] 合计 ${passed} 项通过`);