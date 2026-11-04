/**
 * Webhook 投递（档2·真·内核后端）。
 *
 * 本模块刻意**零依赖**：不引入 i18n / DOM / 任何浏览器 API。投递走思源内核原生
 * 出网通道 `siyuan.client.fetch("/api/network/forwardProxy", …)`（内核 goja 环境
 * **没有全局 `fetch`**，这是档2 排查出的硬约束）。URL 合法性校验、超时（经 proxy 的
 * `timeout` 字段）、异常吞掉等逻辑均在此收敛，便于干净打进 `dist/kernel.js` 常驻运行。
 *
 * 安全边界（与铁律一致）：
 * - 协议仅允许 http / https；`file:`/`ftp:`/`data:`/`javascript:` 等一律拒绝。
 * - 10 秒超时，防止卡住内核事件循环。
 * - 失败只打 warn、绝不抛错中断提醒调度；**任何日志都不打印 webhookUrl**，防 token 泄露。
 */
import type { CalItem } from "./types";

/** 内核常驻，必须卡死超时，避免一个坏端点拖住整个提醒事件循环 */
export const WEBHOOK_TIMEOUT_MS = 10_000;

export interface WebhookPayload {
  /** 来源标识，便于用户端点区分 */
  plugin: "siyuan-caldav-sync";
  type: "reminder";
  /** 触发时刻（ISO 时间戳），便于排障与去重 */
  firedAt: string;
  /** 触发的实例开始/到期时刻（本地墙上时间，用于展示与去重 key） */
  anchorISO: string;
  /** 提前量（分钟） */
  alarmMin: number;
  /** 端点友好的摘要文本（中文标签 + 标题 + 时刻），可直接用于 Bark/Server酱/钉钉等 */
  text: string;
  /** 结构化条目，便于自动化解析 */
  item: {
    uid: string;
    kind: string;
    summary: string;
    calendarUrl: string;
    start?: string;
    end?: string;
    allDay: boolean;
    location?: string;
    description?: string;
    priority?: number;
    percent?: number;
  };
}

/** 由提醒条目构造 Webhook 载荷（纯函数，无副作用） */
export function buildWebhookPayload(
  item: CalItem,
  anchorISO: string,
  alarmMin: number
): WebhookPayload {
  const timeNote = anchorISO ? `（${anchorISO}）` : "";
  return {
    plugin: "siyuan-caldav-sync",
    type: "reminder",
    firedAt: new Date().toISOString(),
    anchorISO,
    alarmMin,
    text: `【思源 CalDAV 提醒】${item.summary}${timeNote}`,
    item: {
      uid: item.uid,
      kind: item.kind,
      summary: item.summary,
      calendarUrl: item.calendarUrl,
      start: item.start,
      end: item.end,
      allDay: item.allDay,
      location: item.location,
      description: item.description,
      priority: item.priority,
      percent: item.percent
    }
  };
}

/**
 * Webhook 通道预设模板（档2·内核后端扩展）。
 *
 * 各预设都带 `${title}` / `${message}` 两个变量，渲染时替换成具体提醒文案。
 * - 飞书自定义机器人：text 类型（`msg_type` 字段名）；
 * - 企业微信群机器人：text 类型（`msgtype` 字段名）；
 * - 钉钉群机器人：text 类型，报文结构与企微同构（`msgtype` / `text.content`）；
 * - DEFAULT：与飞书同构，供「自定义模板留空」时回落，也作为渲染非法模板的兜底。
 */
export const FEISHU_TEMPLATE =
  '{"msg_type":"text","content":{"text":"${title}\\n${message}"}}';
export const WECOM_TEMPLATE =
  '{"msgtype":"text","text":{"content":"${title}\\n${message}"}}';
export const DINGTALK_TEMPLATE =
  '{"msgtype":"text","text":{"content":"${title}\\n${message}"}}';
export const DEFAULT_TEMPLATE = FEISHU_TEMPLATE;

