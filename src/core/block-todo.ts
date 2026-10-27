/**
 * 思源文档任务块 ⇄ CalDAV VTODO 的对账核心（纯逻辑，不碰网络、不碰 DOM）。
 *
 * 背景：GitHub issue #2 —— 用户习惯在思源文档里直接写 `- [ ] 待办`，希望这些
 * **原生任务块**能自动同步到 CalDAV，并在手机端（Tasks.org / DAVx⁵）管理。
 * 身份锚点用 **Block ID**（写进 VTODO 的 `X-SIYUAN-BLOCK-ID`），不用文本匹配：
 * 文本怎么改都对得上，配置丢了也能靠服务端这份属性重建映射。
 *
 * 每轮同步跑一次**三方对账**：
 *   ① 文档侧：内核 SQL 扫出来的任务块（id / 文字 / 勾选态）
 *   ② 服务端侧：同步拉取回来的 VTODO（含 X-SIYUAN-BLOCK-ID）
 *   ③ 本地 store：已建立的映射（CalItem.blockId + 缓存的块状态）
 *
 * 产出四类动作（见 BlockSyncPlan）：
 *   create    块有、映射无、服务端也无 → 新建 VTODO
 *   push      块侧改了（文字/勾选）   → 推服务端
 *   writeback 服务端改了（标题/完成） → 回写块
 *   delete    块没了（**按 ID 直接查在不在**，不受扫描范围影响）→ 删 VTODO
 *
 * ⚠️ 冲突判据的关键：CalItem 上缓存了 `blockText` / `blockChecked`（上次同步时块的
 *    状态）。没有这份缓存就无法区分「块改了」还是「服务端改了」，只能拍脑袋。
 *    稳态下三者相等：`块.text === item.blockText === 服务端标题（去前缀）`。
 *
 * ⚠️ 「完成优先」：两边都动了且其中一边是完成 → 按完成处理。完成是终态，
 *    这样不会来回翻转（推完完成态 / 回写完勾选项后下一轮自动稳定）。
 *    两边都动的**文字**冲突按账户的冲突策略（local=块优先 / server=服务端优先）。
 */
import type { CalItem, CalSettings } from "./types";
import { defaultStartStamp, todayStamp, stampOfMs, addDays as addDaysStamp } from "./date";

/** 文档里的任务块（内核 SQL 出来后已清洗） */
export interface BlockTask {
  /** 块的 Block ID —— 与 VTODO 的唯一身份锚点 */
  id: string;
  /** 块的可见文字（已去 `- [ ] ` 标记、引用链接还原为纯文本、去前后空白、去掉同步前缀） */
  text: string;
  /** 勾选态（完成） */
  checked: boolean;
  /** 所在文档 ID */
  rootId?: string;
  /** 所在笔记本 ID */
  box?: string;
  /** 文档人类路径（调试/日志用） */
  hpath?: string;
  /**
   * 块的原始 markdown（回写勾选态要用 —— 只改第一行的方括号，子块原样带回）。
   * 扫描时一并带出来，回写前不必再查一次内核。
   */
  markdown?: string;
}

/** 新建动作：块 → VTODO（条目由执行层拼，这里只给语义值） */
export interface BlockCreate {
  block: BlockTask;
  /** 写入 VTODO 的标题（已按设置拼好前缀） */
  summary: string;
  completed: boolean;
}

/** 推送动作：条目已含改动后的字段，执行层直接 updateItem */
export interface BlockPush {
  item: CalItem;
  block: BlockTask;
}

/** 回写动作：把块改成 checked（文字不回写，理由见下） */
export interface BlockWriteback {
  item: CalItem;
  block: BlockTask;
  checked: boolean;
}

export interface BlockSyncPlan {
  creates: BlockCreate[];
  pushes: BlockPush[];
  writebacks: BlockWriteback[];
  deletions: CalItem[];
  /** 扫描到的块里「两边一致、无需动作」的数量（反馈文案用） */
  unchanged: number;
}

/** 前缀默认值（设置里可改） */
export const DEFAULT_BLOCK_PREFIX = "[文档]";

/**
 * 块的原始 markdown → 勾选态。
 * 只看第一个 `- [ ]` / `- [x]`（块可能有缩进，也可能带子块），避免误伤正文里的方括号。
 */
export function blockCheckedOf(markdown: string): boolean {
  const m = /^\s*[-*+]\s+\[([ xX])\]/.exec(markdown || "");
  return !!m && m[1].toLowerCase() === "x";
}

