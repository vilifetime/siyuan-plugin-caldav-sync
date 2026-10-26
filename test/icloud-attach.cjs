/**
 * iCloud 托管附件上传回归（2026-10-23 雄哥实测报错驱动，与 Obsidian 同构）
 *
 * 背景：Obsidian 桌面端上传中文名附件报
 *   `Invalid character in header content ["Content-Disposition"]`
 * ——HTTP 头值只收 Latin-1 域字符（\t \x20-\x7e \x80-\xff），中文裸写进
 * Content-Disposition，Node http 直接抛错、请求都发不出去。修法：ASCII 名走
 * RFC 8607 标准 `filename="x"`，非 ASCII 名走 RFC 5987 `filename*=UTF-8''%E5…`。
 * 思源侧走内核代理（JSON 载荷）本来不校验头字符集，但保持两端同一形态：
 * 服务端存的 FILENAME 两种坏形态（UTF-8'' 字面量 / Latin-1 双重编码）两端都能还原。
 *
 * 覆盖范围：
 *  1. Content-Disposition 头值**恒纯 ASCII**（两种名字形态都查）；
 *  2. 动作名是 attachment-add 不是 add-attachment；
 *  3. Apple 文件名禁令字符（\ / : * ? " |）先 sanitize；
 *  4. 二进制 body 原样透传、Prefer 头仍在；
 *  5. iCloud 形态（200 空 body）→ 回 GET 认领托管信息 + 新 etag：**POST 响应 location 头
 *     优先认领**（2026-10-23 00:55 真机 dump：服务端积了 3 条历史托管附件时扣减法歧义，
 *     上传成功却报「无法确认」。⚠️ 01:23 续坑：location 与 ICS 里本次 ATTACH 的 URI
 *     **不是全等——location 缺尾部 token 段**，按同基名（互为前缀）匹配；⑤d 用 01:23
 *     积了 9 条那份 dump 原样回放），location 缺失才走 knownManagedIds 扣减法
 *     （恰好一条未知，多条不猜）；
 *  6. recoverServerFilename 双形态还原。
 *
 * 网络层怎么桩：编译产物里 caldav.js 走 `(0, http_1.httpRequest)(...)`（调用时
 * 才取属性），直接给 http.js 的 exports 对象换方法即可，无需动传输层内部。
 *
 * 用法：node test/icloud-attach.cjs
 */
const assert = require("assert");
const { execSync } = require("child_process");
const fs = require("fs");
const { rmrf } = require("./fsx.cjs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
// 本仓库 CRLF：读源码先统一成 LF
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// 与 todo-attach.cjs 同一套路：tsc 编译到临时目录再引
const outDir = path.join(ROOT, ".test-icloud");
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts src/core/store.ts src/core/secret.ts ` +
    `--outDir .test-icloud --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: ROOT, stdio: "inherit" }
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));

const ics = require(path.join(outDir, "ics.js"));
const http = require(path.join(outDir, "http.js"));
const caldav = require(path.join(outDir, "caldav.js"));

// 临时目录随进程退出清掉
process.on("exit", () => {
  try {
    rmrf(outDir);
  } catch {
    /* 清理失败不影响测试结论 */
  }
});

let failed = 0;
function check(name, cond, hint) {
  if (cond) console.log("  [PASS] " + name);
  else {
    console.log("  [FAIL] " + name + (hint ? " —— " + hint : ""));
    failed++;
  }
}

/** 桩掉网络层：记录每次调用；POST 恒回 200 空 body（iCloud 形态），GET 回捞给 getIcs */
const calls = [];
let getIcs = "";
/** POST 响应的 location 头值（iCloud 给附件规范 URI；空串＝没给，走扣减法） */
let postLocation = "";
/** GET 回捞响应带的 etag（默认 bf6；真机回放用例按 dump 改写） */
let getEtag = '"bf6"';
http.httpRequest = async (url, opts) => {
  calls.push({ url, opts });
  if (opts.method === "POST") {
    return {
      status: 200,
      headers: postLocation ? { location: postLocation } : {},
      body: "",
      elapsedMs: 1,
      via: "proxy"
    };
  }
  return { status: 200, headers: { etag: getEtag }, body: getIcs, elapsedMs: 1, via: "proxy" };
};

