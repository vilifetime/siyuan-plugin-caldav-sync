/**
 * 多日历账户回归测试（2026-10-25 多账户重构）
 *
 * 背景：插件此前只能配一个日历服务器（serverUrl/凭据/日历全平铺在 CalSettings 上）。
 * 雄哥要求同时支持多个日历账户：每个账户独立设置启用开关、服务器、日历、同步参数，
 * 全局只留不分服务器的设置。本次重构把 10 个字段下沉进 CalAccount[]，
 * 老数据由 migrateToAccounts() 一次性迁移。
 *
 * 覆盖：
 *   A. migrateToAccounts：老数据整包搬迁零丢失、老键摘掉（防两处真相）、幂等、
 *      全新安装不造空账户、iCloud 自动命名
 *   B. enabledAccounts / enabledCalendars：停用账户、停用日历都被排除
 *   C. accountOfUrl / findCalendarByUrl / resolveDefaultCalendar / accountOfItem：
 *      反查与「默认日历失效回退第一个启用账户的第一个启用日历」
 *   D. isConfigured：任一启用账户有启用日历
 *   E. syncAll：**单个账户挂掉不阻塞其他账户**（凭据错记带账户名的错误后 continue；
 *      停用账户完全不碰；两个好账户各拉各的）
 *   F. 设置弹窗 HTML（jsdom 真渲染）：账户卡片结构、手风琴展开态、停用置灰、
 *      全局段控件、空账户提示、默认日历下拉只含启用日历、老平铺入参兼容
 *   G. 源码级防漂移：syncAll 按账户循环且错误带账户名、persist 逐账户加密、
 *      侧栏按账户分组
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-multiacc");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
// core 六件套 + secret：扁平编译到 .test-multiacc（types.js / store.js / sync.js …）
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts src/core/store.ts src/core/sync.ts src/core/secret.ts ` +
    `--outDir .test-multiacc --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "pipe" }
);

// settings-dialog 需要项目 tsconfig 的 paths（"@/*" → "src/*"），CLI 不支持 --paths，走 -p。
// 同 purge-ui.test.mjs：include 单文件 + rootDir src，产物保留目录结构。
const tsCfg = path.join(root, "tsconfig.multiacc.json");
fs.writeFileSync(
  tsCfg,
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2020",
        module: "commonjs",
        moduleResolution: "node",
        esModuleInterop: true,
        skipLibCheck: true,
        strict: false,
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
        outDir: ".test-multiacc",
        rootDir: "src"
      },
      include: ["src/ui/settings-dialog.ts"]
    },
    null,
    2
  )
);
try {
  execSync(`npx tsc -p tsconfig.multiacc.json`, { cwd: root, stdio: "pipe" });
} finally {
  // unlinkSync 而不是 rmSync：宿主 safe-delete 拦截 rmSync（见 list-view.test.mjs 注释）
  try {
    fs.unlinkSync(tsCfg);
  } catch {
    /* 临时 tsconfig，删不掉不影响结论 */
  }
}

const require = createRequire(import.meta.url);
// "siyuan" 包只有 .d.ts 没有运行时入口，require 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED —— 给空桩。
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(outDir, request.slice(2));
  if (request === "siyuan" || request.startsWith("siyuan/")) {
    return path.join(outDir, "siyuan-stub.js");
  }
  return origResolve.call(this, request, ...rest);
};
fs.writeFileSync(path.join(outDir, "siyuan-stub.js"), `"use strict";\nmodule.exports = {};\n`);

const typesMod = require(path.join(outDir, "types.js"));
const storeMod = require(path.join(outDir, "store.js"));
const syncMod = require(path.join(outDir, "sync.js"));
const {
  migrateToAccounts,
  enabledAccounts,
  enabledCalendars,
  accountOfUrl,
  findCalendarByUrl,
  accountOfItem,
  resolveDefaultCalendar,
  newAccountId
} = typesMod;

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

const multistatus = (hrefs) =>
  `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
  hrefs
    .map(
      (h) =>
        `<D:response><D:href>${h}</D:href><D:propstat><D:prop><D:getetag>"e-${h}"</D:getetag></D:prop>` +
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

const mkIcs = (uid, summary) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:${uid}\r\nSUMMARY:${summary}\r\n` +
  `DTSTAMP:20260101T000000Z\r\nEND:VTODO\r\nEND:VCALENDAR`;