/**
 * 块文字清洗：内核给的 `content` 已把引用 `((id "文本"))` 还原成纯文本，
 * 这里只做去空白与去掉同步前缀（前缀是插件自己加的，不能当成正文）。
 */
export function cleanBlockText(raw: string, prefix?: string): string {
  let s = (raw || "").replace(/\s+/g, " ").trim();
  const p = (prefix || "").trim();
  if (p && s.startsWith(p)) s = s.slice(p.length).trim();
  return s;
}

/** 按设置拼前缀（写进 VTODO 的 SUMMARY） */
export function withPrefix(text: string, settings: CalSettings): string {
  if (!settings.blockSyncMarks?.includes("prefix")) return text;
  const p = (settings.blockSyncPrefix || DEFAULT_BLOCK_PREFIX).trim();
  return p ? p + text : text;
}

/** 去掉 SUMMARY 里的同步前缀，得到「块该显示的文字」 */
export function stripPrefix(summary: string, settings: CalSettings): string {
  const p = (settings.blockSyncPrefix || DEFAULT_BLOCK_PREFIX).trim();
  if (p && summary.startsWith(p)) return summary.slice(p.length).trim();
  return summary;
}

/** 是否给条目加「文档」小角标（纯 UI，不动数据） */
export function blockBadgeOn(settings: CalSettings): boolean {
  // 未显式配置时按默认开（DEFAULT_SETTINGS 是 ["badge"]），显式给了空数组才是关
  return settings.blockSyncMarks === undefined || settings.blockSyncMarks.includes("badge");
}

/** 完成态的字段组合（与编辑器口径一致：完成=100%/COMPLETED，未完成=0%/NEEDS-ACTION） */
export function completedFields(completed: boolean): Pick<CalItem, "status" | "percent"> {
  return completed ? { status: "COMPLETED", percent: 100 } : { status: "NEEDS-ACTION", percent: 0 };
}

/**
 * 新建条目的默认截止：
 *  `"none"` → 无日期任务（不写 DUE）；
 *  `"sameAsTodo"` → 跟随「新建待办任务时默认结束时间」（settings.todoDefaultEnd）。
 *
 * 基准是**开始时间**（新建时开始默认为当前时刻的下一个整点，等价「当前时间 + N 小时」），
 * 与编辑器口径完全一致，避免算出「截止早于开始」的无效区间。
 */
export function blockDefaultEnd(settings: CalSettings, start: string): string | undefined {
  if (settings.blockSyncDefaultEnd === "none") return undefined;
  const mode = settings.todoDefaultEnd || "plus8h";
  if (mode === "none") return undefined;
  const ms = new Date(start.replace(" ", "T")).getTime() + (mode === "plus1h" ? 1 : 8) * 3600000;
  return Number.isFinite(ms) ? stampOfMs(ms) : undefined;
}

/** 新建条目的默认开始（今天 → 下一个整点） */
export function blockDefaultStart(): string {
  return defaultStartStamp(todayStamp());
}

function localNowStamp(): string {
  return stampOfMs(Date.now());
}

/**
 * 三方对账。
 *
 * @param blocks  本轮扫描到的任务块（**已按设置排除 skip 标记与范围外**）
 * @param items   store 里的全部条目（对账只看其中带 blockId 的待办）
 * @param settings 设置（前缀 / 默认结束时间 / 标记）
 * @param opts.conflict   冲突策略（local=块优先 / server=服务端优先），取当前账户口径
 * @param opts.existing   需要判生死的 blockId 集合（扫描范围外但**仍然存在的块**）。
 *                         对账时凡「映射有、扫描没有」的都来这里查：在 → 只是不在范围内，
 *                         跳过；不在 → 块真的没了，删 VTODO。
 *                         ⚠️ 用 ID 直接查存在性，而不是靠扫描范围判断 —— 否则「文档被删且
 *                         当时没打开」会被误判成「不在范围内」而漏删（雄哥 2026-10-28 追问）。
 */
