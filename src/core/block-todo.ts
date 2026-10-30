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
import {
  type TaskState,
  canWriteState,
  mergeServerState,
  markerOfState,
  stateOfStatus,
  statusFields,
  taskStateOfMarkdown
} from "./task-state";

/** 文档里的任务块（内核 SQL 出来后已清洗） */
export interface BlockTask {
  /** 块的 Block ID —— 与 VTODO 的唯一身份锚点 */
  id: string;
  /** 块的可见文字（已去 `- [ ] ` 标记、引用链接还原为纯文本、去前后空白、去掉同步前缀） */
  text: string;
  /**
   * 任务状态（四态）：待办 / 进行中 / 完成 / 放弃。
   *
   * 来自 markdown 第一行的 marker（`- [ ]` / `- [/]` / `- [X]` / `- [-]`），
   * 与 VTODO 的 STATUS 一一对应。详见 core/task-state.ts。
   */
  state: TaskState;
  /** 勾选态（完成）—— `state === "done"` 的兼容视图，保留给旧调用点 */
  checked: boolean;
  /** markdown 里的原始 marker（自定义任务状态时用它才能原样写回） */
  marker?: string;
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
  /** 块的任务状态（四态） */
  state: TaskState;
  /** 勾选态（完成）—— 兼容视图 */
  completed: boolean;
}

/** 推送动作：条目已含改动后的字段，执行层直接 updateItem */
export interface BlockPush {
  item: CalItem;
  block: BlockTask;
}

