/**
 * 文档任务块 ⇄ VTODO 的**执行层**（对账规划在 core/block-todo.ts，内核读写在 core/block-api.ts）。
 *
 * 三个入口：
 *   runBlockSync   每轮同步后跑一遍（总开关打开时才真跑）+ 设置里的「立即扫描」按钮
 *   convertBlock   块菜单「同步此任务到 CalDAV」—— 单笔转换
 *   unsyncBlock    块菜单「取消同步」—— 删 VTODO + 打忽略标记（`custom-caldav-skip`）
 *   clearBlockSync 设置里的「一键清理」—— 删掉全部块来源 VTODO
 *
 * ⚠️ 所有上传/删除一律走 SyncEngine 的 createItem / updateItem / removeItem：
 *    它们内部有**串行推送链**（pushChain），连点两下不会拿着旧 etag 并发 PUT。
 *    自己直接调 caldav 的 putItem 会绕过这条链 —— 那是 412 丢改动的经典成因。
 */
import type { CalStore } from "./store";
import type { SyncEngine } from "./sync";
import type { CalCalendar, CalItem, CalSettings } from "./types";
import { enabledCalendars, resolveDefaultCalendar } from "./types";
import type { KernelCaller } from "./block-api";
import {
  blockDefaultEnd,
  blockDefaultStart,
  blockItemDrift,
  blockScopeSig,
  newBlockUid,
  planBlockSync,
  stateFields,
  withPrefix
} from "./block-todo";
import { scanTaskBlocks, scanTaskBlocksByIds, blocksExistById, setBlockState, setBlockSkip, blockStampOf } from "./block-api";
import type { BlockTask } from "./block-todo";
import { stampOfMs, todayStamp } from "./date";

/** 全量校准间隔：超过这么久就强制做一次全量扫描（兜底，防水位线漏块） */
export const BLOCK_FULL_SCAN_INTERVAL_MS = 24 * 3600 * 1000;

/**
 * 这个扫描范围是否**覆盖整个工作区**（或用户明确圈定的那个完整集合）。
 *
 * ⚠️ 只有覆盖完整的范围才允许推进增量水位线。原因：水位线的含义是
 *    「水位线之前的改动我全都看过了」。若范围是「打开的文档」或「仅日记」，
 *    它们的**成员会随时间增减**（文档会关掉、文档会被设成日记）：
 *    某个块在它还不在范围内时改了 → 等它进范围时，它的老于水位线 → 增量永远扫不到它
 *    （旧的全量行为能扫到 → 这是增量模式必须避免的回归）。
 *
 *   · `all`       → 覆盖全库 ✓
 *   · `notebooks` → 覆盖用户圈定的那几个笔记本 ✓（增删笔记本会改范围签名 → 水位线作废重扫）
 *   · `open`      → ✗ 成员随时在变
 *   · `daily`     → ✗ 文档随时可能被设成日记
 *
 * `open` / `daily` 的范围本身很小，全量扫也不贵 —— 直接全量，最省心也最安全。
 */
export function scopeCoversWorkspace(scope: string | undefined): boolean {
  return scope === "all" || scope === "notebooks";
}

/**
 * 增量水位线的**重叠窗口**（毫秒）。
 *
 * ⚠️ 内核 `blocks.updated` 只精确到**秒**：水位线记的是「上轮开始时刻」，
 *    若下一轮严格按 `updated > 水位线` 过滤，同一秒里发生的改动会被漏掉。
 *    故回退 2 秒重扫 —— 重复扫到是无害的（对账幂等），漏掉才致命。
 */
export const BLOCK_SCAN_OVERLAP_MS = 2000;

export interface BlockSyncDeps {
  store: CalStore;
  sync: SyncEngine;
  caller: KernelCaller;
  /** 当前打开的文档 ID 列表（范围 = 打开的文档时用） */
  openDocIds?: () => string[];
  /** 限定只扫这些文档（按 root_id）。传入时范围只收口到这些文档（用于「扫描当前文档」/「关闭文档时扫描」） */
  docIds?: string[];
  /** 强制**全量**扫描（手动「扫描全部」/「立即扫描」、首次、范围变更、24h 校准到期） */
  full?: boolean;
}

export interface BlockSyncResult {
  scanned: number;
  created: number;
  updated: number;
  written: number;
  deleted: number;
  errors: string[];
  /** 本轮是全量还是增量（报告文案用；也便于排查「为什么只扫到几个块」） */
  mode?: "full" | "incremental";
}

const emptyResult = (): BlockSyncResult => ({
  scanned: 0,
  created: 0,
  updated: 0,
  written: 0,
  deleted: 0,
  errors: []
});

