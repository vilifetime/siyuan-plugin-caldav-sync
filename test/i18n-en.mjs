/**
 * 英文界面「设置页仍夹杂中文」回归锁（2026-11-08，雄哥五张截图）。
 *
 * 根因有两层，两层都要锁：
 *   ① 字典里 en_US.json 的 value 本身就是中文 —— 思源端 i18n 以中文原文作 key，
 *      当时有 136 条只建了 key、没填英文；长句又被拆成多个 `_t()` 片段拼接，
 *      于是出现「一半英文一半中文」的设置说明（MISC / 中国日历 / 本地数据 /
 *      任务块映射 / 提醒说明等）。
 *   ② 源码里若有 `_t("中文")` 的 key 不在 en_US 字典里，`t()` 会回退中文原文，
 *      同样会在英文界面漏中文（见 src/core/i18n.ts 的 fallback）。
 *
 * 另外两处配套修复也一并锁：设置页一个硬编码中文 placeholder 没走字典；
 * 「立即扫描 / 一键清理」用中文正则 `/失败|未启用/` 判定成功失败，文案翻成英文后
 * 所有错误消息都会被误标成绿色成功。
 *
 * 用法：node test/i18n-en.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const enRaw = read("src/i18n/en_US.json");
const zhRaw = read("src/i18n/zh_CN.json");
const en = JSON.parse(enRaw);
const zh = JSON.parse(zhRaw);
const settingsSrc = read("src/ui/settings-dialog.ts");

// CJK 汉字 + 中文标点（全角逗号/括号等）。英文译文里一个都不该出现。
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
const cjkValues = (dict) => Object.entries(dict).filter(([, v]) => CJK.test(String(v)));

let pass = 0;
const check = (name, fn) => {
  fn();
  pass++;
  console.log(`  [OK] ${name}`);
};

console.log("\n① 英文字典：所有 value 必须是纯英文");
check(`en_US ${Object.keys(en).length} 条 value 无 CJK`, () => {
  const bad = cjkValues(en);
  assert.equal(bad.length, 0,
    `仍有中文 value: ${bad.map(([k]) => JSON.stringify(k)).join(", ")}`);
});
check("判据自测：把任意一条改回中文必须判红（防假绿）", () => {
  const broken = { ...en, 条: "条" };
  assert.ok(cjkValues(broken).some(([k]) => k === "条"),
    "检测函数必须能抓到中文 value");
});
check("zh_CN / en_US 的 key 集合完全一致（含新增 placeholder 键）", () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});
check("新增的钉钉密钥 placeholder 两端都有、且英文值无中文", () => {
  const k = "SECxxxxxxxx（机器人安全设置「加签」处复制）";
  assert.ok(zh[k], "zh_CN 缺 key");
  assert.ok(en[k], "en_US 缺 key");
  assert.ok(!CJK.test(en[k]), "en_US 该条仍是中文");
  assert.match(en[k], /Sign/, "英文应说明 Sign 安全设置");
});

console.log("\n② 源码 _t()/t() 的中文 key 必须能在英文字典里查到");
/** 收集源码里真实调用（排除注释）用到的中文 key；把 TS 的 \n 等转义求值成真实字符 */
function usedChineseKeys(dict) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.ts$/.test(e.name)) files.push(rel);
    }
  };
  walk("src");
  const found = new Set();
  const re = /(?:\b_t|\bt)\(\s*(["'])([^"']+)\1/g;
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // 注释里也有 `_t(...)` 示例文本，不是真实渲染调用
      if (/^(\/\/|\*|\/\*|<!--)/.test(trimmed)) continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        let key = m[2];
        try { key = JSON.parse(`"${key.replace(/"/g, '\\"')}"`); } catch { /* 原样 */ }
        if (/[\u3400-\u9fff]/.test(key) && !(key in dict)) found.add(`${key}  <= ${rel}`);
      }
    }
  }
  return [...found];
}
check("所有中文文案 key 都有英文条目（缺 key 会回退中文）", () => {
  const miss = usedChineseKeys(en);
  assert.equal(miss.length, 0, `字典缺 key:\n${miss.join("\n")}`);
});
check("判据自测：从字典删掉一个在用 key 必须报缺失", () => {
  const broken = { ...en };
  delete broken["条"];
  assert.ok(usedChineseKeys(broken).some((s) => s.startsWith("条 ")),
    "删 key 后扫描必须报出来");
});

const SCAN_OK = /setMsg\(text, !\/失败\|未启用\|failed\|not running\|disabled\|unavailable\/i\.test\(text\)\)/;
const CLEAR_OK = /setMsg\(text, !\/失败\|failed\|not running\|disabled\|unavailable\/i\.test\(text\)\)/;
const OLD_CN_ONLY = /setMsg\(text, !\/失败\|未启用\/\.test\(text\)\)/;

