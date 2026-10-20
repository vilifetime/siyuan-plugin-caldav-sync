/**
 * Digest 认证单测（2026-10-18 雄哥搭 Baïkal：只认 Digest，Basic 永远 401）
 * 运行前先用 tsc 把 src/core/digest.ts + http.ts 编译到 .test-core
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-core");

execSync(
  `npx tsc src/core/digest.ts src/core/http.ts --outDir .test-core --module commonjs --target es2020 ` +
  `--moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
const digest = require(path.join(outDir, "digest.js"));
const http = require(path.join(outDir, "http.js"));

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
async function ta(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n    ", e.message);
    process.exitCode = 1;
  }
}

// ---------- MD5 标准向量（含 UTF-8） ----------
console.log("[digest] MD5 向量");
t("md5 空串", () => assert.strictEqual(digest.md5(""), "d41d8cd98f00b204e9800998ecf8427e"));
t("md5 abc", () => assert.strictEqual(digest.md5("abc"), "900150983cd24fb0d6963f7d28e17f72"));
t("md5 fox", () => assert.strictEqual(digest.md5("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6"));
t("md5 UTF-8 中文", () => assert.strictEqual(digest.md5("中文密码"), "3d4acf94adca8562b4990599b15488de"));
t("md5 长输入（2000 字节跨多块）", () => assert.strictEqual(digest.md5("a".repeat(2000)), "7c1c566ab4cdb11ac8971191694e8bec"));
t("md5 中英混合长串", () => assert.strictEqual(digest.md5("CalDAV-Sync-中文-1234567890"), "c6d3962861235eef60c100f6dfa0eaa7"));
t("md5 64/128 字节边界", () => {
  // 55 字节（刚好不需第二块）、56 字节（需要第二块）、64 字节
  for (const n of [55, 56, 63, 64, 65, 119, 120]) {
    const v = digest.md5("x".repeat(n));
    assert.ok(/^[0-9a-f]{32}$/.test(v), `len ${n} 非法: ${v}`);
  }
});

// ---------- RFC 2617 §3.5.3 完整向量 ----------
console.log("[digest] RFC 2617 标准链");
t("Digest 头 response 与 RFC 公开值一致", () => {
  const cred = {
    username: "Mufasa",
    password: "Circle Of Life",
    challenge: { realm: "testrealm@host.com", nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093", qop: "auth" },
    nc: 0
  };
  const hdr = digest.buildDigestAuthorization(cred, "GET", "/dir/index.html", "0a4f113b");
  assert.ok(hdr.startsWith("Digest "), hdr);
  assert.ok(hdr.includes('response="6629fae49393a05397450978507c4ef1"'), hdr);
  assert.ok(hdr.includes("nc=00000001"), hdr);
  assert.ok(hdr.includes('cnonce="0a4f113b"'), hdr);
  assert.ok(hdr.includes('uri="/dir/index.html"'), hdr);
  assert.ok(hdr.includes("qop=auth"), hdr);
  assert.strictEqual(cred.nc, 1, "nc 应自增到 1");
});
t("第二次构造 nc=00000002", () => {
  const cred = {
    username: "u",
    password: "p",
    challenge: { realm: "r", nonce: "n", qop: "auth" },
    nc: 0
  };
  digest.buildDigestAuthorization(cred, "PROPFIND", "/dav.php/", "c1");
  const hdr2 = digest.buildDigestAuthorization(cred, "PROPFIND", "/dav.php/", "c2");
  assert.ok(hdr2.includes("nc=00000002"), hdr2);
});
t("无 qop（RFC 2069）也能构造", () => {
  const cred = { username: "u", password: "p", challenge: { realm: "r", nonce: "n" }, nc: 0 };
  const hdr = digest.buildDigestAuthorization(cred, "GET", "/x", "c");
  assert.ok(hdr.startsWith("Digest "));
  assert.ok(!hdr.includes("nc="), hdr);
  assert.ok(hdr.includes('response="'), hdr);
});

// ---------- challenge 解析 ----------
console.log("[digest] challenge 解析");
t("解析 Baïkal 真实 challenge", () => {
  const ch = digest.parseDigestChallenge('Digest realm="BaikalDAV",qop="auth",nonce="6ad4dd36dd671",opaque="d66d5f0524036afcb61420e358f990ce"');
  assert.deepStrictEqual(ch, {
    realm: "BaikalDAV",
    nonce: "6ad4dd36dd671",
    qop: "auth",
    opaque: "d66d5f0524036afcb61420e358f990ce"
  });
});
t("Basic challenge 返回 null", () => assert.strictEqual(digest.parseDigestChallenge('Basic realm="BaikalDAV"'), null));
t("空/undefined 返回 null", () => {
  assert.strictEqual(digest.parseDigestChallenge(undefined), null);
  assert.strictEqual(digest.parseDigestChallenge(""), null);
});
t("多 scheme 合并头能定位 Digest 段", () => {
  const ch = digest.parseDigestChallenge('Basic realm="a", Digest realm="b", nonce="n1", qop="auth"');
  assert.strictEqual(ch?.realm, "b");
  assert.strictEqual(ch?.nonce, "n1");
});
t("缺 nonce 返回 null", () => assert.strictEqual(digest.parseDigestChallenge('Digest realm="r"'), null));
t("只有 auth-int 时返回 null（不支持）", () => assert.strictEqual(digest.parseDigestChallenge('Digest realm="r", nonce="n", qop="auth-int"'), null));
t("stale=true 被解析", () => {
  const ch = digest.parseDigestChallenge('Digest realm="r", nonce="n", qop="auth", stale=true');
  assert.strictEqual(ch?.stale, true);
});
t("algorithm=MD5-sess 透传", () => {
  const ch = digest.parseDigestChallenge('Digest realm="r", nonce="n", algorithm=MD5-sess');
  assert.strictEqual(ch?.algorithm, "MD5-sess");
});

// ---------- httpRequest 协商行为（桩 fetch） ----------
console.log("[digest] httpRequest 协商行为");

const BAIKAL_CHALLENGE = 'Digest realm="BaikalDAV",qop="auth",nonce="NONCE-1",opaque="OP-1"';

/** 桩服务器：script 逐步返回，最后一步粘滞；记录每个请求的 Authorization */
function makeServer(script) {
  const received = [];
  let i = 0;
  return {
    received,
    handle(auth, method, uri) {
      received.push({ auth: auth || null, method, uri });
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return step;
    }
  };
}