/** 块来源条目落哪个日历：「使用新建条目的默认日历」→ 复用默认日历及其回退链 */
export function resolveBlockCalendar(s: CalSettings): CalCalendar | undefined {
  const cals = enabledCalendars(s);
  const wanted = (s.blockSyncCalendarUrl || "").trim();
  if (wanted) {
    const hit = cals.find((c) => c.url === wanted);
    if (hit) return hit;
  }
  return resolveDefaultCalendar(s) || cals[0];
}

/** 块 → 新条目（只建内存对象，不上传） */
export function blockToItem(block: BlockTask, cal: CalCalendar, s: CalSettings): CalItem {
  const uid = newBlockUid();
  const start = blockDefaultStart();
  // 四态 → 服务端字段（待办/进行中/完成/放弃），见 core/task-state.ts
  const fields = stateFields(block.state);
  return {
    uid,
    kind: "todo",
    calendarUrl: cal.url,
    href: cal.url.replace(/\/+$/, "") + "/" + uid + ".ics",
    summary: withPrefix(block.text, s),
    allDay: false,
    start,
    end: blockDefaultEnd(s, start),
    priority: 0,
    ...fields,
    completedAt: block.state === "done" ? stampOfMs(Date.now()) : undefined,
    createdAt: todayStamp() + "T" + new Date().toTimeString().slice(0, 8),
    blockId: block.id,
    blockText: block.text,
    blockChecked: block.state === "done",
    blockState: block.state
  };
}

/**
 * 跑一遍块对账。
 *
 * 顺序：扫块 → 捞「服务端改了、块没动」的块 → 查「映射里有、扫描没有」的块是否还在
 *      → 规划 → 执行（推送 / 回写 / 删除）→ 推进增量水位线。
 * ⚠️ 删除判生死**按 ID 查存在性**，不靠扫描范围 —— 否则「文档被删且当时没打开」会漏删
 *    （反过来，块只是不在范围内就绝不能删）。
 *
 * ── 扫描模式：全量 vs 增量（2026-10-30）──
 *   增量：SQL 只取「最后修改时间晚于水位线」的块（内核 `blocks.updated`）。
 *   ⚠️ 但**光靠增量不够** —— 全量扫描还承担两个「非块侧变化」的职责：
 *     ① 服务端改了、块没动（手机端勾完成 / 改标题）→ 要回写块。增量看不见，
 *        靠「服务端态 vs 缓存的块态」的漂移检测挑出来，按 ID 把块捞回来对账。
 *     ② 块被删了 → 要删 VTODO。增量也看不见（删掉的块根本没有 updated），
 *        靠「按 ID 查存在性」判定 —— 这是索引命中，比全量取 content/markdown 便宜得多。
 */