const CAL_A = "http://dav-a.test/cal/";
const CAL_B = "http://dav-b.test/cal/";

const mkCal = (over = {}) => ({
  url: CAL_A,
  displayName: "工作",
  enabled: true,
  supportsEvent: true,
  supportsTodo: true,
  ...over
});

const mkAccount = (over = {}) => ({
  id: "acc-a",
  name: "账户A",
  enabled: true,
  serverUrl: "http://dav-a.test/",
  username: "ua",
  password: "pa",
  calendarPath: "",
  serverType: "caldav",
  channel: "direct",
  conflict: "server",
  pastDays: 90,
  futureDays: 370,
  calendars: [mkCal()],
  ...over
});

async function mkStoreMulti(accounts, items = []) {
  const st = new storeMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  await st.load();
  st.settings = { ...st.settings, syncIntervalMin: 0, accounts };
  items.forEach((it) => st.put(it));
  return st;
}

const mkItem = (over = {}) => ({
  uid: "u1@test",
  kind: "todo",
  calendarUrl: CAL_A,
  href: CAL_A + "u1.ics",
  summary: "待办",
  allDay: false,
  start: "",
  end: "",
  dirty: false,
  etag: '"server-etag"',
  ...over
});

// ============================================================
console.log("[multiacc] A. migrateToAccounts：老数据迁移");
// ============================================================

await t("老数据整包搬进 accounts[0]：凭据/日历/通道/冲突/窗口零丢失", () => {
  const s = {
    serverType: "caldav",
    serverUrl: "http://nas:5232/",
    username: "bob",
    password: "s3cret",
    calendarPath: "http://nas:5232/bob/personal/",
    channel: "proxy",
    conflict: "local",
    pastDays: 30,
    futureDays: 100,
    calendars: [{ url: "http://nas:5232/bob/personal/", displayName: "个人", enabled: true, supportsEvent: true, supportsTodo: true }]
  };
  migrateToAccounts(s);
  assert.strictEqual(s.accounts.length, 1, "应恰好一个账户");
  const a = s.accounts[0];
  assert.strictEqual(a.serverUrl, "http://nas:5232/");
  assert.strictEqual(a.username, "bob");
  assert.strictEqual(a.password, "s3cret");
  assert.strictEqual(a.calendarPath, "http://nas:5232/bob/personal/");
  assert.strictEqual(a.channel, "proxy");
  assert.strictEqual(a.conflict, "local");
  assert.strictEqual(a.pastDays, 30);
  assert.strictEqual(a.futureDays, 100);
  assert.strictEqual(a.calendars.length, 1);
  assert.strictEqual(a.calendars[0].displayName, "个人");
  assert.ok(a.id, "应生成账户 ID");
  assert.strictEqual(a.enabled, true, "老账户默认启用");
});

await t("老字段从 settings 上摘掉 —— 留着会被 persist 写回，变成第二处真相", () => {
  const s = { serverUrl: "http://nas:5232/", username: "bob", password: "p", calendars: [] };
  migrateToAccounts(s);
  for (const k of ["serverUrl", "username", "password", "calendarPath", "serverType", "channel", "conflict", "pastDays", "futureDays", "calendars"]) {
    assert.ok(!(k in s), `老键 ${k} 应被摘掉`);
  }
});

await t("幂等：重复调用不产生第二个账户、不改内容", () => {
  const s = { serverUrl: "http://nas:5232/", username: "bob", password: "p", calendars: [{ url: "http://nas:5232/c/", displayName: "c", enabled: true }] };
  migrateToAccounts(s);
  const first = JSON.stringify(s.accounts);
  migrateToAccounts(s);
  migrateToAccounts(s);
  assert.strictEqual(JSON.stringify(s.accounts), first, "重跑必须完全不变");
});

await t("全新安装（老键不在）不动 accounts", () => {
  const s = { accounts: [], syncIntervalMin: 5 };
  migrateToAccounts(s);
  assert.deepStrictEqual(s.accounts, []);
});

await t("老键在但全空 ⇒ 空数组，不造空账户占位", () => {
  const s = { serverUrl: "", username: "", password: "", calendars: [] };
  migrateToAccounts(s);
  assert.deepStrictEqual(s.accounts, [], "全空老数据不该留下一个空账户");
});

