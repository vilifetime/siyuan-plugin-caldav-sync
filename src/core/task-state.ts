/**
 * 任务状态模型：思源任务块 marker ⇄ VTODO STATUS ⇄ 插件内部状态。
 *
 * 【为什么单独抽一个模块】
 *   状态要在三个地方来回转：思源文档里的 markdown 标记、CalDAV 服务端的
 *   `STATUS` 属性、插件内存/store 里的条目字段。三处各写一份映射迟早对不上，
 *   所以收敛到这里，core 里其它模块一律引用这里的函数。
 *
 * 【思源侧：四种状态存哪儿】
 *   思源的任务列表项状态**存在 markdown 第一行方括号里的那个字符**（marker）。
 *   这是从思源内核源码读出来的确定结论，不是猜的：
 *     · `app/src/protyle/wysiwyg/taskStatusDialog.ts` —— 菜单项与 marker 的对应：
 *         待办   `taskStatusTodo`       marker `" "` → `NEEDS-ACTION`
 *         进行中 `taskStatusInProgress` marker `"/"` → `IN-PROCESS`
 *         完成   `taskStatusDone`       marker `"X"` → `COMPLETED`
 *         放弃   `taskStatusCanceled`   marker `"-"` → `CANCELLED`
 *     · `app/src/protyle/wysiwyg/taskListMarker.ts` —— marker 循环顺序
 *       `[" ", "/", "X", "-"]`，且 `isTaskListMarker` 允许**任意单字符**
 *       （用户可自定义任务状态，自定义的就落在这个兜底里）。
 *     · `app/src/protyle/wysiwyg/list.ts` 的 `setTaskListItemMarker` ——
 *       点菜单就是改 marker，然后 `updateTransaction` 写回文档。
 *   也就是说：markdown 里 `- [ ]` / `- [/]` / `- [X]` / `- [-]` 四种形态，
 *   与 RFC 5545 的 `STATVALUE-TODO` 四值**一一对应**。
 *
 * 【VTODO 侧：RFC 5545 的四个 STATVALUE-TODO】
 *   NEEDS-ACTION / IN-PROCESS / COMPLETED / CANCELLED。
 *   服务端可能给出这四个之外的非法值（别的客户端乱写的），一律按 NEEDS-ACTION 兜底。
 *
 * 【自定义任务状态怎么归类】
 *   思源允许用户自定义任意单字符的状态（如 `- [!]`）。VTODO 没有对应的值，
 *   只能归到「待办」（NEEDS-ACTION）—— 这是**最保守**的归法：既不会把未完成
 *   说成完成，也不会把完成说成未完成。插件也**不会**去改写这类块的 marker
 *   （状态没变就不写回，见 `mergeServerState`）。
 */

/** 任务状态（四态）—— 与 VTODO 的 STATVALUE-TODO 一一对应 */
export type TaskState = "todo" | "in-progress" | "done" | "canceled";

/** 思源任务块的 marker（markdown 第一行方括号里的字符） */
export const MARKER_TODO = " ";
export const MARKER_IN_PROGRESS = "/";
export const MARKER_DONE = "X";
export const MARKER_CANCELED = "-";

/** VTODO 的 STATUS 取值 */
export const STATUS_NEEDS_ACTION = "NEEDS-ACTION";
export const STATUS_IN_PROCESS = "IN-PROCESS";
export const STATUS_COMPLETED = "COMPLETED";
export const STATUS_CANCELLED = "CANCELLED";

/** 四态的合法集合（服务端给别的值时按 NEEDS-ACTION 兜底） */
const VALID_STATUS = new Set<string>([
  STATUS_NEEDS_ACTION,
  STATUS_IN_PROCESS,
  STATUS_COMPLETED,
  STATUS_CANCELLED
]);

/**
 * marker → 状态。
 *
 * ⚠️ 大小写不敏感：`X` 与 `x` 都算完成（思源自己的菜单判定也是
 *    `marker?.toUpperCase() === "X"`）。
 * ⚠️ 自定义状态（任意其它单字符）归为「待办」—— 保守，见文件头说明。
 */
export function stateOfMarker(marker: string | undefined | null): TaskState {
  const m = (marker || "").trim();
  if (!m) return "todo";
  const u = m.toUpperCase();
  if (u === MARKER_DONE) return "done";
  if (m === MARKER_IN_PROGRESS) return "in-progress";
  if (m === MARKER_CANCELED) return "canceled";
  return "todo";
}

/** 状态 → marker（写回文档时用） */
export function markerOfState(state: TaskState): string {
  switch (state) {
    case "done":
      return MARKER_DONE;
    case "in-progress":
      return MARKER_IN_PROGRESS;
    case "canceled":
      return MARKER_CANCELED;
    default:
      return MARKER_TODO;
  }
}

