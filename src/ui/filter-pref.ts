/**
 * 筛选记忆：记住两处筛选下拉上次用的是哪一项，下次打开时恢复。
 *
 * 2026-10-26 雄哥要求：Dock / 任务视图的筛选默认值「不希望固定不可更改」，
 * 设置里新增「上次使用项」（默认）+ 各自下拉的全部取值。
 *
 * ## 为什么存 localStorage 而不进设置
 *
 * 与 `view-pref.ts`（记住上次视图）同一套理由：这是**本机 UI 偏好**，不是业务数据 ——
 *   - 桌面端可能想看「本周任务」、手机端只想看「今日」，没必要跨设备同步
 *   - 不该混进 `CalSettings`（那是给用户看的配置，混进内部状态会污染设置页）
 *   - 切筛选是高频操作，走 data.json 意味着每次都落盘
 *
 * ## 「上次使用项」不存在时的回落
 *
 * 雄哥 2026-10-26：原来 Dock 初始值是「未来七天」，一并改成「所有未完成」。
 * 即 `DEFAULT_DOCK_FILTER = "undone"`、`DEFAULT_TASK_FILTER = "allincomplete"`。
 *
 * ## 容错
 *
 * localStorage 可能因隐私模式 / 配额而抛异常，**读写全部包 try**；
 * 读到的值必须落在合法集合内，否则视为无记录 —— 不让脏数据把面板卡死。
 */
import type { CalSettings, DockFilterKey, TaskFilterKey } from "../core/types";

/**
 * 两个下拉的**选项表**（顺序即下拉中的顺序）。
 *
 * ⚠️ 这是全仓唯一来源：Dock 下拉（ui/panel.ts）、任务视图下拉（ui/view-task.ts）
 * 与设置页这两个「默认筛选」下拉**全部引用它** —— 三处各写一份的话，
 * 哪天往下拉里加一项，设置页就会静默少一个选项（这种漂移最不容易被发现）。
 */
export const DOCK_FILTER_OPTIONS: Array<{ key: DockFilterKey; label: string }> = [
  { key: "next7", label: "未来七天" },
  { key: "today", label: "今日任务" },
  { key: "tomorrow", label: "明日任务" },
  { key: "thisweek", label: "本周任务" },
  { key: "future", label: "未来任务" },
  { key: "overdue", label: "过期任务" },
  { key: "past7", label: "过去七天" },
  { key: "undone", label: "所有未完成" },
  { key: "nodate", label: "无日期任务" },
  { key: "doneToday", label: "今日已完成" },
  { key: "doneYesterday", label: "昨日已完成" },
  { key: "done", label: "已完成" }
];

export const TASK_FILTER_OPTIONS: Array<{ key: TaskFilterKey; label: string }> = [
  { key: "allitems", label: "所有项目" },
  { key: "today", label: "今日" },
  { key: "tomorrow", label: "明日" },
  { key: "next7", label: "未来七天" },
  { key: "thisweek", label: "本周" },
  { key: "future", label: "未来" },
  { key: "overdue", label: "过期" },
  { key: "past7", label: "过去七天" },
  { key: "allincomplete", label: "所有未完成" },
  { key: "nodate", label: "无日期" },
  { key: "todaydone", label: "今日已完成" },
  { key: "yesterdaydone", label: "昨日已完成" },
  { key: "doneall", label: "已完成" }
];

/** key → 文案（给「每项自带 match 函数」的任务视图 filters 用） */
export const DOCK_FILTER_LABEL: Record<DockFilterKey, string> = Object.fromEntries(
  DOCK_FILTER_OPTIONS.map((o) => [o.key, o.label])
) as Record<DockFilterKey, string>;

export const TASK_FILTER_LABEL: Record<TaskFilterKey, string> = Object.fromEntries(
  TASK_FILTER_OPTIONS.map((o) => [o.key, o.label])
) as Record<TaskFilterKey, string>;

/** 上次使用的 Dock 筛选 */
const KEY_DOCK = "caldav-dock-filter";
/** 上次使用的任务视图筛选 */
const KEY_TASK = "caldav-task-filter";

/** 全部合法 Dock 筛选键（与 ui/panel.ts DOCK_FILTERS 一一对应） */
export const VALID_DOCK: readonly DockFilterKey[] = [
  "today", "tomorrow", "next7", "thisweek", "future",
  "overdue", "past7", "undone", "nodate",
  "doneToday", "doneYesterday", "done"
];

/** 全部合法任务视图筛选键（与 ui/view-task.ts filters 一一对应） */
export const VALID_TASK: readonly TaskFilterKey[] = [
  "allitems", "today", "tomorrow", "next7", "thisweek", "future",
  "overdue", "past7", "allincomplete", "nodate",
  "todaydone", "yesterdaydone", "doneall"
];

/** 无记录时 Dock 的初始筛选（雄哥要求：由「未来七天」改为「所有未完成」） */
export const DEFAULT_DOCK_FILTER: DockFilterKey = "undone";
/** 无记录时任务视图的初始筛选（与原本一致） */
export const DEFAULT_TASK_FILTER: TaskFilterKey = "allincomplete";

function read(key: string, valid: readonly string[]): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    return valid.includes(raw) ? raw : null; // 脏数据视为无记录
  } catch {
    // 隐私模式 / 配额受限：读不到就走默认值，不打扰用户
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 忽略：记不住只是下次回到默认筛选，不影响使用 */
  }
}

export function loadLastDockFilter(): DockFilterKey | null {
  return read(KEY_DOCK, VALID_DOCK) as DockFilterKey | null;
}

export function saveLastDockFilter(k: DockFilterKey): void {
  write(KEY_DOCK, k);
}

export function loadLastTaskFilter(): TaskFilterKey | null {
  return read(KEY_TASK, VALID_TASK) as TaskFilterKey | null;
}

export function saveLastTaskFilter(k: TaskFilterKey): void {
  write(KEY_TASK, k);
}

/**
 * 解析「Dock 默认筛选」设置 → 实际该用的初始筛选。
 * - `"last"`（或没设过）→ 上次使用项；无记录则回落「所有未完成」
 * - 具体筛选键 → 固定用它
 */
export function resolveDockFilter(s: CalSettings): DockFilterKey {
  const v = s.defaultDockFilter;
  if (!v || v === "last") return loadLastDockFilter() ?? DEFAULT_DOCK_FILTER;
  return VALID_DOCK.includes(v) ? v : DEFAULT_DOCK_FILTER;
}

/** 解析「任务视图默认筛选」设置 → 实际该用的初始筛选（同上） */
export function resolveTaskFilter(s: CalSettings): TaskFilterKey {
  const v = s.defaultTaskFilter;
  if (!v || v === "last") return loadLastTaskFilter() ?? DEFAULT_TASK_FILTER;
  return VALID_TASK.includes(v) ? v : DEFAULT_TASK_FILTER;
}
