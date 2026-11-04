/**
 * 思源内核后端（档2·真·内核后端）。
 *
 * 与前端 index.js 不同，本文件运行在思源**内核（Node 进程）**里，随思源启动常驻，
 * 不受前端页面关闭 / 最小化影响。职责：
 *  1. 通过 RPC 接收前端推送的「提醒快照」（精简条目 + 设置）。
 *  2. 用 ReminderEngine 在内核里排程提醒；到点时若启用了 Webhook，则向
 *     webhookUrl 发送 HTTP POST（JSON）。
 *
 * 设计要点：
 *  - 内核只负责「Webhook 投递」这一路；前端的系统通知 / 应用内卡片等通道保留在前端。
 *  - 数据单向：前端主动推（call.pushReminderData），内核拉首份（broadcast
 *    requestReminderData 由前端响应）。两端操作都幂等（覆盖缓存 + reschedule）。
 *  - 安全：webhook 地址校验 / 超时 / 静默失败全在 webhook.ts；本文件绝不打印 URL。
 */
import { ReminderEngine } from "./core/reminder";
import { renderWebhookBody, fireWebhook, fireWebhookDetailed } from "./core/webhook";
import { projectReminderItem, type ReminderSnapshot } from "./core/kernel-shared";
import { hmacSha256Base64 } from "./core/hmac-sha256";
import type { CalItem, CalSettings } from "./core/types";

// 思源内核（goja）在运行时注入全局 `siyuan`，类型包仅声明了 `window.siyuan`（前端用），
// 裸全局未导出类型。此处用 any 容错声明（内核类型本就不完整，1.2.7 还缺 client.fetch 等）。
declare const siyuan: any;

/** RPC 方法名：前端调用本方法推送最新提醒快照 */
const RPC_PUSH = "pushReminderData";
/** RPC 广播名：内核拉首份数据时，前端监听后回推快照 */
const RPC_REQUEST = "requestReminderData";
/** RPC 方法名：前端调用本方法立即发一条测试 Webhook 投递并返回结果（供设置页「测试 Webhook」按钮） */
const RPC_TEST_WEBHOOK = "testWebhook";

let engine: ReminderEngine | null = null;
let snapshot: ReminderSnapshot | null = null;

function getItems(): CalItem[] {
  return snapshot?.items ?? [];
}

function getSettings(): CalSettings {
  // ReminderEngine 第四参 getSettings 期望返回完整 CalSettings；
  // 没拿到前返回空对象（enableWebhook 等默认 falsy → 不投递，安全）。
  return snapshot?.settings ?? ({} as CalSettings);
}

/**
 * 钉钉机器人「加签」：把 `timestamp` + `sign` 拼到 webhook URL 后。
 * 算法（钉钉开放平台）：`sign = base64(HmacSHA256(timestamp + "\n" + secret, key=secret))`，
 * 再对 sign 做 URL 编码。无 secret 时原样返回（关键词 / IP 白名单模式无需签名）。
 * ⚠️ 仅在内核（Node）调用，`crypto` 为 Node 内置，绝不打印 secret。
 */
