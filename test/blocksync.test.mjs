/**
 * 文档任务块 ⇄ VTODO（issue #2）单测。
 *
 * 覆盖三块：
 *   ① ICS 层：X-SIYUAN-BLOCK-ID 的写入 / 读回 / 编辑后不丢也不重复
 *   ② 对账层：create / push / writeback / delete 四类动作与完成优先、范围存在性判据
 *   ③ 辅助：块 markdown 改写、文字清洗、前缀、默认截止时间
 * 外加源码级防漂移：设置区控件、总开关守卫、skip 属性名。
 *
 * 运行前用 tsc 把相关 core 文件编到 .test-blocksync（与 core.test 同一套路）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-blocksync");

execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/block-todo.ts src/core/block-api.ts ` +
    `--outDir .test-blocksync --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const ics = require(path.join(outDir, "ics.js"));
const bt = require(path.join(outDir, "block-todo.js"));
const bapi = require(path.join(outDir, "block-api.js"));
const T = require(path.join(outDir, "types.js"));

let pass = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log("  ✓ " + name);
  } catch (e) {
    console.log("  ✗ " + name + "\n    " + (e && e.message));
    process.exitCode = 1;
  }
};

const CAL = "http://127.0.0.1:5232/cal/todo/";
const baseSettings = (over = {}) => ({
  ...T.DEFAULT_SETTINGS,
  blockSyncEnabled: true,
  blockSyncMarks: ["badge", "prefix"],
  blockSyncPrefix: "[文档]",
  ...over
});
const block = (id, text, checked = false) => ({
  id,
  text,
  checked,
  markdown: `- [${checked ? "X" : " "}] ${text}`
});
const item = (over = {}) => ({
  uid: "u-" + Math.random().toString(36).slice(2),
  kind: "todo",
  calendarUrl: CAL,
  href: CAL + "a.ics",
  summary: "买牛奶",
  allDay: false,
  start: "2026-10-28T09:00:00",
  status: "NEEDS-ACTION",
  percent: 0,
  ...over
});

console.log("[blocksync] ① ICS：X-SIYUAN-BLOCK-ID");

check("新建序列化写出 X-SIYUAN-BLOCK-ID", () => {
  const text = ics.itemToNewICS(item({ blockId: "20261028-abc" }));
  assert.match(text, /X-SIYUAN-BLOCK-ID:20261028-abc/);
});

check("解析能读回 blockId", () => {
  const text = ics.itemToNewICS(item({ blockId: "20261028-abc" }));
  const items = ics.itemsFromICS(text, CAL, CAL + "a.ics", "etag1");
  assert.strictEqual(items[0].blockId, "20261028-abc");
});

check("编辑（带 raw）后属性不丢、也不重复", () => {
  const text = ics.itemToNewICS(item({ blockId: "20261028-abc" }));
  const it = ics.itemsFromICS(text, CAL, CAL + "a.ics", "etag1")[0];
  it.summary = "改后的标题";
  const out = ics.itemToEditedICS(it);
  const n = (out.match(/X-SIYUAN-BLOCK-ID/g) || []).length;
  assert.strictEqual(n, 1, "X- 属性必须恰好一份（进 MANAGED 才不会重复）");
  assert.match(out, /X-SIYUAN-BLOCK-ID:20261028-abc/);
});

check("没有 blockId 时不写这个属性", () => {
  assert.ok(!/X-SIYUAN-BLOCK-ID/.test(ics.itemToNewICS(item())));
});

console.log("[blocksync] ② 对账：四类动作");

check("陌生块 → creates（落默认日历、标题带前缀）", () => {
  const plan = bt.planBlockSync([block("b1", "买牛奶")], [], baseSettings());
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.creates[0].summary, "[文档]买牛奶");
  assert.strictEqual(plan.creates[0].completed, false);
});

check("块打勾 → pushes（条目置完成）", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false });
  const plan = bt.planBlockSync([block("b1", "买牛奶", true)], [it], baseSettings());
  assert.strictEqual(plan.pushes.length, 1);
  assert.strictEqual(plan.pushes[0].item.status, "COMPLETED");
  assert.strictEqual(plan.pushes[0].item.percent, 100);
  assert.strictEqual(plan.writebacks.length, 0);
});

check("服务端完成、块未勾 → writebacks（回写块勾选）", () => {
  const it = item({
    blockId: "b1",
    blockText: "买牛奶",
    blockChecked: false,
    status: "COMPLETED",
    percent: 100
  });
  const plan = bt.planBlockSync([block("b1", "买牛奶", false)], [it], baseSettings());
  assert.strictEqual(plan.writebacks.length, 1);
  assert.strictEqual(plan.writebacks[0].checked, true);
});

check("块文字改了 → pushes 且以块为准（服务端标题被覆盖）", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false, summary: "[文档]买牛奶" });
  const plan = bt.planBlockSync([block("b1", "买酸奶")], [it], baseSettings());
  assert.ok(plan.pushes.length >= 1);
  assert.strictEqual(plan.pushes[0].item.summary, "[文档]买酸奶");
  assert.strictEqual(plan.writebacks.length, 0, "文字不回写块（避免拍平富文本）");
});

check("块没了且确实不存在 → deletions", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false });
  const plan = bt.planBlockSync([], [it], baseSettings(), { existing: new Set() });
  assert.strictEqual(plan.deletions.length, 1);
});

check("块没了但仍在库里（只是不在扫描范围）→ 不删", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false });
  const plan = bt.planBlockSync([], [it], baseSettings(), { existing: new Set(["b1"]) });
  assert.strictEqual(plan.deletions.length, 0, "范围外 ≠ 已删除");
});

check("两边都动了 → 完成优先（不会来回翻转）", () => {
  const it = item({
    blockId: "b1",
    blockText: "买牛奶",
    blockChecked: false,
    status: "COMPLETED",
    percent: 100
  });
  const plan = bt.planBlockSync([block("b1", "买牛奶", true)], [it], baseSettings());
  // 块勾上（块动了）+ 服务端已完成（服务端动了）→ 维持完成，不再回写「未勾」
  assert.strictEqual(plan.writebacks.length, 0);
  assert.strictEqual(plan.pushes[0].item.status, "COMPLETED");
});

check("稳态（两边一致）→ 无动作", () => {
  const it = item({
    blockId: "b1",
    blockText: "买牛奶",
    blockChecked: false,
    summary: "[文档]买牛奶"
  });
  const plan = bt.planBlockSync([block("b1", "买牛奶", false)], [it], baseSettings());
  assert.strictEqual(plan.creates.length + plan.pushes.length + plan.writebacks.length + plan.deletions.length, 0);
  assert.strictEqual(plan.unchanged, 1);
});

check("映射缺失但服务端有锚点 → 不重复新建（按 blockId 认亲）", () => {
  const it = item({ blockId: "b1", blockText: "买牛奶", blockChecked: false });
  const plan = bt.planBlockSync([block("b1", "买牛奶")], [it], baseSettings());
  assert.strictEqual(plan.creates.length, 0);
});

console.log("[blocksync] ③ 辅助函数");

check("blockCheckedOf 认 `- [X]`（含大小写与缩进）", () => {
  assert.strictEqual(bt.blockCheckedOf("- [X] 完成"), true);
  assert.strictEqual(bt.blockCheckedOf("- [x] 完成"), true);
  assert.strictEqual(bt.blockCheckedOf("- [ ] 未完成"), false);
  assert.strictEqual(bt.blockCheckedOf("  - [X] 缩进的"), true);
});

check("回写勾选只动第一行，子块原样带回", () => {
  const md = "- [ ] 待办\n  - 子块内容";
  const out = bapi.withCheckedMarkdown(md, true);
  assert.strictEqual(out, "- [X] 待办\n  - 子块内容");
  assert.strictEqual(bapi.withCheckedMarkdown("- [X] x", false), "- [ ] x");
  assert.strictEqual(bapi.withCheckedMarkdown("不是任务块", true), null, "非任务块行必须拒绝改写");
});

check("块文字清洗：trim + 去同步前缀", () => {
  assert.strictEqual(bt.cleanBlockText("  买牛奶  "), "买牛奶");
  assert.strictEqual(bt.cleanBlockText("[文档]买牛奶", "[文档]"), "买牛奶");
});

check("前缀：设置里没勾 prefix 就不加", () => {
  assert.strictEqual(bt.withPrefix("买牛奶", baseSettings({ blockSyncMarks: ["badge"] })), "买牛奶");
  assert.strictEqual(bt.withPrefix("买牛奶", baseSettings({ blockSyncMarks: ["prefix"] })), "[文档]买牛奶");
  assert.strictEqual(bt.stripPrefix("[文档]买牛奶", baseSettings()), "买牛奶");
});

check("默认结束时间：与新建待办一致 → 开始 +8h；空 → 不写 DUE", () => {
  const s8 = baseSettings({ blockSyncDefaultEnd: "sameAsTodo", todoDefaultEnd: "plus8h" });
  assert.strictEqual(bt.blockDefaultEnd(s8, "2026-10-28T09:00:00"), "2026-10-28T17:00:00");
  const s1 = baseSettings({ blockSyncDefaultEnd: "sameAsTodo", todoDefaultEnd: "plus1h" });
  assert.strictEqual(bt.blockDefaultEnd(s1, "2026-10-28T09:00:00"), "2026-10-28T10:00:00");
  assert.strictEqual(bt.blockDefaultEnd(baseSettings({ blockSyncDefaultEnd: "none" }), "2026-10-28T09:00:00"), undefined);
});

check("角标默认开（未配置或含 badge）", () => {
  assert.strictEqual(bt.blockBadgeOn(baseSettings({ blockSyncMarks: undefined })), true);
  assert.strictEqual(bt.blockBadgeOn(baseSettings({ blockSyncMarks: ["badge", "prefix"] })), true);
  assert.strictEqual(bt.blockBadgeOn(baseSettings({ blockSyncMarks: ["prefix"] })), false);
});

console.log("[blocksync] ④ 源码级防漂移");

const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const settingsSrc = read("src/ui/settings-dialog.ts");
const indexSrc = read("src/index.ts");
const apiSrc = read("src/core/block-api.ts");
const typesSrc = read("src/core/types.ts");
const cssSrc = read("src/index.css");

check("设置区有「思源任务块识别与映射」段与（胶囊式）总开关", () => {
  assert.match(settingsSrc, /思源任务块识别与映射/);
  // 总开关改成胶囊 toggle（b3-switch），标识改为 data-blk-enable（不再用 data-s 打勾）
  assert.match(settingsSrc, /data-blk-enable/);
  assert.match(settingsSrc, /b3-switch/);
});
check("停用态有常驻提示（点开关/标题即可展开，不改变「关掉就隐藏」设计）", () => {
  assert.match(settingsSrc, /caldav-blk-hint/);
  assert.match(settingsSrc, /未启用/);
  // 启用时提示带 hidden（不显示），停用时不带
  assert.match(settingsSrc, /caldav-blk-hint"[^>]*>\s*未启用/);
});
check("收起卡头有「未启用」状态标签（停用可见、启用隐藏），且只收起开关以下", () => {
  // 收起卡头带未启用标签；body 才带 hidden，head/开关本身不带 → 验证「以下收起，不是全部」
  assert.match(settingsSrc, /caldav-blk-tag/);
  assert.match(settingsSrc, /caldav-blk-head[^>]*>\s*<span class="caldav-blk-dot"/);
  // 开关 input 不带 hidden（始终可见）
  assert.doesNotMatch(settingsSrc, /<input type="checkbox" class="b3-switch" data-blk-enable[^>]*\shidden/);
});
check("任务块卡**不复用** .caldav-acc 类名（否则会被 bindAccounts 当成账户卡）", () => {
  // 设置页 bindAccounts 用全局 .caldav-acc-head 挂账户展开/收起、测试按 .caldav-acc 数账户卡。
  // 这张卡若带 .caldav-acc，点卡头会走账户逻辑（整页 rerender）、账户计数还会多一张。
  assert.doesNotMatch(
    settingsSrc,
    /class="caldav-acc[^"]*caldav-blk-acc/,
    "任务块卡不该再挂 .caldav-acc（账户卡专用）"
  );
  assert.doesNotMatch(settingsSrc, /class="caldav-acc-head"[^>]*data-blk-head/, "卡头类名必须独立");
});
check("设置区有「扫描时机」三个独立开关（启动扫 / 手动同步扫 / 关闭文档扫）", () => {
  for (const k of ['data-s="blockSyncOnStartup"', 'data-s="blockSyncOnManualSync"', 'data-s="blockSyncOnDocClose"']) {
    assert.ok(settingsSrc.includes(k), "缺 " + k);
  }
});
check("设置区四个配置项齐全（日历 / 结束时间 / 范围 / 标记）", () => {
  for (const k of ["data-s=\"blockSyncCal\"", "data-s=\"blockSyncEnd\"", "data-s=\"blockSyncScope\"", "data-s=\"blockSyncMarkBadge\"", "data-s=\"blockSyncMarkPrefix\""]) {
    assert.ok(settingsSrc.includes(k), "缺 " + k);
  }
});
check("设置区有「增量扫描」开关（默认开）", () => {
  assert.ok(settingsSrc.includes('data-s="blockSyncIncremental"'), "缺增量扫描开关");
  assert.match(settingsSrc, /data-s="blockSyncIncremental"[^\n]*checked/);
  assert.strictEqual(T.DEFAULT_SETTINGS.blockSyncIncremental, true, "默认应为增量");
  assert.match(settingsSrc, /s\.blockSyncIncremental\s*=/, "保存时要落盘这个开关");
});
check("增量扫描的判据是内核 blocks.updated（SQL 里带 updated 条件）", () => {
  assert.match(apiSrc, /updated > /, "增量 SQL 应按 updated 过滤");
  assert.match(apiSrc, /updated IS NULL OR updated = ''/, "空 updated 的老块要永远命中");
});
check("存在性/按 ID 查询必须显式写 LIMIT（内核没写 LIMIT 时只回 64 行，会误删待办）", () => {
  const m = apiSrc.match(/SELECT id FROM blocks WHERE id IN \([\s\S]{0,200}?LIMIT/);
  assert.ok(m, "存在性查询后面必须跟 LIMIT");
  // 「按 ID 查 root_id」已随 blocksRootByIds 一起删除（那是错误逻辑的产物），
  // 现在按 ID 取块只有一条路径：scanTaskBlocksByIds。
  // ⚠️ 它的 `id IN (...)` 在 where 数组里、与 SELECT 不同行 → 不能用单行正则匹配源码，
  //    改为断言「按 ID 取块的那条 SELECT 语句末尾带 LIMIT」。
  const r = apiSrc.match(/SELECT id, content, markdown[^\n]*LIMIT \$\{chunk\.length\}/);
  assert.ok(r, "按 ID 取块（漂移用）后面必须跟 LIMIT");
  assert.doesNotMatch(apiSrc, /blocksRootByIds/, "blocksRootByIds 已删除，不该再出现");
});
check("手动「扫描全部」/「立即扫描」走全量，其余按增量 + 安全网", () => {
  assert.match(indexSrc, /blockSyncPass\(undefined, \{ full: true \}\)/, "手动扫描应强制全量");
  assert.match(read("src/core/block-sync.ts"), /BLOCK_FULL_SCAN_INTERVAL_MS/, "要有 24h 全量校准");
  assert.match(read("src/core/block-sync.ts"), /blockScopeSig/, "范围变了要退回全量");
});
check("范围含四项（打开的文档 / 仅日记 / 笔记本 / 全部文档）", () => {
  for (const v of ['value="open"', 'value="daily"', 'value="notebooks"', 'value="all"']) {
    assert.ok(settingsSrc.includes(v), "缺范围 " + v);
  }
});
check("设置区有「立即扫描」与「一键清理」两个按钮", () => {
  assert.match(settingsSrc, /data-action="blocks-scan"/);
  assert.match(settingsSrc, /data-action="blocks-clear"/);
});
check("总开关守卫：没启用就不跑对账 / 不挂块菜单", () => {
  assert.match(indexSrc, /if \(!s\.blockSyncEnabled\) return;/);
  assert.match(indexSrc, /if \(!this\.store\.settings\.blockSyncEnabled\) return/);
  assert.match(indexSrc, /open-menu-content/);
});
check("扫描时机受 onStartup / onManualSync 两个开关 gate（手动走 onManualSync，非手动走 onStartup）", () => {
  assert.match(indexSrc, /blockSyncOnManualSync/);
  assert.match(indexSrc, /blockSyncOnStartup/);
});
check("关闭文档时扫描：监听 destroy-protyle + 受 onDocClose gate", () => {
  assert.match(indexSrc, /destroy-protyle/);
  assert.match(indexSrc, /blockSyncOnDocClose/);
  assert.match(indexSrc, /onDocClose/);
});
check("块菜单始终挂两个固定扫描项（当前文档 / 全部）", () => {
  assert.match(indexSrc, /扫描任务块（当前文档）/);
  assert.match(indexSrc, /扫描任务块（全部）/);
});
check("扫块排除 skip 标记用的是 attributes 子查询（不是逐块调 API）", () => {
  assert.match(apiSrc, /id NOT IN \(SELECT block_id FROM attributes WHERE name = '\$\{BLOCK_SKIP_ATTR\}'\)/);
});
check("删除判生死走 blocksExistById（不靠扫描范围）", () => {
  assert.match(read("src/core/block-sync.ts"), /blocksExistById/);
});
check("★删除判生死不得按扫描范围收口（用户实测：关文档时把 100+ 条 VTODO 全删了）", () => {
  const bs = read("src/core/block-sync.ts");
  // 存在性查询必须针对**全部** missing 块，不能被 docIds / scope 过滤
  assert.match(bs, /blocksExistById\(deps\.caller, missing\)/, "存在性查询必须查全部 missing 块");
  // 绝不能出现「按 docIds 过滤后再查存在性」的写法（那会把别的文档的块踢出白名单 → 全删）
  assert.doesNotMatch(bs, /blocksExistById\(deps\.caller, inDoc\)/, "不能按文档收口存在性查询");
  assert.doesNotMatch(bs, /blocksRootByIds/, "blocksRootByIds 是错误逻辑的产物，不该再用");
});
check("★删除必须双重保险：既要在白名单外、也要确认查过存在性", () => {
  const bt = read("src/core/block-todo.ts");
  assert.match(bt, /if \(checked && !checked\.has\(id\)\) continue;/, "没查过存在性的块不得进删除队列");
});
check("取消同步必须打 skip 标记（否则下轮会被重建）", () => {
  const bs = read("src/core/block-sync.ts");
  assert.match(bs, /unsyncBlock[\s\S]{0,400}setBlockSkip/);
});
check("默认设置：总开关默认关、范围默认全部、标记默认角标", () => {
  assert.strictEqual(T.DEFAULT_SETTINGS.blockSyncEnabled, false);
  assert.strictEqual(T.DEFAULT_SETTINGS.blockSyncScope, "all");
  assert.deepStrictEqual(T.DEFAULT_SETTINGS.blockSyncMarks, ["badge"]);
  assert.strictEqual(T.DEFAULT_SETTINGS.blockSyncDefaultEnd, "sameAsTodo");
});
check("CalItem 有 blockId / blockText / blockChecked 三个字段", () => {
  assert.match(typesSrc, /blockId\?: string;/);
  assert.match(typesSrc, /blockText\?: string;/);
  assert.match(typesSrc, /blockChecked\?: boolean;/);
});
check("任务块开关切换为局部更新（不 rerender，避免滚动弹回设置开头）", () => {
  const m = settingsSrc.match(/const toggleBlock = \(\)[\s\S]*?\n {6}\};/);
  assert.ok(m, "找到 toggleBlock 定义");
  assert.doesNotMatch(m[0], /rerender\(\)/, "toggleBlock 不应整页重渲");
  assert.match(m[0], /body\.hidden = !on/, "应就地展开/收起 body");
  assert.match(m[0], /blkEnable\.checked = on/, "点标题切换时开关状态要同步");
  // 卡片在页面最底部，展开后要把它滚到滚动区顶部，否则"展开了但看不见"
  assert.match(m[0], /behavior:\s*"smooth"/, "展开后应平滑滚到顶部");
  assert.match(m[0], /requestAnimationFrame/, "须等下一帧布局稳定后再算位置");
});
check("rerender 需记住滚动位置（innerHTML 重建会把滚动条归零）", () => {
  assert.match(settingsSrc, /keepTop/);
  assert.match(settingsSrc, /formAfter\.scrollTop = keepTop/);
});
check("滚动区子项禁止 flex 压缩（否则手风琴卡因 overflow:hidden 被压成 0 高的一条线）", () => {
  // 2026-10-30 实测：.caldav-acc 带 overflow:hidden → flex item 自动最小尺寸退化为 0
  // → 成为唯一能被压扁的卡片（任务块卡压成上下 1px 边框）。必须锁住这条兜底。
  assert.match(cssSrc, /\.caldav-settings-form\s*>\s*\*[\s\S]{0,120}flex:\s*0\s+0\s+auto/);
  assert.match(cssSrc, /\.caldav-editor-form\s*>\s*\*[\s\S]{0,120}flex:\s*0\s+0\s+auto/);
});
check("完成态不可靠的归因必须是「同步冲突(412)」，不得写成「服务端降级」(2026-10-30 实测证伪)", () => {
  // 2026-10-30 实测：Baikal 完整保留 STATUS:COMPLETED（新建→GET / 改回→GET / 等 3 秒→GET
  // 四轮往返全对；199 条 COMPLETED 逐条 GET 与 REPORT 双路径读回一致）。
  // 曾经的「降级活证据」是本地 store 里的**陈旧 raw 快照**，不是服务端内容。
  // 若注释继续写「服务端会降级」，后来者会照着它把「单向回写」这条保险改回去 → 事故复发。
  const btSrc = read("src/core/block-todo.ts");
  const stSrc = read("src/core/store.ts");
  assert.doesNotMatch(btSrc, /实测 Baikal 会把[\s\S]{0,80}降级/);
  assert.doesNotMatch(stSrc, /实测服务端（Baikal）会把已完成的条目/);
  assert.match(btSrc, /不要归咎于「服务端降级」/);
  assert.match(btSrc, /If-Match/);
  assert.match(stSrc, /不要写成「服务端会降级完成态」/);
  assert.match(stSrc, /If-Match/);
});
check("服务端完成态被冲突覆盖时，块来源条目保留本地完成态", () => {
  const stSrc = read("src/core/store.ts");
  assert.match(
    stSrc,
    /merged\.blockId && keep\?\.blockChecked === true && !\(merged\.percent === 100 \|\| merged\.status === "COMPLETED"\)/
  );
});

console.log(`\n[blocksync] 合计 ${pass} 项通过`);
