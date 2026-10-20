/**
 * HTTP 通道：思源内核代理（无 CORS 限制，默认）+ 浏览器直连（回退）
 * 不 import "siyuan"，以便在 Node 测试环境独立运行
 */
import { buildDigestAuthorization, parseDigestChallenge, type DigestCred } from "./digest";

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  elapsedMs: number;
  via: "proxy" | "direct";
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export type Channel = "auto" | "proxy" | "direct";

/** 内核代理通道的相对根（思源渲染进程同源）；测试环境可覆盖 */
export let kernelBase = "";
export function setKernelBase(base: string) {
  kernelBase = base;
}

/**
 * 直连失败后是否自动改走内核代理。
 *
 * 为什么需要：移动端 WebView 会拦掉「明文 HTTP + 跨域」的直连请求，
 * 表现就是 `TypeError: Failed to fetch`（PC 上同样的配置却能通）。
 * 用户此时往往已经在设置里选了「仅浏览器直连」，光靠文案提示不够——
 * 直连在网络层就失败时，静默改走内核代理（Go 侧发起请求，无 CORS、无明文限制）。
 *
 * 只在收到「网络级错误」时兜底：401/404 这类服务器真实响应不会走到这里，
 * 「仅浏览器直连」的语义在服务器可达时仍然成立。
 * 由入口按 isMobile() 打开，core 层不 import "siyuan"。
 */
export let directFallbackToProxy = false;
export function setDirectFallbackToProxy(on: boolean) {
  directFallbackToProxy = on;
}

/** 网络级失败（请求根本没到达服务器）而非服务器返回的 HTTP 错误 */
export function isNetworkLevelError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  // aborted 也算：直连/代理任一侧超时被主动 abort 后，语义上就是「没收到响应」，
  // direct 通道要能据此回退代理（2026-10-16 修 viaProxy 超时时补上）。
  return /failed to fetch|networkerror|network request failed|load failed|err_|abort/i.test(msg);
}

/**
 * 上传（带 body 的请求）的超时预算：小 body 用默认 60s，body 越大给得越宽。
 *
 * 为什么不能固定 30s：待办附件是 base64 内联进 ICS 的，一个 5MB 的图片 →
 * ICS 约 7MB。家用 NAS 的上行常常只有几百 KB/s（还可能经域名/中转绕一圈），
 * 7MB 传完要一分多钟。固定 30s 的结果是「挑选时放行、保存时也放行、上传
 * 永远超时」——条目卡在 dirty 里每轮同步反复重试（2026-10-15 实测：5.03MB
 * 附件，auto 通道代理/直连各 30s 全超时，报「上传 任务测试Z: 请求超时」）。
 *
 * 预算按 32KB/s 的保守速率折算，封顶 10 分钟——再慢就是真的传不动，不该让
 * 用户干等。两条通道都吃这个值：直连是 AbortController 的毫秒数；内核代理
 * 是 forwardProxy 的 `timeout` 字段（毫秒，≤0 回落 7000，见
 * siyuan-plugin-http-channel-debug 的契约表）。
 *
 * 2026-10-16 雄哥实测：NAS 上行有时比 64KB/s 的估速还慢，预算整体翻倍
 * （基线 30→60s、速率 64→32KB/s、封顶 5→10 分钟）。注意只翻「带 body 的
 * 上传」——PROPFIND/DELETE 等小请求仍是各调用点的 30s，那些卡死时等 60s
 * 只会更烦。
 */
export function uploadTimeoutMs(bodyBytes: number): number {
  const BASE_MS = 60000;
  const FLOOR_BYTES_PER_SEC = 32 * 1024;
  const CAP_MS = 600000;
  if (!Number.isFinite(bodyBytes) || bodyBytes <= 0) return BASE_MS;
  return Math.min(CAP_MS, BASE_MS + Math.ceil((bodyBytes / FLOOR_BYTES_PER_SEC) * 1000));
}

