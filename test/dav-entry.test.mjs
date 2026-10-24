/**
 * 「根路径不支持 WebDAV（405）」时的 DAV 入口探测 —— 回归测试
 *
 * 背景（2026-10-24 雄哥实测）：自建 **Baïkal** 前面套 nginx，根路径 `/` 只放行
 * GET/HEAD（返回 Baïkal 的网页管理界面），对根路径发 PROPFIND/OPTIONS 直接 **405**。
 * 用户只看到「服务器返回 HTTP 405」无从下手——真正要填的地址是
 * `http://<host>:<port>/dav.php`（Baïkal 的 DAV 入口）。
 *
 * 覆盖：
 *   1. 根路径 405 → 探测候选路径 → 命中 /dav.php/（401 = 端点在、只是要认证）
 *   2. /.well-known/caldav 的 302 目标**丢了端口** → 必须用原 origin 重建后再验
 *   3. 全部候选都不通 → 返回空串（调用方退化为「请填写 DAV 入口地址」提示）
 *   4. testConnection 的 405 分支要给出「已探测到的入口」，而不是干巴巴一个状态码
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-daventry");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));
execSync(
  `npx tsc src/core/types.ts src/core/date.ts src/core/ics.ts src/core/http.ts src/core/caldav.ts ` +
  `--outDir .test-daventry --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);

const require = createRequire(import.meta.url);
const caldav = require(path.join(outDir, "caldav.js"));

let passed = 0;
const t = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n    ", e.message);
    process.exitCode = 1;
  }
};

const fakeRes = (status, body, headers = {}) => ({
  status,
  text: async () => body,
  headers: { forEach: (fn) => Object.entries(headers).forEach(([k, v]) => fn(v, k)) }
});

function withFetch(router) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const r = router({ url: String(url), method: init?.method || "GET" });
    return fakeRes(r.status, r.body ?? "", r.headers);
  };
  return () => {
    globalThis.fetch = orig;
  };
}

const AUTH = { username: "xiongfei", password: "secret" };
const HOST = "http://nas.bonebear.cn:5808";

await t("根路径 405 → 探测到 Baïkal 的 /dav.php/ 入口", async () => {
  const seen = [];
  const restore = withFetch((req) => {
    seen.push(req.url);
    if (req.url === HOST + "/") return { status: 405, body: "405 Not Allowed" };
    if (req.url === HOST + "/dav.php/") return { status: 401, body: "Unauthorized" };
    return { status: 404, body: "404" };
  });
  try {
    const entry = await caldav.probeDavEntry(HOST, "direct", AUTH);
    assert.strictEqual(entry, HOST + "/dav.php/", "应命中 Baïkal 的 DAV 入口，实际 " + entry);
    assert.ok(seen.includes(HOST + "/.well-known/caldav"), "应先试标准入口 .well-known/caldav");
  } finally {
    restore();
  }
});

await t(".well-known/caldav 的 302 丢了端口 → 用原 origin 重建后再验证", async () => {
  // Baïkal 实际行为：302 → http://nas.bonebear.cn/dav.php（**丢了 :5808**）
  // 照抄 Location 会跳到 80 端口的别处 → 必须重建 origin
  const restore = withFetch((req) => {
    if (req.url === HOST + "/.well-known/caldav") {
      return { status: 302, body: "", headers: { location: "http://nas.bonebear.cn/dav.php" } };
    }
    if (req.url === HOST + "/dav.php") return { status: 401, body: "Unauthorized" };
    return { status: 404, body: "404" };
  });
  try {
    const entry = await caldav.probeDavEntry(HOST, "direct", AUTH);
    assert.strictEqual(entry, HOST + "/dav.php", "重建后应保留 5808 端口，实际 " + entry);
  } finally {
    restore();
  }
});

await t("候选全不通 → 返回空串（调用方退化为提示文案）", async () => {
  const restore = withFetch(() => ({ status: 404, body: "404" }));
  try {
    const entry = await caldav.probeDavEntry(HOST, "direct", AUTH);
    assert.strictEqual(entry, "", "探测不到时应返回空串，实际 " + entry);
  } finally {
    restore();
  }
});

await t("testConnection 遇 405：提示里要带已探测到的入口地址", async () => {
  const restore = withFetch((req) => {
    if (req.url === HOST + "/") return { status: 405, body: "405 Not Allowed" };
    if (req.url === HOST + "/dav.php/") return { status: 401, body: "Unauthorized" };
    return { status: 404, body: "404" };
  });
  try {
    const r = await caldav.testConnection(HOST, "direct", AUTH);
    assert.strictEqual(r.ok, false, "根路径 405 不算连接成功");
    assert.ok(/dav\.php/.test(r.message), "提示里应给出探测到的入口，实际：" + r.message);
    assert.ok(/5808/.test(r.message), "提示里应带完整地址（含端口），实际：" + r.message);
  } finally {
    restore();
  }
});

await t("testConnection 遇 405 且探测不到：提示要教用户填哪种地址", async () => {
  const restore = withFetch(() => ({ status: 405, body: "405 Not Allowed" }));
  try {
    const r = await caldav.testConnection(HOST, "direct", AUTH);
    assert.strictEqual(r.ok, false);
    assert.ok(/dav\.php|well-known/.test(r.message), "提示里应给出常见入口示例，实际：" + r.message);
  } finally {
    restore();
  }
});

console.log(`\n[dav-entry] ${passed} 项通过`);
