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
 *
 * ⚠️⚠️ 内核 SQL 接口的两个坑（2026-10-30 实测，踩中一个就丢数据）：
 *   ① **没写 LIMIT 就只回 64 行**（响应里 `limit:64, truncated:true`），超出的行
 *      **静默丢弃**。存在性判断若被截断，就会把「其实还在」的块判成「没了」→ 删掉
 *      用户的 VTODO。**所以每条查询都必须显式写 LIMIT，并检查 truncated。**
 *   ② `blocks.updated` 是**字符串**（`YYYYMMDDHHmmss`，本地时间、秒级），
 *      等宽数字 → 字典序可比，可用来做增量扫描（见 `since`）。
 */
import type { BlockTask } from "./block-todo";
import { blockCheckedOf, cleanBlockText } from "./block-todo";

/**
 * 内核接口调用：返回**完整响应信封** `{code,msg,data,limit,truncated}`。
 *
 * ⚠️ 为什么不只取 data：信封里的 `truncated` 才知道结果有没有被内核截断。
 *    扫描被截断时**绝不能推进增量水位线**（没扫全，推了就永久漏块）。
 */
export type KernelCaller = (url: string, body: unknown) => Promise<any>;

/** 「取消同步」的忽略标记：块上打这个自定义属性后，扫描不再认它（见 issue #2） */
export const BLOCK_SKIP_ATTR = "custom-caldav-skip";

/** 日记文档的属性标记（思源自建），用于「仅日记」范围 */
const DAILY_ATTR_LIKE = "custom-dailynote-%";

/** 单条查询最多带多少个 ID（分批查，避免 SQL 参数过多） */
const ID_CHUNK = 200;

export interface ScanOptions {
  /** 扫描范围 */
  scope: "open" | "daily" | "notebooks" | "all";
  /** 范围 = 笔记本时的笔记本 ID 列表 */
  notebooks?: string[];
  /** 范围 = 打开的文档时的文档 ID 列表（由调用方从布局里取） */
  openDocIds?: string[];
  /** 限定只扫这些文档（按 root_id 过滤）。传入时**忽略 scope 的 root 过滤**（daily/notebooks/open 都不套），只按 docIds 收口。用于「扫描当前文档」/「关闭文档时扫描」 */
  docIds?: string[];
  /** 同步前缀（要从块文字上剥掉，避免前缀被当成正文） */
  prefix?: string;
  /**
   * **增量水位**（`YYYYMMDDHHmmss`）：只取「最后修改时间晚于它」的块。
   * 不传 = 全量扫描。
   */
  since?: string;
}

/** 一次扫描的结果。`truncated` = 内核把结果截断了（没写 LIMIT 或超上限） */
export interface ScanResult {
  blocks: BlockTask[];
  truncated: boolean;
}

const sqlQuote = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

/**
 * 查 SQL：返回行 + 是否被内核截断 + **查询本身是否失败**。
 *
 * ⚠️ `failed` 的意义：内核报错（`code != 0`）或网络异常时，**拿到的 0 行不是「查到了没有」，
 *    而是「压根没查成」**。两者混为一谈 → 判生死时会把「查不到」当成「块没了」→ 删掉用户的待办。
 *    所以查存在性时必须区分：查失败 ⇒ 一个都不能删。
 */
async function sqlFull<T = any>(
  caller: KernelCaller,
  stmt: string
): Promise<{ rows: T[]; truncated: boolean; failed: boolean }> {
  let r: any;
  try {
    r = await caller("/api/query/sql", { stmt });
  } catch (e) {
    console.warn("[caldav] 内核 SQL 调用异常:", e);
    return { rows: [], truncated: false, failed: true };
  }
  // 兼容两种形状：完整信封（{data,truncated}）与直接给行数组
  if (Array.isArray(r)) return { rows: r, truncated: false, failed: false };
  if (!r || typeof r !== "object") return { rows: [], truncated: false, failed: true };
  // 内核报错：data 为 null / code 非 0
  if (typeof r.code === "number" && r.code !== 0) return { rows: [], truncated: false, failed: true };
  if (!Array.isArray(r.data)) return { rows: [], truncated: false, failed: true };
  return { rows: r.data, truncated: r.truncated === true, failed: false };
}