await t("serverType=icloud ⇒ 账户名自动命名「iCloud 账户」", () => {
  const s = { serverType: "icloud", serverUrl: "https://caldav.icloud.com", username: "a@b.com", password: "p", calendars: [] };
  migrateToAccounts(s);
  assert.strictEqual(s.accounts[0].name, "iCloud 账户");
});

// ============================================================
console.log("[multiacc] B/C. 启用集合与反查");
// ============================================================

const accA = mkAccount({ id: "acc-a", name: "公司", calendars: [mkCal({ url: CAL_A, displayName: "工作" }), mkCal({ url: CAL_A + "off/", displayName: "停用的", enabled: false })] });
const accB = mkAccount({ id: "acc-b", name: "家里", enabled: false, serverUrl: "http://dav-b.test/", username: "ub", password: "pb", calendars: [mkCal({ url: CAL_B, displayName: "家庭" })] });
const twoAcc = { accounts: [accA, accB] };

await t("enabledAccounts：停用账户被排除", () => {
  assert.deepStrictEqual(enabledAccounts(twoAcc).map((a) => a.id), ["acc-a"]);
});

await t("enabledCalendars：停用账户里的日历即使 enabled 也不出现", () => {
  const urls = enabledCalendars(twoAcc).map((c) => c.url);
  assert.deepStrictEqual(urls, [CAL_A], "acc-b 已停用，其日历必须排除，实际 " + JSON.stringify(urls));
});

await t("enabledCalendars：停用日历被排除", () => {
  const urls = enabledCalendars({ accounts: [accA] }).map((c) => c.url);
  assert.deepStrictEqual(urls, [CAL_A], "账户内停用的日历也要排除");
});

await t("空 accounts ⇒ 空启用集合", () => {
  assert.deepStrictEqual(enabledCalendars({ accounts: [] }), []);
});

await t("accountOfUrl 跨账户反查", () => {
  assert.strictEqual(accountOfUrl(twoAcc, CAL_A)?.id, "acc-a");
  assert.strictEqual(accountOfUrl(twoAcc, CAL_B)?.id, "acc-b");
  assert.strictEqual(accountOfUrl(twoAcc, "http://nope.test/"), undefined);
  assert.strictEqual(accountOfUrl(twoAcc, ""), undefined);
});

await t("findCalendarByUrl 含停用日历（编辑条目所属日历停用了也要找得到）", () => {
  assert.strictEqual(findCalendarByUrl(twoAcc, CAL_A + "off/")?.displayName, "停用的");
  assert.strictEqual(findCalendarByUrl(twoAcc, CAL_A)?.displayName, "工作");
});

await t("accountOfItem 按条目反查", () => {
  assert.strictEqual(accountOfItem(twoAcc, mkItem({ calendarUrl: CAL_B }))?.id, "acc-b");
  assert.strictEqual(accountOfItem(twoAcc, mkItem({ calendarUrl: "http://nope.test/" })), undefined);
});

await t("resolveDefaultCalendar：defaultCalendarUrl 有效就用它", () => {
  const hit = resolveDefaultCalendar({ ...twoAcc, defaultCalendarUrl: CAL_A });
  assert.strictEqual(hit?.url, CAL_A);
});

await t("resolveDefaultCalendar：失效（指向停用日历/不存在）回退第一个启用账户的第一个启用日历", () => {
  const hit = resolveDefaultCalendar({ ...twoAcc, defaultCalendarUrl: CAL_A + "off/" });
  assert.strictEqual(hit?.url, CAL_A, "停用日历不能当默认，应回退到第一个启用日历");
  const hit2 = resolveDefaultCalendar({ ...twoAcc, defaultCalendarUrl: "http://gone.test/" });
  assert.strictEqual(hit2?.url, CAL_A);
});

await t("resolveDefaultCalendar：全部停用 ⇒ undefined（调用方要能兜住）", () => {
  assert.strictEqual(resolveDefaultCalendar({ accounts: [accB] }), undefined);
});

// ============================================================
console.log("[multiacc] D. isConfigured");
// ============================================================

await t("任一启用账户有启用日历 ⇒ 已配置", () => {
  const st = new storeMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  st.settings = { ...st.settings, accounts: [accA, accB] };
  assert.strictEqual(st.isConfigured(), true);
});