/** 回写动作：把块改成指定状态（文字不回写，理由见下） */
export interface BlockWriteback {
  item: CalItem;
  block: BlockTask;
  /** 目标状态（四态） */
  state: TaskState;
  /** 勾选态（完成）—— 兼容视图 */
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
 *
 * ⚠️ 现在走统一的状态模型（core/task-state.ts），所以 `- [/]`（进行中）、`- [-]`（放弃）
 *    也认得 —— 它们都不是「勾选态」，所以这里返回 false，与旧口径一致。
 */
export function blockCheckedOf(markdown: string): boolean {
  return taskStateOfMarkdown(markdown).state === "done";
}

/** 块的原始 markdown → 四态任务状态（待办 / 进行中 / 完成 / 放弃） */
export function blockStateOf(markdown: string): TaskState {
  return taskStateOfMarkdown(markdown).state;
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

/**
 * 完成态的字段组合（与编辑器口径一致：完成=100%/COMPLETED，未完成=0%/NEEDS-ACTION）。
 *
 * ⚠️ 旧的二态接口，保留给非块来源的调用点（编辑器、面板等）。
 *    块来源的条目请用 `statusFields(state)`（四态，见 core/task-state.ts）。
 */
export function completedFields(completed: boolean): Pick<CalItem, "status" | "percent"> {
  return completed ? { status: "COMPLETED", percent: 100 } : { status: "NEEDS-ACTION", percent: 0 };
}

/** 四态 → 服务端条目字段（转发到统一状态模型，避免两处各写一份映射） */
export function stateFields(state: TaskState): Pick<CalItem, "status" | "percent"> {
  return statusFields(state);
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
 * 条目缓存的块状态。
 *
 * ⚠️ `blockState` 是四态改造新增的字段，**老数据只有 `blockChecked`（布尔）** ——
 *    这里从它推导：true → 完成，false → 待办。
 *    （进行中 / 放弃是新增能力，老数据本来就没有，推导不出也不影响正确性。）
 */
export function cachedStateOf(item: CalItem): TaskState | undefined {
  if (item.blockState) return item.blockState;
  if (item.blockChecked === undefined) return undefined;
  return item.blockChecked ? "done" : "todo";
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
 * @param opts.checked    **本轮实际查过存在性**的 blockId 集合。只有落在它里面、又不在
 *                         `existing` 里的块才允许删除 —— 防止白名单出错导致删光用户待办
 *                         （2026-10-30 用户实测踩中，见下方删除分支的注释）。
 */
export function planBlockSync(
  blocks: BlockTask[],
  items: CalItem[],
  settings: CalSettings,
  opts: { conflict?: "local" | "server"; existing?: Set<string>; checked?: Set<string> } = {}
): BlockSyncPlan {
  const conflict = opts.conflict || "server";
  const existing = opts.existing || new Set<string>();
  const checked = opts.checked;
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
        state: b.state,
        completed: b.state === "done"
      });
      continue;
    }
    byBlock.delete(b.id);

    // 服务端条目当前的**四态**（STATUS + PERCENT-COMPLETE → 待办/进行中/完成/放弃）
    const serverState = stateOfStatus(it.status, it.percent);
    // ── 文字：**一律以块为准**（文档是主体）──
    //
    // 为什么不回写块文字：块的 `content` 是纯文本，块里可能有加粗、行内代码、引用
    // `((id "文本"))`、图片等富文本，用纯文本去 `updateBlock` 会把它们一律拍平 ——
    // 用户在手机端改个标题，代价是文档里的格式被毁，不划算。
    // 所以服务端标题永远跟随块：块改了就推，服务端那边被别的客户端改了就在下一轮
    // 被块覆盖回来。需要手机端也能改名的话另行评估（得改成 dom 级的增量改写）。
    const nextText = b.text;
    const textDiffers = stripPrefix(it.summary || "", settings) !== nextText;

    // ── 任务状态（四态）：双向 ──
    //
    // 判据靠缓存：稳态下 `块.state === item.blockState === 服务端状态`，
    // 谁跟缓存不一样就是谁动了。缓存缺失（服务端重建映射）→ 以块为准。
    const cachedState = cachedStateOf(it);
    const blockChanged = cachedState === undefined ? false : b.state !== cachedState;
    const serverChanged = cachedState === undefined ? false : serverState !== cachedState;
    let nextState: TaskState;
    if (blockChanged && serverChanged) {
      // 两边都动了 → 完成优先（完成是终态，避免来回翻转）；其余以块为准
      nextState = b.state === "done" || serverState === "done" ? "done" : b.state;
    } else if (blockChanged) {
      // 块改了 → 以块为准（用户的主数据）
      nextState = b.state;
    } else if (serverChanged) {
      // 服务端态与缓存不符，而**块没动** → 走**单向保险**。
      //
      // ⚠️⚠️ **服务端只能把块往前推，不能把块往回拽**（2026-10-30 用户实测踩中过一次）。
      //   规则（见 core/task-state.ts 的 mergeServerState）：
      //     · 服务端「完成」  → 允许（块可以是待办/进行中/放弃）
      //     · 服务端「进行中」→ 只在块是「待办」时允许
      //     · 服务端「放弃」  → 只在块是「待办/进行中」时允许
      //     · 服务端「待办」  → **永远不允许**（服务端只是「没标完成」，没有更多信息）
      //
      // 【踩坑经过】用户「AI开发」文档里 60 个已勾选的任务块，一夜之间全被改成未勾选。
      //   根因：服务端那条 VTODO 当时是 NEEDS-ACTION，而缓存记着「块是勾选的」→
      //   判定落在 serverChanged 分支 → nextChecked = serverCompleted = false →
      //   回写块，把用户的 `- [X]` 拍成 `- [ ]`。
      //
      // 【⚠️ 不要归咎于「服务端降级」】2026-10-30 实测证伪了那个说法：
      //   Baikal **不会**无缘无故把 COMPLETED 改成 NEEDS-ACTION（新建→GET、
      //   改回→GET、等 3 秒→GET 四轮往返全对；199 条 COMPLETED 逐条 GET 与
      //   REPORT 两条路径读回来全是 COMPLETED）。
      //   服务端那一刻之所以是 NEEDS-ACTION，是**插件自己写的**：
      //   更新时带 `If-Match: <本地 etag>`，服务端内容已变 → 返 412 →
      //   插件按冲突策略（server=服务端优先）丢弃本地改动 → 完成态被服务端那份覆盖。
      //
      // 【正确口径】状态只允许**单向**影响块：服务端能安全推进块时才写回；
      //   取消勾选只能由用户在文档里直接做。
      //   这条铁律不依赖「服务端靠不靠谱」，是**结构性保险**：最坏只是该推进的没推进，
      //   绝不会出现用户勾好的待办被插件悄悄取消。
      nextState = mergeServerState(b.state, serverState);
    } else {
      nextState = cachedState === undefined ? b.state : cachedState;
    }

    const stateDiffers = b.state !== nextState;
    const itemDiffers = textDiffers || serverState !== nextState;

    const next: CalItem = {
      ...it,
      blockText: nextText,
      blockChecked: nextState === "done",
      blockState: nextState
    };
    if (itemDiffers) {
      next.summary = withPrefix(nextText, settings);
      Object.assign(next, statusFields(nextState));
      if (nextState === "done" && !it.completedAt) next.completedAt = localNowStamp();
      if (nextState !== "done") next.completedAt = undefined;
    }

    if (!itemDiffers && !stateDiffers) {
      // 完全对齐，但缓存可能还没建（首次/映射重建）→ 只落缓存，不算动作
      if (it.blockText !== nextText || it.blockChecked !== (nextState === "done")) {
        plan.pushes.push({ item: next, block: b });
      } else {
        plan.unchanged++;
      }
      continue;
    }
    // 块侧要改 → 回写块的状态
    //
    // ⛔⛔ **结构性保险（函数级）**：只有「服务端状态能安全推进块」时才允许回写。
    //   `canWriteState` 把「不许降级」写死在状态模型里（core/task-state.ts），
    //   哪怕上面的判定逻辑将来又被改错，最坏也只是「该推进的没推进」，
    //   绝不会出现「用户勾好的待办被插件悄悄取消」—— 那是直接改写用户的主数据。
    //   （旧口径是特判 `wouldUncheck`，只能防「取消完成」；现在连「取消完成」、
    //   「撤销放弃」、「把进行中拽回待办」都一并挡住了。）
    if (stateDiffers && canWriteState(b.state, nextState)) {
      plan.writebacks.push({
        item: next,
        block: b,
        state: nextState,
        checked: nextState === "done"
      });
    }
    // 条目侧要改（文字/状态，或只是补缓存）→ 推送
    plan.pushes.push({ item: next, block: b });
  }