function authFromProxyBody(init) {
  const env = JSON.parse(init.body);
  const h = (env.headers || []).map((o) => Object.values(o)[0]).find((v) => /^(Basic|Digest) /.test(String(v)));
  return h ? String(h) : null;
}

function installFetchStub(server) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/api/network/forwardProxy")) {
      const step = server.handle(authFromProxyBody(init), "PROPFIND", "/dav.php/");
      return { json: async () => ({ code: 0, data: { status: step.status, headers: step.headers || {}, body: step.body || "" } }) };
    }
    const step = server.handle(init?.headers?.Authorization || null, init?.method || "GET", new URL(u).pathname);
    const hdrs = {};
    for (const [k, v] of Object.entries(step.headers || {})) hdrs[k.toLowerCase()] = v;
    return {
      status: step.status,
      headers: {
        get: (k) => hdrs[String(k).toLowerCase()] ?? null,
        forEach: (cb) => Object.entries(hdrs).forEach(([k, v]) => cb(v, k))
      },
      text: async () => step.body || ""
    };
  };
}

function digestParams(hdr) {
  const out = {};
  for (const m of hdr.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

const OPTS = {
  method: "PROPFIND",
  body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
  headers: { "Content-Type": "application/xml; charset=utf-8", Depth: "0" },
  timeoutMs: 15000
};
const AUTH = { username: "bonebear", password: "pw-secret" };

await ta("代理通道：Basic 401 + Digest challenge → 协商后 207", async () => {
  http.clearAuthCache();
  http.setKernelBase("http://kernel.test");
  const server = makeServer([
    { status: 401, headers: { "Www-Authenticate": BAIKAL_CHALLENGE }, body: "<error/>" },
    { status: 207, headers: {}, body: "<multistatus/>" }
  ]);
  installFetchStub(server);
  const r = await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "proxy", AUTH);
  assert.strictEqual(r.status, 207);
  assert.strictEqual(server.received.length, 2, "应恰好两次请求：Basic + Digest");
  assert.ok(server.received[0].auth.startsWith("Basic "), "第一次必须是 Basic");
  assert.ok(server.received[1].auth.startsWith("Digest "), "第二次必须是 Digest");
  const p = digestParams(server.received[1].auth);
  // 独立重算 response，验证整条 MD5 链
  const ha1 = digest.md5(`${AUTH.username}:BaikalDAV:${AUTH.password}`);
  const ha2 = digest.md5("PROPFIND:/dav.php/");
  const expect = digest.md5(`${ha1}:NONCE-1:${p.nc}:${p.cnonce}:auth:${ha2}`);
  assert.strictEqual(p.response, expect, "Digest response 与独立重算不一致");
  assert.strictEqual(p.nc, "00000001");
  assert.strictEqual(p.uri, "/dav.php/");
  assert.strictEqual(p.opaque, "OP-1");
});

await ta("协商后缓存生效：同服务器下一次直接 Digest（无 401 往返）", async () => {
  http.setKernelBase("http://kernel.test");
  const server = makeServer([{ status: 207, headers: {}, body: "<multistatus/>" }]);
  installFetchStub(server);
  const r = await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "proxy", AUTH);
  assert.strictEqual(r.status, 207);
  assert.strictEqual(server.received.length, 1, "有缓存时应只发一次");
  assert.ok(server.received[0].auth.startsWith("Digest "), "应直接走 Digest");
  assert.ok(server.received[0].auth.includes("nc=00000002"), "nc 应递增");
});

