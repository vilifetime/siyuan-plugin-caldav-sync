// 前台启动本地 Radicale（供端到端测试）：node scripts/radicale.mjs
// 用户: testuser / testpass
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = path.join(process.cwd(), ".e2e-radicale");
const py = process.env.E2E_PYTHON || "python";

fs.mkdirSync(path.join(dir, "collections"), { recursive: true });
fs.writeFileSync(path.join(dir, "users"), "testuser:testpass\n");
fs.writeFileSync(
  path.join(dir, "config"),
  `
[server]
hosts = 127.0.0.1:5232

[auth]
type = htpasswd
htpasswd_filename = ${path.join(dir, "users").replace(/\\/g, "/")}
htpasswd_encryption = plain

[rights]
type = owner_only

[storage]
type = multifilesystem
filesystem_folder = ${path.join(dir, "collections").replace(/\\/g, "/")}
`.trim() + "\n"
);

const r = spawnSync(py, ["-c", "import importlib.metadata as m;print(m.version("radicale"))"], { encoding: "utf8" });
if (r.status !== 0) {
  console.error("[radicale] 未安装 radicale，请先: pip install radicale");
  process.exit(1);
}
console.log("[radicale] version", r.stdout.trim(), "http://127.0.0.1:5232/  (testuser/testpass)");

const { spawn } = await import("node:child_process");
// Windows 上必须走 radicale-win.py 这个 wrapper，不能直接 `-m radicale`。
// 原因（2026-10-14 实测）：Radicale 的 pathutils 在创建集合前会探测「当前用户能否建
// 符号链接」，做法是建一个再删掉。本机有建符号链接的权限（提权/开发者模式），于是
// os.symlink 成功、紧接着 os.remove 删一个**目录**符号链接必然 WinError 5，
// 整个进程在启动阶段就崩。普通 Windows 用户走的是 PermissionError 分支，所以官方
// 代码在别人机器上没问题 —— 这是本机特有的坑，wrapper 把该探测短路掉即可。
// e2e.test.mjs 也是同一个启动路径，两边共用这个 wrapper。
const entry =
  process.platform === "win32" ? ["scripts/radicale-win.py"] : ["-m", "radicale"];
const child = spawn(py, [...entry, "--config", path.join(dir, "config")], { stdio: "inherit" });
child.on("exit", (c) => process.exit(c ?? 0));