const item = {
  uid: "u@t",
  kind: "todo",
  calendarUrl: "https://caldav.icloud.com/",
  href: "https://caldav.icloud.com/xxx/u.ics",
  summary: "测试任务"
};
const auth = { username: "u@icloud.com", password: "p" };
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

const NEW_URI = "https://p42-caldav.icloud.com/xxx/attachments/9f1c2b3a";
const NEW_ID = "9f1c2b3a-1111-4222-8333-444455556666";
const MANAGED_ICS = (filename) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTODO",
    "UID:u@t",
    "SUMMARY:测试任务",
    "DTSTAMP:20260101T000000Z",
    "DUE:20270101T090000",
    `ATTACH;FMTTYPE=image/jpeg;SIZE=10;FILENAME="${filename}";MANAGED-ID=${NEW_ID}:${NEW_URI}`,
    "END:VTODO",
    "END:VCALENDAR"
  ].join("\r\n");

// ── 雄哥 2026-10-23 01:23 真机 dump 原样（D:/Temp/caldav-debug.txt，服务端积了 9 条
//    托管附件那次）：POST 响应 location 头 + GET 回捞的资源本体，一字不改。
//    关键事实：location 到文件名结尾，ICS 里本次那条（e0750f65）的 URI 尾部还多一截
//    签名 token——两者不是全等，按「逐字符相同」认领永远不命中（01:23 报错的根因）。
const REAL_LOCATION =
  "https://gateway.icloud.com/caldav/1_MTQ4NDAwOTE3OTE0ODQwMBXBZuhqlCR_nROC4lpzMWf3iX4GRqa8y8gQ78P2NXxw/attach/4_GE2DQNBQGA4TCNZZGE2DQNBQGDLWZPVAHL5PEWD4Y5UNGDQFA7425XFKC4FW2ST732LBXQY5ARVVJL6TIR74X6CFM3MGJ323QSQBDTMHETFATH3HMS6VSNMTJCHPZLYJCFWF62WARY5FBKCGBMKRF74GB4GETMBERROBGS3IY7WR2XAWSIZPSGQCRXXI7RAIRXQECQXU4CBCOVVZ2642OTQ5EMCHZNWPB6B5FRAEGB4ACPTRLXF32VOJ2KXZWTOFAEG6NGYM3YUZORPHVAWBF24S7E/UTF-8%27%27%25E5%258D%2597%25E5%259D%259E%25E5%258F%25A4%25E9%2581%2593.jpg";
const REAL_TOKEN = "/YXR0YWNoYXR0YWNoYXR0YQrTPEU73GACKG60WDsQN2A2ZX4kXNYOMf064DJ92Rcz";
const REAL_GET_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//WorkBuddy//SiYuan CalDAV//CN
BEGIN:VTODO
UID:sy-mvi7xtb1-me4pzffm
CREATED:20261021T145918Z
SUMMARY:测试任务
DTSTART:20261021T150000Z
DUE:20261021T230000Z
STATUS:NEEDS-ACTION
ATTACH;MANAGED-ID=0107af63-afdf-4cf9-8fb5-707d989118bd;FMTTYPE=image/jpeg
 :https://gateway.icloud.com/caldav/1_MTQ4NDAwOTE3OTE0ODQwMBXBZuhqlCR_nRO
 C4lpzMWf3iX4GRqa8y8gQ78P2NXxw/attach/4_GE2DQNBQGA4TCNZZGE2DQNBQGDXYZBFCJ
 GJV65HYFU7Q4N7D6VRHZEKS47FNFOANOKKYVLQK5AIDLCGEOFX7BKH2NZ7OWGFZ5ZPKR3P3V
 5N5P4C4C7WXALZL32XLS5KEVHALUNFDWRQFRX5F5QQ2WFUWLUNNZTZXSNAW2WGQ2JU6JGL62
 EJXSACO5TDA74V4LKCQYR6TSXS3JT6XDDSPQYCTTKNYML462CE4LAWQIA7NTKN4KF6F7RHRZ
 KLY66Y72SVIYZ4ZDZFMVD2SJ4SIDUE6RE/%C3%A5%C2%8D%C2%97%C3%A5%C2%9D%C2%9E%C
 3%A5%C2%8F%C2%A4%C3%A9%C2%81%C2%93.jpg/YXR0YWNoYXR0YWNoYXR0YQrTPEU73GACK
 G60WDsQN2A2ZX4kXNYOMf064DJ92Rcz