export async function runBlockSync(deps: BlockSyncDeps): Promise<BlockSyncResult> {
  const res = emptyResult();
  const s = deps.store.settings;
  if (!s.blockSyncEnabled) return res;

  const cal = resolveBlockCalendar(s);
  if (!cal) {
    res.errors.push("没有可用的日历（账户未配置或日历全部停用）");
    return res;
  }

  const scanOpts = {
    scope: s.blockSyncScope || "all",
    notebooks: s.blockSyncNotebooks || [],
    openDocIds: deps.openDocIds?.() || [],
    docIds: deps.docIds || [],
    prefix: s.blockSyncPrefix
  };

  // ── 本轮用全量还是增量 ──
  const singleDoc = scanOpts.docIds.length > 0;
  // 只有「覆盖完整」的范围才敢用/推水位线（成员会变的范围一律全量，见 scopeCoversWorkspace）
  const canUseWatermark = scopeCoversWorkspace(s.blockSyncScope) && !singleDoc;
  const scopeSig = blockScopeSig(s);
  const now = Date.now();
  const lastFull = deps.store.blockScanFullAt || 0;
  const needFull =
    !canUseWatermark || // 范围覆盖不全（open / daily）或限定单文档 → 全量
    !!deps.full || // 手动「扫描全部」/「立即扫描」
    s.blockSyncIncremental === false || // 用户关了增量 → 永远全量
    !deps.store.blockScanWatermark || // 首次（没有水位线）
    deps.store.blockScanScopeSig !== scopeSig || // 范围变了 → 旧水位线不再覆盖新范围
    !lastFull || // 从没全量过
    now - lastFull > BLOCK_FULL_SCAN_INTERVAL_MS; // 24h 校准到期
  // 增量水位：回退 2 秒（updated 只到秒，防同秒改动漏掉）
  const since =
    needFull || singleDoc ? undefined : blockStampOf((deps.store.blockScanWatermark || 0) - BLOCK_SCAN_OVERLAP_MS);
  res.mode = needFull ? "full" : "incremental";

  const scanStart = now;
  const scanned = await scanTaskBlocks(deps.caller, { ...scanOpts, since });
  res.scanned = scanned.blocks.length;
  if (scanned.truncated) {
    res.errors.push("扫描结果被内核截断（任务块过多），本轮未推进增量水位线");
  }

  // ── 服务端漂移：服务端改了、块没动的条目 ──
  // 增量扫描看不见它们（块没动 → updated 没变），得按 ID 把块捞回来对账，
  // 否则「手机上勾完成 → 回写到思源文档」这条链在增量模式下就断了。
  const mapped = deps.store.getAll().filter((it) => it.kind === "todo" && !!it.blockId);
  const driftIds = Array.from(
    new Set(mapped.filter((it) => blockItemDrift(it, s)).map((it) => it.blockId as string))
  );
  const drift = driftIds.length
    ? await scanTaskBlocksByIds(deps.caller, driftIds, scanOpts)
    : { blocks: [] as BlockTask[], truncated: false };
  if (drift.truncated) res.errors.push("按 ID 取块的结果被内核截断");

  // 合并（扫描到的优先）：同一个块既在增量结果又在漂移结果里，只算一次
  const blocks: BlockTask[] = [...scanned.blocks];
  const seen = new Set(blocks.map((b) => b.id));
  for (const b of drift.blocks) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    blocks.push(b);
  }

  // 映射里有、本轮没扫到的块：查还在不在（在 → 只是范围外/没改动，跳过；不在 → 删条目）
  const scannedIds = new Set(blocks.map((b) => b.id));
  const missing = Array.from(new Set(mapped.map((it) => it.blockId as string))).filter(
    (id) => !scannedIds.has(id)
  );
  // ⚠️⚠️ 免删白名单必须覆盖**全部** missing 块，不能按文档过滤（2026-10-30 修，用户实测踩中）。
  //
  // 【踩坑经过】用户「刷新」得到 100+ 条 VTODO → 编辑某篇文档删掉几个任务块 → 关闭该文档
  //   → 触发单文档扫描 → 结果**其它文档的 100 多条 VTODO 全被删了**，只剩本文档的 2 条。
  //
  // 【根因】本段原先写成「按 docIds 收口：只查本文档的块，把结果当白名单」。
  //   但白名单 `existing` 的语义是「**这些块还活着，别删**」——
  //   别的文档的块没被扫到，**只是因为本轮范围窄**，不是「块没了」。
  //   把它们排除在白名单外 → planBlockSync 判它们「不在 existing」→ **全部进删除队列**。
  //   我把「收窄删除范围」的意图，实现成了「收窄免删范围」，语义正好反了。
  //
  // 【正解】判生死**只有一个依据：这个块在数据库里还在不在**（按 ID 查存在性）。
  //   这与扫描范围完全无关 —— 范围只决定「哪些块进入本轮对账」，不决定「谁该死」。
  //   · 别的文档的块：存在 → 进白名单 → 不删 ✓
  //   · 本文档里被用户删掉的块：查不到 → 不进白名单 → 删 ✓（这才是真删除）
  //   · 本文档里被 skip 标记排除的块：存在 → 不删 ✓
  //   顺带：单文档扫描时，本文档里「还在但没改动」的块也会被查存在性命中 → 不删 ✓
  let existing = new Set<string>();
  let checked: Set<string> = new Set();
  if (missing.length) {
    const r = await blocksExistById(deps.caller, missing);
    existing = r.found;
    checked = new Set(missing);
    // ⚠️ 查询失败/被截断 → 判生死不可靠 → **本轮一个都不删**（宁可留着旧的，也别删用户的）。
    //    「查失败」若被当成「全都查到了没有」→ 全库映射被判成孤儿 → 一次性删光（与上面同类的灾难）。
    if (r.failed || r.truncated) {
      res.errors.push("查块存在性失败/被截断，本轮未删除任何条目（保守）");
      existing = new Set(missing); // 全部当作「还活着」→ 白名单拉满 → 不删
    }
  }

  const plan = planBlockSync(blocks, deps.store.getAll(), s, {
    conflict: (enabledAccountsConflict(s) as "local" | "server") || "server",
    existing,
    checked
  });

  // 1) 回写块（服务端状态变了）：先改块，再改条目 —— 块是用户看得见的那一边
  //
  // ⚠️ 写回前 `planBlockSync` 已过 `canWriteState` 的**单向保险**：
  //    只写「能安全推进」的状态，绝不把用户勾好的待办拽回未完成。
  for (const w of plan.writebacks) {
    const ok = await setBlockState(deps.caller, {
      id: w.block.id,
      state: w.state,
      markdown: w.block.markdown || ""
    });
    if (ok) res.written++;
    else res.errors.push(`回写块失败：${w.block.text}`);
  }
  // 2) 新建
  for (const c of plan.creates) {
    try {
      await deps.sync.createItem(blockToItem(c.block, cal, s));
      res.created++;
    } catch (e) {
      res.errors.push(`新建失败「${c.block.text}」：${(e as Error)?.message || e}`);
    }
  }
  // 3) 推送（文字/完成态/缓存）
  for (const p of plan.pushes) {
    try {
      await deps.sync.updateItem(p.item);
      res.updated++;
    } catch (e) {
      res.errors.push(`更新失败「${p.item.summary}」：${(e as Error)?.message || e}`);
    }
  }
  // 4) 删除（块没了）
  for (const it of plan.deletions) {
    try {
      await deps.sync.removeItem(it);
      res.deleted++;
    } catch (e) {
      res.errors.push(`删除失败「${it.summary}」：${(e as Error)?.message || e}`);
    }
  }

  // ── 推进增量水位线 ──
  // 推进到「**本轮开始时刻**」而不是结束时刻：扫描期间发生的改动留给下一轮，
  // 绝不会漏（下一轮的水位线回退 2 秒，又多留一道重叠）。
  // ⚠️ 三种情况**绝不推进**：
  //   ① 范围覆盖不全（open / daily）或单文档扫描（没覆盖全库，推进了会漏掉别的范围的改动）；
  //   ② 结果被内核截断（没扫全，推进了就等于把没扫到的块永久跳过）。
  if (canUseWatermark && !scanned.truncated && !drift.truncated) {
    deps.store.blockScanWatermark = scanStart;
    if (needFull) deps.store.blockScanFullAt = scanStart;
    deps.store.blockScanScopeSig = scopeSig;
    deps.store.markStateDirty();
  }
  return res;
}

