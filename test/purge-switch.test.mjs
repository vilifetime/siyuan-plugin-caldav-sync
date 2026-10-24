/**
 * 回归测试：「切换服务器时清理旧条目」开关（2026-10-24）
 *
 * 覆盖三层：
 *   ① core/server-id.ts 的「服务器身份」判定（origin 归一 + iCloud 归一 + 退化路径）
 *   ② core/store.ts 的孤儿条目识别（activeServerOrigins / orphanItems）
 *   ③ 清理 + 备份 + 恢复的完整往返（purgeOrphanItems / restorePurgedItems）
 *      以及开关入口的安全阀（purgeOrphansIfEnabled）
 *
 * 关键安全阀（回归重点）：
 *   - 一个启用日历都没有 → 一条都不清
 *   - 启用日历还没跟着新地址走（用户改了 serverUrl 但没重新「发现日历」）
 *     → 一条都不清，否则会把**正在用的旧服务器条目**清掉（真丢数据）
 *   - 键冲突时恢复不覆盖
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-purge");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
  `src/core/store.ts src/core/secret.ts src/core/server-id.ts ` +
  `--outDir .test-purge --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));

const sid = require(path.join(outDir, "server-id.js"));
const storeMod = require(path.join(outDir, "store.js"));

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n    ", e.message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- 测试夹具

const NAS = "http://nas.bonebear.cn:5808";
const NAS_CAL = `${NAS}/dav.php/calendars/work/`;
const NAS_CAL2 = `${NAS}/dav.php/calendars/home/`;
const OLD = "http://nas.bonebear.cn:5232";
const OLD_CAL = `${OLD}/dav.php/calendars/old/`;
const ICLOUD_CAL = "https://p12-caldav.icloud.com:443/1234567/reminders/";

function mkItem(uid, calendarUrl, extra = {}) {
  return {
    uid,
    kind: "event",
    calendarUrl,
    href: `${calendarUrl}${uid}.ics`,
    etag: `"etag-${uid}"`,
    summary: `条目 ${uid}`,
    allDay: false,
    start: "2026-10-24T090000",
    end: "2026-10-24T100000",
    raw: `BEGIN:VCALENDAR\r\nUID:${uid}\r\nEND:VCALENDAR`,
    ...extra
  };
}

/** 造一个 store：传入初始条目与日历配置 */
function mkStore(items, calendars, serverUrl = NAS, extraSettings = {}) {
  const env = {
    loadData: async () => undefined,
    saveData: async () => {}
  };
  const st = new storeMod.CalStore(env);
  st.settings.serverUrl = serverUrl;
  st.settings.calendars = calendars;
  st.settings.purgeOtherServerOnSwitch = false;
  Object.assign(st.settings, extraSettings);
  for (const it of items) st.put(it);
  return st;
}

const cal = (url, enabled = true, displayName = "日历") => ({ url, displayName, enabled });

// ================================================================ ① 身份判定

console.log("[purge] 服务器身份判定（server-origin）");

await t("同主机不同路径 → 同一身份", () => {
  assert.strictEqual(sid.serverOriginOf(NAS_CAL), sid.serverOriginOf(NAS_CAL2));
  assert.strictEqual(sid.serverOriginOf(NAS_CAL), sid.serverOriginOf(`${NAS}/dav.php`));
});

await t("端口不同 → 不同身份", () => {
  assert.notStrictEqual(sid.serverOriginOf(NAS), sid.serverOriginOf(OLD));
});

await t("协议不同 → 不同身份", () => {
  assert.notStrictEqual(sid.serverOriginOf("http://a.com/x"), sid.serverOriginOf("https://a.com/x"));
});

await t("默认端口被归一（:80/:443 不算不同身份）", () => {
  assert.strictEqual(sid.serverOriginOf("http://a.com:80/x"), "http://a.com");
  assert.strictEqual(sid.serverOriginOf("https://a.com:443/x"), "https://a.com");
});

await t("主机名大小写不敏感", () => {
  assert.strictEqual(sid.serverOriginOf("HTTP://NAS.BoneBear.CN:5808/x"), "http://nas.bonebear.cn:5808");
});

await t("iCloud 及其节点主机名统一归一为 icloud", () => {
  assert.strictEqual(sid.serverOriginOf("https://caldav.icloud.com"), "icloud");
  assert.strictEqual(sid.serverOriginOf("https://p12-caldav.icloud.com:443/x/"), "icloud");
  assert.strictEqual(sid.serverOriginOf("https://www.icloud.com"), "icloud");
  // 非 iCloud 的 *.com 子域不得被误归一
  assert.notStrictEqual(sid.serverOriginOf("https://evil-icloud.com"), "icloud");
});

