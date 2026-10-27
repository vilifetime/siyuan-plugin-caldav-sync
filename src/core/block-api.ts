/**
 * 思源内核侧的任务块读写（唯一碰内核接口的地方）。
 *
 * 为什么单独抽一个文件：core 里的逻辑一律纯函数、可测；内核接口调用全收在这里，
 * 通过注入 `KernelCaller` 解耦（测试里塞个假 caller 就能跑，不用起思源）。
 *
 * 用到的内核接口：
 *   POST /api/query/sql        扫任务块、按 ID 查块是否还在
 *   POST /api/block/updateBlock 改块的勾选态（`- [ ]` ⇄ `- [X]`）
 *   POST /api/attr/setBlockAttrs 打/清 `custom-caldav-skip`（「取消同步」的忽略标记）
 *
 * ⚠️ 任务块在数据库里的形态（本机实测）：
 *   `type='i' AND subtype='t'`，`markdown` 形如 `- [ ] 待办1` / `- [X] ((id "文本"))`，
 *   `content` 是**纯文本**（引用已还原），但常带一个前导空格 —— 必须 trim。
 */
import type { BlockTask } from "./block-todo";
import { blockCheckedOf, cleanBlockText } from "./block-todo";

/** 内核接口调用：只取 data，失败返回 undefined（不抛，交给调用方决定文案） */
export type KernelCaller = (url: string, body: unknown) => Promise<any>;

/** 「取消同步」的忽略标记：块上打这个自定义属性后，扫描不再认它（见 issue #2） */
export const BLOCK_SKIP_ATTR = "custom-caldav-skip";

/** 日记文档的属性标记（思源自建），用于「仅日记」范围 */
const DAILY_ATTR_LIKE = "custom-dailynote-%";

export interface ScanOptions {
  /** 扫描范围 */
  scope: "open" | "daily" | "notebooks" | "all";
  /** 范围 = 笔记本时的笔记本 ID 列表 */
  notebooks?: string[];
  /** 范围 = 打开的文档时的文档 ID 列表（由调用方从布局里取） */
  openDocIds?: string[];
  /** 同步前缀（要从块文字上剥掉，避免前缀被当成正文） */
  prefix?: string;
}

const sql = (caller: KernelCaller, stmt: string): Promise<any[]> =>
  caller("/api/query/sql", { stmt }).then((d) => (Array.isArray(d) ? d : []));

const sqlQuote = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

/**
 * 扫任务块。
 *
 * 排除两类：① 打了 skip 标记的（用户明确「取消同步」的块）；② 范围外的。
 * ⚠️ 排除 skip 用的是 `attributes` 表的子查询（思源自定义属性就存在这里），
 *    不是逐块调 getBlockAttrs —— 后者是 N+1，全库扫一次要几百次请求。
 */
export async function scanTaskBlocks(caller: KernelCaller, opts: ScanOptions): Promise<BlockTask[]> {
  // 「打开的文档」：一个文档都没开 → 结果为空（不是退化成全库，那是另一种语义）
  if (opts.scope === "open" && !(opts.openDocIds || []).length) return [];

  const where: string[] = [
    "type = 'i'",
    "subtype = 't'",
    // 忽略标记：打了就不扫（用户点过「取消同步」）
    `id NOT IN (SELECT block_id FROM attributes WHERE name = '${BLOCK_SKIP_ATTR}')`
  ];
  if (opts.scope === "daily") {
    where.push(`root_id IN (SELECT block_id FROM attributes WHERE name LIKE '${DAILY_ATTR_LIKE}')`);
  } else if (opts.scope === "notebooks") {
    const ids = (opts.notebooks || []).filter(Boolean);
    if (!ids.length) return [];
    where.push(`box IN (${ids.map(sqlQuote).join(",")})`);
  } else if (opts.scope === "open") {
    const ids = (opts.openDocIds || []).filter(Boolean);
    where.push(`root_id IN (${ids.map(sqlQuote).join(",")})`);
  }
  // 显式 LIMIT：内核 SQL 接口有默认行数上限，不加会在块多时静默截断
  const stmt =
    `SELECT id, content, markdown, root_id, box, hpath FROM blocks WHERE ${where.join(" AND ")} LIMIT 5000`;
  const rows = await sql(caller, stmt);
  const out: BlockTask[] = [];
  for (const r of rows) {
    const text = cleanBlockText(r?.content || "", opts.prefix);
    if (!r?.id || !text) continue;
    out.push({
      id: String(r.id),
      text,
      checked: blockCheckedOf(String(r.markdown || "")),
      markdown: String(r.markdown || ""),
      rootId: r.root_id ? String(r.root_id) : undefined,
      box: r.box ? String(r.box) : undefined,
      hpath: r.hpath ? String(r.hpath) : undefined
    });
  }
  return out;
}