SEQUENCE:1
DTSTAMP:20261022T183234Z
LAST-MODIFIED:20261022T183234Z
ATTACH;FMTTYPE=image/jpeg;SIZE=5274516;FILENAME=UTF-8''%E5%8D%97%E5%9D%9E
 %E5%8F%A4%E9%81%93.jpg;MANAGED-ID=91e45e2f-9210-46bf-9960-66cc3eb6cdfc:h
 ttps://gateway.icloud.com/caldav/1_MTQ4NDAwOTE3OTE0ODQwMBXBZuhqlCR_nROC4
 lpzMWf3iX4GRqa8y8gQ78P2NXxw/attach/4_GE2DQNBQGA4TCNZZGE2DQNBQGDSR2XAA6LU
 RMK32UNMNQPBMZ3YEAGPQL6AMSIIBC3AFVRDTZAL7JKD7KJMISQ4BOZZC7ISWX2755Z73I5V
 XNJV3PEAFJVJKHS76IM3GAI32TWB7RFAHB5ZF7G5KA5U3545QXCO2BXQMV4KPXHSJ22IB2YY
 O2BFEU3MZWR6RA6MVU5KBCBJTL6TXHNJC5CYF2SPLTSUQ65LQ3ZHSLBSDOAROBNZ75RIYKUJ
 NCCYXSFOPF4VBCAA7MJLQHOHUFN4XT4/UTF-8%27%27%25E5%258D%2597%25E5%259D%259
 E%25E5%258F%25A4%25E9%2581%2593.jpg/YXR0YWNoYXR0YWNoYXR0YQrTPEU73GACKG60
 WDsQN2A2ZX4kXNYOMf064DJ92Rcz
ATTACH;FMTTYPE=image/jpeg;SIZE=5274516;FILENAME=UTF-8''%E5%8D%97%E5%9D%9E
 %E5%8F%A4%E9%81%93.jpg;MANAGED-ID=31ae9a49-2581-4b5c-8bdd-bac662498c5f:h
 ttps://gateway.icloud.com/caldav/1_MTQ4NDAwOTE3OTE0ODQwMBXBZuhqlCR_nROC4
 lpzMWf3iX4GRqa8y8gQ78P2NXxw/attach/4_GE2DQNBQGA4TCNZZGE2DQNBQGDWXBSQQPKE
 7623R72DVFRHQ2MR7KMAH4BMWTY36A32C6VRQKA734HLNZIRVSB5HQ4WXB6KJBZDS352WVLY
 A4CENNXUVTK7ITIAYL6TUUH54M6CQ7GU35PBGENOWNDAKNGBR2X7ZKK2MJJKESM4QFXFVCSB
 7HSLGY4PE5WCOW6RMZZVGHC65FPZFLGFCVUJHMGO5ZVBG6HPYSY3DFQQN2OLLVXSB5X5VCK4
 2Y76JTDR3P3G5CGIZ52OOG5LJYS26LY/UTF-8%27%27%25E5%258D%2597%25E5%259D%259
 E%25E5%258F%25A4%25E9%2581%2593.jpg/YXR0YWNoYXR0YWNoYXR0YQrTPEU73GACKG60
 WDsQN2A2ZX4kXNYOMf064DJ92Rcz
ATTACH;FMTTYPE=image/jpeg;SIZE=5274516;FILENAME=UTF-8''%E5%8D%97%E5%9D%9E
 %E5%8F%A4%E9%81%93.jpg;MANAGED-ID=1dbcb65a-b825-4b87-afd6-54df0cefe1c6:h
 ttps://gateway.icloud.com/caldav/1_MTQ4NDAwOTE3OTE0ODQwMBXBZuhqlCR_nROC4
 lpzMWf3iX4GRqa8y8gQ78P2NXxw/attach/4_GE2DQNBQGA4TCNZZGE2DQNBQGBI2MXXL6X3
 QBH4OPZXFV7LFENEEZ7VCA3F74KHMK4ZSWTL76IB7KU2ZSLGPY3535TVG6MTQDG4OCLWZEYJ
 HFZIV33WW2HB4ZL5LTJ42IYE5UU5EKN2Y6VQX6YVACHCNCAKFRV6PCQG7NTKFJBKNDIVK3OP
 2BPLFAI7JI55FFF3Y24QDA465KYB6NLPNJXIPX5WTA6NFOMWO2E6L5XPFIUZOMJYPQAKD4JU
 H5WDN7NRYKQTUZ4CIE3ZV6QFXYFCKKQ/UTF-8%27%27%25E5%258D%2597%25E5%259D%259
 E%25E5%258F%25A4%25E9%2581%2593.jpg/YXR0YWNoYXR0YWNoYXR0YQrTPEU73GACKG60
 WDsQN2A2ZX4kXNYOMf064DJ92Rcz