const sql = async (caller: KernelCaller, stmt: string): Promise<any[]> => (await sqlFull(caller, stmt)).rows;

/**
 * 范围过滤条件（SQL 片段）。
 *
 * 返回 `null` = **范围内一个文档都没有** → 结果必然为空。
 * ⚠️ 绝不是「退化成全库」——那是另一种语义，静默扩大范围会吓到人。
 */
function scopeWhere(opts: ScanOptions): string[] | null {
  if (opts.docIds && opts.docIds.length) {
    // 指定文档：只按 root_id 收口，忽略 scope 的 root 过滤（daily/notebooks/open 都不套）
    const ids = opts.docIds.filter(Boolean);
    if (!ids.length) return null;
    return [`root_id IN (${ids.map(sqlQuote).join(",")})`];
  }
  if (opts.scope === "daily") {
    return [`root_id IN (SELECT block_id FROM attributes WHERE name LIKE '${DAILY_ATTR_LIKE}')`];
  }
  if (opts.scope === "notebooks") {
    const ids = (opts.notebooks || []).filter(Boolean);
    if (!ids.length) return null;
    return [`box IN (${ids.map(sqlQuote).join(",")})`];
  }
  if (opts.scope === "open") {
    const ids = (opts.openDocIds || []).filter(Boolean);
    if (!ids.length) return null;
    return [`root_id IN (${ids.map(sqlQuote).join(",")})`];
  }
  return [];
}

/**
 * 增量条件：只要「最后修改时间晚于水位」的块。
 *
 * ⚠️ `updated` 是字符串（`YYYYMMDDHHmmss`），等宽数字 → 字典序可比。
 * ⚠️ 兜底 `updated IS NULL OR updated = ''`：老数据 / 导入来的块没有时间戳，
 *    空串跟任何非空串比都更小 → 没有兜底的话这些块**永远扫不到**（静默漏同步）。
 */
function sinceWhere(since: string): string {
  return `(updated > ${sqlQuote(since)} OR updated IS NULL OR updated = '')`;
}