/**
 * 按 ID 查这些块**是否还存在**。
 *
 * 为什么需要它：映射里有、本轮扫描没扫到的块，有两种可能 —— 块真被删了，或只是
 * 不在扫描范围内（文档关着 / 不在指定笔记本）。靠「没扫到」判断会把后者误删，
 * **按 ID 直接查存在性**才能区分。这样「删文档」「删笔记本」不管当时开没开都能
 * 正确跟删 VTODO（雄哥 2026-10-28 追问的正是这个洞）。
 */
export async function blocksExistById(caller: KernelCaller, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const list = (ids || []).filter(Boolean);
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const rows = await sql(
      caller,
      `SELECT id FROM blocks WHERE id IN (${chunk.map(sqlQuote).join(",")})`
    );
    for (const r of rows) if (r?.id) out.add(String(r.id));
  }
  return out;
}

/**
 * 改块的勾选态：只动第一行 `- [ ]` / `- [X]` 的方括号，其余行（子块）原样带回。
 * @returns 改后的 markdown；返回 null 说明这行不是任务块行（拒绝改写，防止毁数据）
 */
export function withCheckedMarkdown(markdown: string, checked: boolean): string | null {
  const lines = String(markdown || "").split("\n");
  const first = lines[0] || "";
  const m = /^(\s*[-*+]\s+\[)([ xX])(\])/.exec(first);
  if (!m) return null;
  lines[0] = `${m[1]}${checked ? "X" : " "}${m[3]}${first.slice(m[0].length)}`;
  return lines.join("\n");
}

/** 写回块的勾选态（用扫描时拿到的原始 markdown 改写，不重新拼整块） */
export async function setBlockChecked(
  caller: KernelCaller,
  opts: { id: string; checked: boolean; markdown: string }
): Promise<boolean> {
  const data = withCheckedMarkdown(opts.markdown, opts.checked);
  if (!data) return false;
  const res = await caller("/api/block/updateBlock", { id: opts.id, dataType: "markdown", data });
  // 内核接口「成功但无 data」也算子成功，只有显式 code 才是失败
  return !res || res.code === 0;
}

/** 打 / 清忽略标记（清空值即删除属性，思源口径） */
export async function setBlockSkip(caller: KernelCaller, id: string, on: boolean): Promise<void> {
  await caller("/api/attr/setBlockAttrs", { id, attrs: { [BLOCK_SKIP_ATTR]: on ? "1" : "" } });
}

export async function isBlockSkipped(caller: KernelCaller, id: string): Promise<boolean> {
  const rows = await sql(
    caller,
    `SELECT block_id FROM attributes WHERE name = '${BLOCK_SKIP_ATTR}' AND block_id = ${sqlQuote(id)} LIMIT 1`
  );
  return rows.length > 0;
}

/** 按 ID 取单个任务块（块菜单的「单笔转换」用：不必全库扫一遍） */
export async function getTaskBlockById(
  caller: KernelCaller,
  id: string,
  prefix?: string
): Promise<BlockTask | undefined> {
  if (!id) return undefined;
  const rows = await sql(
    caller,
    `SELECT id, content, markdown, root_id, box, hpath FROM blocks WHERE id = ${sqlQuote(id)} LIMIT 1`
  );
  const r = rows[0];
  if (!r?.id) return undefined;
  const text = cleanBlockText(r.content || "", prefix);
  if (!text) return undefined;
  return {
    id: String(r.id),
    text,
    checked: blockCheckedOf(String(r.markdown || "")),
    markdown: String(r.markdown || ""),
    rootId: r.root_id ? String(r.root_id) : undefined,
    box: r.box ? String(r.box) : undefined,
    hpath: r.hpath ? String(r.hpath) : undefined
  };
}

/** 笔记本列表（设置里「指定笔记本」多选要列出来） */
export async function listNotebooks(
  caller: KernelCaller
): Promise<Array<{ id: string; name: string }>> {
  const data = await caller("/api/notebook/lsNotebooks", {});
  const nbs: any[] = data?.notebooks || [];
  return nbs.map((n) => ({ id: String(n.id || ""), name: String(n.name || n.id || "") })).filter((n) => n.id);
}