ATTACH;FMTTYPE=image/jpeg;SIZE=5274516;FILENAME=UTF-8''%E5%8D%97%E5%9D%9E
 %E5%8F%A4%E9%81%93.jpg;MANAGED-ID=2998045f-fc4f-4e07-a2bc-747e8b6dfbc6:h
 ttps://gateway.icloud.com/caldav/1_MTQ4NDAwOTE3OTE0ODQwMBXBZuhqlCR_nROC4
 lpzMWf3iX4GRqa8y8gQ78P2NXxw/attach/4_GE2DQNBQGA4TCNZZGE2DQNBQGBG4BQ2JA5Q
 Z7KCYF2BZJJPN2RJSYFCOZX44NMXF4XONSPVFGOHJEKSTZBJ7XVFG3H7DZBS73NXVZYIUM65
 XLC3CJYDL2YBBQOQUHA6XDCEUS4D4EKPTB7PCK5EYHNGFN4NPSUXKZYVADXM3CSD6UF7QWXI
 LHN7L7XMAASGVEULHTUXD2YPVQFOUC7ASH4DYRMP7H2WL6WQOVYNATX6YRVEU43YE63B6UVK
 GSZMFBA2XQUEOB57NXLNB7DI4FIEJZM/UTF-8%27%27%25E5%258D%2597%25E5%259D%259
 E%25E5%258F%25A4%25E9%2581%2593.jpg/YXR0YWNoYXR0YWNoYXR0YQrTPEU73GACKG60
 WDsQN2A2ZX4kXNYOMf064DJ92Rcz
ATTACH;FMTTYPE=image/jpeg;SIZE=5274516;FILENAME=UTF-8''%E5%8D%97%E5%9D%9E
 %E5%8F%A4%E9%81%93.jpg;MANAGED-ID=c4115119-e064-474d-97b4-d3eee3e1cd92:h
 ttps://gateway.icloud.com/caldav/1_MTQ4NDAwOTE3OTE0ODQwMBXBZuhqlCR_nROC4
 lpzMWf3iX4GRqa8y8gQ78P2NXxw/attach/4_GE2DQNBQGA4TCNZZGE2DQNBQGBZWWJTLEMU
 RIRAXJR3IKYL2M3WV75KJUKDXIEEQKJ3LIYYHOPGJJS5VR6EPFMXL5XLJNEIBHZQT5T3JSRR
 GEOQ4GVUVEPESAEB532EWUOAY5C52MPN6XOJGJPPZRKMQWMGRXESOG5YT2ZSVG47TDPAFMJN
 7GUD56TRVIUZH5PDLAHKOQ2OPNMKYT53WTDSLWQP7Q2PSA5WTGH3EK3AAFNAW4AYDGOBQEWS
 IJ2D7IBAVKYCTEY56TLCAPMOOQM2QWA/UTF-8%27%27%25E5%258D%2597%25E5%259D%259
 E%25E5%258F%25A4%25E9%2581%2593.jpg/YXR0YWNoYXR0YWNoYXR0YQrTPEU73GACKG60
 WDsQN2A2ZX4kXNYOMf064DJ92Rcz
