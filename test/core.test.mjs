/**
 * 核心逻辑单测：ICS 解析/序列化、RRULE 展开、日期工具
 * 运行前先用 tsc 把 src/core 编译到 .test-core
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-core");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts src/core/store.ts src/core/sync.ts src/core/secret.ts src/core/reminder.ts ` +
  `--outDir .test-core --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
// .test-core 内声明 cjs，避免被根 package.json 的 type:module 影响
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const ics = require(path.join(outDir, "ics.js"));
const date = require(path.join(outDir, "date.js"));
const storeMod = require(path.join(outDir, "store.js"));

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n    ", e.message);
    process.exitCode = 1;
  }
}

console.log("[core] ICS 解析");
const sample = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:evt-1@test",
  "SUMMARY:团队例会\\, 每周",
  "LOCATION:会议室\\n二楼",
  "DTSTART:20260910T100000Z",
  "DTEND:20260910T110000Z",
  "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=4",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "ACTION:DISPLAY",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VTODO",
  "UID:todo-1@test",
  "SUMMARY:提交报告",
  "DUE:20260911T180000Z",
  "PRIORITY:3",
  "STATUS:NEEDS-ACTION",
  "END:VTODO",
  "END:VCALENDAR"
].join("\r\n");

const items = ics.itemsFromICS(sample, "http://x/cal/", "http://x/cal/evt1.ics", "abc");
t("解析出 1 事件 + 1 待办", () => assert.strictEqual(items.length, 2));
t("事件字段", () => {
  const ev = items[0];
  assert.strictEqual(ev.kind, "event");
  assert.strictEqual(ev.summary, "团队例会, 每周");
  assert.strictEqual(ev.location, "会议室\n二楼");
  assert.strictEqual(ev.allDay, false);
  assert.ok(ev.start.endsWith(":10:00") || ev.start.includes("T18:00") || ev.start.includes("T10:00"));
});
t("RRULE 解析", () => {
  const ev = items[0];
  assert.strictEqual(ev.rrule.freq, "WEEKLY");
  assert.strictEqual(ev.rrule.interval, 2);
  assert.deepStrictEqual(ev.rrule.byDay, ["WE"]);
  assert.strictEqual(ev.rrule.count, 4);
});
t("VALARM 解析", () => assert.strictEqual(items[0].alarms[0].minutesBefore, 15));
t("待办优先级", () => assert.strictEqual(items[1].priority, 3));

console.log("[core] RRULE 展开");
const base = items[0];
// 2026-09-10 是周四？以起点展开未来窗口
const occs = ics.occurrencesInRange(base, date.parseLocalStamp("2026-09-01T00:00:00").getTime(), date.parseLocalStamp("2026-12-31T00:00:00").getTime());
t("双周周三展开 4 次", () => assert.strictEqual(occs.length, 4));
t("全部为周三", () => {
  for (const o of occs) assert.strictEqual(new Date(o.slice(0, 10) + "T00:00:00").getDay(), 3);
});

const daily = {
  uid: "d", kind: "event", calendarUrl: "", href: "", summary: "每日站会",
  allDay: false, start: "2026-09-01T09:00:00", end: "2026-09-01T09:15:00",
  rrule: { freq: "DAILY", interval: 1, count: 5 }
};
t("DAILY count=5 展开", () => {
  const o = ics.occurrencesInRange(daily, date.parseLocalStamp("2026-09-01T00:00:00").getTime(), date.parseLocalStamp("2026-09-30T00:00:00").getTime());
  assert.strictEqual(o.length, 5);
});

const exDate = {
  uid: "e", kind: "event", calendarUrl: "", href: "", summary: "排除测试",
  allDay: false, start: "2026-09-01T09:00:00", end: "2026-09-01T10:00:00",
  rrule: { freq: "DAILY", interval: 1 },
  exdates: ["2026-09-02T09:00:00"]
};
t("EXDATE 排除", () => {
  const o = ics.occurrencesInRange(exDate, date.parseLocalStamp("2026-09-01T00:00:00").getTime(), date.parseLocalStamp("2026-09-05T00:00:00").getTime());
  assert.deepStrictEqual(o.map((s) => s.slice(5, 10)), ["09-01", "09-03", "09-04"]);
});

console.log("[core] 序列化");
t("编辑保留原文属性", () => {
  const edited = { ...base, summary: "改名后的会议" };
  const out = ics.itemToEditedICS(edited);
  assert.ok(out.includes("SUMMARY:改名后的会议"));
  assert.ok(out.includes("UID:evt-1@test"));
  assert.ok(out.includes("BEGIN:VALARM"));
  assert.ok(out.includes("RRULE:FREQ=WEEKLY"));
});
t("新建生成完整 VCALENDAR", () => {
  const out = ics.itemToNewICS({ ...items[1], summary: "新待办" });
  assert.ok(out.includes("BEGIN:VCALENDAR"));
  assert.ok(out.includes("SUMMARY:新待办"));
  assert.ok(out.includes("PRIORITY:3"));
  assert.ok(/\r\n/.test(out));
});
t("折行还原（75 字符）", () => {
  const long = { ...items[0], summary: "很长的标题".repeat(40) };
  const out = ics.itemToEditedICS(long);
  const re = ics.itemsFromICS(out, "", "x", "");
  assert.strictEqual(re[0].summary, long.summary);
});

console.log("[core] Store");
t("mergeServerItems 保留脏数据", async () => {
  const saved = {};
  const st = new storeMod.CalStore({
    loadData: async () => saved.data,
    saveData: async (d) => { saved.data = d; }
  });
  await st.load();
  const remote = { ...base, etag: "v2" };
  st.put({ ...base, dirty: true, summary: "本地改动" });
  st.mergeServerItems([remote]);
  const all = st.getAll();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].summary, "本地改动");
  assert.strictEqual(all[0].dirty, true);
});
t("mergeServerItems 更新远端数据", async () => {
  const st = new storeMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  await st.load();
  st.put({ ...base, etag: "v1" });
  st.mergeServerItems([{ ...base, etag: "v2", summary: "服务端新标题" }]);
  assert.strictEqual(st.getAll()[0].summary, "服务端新标题");
});

console.log("[core] 待办开始/截止时间");
const todoIcs = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTODO",
  "UID:t1@test",
  "SUMMARY:带开始和截止",
  "DTSTART:20260914T090000",
  "DUE:20260915T180000",
  "END:VTODO",
  "BEGIN:VTODO",
  "UID:t2@test",
  "SUMMARY:只有截止（旧数据）",
  "DUE:20260916T120000",
  "END:VTODO",
  "BEGIN:VTODO",
  "UID:t3@test",
  "SUMMARY:无任何日期",
  "STATUS:NEEDS-ACTION",
  "END:VTODO",
  "END:VCALENDAR"
].join("\r\n");
const todoItems = ics.itemsFromICS(todoIcs, "http://x/cal/", "http://x/cal/t.ics", "e1");
t("DTSTART 作为开始、DUE 作为截止", () => {
  const a = todoItems.find((x) => x.uid === "t1@test");
  assert.ok(a.start.includes("T09:00"), "start=" + a.start);
  assert.ok(a.end.includes("T18:00"), "end=" + a.end);
});
t("旧数据只有 DUE 时用 DUE 兜底开始", () => {
  const b = todoItems.find((x) => x.uid === "t2@test");
  assert.ok(b.end.includes("T12:00"), "end=" + b.end);
  assert.strictEqual(b.start, b.end);
});
t("无日期待办解析为空", () => {
  const c = todoItems.find((x) => x.uid === "t3@test");
  assert.strictEqual(c.start, "");
  assert.strictEqual(c.end, undefined);
});
t("序列化：无开始时间不写 DTSTART", () => {
  const c = todoItems.find((x) => x.uid === "t3@test");
  const out = ics.itemToNewICS(c);
  assert.ok(!/DTSTART/.test(out), out);
  assert.ok(!/DUE/.test(out), out);
});
t("往返后开始/截止不丢失", () => {
  const a = todoItems.find((x) => x.uid === "t1@test");
  const out = ics.itemToNewICS(a);
  const back = ics.itemsFromICS("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" + out + "END:VCALENDAR", "http://x/cal/", "http://x/cal/t.ics");
  assert.strictEqual(back.length, 1);
  assert.ok(back[0].start.includes("T09:00"), "回读 start=" + back[0].start);
  assert.ok(back[0].end.includes("T18:00"), "回读 end=" + back[0].end);
});
t("编辑既有条目：改动写入 DTSTART/DUE 而非原样输出", () => {
  const a = todoItems.find((x) => x.uid === "t1@test");
  const edited = { ...a, raw: ics.itemToNewICS(a), start: "2026-09-20T09:00:00", end: "2026-09-21T10:00:00", summary: "改期后的标题" };
  const out = ics.itemToEditedICS(edited);
  const back = ics.itemsFromICS(out, "http://x/cal/", "http://x/cal/t.ics");
  assert.strictEqual(back.length, 1, "编辑后条目数应保持 1");
  assert.strictEqual(back[0].summary, "改期后的标题");
  assert.ok(back[0].start.startsWith("2026-09-20"), "改期未生效: " + back[0].start);
  assert.ok(back[0].end.startsWith("2026-09-21"), "改期未生效: " + back[0].end);
});
t("编辑保留原文的非管理属性（ORGANIZER/VTIMEZONE）", () => {
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "END:VTIMEZONE",
    "BEGIN:VTODO",
    "UID:t9@test",
    "SUMMARY:原标题",
    "DTSTART:20260914T090000",
    "ORGANIZER:mailto:a@b.c",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const it = ics.itemsFromICS(raw, "http://x/cal/", "http://x/cal/t9.ics")[0];
  const out = ics.itemToEditedICS({ ...it, raw, start: "2026-09-25T08:00:00", summary: "新标题" });
  assert.ok(out.includes("ORGANIZER:mailto:a@b.c"), "应保留 ORGANIZER\n" + out);
  assert.ok(out.includes("TZID:Asia/Shanghai"), "应保留 VTIMEZONE\n" + out);
  assert.ok(out.includes("SUMMARY:新标题"));
  const back = ics.itemsFromICS(out, "http://x/cal/", "http://x/cal/t9.ics");
  assert.strictEqual(back.length, 1);
  assert.ok(back[0].start.startsWith("2026-09-25"), "改期未生效: " + back[0].start);
});

console.log("[core] Secret（密码密文存储）");
const secret = require(path.join(outDir, "secret.js"));
async function ta(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n    ", e?.message || e);
    process.exitCode = 1;
  }
}
await ta("加解密往返一致", async () => {
  const cipher = await secret.encryptSecret("p@ss w0rd-中文");
  assert.ok(secret.isEncrypted(cipher), "应为密文格式: " + cipher);
  assert.ok(cipher.startsWith("enc:v3:"), "应使用随数据同步的主密钥（v3）: " + cipher.slice(0, 10));
  assert.ok(!cipher.includes("p@ss"), "密文不应包含明文片段");
  assert.strictEqual(await secret.decryptSecret(cipher), "p@ss w0rd-中文");
});
await ta("空值与非密文原样处理", async () => {
  assert.strictEqual(await secret.encryptSecret(""), "");
  assert.strictEqual(await secret.decryptSecret(""), "");
  assert.strictEqual(await secret.decryptSecret("legacy-plain-pwd"), "legacy-plain-pwd");
});
await ta("每次加密结果不同（随机 iv）", async () => {
  const a = await secret.encryptSecret("same");
  const b = await secret.encryptSecret("same");
  assert.notStrictEqual(a, b);
  assert.strictEqual(await secret.decryptSecret(a), await secret.decryptSecret(b));
});
await ta("Store 保存密文、读回明文", async () => {
  const saved = {};
  const st = new storeMod.CalStore({
    loadData: async () => saved.data,
    saveData: async (d) => { saved.data = d; }
  });
  await st.load();
  st.settings.password = "secret-123";
  await st.persist();
  assert.ok(secret.isEncrypted(saved.data.settings.password), "落盘应为密文");
  assert.ok(!JSON.stringify(saved.data).includes("secret-123"), "落盘数据不应包含明文");
  const st2 = new storeMod.CalStore({
    loadData: async () => saved.data,
    saveData: async () => {}
  });
  await st2.load();
  assert.strictEqual(st2.settings.password, "secret-123");
  assert.strictEqual(st2.secretBroken, false);
});
await ta("旧明文密码自动迁移为密文", async () => {
  const saved = { data: { settings: { serverUrl: "http://x/", username: "u", password: "old-plain" }, items: [] } };
  const st = new storeMod.CalStore({
    loadData: async () => saved.data,
    saveData: async (d) => { saved.data = d; }
  });
  await st.load();
  assert.strictEqual(st.settings.password, "old-plain");
  await st.persist();
  assert.ok(secret.isEncrypted(saved.data.settings.password), "迁移后应为密文");
});
await ta("凭据加密使用随数据同步的 v3 主密钥（与 iframe 端口无关）", async () => {
  secret.setSecretSeed("sysid-abc|D:/SiYuan");
  const cipher = await secret.encryptSecret("pwd-中文-123");
  assert.ok(cipher.startsWith("enc:v3:"), "加密一律使用 v3 主密钥: " + cipher.slice(0, 12));
  assert.strictEqual(await secret.decryptSecret(cipher), "pwd-中文-123");
});
await ta("换设备标识不再影响解密（v3 主密钥随数据走）", async () => {
  const cipher = await secret.encryptSecret("secret-x");
  secret.setSecretSeed("sysid-other|D:/Other");
  assert.strictEqual(await secret.decryptSecret(cipher), "secret-x", "v3 主密钥随数据走：换设备标识不再影响解密");
  secret.setSecretSeed("sysid-abc|D:/SiYuan");
  assert.strictEqual(await secret.decryptSecret(cipher), "secret-x");
});
await ta("凭据异常可被检出（用于界面提示）", async () => {
  const st = new storeMod.CalStore({ loadData: async () => undefined, saveData: async () => {} });
  await st.load();
  st.settings.serverUrl = "http://x/";
  st.settings.password = "";
  assert.ok(st.credentialsIssue(), "空密码应能检出");
  st.settings.password = "p";
  assert.strictEqual(st.credentialsIssue(), undefined);
});

// ---- 新建时的默认开始时间：今天落在「下一个整点」，不再是固定 9:00 ----
t("defaultStartStamp：今天取下一个整点", () => {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  const expectHH = `${String(d.getHours()).padStart(2, "0")}:00`;
  const val = date.defaultStartStamp(date.todayStamp());
  assert.strictEqual(val.slice(11, 16), expectHH, "今天的新建默认应为当前时间的下一个整点");
  assert.strictEqual(val.slice(14, 16), "00", "分钟必须是 00");
});
t("defaultStartStamp：非今天取 09:00、已带时间原样、空值按今天", () => {
  assert.strictEqual(date.defaultStartStamp("2099-01-01"), "2099-01-01T09:00:00", "非今天应为当天 09:00");
  assert.strictEqual(date.defaultStartStamp("2099-01-01T14:30:00"), "2099-01-01T14:30:00", "已带时间应原样返回");
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  assert.strictEqual(
    date.defaultStartStamp().slice(11, 16),
    `${String(d.getHours()).padStart(2, "0")}:00`,
    "不传参数时按今天处理"
  );
});

// ---- 服务器地址变更检测（改了「服务器地址」但没重新发现日历的场景）----
const syncMod = require(path.join(outDir, "sync.js"));
t("originOf：取协议 + 主机 + 端口", () => {
  assert.strictEqual(syncMod.originOf("http://127.0.0.1:5232/testuser/work/"), "http://127.0.0.1:5232");
  assert.strictEqual(syncMod.originOf("https://dav.example.com/cal/"), "https://dav.example.com");
  assert.strictEqual(syncMod.originOf("不是网址"), "", "解析失败应返回空串");
});
t("staleCalendarNames：改服务器地址后能检出仍指向旧地址的日历", () => {
  const cals = [
    { url: "http://127.0.0.1:5232/testuser/work/", displayName: "工作" },
    { url: "http://127.0.0.1:5232/testuser/personal/", displayName: "个人" }
  ];
  assert.deepStrictEqual(syncMod.staleCalendarNames("http://127.0.0.1:5232/", cals), [], "同源不应误报");
  assert.deepStrictEqual(
    syncMod.staleCalendarNames("http://new-host:5232/", cals),
    ["工作", "个人"],
    "换主机应全部检出（否则会静默连旧服务器并「同步成功」）"
  );
  assert.deepStrictEqual(
    syncMod.staleCalendarNames("http://127.0.0.1:5233/", cals),
    ["工作", "个人"],
    "只改端口也算换了服务器"
  );
  assert.deepStrictEqual(syncMod.staleCalendarNames("", cals), [], "服务器地址为空时不误报");
});

console.log(`\n---- 基础用例 ${passed} 项通过，继续提醒引擎与 HTTP 通道 ----`);

// ---- 提醒引擎：只排未来、只提醒带 alarms 的条目、到点触发 ----
const reminder = require(path.join(outDir, "reminder.js"));
function makeItem(over) {
  return {
    uid: "u1",
    kind: "event",
    calendarUrl: "http://x/cal/",
    href: "http://x/cal/e1.ics",
    summary: "会议",
    allDay: false,
    start: "2099-01-01T10:00:00",
    ...over
  };
}
await ta("只提醒带 alarms 的条目；未来时刻被排程且到点触发", async () => {
  const base = new Date("2099-01-01T10:00:00").getTime();
  let fired = null;
  const eng = new reminder.ReminderEngine(
    () => [makeItem({ alarms: [{ minutesBefore: 0 }] })],
    (item, anchorISO, alarmMin) => { fired = { item, anchorISO, alarmMin }; },
    () => base - 1500 // now 在开始前 1.5s，fireAt=base → 约 1.5s 后触发
  );
  eng.start();
  await new Promise((r) => setTimeout(r, 1900));
  eng.stop();
  assert.ok(fired, "到点应触发 fire");
  assert.strictEqual(fired.item.uid, "u1");
  assert.strictEqual(fired.alarmMin, 0);
});
await ta("无 alarms 的条目不排程、已过的提醒不补", async () => {
  let fired = false;
  const eng = new reminder.ReminderEngine(
    () => [
      makeItem({ alarms: undefined }),
      makeItem({ uid: "u2", start: "2000-01-01T10:00:00", alarms: [{ minutesBefore: 0 }] })
    ],
    () => { fired = true; },
    () => new Date("2099-01-01T10:00:00").getTime()
  );
  eng.start();
  await new Promise((r) => setTimeout(r, 60));
  eng.stop();
  assert.strictEqual(fired, false, "无 alarms / 已过的条目不应触发");
});
await ta("提醒时刻刚过去 5 分钟内仍补发一次（内核刚启动/设置刚打开的场景）", async () => {
  const anchor = new Date("2099-01-01T10:00:00").getTime();
  const fired = [];
  const eng = new reminder.ReminderEngine(
    () => [makeItem({ alarms: [{ minutesBefore: 10 }] })],
    (item, anchorISO) => {
      fired.push(anchorISO);
    },
    // 提醒时刻 = 10:00 - 10min = 09:50，令 now = 09:52（已过去 2 分钟，落在宽限期内）
    () => anchor - 10 * 60000 + 2 * 60000
  );
  eng.start();
  await new Promise((r) => setTimeout(r, 60));
  eng.stop();
  assert.strictEqual(fired.length, 1, "宽限期内的过期提醒应补发一次");
  assert.strictEqual(fired[0], "2099-01-01T10:00:00", "anchor 应为条目的开始时刻");
});
await ta("补发过的提醒不会被 rescan 重复补发", async () => {
  const anchor = new Date("2099-01-01T10:00:00").getTime();
  const fired = [];
  const eng = new reminder.ReminderEngine(
    () => [makeItem({ alarms: [{ minutesBefore: 10 }] })],
    () => {
      fired.push(1);
    },
    () => anchor - 10 * 60000 + 2 * 60000
  );
  eng.start();
  await new Promise((r) => setTimeout(r, 60));
  // 模拟同步完成 / 周期 rescan 触发的重排：同一槽位不得二次补发
  eng.reschedule();
  await new Promise((r) => setTimeout(r, 60));
  eng.scheduleAll();
  await new Promise((r) => setTimeout(r, 60));
  eng.stop();
  assert.strictEqual(fired.length, 1, "同一槽位补发后不得重复触发");
});
t("armedCount 统计带提醒时间的条目，count 反映当前排程数", () => {
  const eng = new reminder.ReminderEngine(
    () => [
      makeItem({ alarms: [{ minutesBefore: 10 }] }),
      makeItem({ uid: "u2", alarms: [] }),
      makeItem({ uid: "u3", start: "2099-01-01T11:00:00" })
    ],
    () => {},
    () => new Date("2099-01-01T09:00:00").getTime()
  );
  assert.strictEqual(eng.armedCount(), 1, "只有带 alarms 的条目计入 armedCount");
  eng.scheduleAll();
  assert.strictEqual(eng.count(), 1, "只应为带 alarms 的条目排程");
  eng.stop();
});
t("待办只填了到期日（无 DTSTART）也要能排程提醒", () => {
  const eng = new reminder.ReminderEngine(
    () => [makeItem({ kind: "todo", start: "", end: "2099-01-01T10:00:00", alarms: [{ minutesBefore: 10 }] })],
    () => {},
    () => new Date("2099-01-01T09:00:00").getTime()
  );
  eng.scheduleAll();
  assert.strictEqual(eng.count(), 1, "只有截止日期的待办也应被排程");
  eng.stop();
});

// ---- HTTP 通道：直连被拦截时改走内核代理（移动端 Failed to fetch 的兜底）----
const httpMod = require(path.join(outDir, "http.js"));
const caldavMod = require(path.join(outDir, "caldav.js"));

// ---- etag 的 XML 转义还原（2026-10-20 修复：服务端 getetag 返回 &quot;xxxx&quot; 残留在本地 → 所有条件 PUT/DELETE 412）----
t("sanitizeEtag：&quot; 包裹反解码成纯 hex", () => {
  assert.strictEqual(caldavMod.sanitizeEtag('&quot;a36652e6f28cdc9201772d4ed8be15de&quot;'), "a36652e6f28cdc9201772d4ed8be15de");
});
t("sanitizeEtag：纯 hex 原样返回（幂等）", () => {
  assert.strictEqual(caldavMod.sanitizeEtag("a36652e6f28cdc9201772d4ed8be15de"), "a36652e6f28cdc9201772d4ed8be15de");
});
t("sanitizeEtag：带字面引号的 DAV 引用字符串剥引号", () => {
  assert.strictEqual(caldavMod.sanitizeEtag('"a36652e6f28cdc9201772d4ed8be15de"'), "a36652e6f28cdc9201772d4ed8be15de");
});
t("parseMultistatus：&quot; 转义的 etag 解析为干净 hex（href/UID 正确）", () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
<d:response>
<d:href>/dav.php/calendars/bonebear/default/sy-mvgcy8o8-m3snnrp7.ics</d:href>
<d:propstat><d:prop>
<d:getetag>&quot;a36652e6f28cdc9201772d4ed8be15de&quot;</d:getetag>
<cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:sy-mvgcy8o8-5e2sh8b3
SUMMARY:测试全天事件1
DTSTART;VALUE=DATE:20261020
DTEND;VALUE=DATE:20261020
END:VEVENT
END:VCALENDAR
</cal:calendar-data>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>
</d:multistatus>`;
  const items = caldavMod.parseMultistatus(xml, { url: "http://nas.bonebear.cn:5808/dav.php/calendars/bonebear/default/" });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].etag, "a36652e6f28cdc9201772d4ed8be15de");
  assert.ok(!items[0].etag.includes("&quot;"));
  assert.strictEqual(items[0].uid, "sy-mvgcy8o8-5e2sh8b3");
  assert.strictEqual(items[0].href, "http://nas.bonebear.cn:5808/dav.php/calendars/bonebear/default/sy-mvgcy8o8-m3snnrp7.ics");
});

// ---- 2026-10-23 修复：iCloud 在 calendar-data 外包 <![CDATA[ ]]>，必须剥离；否则
// item.raw 被污染 → itemToEditedICS 误吐裸组件 → iCloud PUT 判 HTTP 400（「无附件也 400」根因）----
t("parseMultistatus：calendar-data 的 <![CDATA[ ]]> 包裹必须剥离（否则 raw 污染 → PUT 400）", () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
<d:response>
<d:href>/cal/sy-cdata-mvi7xtb1-3jcke8nn.ics</d:href>
<d:propstat><d:prop>
<d:getetag>"mvi8mw76"</d:getetag>
<cal:calendar-data><![CDATA[BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//MailClient.VObject/11.0.1267.0
BEGIN:VTODO
UID:sy-cdata-mvi7xtb1-3jcke8nn
SUMMARY:测试任务
DUE:20261023T180000Z
END:VTODO
END:VCALENDAR]]></cal:calendar-data>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>
</d:multistatus>`;
  const items = caldavMod.parseMultistatus(xml, { url: "https://pxx-caldav.icloud.com/cal/" });
  assert.strictEqual(items.length, 1);
  assert.ok(!items[0].raw.includes("CDATA"), "raw 不应残留 <![CDATA[ 包裹符");
  assert.ok(items[0].raw.startsWith("BEGIN:VCALENDAR"), "raw 应以 BEGIN:VCALENDAR 开头（而非 <![CDATA[）");
  assert.strictEqual(items[0].uid, "sy-cdata-mvi7xtb1-3jcke8nn");
  assert.strictEqual(items[0].summary, "测试任务");
});

t("itemToEditedICS：raw 被 <![CDATA[ 包裹污染（无 VCALENDAR 信封层）时，兜底补信封避免 PUT 400", () => {
  const cdataRaw = "<![CDATA[BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//MailClient.VObject/11.0.1267.0\r\nBEGIN:VTODO\r\nUID:sy-cdata-mvi7xtb1-3jcke8nn\r\nSUMMARY:测试任务\r\nDUE:20261023T180000Z\r\nPERCENT:0\r\nEND:VTODO\r\nEND:VCALENDAR]]>";
  const item = {
    kind: "todo", uid: "sy-cdata-mvi7xtb1-3jcke8nn", summary: "测试任务",
    due: "2026-10-23T18:00:00", start: "2026-10-23T10:00:00",
    raw: cdataRaw, etag: "mvi8mw76", attachments: [], percent: 0, priority: 0,
  };
  const out = ics.itemToEditedICS(item);
  assert.ok(out.startsWith("BEGIN:VCALENDAR"), "产物必须以 BEGIN:VCALENDAR 开头（带信封）");
  assert.ok(out.includes("BEGIN:VTODO"), "产物应包含 VTODO");
  assert.ok(out.includes("SUMMARY:测试任务"), "产物应保留原 SUMMARY");
  assert.ok(out.includes("END:VCALENDAR"), "产物应以 END:VCALENDAR 结尾");
  assert.ok(!out.includes("CDATA"), "产物绝不可残留 CDATA 包裹符");
  assert.ok(out.indexOf("BEGIN:VTODO") > out.indexOf("BEGIN:VCALENDAR"), "VTODO 必须嵌套在 VCALENDAR 之内（不是裸组件）");
});

const b64decode = (s) => Buffer.from(s, "base64").toString("utf8");

t("buildProxyBody：headers 必须是单键对象数组，写成 [[k,v]] 会被内核静默丢弃（代理通道 401 的根因）", () => {
  const b = httpMod.buildProxyBody("http://nas.local:5232/bonebear/caldav/", {
    method: "PROPFIND",
    body: "<xml/>",
    headers: { "Content-Type": "application/xml; charset=utf-8", Depth: "0", Authorization: "Basic abc" }
  });
  assert.ok(Array.isArray(b.headers), "headers 应为数组");
  for (const pair of b.headers) {
    assert.ok(pair && typeof pair === "object" && !Array.isArray(pair), "每项必须是对象，不能是键值对数组");
    assert.strictEqual(Object.keys(pair).length, 1, "每项只带一个键（内核按 map 遍历）");
  }
  const flat = Object.assign({}, ...b.headers);
  assert.strictEqual(flat.Authorization, "Basic abc", "Authorization 必须被带上，否则服务端必返 401");
  assert.strictEqual(flat.Depth, "0", "Depth 也不能丢（CalDAV 递归深度）");
  assert.strictEqual(flat["Content-Type"], undefined, "Content-Type 走独立字段，不能留在 headers 里被内核覆盖");
  assert.strictEqual(b.contentType, "application/xml; charset=utf-8", "contentType 要透传真实类型，而非固化 text/plain");
});

t("buildProxyBody：body 一律 base64 且 payload 恒为字符串（无 body 时传空串）", () => {
  const withBody = httpMod.buildProxyBody("http://x/", { method: "REPORT", body: "<query>中文</query>" });
  assert.strictEqual(withBody.payloadEncoding, "base64", "text 编码不会发送 body，只能用 base64");
  assert.strictEqual(b64decode(withBody.payload), "<query>中文</query>", "UTF-8 往返必须无损");
  assert.strictEqual(withBody.contentType, "text/plain", "未指定 Content-Type 时给个安全的默认值");

  const noBody = httpMod.buildProxyBody("http://x/", { method: "DELETE" });
  assert.strictEqual(typeof noBody.payload, "string", "payload 必须是字符串，undefined 会让内核报 [payload] must be a string");
  assert.strictEqual(noBody.payload, "", "无 body 时传空串");
  assert.strictEqual(b64decode(noBody.payload), "", "空串解码后就是空 body");
  assert.strictEqual(httpMod.buildProxyBody("http://x/", {}).method, "GET", "未指定 method 时默认 GET");
  assert.strictEqual(httpMod.buildProxyBody("http://x/", { timeoutMs: 1234 }).timeout, 1234, "超时透传给内核");
});

t("isNetworkLevelError：只把网络级失败判为网络错误，HTTP 状态码不算", () => {
  assert.strictEqual(httpMod.isNetworkLevelError(new TypeError("Failed to fetch")), true, "Failed to fetch 属网络级");
  assert.strictEqual(httpMod.isNetworkLevelError(new Error("Network request failed")), true, "WebView 的报错也应识别");
  assert.strictEqual(httpMod.isNetworkLevelError(new Error("ERR_CLEARTEXT_NOT_PERMITTED")), true, "明文拦截也应识别");
  assert.strictEqual(httpMod.isNetworkLevelError(new Error("The operation was aborted")), true, "超时被 abort 也属网络级（direct 回退代理的判断要用）");
  assert.strictEqual(httpMod.isNetworkLevelError(new Error("HTTP 401")), false, "服务器真实响应不是网络错误");
  assert.strictEqual(httpMod.isNetworkLevelError(new Error("内核代理失败: timeout")), false, "代理通道报错不算");
});

await ta("移动端：直连被拦截时自动改走内核代理", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (String(url).includes("forwardProxy")) {
      return { ok: true, json: async () => ({ code: 0, data: { status: 207, headers: {}, body: "<xml/>" } }) };
    }
    throw new TypeError("Failed to fetch");
  };
  try {
    httpMod.setDirectFallbackToProxy(true);
    const r = await httpMod.httpRequest("http://nas.local:5232/", { method: "PROPFIND" }, "direct", {
      username: "u",
      password: "p"
    });
    assert.strictEqual(r.via, "proxy", "直连网络级失败后应改走内核代理");
    assert.ok(calls.some((u) => String(u).includes("forwardProxy")), "应实际调用内核 forwardProxy 接口");
  } finally {
    globalThis.fetch = origFetch;
    httpMod.setDirectFallbackToProxy(false);
  }
});

await ta("桌面端：未开启兜底时「仅浏览器直连」的失败原样抛出", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  try {
    httpMod.setDirectFallbackToProxy(false);
    let err = null;
    try {
      await httpMod.httpRequest("http://x/", {}, "direct");
    } catch (e) {
      err = e;
    }
    assert.ok(err && /Failed to fetch/.test(err.message), "应抛出原始网络错误，不静默换通道");
  } finally {
    globalThis.fetch = origFetch;
  }
});

t("describeNetworkError：直连被拦时把用户引到「请求通道」", () => {
  const msg = caldavMod.describeNetworkError(new TypeError("Failed to fetch"), "direct");
  assert.ok(/请求通道/.test(msg), "提示应指向「请求通道」设置项");
  assert.ok(/Failed to fetch/.test(msg), "保留原始报错便于排查");
  const auto = caldavMod.describeNetworkError(new TypeError("Failed to fetch"), "auto");
  assert.ok(!/请求通道/.test(auto), "非直连通道不应建议改通道");
  assert.strictEqual(
    caldavMod.describeNetworkError(new Error("HTTP 401"), "direct"),
    "HTTP 401",
    "非网络错误原样返回，避免误导"
  );
});

console.log("[core] 待办/日程 互转");
// 带 VTIMEZONE + ORGANIZER 的事件，验证非受管属性在转换后不丢
const eventRaw = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//x//CN",
  "BEGIN:VTIMEZONE",
  "TZID:Asia/Shanghai",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:evt-conv@test",
  "SUMMARY:项目评审",
  "ORGANIZER;CN=boss:mailto:boss@x",
  "DTSTART:20261023T100000Z",
  "DTEND:20261023T113000Z",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n");
const evtItems = ics.itemsFromICS(eventRaw, "http://x/cal/", "http://x/cal/evt-conv.ics", "etag1");
const evt = evtItems[0];
t("事件解析带 raw", () => assert.ok(evt.raw && evt.raw.includes("BEGIN:VEVENT")));

const todo = ics.convertItemKind(evt, "todo");
t("事件→待办：组件翻成 VTODO", () => assert.ok(todo.raw.includes("BEGIN:VTODO") && !todo.raw.includes("BEGIN:VEVENT")));
t("事件→待办：DTEND→DUE", () => assert.ok(todo.raw.includes("DUE:20261023T113000")));
t("事件→待办：DTSTART→start（DTSTART 仍存在）", () => assert.ok(todo.raw.includes("DTSTART:20261023T100000")));
t("事件→待办：保留 VTIMEZONE 与 ORGANIZER", () => {
  assert.ok(todo.raw.includes("BEGIN:VTIMEZONE"));
  assert.ok(todo.raw.includes("ORGANIZER"));
});
t("事件→待办：UID 不变", () => assert.strictEqual(todo.uid, evt.uid));
t("事件→待办：默认待办状态", () => {
  assert.strictEqual(todo.kind, "todo");
  assert.strictEqual(todo.percent, 0);
  assert.strictEqual(todo.status, "NEEDS-ACTION");
});
t("转换结果可被 itemToEditedICS 再次编辑", () => {
  const again = ics.itemToEditedICS(todo);
  assert.ok(again.includes("BEGIN:VTODO"));
});

const todoRaw = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO",
  "UID:todo-conv@test", "SUMMARY:交周报", "DUE:20261025T180000Z",
  "PRIORITY:1", "PERCENT-COMPLETE:40", "STATUS:IN-PROCESS",
  "END:VTODO", "END:VCALENDAR"
].join("\r\n");
const tdItems = ics.itemsFromICS(todoRaw, "http://x/cal/", "http://x/cal/todo-conv.ics", "etag2");
const td = tdItems[0];
const ev = ics.convertItemKind(td, "event");
t("待办→事件：组件翻成 VEVENT", () => assert.ok(ev.raw.includes("BEGIN:VEVENT") && !ev.raw.includes("BEGIN:VTODO")));
t("待办→事件：DUE→DTSTART", () => assert.ok(ev.raw.includes("DTSTART:20261025T180000")));
t("待办→事件：丢弃 priority/percent/status", () => {
  assert.ok(!ev.raw.includes("PRIORITY"));
  assert.ok(!ev.raw.includes("PERCENT-COMPLETE"));
  assert.ok(!ev.raw.includes("STATUS"));
});
t("待办→事件：默认 1 小时时长（DTEND=DTSTART+1h）", () => {
  assert.ok(ev.raw.includes("DTEND:20261025T190000"));
});
t("待办→事件：UID 不变", () => assert.strictEqual(ev.uid, td.uid));

console.log(`[core] 合计 ${passed} 项通过（含提醒引擎与 HTTP 通道）`);