/**
 * 服务端 STATUS（+ percent）→ 状态。
 *
 * 兼容旧口径：原来判定「完成」是 `percent === 100 || status === "COMPLETED"`，
 * 这里保持一致（服务端有人只写 `PERCENT-COMPLETE:100` 而没写 STATUS 时也算完成）。
 */
export function stateOfStatus(status: string | undefined | null, percent?: number): TaskState {
  const s = (status || "").toUpperCase();
  if (s === STATUS_COMPLETED) return "done";
  if (s === STATUS_IN_PROCESS) return "in-progress";
  if (s === STATUS_CANCELLED) return "canceled";
  if (percent === 100) return "done";
  return "todo";
}

/**
 * 状态 → 服务端条目字段（STATUS + PERCENT-COMPLETE）。
 *
 * PERCENT-COMPLETE 的取值口径（RFC 5545）：
 *   0 = 未开始，1~99 = 部分完成，100 = 完成。
 *   · 完成  → 100
 *   · 进行中 → 0（插件不猜进度百分比；「进行中」本身已由 STATUS 表达）
 *   · 放弃  → 0（放弃不是部分完成）
 *   · 待办  → 0
 */
export function statusFields(state: TaskState): { status: string; percent: number } {
  switch (state) {
    case "done":
      return { status: STATUS_COMPLETED, percent: 100 };
    case "in-progress":
      return { status: STATUS_IN_PROCESS, percent: 0 };
    case "canceled":
      return { status: STATUS_CANCELLED, percent: 0 };
    default:
      return { status: STATUS_NEEDS_ACTION, percent: 0 };
  }
}

/** 把服务端可能给出的任意 STATUS 归一到四个合法值之一 */
export function normalizeTodoStatus(status: string | undefined | null, percent?: number): string {
  const s = (status || "").toUpperCase();
  if (VALID_STATUS.has(s)) return s;
  return percent === 100 ? STATUS_COMPLETED : STATUS_NEEDS_ACTION;
}

/**
 * markdown → { state, marker }。
 *
 * 只看**第一行**的 `- [X]` 标记（块可能有缩进、也可能有子块），避免误伤正文里的方括号。
 * 与思源 `getTaskListMarker` 的正则保持一致：方括号里是**单个非 `]` 字符**。
 */
export function taskStateOfMarkdown(markdown: string): { state: TaskState; marker: string } {
  const m = /^\s*[-*+]\s+\[([^\]\n])\]/.exec(String(markdown || ""));
  if (!m) return { state: "todo", marker: MARKER_TODO };
  const marker = m[1];
  return { state: stateOfMarker(marker), marker };
}

/**
 * 改 markdown 第一行的 marker（只动方括号里那一个字符，其余原样带回）。
 *
 * @returns 改后的 markdown；返回 null 说明这行不是任务块行（拒绝改写，防止毁数据）
 */
export function withMarkerMarkdown(markdown: string, marker: string): string | null {
  const lines = String(markdown || "").split("\n");
  const first = lines[0] || "";
  const m = /^(\s*[-*+]\s+\[)([^\]\n])(\])/.exec(first);
  if (!m) return null;
  const next = (marker || MARKER_TODO).slice(0, 1);
  lines[0] = `${m[1]}${next}${m[3]}${first.slice(m[0].length)}`;
  return lines.join("\n");
}

/**
 * ⭐ 服务端状态能否覆盖块状态 —— **单向保险的核心**（2026-10-30 用户实测踩中过一次）。
 *
 * 规则（只允许「明确且不撤销完成」的状态推进块）：
 *   · 服务端「完成」    → 总是允许（块可以是待办/进行中/放弃）
 *   · 服务端「进行中」  → 只在块是「待办」时允许（不撤销已完成的块）
 *   · 服务端「放弃」    → 只在块是「待办/进行中」时允许（不撤销已完成的块）
 *   · 服务端「待办」    → **永远不允许**（服务端只是「没标完成」，没有更多信息；
 *                        拿它去覆盖块 = 把用户勾好的待办悄悄取消 —— 正是那次事故）
 *
 * 换句话说：**服务端只能把块往前推，不能把块往回拽。** 取消勾选只能由用户在文档里亲手做。
 * 「完成」之所以例外，是因为它不丢信息、且是终态（这也是原口径「完成优先」的由来）。
 */
export function mergeServerState(current: TaskState, server: TaskState): TaskState {
  if (server === "done") return "done";
  if (server === "in-progress") return current === "todo" ? "in-progress" : current;
  if (server === "canceled") {
    return current === "todo" || current === "in-progress" ? "canceled" : current;
  }
  return current;
}

/**
 * 块状态是否允许被目标状态覆盖（结构性保险的判定口）。
 *
 * ⚠️ 这条是**函数级**的保险：回写块之前必须过这一关，哪怕将来上面的判定逻辑
 *    被改错，最坏也只是「该推进的没推进」，绝不会出现「用户勾好的待办被悄悄改掉」。
 */
export function canWriteState(current: TaskState, target: TaskState): boolean {
  return mergeServerState(current, target) === target;
}