/** 由提醒条目构造「标题」（用于频道模板的 ${title}） */
export function buildReminderTitle(
  item: CalItem,
  anchorISO: string,
  alarmMin: number
): string {
  return `【思源 CalDAV 提醒】${item.summary || "(无标题)"}`;
}

/** 由提醒条目构造「正文」（用于频道模板的 ${message}），按字段拼接、克制换行 */
export function buildReminderMessage(
  item: CalItem,
  anchorISO: string,
  alarmMin: number
): string {
  const parts: string[] = [];
  const when = anchorISO ? anchorISO : "(未指定时间)";
  parts.push(`触发时间：${when}`);
  if (alarmMin > 0) parts.push(`提前 ${alarmMin} 分钟提醒`);
  if (item.location) parts.push(`地点：${item.location}`);
  if (item.description) parts.push(`备注：${item.description}`);
  return parts.join("\n");
}

/**
 * 按通道类型渲染最终投递的 JSON 报文（object）。
 * 返回 `null` 表示模板非法（模板本身不是合法 JSON / 根节点非对象），调用方应**静默跳过**该次投递。
 *
 * 实现要点（避免「变量里含换行/引号把 JSON 撑爆」）：
 *  1. 先把**模板**当 JSON 解析（用户自定义模板写错直接 null）；
 *  2. 再在解析后的内存对象树里替换 `${title}` / `${message}`（纯字符串处理，不会破坏 JSON）；
 *  3. 最终由 `fireWebhook` 的 `JSON.stringify` 统一转义换行/引号——所以模板里的
 *     `\n` 是给接收端看的 JSON 转义，正文里的真实换行也能被正确序列化。
 *
 * - feishu / wecom：用内置预设模板；
 * - custom：用用户 `webhookTemplate`；留空则回落 DEFAULT_TEMPLATE。
 */
export function renderWebhookBody(
  item: CalItem,
  anchorISO: string,
  alarmMin: number,
  settings?: { webhookType?: string; webhookTemplate?: string }
): Record<string, unknown> | null {
  const type = settings?.webhookType || "feishu";
  let tmpl: string;
  if (type === "feishu") tmpl = FEISHU_TEMPLATE;
  else if (type === "wecom") tmpl = WECOM_TEMPLATE;
  else if (type === "dingtalk") tmpl = DINGTALK_TEMPLATE;
  else {
    // custom：未填模板则回落默认；填了就用用户的
    tmpl = settings?.webhookTemplate && settings.webhookTemplate.trim() !== ""
      ? settings.webhookTemplate
      : DEFAULT_TEMPLATE;
  }
  // 1) 模板本身必须是合法 JSON（自定义模板写错就跳过）
  let tree: unknown;
  try {
    tree = JSON.parse(tmpl);
  } catch {
    console.warn("[caldav][webhook] Webhook 模板不是合法 JSON，已跳过本次投递");
    return null;
  }
  if (typeof tree !== "object" || tree === null || Array.isArray(tree)) {
    console.warn("[caldav][webhook] Webhook 模板根节点不是对象，已跳过本次投递");
    return null;
  }
  // 2) 在内存对象里替换变量（纯字符串处理，不会破坏 JSON）
  const title = buildReminderTitle(item, anchorISO, alarmMin);
  const message = buildReminderMessage(item, anchorISO, alarmMin);
  const filled = replaceVars(tree, title, message);
  if (typeof filled !== "object" || filled === null || Array.isArray(filled)) return null;
  return filled as Record<string, unknown>;
}

/** 递归遍历对象/数组，把所有字符串里的 ${title} / ${message} 替换成真实文案 */
function replaceVars(node: unknown, title: string, message: string): unknown {
  if (typeof node === "string") {
    return node
      .replace(/\$\{title\}/g, () => title)
      .replace(/\$\{message\}/g, () => message);
  }
  if (Array.isArray(node)) return node.map((c) => replaceVars(c, title, message));
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node as Record<string, unknown>)) {
      out[k] = replaceVars((node as Record<string, unknown>)[k], title, message);
    }
    return out;
  }
  return node;
}

