/**
 * 独立窗口「乐观首帧」共享快照 · 数据层单测（issue #5 · L2）
 *
 * 只测 src/core/first-frame.ts：脱敏、瘦身、体积/时效/结构校验、失败降级。
 * 不触碰任何凭据模块，全部用内存假 storage，不依赖思源运行时。
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, ".test-firstframe");

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
execSync(
  `npx tsc src/core/first-frame.ts ` +
    `--outDir ${outDir} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
const ff = require(join(outDir, "first-frame.js"));

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    console.error("✗", name, "\n   ", e.message);
  }
}

class FakeStorage {
  constructor() { this.map = new Map(); this.throwOnSet = false; this.removed = []; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    if (this.throwOnSet) throw new Error("QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k) { this.removed.push(k); this.map.delete(k); }
}

const NOW = 1_800_000_000_000;
function sampleData() {
  return {
    keyring: { v: 3, salt: "KEYRING-SALT-DO-NOT-LEAK", wrapped: "KEYRING-WRAPPED" },
    settings: {
      accounts: [{ url: "https://dav.example.com", user: "u", password: "PW-CIPHER-DO-NOT-LEAK" }],
      webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=TOKEN-DO-NOT-LEAK",
      webhookSecret: "WEBHOOK-SECRET-DO-NOT-LEAK",
      accessToken: "ACCESS-TOKEN-DO-NOT-LEAK",
      enableWebhook: true,
      lastView: "month",
      showHolidaysCN: true
    },
    items: [
      { uid: "1", summary: "会议", start: "20261106T090000", raw: "BEGIN:VCALENDAR...RAW-DO-NOT-COPY", alarms: [] },
      { uid: "2", summary: "待办", start: "20261106T100000", raw: "BEGIN:VTODO...", attachments: ["BASE64-BLOB"] }
    ],
    purgeBackup: [{ uid: "9", raw: "BEGIN:VEVENT...BACKUP-RAW" }],
    sync: { watermark: 123 }
  };
}

/* ---------- 1. 写入并读回：保留渲染所需，剔除凭据与同步专用大字段 ---------- */
t("写入 + 读回：items/settings 完整、无凭据、无 raw", () => {
  const st = new FakeStorage();
  assert.strictEqual(ff.writeFirstFrameSnapshot(sampleData(), st, NOW), true);
  const snap = ff.readFirstFrameSnapshot(st, NOW);
  assert.ok(snap, "应能读回快照");
  assert.strictEqual(snap.v, 1);
  assert.strictEqual(snap.updatedAt, NOW);
  assert.strictEqual(snap.data.items.length, 2);
  assert.strictEqual(snap.data.items[0].summary, "会议");
  assert.strictEqual(snap.data.items[0].raw, undefined, "item.raw 不进快照");
  assert.strictEqual(snap.data.items[1].attachments, undefined, "附件不进快照");
  assert.strictEqual(snap.data.purgeBackup[0].raw, undefined, "备份里的 raw 也要剔除");
  assert.strictEqual(snap.data.settings.lastView, "month");
  assert.strictEqual(snap.data.settings.enableWebhook, true, "非敏感布尔设置要保留");
  assert.strictEqual(snap.data.settings.sync, undefined);
  assert.strictEqual(snap.data.sync.watermark, 123, "非敏感元数据可保留");
});

t("快照原文绝不出现任何凭据值/凭据键/keyring", () => {
  const st = new FakeStorage();
  ff.writeFirstFrameSnapshot(sampleData(), st, NOW);
  const raw = st.getItem(ff.FIRST_FRAME_KEY);
  for (const s of [
    "PW-CIPHER-DO-NOT-LEAK", "WEBHOOK-SECRET-DO-NOT-LEAK",
    "ACCESS-TOKEN-DO-NOT-LEAK", "TOKEN-DO-NOT-LEAK",
    "KEYRING-SALT-DO-NOT-LEAK", "KEYRING-WRAPPED",
    "RAW-DO-NOT-COPY", "BASE64-BLOB"
  ]) {
    assert.ok(!raw.includes(s), `快照不应包含 ${s}`);
  }
  assert.ok(!/"password"/i.test(raw), "password 键不应出现");
  assert.ok(!/"keyring"/i.test(raw), "keyring 键不应出现");
  assert.ok(!/"webhookSecret"/i.test(raw), "webhookSecret 键不应出现");
  assert.ok(!/"webhookUrl"/i.test(raw), "webhookUrl（含 access_token）不应出现");
  assert.ok(!/"raw"/i.test(raw), "raw 键不应出现");
});