await t("只有停用账户 ⇒ 未配置", () => {
  const st = new storeMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  st.settings = { ...st.settings, accounts: [accB] };
  assert.strictEqual(st.isConfigured(), false);
});

await t("账户有日历但全停用 ⇒ 未配置", () => {
  const st = new storeMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  st.settings = { ...st.settings, accounts: [mkAccount({ calendars: [mkCal({ enabled: false })] })] };
  assert.strictEqual(st.isConfigured(), false);
});

// ============================================================
console.log("[multiacc] E. syncAll：单账户挂掉不阻塞其他账户");
// ============================================================

/**
 * 双账户路由：
 *  - A（坏）：缺用户名 —— 但**根本不该收到任何请求**（凭据检查在循环最前面）
 *  - B（好）：正常 REPORT 拉一条
 * PROPFIND 分流：能力探测（supported-calendar-component-set）回 404 ⇒ 探测失败保留缺省；
 * sync-token 探测回空 multistatus ⇒ 拿不到 token；其余 PROPFIND（资源清单对账）列已有资源。
 */
const twoAccRouter = (extra = {}) => (req) => {
  if (req.url.includes("dav-a.test")) return { status: 401, body: "不该连坏账户" };
  if (req.method === "PROPFIND" && /supported-calendar-component-set/.test(req.body)) return { status: 404, body: "" };
  if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
  if (req.method === "PROPFIND") return { status: 207, body: multistatus(["/cal/b1.ics"]) };
  if (req.method === "REPORT") {
    return { status: 207, body: calQuery([{ href: "/cal/b1.ics", etag: "eb1", ics: mkIcs("b1@test", "家里待办") }]) };
  }
  return { status: 200, body: "" };
};

await t("账户 A 缺用户名 ⇒ 只记一条带账户名的错误，B 照常拉取", async () => {
  const broken = mkAccount({ id: "acc-a", name: "坏账户", username: "" });
  const good = mkAccount({ id: "acc-b", name: "好账户", serverUrl: "http://dav-b.test/", username: "ub", password: "pb", calendars: [mkCal({ url: CAL_B })] });
  const st = await mkStoreMulti([broken, good]);
  const { calls, restore } = withFetch(twoAccRouter());
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.ok, false, "有账户出错整体不算完全成功");
    assert.ok(
      rep.errors.some((e) => e.includes("坏账户") && e.includes("用户名")),
      "错误必须带账户名与原因，实际 " + JSON.stringify(rep.errors)
    );
    assert.ok(!calls.some((c) => c.url.includes("dav-a.test")), "坏账户不该收到任何请求（凭据检查前置）");
    assert.ok(rep.fetched >= 1, "好账户的条目必须照常拉取，实际 fetched=" + rep.fetched);
    assert.deepStrictEqual(st.getAll().map((i) => i.uid), ["b1@test"]);
  } finally {
    restore();
  }
});

await t("账户 A 停用 ⇒ 完全不碰（无请求、无错误）", async () => {
  const off = mkAccount({ id: "acc-a", name: "停用账户", enabled: false });
  const good = mkAccount({ id: "acc-b", name: "好账户", serverUrl: "http://dav-b.test/", username: "ub", password: "pb", calendars: [mkCal({ url: CAL_B })] });
  const st = await mkStoreMulti([off, good]);
  const { calls, restore } = withFetch(twoAccRouter());
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.ok(!calls.some((c) => c.url.includes("dav-a.test")), "停用账户不该被连接");
    assert.strictEqual(rep.ok, true, "停用账户不该产生错误");
    assert.deepStrictEqual(st.getAll().map((i) => i.uid), ["b1@test"]);
  } finally {
    restore();
  }
});

