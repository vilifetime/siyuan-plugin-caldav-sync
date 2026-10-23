/**
 * 待办附件回归测试 —— 2026-10-14。
 *
 * 为什么单独一个文件：这个功能的**底线不是"能上传"而是"编辑不能丢数据"**。
 * 上线前的实测发现插件根本不解析 ATTACH，且因为不保存 ICS 原文，
 * `itemToEditedICS` 是从 CalItem 重新拼一份 —— 改个标题就把服务端的附件抹掉了。
 * 那条底线必须钉死，所以用例围绕「往返不改/增/删都不丢别人的东西」。
 *
 * 另外钉五件容易回归的事：
 *  ① 二进制内嵌件（VALUE=BINARY）**收进 attachments**，编辑时按列表重写；
 *  ② 长 base64 必须正确折行/拼行，否则大附件必坏；
 *  ③ ATTACH 进了 MANAGED 白名单 —— 不在白名单的话界面上删链接根本落不到 ICS；
 *  ④ 任务视图只在**待办**上显示附件，日程不显示；
 *  ⑤ 体积硬上限（设置项可调，2026-10-15 用户传 74MB zip → ICS 99MB → Radicale
 *    默认 10MB 上限 413、待办永久卡在同步失败）：单文件 5MB 挑选时拒、整份 ICS
 *    10MB 保存前卡、putItem 网络层兜底拒；设置弹窗「附件大小限制 / 单个ICS文件限制」。
 *
 * 附件存放方式（2026-10-14 晚改）：用户服务器是 Radicale，它把每个 PUT 进日历集合的
 * 文件都当 iCalendar 解析，放 .txt/.pdf 一律 400（实测）。所以附件改为
 * **二进制内联进 ICS**（RFC 5545 的 VALUE=BINARY;ENCODING=BASE64），跟着条目同步，
 * 不再单独 HTTP 上传。
 *
 * 用法：node test/todo-attach.cjs
 */
const assert = require("assert");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
// ⚠️ 本仓库是 CRLF 行尾（git autocrlf 产物）：源码断言的正则一律禁写死 `\n`
// （2026-10-20 实测：`raw,\n` 在 CRLF 原文上永不匹配，todo-attach 白挂一项）。
// 读进来先统一成 LF，断言按 LF 写。
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// 源码是 TS，Node 不能直接 require —— 用 tsc 编译到临时目录再引。
// 与 core.test.mjs 同一套路（那里连 store/sync 一起编）。
const outDir = path.join(ROOT, ".test-attach");
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts src/core/store.ts src/core/secret.ts ` +
    `--outDir .test-attach --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: ROOT, stdio: "inherit" }
);
// 声明 cjs，避免被根 package.json 的 type:module 影响
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const ics = require(path.join(outDir, "ics.js"));
const storeMod = require(path.join(outDir, "store.js"));

const BIN_B64 = Buffer.from("binary-blob").toString("base64");
const URL_PDF = "https://example.com/a.pdf";

/** 造一份「一个链接附件 + 一个二进制内嵌件」的待办原文 */
function makeIcs(summary = "带附件的待办") {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:att-1@test",
    `SUMMARY:${summary}`,
    "DTSTAMP:20260101T000000Z",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    `ATTACH;FMTTYPE=application/pdf:${URL_PDF}`,
    `ATTACH;VALUE=BINARY;ENCODING=BASE64;FBTYPE=application/msword;X-LINK-UID=x1:${BIN_B64}`,
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
}

const parse = (raw) => ics.itemsFromICS(raw, "http://cal/", "http://cal/att-1.ics", '"e1"')[0];

/**
 * 取「ATTACH 属性」——**必须先把 RFC 5545 的折行拼回去**。
 *
 * ⚠️ 这是本文件第一版的真 bug：长属性会被折成
 *   `ATTACH;…;X-LINK-U` + ` 1:YmluYXJ5LWJsb2I=`
 * 两行，逐行 `includes(b64)` 永远匹配不上 → 误报「二进制被删了」。
 * 插件本身是对的，是判据没拼行。
 */
function attachLines(text) {
  const rawLines = text.split(/\r?\n/);
  const out = [];
  for (const l of rawLines) {
    if (l.startsWith(" ")) {
      if (out.length) out[out.length - 1] += l.slice(1); // 续行：去掉前导空格接回上一行
      continue;
    }
    if (l.startsWith("ATTACH")) out.push(l);
  }
  return out;
}

let failed = 0;
function check(name, cond, hint) {
  if (cond) console.log("  [PASS] " + name);
  else {
    console.log("  [FAIL] " + name + (hint ? " —— " + hint : ""));
    failed++;
  }
}

console.log("附件：解析");

{
  const it = parse(makeIcs());
  // 两种形式都收：1 个链接 + 1 个二进制内嵌
  check("解析出 2 个附件（1 链接 + 1 二进制）", it.attachments && it.attachments.length === 2, JSON.stringify(it.attachments?.map((a) => a.name)));
  const link = it.attachments?.find((a) => a.uri);
  check("链接正确", link?.uri === URL_PDF);
  check("FMTTYPE 正确", link?.fmttype === "application/pdf");
  check(
    "文件名从 URI 末段取",
    link?.name === "a.pdf",
    "实际: " + link?.name
  );
  // 二进制内嵌件：base64 必须**完整**收进来（解析器已拼折行）
  const bin = it.attachments?.find((a) => a.b64);
  check("二进制件收进 attachments", !!bin);
  check("二进制 base64 完整（折行已拼回）", bin?.b64 === BIN_B64, "实际: " + bin?.b64);
  check("二进制件带 FMTTYPE", bin?.fmttype === "application/msword");
}

{
  // 多个链接附件：ATTACH 可重复出现，只取第一个是错的
  const raw = makeIcs().replace(
    `ATTACH;FMTTYPE=application/pdf:${URL_PDF}`,
    `ATTACH;FMTTYPE=application/pdf:${URL_PDF}\r\nATTACH;FMTTYPE=application/vnd.ms-excel:https://example.com/b.xlsx`
  );
  const it = parse(raw);
  check("多个链接附件要全部解析出来（+1 二进制 = 3）", it.attachments?.length === 3, "实际 " + it.attachments?.length);
}

{
  // 大 base64 的折行/拼行：这是二进制内联方案最脆的一环。
  // RFC 5545 规定长属性按 75 字节折行、续行以空格开头；解析不拼、序列化不折，
  // 几百 KB 的附件必然坏。用一个必然跨多行的 base64 钉住。
  const BIG = Buffer.alloc(1200, 0x42).toString("base64"); // 全 B，1600 字符
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:big@test",
    "SUMMARY:大附件",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    `ATTACH;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=application/octet-stream:${BIG}`,
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const it = parse(raw);
  check("大 base64 完整解析（折行拼回）", it.attachments?.[0]?.b64 === BIG,
    "长度 实际=" + (it.attachments?.[0]?.b64?.length ?? -1) + " 期望=" + BIG.length);
  // 编辑后回写：序列化必须重新折行，且拼回来一字不差
  it.raw = raw;
  it.summary = "改个标题";
  const out = ics.itemToEditedICS(it);
  const back = parse(out);
  check("编辑往返后大 base64 一字不差", back.attachments?.[0]?.b64 === BIG);
  check(
    "回写时长属性确实被折行了（不是一行怼到底）",
    attachLines(out).some((l) => l.includes("VALUE=BINARY")) && out.split(/\r?\n/).filter((l) => l.startsWith(" ") || l.startsWith("ATTACH")).length > 1,
    "没折行说明 foldLine 被绕过，长 ICS 会被服务端拒收"
  );
}

console.log("\n附件：编辑往返不能丢");

{
  // 这是本次最关键的一条：改标题后，服务端的链接与二进制都必须还在。
  const it = parse(makeIcs());
  it.raw = makeIcs(); // store 里保存了原文
  it.summary = "改了标题";
  const lines = attachLines(ics.itemToEditedICS(it));
  check("改标题后链接附件仍在", lines.some((l) => l.includes(URL_PDF)), lines.join(" | "));
  check("改标题后二进制内嵌件仍在", lines.some((l) => l.includes("VALUE=BINARY") && l.includes(BIN_B64)));
  check("标题确实改了（对照组）", ics.itemToEditedICS(it).includes("SUMMARY:改了标题"));
}

console.log("\n文本转义：escape/unescape round-trip");

{
  // 2026-10-19 雄哥问「内容字符如何避免破坏 ICS 行结构」时复查发现的 bug：
  // 旧版 unescapeText 四轮 replace，字面「反斜杠+n」escape 成 `a\\\\nb` 后，先跑的
  // `\n` 轮会把 `\\n` 尾部误判成换行 → 读回来变成「反斜杠+真换行」，内容保真丢失。
  const LITERAL = "a\\nb"; // 三个字符：a、反斜杠、n——用户真输入了这个
  check("字面「反斜杠+n」往返后仍是字面（旧版会误读成换行）",
    ics.unescapeText(ics.escapeText(LITERAL)) === LITERAL,
    "实际: " + JSON.stringify(ics.unescapeText(ics.escapeText(LITERAL))));
}