function dingtalkSignedUrl(url: string, secret?: string): string {
  if (!url || !secret || !secret.trim()) return url;
  const ts = Date.now();
  const stringToSign = `${ts}\n${secret}`;
  // 纯 JS 实现，避免依赖 Node 的 require("crypto")（goja 内核里解析不了 Node 内置）
  const sign = hmacSha256Base64(secret, stringToSign);
  const enc = encodeURIComponent(sign);
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}timestamp=${ts}&sign=${enc}`;
}

/**
 * 提醒触发回调：仅当启用 Webhook 且地址非空时才投递。
 * 其余情况（未启用 / 地址空）静默跳过 —— 内核不重复前端已有的提醒通道。
 */
async function fire(item: CalItem, anchorISO: string, alarmMin: number): Promise<void> {
  const s = getSettings();
  if (!s.enableWebhook || !s.webhookUrl) return;
  // 按通道类型（飞书/企业微信/钉钉/自定义）渲染报文；模板非法时返回 null，静默跳过本次投递
  const body = renderWebhookBody(item, anchorISO, alarmMin, s);
  if (!body) return;
  // 钉钉 + 加签密钥：把签名拼进 URL（其余模式/无密钥则原样）
  const url =
    s.webhookType === "dingtalk" && s.webhookSecret
      ? dingtalkSignedUrl(s.webhookUrl, s.webhookSecret)
      : s.webhookUrl;
  await fireWebhook(url, body);
}

/**
 * 设置页「测试 Webhook」：立即用当前设置投递一条演示提醒，返回投递明细供 UI 显示。
 * 与正式调度走同一套渲染 + 投递逻辑，只是条目是写死的演示数据、且结果回传给前端。
 */
async function testWebhook(
  arg: { settings?: CalSettings; item?: CalItem }
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const s = arg.settings ?? getSettings();
  if (!s.enableWebhook || !s.webhookUrl) {
    return { ok: false, error: "未启用 Webhook 或地址为空" };
  }
  const item: CalItem = arg.item ?? {
    uid: "caldav-test-webhook",
    kind: "event",
    calendarUrl: "",
    href: "",
    summary: "Webhook 投递测试",
    allDay: false,
    start: new Date(Date.now() + 60000).toISOString()
  } as CalItem;
  const anchorISO = new Date().toISOString();
  const body = renderWebhookBody(item, anchorISO, 0, s);
  if (!body) return { ok: false, error: "Webhook 模板不是合法 JSON" };
  const url =
    s.webhookType === "dingtalk" && s.webhookSecret
      ? dingtalkSignedUrl(s.webhookUrl, s.webhookSecret)
      : s.webhookUrl;
  return fireWebhookDetailed(url, body);
}

/** 前端通过 RPC 推来的快照：更新缓存并（重）排程 */
async function onPushReminderData(incoming: ReminderSnapshot): Promise<void> {
  // 防御：参数异常时静默忽略，不影响已在跑的调度
  if (!incoming || !Array.isArray(incoming.items) || !incoming.settings) {
    console.warn("[caldav][kernel] 收到非法提醒快照，已忽略");
    return;
  }
  snapshot = {
    items: incoming.items.map(projectReminderItem),
    settings: incoming.settings
  };
  if (!engine) {
    engine = new ReminderEngine(getItems, fire, undefined, getSettings);
    engine.start();
  } else {
    engine.reschedule();
  }
}

// ── 内核生命周期 ──────────────────────────────────────────────────────────────
siyuan.plugin.lifecycle.onload = () => {
  siyuan.rpc
    .bind(RPC_PUSH, onPushReminderData, "前端推送提醒快照（精简条目+设置）")
    .catch((e: unknown) => console.warn("[caldav][kernel] 绑定 pushReminderData 失败", e));
  siyuan.rpc
    .bind(RPC_TEST_WEBHOOK, testWebhook, "设置页「测试 Webhook」：立即投递并返回结果")
    .catch((e: unknown) => console.warn("[caldav][kernel] 绑定 testWebhook 失败", e));
  // 主动拉首份：前端若已就绪会立即回推；未就绪则待其 onload 后主动推送
  siyuan.rpc.broadcast(RPC_REQUEST).catch(() => {
    /* 前端尚未 bind：忽略，前端冷启动会主动推 */
  });
  console.info("[caldav][kernel] 提醒后端已加载（Webhook 通道）");
};

siyuan.plugin.lifecycle.onunload = () => {
  engine?.stop();
  engine = null;
  snapshot = null;
  siyuan.rpc.unbind(RPC_PUSH).catch(() => {
    /* 忽略 */
  });
  console.info("[caldav][kernel] 提醒后端已卸载");
};