/* ---------- 2. 体积上限与配额失败：优雅降级并清掉旧快照 ---------- */
t("超过体积上限：不写入且清掉旧快照", () => {
  const st = new FakeStorage();
  ff.writeFirstFrameSnapshot(sampleData(), st, NOW);
  const big = sampleData();
  big.items = Array.from({ length: 20000 }, (_, i) => ({ uid: String(i), summary: "x".repeat(200), start: "20261106" }));
  assert.strictEqual(ff.writeFirstFrameSnapshot(big, st, NOW), false);
  assert.strictEqual(st.getItem(ff.FIRST_FRAME_KEY), null, "旧快照必须清掉，避免陈旧数据");
  assert.ok(st.removed.includes(ff.FIRST_FRAME_KEY));
});

t("setItem 抛错（配额）：不抛异常、清掉旧快照", () => {
  const st = new FakeStorage();
  ff.writeFirstFrameSnapshot(sampleData(), st, NOW);
  st.throwOnSet = true;
  assert.strictEqual(ff.writeFirstFrameSnapshot(sampleData(), st, NOW), false);
  assert.strictEqual(st.getItem(ff.FIRST_FRAME_KEY), null);
});

/* ---------- 3. 结构 / 时效 / 损坏数据一律不采用 ---------- */
t("损坏 JSON：返回 null 并清掉坏数据", () => {
  const st = new FakeStorage();
  st.setItem(ff.FIRST_FRAME_KEY, "{not-json");
  assert.strictEqual(ff.readFirstFrameSnapshot(st, NOW), null);
  assert.strictEqual(st.getItem(ff.FIRST_FRAME_KEY), null);
});

t("过期 / 未来时间戳：不采用", () => {
  const st = new FakeStorage();
  ff.writeFirstFrameSnapshot(sampleData(), st, NOW);
  assert.strictEqual(ff.readFirstFrameSnapshot(st, NOW + ff.FIRST_FRAME_MAX_AGE_MS + 1), null);
  const st2 = new FakeStorage();
  ff.writeFirstFrameSnapshot(sampleData(), st2, NOW + 120_000);
  assert.strictEqual(ff.readFirstFrameSnapshot(st2, NOW), null, "时钟回拨产生的未来快照不采用");
});

t("结构不全（无 items / 无 settings）：写入与读取都拒绝", () => {
  const st = new FakeStorage();
  assert.strictEqual(ff.writeFirstFrameSnapshot({ settings: {} }, st, NOW), false);
  assert.strictEqual(ff.writeFirstFrameSnapshot({ items: [] }, st, NOW), false);
  const st2 = new FakeStorage();
  st2.setItem(ff.FIRST_FRAME_KEY, JSON.stringify({ v: 1, updatedAt: NOW, data: { items: [] } }));
  assert.strictEqual(ff.readFirstFrameSnapshot(st2, NOW), null);
  const st3 = new FakeStorage();
  st3.setItem(ff.FIRST_FRAME_KEY, JSON.stringify({ v: 2, updatedAt: NOW, data: { items: [], settings: {} } }));
  assert.strictEqual(ff.readFirstFrameSnapshot(st3, NOW), null, "版本不符不采用");
});

/* ---------- 4. storage 不可用 / 清理 ---------- */
t("无 localStorage：写返回 false、读返回 null，不抛错", () => {
  assert.strictEqual(ff.writeFirstFrameSnapshot(sampleData(), null, NOW), false);
  assert.strictEqual(ff.readFirstFrameSnapshot(null, NOW), null);
  assert.strictEqual(ff.defaultFirstFrameStorage(), null, "Node 环境下没有 localStorage");
});

t("clearFirstFrameSnapshot 可清掉快照", () => {
  const st = new FakeStorage();
  ff.writeFirstFrameSnapshot(sampleData(), st, NOW);
  ff.clearFirstFrameSnapshot(st);
  assert.strictEqual(ff.readFirstFrameSnapshot(st, NOW), null);
});

console.log(`\nfirst-frame tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
