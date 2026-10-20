/**
 * ICS (RFC 5545) 解析与序列化
 * - 解析 VEVENT / VTODO（含 VALARM、RRULE、EXDATE、RECURRENCE-ID）
 * - 序列化时在原 ICS 基础上替换目标组件，尽量保留本插件不管理的属性（ORGANIZER / ATTENDEE 等）
 * - 写出的时间统一为 UTC（Z 后缀），避免时区歧义
 */
import type { Alarm, CalAttachment, CalItem, CalKind, CalSettings, LocalStamp, Recurrence } from "./types";
import {
  dateStampOfMs, isDateOnly, parseLocalStamp, stampOfMs, zoneOffsetMs, weekdayIndexOfCode, padDate
} from "./date";
import { pad2 } from "./types";

/**
 * 单个内联附件的**默认**硬上限（MB，2026-10-15，设置项可改）。
 *
 * 实测根因：用户传了个 74MB 的 zip，base64 化后 ICS 约 99MB —— Radicale 默认
 * `max_resource_size` 只有 10MB（其 config.py 里写死 `10000000`），PUT 直接 413；
 * Nextcloud/PHP 默认 `post_max_size` 也只有 8MB。放进去的结果只有一个：
 * **这个待办永远同步不过**，而且每次重试都把整份 ICS 再推一遍（auto 通道还会
 * 被内核代理再 base64 一遍 → ~132MB），报出来还是含糊的「网络请求失败」。
 * 所以超过上限在挑选时就直接拒绝，不给用户造出同步不过的条目。
 */
export const ATTACH_SIZE_MAX_MB = 5;

/**
 * 整份 ICS 的**默认**硬上限（MB）——含全部 base64 附件在内的**真实序列化结果**。
 *
 * 单文件上限挡不住「多个 4MB 凑 12MB」，所以保存前按序列化出的 ICS 卡总账。
 * 默认 10MB 对齐 Radicale 的默认 `max_resource_size`；自己的服务器上限更大
 * （或更小）就在设置里改，报错文案里的数字也取设置值。
 */
export const ICS_SIZE_MAX_MB = 10;

/** MB → 字节；非法值（undefined/0/负数/NaN）回退默认值 */
export function mbToBytes(mb: number | undefined, fallbackMB: number): number {
  const v = typeof mb === "number" && Number.isFinite(mb) && mb > 0 ? mb : fallbackMB;
  return v * 1024 * 1024;
}

/** 生效的单附件上限（字节）——设置里可改，老数据缺省回默认 5MB */
export function attachSizeMaxBytes(s?: CalSettings | null): number {
  return mbToBytes(s?.attachSizeMaxMB, ATTACH_SIZE_MAX_MB);
}

/** 生效的整份 ICS 上限（字节）——设置里可改，老数据缺省回默认 10MB */
export function icsSizeMaxBytes(s?: CalSettings | null): number {
  return mbToBytes(s?.icsSizeMaxMB, ICS_SIZE_MAX_MB);
}

export interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  type: string;
  props: IcsProp[];
  children: IcsComponent[];
}

// ---------- 基础解析 ----------

function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.length > 0);
}

