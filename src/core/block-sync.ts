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
import { blockDefaultEnd, blockDefaultStart, completedFields, newBlockUid, planBlockSync, withPrefix } from "./block-todo";
import { scanTaskBlocks, blocksExistById, setBlockChecked, setBlockSkip } from "./block-api";
import type { BlockTask } from "./block-todo";
import { stampOfMs, todayStamp } from "./date";

export interface BlockSyncDeps {
  store: CalStore;
  sync: SyncEngine;
  caller: KernelCaller;
  /** 当前打开的文档 ID 列表（范围 = 打开的文档时用） */
  openDocIds?: () => string[];
}

export interface BlockSyncResult {
  scanned: number;
  created: number;
  updated: number;
  written: number;
  deleted: number;
  errors: string[];
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
  const done = completedFields(block.checked);
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
    ...done,
    completedAt: block.checked ? stampOfMs(Date.now()) : undefined,
    createdAt: todayStamp() + "T" + new Date().toTimeString().slice(0, 8),
    blockId: block.id,
    blockText: block.text,
    blockChecked: block.checked
  };
}

/**
 * 跑一遍块对账。
 *
 * 顺序：扫块 → 查「映射里有、扫描没有」的块是否还在 → 规划 → 执行（推送 / 回写 / 删除）。
 * ⚠️ 删除判生死**按 ID 查存在性**，不靠扫描范围 —— 否则「文档被删且当时没打开」会漏删
 *    （反过来，块只是不在范围内就绝不能删）。
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

  const blocks = await scanTaskBlocks(deps.caller, {
    scope: s.blockSyncScope || "all",
    notebooks: s.blockSyncNotebooks || [],
    openDocIds: deps.openDocIds?.() || [],
    prefix: s.blockSyncPrefix
  });
  res.scanned = blocks.length;

  // 映射里有、本轮没扫到的块：查还在不在（在 → 只是范围外，跳过；不在 → 删条目）
  const scannedIds = new Set(blocks.map((b) => b.id));
  const mapped = deps.store.getAll().filter((it) => it.kind === "todo" && !!it.blockId);
  const missing = Array.from(new Set(mapped.map((it) => it.blockId as string))).filter(
    (id) => !scannedIds.has(id)
  );
  const existing = missing.length ? await blocksExistById(deps.caller, missing) : new Set<string>();

  const plan = planBlockSync(blocks, deps.store.getAll(), s, {
    conflict: (enabledAccountsConflict(s) as "local" | "server") || "server",
    existing
  });

  // 1) 回写块（服务端完成态变了）：先改块，再改条目 —— 块是用户看得见的那一边
  for (const w of plan.writebacks) {
    const ok = await setBlockChecked(deps.caller, {
      id: w.block.id,
      checked: w.checked,
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