/** 冲突策略取第一个启用账户的口径（与同步提示文案同一判据） */
function enabledAccountsConflict(s: CalSettings): string {
  const acc = (s.accounts || []).find((a) => a.enabled);
  return acc?.conflict || "server";
}

/** 单笔转换：块菜单「同步此任务到 CalDAV」 */
export async function convertBlock(deps: BlockSyncDeps, block: BlockTask): Promise<boolean> {
  const s = deps.store.settings;
  const cal = resolveBlockCalendar(s);
  if (!cal) throw new Error("没有可用的日历（账户未配置或日历全部停用）");
  await deps.sync.createItem(blockToItem(block, cal, s));
  return true;
}

/**
 * 取消同步：删 VTODO + 打忽略标记。
 *
 * ⚠️ 必须打标记：只删 VTODO 而不标记，下一轮扫描会把它当成陌生块**再建一个**
 * （雄哥 2026-10-28 追问的正是这个洞）。标记存在块上（`custom-caldav-skip`）
 * 而不是配置里 —— 配置清空/插件重装后标记还在，不会被扫回来。
 */
export async function unsyncBlock(deps: BlockSyncDeps, item: CalItem): Promise<void> {
  if (item.blockId) await setBlockSkip(deps.caller, item.blockId, true);
  await deps.sync.removeItem(item);
}

/** 重新同步（块菜单第三态）：清标记 → 立刻建回来 */
export async function resyncBlock(deps: BlockSyncDeps, block: BlockTask): Promise<void> {
  await setBlockSkip(deps.caller, block.id, false);
  await convertBlock(deps, block);
}

/**
 * 一键清理：删掉**全部**块来源 VTODO（块本身不动 —— 那是用户自己的文字）。
 * 给「开过之后后悔了、碍眼」准备的出口；清理完若开关还开着、范围还覆盖着，
 * 下一轮又会重新建回来，所以调用方应当提示（或让用户顺手关掉开关）。
 */
export async function clearBlockSync(deps: BlockSyncDeps): Promise<BlockSyncResult> {
  const res = emptyResult();
  const items = deps.store.getAll().filter((it) => it.kind === "todo" && !!it.blockId);
  for (const it of items) {
    try {
      await deps.sync.removeItem(it);
      res.deleted++;
    } catch (e) {
      res.errors.push(`删除失败「${it.summary}」：${(e as Error)?.message || e}`);
    }
  }
  return res;
}