await t("两个账户都正常 ⇒ 两边条目都拉得到", async () => {
  const a = mkAccount({ id: "acc-a", name: "公司" });
  const b = mkAccount({ id: "acc-b", name: "家里", serverUrl: "http://dav-b.test/", username: "ub", password: "pb", calendars: [mkCal({ url: CAL_B })] });
  const st = await mkStoreMulti([a, b]);
  const { calls, restore } = withFetch((req) => {
    if (req.method === "PROPFIND" && /supported-calendar-component-set/.test(req.body)) return { status: 404, body: "" };
    if (req.method === "PROPFIND" && /sync-token/.test(req.body)) return { status: 207, body: multistatus([]) };
    if (req.method === "PROPFIND") {
      const which = req.url.includes("dav-b.test") ? ["/cal/b1.ics"] : ["/cal/a1.ics"];
      return { status: 207, body: multistatus(which) };
    }
    if (req.method === "REPORT") {
      const which = req.url.includes("dav-b.test")
        ? [{ href: "/cal/b1.ics", etag: "eb1", ics: mkIcs("b1@test", "家里待办") }]
        : [{ href: "/cal/a1.ics", etag: "ea1", ics: mkIcs("a1@test", "公司待办") }];
      return { status: 207, body: calQuery(which) };
    }
    return { status: 200, body: "" };
  });
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.ok, true, "两个好账户不该报错：" + JSON.stringify(rep.errors));
    assert.ok(calls.some((c) => c.url.includes("dav-a.test")), "应连过账户 A");
    assert.ok(calls.some((c) => c.url.includes("dav-b.test")), "应连过账户 B");
    assert.deepStrictEqual(st.getAll().map((i) => i.uid).sort(), ["a1@test", "b1@test"]);
  } finally {
    restore();
  }
});

await t("没有启用账户 ⇒ 明确报错（不能静默成功）", async () => {
  const st = await mkStoreMulti([mkAccount({ enabled: false })]);
  const { restore } = withFetch(() => ({ status: 200, body: "" }));
  try {
    const eng = new syncMod.SyncEngine(st, () => "direct");
    const rep = await eng.syncAll();
    assert.strictEqual(rep.ok, false);
    assert.ok(rep.errors.some((e) => e.includes("没有启用的账户")), JSON.stringify(rep.errors));
  } finally {
    restore();
  }
});

// ============================================================
console.log("[multiacc] F. 设置弹窗 HTML（jsdom 真渲染）");
// ============================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try {
  globalThis.navigator = dom.window.navigator;
} catch {
  /* 某些 Node 版本 navigator 只读 */
}
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;

const { settingsHtml } = require(path.join(outDir, "ui", "settings-dialog.js"));

const htmlSettings = {
  accounts: [
    {
      ...mkAccount({
        id: "acc-a",
        name: "公司",
        calendars: [
          { url: CAL_A, displayName: "工作", enabled: true, supportsEvent: true, supportsTodo: true, eventColor: "#3b82f6", todoColor: "#f97316" },
          { url: CAL_A + "off/", displayName: "停用的", enabled: false, supportsEvent: true, supportsTodo: true, eventColor: "#3b82f6", todoColor: "#f97316" }
        ]
      })
    },
    {
      ...mkAccount({
        id: "acc-b",
        name: "家里",
        enabled: false,
        serverUrl: "http://dav-b.test/",
        username: "ub",
        password: "pb",
        calendars: [{ url: CAL_B, displayName: "家庭", enabled: true, supportsEvent: true, supportsTodo: true, eventColor: "#3b82f6", todoColor: "#f97316" }]
      })
    }
  ],
  syncIntervalMin: 10,
  enableReminders: true,
  attachSizeMaxMB: 5,
  icsSizeMaxMB: 10
};

const doc = new JSDOM(`<body>${settingsHtml(htmlSettings, false, "acc-a")}</body>`).window.document;

await t("账户卡片：两张卡、data-acc 标识、开关与删除按钮在位", () => {
  const cards = doc.querySelectorAll(".caldav-acc");
  assert.strictEqual(cards.length, 2, "应渲染两张账户卡片");
  assert.strictEqual(cards[0].getAttribute("data-acc"), "acc-a");
  assert.strictEqual(cards[1].getAttribute("data-acc"), "acc-b");
  assert.ok(doc.querySelector('[data-acc-toggle="acc-a"]'), "应有账户启用开关");
  assert.ok(doc.querySelector('[data-acc-toggle="acc-a"]').checked, "acc-a 默认启用应勾选");
  assert.ok(!doc.querySelector('[data-acc-toggle="acc-b"]').checked, "acc-b 停用不该勾选");
  const del = doc.querySelector('[data-action="acc-del"][data-acc-del="acc-a"]');
  assert.ok(del, "应有删除账户按钮");
});

