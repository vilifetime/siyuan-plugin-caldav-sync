/**
 * 纯 JS 实现的 HMAC-SHA256（RFC 2104 / RFC 6234），**零依赖**。
 *
 * 为什么需要它：思源内核插件运行在 Go 内置的 goja JS 解释器里，
 * 那里 `require("crypto")` 这种 Node 内置模块解析不了（会导致 kernel.js 加载即崩、
 * 插件 never running）。而钉钉「加签」需要 HMAC-SHA256。
 * 本实现只用 JS 原生类型（Uint8Array / number），在浏览器、Node、goja 下完全一致。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      i++;
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 over arbitrary bytes → 32-byte digest */
function sha256(msg: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const l = msg.length;
  const paddedLen = (((l + 8) >> 6) + 1) << 6; // (l+1+8) rounded up to 64
  const padded = new Uint8Array(paddedLen);
  padded.set(msg);
  padded[l] = 0x80;
  // message length in bits, as 64-bit big-endian
  const bitLen = l * 8;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  padded[paddedLen - 8] = (hi >>> 24) & 0xff;
  padded[paddedLen - 7] = (hi >>> 16) & 0xff;
  padded[paddedLen - 6] = (hi >>> 8) & 0xff;
  padded[paddedLen - 5] = hi & 0xff;
  padded[paddedLen - 4] = (lo >>> 24) & 0xff;
  padded[paddedLen - 3] = (lo >>> 16) & 0xff;
  padded[paddedLen - 2] = (lo >>> 8) & 0xff;
  padded[paddedLen - 1] = lo & 0xff;

  const w = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] =
        (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3];
    let e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (h[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
    out[i * 4 + 3] = h[i] & 0xff;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa 在浏览器/部分运行时存在；Node 与 goja 可能没有 → 用 Buffer 兜底（Node）或手写
  if (typeof btoa === "function") return btoa(bin);
  // 手写 base64（不依赖任何运行时）
  const table =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += table[(triple >> 18) & 0x3f];
    out += table[(triple >> 12) & 0x3f];
    out += i + 1 < bytes.length ? table[(triple >> 6) & 0x3f] : "=";
    out += i + 2 < bytes.length ? table[triple & 0x3f] : "=";
  }
  return out;
}

/**
 * HMAC-SHA256，输出 base64 字符串。
 * key / message 均按 UTF-8 处理（与钉钉 Java 端一致）。
 */
export function hmacSha256Base64(key: string, message: string): string {
  const blockSize = 64;
  let keyBytes = utf8Bytes(key);
  if (keyBytes.length > blockSize) {
    keyBytes = sha256(keyBytes);
  }
  const paddedKey = new Uint8Array(blockSize);
  paddedKey.set(keyBytes);

  const oKeyPad = new Uint8Array(blockSize);
  const iKeyPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    oKeyPad[i] = paddedKey[i] ^ 0x5c;
    iKeyPad[i] = paddedKey[i] ^ 0x36;
  }
  const inner = sha256(concat(iKeyPad, utf8Bytes(message)));
  const outer = sha256(concat(oKeyPad, inner));
  return bytesToBase64(outer);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
