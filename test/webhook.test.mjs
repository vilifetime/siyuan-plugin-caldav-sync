/**
 * Webhook 投递单元测试（档2·真·内核后端）。
 *
 * webhook.ts 是零依赖纯模块，用 esbuild 单独打包成 ESM 后断言：
 *   1) isSafeWebhookUrl 仅放行 http/https，拒绝 ftp/file/javascript/空/非字符串；
 *   2) buildWebhookPayload 产出结构正确（plugin/type/item/text/firedAt）；
 *   3) fireWebhook 走内核 forwardProxy 通道：成功时向上游 POST JSON、地址非法时短路、
 *      上游非 2xx / proxy 异常 / fetch 抛错 均静默返回 false 且不抛错、不打印 URL。
 *
 * 测试用 `globalThis.siyuan.client.fetch` 模拟思源内核的 forwardProxy 行为（返回
 * `{ code:0, data:{ status, body } }`），与本插件内核运行时的契约一致。
 */
import assert from "node:assert";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const out = path.join(root, "dist-test", "webhook.mjs");
fs.mkdirSync(path.dirname(out), { recursive: true });

await build({
  entryPoints: [path.join(root, "src/core/webhook.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "silent"
});

const {
  isSafeWebhookUrl,
  buildWebhookPayload,
  fireWebhook,
  fireWebhookDetailed,
  renderWebhookBody,
  buildReminderTitle,
  buildReminderMessage,
  FEISHU_TEMPLATE,
  WECOM_TEMPLATE,
  DINGTALK_TEMPLATE,
  DEFAULT_TEMPLATE,
  WEBHOOK_TIMEOUT_MS
} = await import(pathToFileURL(out).href + "?t=" + Date.now());

// 内核 forwardProxy 模拟：捕获请求并回放 { code:0, data:{ status, body } }
let lastCall = null;
function mockKernelFetch(status = 200, body = "ok", proxyOk = true, proxyStatus = 200) {
  globalThis.siyuan = {
    client: {
      fetch: async (url, opts) => {
        lastCall = { url, opts };
        return {
          ok: proxyOk,
          status: proxyStatus,
          json: async () => ({ code: 0, data: { status, body } })
        };
      }
    }
  };
}
function envelope() {
  return JSON.parse(lastCall.opts.body);
}

// ── 1. isSafeWebhookUrl ───────────────────────────────────────────────────────
assert.strictEqual(isSafeWebhookUrl("https://example.com/hook"), true, "https 应放行");
assert.strictEqual(isSafeWebhookUrl("http://example.com/hook"), true, "http 应放行");
assert.strictEqual(isSafeWebhookUrl("https://a.com?token=secret"), true, "含 token 的 https 仅校验协议");
assert.strictEqual(isSafeWebhookUrl("ftp://x"), false, "ftp 应拒绝");
assert.strictEqual(isSafeWebhookUrl("file:///etc/passwd"), false, "file 应拒绝");
assert.strictEqual(isSafeWebhookUrl("javascript:alert(1)"), false, "javascript 应拒绝");
assert.strictEqual(isSafeWebhookUrl(""), false, "空串应拒绝");
assert.strictEqual(isSafeWebhookUrl("   "), false, "纯空白应拒绝");
assert.strictEqual(isSafeWebhookUrl(undefined), false, "undefined 应拒绝");
assert.strictEqual(isSafeWebhookUrl(null), false, "null 应拒绝");
assert.strictEqual(isSafeWebhookUrl(123), false, "数字应拒绝");
assert.strictEqual(isSafeWebhookUrl({}), false, "对象应拒绝");

// ── 2. buildWebhookPayload ────────────────────────────────────────────────────
const item = {
  uid: "u1",
  kind: "todo",
  calendarUrl: "https://cal/cal.ics",
  href: "https://cal/u1.ics",
  summary: "买牛奶",
  start: "2026-01-01T10:00:00",
  end: "2026-01-01T11:00:00",
  allDay: false,
  location: "超市",
  description: "脱脂",
  priority: 5,
  percent: 0,
  alarms: [{ minutesBefore: 15 }]
};
const p = buildWebhookPayload(item, "2026-01-01T10:00:00", 15);
assert.strictEqual(p.plugin, "siyuan-caldav-sync");
assert.strictEqual(p.type, "reminder");
assert.ok(p.firedAt && !Number.isNaN(Date.parse(p.firedAt)), "firedAt 应为合法 ISO 时间戳");
assert.strictEqual(p.anchorISO, "2026-01-01T10:00:00");
assert.strictEqual(p.alarmMin, 15);
assert.strictEqual(p.item.uid, "u1");
assert.strictEqual(p.item.kind, "todo");
assert.strictEqual(p.item.summary, "买牛奶");
assert.strictEqual(p.item.location, "超市");
assert.strictEqual(p.item.priority, 5);
assert.ok(p.text.includes("买牛奶"), "text 应包含标题");

// ── 2b. 通道模板渲染（档2·扩展） ──────────────────────────────────────────────
assert.strictEqual(
  buildReminderTitle(item, "x", 0),
  "【思源 CalDAV 提醒】买牛奶",
  "buildReminderTitle 应为固定前缀 + 标题"
);
assert.ok(
  buildReminderMessage(item, "x", 5).includes("提前 5 分钟提醒"),
  "buildReminderMessage 应含提前量"
);

const A = "2026-01-01T10:00:00";
const expectMsg = `触发时间：${A}\n提前 15 分钟提醒\n地点：超市\n备注：脱脂`;
const expectTitle = "【思源 CalDAV 提醒】买牛奶";

// 飞书预设
const feishuBody = renderWebhookBody(item, A, 15, { webhookType: "feishu" });
assert.strictEqual(feishuBody.msg_type, "text", "飞书应为 text 类型");
assert.strictEqual(
  feishuBody.content.text,
  `${expectTitle}\n${expectMsg}`,
  "飞书正文 = 标题 + 换行 + 消息"
);

// 企业微信预设（字段名不同）
const wecomBody = renderWebhookBody(item, A, 15, { webhookType: "wecom" });
assert.strictEqual(wecomBody.msgtype, "text", "企业微信应为 text 类型");
assert.strictEqual(
  wecomBody.text.content,
  `${expectTitle}\n${expectMsg}`,
  "企业微信正文 = 标题 + 换行 + 消息"
);

// 钉钉预设（报文结构与企微同构：msgtype/text.content）
const dingtalkBody = renderWebhookBody(item, A, 15, { webhookType: "dingtalk" });
assert.strictEqual(dingtalkBody.msgtype, "text", "钉钉应为 text 类型");
assert.strictEqual(
  dingtalkBody.text.content,
  `${expectTitle}\n${expectMsg}`,
  "钉钉正文 = 标题 + 换行 + 消息"
);

// 自定义模板（合法 JSON）
const customTmpl = '{"title":"${title}","msg":"${message}"}';
const customBody = renderWebhookBody(item, A, 15, {
  webhookType: "custom",
  webhookTemplate: customTmpl
});
assert.strictEqual(customBody.title, expectTitle, "自定义模板标题变量替换正确");
assert.strictEqual(customBody.msg, expectMsg, "自定义模板消息变量替换正确");

// 自定义模板非法 JSON → 返回 null（调用方静默跳过）
const badBody = renderWebhookBody(item, A, 15, {
  webhookType: "custom",
  webhookTemplate: '{"bad": }'
});
assert.strictEqual(badBody, null, "非法 JSON 模板应返回 null");

// 自定义模板留空 → 回落默认模板（与飞书同构）
const emptyBody = renderWebhookBody(item, A, 15, {
  webhookType: "custom",
  webhookTemplate: ""
});
assert.strictEqual(emptyBody.msg_type, "text", "空模板应回落默认（飞书同构）");

// 未指定类型 / 空 settings → 默认飞书
const defBody = renderWebhookBody(item, A, 15, {});
assert.strictEqual(defBody.msg_type, "text", "缺省 settings 应回落飞书");

// 飞书 / 企业微信 / 钉钉 / 默认 四个预设本身都是合法 JSON
JSON.parse(FEISHU_TEMPLATE);
JSON.parse(WECOM_TEMPLATE);
JSON.parse(DINGTALK_TEMPLATE);
JSON.parse(DEFAULT_TEMPLATE);

// ── 3. fireWebhook：成功（经内核 forwardProxy 出网）─────────────────────────
mockKernelFetch(200);
let ok = await fireWebhook("https://example.com/hook", p);
assert.strictEqual(ok, true, "上游 2xx 应返回 true");
assert.strictEqual(lastCall.url, "/api/network/forwardProxy", "应走内核 forwardProxy");
const env = envelope();
assert.strictEqual(env.url, "https://example.com/hook", "proxy 信封 url 应为目标 webhook");
assert.strictEqual(env.method, "POST");
assert.strictEqual(env.timeout, WEBHOOK_TIMEOUT_MS, "proxy 信封应带超时");
const body = JSON.parse(env.payload);
assert.strictEqual(body.plugin, "siyuan-caldav-sync");
assert.strictEqual(body.item.uid, "u1");

// ── 3a. fireWebhook：渲染后的飞书报文对象也能正常 POST ───────────────────────
mockKernelFetch(200);
const ok2 = await fireWebhook("https://example.com/hook", feishuBody);
assert.strictEqual(ok2, true, "渲染后的飞书报文应投递成功");
const body2 = JSON.parse(envelope().payload);
assert.strictEqual(body2.msg_type, "text", "投递的飞书报文类型正确");
assert.strictEqual(
  body2.content.text,
  `${expectTitle}\n${expectMsg}`,
  "投递的飞书报文正文正确"
);

// ── 3b. fireWebhook：地址非法时短路，绝不调用 fetch ─────────────────────────
let fetchCalled = false;
globalThis.siyuan = {
  client: {
    fetch: async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 200 } }) };
    }
  }
};
const bad = await fireWebhook("javascript:alert(1)", p);
assert.strictEqual(bad, false, "非法地址应返回 false");
assert.strictEqual(fetchCalled, false, "非法地址不应发起任何请求");