function parseProp(line: string): IcsProp {
  // NAME;PARAM=V;PARAM=V:value  （value 中可含冒号）
  let inQuote = false;
  let splitAt = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) { splitAt = i; break; }
  }
  if (splitAt < 0) return { name: line.toUpperCase(), params: {}, value: "" };
  const head = line.slice(0, splitAt);
  const value = line.slice(splitAt + 1);
  const segs = head.split(";");
  const name = segs[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < segs.length; i++) {
    const eq = segs[i].indexOf("=");
    if (eq > 0) params[segs[i].slice(0, eq).toUpperCase()] = segs[i].slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

export function parseICS(text: string): IcsComponent {
  const root: IcsComponent = { type: "ROOT", props: [], children: [] };
  const stack: IcsComponent[] = [root];
  for (const line of unfold(text)) {
    const m = /^(BEGIN|END):(.+)$/i.exec(line);
    if (m) {
      const type = m[2].trim().toUpperCase();
      if (m[1].toUpperCase() === "BEGIN") {
        const comp: IcsComponent = { type, props: [], children: [] };
        stack[stack.length - 1].children.push(comp);
        stack.push(comp);
      } else {
        while (stack.length > 1 && stack[stack.length - 1].type !== type) stack.pop();
        if (stack.length > 1) stack.pop();
      }
      continue;
    }
    stack[stack.length - 1].props.push(parseProp(line));
  }
  return root;
}

function findComponents(comp: IcsComponent, type: string, out: IcsComponent[] = []): IcsComponent[] {
  for (const c of comp.children) {
    if (c.type === type) out.push(c);
    findComponents(c, type, out);
  }
  return out;
}

function firstProp(comp: IcsComponent, name: string): IcsProp | undefined {
  return comp.props.find((p) => p.name === name);
}

// ---------- 时间值解析 ----------

/**
 * 全天事件判定（2026-10-20 雄哥报障「Outlook 建的全天事件在周视图变成 00:00 一条线」后放宽）。
 *
 * 两种形态都算全天：
 * ① `YYYYMMDD` —— 标准 VALUE=DATE；
 * ② `YYYYMMDDT000000` 且 DTEND 缺失、或同为某日 `T000000` —— Outlook / Windows 邮件系
 *    客户端（PRODID MailClient.VObject）向不支持 DATE 值的 CalDAV 服务器（Baïkal 等）
 *    建「全天」时的降级写法：人在定时事件里根本设不出「00:00 开始、00:00 结束、
 *    零时长」，DTEND 要么同日 000000（单日全天）、要么排他次日/多日 000000。
 *    实测样本（10-03 Outlook 建）：DTSTART:20260928T000000 / DTEND:20260928T000000。
 *
 * ⚠️ 仅事件：待办（VTODO）没有「全天」概念，恒 false。
 * ⚠️ start 是 000000 但 DTEND 带真实时分（如 T120000）= 有真实时长的事件，不算全天。
 */
function isAllDayEvent(startVal: string, endVal: string, kind: CalKind): boolean {
  if (kind !== "event" || !startVal) return false;
  if (/^\d{8}$/.test(startVal)) return true;
  return /^\d{8}T000000$/.test(startVal) && (endVal === "" || /^\d{8}T000000$/.test(endVal));
}

function parseIcsStamp(prop: IcsProp, forceDateOnly?: boolean): LocalStamp {
  const v = prop.value.trim();
  // DATE 值
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return stampOfMs(Date.now());
  const [, y, mo, d, hh, mi, ss, z] = m;
  // 全天事件的 T000000 降级形态按 DATE 值收：只取日期部分，与标准 VALUE=DATE 在内存里
  // 完全一致（start/end 都是 date-only），occurrences / 序列化 / 编辑器全部走既有全天
  // 路径，零附带影响；时区换算对全天无意义，直接跳过。
  if (forceDateOnly) return `${y}-${mo}-${d}`;
  if (z === "Z") {
    const ms = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
    return stampOfMs(ms);
  }
  const tzid = prop.params["TZID"];
  if (tzid) {
    const naive = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
    const guess = naive - zoneOffsetMs(tzid, naive);
    const ms = naive - zoneOffsetMs(tzid, guess);
    return stampOfMs(ms);
  }
  return `${y}-${mo}-${d}T${hh}:${mi}:${ss}`; // 浮动时间按本地
}

// ---------- RRULE / EXDATE ----------

export function parseRRule(value: string): Recurrence | undefined {
  const parts: Record<string, string> = {};
  for (const seg of value.split(";")) {
    const eq = seg.indexOf("=");
    if (eq > 0) parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  const freq = (parts["FREQ"] || "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return undefined;
  const r: Recurrence = {
    freq: freq as Recurrence["freq"],
    interval: parts["INTERVAL"] ? Math.max(1, +parts["INTERVAL"] || 1) : 1
  };
  if (parts["BYDAY"]) r.byDay = parts["BYDAY"].split(",").map((s) => s.trim().slice(-2).toUpperCase());
  if (parts["BYMONTHDAY"]) r.byMonthDay = parts["BYMONTHDAY"].split(",").map((n) => +n).filter((n) => n);
  if (parts["COUNT"]) r.count = +parts["COUNT"];
  if (parts["UNTIL"]) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(parts["UNTIL"]);
    if (m) {
      r.until = m[4]
        ? stampOfMs(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
        : `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
  return r;
}

export function serializeRRule(r: Recurrence): string {
  const segs = [`FREQ=${r.freq}`];
  if (r.interval > 1) segs.push(`INTERVAL=${r.interval}`);
  if (r.byDay?.length) segs.push(`BYDAY=${r.byDay.join(",")}`);
  if (r.byMonthDay?.length) segs.push(`BYMONTHDAY=${r.byMonthDay.join(",")}`);
  if (r.count) segs.push(`COUNT=${r.count}`);
  if (r.until) {
    const d = parseLocalStamp(r.until);
    if (isDateOnly(r.until)) segs.push(`UNTIL=${r.until.replace(/-/g, "")}`);
    else segs.push(`UNTIL=${icsUtc(d.getTime())}`);
  }
  return segs.join(";");
}

function parseExdates(comp: IcsComponent): LocalStamp[] {
  const out: LocalStamp[] = [];
  for (const p of comp.props) {
    if (p.name === "EXDATE") {
      for (const v of p.value.split(",")) out.push(parseIcsStamp({ ...p, value: v.trim() }));
    }
  }
  return out;
}

// ---------- 组件 -> CalItem ----------

/**
 * 从 URI 取附件显示用的文件名（2026-10-14）。
 *
 * 取名失败时回退到 FBTYPE 的扩展名（Apple 的内嵌件常用 `fbdoc` 之类），
 * 再不行给个通用名 —— **界面上总得有个名字显示**，空着会让行看不出是附件。
 */
function attachmentName(uri: string, fmttype?: string): string {
  const path = uri.split(/[?#]/)[0];
  const last = path.split("/").filter(Boolean).pop();
  if (last) return decodeURIComponent(last);
  const sub = fmttype ? "." + fmttype.split("/").pop() : "";
  return "附件" + (sub && sub !== "." ? sub : "");
}

/**
 * 二进制附件的文件名 → X-FILENAME 参数值。
 *
 * **裸写优先**（2026-10-19 晚修正）：X-FILENAME 是 Apple 系客户端（macOS Calendar /
 * iOS）的惯例、值为裸文件名，emClient 等外部客户端原样显示参数值。第一版整体
 * `encodeURIComponent` 导致所有外部客户端看到 `%E5%91%A8…` 乱码（雄哥实测）。
 *
 * 只对会破坏 ICS 行结构的字符编码：
 *  - `%`——自身是编码引入符，不编码的话解析端 decode 会误读/抛错（`50%.pdf`）；
 *  - `;`——参数分隔符（序列化与解析都按它拆段）；
 *  - `,`——多值属性分隔符；
 *  - `:`——属性名/值分隔符；
 *  - `"`——引号（我们的序列化器不生成 quoted-string，见 propLine）。
 * 控制字符直接剔除。中文等非 ASCII **裸写**：ICS 文件本身 UTF-8， Radicale /
 * SabreDAV 及各客户端原样透传；Apple 惯例同样裸写。
 */
function icsFilenameParam(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[%/,:;"]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

/** X-FILENAME 参数值 → 文件名。防御性解码：别的客户端可能写了非 %XX 的怪值（如裸 `50%.pdf`），
 *  decodeURIComponent 会抛 URIError——此时原样返回，总比丢名字好。 */
function safeDecodeFilename(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function itemFromComponent(
  comp: IcsComponent,
  kind: CalKind,
  calendarUrl: string,
  href: string,
  etag?: string,
  raw?: string
): CalItem | undefined {
  const uid = firstProp(comp, "UID")?.value || href;
  const summary = unescapeText(firstProp(comp, "SUMMARY")?.value || "");
  const dtstartProp = firstProp(comp, "DTSTART");
  const dueProp = firstProp(comp, "DUE");
  const dtendProp = firstProp(comp, "DTEND");
  // 事件以 DTSTART 为准；待办 DTSTART = 开始、DUE = 截止，旧数据只有 DUE 时用作兜底
  const startProp = kind === "event" ? dtstartProp : dtstartProp || dueProp;
  if (!startProp && kind === "event") return undefined;
  // 全天判定要同时看 DTEND（Outlook 降级形态靠「end 也是 000000」认），故提前取出来
  const allDay = isAllDayEvent(
    startProp ? startProp.value.trim() : "",
    dtendProp ? dtendProp.value.trim() : "",
    kind
  );
  const item: CalItem = {
    uid,
    kind,
    calendarUrl,
    href,
    etag,
    // **必须把整份资源原文带下来**（不是单个组件）。
    // 编辑走 `itemToEditedICS(item)`：它重新解析 raw、只重建 UID 匹配的那个组件，
    // 其余内容（VTIMEZONE、同一资源里的其它组件、ATTACH 二进制件、ORGANIZER、
    // ATTENDEE、X- 扩展属性…）原样带回。少了它就会退化成 `itemToNewICS` 整份重拼，
    // 上面这些**全部丢失** —— 2026-10-14 实测：改个标题就把服务端的附件抹没了。
    // 同一资源含多个组件时它们共享同一份 raw，靠 UID（+RECURRENCE-ID）区分。
    raw,
    summary,
    allDay,
    start: startProp ? parseIcsStamp(startProp, allDay) : ""
  };
  const desc = firstProp(comp, "DESCRIPTION");
  if (desc?.value) item.description = unescapeText(desc.value);
  const loc = firstProp(comp, "LOCATION");
  if (loc?.value) item.location = unescapeText(loc.value);
  const cats = firstProp(comp, "CATEGORIES");
  if (cats?.value) item.categories = cats.value.split(",").map((s) => unescapeText(s.trim())).filter(Boolean);
  // 附件：ATTACH 可出现多次，必须遍历（firstProp 只能拿到第一个）。
  // 两种形式都收：URI（外链）与 VALUE=BINARY（内嵌 base64）。
  // ⚠️ 二进制件**必须进 item.attachments**：编辑时 rebuildComponent 按这个列表重写，
  //    漏收就等于编辑一次把服务端的内嵌附件抹掉（2026-10-14 实测事故）。
  //    `unfold()` 已经把折行拼回来，所以 p.value 是完整 base64，直接存即可。
  const atts: CalAttachment[] = [];
  for (const p of comp.props) {
    if (p.name !== "ATTACH") continue;
    const fmttype = p.params.FMTTYPE || p.params.FBTYPE;
    if ((p.params.VALUE || "").toUpperCase() === "BINARY") {
      const b64 = (p.value || "").replace(/\s+/g, "");
      if (!b64) continue;
      // 文件名：优先 X-FILENAME 参数（Apple 系/emClient 等客户端用它带原名），否则按 MIME 推个扩展名。
      // ⚠️ 必须走 safeDecodeFilename：我们只编码 `%/,:;"` 五个字符（见 icsFilenameParam），
      //    但别的客户端可能写裸 `%` 值，无脑 decodeURIComponent 会抛 URIError 丢名字。
      const fname = p.params["X-FILENAME"];
      atts.push({
        b64,
        name: fname ? safeDecodeFilename(fname) : attachmentName("", fmttype),
        fmttype
      });
      continue;
    }
    const uri = unescapeText(p.value || "").trim();
    if (!uri) continue;
    atts.push({ uri, name: attachmentName(uri, fmttype), fmttype });
  }
  if (atts.length) item.attachments = atts;
  if (kind === "event") {
    if (dtendProp) {
      item.end = parseIcsStamp(dtendProp, allDay);
    } else {
      const dur = firstProp(comp, "DURATION");
      if (dur) {
        const mins = parseDurationMinutes(dur.value);
        item.end = addMinutesStamp(item.start, mins);
      } else {
        item.end = item.allDay ? addDaysStamp(item.start, 1) : item.start;
      }
    }
  } else {
    item.end = dueProp ? parseIcsStamp(dueProp) : undefined;
    const pr = firstProp(comp, "PRIORITY");
    if (pr?.value) item.priority = +pr.value || 0;
    const st = firstProp(comp, "STATUS");
    if (st?.value) item.status = st.value.toUpperCase();
    const pc = firstProp(comp, "PERCENT-COMPLETE");
    if (pc?.value) item.percent = Math.min(100, Math.max(0, +pc.value || 0));
    const cm = firstProp(comp, "COMPLETED");
    if (cm?.value) item.completedAt = parseIcsStamp(cm);
    if (item.status === "COMPLETED") item.percent = 100;
  }
  const rr = firstProp(comp, "RRULE");
  if (rr?.value) item.rrule = parseRRule(rr.value);
  const created = firstProp(comp, "CREATED");
  if (created?.value) item.createdAt = parseIcsStamp(created);
  const rid = firstProp(comp, "RECURRENCE-ID");
  if (rid) item.recurId = parseIcsStamp(rid);
  const ex = parseExdates(comp);
  if (ex.length) item.exdates = ex;
  const alarms: Alarm[] = [];
  for (const a of findComponents(comp, "VALARM")) {
    const trig = firstProp(a, "TRIGGER");
    if (!trig) continue;
    const m = /^-?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(trig.value.trim().toUpperCase());
    if (m) {
      const mins = (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
      if (trig.value.trim().toUpperCase().startsWith("-P") || mins === 0) alarms.push({ minutesBefore: mins });
    }
  }
  if (alarms.length) item.alarms = alarms;
  return item;
}

function parseDurationMinutes(v: string): number {
  const m = /^[+-]?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(v.toUpperCase());
  if (!m) return 0;
  return (+(m[1] || 0)) * 10080 + (+(m[2] || 0)) * 1440 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
}

function addMinutesStamp(stamp: LocalStamp, mins: number): LocalStamp {
  if (isDateOnly(stamp)) return stamp;
  const d = parseLocalStamp(stamp);
  return stampOfMs(d.getTime() + mins * 60000);
}

function addDaysStamp(stamp: LocalStamp, days: number): LocalStamp {
  const d = parseLocalStamp(stamp);
  d.setDate(d.getDate() + days);
  return dateStampOfMs(d.getTime());
}

/** 解析一个 ICS 文本为条目列表（同文件多组件时各取一条，href 相同） */
export function itemsFromICS(text: string, calendarUrl: string, href: string, etag?: string): CalItem[] {
  const root = parseICS(text);
  const items: CalItem[] = [];
  for (const comp of findComponents(root, "VEVENT")) {
    const it = itemFromComponent(comp, "event", calendarUrl, href, etag, text);
    if (it) items.push(it);
  }
  for (const comp of findComponents(root, "VTODO")) {
    const it = itemFromComponent(comp, "todo", calendarUrl, href, etag, text);
    if (it) items.push(it);
  }
  return items;
}

// ---------- 文本转义 ----------

export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

export function unescapeText(s: string): string {
  // 单次扫描：一把匹配所有 `\X` 转义序列。
  // ⚠️ 不能拆成多轮 replace（旧版 `/\\n/gi → \, → \; → \\` 四轮）：escape 后的字面
  //    「反斜杠+n」是 `a\\\\nb`，先跑 `\n` 轮会把 `\\n` 尾部误判成换行，读回来变成
  //    「反斜杠+真换行」——用户内容保真丢失（2026-10-19 雄哥问 ICS 转义机制时复查发现）。
  //    单次扫描下每个 `\X` 只被消费一次，不存在二次匹配。
  // 大小写：RFC 5545 允许 `\n` 与 `\N`，都解成换行。未知转义（`\x`）原样保留（宽容解析）。
  return s.replace(/\\(n|N|,|;|\\)/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

// ---------- 序列化 ----------

function icsUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

function stampToIcs(stamp: LocalStamp, dateOnly: boolean): string {
  if (dateOnly) return stamp.replace(/-/g, "");
  return icsUtc(parseLocalStamp(stamp).getTime());
}

function foldLine(line: string): string {
  // 按 74 字节折叠（近似：按码元折叠，ASCII 场景精确）
  if (line.length <= 74) return line;
  const parts: string[] = [line.slice(0, 74)];
  let rest = line.slice(74);
  while (rest.length > 73) {
    parts.push(" " + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  if (rest) parts.push(" " + rest);
  return parts.join("\r\n");
}

/** 本插件管理的属性名（编辑时重建，其余属性原样保留） */
const MANAGED = new Set([
  "UID", "SUMMARY", "DESCRIPTION", "LOCATION", "CATEGORIES",
  "DTSTART", "DTEND", "DUE", "DURATION", "RRULE", "EXDATE", "RECURRENCE-ID",
  "STATUS", "PRIORITY", "PERCENT-COMPLETE", "COMPLETED",
  "DTSTAMP", "LAST-MODIFIED", "SEQUENCE", "TZID",
  // ATTACH 进白名单，界面上增删附件才能真正落到 ICS。
  // 二进制内联件也走这条：解析时收进 item.attachments，编辑时按列表重写。
  // 老数据（attachments 为 undefined）在 rebuildComponent 里原样带回，不会丢。
  "ATTACH"
]);

function propLine(name: string, params: Record<string, string>, value: string): string {
  let head = name;
  for (const k of Object.keys(params)) head += `;${k}=${params[k]}`;
  return foldLine(`${head}:${value}`);
}

/** 重建目标组件的属性列表：保留未管理属性，重写受管理属性 */
function rebuildComponent(comp: IcsComponent, item: CalItem): IcsComponent {
  const kept = comp.props.filter((p) => !MANAGED.has(p.name));
  const props: IcsProp[] = [];
  const push = (name: string, value: string, params: Record<string, string> = {}) => {
    if (value !== "" && value !== undefined) props.push({ name, params, value });
  };
  push("UID", firstProp(comp, "UID")?.value || item.uid);
  // 保留的时间无关属性
  for (const p of kept) props.push(p);

  push("SUMMARY", escapeText(item.summary || ""));
  if (item.description) push("DESCRIPTION", escapeText(item.description));
  if (item.location) push("LOCATION", escapeText(item.location));
  if (item.categories?.length) push("CATEGORIES", item.categories.map(escapeText).join(","));

  const dateOnly = item.allDay;
  if (item.start) push("DTSTART", stampToIcs(item.start, dateOnly), dateOnly ? { VALUE: "DATE" } : {});
  if (item.kind === "event") {
    const end = item.end || (dateOnly ? addDaysStamp(item.start, 1) : item.start);
    push("DTEND", stampToIcs(end, dateOnly), dateOnly ? { VALUE: "DATE" } : {});
  } else {
    if (item.end) push("DUE", stampToIcs(item.end, dateOnly), dateOnly ? { VALUE: "DATE" } : {});
    if (item.priority) push("PRIORITY", String(item.priority));
    push("STATUS", item.percent === 100 ? "COMPLETED" : item.status === "IN-PROCESS" ? "IN-PROCESS" : "NEEDS-ACTION");
    if (item.percent !== undefined && item.percent > 0) push("PERCENT-COMPLETE", String(item.percent));
    if (item.percent === 100) push("COMPLETED", icsUtc(Date.now()));
  }
  if (item.rrule) push("RRULE", serializeRRule(item.rrule));
  if (item.recurId) push("RECURRENCE-ID", stampToIcs(item.recurId, item.allDay), item.allDay ? { VALUE: "DATE" } : {});
  for (const ex of item.exdates || []) {
    push("EXDATE", stampToIcs(ex, dateOnly), dateOnly ? { VALUE: "DATE" } : {});
  }
  // 附件：按 item.attachments 重写（增删都靠这一步落进 ICS）。
  //
  // ⚠️ `item.attachments === undefined` 是老数据的特征（二进制附件支持之前解析的），
  //    此时插件没有接管附件，**原文里有什么就原样带回什么**（URI 与二进制都不碰）——
  //    否则升级后第一次编辑就会把它们抹掉。
  //    字段一旦存在（哪怕空数组）就说明附件已由插件接管，以它为准。
  if (item.attachments === undefined) {
    for (const p of comp.props) {
      if (p.name === "ATTACH") props.push(p);
    }
  }
  for (const a of item.attachments || []) {
    const uri = (a.uri || "").trim();
    const b64 = (a.b64 || "").replace(/\s+/g, "");
    if (uri) {
      push("ATTACH", escapeText(uri), a.fmttype ? { FMTTYPE: a.fmttype } : {});
    } else if (b64) {
      // 二进制内联：base64 不含需转义的字符，直接写；折行由 compToLines 统一做
      push("ATTACH", b64, {
        VALUE: "BINARY",
        ENCODING: "BASE64",
        ...(a.fmttype ? { FMTTYPE: a.fmttype } : {}),
        // 文件名也必须跟着 ICS 走（2026-10-19 雄哥问「换设备下载能不能恢复原名」发现的缺口）：
        // 原先只写 FMTTYPE，服务器上的 ICS 是无名氏——本机下载走本地 attachments[].name
        // 没事，但换设备/本地数据丢失后从服务端重拉，解析端只能按 MIME 猜个「附件.jpg」。
        // ⚠️ 编码方式（2026-10-19 晚二次修正，雄哥在 emClient 看到乱码）：X-FILENAME 是
        //    Apple 系客户端的惯例、值为**裸文件名**，外部客户端（emClient 实测）原样显示
        //    参数值——整体 encodeURIComponent 会让所有外部客户端看到 %E5%91%A8… 乱码。
        //    故改为**裸写优先**，只编码会破坏 ICS 行结构的字符，见 icsFilenameParam。
        ...(a.name ? { "X-FILENAME": icsFilenameParam(a.name) } : {})
      });
    }
    // 两者都空 = 用户删到一半没填，忽略而不是写个空 ATTACH
  }
  const seq = firstProp(comp, "SEQUENCE");
  push("SEQUENCE", String((seq ? +seq.value || 0 : 0) + 1));
  push("DTSTAMP", icsUtc(Date.now()));
  push("LAST-MODIFIED", icsUtc(Date.now()));
  for (const a of item.alarms || []) {
    props.push({ name: "BEGIN", params: {}, value: "VALARM" });
    props.push({ name: "ACTION", params: {}, value: "DISPLAY" });
    props.push({ name: "DESCRIPTION", params: {}, value: escapeText(item.summary || "提醒") });
    props.push({ name: "TRIGGER", params: {}, value: `-PT${a.minutesBefore}M` });
    props.push({ name: "END", params: {}, value: "VALARM" });
  }
  return { type: comp.type, props, children: [] };
}

function compToLines(comp: IcsComponent): string[] {
  const lines = [`BEGIN:${comp.type}`];
  for (const p of comp.props) {
    const params = Object.entries(p.params).map(([k, v]) => `;${k}=${v}`).join("");
    lines.push(foldLine(`${p.name}${params}:${p.value}`));
  }
  for (const c of comp.children) lines.push(...compToLines(c));
  lines.push(`END:${comp.type}`);
  return lines;
}

/** 生成新建条目的 ICS */
export function itemToNewICS(item: CalItem): string {
  const comp = rebuildComponent(
    { type: item.kind === "event" ? "VEVENT" : "VTODO", props: [], children: [] },
    item
  );
  // 新建：无 SEQUENCE 递增需求，重置为 0
  comp.props = comp.props.filter((p) => p.name !== "SEQUENCE");
  comp.props.push({ name: "CREATED", params: {}, value: icsUtc(Date.now()) });
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WorkBuddy//SiYuan CalDAV//CN",
    ...compToLines(comp),
    "END:VCALENDAR"
  ];
  return lines.join("\r\n") + "\r\n";
}

/** 时间戳的「紧凑形」：2026-10-21T09:00:00 / 20261021T090000 / 20261021 → 20261021090000 / 20261021 */
function compactStamp(s: string): string {
  return s.replace(/[-:T]/g, "").trim();
}

/** 组件的 RECURRENCE-ID 紧凑值（没有则空串）——用于在同一 UID 的多个组件间定位 */
function recurIdOf(comp: IcsComponent): string {
  return compactStamp(firstProp(comp, "RECURRENCE-ID")?.value || "");
}

/** 这条 CalItem 对应的是原文里的哪个组件。
 *
 *  ⚠️ 只比 UID 是错的：周期性条目的「例外」与主条目**UID 相同**，靠 RECURRENCE-ID 区分。
 *  只比 UID 时 `find` 会命中主条目，把例外的改动写进主条目、例外原封不动 —— 两头都错。
 *  必须 UID + RECURRENCE-ID 一起匹配（两者都没有 RECURRENCE-ID 时互相匹配）。
 *  匹配不上就交给调用方报错，**不要**随便抓一个组件往上写。
 *
 *  两边的格式必须归一化后再比：本地 recurId 是 `2026-10-21T09:00:00`（date.ts 口径），
 *  ICS 里是 `20261021T090000`，直接字符串相等永远配不上。
 */
function findTargetComponent(comps: IcsComponent[], item: CalItem): IcsComponent | undefined {
  const want = item.recurId ? compactStamp(item.recurId) : "";
  return comps.find((c) => firstProp(c, "UID")?.value === item.uid && recurIdOf(c) === want);
}

/** 在原 ICS 基础上应用编辑（保留 ORGANIZER / ATTENDEE / VTIMEZONE 等） */
export function itemToEditedICS(item: CalItem): string {
  if (!item.raw) return itemToNewICS(item);
  const root = parseICS(item.raw);
  const target = item.kind === "event" ? "VEVENT" : "VTODO";
  const comps = findComponents(root, target);
  const match = findTargetComponent(comps, item);
  // 原文里找不到目标组件：**绝不能**退回整份重拼。那会把这个资源里的
  // VTIMEZONE / ATTACH / ORGANIZER / 其它组件全部抹掉（2026-10-14 实测的数据丢失）。
  // 抛出来让同步层报错，条目保持脏、下次重试，比静默毁数据好。
  if (!match) {
    throw new Error(
      `ICS 原文里找不到 ${target}（UID=${item.uid}${item.recurId ? " RECURRENCE-ID=" + item.recurId : ""}），` +
        `已中止写入以免丢失其它属性`
    );
  }
  const lines: string[] = [];
  // 注意：parseICS 的根是 ROOT，VCALENDAR / VEVENT / VTODO 都在其下多层，
  // 必须递归下钻才能命中目标组件（只遍历 root.children 会永远打不到）。
  const emit = (c: IcsComponent) => {
    if (c === match) {
      lines.push(...compToLines(rebuildComponent(c, item)));
      return;
    }
    lines.push(`BEGIN:${c.type}`);
    for (const p of c.props) {
      const params = Object.entries(p.params).map(([k, v]) => `;${k}=${v}`).join("");
      lines.push(foldLine(`${p.name}${params}:${p.value}`));
    }
    for (const child of c.children) emit(child);
    lines.push(`END:${c.type}`);
  };
  for (const c of root.children) emit(c);
  return lines.join("\r\n") + "\r\n";
}

/** RRULE 展开给定时间窗内的实例开始时间（不含 EXDATE 过滤） */
export function expandRepeats(item: CalItem, rangeStartMs: number, rangeEndMs: number): LocalStamp[] {
  if (!item.rrule || !item.start) return [item.start];
  const r = item.rrule;
  const interval = Math.max(1, r.interval);
  const durMs = item.end ? parseLocalStamp(item.end).getTime() - parseLocalStamp(item.start).getTime() : 0;
  const out: LocalStamp[] = [];
  const untilMs = r.until ? parseLocalStamp(r.until).getTime() + (isDateOnly(r.until) ? 86399000 : 0) : Infinity;
  const hardUntil = Math.min(untilMs, rangeEndMs);
  const count = r.count && r.count > 0 ? r.count : Infinity;
  const base = parseLocalStamp(item.start);
  const baseMs = base.getTime();
  if (baseMs > hardUntil) return [item.start];

  const padD = (d: Date) => padDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  let produced = 0;
  const pushIfInRange = (d: Date) => {
    const ms = d.getTime();
    if (ms > hardUntil || produced >= count) return false;
    if (ms >= Math.max(rangeStartMs - durMs, baseMs)) {
      out.push(isDateOnly(item.start) ? padD(d) : stampOfMs(ms));
      produced++;
    }
    return ms <= hardUntil && produced <= count;
  };

  if (r.freq === "DAILY") {
    const d = new Date(base);
    for (let i = 0; ; i += interval) {
      d.setTime(baseMs + i * 86400000);
      if (d.getTime() > hardUntil || produced >= count) break;
      pushIfInRange(d);
      if (i * 86400000 > 366 * 86400000 * 5) break; // 安全阀
    }
  } else if (r.freq === "WEEKLY") {
    const byDay = r.byDay?.length ? r.byDay : null;
    const week0 = new Date(base);
    week0.setDate(week0.getDate() - ((week0.getDay() + 6) % 7)); // 周一起点
    // 统一转成「周一 = 0」的偏移，与 week0 对齐
    const toMondayOffset = (sundayBased: number) => (sundayBased + 6) % 7;
    for (let w = 0; ; w += interval) {
      if (produced >= count) break;
      const weekStart = new Date(week0);
      weekStart.setDate(week0.getDate() + w * 7);
      if (weekStart.getTime() - 7 * 86400000 > hardUntil) break;
      const offsets = byDay
        ? byDay.map((c) => toMondayOffset(weekdayIndexOfCode(c))).filter((i) => i >= 0).sort((a, b) => a - b)
        : [toMondayOffset(base.getDay())];
      for (const off of offsets) {
        const d2 = new Date(weekStart);
        d2.setDate(weekStart.getDate() + off);
        d2.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0);
        if (d2.getTime() < baseMs) continue;
        if (d2.getTime() > hardUntil || produced >= count) break;
        pushIfInRange(d2);
      }
      if (weekStart.getTime() > hardUntil) break;
      if (w > 520) break;
    }
  } else if (r.freq === "MONTHLY") {
    for (let m = 0; ; m += interval) {
      if (produced >= count) break;
      const d = new Date(base);
      d.setDate(1);
      d.setMonth(base.getMonth() + m);
      if (d.getFullYear() > base.getFullYear() + 20) break;
      const candidates: Date[] = [];
      if (r.byMonthDay?.length) {
        for (const md of r.byMonthDay) {
          const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
          const dd = Math.min(md < 0 ? last + 1 + md : md, last);
          if (dd >= 1) candidates.push(new Date(d.getFullYear(), d.getMonth(), dd, base.getHours(), base.getMinutes(), base.getSeconds()));
        }
      } else {
        candidates.push(new Date(d));
        candidates[0].setDate(base.getDate());
      }
      candidates.sort((a, b) => a.getTime() - b.getTime());
      for (const c of candidates) {
        if (c.getTime() < baseMs) continue;
        if (c.getTime() > hardUntil || produced >= count) break;
        pushIfInRange(c);
      }
      if (new Date(d).setDate(28) > hardUntil && m > 0) break;
    }
  } else {
    // YEARLY
    for (let y = 0; ; y += interval) {
      if (produced >= count) break;
      const d = new Date(base);
      d.setFullYear(base.getFullYear() + y);
      if (d.getTime() > hardUntil || produced >= count) break;
      pushIfInRange(d);
      if (y > 30) break;
    }
  }
  return out.length ? out : [item.start];
}

/** 条目实例是否落在窗口内（展开重复并应用 EXDATE） */
export function occurrencesInRange(item: CalItem, rangeStartMs: number, rangeEndMs: number): LocalStamp[] {
  const ex = new Set((item.exdates || []).map((s) => (isDateOnly(s) ? s.slice(0, 10) : s.slice(0, 19))));
  return expandRepeats(item, rangeStartMs, rangeEndMs)
    .filter((s) => !ex.has(isDateOnly(s) ? s : s.slice(0, 19)));
}

export { padDate };
