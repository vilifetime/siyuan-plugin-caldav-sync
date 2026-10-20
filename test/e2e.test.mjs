/**
 * 端到端测试：真实 Radicale CalDAV 链路
 * 前置：pip install radicale（或 E2E_PYTHON 指向带 radicale 的解释器）
 * 覆盖：测试连接 / 自动发现 / MKCALENDAR / 拉取 / 上传 / 编辑 / 412 冲突 / sync-token 增量 / 删除 / 待办
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const py = process.env.E2E_PYTHON || path.join(os.homedir(), ".workbuddy/binaries/python/envs/default/Scripts/python.exe");
const PORT = 5232;
const BASE = `http://127.0.0.1:${PORT}/`;

// ---- 编译 core ----
const outDir = path.join(root, ".test-core");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts src/core/store.ts src/core/sync.ts ` +
  `--outDir .test-core --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);
const require = createRequire(import.meta.url);
const caldav = require(path.join(outDir, "caldav.js"));
const ics = require(path.join(outDir, "ics.js"));
const http = require(path.join(outDir, "http.js"));
const { setKernelBase } = http;

const auth = { username: "testuser", password: "testpass" };
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

// ---- 启动 Radicale（清空上次状态） ----
fs.rmSync(path.join(root, ".e2e-radicale"), { recursive: true, force: true });
const dir = path.join(root, ".e2e-radicale");
fs.mkdirSync(path.join(dir, "collections"), { recursive: true });
fs.writeFileSync(path.join(dir, "users"), "testuser:testpass\n");
fs.writeFileSync(
  path.join(dir, "config"),
  `
[server]
hosts = 127.0.0.1:${PORT}

[auth]
type = htpasswd
htpasswd_filename = ${path.join(dir, "users").replace(/\\/g, "/")}
htpasswd_encryption = plain

[rights]
type = owner_only

[storage]
type = multifilesystem
filesystem_folder = ${path.join(dir, "collections").replace(/\\/g, "/")}
`.trim() + "\n"
);

const radicaleLog = [];
// Windows 上必须走 radicale-win.py wrapper，不能 `-m radicale` —— 本机有建符号链接的
// 权限，Radicale 启动时的「能否建符号链接」探测会建一个再删，删目录符号链接必然
// WinError 5，进程起不来（详见 scripts/radicale-win.py 顶部注释）。
const radicaleEntry =
  process.platform === "win32" ? ["scripts/radicale-win.py"] : ["-m", "radicale"];
const radicale = spawn(py, [...radicaleEntry, "--config", path.join(dir, "config")], {
  stdio: ["ignore", "pipe", "pipe"],
  env: (() => {
    const env = { ...process.env };
    // WorkBuddy 等环境的 PYTHONPATH shim 会破坏 Radicale 的临时文件逻辑
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
    return env;
  })()
});
radicale.stderr.on("data", (d) => radicaleLog.push(String(d)));
radicale.stdout.on("data", (d) => radicaleLog.push(String(d)));
radicale.on("error", (e) => radicaleLog.push("SPAWN ERROR: " + e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE, { method: "GET" });
      if (r.status < 500) return true;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Radicale 未在预期时间内启动: " + radicaleLog.join(""));
}

try {
  await waitReady();
  console.log("[e2e] Radicale 已就绪");
  const channel = "direct";
  const CH = channel;

  await t("测试连接（PROPFIND + Basic 认证）", async () => {
    const r = await caldav.testConnection(BASE, CH, auth);
    assert.ok(r.ok, r.message);
  });

  await t("自动发现 principal / calendar-home", async () => {
    const r = await caldav.discoverCalendars(BASE, CH, auth);
    assert.ok(r.principal, "应有 principal: " + JSON.stringify(r));
    assert.ok(r.home, "应有 calendar-home");
  });

  await t("MKCALENDAR 创建日历后再发现", async () => {
    const res = await http.httpRequest(
      BASE + "testuser/e2e/",
      { method: "MKCALENDAR", body: `<?xml version="1.0"?><mkcalendar xmlns="urn:ietf:params:xml:ns:caldav"><set><prop xmlns="DAV:"><displayname>E2E 测试</displayname><resourcetype><collection/><calendar/></resourcetype></prop></set></mkcalendar>`, headers: { "Content-Type": "application/xml" } },
      CH,
      auth
    );
    assert.ok(res.status < 300 || res.status === 405, "MKCALENDAR 失败: " + res.status);
    const r = await caldav.discoverCalendars(BASE, CH, auth);
    const cal = r.calendars.find((c) => c.url.includes("/e2e/"));
    assert.ok(cal, "应发现新建日历: " + r.calendars.map((c) => c.url).join(","));
    assert.ok(/E2E|e2e/.test(cal.displayName) || cal.displayName, "日历名: " + cal.displayName);
  });

  const calUrl = BASE + "testuser/e2e/";
  const cal = { url: calUrl, displayName: "E2E", color: "#3b82f6", enabled: true, supportsEvent: true, supportsTodo: true };

  const eventItem = {
    uid: "e2e-event-1@siyuan",
    kind: "event",
    calendarUrl: calUrl,
    href: calUrl + "e2e-event-1.ics",
    summary: "端到端会议",
    description: "第一次描述",
    location: "3 号楼",
    allDay: false,
    start: "2026-09-10T10:00:00",
    end: "2026-09-10T11:00:00",
    alarms: [{ minutesBefore: 10 }],
    rrule: { freq: "WEEKLY", interval: 1, byDay: ["TH"], count: 3 },
    dirty: false
  };

  let etag1 = "";

  await t("上传新建日程（PUT）", async () => {
    const r = await caldav.putItem(eventItem, ics.itemToNewICS(eventItem), CH, auth);
    void r;
  });

  await t("拉取（calendar-query）解析正确", async () => {
    const r = await caldav.fetchCalendarItems(
      cal, CH, auth,
      caldav.icsRangeIso(Date.UTC(2026, 8, 1)),
      caldav.icsRangeIso(Date.UTC(2026, 11, 31))
    );
    const it = r.items.find((i) => i.uid === eventItem.uid);
    assert.ok(it, "应拉取到事件");
    assert.strictEqual(it.summary, "端到端会议");
    assert.strictEqual(it.location, "3 号楼");
    assert.ok(it.rrule && it.rrule.freq === "WEEKLY");
    assert.ok(it.etag, "应有 etag");
    etag1 = it.etag;
    const occs = ics.occurrencesInRange(it, Date.UTC(2026, 8, 1), Date.UTC(2026, 11, 31));
    assert.strictEqual(occs.length, 3, "每周四 x3，实际 " + JSON.stringify(occs));
  });

  await t("编辑后重新上传（保留原属性）", async () => {
    const r = await caldav.fetchCalendarItems(cal, CH, auth, caldav.icsRangeIso(Date.UTC(2026, 8, 1)), caldav.icsRangeIso(Date.UTC(2026, 11, 31)));
    const it = r.items.find((i) => i.uid === eventItem.uid);
    it.summary = "改名后的会议";
    it.location = "线上";
    const put = await caldav.putItem(it, ics.itemToEditedICS(it), CH, auth);
    const r2 = await caldav.fetchCalendarItems(cal, CH, auth, caldav.icsRangeIso(Date.UTC(2026, 8, 1)), caldav.icsRangeIso(Date.UTC(2026, 11, 31)));
    const it2 = r2.items.find((i) => i.uid === eventItem.uid);
    assert.strictEqual(it2.summary, "改名后的会议");
    assert.strictEqual(it2.location, "线上");
    assert.strictEqual(it2.alarms[0].minutesBefore, 10, "VALARM 应保留");
    void put;
  });

  await t("编辑不能抹掉服务端非受管属性（raw 全链路）", async () => {
    // 2026-10-14 数据丢失事故的端到端复现位。
    // 根因：itemsFromICS 从不把服务端原文写进 item.raw → itemToEditedICS 退化成
    // itemToNewICS 整份重拼 → ORGANIZER / ATTENDEE / VTIMEZONE / X- 扩展 /
    // 二进制 ATTACH / 同一资源里的其它组件**全部丢失**。
    // 用户实测：改个标题，服务器上那个附件就没了。
    //
    // 上面那条「编辑后重新上传」用例抓不到这个 bug —— 它只断言 VALARM，
    // 而 VALARM 在 itemToNewICS 里也会被写出来，两条路径都有。
    // 所以这里必须用**只有 raw 路径才保得住的属性**来钉。
    const uid = "e2e-raw-loss@siyuan";
    const href = calUrl + "e2e-raw-loss.ics";
    const seedIcs = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//e2e//raw-loss//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTAMP:20260901T000000Z",
      "DTSTART:20260915T100000Z",
      "DTEND:20260915T110000Z",
      "SUMMARY:带非受管属性的会",
      "ORGANIZER:mailto:boss@example.com",
      "X-CUSTOM-FIELD:keep-me",
      "ATTACH;VALUE=BINARY;ENCODING=BASE64:QUJDREVG",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    await http.httpRequest(href, { method: "PUT", body: seedIcs, headers: { "Content-Type": "text/calendar" } }, CH, auth);

    // ① 拉回来时 raw 必须在（这一条就是事故的根）
    const r = await caldav.fetchCalendarItems(
      cal, CH, auth,
      caldav.icsRangeIso(Date.UTC(2026, 8, 1)),
      caldav.icsRangeIso(Date.UTC(2026, 11, 31))
    );
    const it = r.items.find((i) => i.uid === uid);
    assert.ok(it, "应拉取到种子条目");
    assert.ok(typeof it.raw === "string" && it.raw.length > 0,
      "拉回的条目必须带 raw —— 没有它，编辑就走整份重拼");
    assert.ok(it.raw.includes("ORGANIZER"), "raw 应含服务端原文的 ORGANIZER");

    // ② 只改标题，推回去
    it.summary = "只改了标题";
    await caldav.putItem(it, ics.itemToEditedICS(it), CH, auth);

    // ③ 回读服务端原文：非受管属性必须一条不少
    const back = await http.httpRequest(href, { method: "GET" }, CH, auth);
    assert.ok(back.status === 200, "GET 回读失败: " + back.status);
    assert.ok(back.body.includes("SUMMARY:只改了标题"), "标题改动应生效");
    assert.ok(back.body.includes("ORGANIZER:mailto:boss@example.com"),
      "ORGANIZER 必须保留 —— 它被抹掉就是这个事故本身");
    assert.ok(back.body.includes("X-CUSTOM-FIELD:keep-me"),
      "X- 扩展属性必须保留");
    assert.ok(/ATTACH[^\r\n]*BINARY[^\r\n]*QUJDREVG/.test(back.body.replace(/\r\n /g, "")),
      "二进制 ATTACH 必须原样保留（RFC 5545 折行要先拼回去再判）");
  });

  await t("过期 If-Match 上传应 412", async () => {
    const stale = { ...eventItem, etag: etag1 };
    await assert.rejects(
      () => caldav.putItem(stale, ics.itemToEditedICS(stale), CH, auth),
      (e) => e.status === 412 || e.message.includes("412"),
      "应抛出 412 冲突"
    );
  });

  await t("sync-token 增量同步", async () => {
    // 取 sync-token
    const disc = await caldav.discoverCalendars(BASE, CH, auth, calUrl);
    const token = disc.calendars.find((c) => c.url.includes("/e2e/"))?.syncToken;
    // 新增第二个事件
    const ev2 = { ...eventItem, uid: "e2e-event-2@siyuan", href: calUrl + "e2e-event-2.ics", summary: "增量新事件", rrule: undefined };
    await caldav.putItem(ev2, ics.itemToNewICS(ev2), CH, auth);
    // 增量拉取
    const r = await caldav.syncCollection(cal, CH, auth, token || "");
    const added = r.items.find((i) => i.uid === "e2e-event-2@siyuan");
    assert.ok(added, "增量应包含新事件，实际 " + r.items.length + " 条");
  });

  await t("上传待办（VTODO）并拉取", async () => {
    const todo = {
      uid: "e2e-todo-1@siyuan",
      kind: "todo",
      calendarUrl: calUrl,
      href: calUrl + "e2e-todo-1.ics",
      summary: "端到端待办",
      allDay: false,
      start: "2026-09-11T18:00:00",
      end: "2026-09-11T18:00:00",
      priority: 3,
      status: "NEEDS-ACTION",
      percent: 0,
      dirty: false
    };
    await caldav.putItem(todo, ics.itemToNewICS(todo), CH, auth);
    const r = await caldav.fetchCalendarItems(cal, CH, auth, caldav.icsRangeIso(Date.UTC(2026, 8, 1)), caldav.icsRangeIso(Date.UTC(2026, 11, 31)));
    const it = r.items.find((i) => i.uid === todo.uid);
    assert.ok(it, "应拉取到待办");
    assert.strictEqual(it.kind, "todo");
    assert.strictEqual(it.priority, 3);
    assert.strictEqual(it.summary, "端到端待办");
  });

  await t("删除服务端条目", async () => {
    const r = await caldav.fetchCalendarItems(cal, CH, auth, caldav.icsRangeIso(Date.UTC(2026, 8, 1)), caldav.icsRangeIso(Date.UTC(2026, 11, 31)));
    const it = r.items.find((i) => i.uid === "e2e-event-2@siyuan");
    assert.ok(it, "删除前应存在");
    await caldav.deleteItem(it, CH, auth);
    const r2 = await caldav.fetchCalendarItems(cal, CH, auth, caldav.icsRangeIso(Date.UTC(2026, 8, 1)), caldav.icsRangeIso(Date.UTC(2026, 11, 31)));
    assert.ok(!r2.items.find((i) => i.uid === "e2e-event-2@siyuan"), "删除后应不存在");
  });

  console.log(`\n[e2e] ${passed} 项通过（真实 Radicale ${PORT}）`);
} finally {
  radicale.kill();
}
