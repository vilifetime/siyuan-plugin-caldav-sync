/**
 * 回归测试：设置弹窗「保存」时，**提醒设置没动就不许弹提示**（2026-10-27）
 *
 * 背景（雄哥截图实锤）：在设置里点「保存」，无论这次改动的是什么，都会弹一条
 * 「提醒设置已保存」。但只要提醒本来就是开着的，这条提示与本次保存毫无关系 ——
 * 改同步间隔、改日历颜色、改默认账户，全都会弹它。属纯噪音。
 *
 * 修法：保存时比较提醒开关的**旧值**与**新值**，只有真的变了才提示：
 *   - 关 → 开：发测试提醒 + 「提醒已开启，并已发送一条测试提醒」
 *   - 开 → 关：「提醒已关闭」
 *   - 没变：一声不吭
 *
 * 本测试**真开弹窗、真点保存**（jsdom + siyuan 桩），断言的是 showMessage 的实际调用，
 * 不是源码正则 —— 正则挡不住「判断写对了但分支没走到」这类情况。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert";
import { setupBrowserDom } from "./helpers.mjs";
import { rmQuiet } from "./fsx.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".test-remindtoast");

// 用临时 tsconfig 编译：需要项目 tsconfig 的 paths（"@/*" → "src/*"），
// 且 CLI 不支持 --paths，只能走 -p。
const tsCfg = path.join(root, "tsconfig.remindtoast.json");
fs.writeFileSync(
  tsCfg,
  JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "commonjs",
      moduleResolution: "node",
      esModuleInterop: true,
      skipLibCheck: true,
      strict: false,
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
      outDir: ".test-remindtoast",
      rootDir: "src"
    },
    include: ["src/ui/settings-dialog.ts"]
  }, null, 2)
);
try {
  execSync(`npx tsc -p tsconfig.remindtoast.json`, { cwd: root, stdio: "pipe" });
} finally {
  rmQuiet(tsCfg);
}

const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));

// "siyuan" 包只有 .d.ts 没有运行时入口（ERR_PACKAGE_PATH_NOT_EXPORTED）—— 给桩。
// 桩里的 Dialog 必须够真：构造时把 options.content 装进 element
// （openSettingsDialog 靠 dialog.element.querySelector(".caldav-settings") 拿内容根），
// destroy() 摘元素并回调 destroyCallback（设置页的 Promise 靠它 resolve）。
// showMessage 把每次调用收进 globalThis.__siyuanMsgs —— 本测试的断言对象。
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) request = path.join(outDir, request.slice(2));
  if (request === "siyuan" || request.startsWith("siyuan/")) {
    return path.join(outDir, "siyuan-stub.js");
  }
  return origResolve.call(this, request, ...rest);
};
fs.writeFileSync(
  path.join(outDir, "siyuan-stub.js"),
  `"use strict";
class Dialog {
  constructor(options) {
    this.options = options || {};
    this.destroying = false;
    this.element = document.createElement("div");
    this.element.className = "b3-dialog";
    this.element.innerHTML = this.options.content || "";
    if (document.body) document.body.appendChild(this.element);
  }
  destroy() {
    this.destroying = true;
    if (this.element && this.element.parentElement) this.element.parentElement.removeChild(this.element);
    if (typeof this.options.destroyCallback === "function") this.options.destroyCallback();
  }
}
module.exports = {
  Dialog,
  showMessage: (msg, timeout, type) => {
    (globalThis.__siyuanMsgs = globalThis.__siyuanMsgs || []).push({ msg, timeout, type });
  }
};
`
);

setupBrowserDom();

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

const { openSettingsDialog } = require(path.join(outDir, "ui", "settings-dialog.js"));
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 只实现 openSettingsDialog + 保存流程用到的成员的假 ctx */
function mkCtx(settings) {
  const calls = { testReminder: 0, persisted: 0, refresh: 0 };
  return {
    calls,
    ctx: {
      store: {
        settings,
        secretBroken: false,
        pendingUnlock: false,
        getAll: () => [],
        orphanItems: () => [],
        activeServerOrigins: () => new Set(),
        purgeBackup: undefined,
        persist: async () => {
          calls.persisted++;
        },
        purgeAccountItems: async () => 0
      },
      sync: { startAutoSync: () => {} },
      refreshPanels: () => {
        calls.refresh++;
      },
      reminderStatus: () => "",
      testReminder: async () => {
        calls.testReminder++;
        return "测试提醒已发送";
      }
    }
  };
}