await ta("Basic 服务器密码错：401 无 challenge → 不重试、原样返回", async () => {
  http.clearAuthCache();
  const server = makeServer([{ status: 401, headers: {}, body: "denied" }]);
  installFetchStub(server);
  const r = await http.httpRequest("http://radicale.test:5232/user/cal/", OPTS, "proxy", AUTH);
  assert.strictEqual(r.status, 401);
  assert.strictEqual(server.received.length, 1, "没有 Digest challenge 时不能重试");
  assert.ok(server.received[0].auth.startsWith("Basic "));
});

await ta("Basic 服务器正常：一次 207，不碰 Digest 逻辑", async () => {
  http.clearAuthCache();
  const server = makeServer([{ status: 207, headers: {}, body: "<multistatus/>" }]);
  installFetchStub(server);
  const r = await http.httpRequest("http://radicale.test:5232/user/cal/", OPTS, "proxy", AUTH);
  assert.strictEqual(r.status, 207);
  assert.strictEqual(server.received.length, 1);
  assert.ok(server.received[0].auth.startsWith("Basic "));
});

await ta("直连通道：401 challenge → Digest 重试 207", async () => {
  http.clearAuthCache();
  const server = makeServer([
    { status: 401, headers: { "www-authenticate": BAIKAL_CHALLENGE }, body: "<error/>" },
    { status: 207, headers: {}, body: "<multistatus/>" }
  ]);
  installFetchStub(server);
  const r = await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "direct", AUTH);
  assert.strictEqual(r.status, 207);
  assert.strictEqual(server.received.length, 2);
  assert.ok(server.received[1].auth.startsWith("Digest "), "直连通道也要能协商");
});