/**
 * 校验 webhook 地址安全性：仅放行 http / https 绝对 URL。
 * 返回 false 表示非法或危险（日志中不可打印原始 URL）。
 */
export function isSafeWebhookUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.trim() === "") return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "http:" || u.protocol === "https:";
}

/**
 * 向 webhook 地址投递提醒载荷，返回**明细**（成功/HTTP 状态/错误文案）。
 * `payload` 可为：
 *  - object：按 JSON 序列化后 POST（飞书/企业微信/自定义模板的渲染结果，或旧版结构化载荷）；
 *  - string：已是 JSON 文本，原样 POST（调用方已自行序列化）。
 * 任何异常都被吞掉（仅记入 error 字段），绝不向上抛出中断提醒调度；绝不打印 URL。
 */
/**
 * 解析内核环境下的 fetch 实现。
 * 思源内核（goja）**没有全局 `fetch`**，出网须走 SiYuan 自带 HTTP 通道。实测可用入口
 * 为 `siyuan.client.fetch`（kernel.js 注入，函数签名与标准 fetch 一致：
 * `(url, {method,headers,body}) => ResponseLike{ok,status,json()}`）。它既能访问
 * 思源内部 API，也能经 `/api/network/forwardProxy` 对外发请求。
 * 探测顺序：siyuan.client.fetch → siyuan.fetch（旧字段兜底）→ 全局 fetch（浏览器）。
 * 三者皆无则返回 null。
 */
function resolveKernelFetch():
  | ((u: string, init?: Record<string, unknown>) => Promise<any>)
  | null {
  const g = globalThis as any;
  const siyuan = g?.siyuan;
  if (siyuan?.client?.fetch && typeof siyuan.client.fetch === "function") {
    return siyuan.client.fetch.bind(siyuan.client);
  }
  if (siyuan?.fetch && typeof siyuan.fetch === "function") {
    return siyuan.fetch.bind(siyuan);
  }
  if (typeof g?.fetch === "function") {
    return g.fetch.bind(g);
  }
  return null;
}

export async function fireWebhookDetailed(
  url: string,
  payload: WebhookPayload | Record<string, unknown> | string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!isSafeWebhookUrl(url)) {
    return { ok: false, error: "地址非法或非 http/https" };
  }
  const body =
    typeof payload === "string" ? payload : JSON.stringify(payload);

  const f = resolveKernelFetch();
  if (!f) {
    return { ok: false, error: "内核未提供可用的 fetch（siyuan.client.fetch 缺失）" };
  }

  try {
    // 走思源内核的 forwardProxy 出网（内核 goja 无全局 fetch，且此为内核原生外发通道）
    const proxyResp = await f("/api/network/forwardProxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        method: "POST",
        payload: body,
        headers: [{ name: "Content-Type", value: "application/json" }],
        timeout: WEBHOOK_TIMEOUT_MS,
        contentType: "application/json"
      })
    });
    if (!proxyResp.ok) {
      return {
        ok: false,
        status: proxyResp.status,
        error: `forwardProxy 返回 HTTP ${proxyResp.status}`
      };
    }
    const r = await proxyResp.json();
    const status: unknown = r?.data?.status;
    if (typeof status !== "number") {
      return { ok: false, error: "forwardProxy 返回结构异常（缺 data.status）" };
    }
    const ok = status >= 200 && status < 300;
    return { ok, status };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) };
  }
}

/**
 * 向 webhook 地址投递提醒载荷（静默版，供内核提醒调度使用）。
 * 失败只在控制台 warn，**绝不打印 URL**（防 token 泄露）。详见 `fireWebhookDetailed`。
 */
export async function fireWebhook(
  url: string,
  payload: WebhookPayload | Record<string, unknown> | string
): Promise<boolean> {
  const r = await fireWebhookDetailed(url, payload);
  if (!r.ok) {
    console.warn(
      `[caldav][webhook] 投递失败（已忽略，不影响其他提醒）：${r.error ?? ""}${r.status ? ` (HTTP ${r.status})` : ""}`
    );
  }
  return r.ok;
}