{
  // 常规混合 round-trip：真换行、分号、逗号、反斜杠
  const MIX = "第一行\n第二;行,含\\反斜杠";
  check("混合特殊字符往返一字不差",
    ics.unescapeText(ics.escapeText(MIX)) === MIX,
    "实际: " + JSON.stringify(ics.unescapeText(ics.escapeText(MIX))));
  check("escape 后确实不含裸换行（否则破坏 ICS 行结构）",
    !/\r?\n/.test(ics.escapeText(MIX)));
}

{
  // 外部客户端兼容：RFC 5545 允许 `\N`（大写）也表示换行
  check("外部写的大写 \\N 也解成换行", ics.unescapeText("a\\Nb") === "a\nb");
  // 宽容解析：未知转义序列原样保留，不吞字符
  check("未知转义原样保留", ics.unescapeText("a\\xb") === "a\\xb");
}

{
  // 源码防漂移：必须是单次扫描，不许回退成多轮 replace
  const src = read("src/core/ics.ts");
  const fn = /export function unescapeText\([\s\S]*?\n\}/.exec(src);
  const replaceCount = fn ? (fn[0].match(/replace\(/g) || []).length : -1;
  check("unescapeText 单次扫描（防回退成多轮 replace 二次匹配）",
    !!fn && replaceCount === 1 && /\\\\\(n\|N\|,\|;\|\\\\\)/.test(fn[0]),
    "多轮 replace 会把字面「反斜杠+n」误读成换行（2026-10-19 实测）；实际 replace 次数: " + replaceCount);
}

{
  // 附件名必须跟着 ICS 一起同步（2026-10-19 雄哥问「换设备下载能不能恢复原名」）：
  // 原先 ICS 里只有 VALUE=BINARY;ENCODING=BASE64;FMTTYPE，服务器上那份是无名氏——
  // 本机下载走本地 attachments[].name 没事，但换设备/本地数据丢了重拉就退化成「附件.jpg」。
  // 编码策略（当晚二次修正，雄哥在 emClient 看到 %E5%91%A8… 乱码）：**裸写优先**，
  // 只编码 ICS 结构危险字符（% / , : ; "）——X-FILENAME 是 Apple 系惯例、外部客户端原样显示。
  const SPECIAL = "周报;v2,最终:版.pdf";
  const it = parse(makeIcs());
  it.raw = makeIcs();
  it.attachments = (it.attachments || []).map((a) => (a.b64 ? { ...a, name: SPECIAL } : a));
  const out = ics.itemToEditedICS(it);
  const back = parse(out);
  const binBack = back.attachments?.find((a) => a.b64);
  const binLine = attachLines(out).filter((l) => l.includes("VALUE=BINARY"))[0] || "";
  check("二进制件的原名写进了 ICS（X-FILENAME 参数）", /ATTACH;[^:\r\n]*X-FILENAME=/.test(out), binLine.slice(0, 100));
  check("中文裸写（不整体 percent-encode，否则 emClient 等外部客户端显示乱码）", binLine.includes("周报"), binLine.slice(0, 140));
  check("结构危险字符仍被编码（; , : 不能裸奔进行参数）", binLine.includes("%3B") && binLine.includes("%2C") && binLine.includes("%3A"), binLine.slice(0, 140));
  check("换设备重拉后原名一字不差还原", binBack?.name === SPECIAL, "实际: " + binBack?.name);
  check("链接附件不写 X-FILENAME（名字在 URL 末段，解析端自己取）",
    !attachLines(out).some((l) => l.includes("a.pdf") && l.includes("X-FILENAME")));
}

{
  // 文件名含字面 `%`：序列化必须把 % 自己编码成 %25，否则解析端 decode 会把 `50%.pdf`
  // 当成坏转义（decodeURIComponent 抛 URIError）。第一版整体 encodeURIComponent 顺带处理了
  // 这个，改裸写优先后必须显式编码 %。
  const PCT = "进度 50%.pdf";
  const it = parse(makeIcs());
  it.raw = makeIcs();
  it.attachments = (it.attachments || []).map((a) => (a.b64 ? { ...a, name: PCT } : a));
  const out = ics.itemToEditedICS(it);
  const binLine = attachLines(out).filter((l) => l.includes("VALUE=BINARY"))[0] || "";
  const back = parse(out);
  check("字面 % 编码成 %25（否则解析端解码抛错）", binLine.includes("%25"), binLine.slice(0, 140));
  check("含 % 文件名 round-trip 还原", back.attachments?.find((a) => a.b64)?.name === PCT,
    "实际: " + back.attachments?.find((a) => a.b64)?.name);
}

{
  // 外部客户端（Apple/emClient）写的裸值：非我们编码风格，解析端不能炸。
  // 两种形态：纯中文裸写（应原样显示）+ 裸 `%` 值（decode 会抛，必须回落原串）。
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:ext@test",
    "SUMMARY:外部客户端附件",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    `ATTACH;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=application/pdf;X-FILENAME=外部周报.pdf:${BIN_B64}`,
    `ATTACH;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=application/pdf;X-FILENAME=50%.pdf:${BIN_B64}`,
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const it = parse(raw);
  check("外部裸中文名原样解析（不抛错）", it.attachments?.[0]?.name === "外部周报.pdf",
    "实际: " + it.attachments?.[0]?.name);
  check("外部裸 % 值回落原串（decodeURIComponent 抛错时不丢名字）", it.attachments?.[1]?.name === "50%.pdf",
    "实际: " + it.attachments?.[1]?.name);
}

{
  // 名字为空（脏数据/别的客户端写的不带名）时不写空参数——ICS 里 `;X-FILENAME=` 是垃圾
  const it = parse(makeIcs());
  it.raw = makeIcs();
  it.attachments = (it.attachments || []).map((a) => (a.b64 ? { ...a, name: "" } : a));
  const out = ics.itemToEditedICS(it);
  check("名字为空时不写 X-FILENAME 空参数", !attachLines(out).some((l) => l.includes("X-FILENAME=")));
}

{
  // 新增链接
  const it = parse(makeIcs());
  it.raw = makeIcs();
  it.attachments.push({ uri: "https://example.com/b.xlsx", name: "b.xlsx", fmttype: "application/vnd.ms-excel" });
  const lines = attachLines(ics.itemToEditedICS(it));
  check("新增的链接写入 ICS", lines.some((l) => l.includes("b.xlsx")));
  check("新增后二进制仍在", lines.some((l) => l.includes("VALUE=BINARY")));
  check("新增后共 3 条 ATTACH", lines.length === 3, "实际 " + lines.length);
}

{
  // 删除链接 —— **绝不能连带删掉二进制内嵌件**，那是我们不管理的别人的数据
  const it = parse(makeIcs());
  it.raw = makeIcs();
  it.attachments = (it.attachments || []).filter((a) => a.uri !== URL_PDF);
  const lines = attachLines(ics.itemToEditedICS(it));
  check("被删的链接已消失", !lines.some((l) => l.includes("a.pdf")), lines.join(" | "));
  check(
    "删除链接后二进制内嵌件**仍然保留**",
    lines.some((l) => l.includes("VALUE=BINARY") && l.includes(BIN_B64)),
    "删一个链接把别人的内嵌件也删了 —— 这是数据丢失"
  );
  check("删光链接后不写空 ATTACH", !lines.some((l) => /ATTACH[^:]*:\s*$/.test(l)));
}

{
  // 没有附件的待办不应凭空长出 ATTACH
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VTODO",
    "UID:noatt@test",
    "SUMMARY:无附件",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const it = parse(raw);
  check("无附件时 attachments 为 undefined", it.attachments === undefined);
  it.raw = raw;
  check("无附件时回写不含 ATTACH", attachLines(ics.itemToEditedICS(it)).length === 0);
}

console.log("\n附件：删光 vs 老数据（两个方向都必须对）");

{
  // ⚠️ 这一对是本次最容易写错的地方，两个方向各钉一条：
  //  - `attachments = []`（用户明确删光）→ 二进制件必须**消失**，否则删除无效；
  //  - `attachments = undefined`（老数据，二进制支持之前解析的）→ 原文里的
  //    二进制件必须**原样带回**，否则升级后第一次编辑就丢附件。
  // 用一个判据同时满足两者是不可能的，必须靠「字段在不在」区分。
  const it = parse(makeIcs());
  it.raw = makeIcs();
  it.attachments = [];
  const emptied = ics.itemToEditedICS(it);
  check(
    "删光附件（[]）后二进制件也消失",
    attachLines(emptied).length === 0,
    "用户的删除必须生效 —— 宁可让老数据走另一条路，也不能让删除失灵"
  );
  check(
    "删光附件后整份 ICS 不含 base64 串（雄哥问「删除有没有把 base64 从数据包里删掉」）",
    !emptied.includes(BIN_B64),
    "ATTACH 行没了但 base64 还藏在别处，同样占体积、同样会随编辑重传"
  );

  const legacy = parse(makeIcs());
  legacy.raw = makeIcs();
  delete legacy.attachments; // 模拟老数据：字段压根不存在
  const lines = attachLines(ics.itemToEditedICS(legacy));
  check(
    "老数据（undefined）原文二进制件原样带回",
    lines.some((l) => l.includes("VALUE=BINARY") && l.includes(BIN_B64)),
    "升级用户的第一次编辑不能丢附件"
  );
  check("老数据原样带回时链接也在", lines.some((l) => l.includes(URL_PDF)));
}

console.log("\n附件：新建待办");

{
  const it = {
    uid: "new@test",
    kind: "todo",
    calendarUrl: "http://cal/",
    href: "http://cal/new.ics",
    summary: "新建带附件",
    allDay: false,
    start: "2026-10-20T09:00:00",
    end: "2026-10-21T09:00:00",
    attachments: [{ uri: "https://example.com/new.pdf", name: "new.pdf", fmttype: "application/pdf" }]
  };
  const out = ics.itemToNewICS(it).replace(/\r\n /g, "");
  check("新建时附件写入 ICS", out.includes("https://example.com/new.pdf"));
  check("新建时带 FMTTYPE", /ATTACH;FMTTYPE=application\/pdf/.test(out), out.split(/\r?\n/).find((l) => l.startsWith("ATTACH")) || "");
  check("新建时带 FILENAME（换设备重拉也叫得出原名）", /FILENAME=new\.pdf/.test(out), out.split(/\r?\n/).find((l) => l.startsWith("ATTACH")) || "");
}

console.log("\n附件：源码防漂移");

{
  const icsSrc = read("src/core/ics.ts");
  const typesSrc = read("src/core/types.ts");
  const taskSrc = read("src/ui/view-task.ts");

  // ATTACH 必须在 MANAGED 里 —— 否则界面上的增删根本写不进 ICS（最容易被"优化"掉）
  const managed = /const MANAGED = new Set\(\[([\s\S]*?)\]\)/.exec(icsSrc);
  check("能定位 MANAGED 白名单", !!managed);
  check('ATTACH 在 MANAGED 白名单里（界面增删才落得到 ICS）', /"ATTACH"/.test(managed?.[1] || ""));

  check("CalItem.attachments 字段存在", /attachments\?: CalAttachment\[\]/.test(typesSrc));
  check("CalAttachment 类型存在", /export interface CalAttachment/.test(typesSrc));

  // 任务视图：只在待办上显示（日程不显示）
  check("任务视图渲染附件链接", /cal-task-attach/.test(taskSrc));
  check("附件只在非日程时渲染", /!isEvent \? it\.attachments/.test(taskSrc) || /const atts = !isEvent/.test(taskSrc));

  // 点击附件链接不能冒泡去打开编辑器
  const panelSrc = read("src/ui/panel.ts");
  check(
    "点附件链接被拦截（不弹编辑器）",
    /closest\("\[data-attach-open\]"\)/.test(panelSrc),
    "少了拦截：点链接会冒泡到 [data-open] 委托 → 弹编辑器，链接点不开"
  );
}

console.log("\n附件：二进制内联上传（不再走 HTTP PUT）");

{
  const editorSrc = read("src/ui/editor.ts");
  const caldavSrc = read("src/core/caldav.ts");
  const httpSrc = read("src/core/http.ts");
  const panelSrc = read("src/ui/panel.ts");
  const taskSrc = read("src/ui/view-task.ts");

  // 阈值：超过 800K 先确认。写死数字而不是从源码读 —— 这里要钉的就是这个值本身。
  check(
    "上传大小提醒阈值是 800K",
    /ATTACH_SIZE_WARN = 800 \* 1024/.test(editorSrc),
    "阈值是产品决策，改了要用户点头"
  );
  check(
    "超过阈值先走确认栏（不是直接传）",
    /file\.size > ATTACH_SIZE_WARN[\s\S]{0,400}?confirmLargeFile/.test(editorSrc),
    "大文件内联后每次编辑都重传，必须让用户知情"
  );
  check(
    "确认栏有确定/取消两个按钮",
    /data-attach-confirm-ok/.test(editorSrc) && /data-attach-confirm-no/.test(editorSrc)
  );

  // 项目约定不用 confirm()：原生框在思源里样式割裂、移动端体验差
  // ⚠️ 必须先剥注释再判 —— 这条断言自己的解释文字里就写着 "confirm()"，
  //    不剥就会匹配到自己、永远假绿（2026-10-14 在 Obsidian 侧踩过同型的坑）。
  const editorCode = editorSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check(
    "不用原生 confirm()",
    !/\bconfirm\s*\(/.test(editorCode.replace(/confirmLargeFile/g, "")) && !/window\.confirm/.test(editorCode),
    "删按钮的二次点击确认、大文件确认都走行内控件"
  );

  // base64 转换必须分块 —— spread 展开大数组会爆栈
  check(
    "ArrayBuffer → base64 分块转换",
    /const CHUNK = 0x8000/.test(editorSrc) && /fromCharCode\(\.\.\.bytes\.subarray/.test(editorSrc),
    "String.fromCharCode(...bytes) 对几百 KB 就爆栈"
  );

  // HTTP 上传链路整条删掉：Radicale 把日历目录里每个文件都当 iCalendar 解析，
  // 放别的文件一律 400（本地 Radicale 3.8 实测，服务端日志 Failed to parse line）。
  // 留着这套死代码会让人以为还有戏，继续往那个方向排查。
  check(
    "HTTP 附件上传函数已删除",
    !/export async function uploadAttachment/.test(caldavSrc) &&
      !/export async function probeAttachmentUpload/.test(caldavSrc) &&
      !/export async function deleteAttachmentFile/.test(caldavSrc),
    "Radicale 类服务端只收 iCalendar，这条路服务端层面不通"
  );
  check(
    "HttpOptions.binaryBody 已删除",
    !/binaryBody/.test(httpSrc),
    "唯一的使用方就是那个上传函数，一起走"
  );

  // 界面提示要说清楚「内联」，别让用户以为文件存在服务器上的单独文件里
  check(
    "提示文案说明是内联进待办",
    /内联进待办/.test(editorSrc),
    "用户需要知道文件是存在日历条目里的"
  );

  // 二进制件的打开方式：blob 下载，不是新标签页
  check(
    "二进制附件走 blob 下载",
    /createObjectURL/.test(panelSrc) && /a\.download/.test(panelSrc),
    "内联件没有可打开的地址，只能解出来落盘"
  );

  // 编辑器里的已有附件也要能下载（2026-10-19 雄哥报「编辑待办里附件没法下载」）：
  // 任务视图的下载按钮一直有（上面那条），编辑器是漏的
  const iconsSrc = read("src/ui/icons.ts");
  check("icons.ts 有 download 图标", /download: svg\(/.test(iconsSrc));
  check(
    "编辑器二进制附件行带「下载」按钮",
    /data-attach-dl/.test(editorSrc) && /icons\.download/.test(editorSrc),
    "只能上传不能取回 = 附件进去了出不来"
  );
  check(
    "下载函数与任务视图同机制（atob→Blob→a.download）",
    /function downloadAttachment/.test(editorSrc) &&
      /URL\.createObjectURL/.test(editorSrc) &&
      /link\.download = safeAttachName/.test(editorSrc),
    "两处实现要可对照，别写着写着漂移"
  );
  check(
    "objectURL 会 revoke（否则每次下载泄漏一份内存）",
    /URL\.revokeObjectURL/.test(editorSrc),
    "大附件反复下载会攒出几十 MB"
  );
  check(
    "下载点击有处理分支",
    /closest<HTMLElement\>\("\[data-attach-dl\]"\)/.test(editorSrc),
    "按钮渲染了没人接 = 点了没反应"
  );
  check(
    "下载失败走行内提示（不用 alert）",
    /catch \(err\)\s*\{\s*setMsg\(err instanceof Error/.test(editorSrc),
    "项目约定：反馈一律行内控件；panel.ts 那版用的 alert，别抄错（文件顶部配置提示那个老 alert 与本次无关，别误伤）"
  );
  check(
    "任务视图区分内联件（bin: 标记）",
    /bin:/.test(taskSrc) && /cal-task-attach-link--bin/.test(taskSrc)
  );

  // 保存时：删光写 [] 而不是 undefined（undefined 在老数据里是「原样带回」的信号）
  check(
    "保存时过滤空条目且保留空数组语义",
    /it\.attachments = attachList\.filter/.test(editorSrc),
    "写成 undefined 会让删除失效，见上面「删光 vs 老数据」用例"
  );
}

console.log("\n附件：大文件确认流（只说一遍 / 三态 / 提示语实时刷新）");

{
  const editorSrc = read("src/ui/editor.ts");
  const cssSrc = read("src/index.css");

  // ① 重复提示回归（2026-10-15 雄哥截图）：超 800KB 的文件，挑选时**不再**预发
  //    一段红色说明。早先 setMsg 说一遍、确认栏又说一遍，同一信息连报两遍，
  //    一次普通确认被做成了报错的样子。行为层由 test/attach-confirm.mjs 实测。
  const warnBranch = /file\.size > ATTACH_SIZE_WARN[\s\S]{0,600}?await confirmLargeFile/.exec(editorSrc);
  check("能定位超过 800KB 的分支", !!warnBranch);
  check(
    "超过阈值不再预发 setMsg（文件信息只说一遍）",
    !!warnBranch && !/setMsg\([^)]*true/.test(warnBranch[0]) && !warnBranch[0].includes("体积会涨"),
    "预发红色说明 + 确认栏再说一遍 = 同一信息报两遍（雄哥截图报的）"
  );
  const confirmFn = /function confirmLargeFile\([\s\S]*?\n\}/.exec(editorSrc);
  check("能定位 confirmLargeFile", !!confirmFn);
  check(
    "确认栏自带完整说明文（为什么确认 + 仍要内联吗）",
    !!confirmFn && confirmFn[0].includes("体积会涨") && confirmFn[0].includes("仍要内联吗"),
    "挑选侧不预发消息了，说明文必须并进确认栏，否则用户只被问、不知道为什么要被问"
  );
  check(
    "确认栏文案是「建议」口吻（当前为 X，附件建议不超过 N），不用「超过 N」的违规口吻",
    !!confirmFn &&
      confirmFn[0].includes("当前为 ${sizeText(file.size)}") &&
      confirmFn[0].includes("附件建议不超过 ${sizeText(ATTACH_SIZE_WARN)}") &&
      !confirmFn[0].includes("，超过 ${sizeText(ATTACH_SIZE_WARN)}"),
    "2026-10-15 雄哥：上限 7MB 没到还被提醒，确认栏不能写得像在指责他超限"
  );
  check(
    "说明文在源码里只出现一遍",
    (editorSrc.match(/体积会涨约 1\/3/g) || []).length === 1,
    "出现两遍就等于又回到了重复提示"
  );

  // ② 三态返回值：ok / cancel / superseded。作废若不 resolve，旧 Promise 永远
  //    悬挂、旧 handler 永远不返回；若把作废当取消，还会刷一条误导的「已取消上传」。
  check(
    "确认栏返回三态且作废时 resolve",
    /type ConfirmLargeFileResult = "ok" \| "cancel" \| "superseded"/.test(editorSrc) &&
      /cancelPendingConfirm\?\.\(\)/.test(editorSrc) &&
      /cancelPendingConfirm = \(\) => done\("superseded"\)/.test(editorSrc),
    "只返回布尔 → 没点确认又选新文件时，旧 handler 要么永远悬挂、要么误刷「已取消上传」"
  );
  check(
    "只有用户点取消才提示「已取消上传」",
    /if \(r === "cancel"\) setMsg\("已取消上传"\)/.test(editorSrc),
    "写成 r !== \"ok\" 会把「被新选择作废」也提示成用户主动取消"
  );

  // ③ 去错误化只去确认栏：硬上限拒绝仍是红色 is-error，确认栏走中性 accent
  const hardBranch = /if \(file\.size > maxBytes\)[\s\S]*?return;/.exec(editorSrc);
  check(
    "硬上限拒绝仍是红色错误（is-error）",
    !!hardBranch && /setMsg\([\s\S]*?true\s*\)/.test(hardBranch[0]) && hardBranch[0].includes("超过单文件上限"),
    "去错误化不能把真拒绝也中性化 —— 超过上限是必须看见的错"
  );
  const confirmCss = /\.caldav-attach-confirm \{[^}]*\}/.exec(cssSrc);
  check(
    "确认栏左边框用中性 accent 色（不是 danger）",
    !!confirmCss && confirmCss[0].includes("border-left: 3px solid var(--caldav-accent)") && !confirmCss[0].includes("danger"),
    "红色左边框让普通确认看着像报错（2026-10-15 雄哥截图）"
  );

  // ④ 提示语实时刷新（2026-10-15 雄哥报「改了 7M 还提示 5M」）：editorHtml 渲染时
  //    的上限是开弹窗那一刻的快照，设置里把 5 改成 7 之后，旧弹窗的提示语还挂着
  //    5.0 MB，看着就像设置没生效。挑选文件时按当前设置重写，显示的上限才与
  //    实际校验的上限一致。
  check(
    "提示语抽出 attachHintHtml 且挂在 data-attach-hint 上",
    /function attachHintHtml\(maxBytes: number, isIcloud\?: boolean\)/.test(editorSrc) && /data-attach-hint/.test(editorSrc),
    "不抽出函数就没法在挑选时重写"
  );
  check(
    "挑选文件时按当前设置实时刷新提示语（在校验之前）",
    // ⚠️ 仓库是 CRLF：两行之间的间隔用 \s*，别写死 \n（本项目踩过的坑）
    /const maxBytes = attachSizeMaxBytes\(ctx\.store\.settings\);\s*refreshHint\(\);/.test(editorSrc) &&
      /hintEl\.innerHTML = attachHintHtml\(attachSizeMaxBytes\(ctx\.store\.settings\), isIcloud\)/.test(editorSrc),
    "开弹窗后的快照会过期：设置里 5 改 7，旧弹窗仍显示 5.0 MB，就像设置没生效"
  );
}

// =====================================================================
// 编辑不能丢数据 —— ICS 原文（raw）必须跟着拉取一起下来
//
// 这是 2026-10-14 的真实事故：用户报告「任务里原本有附件，编辑后全没了」。
// 根因不是附件解析，而是 **itemsFromICS 从不把服务端原文写进 item.raw**，
// 于是 itemToEditedICS 退化成 itemToNewICS 整份重拼，把该资源里所有
// 未管理属性（ATTACH 二进制件、ORGANIZER、ATTENDEE、VTIMEZONE、其它组件…）
// 一并抹掉。实测用户本地 250 条里只有 9 条有 raw（全是插件自己新建的）。
//
// ⚠️ 本文件上面那些用例全都 `it.raw = makeIcs()` 手工补了原文 —— 正是这个
// 「假造前提」让真 bug 一路绿灯。下面这批**一律不补**，老代码在此必红。
// =====================================================================

console.log("\n数据丢失回归：拉取必须带上 ICS 原文");

{
  const it = parse(makeIcs());
  const raw = it.raw || "";
  check(
    "服务端解析出的条目自带 raw",
    typeof it.raw === "string" && raw.includes("BEGIN:VCALENDAR"),
    "没有 raw → 编辑走 itemToNewICS 整份重拼，服务端属性全丢（2026-10-14 实测）"
  );
  check(
    "raw 是整份资源（含 VCALENDAR 外壳，VTIMEZONE 才保得住）",
    raw.includes("BEGIN:VCALENDAR") && raw.includes("END:VCALENDAR") && raw.includes("BEGIN:VTODO")
  );
}

{
  // 最关键的一条：**完全不碰 raw**，改个标题，附件必须还在。
  const it = parse(makeIcs());
  it.summary = "改了标题";
  const out = ics.itemToEditedICS(it);
  const lines = attachLines(out);
  check("不补 raw：改标题后链接附件仍在", lines.some((l) => l.includes(URL_PDF)), lines.join(" | "));
  check(
    "不补 raw：改标题后二进制内嵌件仍在",
    lines.some((l) => l.includes("VALUE=BINARY") && l.includes(BIN_B64)),
    "删一个链接把别人的内嵌件也删了 —— 这是数据丢失"
  );
  check("不补 raw：标题确实改了（对照组）", out.includes("SUMMARY:改了标题"));
}

{
  // 二进制-only 待办：attachments 为空，但原文里的二进制件不能被自己抹掉
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:bin-only@test",
    "SUMMARY:只有二进制附件",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    `ATTACH;VALUE=BINARY;ENCODING=BASE64;FBTYPE=application/msword;X-LINK-UID=x1:${BIN_B64}`,
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const it = parse(raw);
  check("二进制-only：附件收进 attachments（现在既要展示也要管）", it.attachments && it.attachments.length === 1 && !!it.attachments[0].b64,
    "不收就等于编辑一次把它抹掉 —— 用户报的『附件不见了』正是这条");
  it.summary = "改了标题";
  check(
    "二进制-only：改标题后二进制件仍在（用户报的『附件不见了』就是这条）",
    attachLines(ics.itemToEditedICS(it)).some((l) => l.includes("VALUE=BINARY") && l.includes(BIN_B64))
  );
}

{
  // 不只是附件：ORGANIZER / ATTENDEE / VTIMEZONE / X- 扩展同样靠 raw 活着
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VTODO",
    "UID:org-1@test",
    "SUMMARY:带组织者",
    "DTSTART;TZID=Asia/Shanghai:20261020T090000",
    "DUE;TZID=Asia/Shanghai:20261021T090000",
    "ORGANIZER:mailto:boss@example.com",
    "ATTENDEE;CN=小红:mailto:xh@example.com",
    "X-CUSTOM-FLAG:keepme",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const it = parse(raw);
  it.summary = "改了标题";
  const out = ics.itemToEditedICS(it);
  check("VTIMEZONE 保留", out.includes("BEGIN:VTIMEZONE") && out.includes("TZID:Asia/Shanghai"), out.slice(0, 200));
  check("ORGANIZER 保留", out.includes("ORGANIZER:mailto:boss@example.com"));
  check("ATTENDEE 保留", out.includes("ATTENDEE;CN=小红:mailto:xh@example.com"));
  check("X- 扩展属性保留", out.includes("X-CUSTOM-FLAG:keepme"));
}

{
  // 同一份资源里两个 VTODO：编辑一个，另一个必须原样不动
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:multi-a@test",
    "SUMMARY:甲",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    "END:VTODO",
    "BEGIN:VTODO",
    "UID:multi-b@test",
    "SUMMARY:乙",
    "DTSTART:20261022T090000",
    "DUE:20261023T090000",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const items = ics.itemsFromICS(raw, "http://cal/", "http://cal/multi.ics", '"e1"');
  check("一份资源解析出 2 个条目", items.length === 2, "实际 " + items.length);
  const b = items.find((i) => i.uid === "multi-b@test");
  b.summary = "乙改过了";
  const out = ics.itemToEditedICS(b);
  check("同资源的另一条组件原样保留", out.includes("SUMMARY:甲"));
  check("目标组件真的改了", out.includes("SUMMARY:乙改过了"));
  check("两条组件都还在（没被压成一条）", (out.match(/BEGIN:VTODO/g) || []).length === 2);
}

{
  // 周期性例外：与主条目 UID 相同，只能靠 RECURRENCE-ID 区分。
  // 只比 UID 会把例外的改动写进主条目 —— 两头都错。
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:rec-1@test",
    "SUMMARY:主条目",
    "DTSTART:20261020T090000",
    "DUE:20261021T090000",
    "RRULE:FREQ=DAILY;COUNT=3",
    `ATTACH;FMTTYPE=application/pdf:${URL_PDF}`,
    "END:VTODO",
    "BEGIN:VTODO",
    "UID:rec-1@test",
    "RECURRENCE-ID:20261021T090000",
    "SUMMARY:例外",
    "DTSTART:20261021T100000",
    "DUE:20261022T100000",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  const items = ics.itemsFromICS(raw, "http://cal/", "http://cal/rec.ics", '"e1"');
  check("周期性资源解析出主条目 + 例外", items.length === 2, "实际 " + items.length);
  const ov = items.find((i) => i.recurId);
  check("例外条目带 recurId", !!ov && ov.recurId === "2026-10-21T09:00:00", JSON.stringify(ov && ov.recurId));
  ov.summary = "例外改过了";
  const out = ics.itemToEditedICS(ov);
  check("例外条目改的是例外自己", out.includes("SUMMARY:例外改过了"));
  check("主条目标题没被顺手改掉", out.includes("SUMMARY:主条目"), out);
  // 这条是真正钉死「写对组件」的判据：例外条目自己没有 RRULE，
  // 一旦把改动写进主条目（只比 UID 的写法就会这样），主条目的 RRULE 随之消失。
  check("主条目的 RRULE 还在（没被例外条目覆盖掉）", out.includes("RRULE:FREQ=DAILY;COUNT=3"), out);
  check("主条目的附件还在", out.includes(URL_PDF));
  // 只断言「属性还在」，不绑定时区换算后的具体值：rebuildComponent 会把本地墙上时间
  // 统一转成 UTC（既有行为，DTSTART/DUE/RECURRENCE-ID 一视同仁），
  // 在东八区会跑成 20261021T010000Z，绑死原值会误红。
  check("例外组件的 RECURRENCE-ID 还在", /RECURRENCE-ID:2026\d{4}T\d{6}Z?/.test(out), out);
}

{
  // 原文里找不到目标组件 → **抛错**，绝不能静默整份重拼（那正是数据丢失的形态）
  const it = parse(makeIcs());
  it.raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:完全是另一个@test",
    "SUMMARY:别人",
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");
  let threw = "";
  try {
    ics.itemToEditedICS(it);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("原文里没有目标组件时抛错（而不是整份重拼丢数据）", /找不到/.test(threw), "实际: " + threw);
  check("报错信息带 UID，便于定位", threw.includes("att-1@test"));
}

{
  // 源码防漂移：itemsFromICS 必须把原文传下去（这是本次事故的直接根因）
  const icsSrc = read("src/core/ics.ts");
  const fn = /export function itemsFromICS\(([\s\S]*?)\n\}/.exec(icsSrc);
  check("能定位 itemsFromICS", !!fn);
  check(
    "itemsFromICS 把 text 传给 itemFromComponent",
    /itemFromComponent\(comp,\s*"(event|todo)",\s*calendarUrl,\s*href,\s*etag,\s*text\)/.test(fn?.[1] || ""),
    "少传一个参数 → 拉回来的条目全都没有 raw → 每次编辑都整份重拼"
  );
  check("itemFromComponent 收 raw 参数", /etag\?: string,\s*raw\?: string/.test(icsSrc));
  check(
    "CalItem 字面量里赋了 raw",
    /const item: CalItem = \{[\s\S]*?\braw,\n/.test(icsSrc),
    "光传参数不赋值等于没传"
  );
  // mergeServerItems 的自愈：老数据没有 raw 时，服务端内容没变也要补上
  const storeSrc = read("src/core/store.ts");
  check(
    "mergeServerItems 有 adoptRaw 自愈（老数据补原文）",
    /const adoptRaw = \(cur: CalItem, inc: CalItem\)/.test(storeSrc) && /adoptRaw\(cur, inc\)/.test(storeSrc),
    "不给 2026-10-14 之前的老条目补 raw，它们的下一次编辑照样毁数据"
  );
  // ⚠️ 判据是 attKey(...) 而不是裸的 JSON.stringify(x || null)：删光附件时编辑器写 []、
  // 解析器无 ATTACH 时留 undefined，不归一化就会把「删完附件」的条目每轮都判成有变化。
  check(
    "附件纳入「有无变化」判据（且空≡没有）",
    /attKey\(cur\.attachments\) === attKey\(inc\.attachments\)/.test(storeSrc),
    "裸比 [] 与 undefined 会让删完附件的条目每轮同步都被拉回一次（自环回显的变体）"
  );
  check(
    "pushDirty 有原文才走增量改写",
    /const ics = item\.raw \? itemToEditedICS\(item\) : itemToNewICS\(item\);/.test(read("src/core/sync.ts"))
  );
}

{
  // 行为用例：mergeServerItems 的自愈必须真的生效（不是只有源码文本）
  const s = new storeMod.CalStore({ loadData: async () => ({}), saveData: async () => {} });
  const serverItem = parse(makeIcs());
  // 老数据：本地条目与服务端内容一致，但**没有 raw**
  const legacy = { ...serverItem };
  delete legacy.raw;
  s.put(legacy);
  const r1 = s.mergeServerItems([serverItem], []);
  const key = storeMod.keyOf(serverItem);
  check("老条目被判定为无变化（etag 相同）", r1.applied === 0, JSON.stringify(r1));
  check(
    "无变化时也补上了 raw（自愈生效）",
    typeof s.get(key)?.raw === "string",
    "etag 相同会 continue，不补 raw 的话老条目的下次编辑照样毁数据"
  );
  // 补上之后再编辑，附件必须还在
  const healed = s.get(key);
  healed.summary = "自愈后编辑";
  const lines = attachLines(ics.itemToEditedICS(healed));
  check("自愈后编辑，附件仍在", lines.some((l) => l.includes(URL_PDF)), lines.join(" | "));
  check("自愈后编辑，二进制件仍在", lines.some((l) => l.includes("VALUE=BINARY") && l.includes(BIN_B64)));
  // 自愈不能虚增「拉取 N 条」
  check("自愈不计入拉取数、但标记 changed 让它落盘", r1.applied === 0 && r1.changed === true, JSON.stringify(r1));
}

console.log("\n附件体积硬上限（设置项：附件大小限制 / 单个ICS文件限制）");

{
  const icsSrc = read("src/core/ics.ts");
  const editorSrc = read("src/ui/editor.ts");
  const caldavSrc = read("src/core/caldav.ts");
  const syncSrc = read("src/core/sync.ts");
  const settingsSrc = read("src/ui/settings-dialog.ts");
  const typesSrc = read("src/core/types.ts");

  check(
    "默认单文件上限 5MB（ics.ts 导出 ATTACH_SIZE_MAX_MB）",
    /export const ATTACH_SIZE_MAX_MB = 5/.test(icsSrc),
    "Radicale 默认 max_resource_size=10MB，base64 涨 1/3，5MB 文件 → 6.7MB ICS 才安全"
  );
  check(
    "默认整份 ICS 上限 10MB（ics.ts 导出 ICS_SIZE_MAX_MB）",
    /export const ICS_SIZE_MAX_MB = 10/.test(icsSrc),
    "单文件上限挡不住多个 4MB 凑 12MB；默认值对齐 Radicale 的 max_resource_size"
  );
  check(
    "设置项有两个上限字段（CalSettings + DEFAULT_SETTINGS）",
    /attachSizeMaxMB\?: number/.test(typesSrc) &&
      /icsSizeMaxMB\?: number/.test(typesSrc) &&
      /attachSizeMaxMB: 5/.test(typesSrc) &&
      /icsSizeMaxMB: 10/.test(typesSrc),
    "缺字段 → 设置弹窗存不进去、解析器取不到值"
  );
  check(
    "解析器按设置取值、非法回退默认",
    /export function attachSizeMaxBytes/.test(icsSrc) && /export function icsSizeMaxBytes/.test(icsSrc) && /export function mbToBytes/.test(icsSrc),
    "老数据没有这两个字段时必须回退默认，不能 NaN"
  );
  check(
    "挑选时超过单文件上限直接拒绝（不给确认机会，上限取自设置）",
    /const maxBytes = attachSizeMaxBytes\(ctx\.store\.settings\)[\s\S]{0,200}?if \(file\.size > maxBytes\)[\s\S]{0,500}?return;/.test(editorSrc),
    "只警告不硬拦 → 用户点一下确认就造出一个永远 413 的待办（2026-10-15 实测）"
  );
  check(
    "保存前按真实序列化结果卡总账（itemToEditedICS，上限取自设置）",
    /const icsDraft = itemToEditedICS\(draftForSize\);[\s\S]{0,700}?const icsMax = icsSizeMaxBytes\(ctx\.store\.settings\)[\s\S]{0,200}?if \(icsBytes > icsMax\)/.test(editorSrc),
    "不卡总账 → 多个中等附件叠加照样超限，保存成功但同步永远失败"
  );
  check(
    "二进制附件的原名写进 ICS（X-FILENAME，裸写优先只编码结构危险字符）",
    /"X-FILENAME": icsFilenameParam\(a\.name\)/.test(icsSrc) &&
      /function icsFilenameParam[\s\S]{0,200}?replace\(\/\[%\/,:;"\]\/g/.test(icsSrc) &&
      /function safeDecodeFilename[\s\S]{0,120}?try \{[\s\S]{0,80}?decodeURIComponent/.test(icsSrc),
    "只写 FMTTYPE 不写名字 → 服务器上的 ICS 是无名氏，换设备重拉退化成「附件.jpg」（2026-10-19 雄哥发现）；整体 encodeURIComponent 则 emClient 等外部客户端显示 %E5%91%A8… 乱码（雄哥实测）——必须裸写优先；解析端无脑 decode 会被外部裸 % 值炸掉，必须 try/catch"
  );
  check(
    "putItem 收设置里的 ICS 上限参数（icsSizeMaxMB）",
    /auth: DavAuth,\s*icsSizeMaxMB\?: number/.test(caldavSrc) && /const maxBytes = mbToBytes\(maxMB, ICS_SIZE_MAX_MB\)/.test(caldavSrc),
    "不传参 → 设置改了不生效，还是按默认值卡"
  );
  check(
    "sync.ts 把 settings.icsSizeMaxMB 传进 putItem",
    /putItem\(item, ics, this\.channel\(\), this\.auth\(\), this\.store\.settings\.icsSizeMaxMB\)/.test(syncSrc),
    "两个调用点（新建/编辑 + 412 覆盖）都要传，漏一个那条路径就失控"
  );
  check(
    "设置弹窗有这两个输入框且保存时接线",
    /data-s="attachMax"/.test(settingsSrc) &&
      /data-s="icsMax"/.test(settingsSrc) &&
      /s\.attachSizeMaxMB = Math\.max\(1/.test(settingsSrc) &&
      /s\.icsSizeMaxMB = Math\.max\(1/.test(settingsSrc),
    "只加 UI 不保存 ＝ 白改"
  );
  check(
    "413 文案说「服务器/反向代理的上限」，不再拿设置值冒充服务器默认",
    /服务器（或其反向代理）对单条日历数据有上限/.test(caldavSrc) &&
      !/CalDAV服务器默认 \$\{maxMB\}MB/.test(caldavSrc),
    "2026-10-18 雄哥的 Baïkal 前有 nginx（默认 client_max_body_size 1MB），413 来自反代——" +
      "老文案说「CalDAV服务器默认 10MB」把用户往错方向引"
  );
}

console.log("\n上传超时：按 body 大小放宽（2026-10-15 上传超时实测）");

{
  const httpSrc = read("src/core/http.ts");
  const caldavSrc = read("src/core/caldav.ts");

  check(
    "http.ts 导出 uploadTimeoutMs（按 body 字节数算超时预算）",
    /export function uploadTimeoutMs/.test(httpSrc),
    "固定 30s：5MB 附件 → ICS 约 7MB，家庭宽带上行传完要一分多钟，必然超时"
  );
  // putItem 的调用点单独抠出来看：dav()/DELETE 那些小 body 仍然固定 30s 是对的，
  // 不能一刀切断言全文件没有 30000。
  const putFn = /export async function putItem\([\s\S]*?\n\}/.exec(caldavSrc);
  check("能定位 putItem", !!putFn);
  check(
    "putItem 按 ICS 实际字节数传超时（调用点不再写死 30000）",
    !!putFn && /timeoutMs: uploadTimeoutMs\(icsBytes\)/.test(putFn[0]) && !/30000/.test(putFn[0]),
    "icsBytes 上面已经用 TextEncoder 算过，直接复用；写死 30000 就是这次的 bug"
  );
  check(
    "httpRequest 对没显式给超时的带 body 请求自动套用",
    /full\.timeoutMs === undefined[\s\S]{0,240}?uploadTimeoutMs\(/.test(httpSrc),
    "防御其它上传路径：以后新加的 PUT 不传 timeoutMs 也不会被 30s 卡死"
  );
  check(
    "超时预算封顶 10 分钟（2026-10-16 雄哥要求预算翻倍，封顶同步翻倍）",
    /CAP_MS = 600000/.test(httpSrc) && /Math\.min\(CAP_MS/.test(httpSrc),
    "再慢就是真的传不动，不该让用户干等"
  );
  // 2026-10-16 雄哥实测：请求超时了，同步按钮还在转 —— viaProxy 的 fetch 没有
  // abort，超时全押在内核 forwardProxy 的 timeout 字段上（黑盒，NAS 卡死时不可靠），
  // 于是 syncAll 永不返回、按钮的 .finally() 永远不跑。
  const proxyFn = /async function viaProxy\([\s\S]*?\n\}/.exec(httpSrc);
  check("能定位 viaProxy", !!proxyFn);
  check(
    "viaProxy 的 fetch 带 abort 信号（客户端硬超时，不迷信内核 timeout 字段）",
    !!proxyFn && /signal: ctrl\.signal/.test(proxyFn[0]) && /setTimeout\(\(\) => ctrl\.abort\(\)/.test(proxyFn[0]),
    "没有这层 abort，NAS 只接受 TCP 不响应 HTTP 时同步按钮会转到天荒地老"
  );
  check(
    "auto 回退直连按剩余预算（不是每条通道再等一份全额）",
    /const remaining = \(\)/.test(httpSrc) && /viaDirect\(url, \{ \.\.\.o, timeoutMs: remaining\(\) \}\)/.test(httpSrc),
    "7MB ICS 若两段各等 142s，要将近 5 分钟才停得下来"
  );
}

console.log("\n保存/删除不再阻塞关窗 + 推送队列（2026-10-15 窗口假死回归）");

{
  const editorSrc = read("src/ui/editor.ts");
  const syncSrc = read("src/core/sync.ts");

  // 保存 handler 整体抠出来（到 `\n  });` 为止，2 空格缩进）
  const saveFn = /el\.querySelector\('\[data-action="save"\]'\)\?\.addEventListener\("click", \(\) => \{[\s\S]*?\n  \}\);/.exec(editorSrc);
  check("能定位保存按钮 handler", !!saveFn);
  check(
    "保存：上传 void 化（不 await 网络往返）",
    !!saveFn && /void \(isNew \? ctx\.sync\.createItem\(saved\) : ctx\.sync\.updateItem\(saved\)\)/.test(saveFn[0]),
    "await 上传成功才关窗 → 服务端卡死时窗口假死一分钟以上（2026-10-15 实测）"
  );
  check(
    "保存：dialog.destroy() 与上传解耦，且没有 .then(() => dialog.destroy()) 复活",
    !!saveFn && /dialog\.destroy\(\);\s*\} catch/.test(saveFn[0]) && !/\.then\(\s*\(\)\s*=>\s*dialog\.destroy\(\)/.test(saveFn[0]),
    "上传结果走页脚状态条（lastNote/lastError），不阻塞编辑窗"
  );
  // 删除 handler 同理（4 空格缩进收尾）
  const delFn = /delBtn\.addEventListener\("click", async \(\) => \{[\s\S]*?\n    \}\);/.exec(editorSrc);
  check("能定位删除按钮 handler", !!delFn);
  check(
    "删除：同样 void 化并立即关窗（不冻在「删除中…」）",
    !!delFn && /void ctx\.sync\.removeItem\(it\)/.test(delFn[0]) && !/await ctx\.sync\.removeItem\(it\)/.test(delFn[0]),
    "删除也是先本地标记、后台上传，服务端失败留待下次同步重试"
  );

  // sync.ts：先落盘再推 + 推送队列
  check(
    "createItem/updateItem/removeItem 先 persist 再推（上传排队时改动已落盘）",
    (syncSrc.match(/await this\.store\.persist\(\);/g) || []).length >= 3,
    "少于 3 处说明有入口漏了先落盘 —— 关窗后改动只在内存里，重启就丢"
  );
  check(
    "推送队列存在（pushChain + enqueuePush）",
    /private pushChain: Promise<void> = Promise\.resolve\(\);/.test(syncSrc) && /private enqueuePush/.test(syncSrc),
    "保存不阻塞后连点保存会并发推同一条目 → 第二条拿旧 etag → 假 412 → 丢弃本地改动"
  );
  check(
    "create/update/remove 三个入口都走 pushAndPersist（队列化）",
    (syncSrc.match(/await this\.pushAndPersist\(\);/g) || []).length >= 3
  );
  check(
    "syncAll 的第一步推送也走队列（enqueuePush(() => this.pushDirty(report))）",
    /await this\.enqueuePush\(\(\) => this\.pushDirty\(report\)\);/.test(syncSrc),
    "手动同步与「保存即推」的后台推送并发，同样会假 412"
  );
}

(async () => {
  // 行为用例：putItem 的体积闸门必须认设置里的上限，且**不进网络**。
  // （守卫若被摘掉，这些用例会真的发请求 → 挂成网络错误，正好抓住回归。）
  const caldav = require(path.join(outDir, "caldav.js"));
  const item = { uid: "u@t", kind: "todo", href: "http://127.0.0.1:1/none.ics", summary: "大附件待办" };
  const auth = { username: "u", password: "p" };
  const tryPut = (ics, maxMB) =>
    caldav.putItem(item, ics, "direct", auth, maxMB).then(
      () => null,
      (e) => e
    );

  // ① 默认上限 10MB：11MB ICS 必须被拒
  let err = await tryPut("X".repeat(11 * 1024 * 1024), undefined);
  check("默认上限 10MB：11MB ICS 被拒", !!err && err.status === 413, "status=" + (err && err.status));
  check(
    "拒收文案说清原因和动作（超的是本地设置上限）",
    err && /内容过大/.test(err.message) && /超过「单个ICS文件限制」/.test(err.message) && /外链/.test(err.message),
    err && err.message
  );
  const t0 = Date.now();
  await tryPut("X".repeat(11 * 1024 * 1024), undefined);
  check("秒拒（没真发请求）", Date.now() - t0 < 1000, `耗时 ${Date.now() - t0}ms，像是发了请求`);

  // ② 设置调小到 1MB：2MB ICS 也要被拒，文案数字跟着变
  err = await tryPut("X".repeat(2 * 1024 * 1024), 1);
  check("设置上限 1MB 生效（2MB ICS 被拒）", !!err && err.status === 413, "status=" + (err && err.status));
  check("文案里的数字取设置值（1MB）", err && /超过「单个ICS文件限制」1MB/.test(err.message), err && err.message);

  // ③ 设置调大到 20MB：2MB ICS 必须放行（守卫不能锁死默认值）
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 201, headers: { forEach: () => {} }, text: async () => "" });
  let okErr = await tryPut("X".repeat(2 * 1024 * 1024), 20);
  check("设置上限 20MB 生效（2MB ICS 放行）", !okErr, okErr && okErr.message);

  // ④ 服务端真返 413 时，文案指向「服务器/反向代理上限」并给常见值参考
  globalThis.fetch = async () => ({ status: 413, headers: { forEach: () => {} }, text: async () => "" });
  err = await tryPut("X".repeat(1024), 10);
  check(
    "服务端 413 → 可操作文案（nginx 反代常见 1MB）",
    err && err.status === 413 && /服务器（或其反向代理）/.test(err.message) && /nginx 反代常见默认仅 1MB/.test(err.message) && /外链/.test(err.message),
    err && err.message
  );
  globalThis.fetch = prevFetch;

  // ⑤ 解析器行为：缺省/非法值回退默认，合法值按设置
  const MB = 1024 * 1024;
  check("attachSizeMaxBytes 缺省回退 5MB", ics.attachSizeMaxBytes(undefined) === 5 * MB && ics.attachSizeMaxBytes(null) === 5 * MB);
  check("attachSizeMaxBytes 按设置取值", ics.attachSizeMaxBytes({ attachSizeMaxMB: 2 }) === 2 * MB);
  check("attachSizeMaxBytes 非法值回退默认", ics.attachSizeMaxBytes({ attachSizeMaxMB: 0 }) === 5 * MB && ics.attachSizeMaxBytes({ attachSizeMaxMB: -3 }) === 5 * MB);
  check("icsSizeMaxBytes 缺省回退 10MB", ics.icsSizeMaxBytes(undefined) === 10 * MB);
  check("icsSizeMaxBytes 按设置取值", ics.icsSizeMaxBytes({ icsSizeMaxMB: 20 }) === 20 * MB);

  // ⑥ 上传超时按 body 放宽。2026-10-15 实测：5.03MB 附件 → ICS 约 7MB，
  //    auto 通道代理/直连各 30s 全超时，条目永远 dirty、每轮同步反复重试。
  //    2026-10-16 雄哥实测 NAS 上行比估速还慢，预算整体翻倍（60s 基线 +
  //    32KB/s 折算 + 10 分钟封顶）。
  const http = require(path.join(outDir, "http.js"));
  check("空/非法 body → 默认 60s", http.uploadTimeoutMs(0) === 60000 && http.uploadTimeoutMs(NaN) === 60000 && http.uploadTimeoutMs(-1) === 60000);
  check("小 body（1KB）≈ 60s（不放大）", http.uploadTimeoutMs(1024) === 60032, String(http.uploadTimeoutMs(1024)));
  check("7MB ICS → 284s（60s 基线 + 按 32KB/s 折算）", http.uploadTimeoutMs(7 * 1024 * 1024) === 284000, String(http.uploadTimeoutMs(7 * 1024 * 1024)));
  check("100MB → 封顶 10 分钟", http.uploadTimeoutMs(100 * 1024 * 1024) === 600000, String(http.uploadTimeoutMs(100 * 1024 * 1024)));
  // putItem 真的把放宽后的超时传进了请求：拦内核代理的 body，
  // forwardProxy 的 timeout 字段就是证据（毫秒，见 siyuan-plugin-http-channel-debug 契约表）
  let proxyBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("forwardProxy")) proxyBody = JSON.parse(init.body);
    return {
      status: 201,
      headers: { forEach: () => {} },
      text: async () => "",
      json: async () => ({ code: 0, data: { status: 201 } })
    };
  };
  const bigIcs = "X".repeat(7 * 1024 * 1024);
  const putBig = await caldav
    .putItem({ uid: "u@t", kind: "todo", href: "http://127.0.0.1:1/none.ics", summary: "大附件待办" }, bigIcs, "proxy", auth, 20)
    .then(
      () => null,
      (e) => e
    );
  check("7MB ICS 走内核代理上传成功（守卫放行）", !putBig, putBig && putBig.message);
  check(
    "putItem 把放宽后的超时传进内核代理（7MB → 284000ms）",
    !!proxyBody && proxyBody.timeout === 284000,
    proxyBody ? "timeout=" + proxyBody.timeout : "没抓到代理请求体"
  );
  globalThis.fetch = prevFetch;

  // ⑦ 2026-10-16 雄哥实测：请求超时了，同步按钮还在转。根因是 viaProxy 的
  //    fetch 没有 abort，超时全押在内核 forwardProxy 的 timeout 字段上（黑盒，
  //    NAS 只接受 TCP 不响应 HTTP 时不可靠）→ syncAll 永不返回 → 按钮的
  //    .finally() 永远不跑。这里复现「代理挂死」：fetch 永不 resolve，
  //    到预算必须主动 abort。带 5s 看门狗——bug 状态下要 FAIL，不能把测试卡死。
  {
    const prevFetch2 = globalThis.fetch;
    const t0 = Date.now();
    globalThis.fetch = (_url, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    const hung = await Promise.race([
      http
        .httpRequest("http://127.0.0.1:1/hang.ics", { method: "PUT", body: "X".repeat(2048), timeoutMs: 300 }, "proxy", auth)
        .then(
          () => null,
          (e) => e
        ),
      new Promise((r) => setTimeout(() => r("HUNG"), 5000))
    ]);
    check(
      "内核代理挂死时客户端 abort 生效（不再无限等）",
      hung !== "HUNG" && !!hung && /abort/i.test(hung.message),
      hung === "HUNG" ? "5 秒还在等 = 回到无限挂死，同步按钮永远停不下来" : hung && hung.message
    );
    check("abort 按显式预算触发（≈300ms，不是默认 30s）", Date.now() - t0 < 5000, `耗时 ${Date.now() - t0}ms`);
    globalThis.fetch = prevFetch2;
  }

  {
    // iCloud 托管附件（RFC 8607）：服务端 ICS 里 ATTACH 带 MANAGED-ID 参数，
    //    文件在服务端托管存储里（不在 ICS 内）。解析必须收 managedId，
    //    序列化必须原样写回（带引号）——漏一个就是编辑一次把托管引用抹掉。
    const icsM = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//test//EN",
      "BEGIN:VTODO",
      "UID:icl-managed@test",
      "SUMMARY:托管附件解析",
      "DTSTAMP:20260101T000000Z",
      "ATTACH;MANAGED-ID=\"abc-123\";FMTTYPE=image/jpeg:https://p12-caldav.icloud.com/xxx/attach/abc-123/x.jpg",
      "END:VTODO",
      "END:VCALENDAR"
    ].join("\r\n");
    const itM = ics.itemsFromICS(icsM, "https://caldav.icloud.com/1/", "https://caldav.icloud.com/1/x.ics", "e1")[0];
    check(
      "托管附件：解析出 managedId",
      itM.attachments?.[0]?.managedId === "abc-123",
      JSON.stringify(itM.attachments)
    );
    const backM = ics.itemToEditedICS(itM);
    check(
      "序列化写回 MANAGED-ID（带引号，RFC 5545 参数值规则）",
      /ATTACH;MANAGED-ID="abc-123"(;FMTTYPE=[^:\r\n]*)?(;FILENAME=[^:\r\n]*)?:https:\/\/p12-caldav\.icloud\.com/.test(backM.replace(/\r\n /g, "")),
      backM.split(/\r?\n/).find((l) => l.startsWith("ATTACH")) || "没有 ATTACH 行"
    );
  }

  {
    // ⑤ 托管附件文件名往返（2026-10-23 雄哥实测：托管分支原先不写文件名参数，
    //    服务端 ICS 是无名氏——换设备/本地数据丢失后重拉只能按 URI 末段的签名
    //    token 推乱名）。形态与 iCloud 自身写出的一致：ASCII 裸写、非 ASCII 走
    //    UTF-8''+percent；recoverServerFilename 还原。
    const icsFn = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//test//EN",
      "BEGIN:VTODO",
      "UID:icl-fn@test",
      "SUMMARY:托管附件文件名往返",
      "DTSTAMP:20260101T000000Z",
      "ATTACH;FMTTYPE=image/jpeg;FILENAME=UTF-8''%E5%8D%97%E5%9D%9E%E5%8F%A4%E9%81%93.jpg;MANAGED-ID=fn-1:https://gateway.icloud.com/1/attach/fn-1/x.jpg",
      "END:VTODO",
      "END:VCALENDAR"
    ].join("\r\n");
    const itF = ics.itemsFromICS(icsFn, "https://caldav.icloud.com/1/", "https://caldav.icloud.com/1/x.ics", "e1")[0];
    check(
      "解析：FILENAME 参数还原中文原名",
      itF.attachments?.[0]?.name === "南坞古道.jpg",
      JSON.stringify(itF.attachments)
    );
    const backF = ics.itemToEditedICS(itF).replace(/\r\n /g, "");
    check(
      "序列化：托管分支写 FILENAME（非 ASCII 走 UTF-8'' 形态，与 iCloud 自身一致）",
      /FILENAME=UTF-8''%E5%8D%97%E5%9D%9E%E5%8F%A4%E9%81%93.jpg/.test(backF),
      backF.split(/\r?\n/).find((l) => l.startsWith("ATTACH")) || "没有 ATTACH 行"
    );
    const itF2 = ics.itemsFromICS(ics.itemToEditedICS(itF), "https://caldav.icloud.com/1/", "https://caldav.icloud.com/1/x.ics", "e1")[0];
    check(
      "往返：序列化后再解析，名字不变",
      itF2.attachments?.[0]?.name === "南坞古道.jpg" && itF2.attachments?.[0]?.managedId === "fn-1",
      JSON.stringify(itF2.attachments)
    );
    check(
      "helper：ASCII 名裸写、非 ASCII 走 UTF-8''、控制字符剔除、结构字符编码",
      ics.managedAttachFilenameParam("photo.jpg") === "photo.jpg" &&
        ics.managedAttachFilenameParam("南坞古道.jpg") === "UTF-8''%E5%8D%97%E5%9D%9E%E5%8F%A4%E9%81%93.jpg" &&
        ics.managedAttachFilenameParam("a\u0007b.jpg") === "ab.jpg" &&
        ics.managedAttachFilenameParam("a,b;c.jpg") === "UTF-8''a%2Cb%3Bc.jpg",
      ""
    );

    // ⑤b 结构字符附件名（`, ; : " % /`）在 Windows 文件名里合法，裸写进 ATTACH
    //     行会撕碎结构（第一个 : 之后全被当 URI、; 拆出假参数），服务端直接 PUT 400。
    //     必须走 UTF-8'' 形态且往返无损。
    const icsFn2 = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//test//EN",
      "BEGIN:VTODO",
      "UID:icl-fn2@test",
      "SUMMARY:结构字符附件名往返",
      "DTSTAMP:20260101T000000Z",
      "ATTACH;FMTTYPE=image/jpeg;FILENAME=UTF-8''a%2Cb%3Bc.jpg;MANAGED-ID=fn-2:https://gateway.icloud.com/1/attach/fn-2/x.jpg",
      "END:VTODO",
      "END:VCALENDAR"
    ].join("\r\n");
    const itG = ics.itemsFromICS(icsFn2, "https://caldav.icloud.com/1/", "https://caldav.icloud.com/1/x.ics", "e1")[0];
    check(
      "解析：结构字符名从 UTF-8'' 形态还原",
      itG.attachments?.[0]?.name === "a,b;c.jpg",
      JSON.stringify(itG.attachments)
    );
    const backG = ics.itemToEditedICS(itG).replace(/\r\n /g, "");
    check(
      "序列化：结构字符名仍走 UTF-8''（不裸写撕碎 ATTACH 行）",
      /FILENAME=UTF-8''a%2Cb%3Bc\.jpg/.test(backG),
      backG.split(/\r?\n/).find((l) => l.startsWith("ATTACH")) || "没有 ATTACH 行"
    );
    const itG2 = ics.itemsFromICS(ics.itemToEditedICS(itG), "https://caldav.icloud.com/1/", "https://caldav.icloud.com/1/x.ics", "e1")[0];
    check(
      "往返：结构字符名序列化后再解析不变",
      itG2.attachments?.[0]?.name === "a,b;c.jpg" && itG2.attachments?.[0]?.managedId === "fn-2",
      JSON.stringify(itG2.attachments)
    );
  }

  console.log(failed === 0 ? "\n✓ 待办附件回归测试通过" : `\n✗ ${failed} 个用例失败`);
  process.exit(failed === 0 ? 0 : 1);
})();