await ta("nonce 过期（stale）：丢缓存换新 nonce 重试一次", async () => {
  http.clearAuthCache();
  // 先建立缓存
  const warm = makeServer([
    { status: 401, headers: { "Www-Authenticate": BAIKAL_CHALLENGE }, body: "" },
    { status: 207, headers: {}, body: "" }
  ]);
  installFetchStub(warm);
  await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "proxy", AUTH);
  // 再模拟 nonce 过期：服务端给新 challenge（stale=true）
  const renewed = 'Digest realm="BaikalDAV",qop="auth",nonce="NONCE-2",opaque="OP-2",stale=true';
  const server = makeServer([
    { status: 401, headers: { "Www-Authenticate": renewed }, body: "" },
    { status: 207, headers: {}, body: "" }
  ]);
  installFetchStub(server);
  const r = await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "proxy", AUTH);
  assert.strictEqual(r.status, 207);
  assert.strictEqual(server.received.length, 2, "过期时应：Digest 401 → 换 nonce 再 Digest");
  assert.ok(server.received[0].auth.includes("NONCE-1"), "第一次还用旧 nonce");
  assert.ok(server.received[1].auth.includes("NONCE-2"), "第二次必须换新 nonce");
  // 缓存已更新：再下一次直接用新 nonce
  const after = makeServer([{ status: 207, headers: {}, body: "" }]);
  installFetchStub(after);
  await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "proxy", AUTH);
  assert.strictEqual(after.received.length, 1);
  assert.ok(after.received[0].auth.includes("NONCE-2"), "缓存应已是新 nonce");
  // 新 nonce 在重试那一下已用掉 nc=1，所以再下一次是 nc=2
  assert.ok(after.received[0].auth.includes("nc=00000002"), "新 nonce 的 nc 应续着计");
});

await ta("clearAuthCache 后回到 Basic 首次流程", async () => {
  const server = makeServer([
    { status: 401, headers: { "Www-Authenticate": BAIKAL_CHALLENGE }, body: "" },
    { status: 207, headers: {}, body: "" }
  ]);
  installFetchStub(server);
  http.clearAuthCache();
  const r = await http.httpRequest("http://192.168.0.133:5808/dav.php/", OPTS, "proxy", AUTH);
  assert.strictEqual(r.status, 207);
  assert.strictEqual(server.received.length, 2, "清缓存后应重新 Basic→Digest 协商");
  assert.ok(server.received[0].auth.startsWith("Basic "));
});

await ta("无 auth 的请求不带 Authorization、不发第二次", async () => {
  const server = makeServer([{ status: 207, headers: {}, body: "" }]);
  installFetchStub(server);
  const r = await http.httpRequest("http://x.test/dav.php/", OPTS, "proxy");
  assert.strictEqual(r.status, 207);
  assert.strictEqual(server.received.length, 1);
  assert.strictEqual(server.received[0].auth, null);
});

// ---------- 源码断言：设置保存处必须清缓存 ----------
console.log("[digest] 源码断言");
t("settings-dialog 保存后调用 clearAuthCache", () => {
  // 先剥注释：注释里出现函数名不能算调用（变异测试时自己写的注释就误伤过一次）
  // ⚠️ 本仓库 CRLF 行尾：先统一成 LF，断言里的 \s / $ 才行为可预期（2026-10-20）
  const src = fs.readFileSync(path.join(root, "src/ui/settings-dialog.ts"), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(/import\s*\{\s*clearAuthCache\s*\}\s*from\s*"\.\.\/core\/http"/.test(src), "缺少 clearAuthCache import");
  assert.ok(/clearAuthCache\(\)/.test(src), "保存流程里没有调用 clearAuthCache()");
});
t("http.ts 保留 Basic 首次行为与上传预算逻辑", () => {
  const src = fs.readFileSync(path.join(root, "src/core/http.ts"), "utf8");
  assert.ok(src.includes("basicAuthHeader(auth.username, auth.password)"), "Basic 首次行为被改掉");
  assert.ok(/uploadTimeoutMs\(/.test(src), "上传预算逻辑丢失");
  assert.ok(src.includes("signal: ctrl.signal"), "viaProxy 的 abort signal 丢失");
});

console.log(`\n[digest] ${passed} 项通过`);