/** 行 → 任务块 */
function toBlockTasks(rows: any[], prefix?: string): BlockTask[] {
  const out: BlockTask[] = [];
  for (const r of rows) {
    const text = cleanBlockText(r?.content || "", prefix);
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
 * 扫任务块。
 *
 * 排除两类：① 打了 skip 标记的（用户明确「取消同步」的块）；② 范围外的。
 * ⚠️ 排除 skip 用的是 `attributes` 表的子查询（思源自定义属性就存在这里），
 *    不是逐块调 getBlockAttrs —— 后者是 N+1，全库扫一次要几百次请求。
 *
 * @param opts.since 传了就是**增量扫描**（只取改动过的块）；不传 = 全量。
 */
export async function scanTaskBlocks(caller: KernelCaller, opts: ScanOptions): Promise<ScanResult> {
  const scope = scopeWhere(opts);
  if (scope === null) return { blocks: [], truncated: false };

  const where: string[] = [
    "type = 'i'",
    "subtype = 't'",
    // 忽略标记：打了就不扫（用户点过「取消同步」）
    `id NOT IN (SELECT block_id FROM attributes WHERE name = '${BLOCK_SKIP_ATTR}')`
  ];
  where.push(...scope);
  if (opts.since) where.push(sinceWhere(opts.since));

  // 显式 LIMIT：内核 SQL 接口**没写 LIMIT 时只回 64 行**，超出的行静默丢弃。
  const stmt =
    `SELECT id, content, markdown, root_id, box, hpath FROM blocks WHERE ${where.join(" AND ")} LIMIT 5000`;
  const { rows, truncated } = await sqlFull(caller, stmt);
  if (truncated) {
    console.warn("[caldav] 任务块扫描结果被内核截断（任务块过多？）");
  }
  return { blocks: toBlockTasks(rows, opts.prefix), truncated };
}

/**
 * 按 ID 精确取这些任务块（**带同样的范围过滤**）。
 *
 * 用途：服务端那边改了（勾完成 / 改标题）而**块侧没动**的条目 ——
 * 增量扫描看不见它们（块没改 → `updated` 没变），得按 ID 把块捞回来对账，
 * 否则「手机上勾完成 → 回写到思源文档」这条链在增量模式下就断了。
 */
export async function scanTaskBlocksByIds(
  caller: KernelCaller,
  ids: string[],
  opts: ScanOptions
): Promise<ScanResult> {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return { blocks: [], truncated: false };
  const scope = scopeWhere(opts);
  if (scope === null) return { blocks: [], truncated: false };

  const out: BlockTask[] = [];
  let truncated = false;
  for (let i = 0; i < list.length; i += ID_CHUNK) {
    const chunk = list.slice(i, i + ID_CHUNK);
    const where = [
      "type = 'i'",
      "subtype = 't'",
      `id IN (${chunk.map(sqlQuote).join(",")})`,
      ...scope
    ];
    // LIMIT 写成这批的条数：既不会被内核的默认 64 行截断，也不会多取
    const stmt =
      `SELECT id, content, markdown, root_id, box, hpath FROM blocks WHERE ${where.join(" AND ")} LIMIT ${chunk.length}`;
    const r = await sqlFull(caller, stmt);
    truncated = truncated || r.truncated;
    out.push(...toBlockTasks(r.rows, opts.prefix));
  }
  return { blocks: out, truncated };
}

/**
 * 按 ID 查这些块**是否还存在**。
 *
 * 为什么需要它：映射里有、本轮扫描没扫到的块，有两种可能 —— 块真被删了，或只是
 * 不在扫描范围内（文档关着 / 不在指定笔记本）。靠「没扫到」判断会把后者误删，
 * **按 ID 直接查存在性**才能区分。这样「删文档」「删笔记本」不管当时开没开都能
 * 正确跟删 VTODO（雄哥 2026-10-28 追问的正是这个洞）。
 *
 * ⚠️ 必须显式写 LIMIT：内核 SQL 没写 LIMIT 时只回 64 行，被截断的 ID 会被判成
 *    「块没了」→ 误删用户的待办（2026-10-30 实测并修复）。
 *
 * ⚠️ 返回值带 `failed`：**查询失败 ≠ 块没了**。内核报错或网络异常时返回的行数是 0，
 *    若把它当成「全都查到了没有」→ 会把全部映射判成孤儿 → 全删。
 *    调用方看到 `failed` 必须**一个都不删**。
 */
export async function blocksExistById(
  caller: KernelCaller,
  ids: string[]
): Promise<{ found: Set<string>; failed: boolean; truncated: boolean }> {
  const found = new Set<string>();
  const list = (ids || []).filter(Boolean);
  let failed = false;
  let truncated = false;
  for (let i = 0; i < list.length; i += ID_CHUNK) {
    const chunk = list.slice(i, i + ID_CHUNK);
    const r = await sqlFull(
      caller,
      `SELECT id FROM blocks WHERE id IN (${chunk.map(sqlQuote).join(",")}) LIMIT ${chunk.length}`
    );
    if (r.failed) {
      failed = true;
      continue;
    }
    if (r.truncated) truncated = true;
    for (const row of r.rows) if (row?.id) found.add(String(row.id));
  }
  return { found, failed, truncated };
}

/**
 * 查单个块所属的文档（root_id）。「扫描任务块（当前文档）」菜单项用它从点击的块反推所属文档，
 * 再按该文档收口扫描（避免依赖「当前激活文档」这种易失状态）。
 */
export async function getBlockRootId(caller: KernelCaller, id: string): Promise<string | undefined> {
  if (!id) return undefined;
  const rows = await sql(caller, `SELECT root_id FROM blocks WHERE id = ${sqlQuote(id)} LIMIT 1`);
  const r = rows?.[0];
  return r?.root_id ? String(r.root_id) : undefined;
}

/**
 * 思源块的时间戳格式：`YYYYMMDDHHmmss`（本地时间、秒级）。
 *
 * 与内核 `blocks.updated` 的格式**完全一致**，可以直接做字符串比较；
 * 也用于把 epoch 毫秒换算成内核认的格式（增量水位线）。
 */
export function blockStampOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
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
  const res = await caller("/api/notebook/lsNotebooks", {});
  const data = res?.data ?? res;
  const nbs: any[] = data?.notebooks || [];
  return nbs.map((n) => ({ id: String(n.id || ""), name: String(n.name || n.id || "") })).filter((n) => n.id);
}
