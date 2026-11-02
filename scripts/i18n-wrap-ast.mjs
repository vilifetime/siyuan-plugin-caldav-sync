// i18n AST 包裹器（可靠版，替代脆弱的正则脚本）。
//
// 思路：
//   - 用 TypeScript 编译器 API 解析每个 src/**/*.ts，得到精确 AST；
//   - 只处理「含中文（CJK）」的 StringLiteral / TemplateLiteral 节点；
//   - 对字符串字面量：整段包成 `t(<原始带引号文本>)`；
//   - 对模板字面量：把里面的中文片段逐段包成 `${t("片段")}`，保留结构（HTML/插值不丢）；
//   - 用「按原始偏移做反向文本替换」的方式落地，**不重新格式化、不改 CRLF、不动注释**；
//   - 需要时在文件顶部注入 `import { t } from "@/core/i18n";`（撞名则 alias 成 `_t`）。
//
// 跳过（绝不包裹）的位置：
//   1. import / export / require / 动态 import() 的模块说明符
//   2. 属性名 / 类成员名 / 枚举成员名 / 计算属性名（key，非 value）
//   3. 元素访问下标 `obj["x"]`
//   4. switch 的 case 表达式
//   5. 类型位置（类型注解 / as / 字面量类型）
//   6. console.* 的参数
//   7. 比较运算（`===`/`!==`/`==`/`!=`）的操作数 —— 多半是解析内部关键字
//   8. 字符串处理方法（includes/startsWith/match/replace/split…）的参数
//   9. RegExp 构造器的参数
//  10. key-like 属性值（key/id/type/status/mode… 这种内部键）
//  11. 数组元素（几乎都是内部关键字表 / 枚举集合）
//  12. 枚举成员初始化器（模块求值期调用 t 无意义，且多为内部键）
//
// 用法：
//   node scripts/i18n-wrap-ast.mjs            # 仅 dry-run，打印将产生的改动数量
//   node scripts/i18n-wrap-ast.mjs --apply    # 真正写回
import ts from "typescript";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;

// ---- 跳过的「属性值」键名（这些是内部键，不该翻译） ----
const KEY_NAMES = new Set([
  "key", "id", "type", "kind", "action", "value", "tag", "code", "status",
  "mode", "cmd", "method", "prop", "attr", "field", "lang", "locale",
  "unit", "format", "class", "role", "target", "view", "scope", "name2",
  "group", "category", "token", "symbol", "icon", "color", "style",
]);

const CONSOLE_METHODS = new Set(["log", "info", "warn", "error", "debug", "trace"]);
const STRING_METHODS = new Set([
  "includes", "startsWith", "endsWith", "indexOf", "lastIndexOf",
  "match", "replace", "search", "split", "test", "exec", "concat", "padStart", "padEnd",
]);

// ---- CJK-ish 字符判定（含全角标点，便于把整句中文作为 key） ----
function isCJKChar(ch) {
  if (!ch) return false;
  const c = ch.codePointAt(0);
  return (
    (c >= 0x3000 && c <= 0x9fff) || // CJK 符号/标点 + 统一汉字
    (c >= 0xff00 && c <= 0xffef) || // 全角形式
    (c >= 0x2000 && c <= 0x206f) || // 通用标点（— … ‘ ’ “ ”）
    (c >= 0x2018 && c <= 0x201f)
  );
}
function hasCJK(s) {
  for (const ch of s) if (isCJKChar(ch)) return true;
  return false;
}
// 在 [a,b) 区间内找连续 CJK 片段，返回 {start,end} 列表（基于原始偏移）
function cjkRunsInRange(raw, a, b) {
  const runs = [];
  let s = -1;
  for (let i = a; i < b; i++) {
    if (isCJKChar(raw[i])) {
      if (s < 0) s = i;
    } else if (s >= 0) {
      runs.push({ start: s, end: i });
      s = -1;
    }
  }
  if (s >= 0) runs.push({ start: s, end: b });
  return runs;
}

// ---- 祖先链是否位于类型位置 ----
function inTypePosition(node) {
  let p = node.parent;
  while (p) {
    if (ts.isTypeNode(p)) return true;
    p = p.parent;
  }
  return false;
}