  // 映射有、本轮扫描没扫到 → 查存在性：还活着（只是不在范围内）跳过，真没了就删
  //
  // ⚠️⚠️ **只有「本轮确实查过存在性、且确认不存在」的块才允许删**（2026-10-30 用户实测踩中）。
  //   曾经的写法是「不在 existing 白名单里 → 删」—— 这意味着**白名单漏一个就删一个**。
  //   而白名单的构造一旦出错（范围收窄、查询失败、忘了传），后果是**把用户的待办删光**。
  //   改成「必须落在 checked（查过存在性）里，且不在 existing（还活着）里」→ 双重条件，
  //   白名单算错最多是「该删的没删」，绝不会「不该删的删了」。
  for (const it of byBlock.values()) {
    const id = it.blockId as string;
    if (existing.has(id)) continue;      // 还活着 → 跳过
    if (checked && !checked.has(id)) continue; // 没查过存在性 → 不动（保守）
    plan.deletions.push(it);
  }

  return plan;
}

/**
 * 条目是否「与服务端漂移」—— 即**服务端那边**的态，跟上次对账时缓存的块态对不上。
 *
 * 为什么需要它（增量扫描的配套件）：增量扫描只看**块侧**的改动。用户在手机端把待办
 * 勾完成、或改了标题，块没动 → 增量扫描看不见这条 → 对账就不会发生，「服务端完成
 * → 回写文档勾选」这条链就断了。靠本函数把这些条目挑出来，按 ID 把块捞回来对账。
 *
 * 判据与 planBlockSync 的缓存判据同源：
 *   完成态：服务器态（percent / status）≠ 缓存的 blockChecked
 *   标题  ：服务器标题（去前缀）≠ 缓存的 blockText
 *   缓存缺失（老数据 / 映射重建）→ 视为漂移，让它重新对账一次把缓存建起来
 */
export function blockItemDrift(item: CalItem, settings: CalSettings): boolean {
  if (item.kind !== "todo" || !item.blockId) return false;
  const cached = cachedStateOf(item);
  if (cached === undefined || item.blockText === undefined) return true;
  const server = stateOfStatus(item.status, item.percent);
  // ⚠️ 只认**能安全推进块**的方向的漂移 —— 判据直接复用单向保险的同一函数
  //   （mergeServerState）：服务端状态若会改变块的状态，就是真漂移。
  //   · 服务端「完成」+ 块未完成 → 漂移（要回写勾上，手机端勾完成 → 回写文档）
  //   · 服务端「进行中/放弃」+ 块是待办 → 漂移（明确状态，可以推进）
  //   · 服务端「待办」+ 块已完成 → **不算漂移**：服务端只是没标完成，没有更多信息；
  //     判成漂移会让每轮扫描都把这些条目按 ID 捞回来重新对账 —— 白跑一轮，
  //     且反复触发完成态判定（2026-10-30 用户实测踩中）。
  //   · 服务端「进行中/放弃」+ 块已完成 → **不算漂移**（不撤销用户的完成）
  if (mergeServerState(cached, server) !== cached) return true;
  if (stripPrefix(item.summary || "", settings) !== item.blockText) return true;
  return false;
}

/**
 * 扫描范围的签名。
 *
 * 范围一变（换了范围模式、增删了笔记本），旧的水位线就不再覆盖新范围 → 必须重新
 * 做一次全量，否则新范围里那些「老于水位线」的块会被永远跳过（静默漏同步）。
 */
export function blockScopeSig(s: CalSettings): string {
  return JSON.stringify([s.blockSyncScope || "all", (s.blockSyncNotebooks || []).slice().sort()]);
}

/** 生成块来源条目的 UID（不依赖 ui 层，core 不能反向依赖 ui） */
export function newBlockUid(): string {
  return "sy-blk-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** 全天待办的兜底截止（编辑器口径）：次日 */
export function blockAllDayEnd(start: string): string {
  return addDaysStamp(start, 1);
}