await t("删除确认条默认隐藏（二次点击确认，不用 confirm()）", () => {
  const conf = doc.querySelector('[data-acc-delconf]');
  assert.ok(conf, "应有删除确认条");
  assert.ok(conf.hasAttribute("hidden"), "确认条默认必须隐藏");
  assert.ok(conf.querySelector('[data-action="acc-del-ok"]'), "确认条里应有「确认删除」");
  assert.ok(conf.querySelector('[data-action="acc-del-cancel"]'), "确认条里应有「取消」");
});

await t("手风琴：只展开 activeAccId 的账户，其余 body hidden", () => {
  const open = doc.querySelector('.caldav-acc[data-acc="acc-a"] .caldav-acc-body');
  const closed = doc.querySelector('.caldav-acc[data-acc="acc-b"] .caldav-acc-body');
  assert.ok(!open.hasAttribute("hidden"), "acc-a 被展开");
  assert.ok(closed.hasAttribute("hidden"), "acc-b 未展开");
});

await t("展开的账户含「服务器 / 日历 / 同步」三段与全部控件", () => {
  const body = doc.querySelector('.caldav-acc[data-acc="acc-a"]');
  for (const k of ["server", "username", "password", "path", "channel", "serverType", "conflict", "past", "future", "accName"]) {
    assert.ok(body.querySelector(`[data-s="${k}"]`), `账户 body 应含控件 data-s="${k}"`);
  }
  assert.ok(body.querySelector("[data-cals]"), "应有日历勾选区");
  assert.ok(body.querySelector('.caldav-acc-cal [type="checkbox"]'), "日历勾选应在");
  assert.ok(body.querySelector('[data-action="discover"]'), "应有「发现日历」按钮");
  assert.ok(body.querySelector('[data-action="test"]'), "应有「测试连接」按钮");
});

await t("停用账户卡片带 is-off（置灰）", () => {
  assert.ok(doc.querySelector('.caldav-acc[data-acc="acc-b"]').classList.contains("is-off"));
  assert.ok(!doc.querySelector('.caldav-acc[data-acc="acc-a"]').classList.contains("is-off"));
});

await t("全局段控件在位（同步间隔/默认日历/附件上限）", () => {
  assert.ok(doc.querySelector('[data-s="interval"]'), "同步间隔");
  assert.ok(doc.querySelector('[data-s="defaultCal"]'), "默认日历下拉");
  assert.ok(doc.querySelector('[data-s="attachMax"]'), "附件上限");
  assert.ok(doc.querySelector('[data-s="icsMax"]'), "ICS 上限");
  assert.ok(doc.querySelector('[data-s="reminders"]'), "提醒开关");
});

await t("默认日历下拉只含启用账户的启用日历", () => {
  const sel = doc.querySelector('[data-s="defaultCal"]');
  const urls = Array.from(sel.querySelectorAll("option")).map((o) => o.getAttribute("value")).filter(Boolean);
  assert.deepStrictEqual(urls, [CAL_A], "停用账户/停用日历的 url 都不该出现，实际 " + JSON.stringify(urls));
});

await t("没有账户时给出「添加账户」提示", () => {
  const d2 = new JSDOM(`<body>${settingsHtml({ accounts: [], syncIntervalMin: 0 }, false)}</body>`).window.document;
  assert.strictEqual(d2.querySelectorAll(".caldav-acc").length, 0);
  assert.ok(d2.querySelector('[data-action="acc-add"]'), "应有「添加账户」按钮");
  assert.ok(/添加任何日历账户/.test(d2.body.textContent), "应有引导文案");
});

await t("老平铺入参兼容：settingsHtml 内部先迁移再渲染", () => {
  const legacy = {
    serverType: "caldav",
    serverUrl: "http://legacy.test/",
    username: "u",
    password: "p",
    calendars: [{ url: "http://legacy.test/cal/", displayName: "老日历", enabled: true, supportsEvent: true, supportsTodo: true, eventColor: "#3b82f6", todoColor: "#f97316" }],
    syncIntervalMin: 5
  };
  const d3 = new JSDOM(`<body>${settingsHtml(legacy, false)}</body>`).window.document;
  const cards = d3.querySelectorAll(".caldav-acc");
  assert.strictEqual(cards.length, 1, "老数据应迁移出恰好一张卡");
  const server = cards[0].querySelector('[data-s="server"]');
  assert.strictEqual(server.value, "http://legacy.test/", "服务器地址应迁移进卡片");
  assert.ok(cards[0].querySelector('[data-s="username"]').value === "u", "用户名应迁移进卡片");
});

