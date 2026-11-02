// 从 src 里抽取所有 t("...") / _t("...") 的 key，生成 i18n 字典。
//   - zh_CN.json：恒等映射（key 即中文原文）
//   - en_US.json：骨架（先恒等，随后人工翻译成英文）
// 抽取基于 TypeScript AST，只取「首个参数是字符串字面量」的 t/_t 调用。
import ts from "typescript";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(SRC, "i18n");

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const files = walk(SRC).filter((f) => !f.endsWith(path.join("core", "i18n.ts")));
const keys = new Set();
let scanned = 0;

// 命令（addCommand 的 langKey）引用的 stock 键：必须保留在 i18n 文件里，
// 否则 SiYuan 解析 langKey 会拿到 [object Object]/undefined。统一用扁平字符串。
// 注意：这些键是 ASCII 名（langKey 用），值是中文文案；en_US 里预翻成英文。
const STOCK = {
  addTask: { zh: "新建待办", en: "New To-do" },
  syncNow: { zh: "立即同步 CalDAV", en: "Sync Now" },
  openPanel: { zh: "打开日历与任务", en: "Open Calendar & Tasks" },
  insertToday: { zh: "把日程与待办插入日记", en: "Insert Schedule & Todos into Daily Note" },
};

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  scanned++;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && (callee.text === "t" || callee.text === "_t")) {
        const first = node.arguments[0];
        if (first && ts.isStringLiteral(first)) {
          keys.add(first.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

const list = [...keys].sort();
fs.mkdirSync(OUT, { recursive: true });

const zh = {};
for (const k of list) zh[k] = k;
// stock 键：zh_CN 用中文值
for (const [k, v] of Object.entries(STOCK)) zh[k] = v.zh;
fs.writeFileSync(path.join(OUT, "zh_CN.json"), JSON.stringify(zh, null, 2) + "\n", "utf8");

const en = {};
for (const k of list) en[k] = k; // 骨架：先恒等，待翻译
// stock 键：en_US 直接用预翻英文（translate.mjs 遇到非中文值会原样保留）
for (const [k, v] of Object.entries(STOCK)) en[k] = v.en;
fs.writeFileSync(path.join(OUT, "en_US.json"), JSON.stringify(en, null, 2) + "\n", "utf8");

console.log(`i18n-gen-ast: 扫描 ${scanned} 文件，抽取 ${list.length} 个唯一 key（含 ${Object.keys(STOCK).length} 个 stock 键）`);
console.log(`  -> ${path.join(OUT, "zh_CN.json")} (恒等)`);
console.log(`  -> ${path.join(OUT, "en_US.json")} (骨架，待翻译)`);
