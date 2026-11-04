/**
 * 纯 JS HMAC-SHA256 单元测试（内核加签依赖，零 crypto 依赖）。
 *
 * 钉钉「加签」依赖 HMAC-SHA256，且内核运行在 goja（不能用 require("crypto")），
 * 故实现放 src/core/hmac-sha256.ts。本测试对照 Node 原生 crypto 校验正确性：
 *   - RFC 4231 两条标准向量（十六进制期望 → 先 base64 再比对）；
 *   - 钉钉风格：key=secret, msg=timestamp+"\n"+secret，与 Node 算出的值逐位一致。
 */
import assert from "node:assert";
import { createHmac } from "node:crypto";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const out = path.join(root, "dist-test", "hmac.mjs");
fs.mkdirSync(path.dirname(out), { recursive: true });

await build({
  entryPoints: [path.join(root, "src/core/hmac-sha256.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "silent"
});

const { hmacSha256Base64 } = await import(pathToFileURL(out).href + "?t=" + Date.now());

function nodeHmacB64(key, msg) {
  return createHmac("sha256", key).update(msg, "utf8").digest("base64");
}

// RFC 4231 #1: key=0x0b×20, data="Hi There"
const v1 = hmacSha256Base64("\x0b".repeat(20), "Hi There");
const e1 = Buffer.from("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7", "hex").toString("base64");
assert.strictEqual(v1, e1, "RFC4231 #1 应匹配");

// RFC 4231 #2: key="Jefe", data="what do ya want for nothing?"
const v2 = hmacSha256Base64("Jefe", "what do ya want for nothing?");
const e2 = Buffer.from("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", "hex").toString("base64");
assert.strictEqual(v2, e2, "RFC4231 #2 应匹配");

// 钉钉风格：与 Node 原生实现逐位一致
const ts = "1690000000000";
const secret = "my-dingtalk-secret";
const msg = `${ts}\n${secret}`;
assert.strictEqual(
  hmacSha256Base64(secret, msg),
  nodeHmacB64(secret, msg),
  "钉钉风格签名应与 Node 原生一致"
);

// 中文 key/msg 也能正确处理（UTF-8）
const cnhmac = hmacSha256Base64("密钥🙂", "消息内容🎯");
assert.strictEqual(cnhmac, nodeHmacB64("密钥🙂", "消息内容🎯"), "UTF-8 中文/emoji 应与 Node 原生一致");

console.log("[hmac-sha256.test] 全部断言通过 ✅（纯 JS HMAC-SHA256 与 Node crypto 一致）");
