/**
 * 极简 CalDAV 客户端：发现 / 拉取 / 上传 / 删除 / sync-token 增量
 */
import type { CalCalendar, CalItem } from "./types";
import { httpRequest, HttpError, isNetworkLevelError, type HttpResult, type Channel } from "./http";
import { itemsFromICS } from "./ics";

export interface DavAuth {
  username: string;
  password: string;
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

/** 从服务端返回的 URL / href 归一化为绝对地址 */
export function toAbsolute(base: string, href: string): string {
  try {
    return new URL(href, base.endsWith("/") ? base : base + "/").toString();
  } catch {
    return joinUrl(base, href);
  }
}

async function dav(
  url: string,
  method: string,
  body: string,
  channel: Channel,
  auth: DavAuth,
  depth = "0",
  extraHeaders: Record<string, string> = {}
): Promise<HttpResult> {
  return httpRequest(
    url,
    {
      method,
      body,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        Depth: depth,
        ...extraHeaders
      },
      timeoutMs: 30000
    },
    channel,
    auth
  );
}

function pickHrefXml(xml: string): string[] {
  // 不做完整 XML 解析，提取 <D:href> / <href>（CalDAV 服务端响应结构固定）
  const out: string[] = [];
  const re = /<(?:[A-Za-z0-9_-]+:)?href>([^<]+)<\/(?:[A-Za-z0-9_-]+:)?href>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

function pickTextXml(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}[^>]*>([^<]*)</(?:[A-Za-z0-9_-]+:)?${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

export interface DiscoverResult {
  principal?: string;
  home?: string;
  calendars: CalCalendar[];
}

const COLORS = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"];

/** 自动发现：principal -> calendar-home -> 日历集合列表 */
export async function discoverCalendars(
  serverUrl: string,
  channel: Channel,
  auth: DavAuth,
  hintPath = ""
): Promise<DiscoverResult> {
  const base = serverUrl.endsWith("/") ? serverUrl : serverUrl + "/";
  let home = hintPath ? toAbsolute(base, hintPath) : "";

  // 1. current-user-principal（有 hint 时跳过）
  let principal = "";
  if (!home) {
    const res = await dav(
      base,
      "PROPFIND",
      `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`,
      channel,
      auth
    );
    if (res.status === 401) throw new HttpError(401, "认证失败（401），请检查用户名密码");
    if (res.status >= 400) throw new HttpError(res.status, `发现 principal 失败: HTTP ${res.status}`);
    const hrefs = pickHrefXml(res.body);
    const cur = /<(?:[A-Za-z0-9_-]+:)?current-user-principal[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?current-user-principal>/.exec(res.body);
    if (cur) {
      const inner = pickHrefXml(cur[1]);
      principal = inner[0] || "";
    } else if (hrefs.length) {
      principal = hrefs[0];
    }
    if (!principal) throw new HttpError(res.status, "无法定位 principal（服务器不标准），请手动填写日历路径");
    home = toAbsolute(base, principal);
  }

  // 2. calendar-home-set
  const homeRes = await dav(
    home,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><D:prop><c:calendar-home-set/></D:prop></D:propfind>`,
    channel,
    auth
  );
  if (homeRes.status < 400) {
    const cur = /<(?:[A-Za-z0-9_-]+:)?calendar-home-set[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?calendar-home-set>/.exec(homeRes.body);
    const inner = cur ? pickHrefXml(cur[1]) : [];
    if (inner[0]) home = toAbsolute(base, inner[0]);
  }

  // 3. 枚举日历集合（Depth 1）
  const listRes = await dav(
    home,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="urn:ietf:params:xml:ns:caldav-extensions"><D:prop><D:resourcetype/><D:displayname/><cs:getctag/><a:calendar-color/><D:current-user-privilege-set/></D:prop></D:propfind>`,
    channel,
    auth,
    "1"
  );
  if (listRes.status >= 400) throw new HttpError(listRes.status, `枚举日历失败: HTTP ${listRes.status}`);

  const calendars: CalCalendar[] = [];
  // 按 <response> 分块
  const chunks = listRes.body.split(/<(?:[A-Za-z0-9_-]+:)?response>/i).slice(1);
  let colorIdx = 0;
  for (const chunk of chunks) {
    const href = pickHrefXml(chunk)[0];
    if (!href) continue;
    if (!/<(?:[A-Za-z0-9_-]+:)?calendar\s*\/?>/.test(chunk)) continue; // 必须含 <calendar/> 资源类型
    const names = pickTextXml(chunk, "displayname");
    const name = (names[0] || decodeURIComponent(href.replace(/\/+$/, "").split("/").pop() || "")).trim();
    const colorM = /<(?:[A-Za-z0-9_-]+:)?calendar-color[^>]*>([^<]*)</.exec(chunk);
    let color = colorM ? colorM[1].trim() : "";
    if (/^#[0-9a-fA-F]{8}$/.test(color)) color = color.slice(0, 7);
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = COLORS[colorIdx++ % COLORS.length];
    const supported = pickHrefXml(chunk); // 无用，占位
    void supported;
    const compM = chunk.match(/<(?:[A-Za-z0-9_-]+:)?comp[^>]*name="(VEVENT|VTODO)"/g);
    let supportsEvent = true;
    let supportsTodo = true;
    if (compM && compM.length) {
      const set = new Set(compM.map((c) => /name="(VEVENT|VTODO)"/.exec(c)![1]));
      supportsEvent = set.has("VEVENT");
      supportsTodo = set.has("VTODO");
      if (!set.size) { supportsEvent = true; supportsTodo = true; }
    }
    const url = toAbsolute(base, href);
    const desc = pickTextXml(chunk, "description")[0] || "";
    calendars.push({
      url,
      displayName: name || "日历",
      color, // 向下兼容镜像，恒等于 eventColor
      eventColor: color,
      todoColor: color,
      enabled: true,
      supportsEvent,
      supportsTodo,
      description: desc
    });
  }
  return { principal: principal || undefined, home, calendars };
}

/** 全量拉取一个日历（calendar-query 时间窗） */
export async function fetchCalendarItems(
  cal: CalCalendar,
  channel: Channel,
  auth: DavAuth,
  rangeStartIsoUtc: string,
  rangeEndIsoUtc: string
): Promise<{ items: CalItem[]; syncToken?: string }> {
  // RFC 4791：同一层 comp-filter 为 AND 语义，VEVENT 与 VTODO 必须分两次查询
  const kindFilters: string[] = [];
  if (cal.supportsEvent !== false) {
    kindFilters.push(`<c:comp-filter name="VEVENT"><c:time-range start="${rangeStartIsoUtc}" end="${rangeEndIsoUtc}"/></c:comp-filter>`);
  }
  if (cal.supportsTodo) {
    kindFilters.push(`<c:comp-filter name="VTODO"/>`);
  }
  const items: CalItem[] = [];
  for (const compFilter of kindFilters) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><c:calendar-data/></D:prop>
  <c:filter><c:comp-filter name="VCALENDAR">${compFilter}</c:comp-filter></c:filter>
</c:calendar-query>`;
    const res = await dav(cal.url, "REPORT", body, channel, auth, "1");
    if (res.status >= 400) throw new HttpError(res.status, `拉取日历失败: HTTP ${res.status}`);
    items.push(...parseMultistatus(res.body, cal));
  }
  return { items, syncToken: undefined };
}

/**
 * 取 URL / href 的文件名。
 *
 * 对账时必须拿它比：服务端 PROPFIND 回的多半是**路径**（`/dav/cal/x.ics`），
 * 而本地存的是**完整 URL**（`http://host/dav/cal/x.ics`），直接比字符串永远不等。
 * 同一个日历集合内文件名唯一，比 basename 最稳（也顺手吃掉 %40 之类的转义差异）。
 */
export function fileNameOf(url: string): string {
  // 先切 basename 再解码：畸形转义（如 "%E0%A4%A"）时退回**未解码的 basename**，
  // 而不是整条 URL —— 否则同一条资源在两处算出的名字不一致，对账会误判。
  const raw = String(url || "").split("/").filter(Boolean).pop() || "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 列出日历集合下**所有**资源的文件名（PROPFIND Depth:1，只取 href 不取正文）。
 *
 * 用途：同步后的「幽灵条目对账」（见 sync.ts 的 reconcile）——
 * 本地记着 etag 却被服务端删掉的条目，**不会被任何增量查询报出来**
 * （deletedHrefs 只在增量路径产出，sync-token 失效回退全量时恒为空）。
 * 这里直接要一份完整清单来比对，与 sync-token / time-range 都无关。
 */
export async function listResourceNames(cal: CalCalendar, channel: Channel, auth: DavAuth): Promise<string[]> {
  const res = await httpRequest(
    cal.url,
    {
      method: "PROPFIND",
      headers: { "Content-Type": "application/xml; charset=utf-8", Depth: "1" },
      body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>`,
      timeoutMs: 20000
    },
    channel,
    auth
  );
  if (res.status >= 400) throw new HttpError(res.status, `列出日历资源失败: HTTP ${res.status}`);
  return [...res.body.matchAll(/<(?:[A-Za-z0-9_-]+:)?href[^>]*>([^<]*)</g)]
    .map((m) => fileNameOf(m[1]))
    .filter((n) => /\.ics$/i.test(n));
}

/** sync-token 增量拉取：返回 变更条目 + 已删除 href */
export async function syncCollection(
  cal: CalCalendar,
  channel: Channel,
  auth: DavAuth,
  syncToken: string
): Promise<{ items: CalItem[]; deletedHrefs: string[]; syncToken?: string }> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token>${syncToken}</D:sync-token>
  <D:sync-level>1</D:sync-level>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;
  const res = await dav(cal.url, "REPORT", body, channel, auth, "1");
  if (res.status >= 400) throw new HttpError(res.status, `增量同步失败: HTTP ${res.status}`);
  const tokenM = /<(?:[A-Za-z0-9_-]+:)?sync-token[^>]*>([^<]*)</.exec(res.body);
  const deletedHrefs: string[] = [];
  const chunks = res.body.split(/<(?:[A-Za-z0-9_-]+:)?response>/i).slice(1);
  const changed: string[] = [];
  for (const chunk of chunks) {
    const href = pickHrefXml(chunk)[0] || "";
    const status = pickTextXml(chunk, "status")[0] || "";
    if (/404/.test(status) || /<deleted|status>HTTP[^<]*404/.test(chunk)) deletedHrefs.push(href);
    else changed.push(href);
  }
  let items: CalItem[] = [];
  if (changed.length) {
    items = await multiget(cal, channel, auth, changed);
  }
  return { items, deletedHrefs, syncToken: tokenM ? tokenM[1].trim() : undefined };
}

/** calendar-multiget 精确取回 ICS 数据 */
async function multiget(cal: CalCalendar, channel: Channel, auth: DavAuth, hrefs: string[]): Promise<CalItem[]> {
  const base = cal.url;
  const items: CalItem[] = [];
  // 分批 50 个
  for (let i = 0; i < hrefs.length; i += 50) {
    const batch = hrefs.slice(i, i + 50);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><c:calendar-data/></D:prop>
  ${batch.map((h) => `<D:href>${escapeXml(h)}</D:href>`).join("\n  ")}
</c:calendar-multiget>`;
    const res = await dav(base, "REPORT", body, channel, auth, "1");
    if (res.status >= 400) throw new HttpError(res.status, `multiget 失败: HTTP ${res.status}`);
    items.push(...parseMultistatus(res.body, cal));
  }
  return items;
}

function parseMultistatus(xml: string, cal: CalCalendar): CalItem[] {
  const items: CalItem[] = [];
  const chunks = xml.split(/<(?:[A-Za-z0-9_-]+:)?response>/i).slice(1);
  for (const chunk of chunks) {
    const href = pickHrefXml(chunk)[0] || "";
    const etag = pickTextXml(chunk, "getetag")[0] || "";
    const calDataM = /<(?:[A-Za-z0-9_-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?calendar-data>/i.exec(chunk);
    if (!href || !calDataM) continue;
    let ics = calDataM[1];
    // XML 实体还原
    ics = ics.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    items.push(...itemsFromICS(ics, cal.url, toAbsolute(cal.url, href), etag.replace(/^"|"$/g, "")));
  }
  return items;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface PutResult {
  etag?: string;
}

/** 上传/修改条目；etag 提供 If-Match */
export async function putItem(item: CalItem, ics: string, channel: Channel, auth: DavAuth): Promise<PutResult> {
  const headers: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" };
  if (item.etag) headers["If-Match"] = `"${item.etag}"`;
  const res = await httpRequest(
    item.href,
    { method: "PUT", body: ics, headers, timeoutMs: 30000 },
    channel,
    auth
  );
  if (res.status === 412) throw new HttpError(412, "服务端已变更（412 冲突）");
  if (res.status >= 400) throw new HttpError(res.status, `上传失败: HTTP ${res.status}`);
  const etag = (res.headers["etag"] || res.headers["etag".toLowerCase()] || "").replace(/^"|"$/g, "");
  return { etag: etag || undefined };
}

/** 删除服务端条目 */
export async function deleteItem(item: CalItem, channel: Channel, auth: DavAuth): Promise<void> {
  const headers: Record<string, string> = {};
  if (item.etag) headers["If-Match"] = `"${item.etag}"`;
  const res = await httpRequest(item.href, { method: "DELETE", headers, timeoutMs: 30000 }, channel, auth);
  if (res.status >= 400 && res.status !== 404) {
    throw new HttpError(res.status, `删除失败: HTTP ${res.status}`);
  }
}

/**
 * 把网络级失败翻译成用户能照着做的提示。
 * 「Failed to fetch」是浏览器在请求根本没发出去时的笼统报错，
 * 与密码无关（密码错会返回 401）——手机端多半是 WebView 拦了明文 HTTP / 跨域。
 */
export function describeNetworkError(e: unknown, channel: Channel): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  if (!isNetworkLevelError(e)) return raw;
  if (channel === "direct") {
    return `请求未能到达服务器（${raw}）——浏览器直连被拦截（跨域或明文 HTTP），请把「请求通道」改为「自动」或「仅思源内核代理」后重试`;
  }
  return `请求未能到达服务器（${raw}）——请检查服务器地址、端口与网络连通性`;
}

/** 测试连接：PROPFIND 根集合 */
export async function testConnection(serverUrl: string, channel: Channel, auth: DavAuth): Promise<{ ok: boolean; message: string }> {
  try {
    const base = serverUrl.endsWith("/") ? serverUrl : serverUrl + "/";
    const res = await dav(
      base,
      "PROPFIND",
      `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`,
      channel,
      auth
    );
    if (res.status === 401) return { ok: false, message: "认证失败（401）：用户名或密码错误" };
    if (res.status >= 400) return { ok: false, message: `服务器返回 HTTP ${res.status}` };
    return { ok: true, message: `连接成功（${res.via === "proxy" ? "内核代理" : "直连"}，${res.elapsedMs}ms）` };
  } catch (e: any) {
    return { ok: false, message: "连接失败: " + describeNetworkError(e, channel) };
  }
}

/** 服务端时间窗 ISO（UTC 基本格式 20260101T000000Z） */
export function icsRangeIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