function normalizeHeaders(h: Record<string, string[]> | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const k of Object.keys(h)) {
    const v = (h as any)[k];
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/**
 * 组装 /api/network/forwardProxy 的请求体。
 *
 * 三个必须遵守的内核约定（均已实测确认，SiYuan 3.1.0 与 3.8.4 一致）：
 * 1. `headers` 必须是「单键对象数组」`[{"k":"v"}]`，不是键值对数组 `[["k","v"]]`。
 *    传成后者时，内核遍历 `map[string]any` 取不到任何键，**自定义头被静默丢弃**——
 *    表现为代理通道永远 401（Authorization 没送到），而直连通道一切正常。
 * 2. `contentType` 是独立字段，内核会用它覆盖请求头里的 Content-Type；
 *    若固化传 text/plain，PROPFIND 的 application/xml 会被改写。
 * 3. `payloadEncoding: "base64"` 时内核要求 `payload` 必须是字符串：
 *    无 body 的请求（DELETE）也要传空串，否则报 `[payload] must be a string`。
 *    另外 `payloadEncoding: "text"` 不会发送 body，所以 body 一律走 base64。
 */
/**
 * 内核代理请求体。
 *
 * ⚠️ `payload` 必须恒为字符串：Go 侧 `[payload] must be a string`。
 *    另外 `payloadEncoding: "text"` 不会发送 body，所以 body 一律走 base64。
 *    文本要先用 UTF-8 编码再 base64（`unescape(encodeURIComponent(...))` 那一步），
 *    否则中文会被按 Latin-1 截断。
 */
export function buildProxyBody(url: string, opts: HttpOptions): Record<string, unknown> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  let contentType = "text/plain";
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "content-type") {
      contentType = headers[k];
      delete headers[k];
    }
  }
  return {
    url,
    method: opts.method || "GET",
    timeout: Math.floor(opts.timeoutMs || 30000),
    contentType,
    headers: Object.entries(headers).map(([k, v]) => ({ [k]: v })),
    payload: btoa(unescape(encodeURIComponent(opts.body ?? ""))),
    payloadEncoding: "base64",
    responseEncoding: "text"
  };
}

async function viaProxy(url: string, opts: HttpOptions): Promise<HttpResult> {
  const t0 = Date.now();
  // 客户端侧硬超时：内核 forwardProxy 的 timeout 字段是黑盒——实测对「服务器
  // 接受 TCP 后不响应 HTTP」的场景不可靠（NAS 濒死时 PUT 挂死十几分钟不停）。
  // 没有这层 abort，这个 fetch 会永远挂起 → syncAll 永不返回 → runSync 的
  // await 不落地 → 同步按钮的 .finally() 永远不跑，按钮转到天荒地老
  // （2026-10-16 雄哥实测：请求超时报了，按钮还在转）。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 30000);
  try {
    const res = await fetch(kernelBase + "/api/network/forwardProxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildProxyBody(url, opts)),
      signal: ctrl.signal
    });
    const data: any = await res.json();
    if (data.code !== 0) throw new Error("内核代理失败: " + (data.msg || JSON.stringify(data)));
    const d = data.data || {};
    const body = typeof d.body === "string" ? d.body : d.body?.content ?? "";
    return {
      status: d.status ?? 0,
      headers: normalizeHeaders(d.headers),
      body,
      elapsedMs: Date.now() - t0,
      via: "proxy"
    };
  } finally {
    clearTimeout(timer);
  }
}

async function viaDirect(url: string, opts: HttpOptions): Promise<HttpResult> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 30000);
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body, elapsedMs: Date.now() - t0, via: "direct" };
  } finally {
    clearTimeout(timer);
  }
}

export function basicAuthHeader(username: string, password: string): string {
  return "Basic " + btoa(unescape(encodeURIComponent(username + ":" + password)));
}

// —— Digest 认证协商（2026-10-18 雄哥搭 Baïkal 触发）——
// Baïkal 用户库只存 digest_a1_hash、不验 Basic，对它只发 Basic 永远 401；
// DAVx5/Thunderbird 能登是因为会自动协商 Digest。流程：
//   首次按 Basic 发 → 401 且响应带 Digest challenge → 算 Digest 重试，并按
//   「origin+用户名」缓存（nonce 复用、nc 递增）；之后同服务器请求直接走
//   Digest，不再每次 401 往返。nonce 过期（服务端常带 stale=true）时丢缓存
//   重协商一次；不带 challenge 的 401 是真·密码错，原样上交、行为不变。
const digestCache = new Map<string, DigestCred>();