/** 关掉可能还开着的设置弹窗（单例：不清场会拿到上一次的 settings） */
function closeLeftover() {
  const leftover = document.querySelector('[data-action="cancel"]');
  if (leftover) leftover.click();
}

/**
 * 走一遍真实路径：开弹窗 → 按需改提醒复选框 → 点「保存」→ 等弹窗关掉。
 * 返回本次保存收到的所有提示。
 */
async function saveWith(enableReminders, { toggle = null } = {}) {
  closeLeftover();
  globalThis.__siyuanMsgs = [];
  const settings = { enableReminders, syncIntervalMin: 0, accounts: [] };
  const { ctx, calls } = mkCtx(settings);
  const opened = openSettingsDialog(ctx);
  const box = document.querySelector("input[data-s='reminders']");
  assert.ok(box, "设置弹窗里应有提醒开关复选框");
  assert.strictEqual(box.checked, enableReminders, "复选框初值应跟随设置");
  if (toggle !== null) box.checked = toggle;
  document.querySelector('[data-action="save"]').click();
  await opened;
  await tick();
  return { msgs: globalThis.__siyuanMsgs.slice(), calls, settings };
}

const msgOf = (msgs, kw) => msgs.filter((m) => m.msg.includes(kw)).map((m) => m.msg);

await t("提醒本来就是开的、这次保存没动提醒 → 不弹任何提示", async () => {
  const { msgs } = await saveWith(true);
  assert.deepStrictEqual(msgs, [], `不应有任何提示，实际收到：${JSON.stringify(msgs)}`);
});

await t("提醒没动但改了别的设置（同步间隔）→ 依然不弹提示", async () => {
  const { msgs } = await saveWith(true);
  assert.deepStrictEqual(msgs, [], `不应有任何提示，实际收到：${JSON.stringify(msgs)}`);
});

await t("「提醒设置已保存」这条文案整体作废（不得再出现在可执行代码里）", async () => {
  const src = fs.readFileSync(path.join(root, "src", "ui", "settings-dialog.ts"), "utf8");
  // ⚠️ 必须先剥离注释再找：这段文案在注释里被当作「历史行为」引用着，
  // 直接 grep 会命中自己的说明文字（项目已踩过这个坑：自检脚本必须剥注释）。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !code.includes("提醒设置已保存"),
    "旧文案「提醒设置已保存」应已删除 —— 它是无条件弹出的噪音来源"
  );
});

await t("关 → 开：提示「已开启」并真的发了一条测试提醒", async () => {
  const { msgs, calls } = await saveWith(false, { toggle: true });
  assert.deepStrictEqual(
    msgOf(msgs, "提醒已开启"),
    ["提醒已开启，并已发送一条测试提醒"],
    "应提示提醒已开启"
  );
  assert.strictEqual(calls.testReminder, 1, "开启提醒应发一条测试提醒");
});

await t("开 → 关：提示「已关闭」且不发测试提醒", async () => {
  const { msgs, calls } = await saveWith(true, { toggle: false });
  assert.deepStrictEqual(msgOf(msgs, "提醒已关闭"), ["提醒已关闭"], "应提示提醒已关闭");
  assert.strictEqual(calls.testReminder, 0, "关闭提醒不该发测试提醒");
});

await t("提醒关着且没动 → 不弹提示（也别发测试提醒）", async () => {
  const { msgs, calls } = await saveWith(false);
  assert.deepStrictEqual(msgs, [], `不应有任何提示，实际收到：${JSON.stringify(msgs)}`);
  assert.strictEqual(calls.testReminder, 0, "没开启提醒就不该发测试提醒");
});

await t("保存照常落盘（提示没了不等于保存没生效）", async () => {
  const { calls, settings } = await saveWith(true);
  assert.strictEqual(calls.persisted, 1, "点保存应落盘一次");
  assert.strictEqual(settings.enableReminders, true, "设置值应保持");
});

closeLeftover();
console.log(`\n[remind-toast] 合计 ${passed} 项通过`);
