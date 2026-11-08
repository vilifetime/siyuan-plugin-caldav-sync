/**
 * A/B 组英文译文回归锁（2026-11-08，雄哥圈定「先改 A、B」）。
 *
 *  A = 错误提示类机翻粘连（DeleteFailed: / Kernel ProxyFailed: / No canuse Calendar …）
 *  B = 状态与标签错译（EnableThis account / None (OnlyStartDate) …）
 *
 *  这批全是**独立 value**，不参与 _t() 拼接语序，所以只改字典、不动源码。
 *  C 组（拼接片段）本轮未动；D 组（HTML 注释死键）已于 2026-11-08 单独一轮清理，
 *  字典从 921 键瘦身到 810 键，本测试只跟着更新键数断言，A/B 22 条译文不受影响。
 *
 *  两条按雄哥指定译文，不要「顺手改得更地道」：
 *    未完成（未开始）        = Incomplete(Not started)
 *    未在标题中识别到日期时间。= No date or time recognized in the title.
 *
 * 用法：node test/ab-i18n.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const en = JSON.parse(read("src/i18n/en_US.json"));
const zh = JSON.parse(read("src/i18n/zh_CN.json"));

let pass = 0;
const check = (name, fn) => {
  fn();
  pass++;
  console.log(`  [OK] ${name}`);
};

// 22 条精确值：key 是中文原文，value 是本轮定稿英文。
// 带尾空格的几条是拼接前缀（后面直接接 HTTP 507 / 消息正文 / 块文本），
// 空格是刻意的，别 trim 掉。
const EXPECT = {
  // A 组 · 错误提示
  "内核代理失败: {0}": "Kernel proxy failed: {0}",
  "分类名称重复：": "Duplicate category name: ",
  "删除失败：{0}": "Delete failed: {0}",
  "发现失败: {0}": "Discovery failed: {0}",
  "取消同步失败：": "Cancel sync failed: ",
  "同步失败：": "Sync failed: ",
  "扫描失败：": "Scan failed: ",
  "插入日记失败：": "Failed to insert into daily note: ",
  "连接失败: {0}": "Connection failed: {0}",
  "上传失败：": "Upload failed: ",
  "写入日记失败：": "Failed to write to daily note: ",
  "回写块失败：": "Failed to write back block: ",
  "，未上传。": ", not uploaded.",
  // B 组 · 状态与标签
  "启用该账户": "Enable this account",
  "无（仅开始日期）": "None (start date only)",
  "未完成（未开始）": "Incomplete(Not started)",
  "未在标题中识别到日期时间。": "No date or time recognized in the title.",
  "没有可用的日历（账户未配置或日历全部停用）":
    "No calendars available (no account configured, or all calendars disabled)",
  "同步未来（天）": "Days ahead to sync",
  "同步过去（天）": "Days back to sync",
  "已同步到服务端：上传": "Synced to server: uploaded",
  "已同步到服务端：删除": "Synced to server: deleted",
};

const assertAll = (dict) => {
  for (const [k, want] of Object.entries(EXPECT)) {
    assert.ok(Object.prototype.hasOwnProperty.call(dict, k), `缺 key：${k}`);
    assert.strictEqual(dict[k], want, `${k} 的英文译文不符`);
  }
};

check("字典键集合完整（810 键，中英一一对应；D 组已删 111 条注释死键）", () => {
  assert.strictEqual(Object.keys(en).length, 810);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});

check("A/B 共 22 条译文逐字一致", () => assertAll(en));

check("雄哥指定的两条译文不得被「润色」", () => {
  assert.strictEqual(en["未完成（未开始）"], "Incomplete(Not started)");
  assert.strictEqual(en["未在标题中识别到日期时间。"], "No date or time recognized in the title.");
});

check("A 组：错误提示里不再有中文式粘连驼峰", () => {
  // 只扫 A 组的 13 个 key，避免误伤 iCloud / SiYuan / DingTalk 等正常专有名词。
  const aKeys = Object.keys(EXPECT).slice(0, 13);
  const glued = aKeys.filter((k) => /[a-z][A-Z][a-z]|[A-Z][a-z]+[A-Z][a-z]+/.test(en[k]));
  assert.deepEqual(glued, [], `仍有粘连：${glued.map((k) => `${k} = ${en[k]}`).join(" | ")}`);
});

check("A 组：禁用 Canuse / NotUpload / EnableThis 等旧病（扫实际字典值）", () => {
  const aValues = Object.keys(EXPECT).slice(0, 13).map((k) => en[k]).join(" ");
  assert.ok(!/canuse|NotUpload|EnableThis|OnlyStartDate|NotStart\b|\bFailed[A-Z]|ProxyFailed|SyncFailed|ScanFailed/i.test(aValues),
    "A 组实际译文里不得残留旧词");
  // 拼接前缀必须以「冒号+空格」结尾，否则会粘成 "failed:HTTP 507"。
  for (const k of ["上传失败：", "写入日记失败：", "回写块失败：", "插入日记失败：", "分类名称重复：", "取消同步失败：", "同步失败：", "扫描失败："]) {
    assert.match(en[k], /: $/, `${k} 需要尾空格`);
  }
});

check("B 组：术语仍与两端约定一致（Event / To-do，不引入 Task / Schedule）", () => {
  const bValues = Object.keys(EXPECT).slice(13).map((k) => en[k]).join(" ");
  assert.ok(!/\b(tasks?|todos?|schedules?|events?)\b/i.test(bValues), "B 组不应出现实体术语");
});

check("中文端零改动（zh_CN 仍是中文原文作 value）", () => {
  for (const k of Object.keys(EXPECT)) {
    assert.strictEqual(zh[k], k, `zh_CN 的 ${k} 应回退为中文原文`);
  }
});

check("变异自测：改坏任意一条都会被抓到", () => {
  for (const k of ["删除失败：{0}", "未完成（未开始）", "未在标题中识别到日期时间。", "上传失败："]) {
    const broken = { ...en, [k]: "DeleteFailed: {0}" };
    assert.throws(() => assertAll(broken), `改坏 ${k} 却没被抓到`);
  }
});

console.log(`\n[PASS] ab-i18n：${pass} 项全通过`);