await t("空地址 → 空身份（调用方据此判定「没配服务器」）", () => {
  assert.strictEqual(sid.serverOriginOf(""), "");
  assert.strictEqual(sid.serverOriginOf("   "), "");
});

await t("缺协议的裸主机名退化为带端口的裸标识（不同端口仍是不同身份）", () => {
  // ⚠️ 回归点：`nas:5232` 与 `nas:5808` 若被归成同一身份，旧服务器条目永远清不掉
  assert.notStrictEqual(sid.serverOriginOf("nas.bonebear.cn:5232"), sid.serverOriginOf("nas.bonebear.cn:5808"));
  assert.strictEqual(sid.serverOriginOf("nas.bonebear.cn:5232"), "nas.bonebear.cn:5232");
});

await t("isSameServer / serverChanged 的边界", () => {
  assert.ok(sid.isSameServer(NAS_CAL, NAS_CAL2));
  assert.ok(!sid.isSameServer(NAS, OLD));
  assert.ok(sid.serverChanged(NAS, OLD));
  assert.ok(!sid.serverChanged(NAS, NAS_CAL2));
  assert.ok(!sid.serverChanged("", OLD), "首次配置不算「切换」");
  assert.ok(!sid.serverChanged(NAS, ""), "新地址还没填不算「切换」");
});

// ================================================================ ② 孤儿识别

console.log("[purge] 孤儿条目识别");

await t("activeServerOrigins 只取启用的日历", () => {
  const st = mkStore([], [cal(NAS_CAL, true), cal(OLD_CAL, false)]);
  const origins = st.activeServerOrigins();
  assert.strictEqual(origins.size, 1);
  assert.ok(origins.has(sid.serverOriginOf(NAS)));
});

await t("同一服务器的两个日历只算一个身份", () => {
  const st = mkStore([], [cal(NAS_CAL, true), cal(NAS_CAL2, true)]);
  assert.strictEqual(st.activeServerOrigins().size, 1);
});

await t("orphanItems 认出跨服务器的条目、保留同服务器的条目", () => {
  const st = mkStore(
    [
      mkItem("a", NAS_CAL),
      mkItem("b", NAS_CAL2), // 同一服务器、另一个日历集合 → 保留
      mkItem("c", OLD_CAL), // 旧服务器 → 孤儿
      mkItem("d", ICLOUD_CAL) // iCloud → 孤儿
    ],
    [cal(NAS_CAL, true), cal(NAS_CAL2, true)]
  );
  const orphans = st.orphanItems().map((i) => i.uid).sort();
  assert.deepStrictEqual(orphans, ["c", "d"]);
});

await t("一个启用日历都没有 → 一条都不算孤儿（绝不把全部数据当孤儿）", () => {
  const st = mkStore([mkItem("a", NAS_CAL), mkItem("b", OLD_CAL)], [cal(NAS_CAL, false)]);
  assert.strictEqual(st.orphanItems().length, 0);
});

await t("判不出归属的条目（calendarUrl 为空）保留", () => {
  const st = mkStore([mkItem("z", "")], [cal(NAS_CAL, true)]);
  assert.strictEqual(st.orphanItems().length, 0);
});

// ================================================================ ③ 清理 + 备份 + 恢复

console.log("[purge] 清理 / 备份 / 恢复往返");

await t("purgeOrphanItems 删掉孤儿、留下备份", async () => {
  const st = mkStore([mkItem("a", NAS_CAL), mkItem("c", OLD_CAL)], [cal(NAS_CAL, true)]);
  const n = await st.purgeOrphanItems();
  assert.strictEqual(n, 1);
  assert.strictEqual(st.getAll().length, 1);
  assert.strictEqual(st.get("a") !== undefined, true);
  assert.strictEqual(st.get("c"), undefined);
  assert.ok(st.purgeBackup, "应留下备份");
  assert.strictEqual(st.purgeBackup.count, 1);
  assert.strictEqual(st.purgeBackup.items.length, 1);
  assert.strictEqual(st.purgeBackup.items[0].uid, "c");
  assert.strictEqual(st.purgeBackup.items[0].raw, mkItem("c", OLD_CAL).raw, "备份必须含 raw 原文");
  assert.ok(st.purgeBackup.removedServers.includes("5232"));
});