ATTACH;FMTTYPE=image/jpeg;SIZE=5274516;FILENAME=UTF-8''%E5%8D%97%E5%9D%9E
 %E5%8F%A4%E9%81%93.jpg;MANAGED-ID=62e7b256-083c-4c1f-a460-29e12b55b780:h
 ttps://gateway.icloud.com/caldav/1_MTQ4NDAwOTE3OTE0ODQwMBXBZuhqlCR_nROC4
 lpzMWf3iX4GRqa8y8gQ78P2NXxw/attach/4_GE2DQNBQGA4TCNZZGE2DQNBQGA2CU4673ZQ
 U6LPXUBLHU63BGY6MHQDMUQBZLYXAI4TZBF2UV2B374QBLZNCWZRQFM2U2HF3M7PEJ3P3QCK
 MTN6A5FTIBGLOD7XTN4TOESS77K5KUPICNBJ5RJF74LWRYZUYMSLCUX6BZCVIYZSRFOZY4DY
 V5LYLKNY7SD4P72C2WSY52IRVXIK5DOVJEICBHH77DDBCROWBTVX2MMC2KSMH55HVAEBZBA5
 O3KM35A2T3BK2CRVKRXIKCBUC3FXEHM/UTF-8%27%27%25E5%258D%2597%25E5%259D%259
 E%25E5%258F%25A4%25E9%2581%2593.jpg/YXR0YWNoYXR0YWNoYXR0YQrTPEU73GACKG60
 WDsQN2A2ZX4kXNYOMf064DJ92Rcz
ATTACH;FMTTYPE=image/jpeg;SIZE=5274516;FILENAME=UTF-8''%E5%8D%97%E5%9D%9E
 %E5%8F%A4%E9%81%93.jpg;MANAGED-ID=38918d29-dd45-4c3c-a08f-e3db5bba4535:h
 ttps://gateway.icloud.com/caldav/1_MTQ4NDAwOTE3OTE0ODQwMBXBZuhqlCR_nROC4
 lpzMWf3iX4GRqa8y8gQ78P2NXxw/attach/4_GE2DQNBQGA4TCNZZGE2DQNBQGCN5K2NB2HT
 PWIB7PAOBP3VOE2AQZMCCKANLKM2ZIPDHP7HO6GRN62KMXOGHYOKK5L3EZP7JF733NJIKA3Z
 YX3CLZXABBY7AOINUTQRUIUUFZS2TASI2PN4DXIPXKMCJNCMG4Y37PVACEYUDK3JYK4M5TQ2
 HAMMDSNKMEZZ5GYQ7EKIA2MCP7L2D6KYUJ5HLUSWVYYUQD35P3HMW2ZN2SCTTZVKPZZM27VX
 B5PVMH5W47RPBTNXGHT6UDYRHANPEBM/UTF-8%27%27%25E5%258D%2597%25E5%259D%259
 E%25E5%258F%25A4%25E9%2581%2593.jpg/YXR0YWNoYXR0YWNoYXR0YQrTPEU73GACKG60
 WDsQN2A2ZX4kXNYOMf064DJ92Rcz
ATTACH;FMTTYPE=image/jpeg;SIZE=5274516;FILENAME=UTF-8''%E5%8D%97%E5%9D%9E
 %E5%8F%A4%E9%81%93.jpg;MANAGED-ID=e0750f65-b12d-444a-a197-0399adfe2821:h
 ttps://gateway.icloud.com/caldav/1_MTQ4NDAwOTE3OTE0ODQwMBXBZuhqlCR_nROC4
 lpzMWf3iX4GRqa8y8gQ78P2NXxw/attach/4_GE2DQNBQGA4TCNZZGE2DQNBQGDLWZPVAHL5
 PEWD4Y5UNGDQFA7425XFKC4FW2ST732LBXQY5ARVVJL6TIR74X6CFM3MGJ323QSQBDTMHETF
 ATH3HMS6VSNMTJCHPZLYJCFWF62WARY5FBKCGBMKRF74GB4GETMBERROBGS3IY7WR2XAWSIZ
 PSGQCRXXI7RAIRXQECQXU4CBCOVVZ2642OTQ5EMCHZNWPB6B5FRAEGB4ACPTRLXF32VOJ2KX
 ZWTOFAEG6NGYM3YUZORPHVAWBF24S7E/UTF-8%27%27%25E5%258D%2597%25E5%259D%259
 E%25E5%258F%25A4%25E9%2581%2593.jpg/YXR0YWNoYXR0YWNoYXR0YQrTPEU73GACKG60
 WDsQN2A2ZX4kXNYOMf064DJ92Rcz