// ---- 是否应跳过该字符串节点 ----
function shouldSkip(node) {
  const parent = node.parent;
  if (!parent) return true;

  // 1. 模块说明符
  if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) return true;
  if (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) return true;
  if (ts.isImportEqualsDeclaration(parent)) return true;
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword && parent.arguments[0] === node) return true;
  if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "require" && parent.arguments[0] === node) return true;

  // 2. 属性名 / 类·枚举成员名 / 计算属性名
  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) ||
      ts.isMethodDeclaration(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) &&
    parent.name === node
  ) return true;
  if (ts.isComputedPropertyName(parent)) return true;
  if (ts.isEnumMember(parent) && parent.name === node) return true;
  if (typeof ts.isClassElement === "function" && ts.isClassElement(parent) && parent.name === node) return true;

  // 3. 元素访问下标
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;

  // 4. case 表达式
  if (ts.isCaseClause(parent) && parent.expression === node) return true;

  // 5. 类型位置
  if (inTypePosition(node)) return true;

  // 6. console.* 参数
  if (
    ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) &&
    ts.isIdentifier(parent.expression.expression) && parent.expression.expression.text === "console"
  ) return true;

  // 7. 比较运算操作数
  if (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
    (parent.left === node || parent.right === node)
  ) return true;

  // 8. 字符串处理方法参数
  if (
    ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) &&
    STRING_METHODS.has(parent.expression.name.text) && parent.arguments.includes(node)
  ) return true;

  // 9. RegExp 构造器参数
  if (
    ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) &&
    parent.expression.text === "RegExp" && parent.arguments && parent.arguments[0] === node
  ) return true;

  // 10. key-like 属性值
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name) && KEY_NAMES.has(parent.name.text)) return true;

  // 11. 数组元素
  if (ts.isArrayLiteralExpression(parent) && parent.elements.includes(node)) return true;

  // 12. 枚举成员初始化器
  if (ts.isEnumMember(parent) && parent.initializer === node) return true;

  return false;
}

function escapeDq(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

// ---- 字符串拼接（`"前缀" + x + "后缀"`）合并成模板，避免碎片段 key ----
function touchesString(n) {
  if (ts.isStringLiteral(n)) return true;
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return touchesString(n.left) || touchesString(n.right);
  }
  return false;
}
function hasTemplateLiteral(n) {
  if (n.kind === ts.SyntaxKind.TemplateExpression || n.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) return true;
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return hasTemplateLiteral(n.left) || hasTemplateLiteral(n.right);
  }
  return false;
}
function isConcatBinary(n) {
  return (
    ts.isBinaryExpression(n) &&
    n.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    touchesString(n) &&
    !hasTemplateLiteral(n)
  );
}
function escapeTemplateLit(s) {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

// ---- 收集某文件的所有编辑操作 ----
// op: { start, end, text }  —— 应用到 raw.substring(start,end)
function collectOps(file, raw) {
  const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ops = [];

  function addStringWrap(node) {
    if (!hasCJK(node.text)) return;
    if (shouldSkip(node)) return;
    const start = node.getStart();
    const end = node.getEnd();
    ops.push({ start, end, text: `t(${raw.substring(start, end)})` });
  }

  function addTemplateSegmentWrap(node) {
    // 计算 head 与每个 span.literal 的中文片段区间，逐个替换成 ${t("片段")}
    const spans = node.templateSpans || [];
    const ranges = [];
    // head
    const headStart = node.getStart() + 1;
    const headEnd = spans.length ? spans[0].expression.getStart() : node.getEnd() - 1;
    ranges.push([headStart, headEnd]);
    // 每个 span 的 literal（位于该 expression 之后，到下一个 expression 或结尾之前）
    for (let i = 0; i < spans.length; i++) {
      const exprEnd = spans[i].expression.getEnd();
      const nextStart = i + 1 < spans.length ? spans[i + 1].expression.getStart() : node.getEnd() - 1;
      ranges.push([exprEnd, nextStart]);
    }
    for (const [a, b] of ranges) {
      if (b <= a) continue;
      const runs = cjkRunsInRange(raw, a, b);
      for (const r of runs) {
        const seg = raw.substring(r.start, r.end);
        if (!hasCJK(seg)) continue;
        ops.push({ start: r.start, end: r.end, text: `\${t("${escapeDq(seg)}")}` });
      }
    }
  }

  function collectConcat(n, segs) {
    if (ts.isStringLiteral(n)) {
      segs.push({ type: "lit", text: n.text });
      return;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      collectConcat(n.left, segs);
      collectConcat(n.right, segs);
      return;
    }
    segs.push({ type: "expr", src: raw.substring(n.getStart(), n.getEnd()) });
  }

  function addConcatWrap(node) {
    const segs = [];
    collectConcat(node, segs);
    // 整句合成一个 key：「共」+ n + 「条」→ t("共{0}条", n)
    let fmt = "";
    const args = [];
    let i = 0;
    for (const s of segs) {
      if (s.type === "lit") {
        fmt += s.text; // 保留原样（含中文与标点），不再拆片段
      } else {
        fmt += "{" + i + "}";
        args.push(s.src);
        i++;
      }
    }
    if (!hasCJK(fmt)) return; // 整段无中文：保持原样
    const argPart = args.length ? ", " + args.join(", ") : "";
    ops.push({ start: node.getStart(), end: node.getEnd(), text: `t("${escapeDq(fmt)}"${argPart})` });
  }

  function visit(node) {
    if (!node || typeof node.kind !== "number") return;
    // 字符串拼接：合并成模板，整段作为一个 key（避免碎片段）
    if (isConcatBinary(node)) {
      addConcatWrap(node);
      return;
    }
    // 模板字面量：先做片段包裹（不递归其 literal 文本，但递归其 expression 子节点）
    if (node.kind === ts.SyntaxKind.TemplateExpression) {
      addTemplateSegmentWrap(node);
      // 递归子节点（expression 里的字符串仍需包裹）
      ts.forEachChild(node, visit);
      return;
    }
    if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      addTemplateSegmentWrap(node);
      return;
    }
    if (node.kind === ts.SyntaxKind.StringLiteral) {
      addStringWrap(node);
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return ops;
}

// ---- 判断是否需要 import 以及用 t 还是 _t ----
// 用「相对路径」指向 src/core/i18n，避免依赖 vite 的 @ 别名
// （test/core.test.mjs 用裸 tsc 编译 core 文件，@ 别名解析不到会报错）。
function relativeI18nSpec(file) {
  let rel = path.relative(path.dirname(file), path.join(SRC, "core", "i18n"));
  rel = rel.split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}
function planImport(raw, file) {
  // 是否已存在对 i18n 的 import？精确看它怎么绑定 t
  const m = raw.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*i18n["']/);
  if (m) {
    const names = m[1];
    const bindsDirectT = /\bt\b/.test(names) && !/t\s+as\b/.test(names);
    if (bindsDirectT) return { need: false, wrapper: "t" };
    if (/t\s+as\s+_t/.test(names)) return { need: false, wrapper: "_t" };
    // 只导入了 setI18n 这类、没有 t：需要补一个 t as _t
    const spec = relativeI18nSpec(file);
    return { need: true, wrapper: "_t", importText: `import { t as _t } from "${spec}";` };
  }
  // 顶层 const/let/var/function/class t  => 撞名，用 _t
  const localT = /(?:const|let|var|function|class)\s+t\b/.test(raw);
  const importTelsewhere = /import\s*\{[^}]*\bt\b[^}]*\}\s*from/.test(raw);
  const spec = relativeI18nSpec(file);
  if (localT || importTelsewhere) {
    return { need: true, wrapper: "_t", importText: `import { t as _t } from "${spec}";` };
  }
  return { need: true, wrapper: "t", importText: `import { t } from "${spec}";` };
}

// 用 AST 找最后一个顶层 import 语句的结束偏移（兼容多行 import {...} from）
function lastImportEnd(file, raw) {
  const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  let end = -1;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (stmt.getEnd() > end) end = stmt.getEnd();
    }
  }
  return end;
}