// ── 3c. fireWebhook：proxy 正常但上游非 2xx → false ────────────────────────
mockKernelFetch(500);
const notOk = await fireWebhook("https://example.com/hook", p);
assert.strictEqual(notOk, false, "上游非 2xx 应返回 false");
const det = await fireWebhookDetailed("https://example.com/hook", p);
assert.strictEqual(det.ok, false);
assert.strictEqual(det.status, 500, "应透出上游 HTTP 状态");

// ── 3d. fireWebhook：proxy 自身返回非 2xx（如 502）─────────────────────────
mockKernelFetch(200, "ok", false, 502);
const proxyBad = await fireWebhook("https://example.com/hook", p);
assert.strictEqual(proxyBad, false, "proxy 非 2xx 应返回 false");

// ── 3e. fireWebhook：fetch 抛错也不向上抛出 ────────────────────────────────
globalThis.siyuan = {
  client: {
    fetch: async () => {
      throw new Error("network down");
    }
  }
};
const threw = await fireWebhook("https://example.com/hook", p);
assert.strictEqual(threw, false, "fetch 抛错应被吞掉返回 false");

// ── 3f. fireWebhook：siyuan.client.fetch 缺失时给出可读错误而非崩溃 ──────────
delete globalThis.siyuan;
const noFetch = await fireWebhook("https://example.com/hook", p);
assert.strictEqual(noFetch, false, "无 siyuan.client.fetch 应返回 false 而非抛错");

console.log("[webhook.test] 全部断言通过 ✅");
