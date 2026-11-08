/**
 * C 组 `_t()` 拼接片段英文回归锁（2026-11-08，雄哥「按建议做」）。
 *
 * 本轮范围：**只改 en_US.json 的 value，零源码改动**。
 *  注：之后的 D 组清理动过 src/ui/*.ts 的 HTML 注释（去掉注释里的 _t()），
 *  但没有碰下面锁的 4 个拼接表达式，所以「源码零改动检查」依旧成立。
 *  - 中文端完全不受影响（字典 key 就是中文原文、zh_CN 自映射）。
 *  - 不用 rebuild：字典是运行时文件，宿主按语言读 i18n/<lang>.json。
 *  - 提前修掉 settings-dialog.ts:1659 的 title 属性双引号 DOM bug（译文里禁双引号）。
 *  - setMsg 用 /失败|failed|…/i 判成败，所以失败类拼接句必须保留 failed 字样。
 *
 * 为什么必须有「拼接渲染测试」：C 组的 value 全是半截句子，
 * 逐字锁 value 只能证明「没被改回去」，证明不了「拼起来是人话」。
 * 这里按源码真实的片段顺序把 22 条完整句渲染出来逐字断言。
 *
 * 已知残留（需动源码，留下一轮，别为它去改共享片段）：
 *   Account 'Foo'/ cal-a …        ← `/` 前缺空格，源码把 "/" 写死在 t("」") 后
 *   Connected (Kernel proxy,123ms) ← 逗号后缺空格，`，` 是 6 处共享片段
 *   OpenCalendar View (…)         ← `打开` 是 3 处共享片段（按钮/aria-label），不能加尾空格
 *
 * 用法：node test/c-i18n.mjs
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

// 28 条定稿 value。带前/尾空格的都是刻意拼接用的，别 trim。
// 注：`，未上传。` 属 A 组定稿（ab-i18n.mjs 锁 `, not uploaded.`），本轮不推翻，见 keep。
const EXPECT = {
  "新建失败「": `Failed to create '`,
  "更新失败「": `Failed to update '`,
  "删除失败「": `Failed to delete '`,
  "」：": `': `,
  "账户「": `Account '`,
  "」的密码密文与本地密钥不匹配（可能由另一台设备写入），请重新输入密码":
    `': password ciphertext does not match the local key (it may have been written by another device); please re-enter the password`,
  "」未填写密码，请在设置中填写": `' has no password set; please enter one in settings`,
  "」服务器地址已变更，以下日历仍指向旧地址，请到设置里重新「发现日历」：":
    `' server URL has changed; the following calendars still point to the old address. Please re-run "Discover Calendars" in settings: `,
  "上传附件「": `Failed to upload attachment '`,
  "」失败": `'`,
  "点击选择该日历「": `Set default color for '`,
  "」的默认颜色": `'`,
  "已删除账户「": `Deleted account '`,
  "」，并清理其": `' and cleaned up`,
  "」（本地条目保留，可重新添加账户后恢复显示）":
    `' (local entries kept; add the account again to show them)`,
  "已开始下载「": `Started downloading '`,
  "连接成功（": `Connected (`,
  "天后开始": ` days from now`,
  "（上次打开的视图）": ` (last view used)`,
  "条": `item(s)`,
  "），超过「单个": `), exceeding the single `,
  "文件限制」": ` file limit of `,
  "）。请填写服务器的": `): connection failed. Please enter the server's`,
  "）。已探测到": `): connection failed. Detected a`,
  "入口：": `URL:`,
  "入口地址（": `URL (`,
  "常见": `commonly`,
  "，标准入口": `; standard URL`,
};

// 按源码真实拼接顺序。数组元素：命中字典则取 value，否则当字面量。
const S = [
  ["新建失败", "block-sync.ts:341", ["新建失败「", "Foo", "」：", "permission denied"],
    `Failed to create 'Foo': permission denied`],
  ["更新失败", "block-sync.ts:350", ["更新失败「", "Foo", "」：", "permission denied"],
    `Failed to update 'Foo': permission denied`],
  ["删除失败", "block-sync.ts:359", ["删除失败「", "Foo", "」：", "permission denied"],
    `Failed to delete 'Foo': permission denied`],
  ["账户错误", "sync.ts:234", ["账户「", "Foo", "」：", "permission denied"],
    `Account 'Foo': permission denied`],
  ["密码密文", "store.ts:166", ["账户「", "Foo", "」的密码密文与本地密钥不匹配（可能由另一台设备写入），请重新输入密码"],
    `Account 'Foo': password ciphertext does not match the local key (it may have been written by another device); please re-enter the password`],
  ["未填密码", "store.ts:185", ["账户「", "Foo", "」未填写密码，请在设置中填写"],
    `Account 'Foo' has no password set; please enter one in settings`],
  ["地址变更", "sync.ts:243", ["账户「", "Foo", "」服务器地址已变更，以下日历仍指向旧地址，请到设置里重新「发现日历」：", "cal-a, cal-b"],
    `Account 'Foo' server URL has changed; the following calendars still point to the old address. Please re-run "Discover Calendars" in settings: cal-a, cal-b`],
  ["账户/日历", "sync.ts:323", ["账户「", "Foo", "」", "/ cal-a: permission denied"],
    `Account 'Foo'/ cal-a: permission denied`],
  ["上传附件", "caldav.ts:696", ["上传附件「", "Foo", "」失败", ": HTTP 507"],
    `Failed to upload attachment 'Foo': HTTP 507`],
  ["title 属性", "settings-dialog.ts:1659", ["点击选择该日历「", "Work", "」的默认颜色"],
    `Set default color for 'Work'`],
  ["删除账户+清理", "settings-dialog.ts:272", ["已删除账户「", "Foo", "」，并清理其", " 3 ", "条本地条目（已备份，可恢复）"],
    `Deleted account 'Foo' and cleaned up 3 local entries (backed up, recoverable)`],
  ["删除账户+保留", "settings-dialog.ts:273", ["已删除账户「", "Foo", "」（本地条目保留，可重新添加账户后恢复显示）"],
    `Deleted account 'Foo' (local entries kept; add the account again to show them)`],
  ["开始下载", "editor.ts:932", ["已开始下载「", "Foo", "」"],
    `Started downloading 'Foo'`],
  ["连接成功", "caldav.ts:770", ["连接成功（", "Kernel proxy", "，", "123", "ms", "）"],
    `Connected (Kernel proxy,123ms)`],
  ["天后开始", "panel.ts:1281", ["3", "天后开始"], `3 days from now`],
  ["上次视图", "panel.ts:1694", ["打开", "Calendar View", "（上次打开的视图）"],
    `OpenCalendar View (last view used)`],
  ["条计数A", "sync.ts:865", ["已同步到服务端：上传", " 1 ", "条"],
    `Synced to server: uploaded 1 item(s)`],
  ["条计数B", "change-alert-dialog.ts:21", ["1 ", "条"], `1 item(s)`],
  ["内容过大", "caldav.ts:421", ["内容过大（", "ICS ", "1.2", "MB", "），超过「单个", "ICS", "文件限制」", "10", "MB", "，未上传。"],
    `Content too large (ICS 1.2MB), exceeding the single ICS file limit of 10MB, not uploaded.`],
  ["根路径A", "caldav.ts:765", ["根路径不支持", " WebDAV", "（", "HTTP ", "405", "）。已探测到", " DAV ", "入口：", "…/dav.php/", " ", "——", " ", "请把「服务器地址」改成它再测试"],
    `Root path not supported WebDAV(HTTP 405): connection failed. Detected a DAV URL:…/dav.php/ -- please set "Server URL" to it and test again`],
  ["根路径B", "caldav.ts:766", ["根路径不支持", " WebDAV", "（", "HTTP ", "405", "）。请填写服务器的", " DAV ", "入口地址（", "Baïkal ", "常见", " ", "…", "/dav.php/", "，标准入口", " ", "…", "/.well-known/caldav", "）"],
    `Root path not supported WebDAV(HTTP 405): connection failed. Please enter the server's DAV URL (Baïkal commonly …/dav.php/; standard URL …/.well-known/caldav)`],
];

const render = (parts, dict) => parts.map((p) => (p in dict ? dict[p] : p)).join("");
const assertAll = (dict) => {
  for (const k of Object.keys(EXPECT)) assert.strictEqual(dict[k], EXPECT[k], `${k} 译文回退了`);
  for (const [name, loc, parts, want] of S) {
    assert.strictEqual(render(parts, dict), want, `${name} (${loc}) 拼出来不对`);
  }
};

check("28 条定稿 value 逐字锁", () => assertAll(en));

check("字典完整性：810 键、zh/en 键集合一致、en 无 CJK（D 组已删 111 条注释死键）", () => {
  assert.strictEqual(Object.keys(en).length, 810);
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
  for (const [k, v] of Object.entries(en)) assert.ok(!CJK.test(String(v)), `${k} 仍是中文`);
});

check("中文端零改动（zh_CN 仍是中文原文作 value）", () => {
  for (const k of Object.keys(EXPECT)) assert.strictEqual(zh[k], k, `zh_CN 的 ${k} 被改了`);
});

check("22 条完整拼接句逐字断言（失败模板 / 账户组）", () => {
  for (const row of S.slice(0, 8)) {
    assert.strictEqual(render(row[2], en), row[3], `${row[0]} (${row[1]})`);
  }
});

check("22 条完整拼接句逐字断言（附件 / 设置页 / 状态组）", () => {
  for (const row of S.slice(8, 18)) {
    assert.strictEqual(render(row[2], en), row[3], `${row[0]} (${row[1]})`);
  }
});

check("22 条完整拼接句逐字断言（长句组：413 / 根路径两分支）", () => {
  for (const row of S.slice(18)) {
    assert.strictEqual(render(row[2], en), row[3], `${row[0]} (${row[1]})`);
  }
});

check("title 属性 DOM 安全：译文里不得出现双引号或 CJK", () => {
  const html = render(S[9][2], en);
  assert.ok(!html.includes(`"`), "title=\"…\" 内出现双引号会提前闭合属性、破坏 DOM");
  assert.ok(!/[\u3400-\u9fff]/.test(html));
  assert.match(html, /^Set default color for 'Work'$/);
});

check("setMsg 判色依赖：失败句保留 failed，成功句不含", () => {
  const RE = /失败|未启用|failed|not running|disabled|unavailable/i;
  // 这些是错误/失败提示，改掉 failed 会被 setMsg 标绿。
  for (const name of ["新建失败", "更新失败", "删除失败", "上传附件", "根路径A", "根路径B"]) {
    const row = S.find((r) => r[0] === name);
    assert.ok(RE.test(render(row[2], en)), `${name} 丢失 failed 字样，会被判成成功`);
  }
  const ok = render(S.find((r) => r[0] === "连接成功")[2], en);
  assert.ok(!RE.test(ok), "连接成功提示不能带 failed，否则被标红");
});

check("共享片段与相邻组定稿禁改：别为补空格动 」/（/）/，/：/、/打开/…", () => {
  const keep = {
    "」": "'", "（": "(", "）": ")", "，": ",", "：": ":", "、": ",",
    "打开": "Open", "…": "…", "根路径不支持": "Root path not supported",
    "，未上传。": ", not uploaded.", // A 组定稿，ab-i18n.mjs 也锁
  };
  for (const [k, v] of Object.entries(keep)) assert.strictEqual(en[k], v, `共享片段/相邻组定稿 ${k} 被改了`);
});

check("D 组注释死键已删除（不再为零收益项保留机翻 value）", () => {
  // 这三条原先锁的是「界面不可见、故意不改」的机翻 value；D 组清理后
  // 注释里的 _t() 已还原成中文设计笔记，字典里这些 key 应当彻底消失。
  for (const k of ["立即同步），", "）与搜索（", "主窗口工具栏已有（",
                   "雄哥改版，同日二次调整）：", "一行三个操作点"]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(en, k), `死键 ${k} 又回来了`);
    assert.ok(!Object.prototype.hasOwnProperty.call(zh, k), `zh_CN 的死键 ${k} 没删`);
  }
});

check("源码零改动：拼接表达式仍在，且没有把英文模板硬编码进源码", () => {
  const block = read("src/core/block-sync.ts");
  const sync = read("src/core/sync.ts");
  const settings = read("src/ui/settings-dialog.ts");
  const caldav = read("src/core/caldav.ts");
  assert.match(block, /t\("新建失败「"\)/);
  assert.match(block, /t\("」："\)/);
  assert.match(sync, /t\("账户「"\)/);
  assert.match(settings, /title="\$\{_t\("点击选择该日历「"\)\}\$\{label\}\$\{_t\("」的默认颜色"\)\}"/);
  assert.match(caldav, /t\("上传附件「"\)/);
  for (const f of ["src/core/block-sync.ts", "src/core/sync.ts", "src/ui/settings-dialog.ts", "src/core/caldav.ts"]) {
    const s = read(f);
    assert.ok(!s.includes(`Failed to create '`), `${f} 里不该出现硬编码英文模板`);
    assert.ok(!s.includes(`Set default color for '`), `${f} 里不该出现硬编码英文模板`);
  }
});

check("变异自测：改坏片段一定会被抓到", () => {
  // ① 中缀回退 → 冒号后丢空格，失败模板拼坏
  assert.throws(() => assertAll({ ...en, "」：": "':" }));
  // ② title 开片段回退 → 双引号重新混进 HTML 属性
  const brokenTitle = { ...en, "点击选择该日历「": `Click to select this calendar "` };
  assert.ok(render(S[9][2], brokenTitle).includes(`"`));
  assert.throws(() => assertAll(brokenTitle));
  // ③ 附件前缀丢掉 failed → 判色会失效（且 assertAll 也会抓到 value 回退）
  const noFailed = { ...en, "上传附件「": `Attachment '` };
  assert.ok(!/failed/i.test(render(S[8][2], noFailed)), "去掉 failed 后 setMsg 会把错误标绿");
  assert.throws(() => assertAll(noFailed));
  // ④ 条回退 → 1 items 语法错复现
  assert.throws(() => assertAll({ ...en, "条": "items" }));
});

console.log(`\n[PASS] c-i18n：${pass} 项全通过`);