// ---- 主流程 ----
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

let files = walk(SRC).filter((f) => !f.endsWith(path.join("core", "i18n.ts")));
files.sort();

let totalWrap = 0;
let changedFiles = 0;
const report = [];

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const ops = collectOps(file, raw);
  if (!ops.length) continue;
  // 去重/排序（按 start 升序便于审阅；应用时会反向）
  ops.sort((a, b) => a.start - b.start);
  const plan = planImport(raw, file);
  // 应用 wrapper：把 op.text 里的 t( 换成 wrapper(
  const realOps = ops.map((o) => ({
    start: o.start,
    end: o.end,
    text: o.text.replace(/\bt\(/, `${plan.wrapper}(`),
  }));
  totalWrap += realOps.length;
  changedFiles++;

  if (DRY) {
    report.push(`${path.relative(ROOT, file)}: ${realOps.length} 处 wrap（import=${plan.need ? plan.wrapper : "已有"}）`);
    continue;
  }

  // 反向应用编辑，保留原始字节
  let out = raw;
  for (let i = realOps.length - 1; i >= 0; i--) {
    const { start, end, text } = realOps[i];
    out = out.slice(0, start) + text + out.slice(end);
  }
  if (plan.need) {
    const at = lastImportEnd(file, out);
    const nl = out.includes("\r\n") ? "\r\n" : "\n";
    if (at > 0) out = out.slice(0, at) + nl + plan.importText + nl + out.slice(at);
    else out = plan.importText + nl + out;
  }
  fs.writeFileSync(file, out);
  report.push(`${path.relative(ROOT, file)}: ${realOps.length} 处 wrap（import=${plan.wrapper}）`);
}

console.log(`i18n-wrap-ast ${APPLY ? "[APPLY]" : "[DRY-RUN]"}`);
console.log(`文件改动：${changedFiles}，包裹点：${totalWrap}`);
for (const r of report) console.log("  " + r);