await t("restorePurgedItems 完整还原", async () => {
  const st = mkStore([mkItem("a", NAS_CAL), mkItem("c", OLD_CAL)], [cal(NAS_CAL, true)]);
  await st.purgeOrphanItems();
  const n = await st.restorePurgedItems();
  assert.strictEqual(n, 1);
  assert.strictEqual(st.getAll().length, 2);
  assert.ok(st.get("c"), "旧条目应被还原");
  assert.strictEqual(st.purgeBackup, undefined, "恢复后备份应清空");
});

await t("恢复出来的条目不带脏标记（不会被当成本服务器新条目推上去）", async () => {
  const st = mkStore(
    [mkItem("c", OLD_CAL, { dirty: true, deleted: true })],
    [cal(NAS_CAL, true)]
  );
  await st.purgeOrphanItems();
  await st.restorePurgedItems();
  const it = st.get("c");
  assert.strictEqual(it.dirty, false);
  assert.strictEqual(it.deleted, false);
});

await t("键冲突时恢复跳过、不覆盖现有数据", async () => {
  const st = mkStore([mkItem("a", NAS_CAL), mkItem("c", OLD_CAL)], [cal(NAS_CAL, true)]);
  await st.purgeOrphanItems();
  // 恢复前先塞一个同 UID 的本地条目（内容不同）
  st.put(mkItem("c", OLD_CAL, { summary: "本地已有" }));
  const n = await st.restorePurgedItems();
  assert.strictEqual(n, 0, "冲突时应一条都不恢复");
  assert.strictEqual(st.get("c").summary, "本地已有", "不得覆盖本地现有数据");
});

await t("没有备份时恢复返回 0（不抛错）", async () => {
  const st = mkStore([], [cal(NAS_CAL, true)]);
  assert.strictEqual(await st.restorePurgedItems(), 0);
});

await t("清理后备份落盘在数据顶层（不在 settings 里，避免污染配置备份）", async () => {
  let saved = null;
  const st = new storeMod.CalStore({
    loadData: async () => undefined,
    saveData: async (d) => {
      saved = d;
    }
  });
  st.settings.serverUrl = NAS;
  st.settings.calendars = [cal(NAS_CAL, true)];
  st.put(mkItem("c", OLD_CAL));
  await st.purgeOrphanItems();
  assert.ok(saved, "应已落盘");
  assert.ok(saved.purgeBackup, "purgeBackup 应在顶层");
  assert.strictEqual(saved.purgeBackup.count, 1);
  assert.strictEqual(saved.settings.purgeBackup, undefined, "settings 里不应塞条目快照");
});

await t("重新加载后备份仍在（重启也能恢复）", async () => {
  const st1 = new storeMod.CalStore({
    loadData: async () => undefined,
    saveData: async () => {}
  });
  st1.settings.serverUrl = NAS;
  st1.settings.calendars = [cal(NAS_CAL, true)];
  st1.put(mkItem("c", OLD_CAL));
  await st1.purgeOrphanItems();

  const st2 = new storeMod.CalStore({
    loadData: async () => ({ settings: st1.settings, items: [], purgeBackup: st1.purgeBackup }),
    saveData: async () => {}
  });
  await st2.load();
  assert.ok(st2.purgeBackup, "重启后备份应保留");
  assert.strictEqual(await st2.restorePurgedItems(), 1);
});

// ================================================================ ④ 开关入口与安全阀

console.log("[purge] 开关入口与安全阀");

await t("开关关闭 → purgeOrphansIfEnabled 什么都不做", async () => {
  const st = mkStore([mkItem("a", NAS_CAL), mkItem("c", OLD_CAL)], [cal(NAS_CAL, true)]);
  assert.strictEqual(await st.purgeOrphansIfEnabled(), 0);
  assert.strictEqual(st.getAll().length, 2);
});

await t("开关打开 + 配置已对齐 → 清理孤儿", async () => {
  const st = mkStore([mkItem("a", NAS_CAL), mkItem("c", OLD_CAL)], [cal(NAS_CAL, true)], NAS, {
    purgeOtherServerOnSwitch: true
  });
  assert.strictEqual(await st.purgeOrphansIfEnabled(), 1);
  assert.strictEqual(st.getAll().length, 1);
});

await t("安全阀：启用日历还指着旧服务器 → 一条都不清", async () => {
  // 用户改了 serverUrl 但还没重新「发现日历」——此时清理会误删正在用的数据
  const st = mkStore([mkItem("a", OLD_CAL), mkItem("c", NAS_CAL)], [cal(OLD_CAL, true)], NAS, {
    purgeOtherServerOnSwitch: true
  });
  assert.strictEqual(await st.purgeOrphansIfEnabled(), 0, "配置未对齐时必须跳过");
  assert.strictEqual(st.getAll().length, 2);
});

