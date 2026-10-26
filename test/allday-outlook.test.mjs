/**
 * 全天事件 Outlook 降级形态回归（2026-10-20 雄哥报障后修复，与 Obsidian 侧同构）。
 *
 * 背景：服务器上「测试全天事件1」名字是全天、实际开始结束都是 00:00。地面真相：
 * 该 ICS 由 Outlook 侧（PRODID MailClient.VObject）10-03 创建，写的是
 *   DTSTART:20260928T000000 / DTEND:20260928T000000
 * —— Outlook 向不支持 VALUE=DATE 的 CalDAV 服务器（Baïkal）建「全天」时的降级写法。
 * 旧判定只认 8 位纯日期，它被当成 00:00 零时长定时事件：周/日视图里落到 00:00
 * 刻度处一条 15 分钟矮线，全天条里反而没有。
 *
 * 修复（src/core/ics.ts）：
 * ① isAllDayEvent：start 是 `YYYYMMDDT000000` 且 DTEND 缺失或同为某日 `T000000`
 *    → 全天。定时事件里设不出「00:00 开始、00:00 结束、零时长」；start 是 000000
 *    但 DTEND 带真实时分的不算（有真实时长）。
 * ② parseIcsStamp(prop, forceDateOnly)：判全天时 start/end 只取日期部分，与标准
 *    VALUE=DATE 在内存里完全一致，occurrences/序列化/编辑器全走既有全天路径。
 * ③ 序列化天然升级：编辑保存时 DTSTART/DTEND 写成 VALUE=DATE，服务器降级形态
 *    被修回正版。
 *
 * 运行前先用 tsc 把 src/core 编译到 .test-allday（与 core.test.mjs 同套路）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import { rmrf } from "./fsx.mjs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-allday");

rmrf(outDir);
fs.mkdirSync(outDir, { recursive: true });
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts --outDir .test-allday ` +
    `--module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const { itemsFromICS, itemToNewICS, occurrencesInRange } = require(path.join(outDir, "ics.js"));
const { isDateOnly, parseLocalStamp } = require(path.join(outDir, "date.js"));

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}
function parseEvent(props, kind = "VEVENT") {
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//test//CN", `BEGIN:${kind}`, ...props, `END:${kind}`, "END:VCALENDAR"].join("\r\n");
  return itemsFromICS(ics, "http://nas.test/cal/", "http://nas.test/cal/x.ics")[0];
}

console.log("[allday-outlook] 真实故障样本（服务器原文照抄）");

t("Outlook 降级形态（零时长同日）→ 全天，start/end 取日期部分", () => {
  const it = parseEvent([
    "UID:sy-muso87f4-6vjrgoct",
    "DTSTART:20260928T000000",
    "DTEND:20260928T000000",
    "SUMMARY:测试全天事件1",
  ]);
  assert.strictEqual(it.allDay, true);
  assert.strictEqual(it.start, "2026-09-28");
  assert.strictEqual(it.end, "2026-09-28");
});

t("完整服务器原文（含 VTIMEZONE 噪音）照解析不误", () => {
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MailClient.VObject/11.0.1201.0",
    "BEGIN:VTIMEZONE",
    "TZID:China Standard Time",
    "BEGIN:STANDARD",
    "TZNAME:中国标准时间",
    "DTSTART:19800101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:sy-muso87f4-6vjrgoct",
    "DTSTART:20260928T000000",
    "DTEND:20260928T000000",
    "CREATED:20261003T173400Z",
    "DTSTAMP:20261003T173400Z",
    "LAST-MODIFIED:20261003T173400Z",
    "SUMMARY:测试全天事件1",
    "TRANSP:OPAQUE",
    "X-MICROSOFT-CDO-BUSYSTATUS:BUSY",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const items = itemsFromICS(raw, "http://nas.test/cal/", "http://nas.test/cal/sy-muso87f4-6vjrgoct.ics", "etag1");
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].allDay, true);
  assert.strictEqual(items[0].start, "2026-09-28");
  assert.ok(items[0].raw && items[0].raw.includes("X-MICROSOFT-CDO-BUSYSTATUS"), "raw 必须原文带下");
});

console.log("[allday-outlook] 降级形态变体");

t("排他次日 DTEND:20260929T000000 → 全天（DATE 语义的等价降级）", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DTEND:20260929T000000"]);
  assert.strictEqual(it.allDay, true);
  assert.strictEqual(it.start, "2026-09-28");
  assert.strictEqual(it.end, "2026-09-29");
});

t("多日全天（28→次月1日 000000）→ 全天", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DTEND:20261001T000000"]);
  assert.strictEqual(it.allDay, true);
  assert.strictEqual(it.end, "2026-10-01");
});

t("无 DTEND（只写 DTSTART:20260928T000000）→ 全天，end 兜底次日", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000"]);
  assert.strictEqual(it.allDay, true);
  assert.strictEqual(it.end, "2026-09-29", "全天无 end 时兜底 start+1（与 VALUE=DATE 行为一致）");
});

console.log("[allday-outlook] 误伤防护");

t("DTEND 带真实时分（00:00→12:00）→ 非全天，时分保留", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DTEND:20260928T120000"]);
  assert.strictEqual(it.allDay, false, "有真实时长不能判全天");
  assert.strictEqual(it.start, "2026-09-28T00:00:00");
  assert.strictEqual(it.end, "2026-09-28T12:00:00");
});

t("start 非 000000（10:00 开始）→ 非全天", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T100000", "DTEND:20260929T100000"]);
  assert.strictEqual(it.allDay, false);
});

t("标准 VALUE=DATE 行为不变（回归）", () => {
  const it = parseEvent(["UID:a", "DTSTART;VALUE=DATE:20260928", "DTEND;VALUE=DATE:20260929"]);
  assert.strictEqual(it.allDay, true);
  assert.strictEqual(it.start, "2026-09-28");
  assert.strictEqual(it.end, "2026-09-29");
});

t("待办不判全天（VTODO DTSTART:20260928T000000）", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DUE:20260928T000000"], "VTODO");
  assert.strictEqual(it.allDay, false, "待办没有全天概念");
});

t("带 Z 的 000000 不判全天（UTC 零点 ≠ 本地全天）", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000Z", "DTEND:20260928T000000Z"]);
  assert.strictEqual(it.allDay, false);
});

console.log("[allday-outlook] 下游链路");

t("occurrences 产出 date-only（周视图才会进全天条）", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DTEND:20260928T000000"]);
  const s = parseLocalStamp("2026-09-27").getTime();
  const e = parseLocalStamp("2026-09-30").getTime();
  const occs = occurrencesInRange(it, s, e);
  assert.ok(occs.length >= 1, "应有发生日");
  assert.ok(occs.every((o) => isDateOnly(o)), `occ 应全为 date-only，实得 ${JSON.stringify(occs)}`);
});

t("序列化升级：编辑保存写出 VALUE=DATE（服务器降级形态被修回正版）", () => {
  const it = parseEvent(["UID:a", "DTSTART:20260928T000000", "DTEND:20260928T000000", "SUMMARY:x"]);
  const ics = itemToNewICS(it);
  assert.ok(/DTSTART;VALUE=DATE:20260928/.test(ics), `DTSTART 未升级为 DATE，实得:\n${ics}`);
  assert.ok(/DTEND;VALUE=DATE:20260928/.test(ics), "DTEND 未升级为 DATE");
  assert.ok(!ics.includes("20260928T000000"), "不应再残留 T000000 形态");
});

console.log(`\n[allday-outlook] ${passed} 项通过${process.exitCode ? "，有失败" : ""}`);