/** 设置里改了凭据时调用，避免缓存里留着旧密码的协商结果 */
export function clearAuthCache() {
  digestCache.clear();
}

function digestCacheKey(url: string, username: string): string {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    /* 非标准 URL 时退回全串 */
  }
  return origin + "|" + username;
}

/** Digest 头里的 uri 必须是请求实际发出的路径（去掉 scheme/host） */
function requestUri(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * 按通道发起请求；channel=auto 时代理失败自动回退直连
 */
export async function httpRequest(
  url: string,
  opts: HttpOptions,
  channel: Channel,
  auth?: { username: string; password: string }
): Promise<HttpResult> {
  const full: HttpOptions = { ...opts, headers: { ...(opts.headers || {}) } };
  // 没显式给超时的带 body 请求（上传类）按 body 大小放宽预算，见 uploadTimeoutMs：
  // 几 MB 的日历数据在家庭宽带上传一分钟以上是常事，固定 30s 等于必然超时。
  // 显式传了 timeoutMs 的调用方（小 body 的 PROPFIND/DELETE 等）保持原值不动。
  if (full.timeoutMs === undefined && typeof full.body === "string" && full.body.length > 0) {
    full.timeoutMs = uploadTimeoutMs(new TextEncoder().encode(full.body).length);
  }

  // 回退时按**剩余预算**走：否则 auto 通道下每条通道各等一份全额超时，
  // 7MB 的 ICS 就是 142s（代理）+ 142s（直连）≈ 5 分钟才停下来。
  const t0 = Date.now();
  const remaining = () => Math.max(2000, (full.timeoutMs || 30000) - (Date.now() - t0));

  // 单次派发（含 auto 的代理→直连回退）；Authorization 由上层拼进 headers
  const dispatch = async (o: HttpOptions): Promise<HttpResult> => {
    if (channel === "direct") {
      try {
        return await viaDirect(url, o);
      } catch (e) {
        // 直连在网络层就被拦（常见于手机 WebView 的明文 HTTP / 跨域限制）→ 改走内核代理
        if (!directFallbackToProxy || !isNetworkLevelError(e)) throw e;
        console.warn("[caldav] 浏览器直连被拦截，改走内核代理:", e);
        return viaProxy(url, o);
      }
    }
    if (channel === "proxy") return viaProxy(url, o);
    try {
      return await viaProxy(url, o);
    } catch (e) {
      console.warn("[caldav] 内核代理通道失败，回退浏览器直连:", e);
      return viaDirect(url, { ...o, timeoutMs: remaining() });
    }
  };

  if (!auth) return dispatch(full);

  const method = full.method || "GET";
  const uri = requestUri(url);
  const withAuth = (header: string): HttpOptions => ({
    ...full,
    headers: { ...full.headers, Authorization: header }
  });
  const digestHeader = (cred: DigestCred) => withAuth(buildDigestAuthorization(cred, method, uri));

  const key = digestCacheKey(url, auth.username);
  const cached = digestCache.get(key);
  if (cached) {
    // 已协商过：直接 Digest 发一次，不再 401 往返
    const r = await dispatch(digestHeader(cached));
    if (r.status !== 401) return r;
    // nonce 过期：丢缓存；带了新 challenge 就换 nonce 重试一次，否则按普通 401 上交
    digestCache.delete(key);
    const renewed = parseDigestChallenge(r.headers["www-authenticate"]);
    if (!renewed) return r;
    const cred: DigestCred = { username: auth.username, password: auth.password, challenge: renewed, nc: 0 };
    digestCache.set(key, cred);
    return dispatch(digestHeader(cred));
  }

  // 首次：Basic（Radicale/Nextcloud 走这条路，行为不变）
  const r = await dispatch(withAuth(basicAuthHeader(auth.username, auth.password)));
  if (r.status !== 401) return r;
  const challenge = parseDigestChallenge(r.headers["www-authenticate"]);
  if (!challenge) return r; // 真·密码错（Basic 服务器）→ 原样返回，调用方文案不变
  const cred: DigestCred = { username: auth.username, password: auth.password, challenge, nc: 0 };
  digestCache.set(key, cred);
  console.info("[caldav] 服务器要求 Digest 认证，已协商（Baïkal 类服务器只认 Digest）");
  return dispatch(digestHeader(cred));
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
  }
}