export function planBlockSync(
  blocks: BlockTask[],
  items: CalItem[],
  settings: CalSettings,
  opts: { conflict?: "local" | "server"; existing?: Set<string> } = {}
): BlockSyncPlan {
  const conflict = opts.conflict || "server";
  const existing = opts.existing || new Set<string>();
  // 文字一律以块为准，冲突策略此刻只影响未来的「文字双向」能力，先留着（见下）
  void conflict;
  const plan: BlockSyncPlan = { creates: [], pushes: [], writebacks: [], deletions: [], unchanged: 0 };

  // 映射索引：blockId → 条目。同一块若被重复建过（异常数据）取第一条，其余交给人工清理。
  const byBlock = new Map<string, CalItem>();
  for (const it of items) {
    if (it.kind !== "todo" || !it.blockId) continue;
    if (!byBlock.has(it.blockId)) byBlock.set(it.blockId, it);
  }

  const seen = new Set<string>();
  for (const b of blocks) {
    if (!b.id) continue;
    seen.add(b.id);
    const it = byBlock.get(b.id);
    if (!it) {
      plan.creates.push({
        block: b,
        summary: withPrefix(b.text, settings),
        completed: b.checked
      });
      continue;
    }
    byBlock.delete(b.id);

    const serverCompleted = it.percent === 100 || it.status === "COMPLETED";
    // ── 文字：**一律以块为准**（文档是主体）──
    //
    // 为什么不回写块文字：块的 `content` 是纯文本，块里可能有加粗、行内代码、引用
    // `((id "文本"))`、图片等富文本，用纯文本去 `updateBlock` 会把它们一律拍平 ——
    // 用户在手机端改个标题，代价是文档里的格式被毁，不划算。
    // 所以服务端标题永远跟随块：块改了就推，服务端那边被别的客户端改了就在下一轮
    // 被块覆盖回来。需要手机端也能改名的话另行评估（得改成 dom 级的增量改写）。
    const nextText = b.text;
    const textDiffers = stripPrefix(it.summary || "", settings) !== nextText;

    // ── 勾选 / 完成：双向 ──
    // 判据靠缓存：稳态下 `块.checked === item.blockChecked === 服务端完成态`，
    // 谁跟缓存不一样就是谁动了。缓存缺失（服务端重建映射）→ 以块为准。
    const cachedChecked = it.blockChecked;
    const blockChanged = cachedChecked === undefined ? false : b.checked !== cachedChecked;
    const serverChanged = cachedChecked === undefined ? false : serverCompleted !== cachedChecked;
    let nextChecked: boolean;
    if (blockChanged && serverChanged) {
      // 两边都动了 → 完成优先（完成是终态，避免来回翻转）
      nextChecked = b.checked || serverCompleted;
    } else if (blockChanged) {
      nextChecked = b.checked;
    } else if (serverChanged) {
      nextChecked = serverCompleted;
    } else {
      nextChecked = cachedChecked === undefined ? b.checked : cachedChecked;
    }

    const checkedDiffers = b.checked !== nextChecked;
    const itemDiffers = textDiffers || serverCompleted !== nextChecked;

    const next: CalItem = {
      ...it,
      blockText: nextText,
      blockChecked: nextChecked
    };
    if (itemDiffers) {
      next.summary = withPrefix(nextText, settings);
      Object.assign(next, completedFields(nextChecked));
      if (nextChecked && !it.completedAt) next.completedAt = localNowStamp();
      if (!nextChecked) next.completedAt = undefined;
    }

    if (!itemDiffers && !checkedDiffers) {
      // 完全对齐，但缓存可能还没建（首次/映射重建）→ 只落缓存，不算动作
      if (it.blockText !== nextText || it.blockChecked !== nextChecked) {
        plan.pushes.push({ item: next, block: b });
      } else {
        plan.unchanged++;
      }
      continue;
    }
    // 块侧要改（服务端完成态变了）→ 回写块的勾选
    if (checkedDiffers) plan.writebacks.push({ item: next, block: b, checked: nextChecked });
    // 条目侧要改（文字/完成态，或只是补缓存）→ 推送
    plan.pushes.push({ item: next, block: b });
  }

  // 映射有、本轮扫描没扫到 → 查存在性：还活着（只是不在范围内）跳过，真没了就删
  for (const it of byBlock.values()) {
    const id = it.blockId as string;
    if (existing.has(id)) continue;
    plan.deletions.push(it);
  }

  return plan;
}

/** 生成块来源条目的 UID（不依赖 ui 层，core 不能反向依赖 ui） */
export function newBlockUid(): string {
  return "sy-blk-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** 全天待办的兜底截止（编辑器口径）：次日 */
export function blockAllDayEnd(start: string): string {
  return addDaysStamp(start, 1);
}
