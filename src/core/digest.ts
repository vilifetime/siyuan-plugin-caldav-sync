/**
 * HTTP Digest 认证（RFC 2617 §3.2.2，兼容 RFC 7616 的 MD5 子集）
 *
 * 为什么需要：Baïkal 的用户库里只存 digest_a1_hash，服务端根本不验证 Basic
 * 密码——对它只发 Basic 永远 401（表现为「认证失败：用户名或密码错误」），
 * 而同一对凭据在 DAVx5 / Thunderbird 里能登录，因为那些客户端收到
 * `WWW-Authenticate: Digest` challenge 后会自动协商。插件在 http.ts 里补上
 * 同样的协商：Basic 401 + Digest challenge → 算 Digest 重试。
 */

/** MD5（纯 JS）。WebCrypto 只支持 SHA 系列，Electron/浏览器里要 MD5 只能自带。 */
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const n = bytes.length;
  // 填充到 64 的倍数：0x80 + 补零 + 64-bit 小端长度
  const padded = new Uint8Array(((n + 8) >> 6) * 64 + 64);
  padded.set(bytes);
  padded[n] = 0x80;
  const bitLen = n * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  const K: number[] = [];
  for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  let a = 0x67452301 | 0;
  let b = 0xefcdab89 | 0;
  let c = 0x98badcfe | 0;
  let d = 0x10325476 | 0;
  const X = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = dv.getInt32(off + i * 4, true);
    let A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) & 15;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) & 15;
      }
      F = (F + A + K[i] + X[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a = (a + A) | 0;
    b = (b + B) | 0;
    c = (c + C) | 0;
    d = (d + D) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  out.setInt32(0, a, true);
  out.setInt32(4, b, true);
  out.setInt32(8, c, true);
  out.setInt32(12, d, true);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += out.getUint8(i).toString(16).padStart(2, "0");
  return hex;
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  /** 只实现 qop=auth；auth-int 不做 */
  qop?: "auth";
  opaque?: string;
  /** 缺省 MD5；MD5-sess 也支持 */
  algorithm?: string;
  stale?: boolean;
}

/**
 * 解析 `WWW-Authenticate: Digest ...` 响应头；不是 Digest（或参数不全）返回 null。
 * 多 scheme 合并的头（`Basic ..., Digest ...`）也能定位到 Digest 段。
 */
export function parseDigestChallenge(headerValue: string | undefined | null): DigestChallenge | null {
  if (!headerValue) return null;
  const v = String(headerValue);
  const m = /(?:^|,\s*)Digest\s+([\s\S]*)$/i.exec(v);
  if (!m) return null;
  const params: Record<string, string> = {};
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(m[1]))) {
    params[mm[1].toLowerCase()] = mm[2] !== undefined ? mm[2].replace(/\\(.)/g, "$1") : mm[3];
  }
  if (!params.realm || !params.nonce) return null;
  const out: DigestChallenge = { realm: params.realm, nonce: params.nonce };
  if (params.qop) {
    const list = params.qop.split(",").map((s) => s.trim().toLowerCase());
    if (!list.includes("auth")) return null; // 只有 auth-int 时不做
    out.qop = "auth";
  }
  if (params.opaque) out.opaque = params.opaque;
  if (params.algorithm) out.algorithm = params.algorithm;
  if (params.stale) out.stale = /^true$/i.test(params.stale);
  return out;
}

export interface DigestCred {
  username: string;
  password: string;
  challenge: DigestChallenge;
  /** 已使用次数；取用时先自增（首次 → nc=00000001） */
  nc: number;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  const c = (globalThis as any).crypto;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(buf);
  else for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * 构造 `Authorization: Digest ...` 头。
 * uri 必须是请求实际发出的路径（scheme/host 去掉，与 RFC 2617 示例一致）。
 * fixedCnonce 仅供测试注入标准向量，生产不传。
 */
export function buildDigestAuthorization(cred: DigestCred, method: string, uri: string, fixedCnonce?: string): string {
  const ch = cred.challenge;
  const cn = fixedCnonce || randomHex(16);
  let ha1 = md5(`${cred.username}:${ch.realm}:${cred.password}`);
  if ((ch.algorithm || "").toLowerCase() === "md5-sess") ha1 = md5(`${ha1}:${ch.nonce}:${cn}`);
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);
  cred.nc += 1;
  const nc = cred.nc.toString(16).padStart(8, "0");
  const response = ch.qop ? md5(`${ha1}:${ch.nonce}:${nc}:${cn}:${ch.qop}:${ha2}`) : md5(`${ha1}:${ch.nonce}:${ha2}`);
  const parts = [
    `username="${cred.username}"`,
    `realm="${ch.realm}"`,
    `nonce="${ch.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${ch.algorithm || "MD5"}`
  ];
  if (ch.opaque) parts.push(`opaque="${ch.opaque}"`);
  if (ch.qop) parts.push(`qop=${ch.qop}`, `nc=${nc}`, `cnonce="${cn}"`);
  return "Digest " + parts.join(", ");
}
