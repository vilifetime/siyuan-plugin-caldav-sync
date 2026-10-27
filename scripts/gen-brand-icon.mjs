#!/usr/bin/env node
/**
 * 生成思源 Dock 品牌栏的自研图标模块。
 *
 * 背景：
 *   Dock 标题「日历任务管理」左侧原先用的是内联 SVG（icons.calendar）＋主题色方块底，
 *   2026-10-27 雄哥要求换成自己设计的图标（奶油渐变圆角底＋棕色描边日历＋橙色同步箭头＋绿勾徽章）。
 *   该图��就是仓库根目录的 icon.png（集市/插件图标），源文件在 icon-design/icon-warmA-cream.png。
 *
 * 为什么不直接引用图片文件：
 *   · 思源插件目录名随用户安装目录变化（siyuan-plugin-caldav-sync / market-plugin），拼 URL 不可靠；
 *   · 桌面端 / 移动端 / 打包 zip 的相对路径基准不同；
 *   · 内联 data URI 零依赖、零请求，任何环境下表现一致。
 *
 * 用法：
 *   node scripts/gen-brand-icon.mjs
 *   （改了 icon-design/icon-warmA-cream-64.png 之后必须重跑，否则模块与设计稿会漂移）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/** 设计稿（64px，足够覆盖 2x 屏）。要与根目录 icon.png 同源，勿随意替换。 */
const SRC = path.join(ROOT, "icon-design", "icon-warmA-cream-64.png");
const OUT = path.join(ROOT, "src", "ui", "brand-icon.ts");

if (!fs.existsSync(SRC)) {
    console.error(`[gen-brand-icon] 找不到设计稿：${SRC}`);
    process.exit(1);
}

const buf = fs.readFileSync(SRC);
const b64 = buf.toString("base64");

// PNG magic 校验，避免把损坏/非 PNG 文件塞进模块
const isPng =
    buf.length > 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47;
if (!isPng) {
    console.error(`[gen-brand-icon] ${SRC} 不是合法 PNG`);
    process.exit(1);
}

const dataUri = `data:image/png;base64,${b64}`;

const content = `/**
 * 本文件由 scripts/gen-brand-icon.mjs 生成，请勿手工编辑。
 *
 * 源文件：icon-design/icon-warmA-cream-64.png（与仓库根目录 icon.png 同源）
 * 用途：思源左侧 Dock「日历任务管理」标题左侧的品牌图标。
 * 改设计稿后请重跑：node scripts/gen-brand-icon.mjs
 */

/** 自研品牌图标的 data URI（内联 PNG，免运行时请求） */
export const BRAND_ICON_DATA_URI =
    "${dataUri}";

/** 品牌图标 HTML 片段（<img>，alt 走 aria-label） */
export const BRAND_ICON_HTML =
    \`<img class="caldav-brand-icon-img" src="\${BRAND_ICON_DATA_URI}" alt="" aria-hidden="true" />\`;
`;

fs.writeFileSync(OUT, content, "utf8");
console.log(
    `[gen-brand-icon] 已生成 ${path.relative(ROOT, OUT)}（PNG ${buf.length}B → base64 ${b64.length} 字符）`
);