await t("整页不把 SVG 源码当文字输出", () => {
  assert.ok(!doc.body.textContent.includes("<svg"), "页面文本里出现了 SVG 源码");
  assert.ok(!doc.body.textContent.includes("viewBox"), "页面文本里出现了 viewBox 字面量");
});

// ============================================================
console.log("[multiacc] G. 源码级防漂移");
// ============================================================

{
  const syncSrc = fs.readFileSync(path.join(root, "src/core/sync.ts"), "utf8");
  const storeSrc = fs.readFileSync(path.join(root, "src/core/store.ts"), "utf8");
  const typesSrc = fs.readFileSync(path.join(root, "src/core/types.ts"), "utf8");
  const panelSrc = fs.readFileSync(path.join(root, "src/ui/panel.ts"), "utf8");
  const cssSrc = fs.readFileSync(path.join(root, "src/index.css"), "utf8");

  await t("syncAll 按启用账户循环", () => {
    assert.ok(/for \(const acc of accounts\)/.test(syncSrc), "syncAll 必须遍历启用账户");
    assert.ok(/const accounts = enabledAccounts\(this\.store\.settings\);/.test(syncSrc), "账户集合取自 enabledAccounts");
  });

  await t("单账户错误带账户名且 continue（不能 return/抛错把其他账户带停）", () => {
    assert.ok(/账户「\$\{acc\.name\}」/.test(syncSrc), "错误文案必须带账户名");
    const m = /const credErr = this\.accountCredentialError\(acc\);[\s\S]*?continue;/.exec(syncSrc);
    assert.ok(m, "凭据错误分支必须 continue（跳过该账户、其他账户继续）");
    const stale = /const stale = staleCalendarNames\(acc\.serverUrl, accCals\);[\s\S]*?continue;/.exec(syncSrc);
    assert.ok(stale, "stale 日历分支必须 continue");
  });

  await t("拉取按账户取通道与凭据（channelOf(acc)/authOf(acc)）", () => {
    assert.ok(/fetchCalendarItems\(\s*cal,\s*this\.channelOf\(acc\)/.test(syncSrc), "calendar-query 必须带账户通道");
    assert.ok(/this\.authOf\(acc\)/.test(syncSrc), "必须带账户凭据");
  });

  await t("同步窗口按账户（pastDays/futureDays 取 acc 的）", () => {
    assert.ok(/Date\.now\(\) - acc\.pastDays \* 86400000/.test(syncSrc), "rangeStart 应按账户 pastDays");
    assert.ok(/Date\.now\(\) \+ acc\.futureDays \* 86400000/.test(syncSrc), "rangeEnd 应按账户 futureDays");
  });

  await t("persist 逐账户加密，settings 只写 accounts（不写平铺 serverUrl）", () => {
    assert.ok(/for \(const acc of this\.settings\.accounts\)/.test(storeSrc), "persist 必须逐账户处理密码");
    assert.ok(/settings: \{ \.\.\.this\.settings, accounts \}/.test(storeSrc), "落盘的 settings 只覆盖 accounts 一个键");
  });

  await t("migrateToAccounts 幂等判据是老键在不在", () => {
    assert.ok(/"serverUrl" in s/.test(typesSrc), "判据必须是老键存在性（accounts 恒为数组会被 DEFAULT 合并骗过去）");
    assert.ok(/delete s\[k\]/.test(typesSrc), "老键必须摘掉");
  });

  await t("侧栏按账户分组渲染，CSS 配套在位", () => {
    assert.ok(/caldav-cal-group/.test(panelSrc), "panel.ts 应按账户分组渲染日历列表");
    assert.ok(/caldav-cal-group-name/.test(panelSrc), "分组应有账户名");
    assert.ok(/enabledCalendars\(/.test(panelSrc), "可见性判据走 enabledCalendars 唯一入口");
    assert.ok(/\.caldav-cal-group/.test(cssSrc), "index.css 应有分组样式");
    assert.ok(/\.caldav-cal-group\.is-off/.test(cssSrc), "停用账户分组应有置灰样式");
  });
}

console.log(`\n[multiacc] 合计 ${passed} 项通过`);