await t("安全阀：serverUrl 为空 → 跳过", async () => {
  const st = mkStore([mkItem("a", NAS_CAL), mkItem("c", OLD_CAL)], [cal(NAS_CAL, true)], "", {
    purgeOtherServerOnSwitch: true
  });
  assert.strictEqual(await st.purgeOrphansIfEnabled(), 0);
});

await t("安全阀：一个启用日历都没有 → 跳过", async () => {
  const st = mkStore([mkItem("a", NAS_CAL)], [cal(NAS_CAL, false)], NAS, {
    purgeOtherServerOnSwitch: true
  });
  assert.strictEqual(await st.purgeOrphansIfEnabled(), 0);
});

await t("iCloud → 自建服务器切换：iCloud 的条目被认出为孤儿", async () => {
  const st = mkStore([mkItem("x", ICLOUD_CAL), mkItem("y", NAS_CAL)], [cal(NAS_CAL, true)], NAS, {
    purgeOtherServerOnSwitch: true
  });
  const orphans = st.orphanItems().map((i) => i.uid);
  assert.deepStrictEqual(orphans, ["x"]);
  assert.strictEqual(await st.purgeOrphansIfEnabled(), 1);
});

// ================================================================ ⑤ 源码级约束

console.log("[purge] 源码级约束");

await t("备份条目快照不得放进 CalSettings（会污染 Obsidian 配置备份）", () => {
  const src = fs.readFileSync(path.join(root, "src/core/types.ts"), "utf8");
  const settingsBlock = src.slice(src.indexOf("export interface CalSettings"), src.indexOf("export interface PurgeBackup"));
  assert.ok(!/purgeBackup\??\s*:\s*PurgeBackup/.test(settingsBlock), "CalSettings 里不应有 purgeBackup");
  assert.ok(/export interface PurgeBackup/.test(src), "应有独立的 PurgeBackup 类型");
});

await t("设置页必须提供「立即清理」与「恢复」两个入口", () => {
  const src = fs.readFileSync(path.join(root, "src/ui/settings-dialog.ts"), "utf8");
  assert.ok(/data-action="purge-now"/.test(src), "应有「立即清理」按钮");
  assert.ok(/data-action="purge-restore"/.test(src), "应有「恢复」按钮");
  assert.ok(/purgeOtherServerOnSwitch/.test(src), "应读写开关字段");
  // 删注释再查：注释里会写「不用 confirm()」这类说明，不能误判
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/[^.\w]confirm\s*\(/.test(code), "删除类操作禁用 confirm()，用二次点击确认");
  assert.ok(/purgeArmed/.test(code), "应有二次点击确认逻辑");
});

await t("按钮文案不得用 textContent 写 SVG（会把 <svg> 源码当纯文本显示）", () => {
  // 回归点（2026-10-24 雄哥截图）：`btn.textContent = \`${icons.trash} 清理 N 条\``
  // 会把 SVG 源码原样显示在按钮上。图标必须与文字分开，JS 只改文字节点。
  const src = fs.readFileSync(path.join(root, "src/ui/settings-dialog.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const bad = [...code.matchAll(/(\w+)\.textContent\s*=\s*[^;]*icons\./g)];
  assert.strictEqual(bad.length, 0, `不得用 textContent 写图标：${bad.map((m) => m[0]).join(" | ")}`);
  // 按钮模板里图标与文字必须用 span 分开
  assert.ok(/data-purge-now-label/.test(code), "清理按钮的文字应有独立节点");
  assert.ok(/data-purge-restore-label/.test(code), "恢复按钮的文字应有独立节点");
  // 全仓兜底：任何 .textContent = 赋值都不能内嵌 <svg
  const svgText = [...code.matchAll(/textContent\s*=\s*[^;\n]*<svg/gi)];
  assert.strictEqual(svgText.length, 0, "textContent 里不得含 <svg");
});

await t("恢复按钮的 hidden 需有 CSS 兜底（.caldav-btn 是 inline-flex 会盖掉 UA 规则）", () => {
  const css = fs.readFileSync(path.join(root, "src/index.css"), "utf8");
  assert.ok(
    /\.caldav-btn\[hidden\]\s*\{\s*display:\s*none/.test(css),
    "缺 .caldav-btn[hidden]{display:none} → 无备份时恢复按钮藏不住"
  );
});

console.log(`\n[purge] 通过 ${passed} 项`);