END:VTODO
END:VCALENDAR`.replace(/\n/g, "\r\n");

const postOf = () => calls.find((c) => c.opts.method === "POST");

(async () => {
  console.log("iCloud 托管附件上传：Content-Disposition 头（2026-10-23 报错回归）");

  {
    // ① 中文名：头值必须纯 ASCII（HTTP 头只收 Latin-1 域字符）
    calls.length = 0;
    getIcs = MANAGED_ICS("UTF-8''%E5%8D%97%E5%9D%9E%E5%8F%A4%E9%81%93.jpg");
    const r = await caldav.uploadIcloudAttachment(item, bytes, "南坞古道.jpg", "image/jpeg", "proxy", auth, []);
    const post = postOf();
    const disp = post.opts.headers["Content-Disposition"];
    check("中文名：Content-Disposition 头值纯 ASCII（Latin-1 域）", !/[^\x20-\x7e]/.test(disp), disp);
    check(
      "中文名：走 filename*=UTF-8'' 形式且值正确",
      disp === "attachment; filename*=UTF-8''%E5%8D%97%E5%9D%9E%E5%8F%A4%E9%81%93.jpg",
      disp
    );
    check("POST 地址＝href + ?action=attachment-add", post.url === item.href + "?action=attachment-add", post.url);
    check("动作名不是写错的 add-attachment", !/add-attachment/.test(post.url));
    check("Prefer: return=representation 仍在", post.opts.headers["Prefer"] === "return=representation");
    check("Content-Type 用传入 mime", post.opts.headers["Content-Type"] === "image/jpeg");
    check("二进制 body 原样透传（同一个 Uint8Array）", post.opts.body === bytes);
    check("超时按字节数放宽", post.opts.timeoutMs === http.uploadTimeoutMs(bytes.length), String(post.opts.timeoutMs));
    check("200 空 body → 回 GET 资源认领", calls.some((c) => c.opts.method === "GET" && c.url === item.href));
    check("认领出托管 URI", r.uri === NEW_URI, JSON.stringify(r));
    check("认领出 MANAGED-ID（uuid；冒号后的 URI 归 value）", r.managedId === NEW_ID, r.managedId);
    check("带回 GET 拿到的新 etag（bf6，不刷新随后 PUT 必 412）", r.etag === "bf6", String(r.etag));
  }

  {
    // ② 纯 ASCII 名：RFC 8607 标准形态
    calls.length = 0;
    getIcs = MANAGED_ICS("photo.jpg");
    await caldav.uploadIcloudAttachment(item, bytes, "photo.jpg", "image/jpeg", "proxy", auth, []);
    const disp = postOf().opts.headers["Content-Disposition"];
    check("ASCII 名：filename=\"photo.jpg\"", disp === 'attachment; filename="photo.jpg"', disp);
    check("ASCII 名：同样纯 ASCII 头值", !/[^\x20-\x7e]/.test(disp));
  }

  {
    // ③ Apple 禁令字符先 sanitize；ASCII / 非 ASCII 两种形态都查
    calls.length = 0;
    getIcs = MANAGED_ICS("a_b_c_d_e_f_g.jpg");
    await caldav.uploadIcloudAttachment(item, bytes, 'a/b:c*d?e"f|g.jpg', "image/jpeg", "proxy", auth, []);
    const disp = postOf().opts.headers["Content-Disposition"];
    check("禁令字符换成 _（ASCII 名）", disp === 'attachment; filename="a_b_c_d_e_f_g.jpg"', disp);

    calls.length = 0;
    getIcs = MANAGED_ICS("UTF-8''%E5%8D%97_%E5%8C%97_%E5%B2%9B_.jpg");
    await caldav.uploadIcloudAttachment(item, bytes, "南/北:岛*.jpg", "image/jpeg", "proxy", auth, []);
    const disp2 = postOf().opts.headers["Content-Disposition"];
    check("禁令字符 + 中文：sanitize 后仍走 filename*", disp2 === "attachment; filename*=UTF-8''%E5%8D%97_%E5%8C%97_%E5%B2%9B_.jpg", disp2);
    check("头值依旧纯 ASCII", !/[^\x20-\x7e]/.test(disp2), disp2);
  }

  {
    // ④ 空名兜底 + 控制字符剔除
    check("空名 → filename=\"attachment\"", caldav.icloudContentDisposition("") === 'attachment; filename="attachment"', caldav.icloudContentDisposition(""));
    check(
      "控制字符被剔除",
      caldav.icloudContentDisposition("a\u0007b.jpg") === 'attachment; filename="ab.jpg"',
      caldav.icloudContentDisposition("a\u0007b.jpg")
    );
  }

  {
    // ⑤ knownManagedIds 扣减法：GET 里已托管的旧件不能抢领（location 缺失时的兜底路径）
    calls.length = 0;
    postLocation = "";
    const OLD_ID = "old-id-1";
    const OLD_URI = "https://p42-caldav.icloud.com/xxx/attachments/old1";
    getIcs = MANAGED_ICS("UTF-8''%E5%8D%97%E5%9D%9E%E5%8F%A4%E9%81%93.jpg").replace(
      `MANAGED-ID=${NEW_ID}:${NEW_URI}`,
      `MANAGED-ID=${OLD_ID}:${OLD_URI}` + "\r\n" + `ATTACH;FMTTYPE=image/png;MANAGED-ID=${NEW_ID}:${NEW_URI}`
    );
    const r = await caldav.uploadIcloudAttachment(item, bytes, "南坞古道.jpg", "image/jpeg", "proxy", auth, [OLD_ID]);
    check("扣减法：认领的是新传的那个", r.managedId === NEW_ID, r.managedId);
    check("扣减法：URI 也是新的", r.uri === NEW_URI, r.uri);
  }

  {
    // ⑤b location 头优先认领 —— 复刻雄哥 2026-10-23 00:55 真机 dump 的翻车场景：
    //     上传其实成功了，但条目在服务端积了 3 条历史托管附件，扣减法剩 3 条判歧义→
    //     假失败；且失败就不 PUT、积压不清→恶性循环。POST 响应的 location 头与 ICS 里
    //     本次 ATTACH 的 URI 逐字符相同，是服务端权威指向，应当优先用它认领。
    calls.length = 0;
    postLocation = "https://gateway.icloud.com/caldav/1_t0k/attach/4_GE2DQ/UTF-8%27%27%25E5.jpg/YXR0YWNoYXR0YWNoYXR0YQ";
    // 4 条托管 ATTACH：1 条 known + 3 条历史积压（其中两条按真机 dump 的折行形态写）
    getIcs = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//WorkBuddy//SiYuan CalDAV//CN",
      "BEGIN:VTODO",
      "UID:u@t",
      "SUMMARY:测试任务",
      "DTSTAMP:20260101T000000Z",
      "DUE:20270101T090000",
      "ATTACH;FMTTYPE=image/jpeg;MANAGED-ID=known-1:https://gateway.icloud.com/caldav/old1",
      "ATTACH;FMTTYPE=image/jpeg;SIZE=5274516;FILENAME=\"UTF-8''%E5%8D%97.jpg\";MANAGED-ID=91e45e2f-9210-46bf-9960-66cc3eb6cdfc:https://gateway.icloud.com/caldav/old2",
      "ATTACH;FMTTYPE=image/jpeg;SIZE=5274516;FILENAME=UTF-8''%E5%8D%97%E5%9D%9E",
      " %E5%8F%A4%E9%81%93.jpg;MANAGED-ID=31ae9a49-2581-4b5c-8bdd-bac662498c5f:h",
      " ttps://gateway.icloud.com/caldav/old3",
      "ATTACH;FMTTYPE=image/jpeg;SIZE=5274516;FILENAME=UTF-8''%E5%8D%97%E5%9D%9E",
      " %E5%8F%A4%E9%81%93.jpg;MANAGED-ID=1dbcb65a-b825-4b87-afd6-54df0cefe1c6:h",
      " ttps://gateway.icloud.com/caldav/1_t0k/attach/4_GE2DQ/UTF-8%27%27%25E5.jpg/YXR0YWNoYXR0YWNoYXR0YQ",
      "END:VTODO",
      "END:VCALENDAR"
    ].join("\r\n");
    const r = await caldav.uploadIcloudAttachment(item, bytes, "南坞古道.jpg", "image/jpeg", "proxy", auth, []);
    check("location 命中：认领出 location 指的那条（不管历史积压几条）", r.managedId === "1dbcb65a-b825-4b87-afd6-54df0cefe1c6", r.managedId);
    check("location 命中：URI 与 location 头一致", r.uri === postLocation, r.uri);
    check("location 命中：同样带回新 etag", r.etag === "bf6", String(r.etag));
  }

  {
    // ⑤d 雄哥 2026-10-23 01:23 真机 dump 原样回放（D:/Temp/caldav-debug.txt：
    //     服务端积了 9 条托管附件 + location 缺尾部 token 段）。00:55 那轮把认领写成
    //     「逐字符相同」，真机上 location 到文件名结尾、ICS URI 尾部还拖一截签名 token
    //     （缺了它直接 GET location 会 400），精确相等永远不命中 → 掉回扣减法被 9 条
    //     积压判歧义 → 假失败 → 不 PUT → 下轮再传一条，越积越多。期望：按同基名认领出
    //     e0750f65 那条，URI 取 ICS 里的全量形态，带回新 etag。
    calls.length = 0;
    postLocation = REAL_LOCATION;
    getEtag = '"mvi8mw71"';
    getIcs = REAL_GET_ICS;
    const parsed = caldav.parseAllManagedAttach(REAL_GET_ICS);
    check("dump 数据完整性：GET 回捞里共 9 条托管 ATTACH", parsed.length === 9, String(parsed.length));
    check("dump 数据完整性：location 确实比 ICS URI 短（缺 token 段）", REAL_LOCATION.length < (REAL_LOCATION + REAL_TOKEN).length);
    const r = await caldav.uploadIcloudAttachment(item, bytes, "南坞古道.jpg", "image/jpeg", "proxy", auth, []);
    check("真机回放：location 缺 token 段也能命中（互为前缀）", r.managedId === "e0750f65-b12d-444a-a197-0399adfe2821", r.managedId);
    check("真机回放：URI 是 ICS 里那条全量（location + token 段）", r.uri === REAL_LOCATION + REAL_TOKEN, r.uri.slice(0, 60) + "…");
    check("真机回放：带回新 etag（mvi8mw71，不刷新随后 PUT 必 412）", r.etag === "mvi8mw71", String(r.etag));
    postLocation = "";
    getEtag = '"bf6"';
  }

  {
    // ⑤c 反过来钉死：没有 location 头且多条未知托管附件 → 必须失败不猜
    //     （猜错＝把别人附件的 URI 挂到本条目上。Node 测试里 debugDump 的
    //      globalThis.require 不存在，不会真写 D:/Temp，安全）
    calls.length = 0;
    postLocation = "";
    let err = null;
    try {
      await caldav.uploadIcloudAttachment(item, bytes, "南坞古道.jpg", "image/jpeg", "proxy", auth, []);
    } catch (e) {
      err = e;
    }
    check("多条未知且无 location：抛错不猜", !!err && /无法确认托管信息/.test(err.message), err && err.message.slice(0, 60));
  }

  {
    // ⑥ recoverServerFilename：服务端存的两种坏形态都能还原成本地名
    check(
      "UTF-8'' 字面量 → 原名",
      ics.recoverServerFilename("UTF-8''%E5%8D%97%E5%9D%9E%E5%8F%A4%E9%81%93.jpg") === "南坞古道.jpg",
      ics.recoverServerFilename("UTF-8''%E5%8D%97%E5%9D%9E%E5%8F%A4%E9%81%93.jpg")
    );
    const latin1 = Buffer.from("南坞古道.jpg", "utf8").toString("latin1");
    check("Latin-1 双重编码 → 原名", ics.recoverServerFilename(latin1) === "南坞古道.jpg", latin1);
    check("正常 ASCII 名不误伤", ics.recoverServerFilename("photo.jpg") === "photo.jpg");
    check("正常中文名不误伤", ics.recoverServerFilename("南坞古道.jpg") === "南坞古道.jpg");
  }

  {
    // ⑦ 源码防漂移：头必须走 icloudContentDisposition；认领必须保留 location 优先
    //    （2026-10-23 00:55 真机翻车场景的防线）
    const src = read("src/core/caldav.ts");
    check("caldav.ts 不再裸拼 filename 头", !/Content-Disposition.*sanitizeIcloudFilename\(name\)/.test(src));
    check("caldav.ts 导出 icloudContentDisposition", /export function icloudContentDisposition/.test(src));
    check("认领按 sameIcloudAttachmentUri 匹配（location 与 ICS URI 同一附件，非精确相等）", /sameIcloudAttachmentUri\(a\.uri, locationUri\)/.test(src));
    check("扣减法兜底仍在（未知恰好一条）", /fresh\.length !== 1/.test(src));
  }

  console.log(failed === 0 ? "\n✓ iCloud 托管附件上传回归测试通过" : `\n✗ ${failed} 个用例失败`);
  process.exit(failed === 0 ? 0 : 1);
})();