console.log("\n③ 设置页硬编码中文与语言相关的判定逻辑");
check("钉钉密钥 placeholder 已走 _t()，不再是硬编码中文", () => {
  assert.ok(!/placeholder="SECxxxxxxxx（/.test(settingsSrc),
    "仍有硬编码中文 placeholder");
  assert.match(settingsSrc, /placeholder="\$\{escape\(_t\("SECxxxxxxxx（/,
    "placeholder 必须用 escape(_t(...)) 包住（英文译文含双引号，不 escape 会截断属性）");
});
check("判据自测：还原成硬编码中文必须判红", () => {
  const broken = '<input placeholder="SECxxxxxxxx（机器人安全设置「加签」处复制）"/>';
  assert.ok(/placeholder="SECxxxxxxxx（/.test(broken), "变异样本必须能被判据抓到");
  assert.ok(!(!/placeholder="SECxxxxxxxx（/.test(broken)), "主判据在变异样本上必须失败");
});
check("扫描/清理结果判定同时认中英失败关键词", () => {
  assert.match(settingsSrc, SCAN_OK, "立即扫描的判定缺英文关键词");
  assert.match(settingsSrc, CLEAR_OK, "一键清理的判定缺英文关键词");
  assert.ok(!OLD_CN_ONLY.test(settingsSrc),
    "旧版纯中文正则会把英文错误消息标成绿色成功");
});
check("判据自测：改回纯中文正则必须判红", () => {
  const broken = "setMsg(text, !/失败|未启用/.test(text))";
  assert.ok(OLD_CN_ONLY.test(broken), "变异样本必须能被判据抓到");
  assert.ok(!SCAN_OK.test(broken), "新判据在旧正则上必须返回 false");
});

console.log("\n④ 五张截图里的关键文案逐条抽查");
const EXPECT = [
  ["在月", /^Month$/, "图2 atmoth → Month"],
  ["一次同步改动数量告警值", /^Change-count alert threshold per sync$/, "图5 one syncnumber of changesalert threshold"],
  ["条", /^item\(s\)$/, "图1/图4 的「N 条」量词（C 组：items 会拼出 1 items，改 item(s)）"],
  ["便携版思源还会因缺少开始菜单快捷方式", /Start Menu shortcut/, "图1 提醒说明夹中文"],
  ["显示节假日（国务院每年公布，联网拉取；调休补班标「班」）", /make-up workdays/, "图2 中国日历"],
  ["日视图的日期数字栏上叠加显示节假日、农历与节气。纯展示，不写入", /solar terms/, "图2 中国日历说明"],
  ["默认都是「上次使用项」：记住你上次选的，下次打开直接回到它。", /Last used/, "图3 MISC"],
  ["记录存在配置里，会随数据同步到其他设备（思源的端口每次启动都变，", /settings file/, "图3 MISC"],
  ["浏览器存储按端口隔离，存那儿等于每次都丢）。", /isolated per port/, "图3 MISC"],
  ["比如曾经连过、现已不在设置里的旧服务器数据。只清本地缓存，服务端不动。", /Only the local cache/, "图4 本地数据"],
  ["条其他服务器的本地条目", /^local entries from other servers$/, "图4 清理按钮"],
  ["条不属于任何已配置账户的本地条目", /no configured account/, "图4 状态行"],
  ["；已建立的映射照常双向同步，不受范围限制。", /existing mappings/, "图5 范围说明"],
  ["自定义前缀（会写进待办标题，其他端也能看出来）", /^Custom prefix/, "图5 标记"],
  ["一轮对账算出来的改动（回写任务块", /reconciliation pass/, "图5 安全提醒"],
  ["点「取消」则本轮一条都不改。填", /Click "Cancel"/, "图5 安全提醒"],
];
check(`${EXPECT.length} 条截图文案均为英文且语义到位`, () => {
  for (const [key, re, why] of EXPECT) {
    assert.ok(en[key], `字典缺 key ${JSON.stringify(key)}（${why}）`);
    assert.ok(!CJK.test(en[key]), `${JSON.stringify(key)} 仍是中文（${why}）`);
    assert.match(en[key], re, `${JSON.stringify(key)} 译文不符预期（${why}）`);
  }
});
check("判据自测：抽查项改回中文必须判红", () => {
  const broken = { ...en, 条: "条" };
  assert.ok(CJK.test(broken["条"]));
});

console.log(`\ni18n-en: ${pass} 项断言全部通过（en_US 零中文 / key 全覆盖 / 无硬编码中文 / 双语失败判定）\n`);
