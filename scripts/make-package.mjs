import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { loadEnv } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const pkgDir = path.join(root, "package");

const env = loadEnv("production", root);
const workspace = env.VITE_SIYUAN_WORKSPACE_PATH || "";
const pluginName = env.VITE_SIYUAN_PLUGIN_NAME || "siyuan-plugin-caldav-sync";

const files = [
  ["dist/index.js", "index.js"],
  ["dist/index.css", "index.css"],
  ["dist/kernel.js", "kernel.js"],
  "plugin.json",
  "README.md",
  "README_zh_CN.md",
  "README_en_US.md",
  ["icon.png", "icon.png"],
  ["preview.png", "preview.png"],
  ["src/i18n/en_US.json", "i18n/en_US.json"],
  ["src/i18n/zh_CN.json", "i18n/zh_CN.json"]
];

function readSrc(src) {
  const p = path.join(root, src);
  if (!fs.existsSync(p)) throw new Error("缺少文件: " + src);
  return fs.readFileSync(p);
}

// 1. 组装 package/ 目录
// 删除失败（如系统回收站工具异常）时降级为覆盖写，保证打包不中断
try {
  fs.rmSync(pkgDir, { recursive: true, force: true });
} catch { /* ignore */ }
fs.mkdirSync(pkgDir, { recursive: true });
for (const f of files) {
  const [src, dest] = Array.isArray(f) ? f : [f, f];
  const d = path.join(pkgDir, dest);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.writeFileSync(d, readSrc(src));
}

// 2. dev 模式下复制到思源工作空间
if (workspace && fs.existsSync(workspace)) {
  const target = path.join(workspace, "data", "plugins", pluginName);
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch { /* ignore */ }
  fs.cpSync(pkgDir, target, { recursive: true });
  console.log("[make-package] dev 复制到工作空间:", target);
}

// 3. 打包 package.zip
const zip = new JSZip();
function addDir(dir, base) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = base ? base + "/" + name : name;
    if (fs.statSync(p).isDirectory()) addDir(p, rel);
    else {
      const stat = fs.statSync(p);
      zip.file(rel, fs.readFileSync(p), { date: stat.mtime });
    }
  }
}
addDir(pkgDir, "");
const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
fs.writeFileSync(path.join(root, "package.zip"), buf);
console.log("[make-package] package.zip (%s KB)", Math.round(buf.length / 1024));
