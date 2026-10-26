/**
 * 筛选记忆：记住两处筛选下拉上次用的是哪一项，下次打开时恢复。
 *
 * 2026-10-26 雄哥要求：Dock / 任务视图的筛选默认值「不希望固定不可更改」，
 * 设置里新增「上次使用项」（默认）+ 各自下拉的全部取值。
 *
 * ## 2026-10-27：存储从 localStorage 改到配置（`CalSettings`）
 *
 * 原先按「本机 UI 偏好、不该跨设备同步」的理由存了 localStorage，结果**永远记不住**
 * —— 思源每次启动的**内核端口是随机的**（实测 9905 / 11038 / 4008 / 8351 …），
 * 而 localStorage 按 origin —— **含端口** —— 隔离：记录写进去了（Electron 的
 * leveldb 里能看到一串不同端口下的记录），但下次启动是另一个 origin，一条也读不回来。
 * IndexedDB / cookie 同样按 origin 隔离，一起失效，浏览器存储在思源里这条路是死的。
 *
 * 故按雄哥 2026-10-27 的要求改存配置：`settings.lastDockFilter` / `settings.lastTaskFilter`，
 * 跟着 data.json 同步到其他设备。代价是多端互相覆盖，但只影响「上次哪个筛选」。
 *
 * ## 「上次使用项」不存在时的回落
 *
 * 雄哥 2026-10-26：原来 Dock 初始值是「未来七天」，一并改成「所有未完成」。
 * 即 `DEFAULT_DOCK_FILTER = "undone"`、`DEFAULT_TASK_FILTER = "allincomplete"`。
 *
 * ## 容错
 *
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

/** 读出来的值必须落在合法集合内，否则视为无记录（脏数据不该把面板卡死） */
function valid<T extends string>(raw: string | undefined, set: readonly string[]): T | null {
  if (!raw) return null;
  return set.includes(raw) ? (raw as T) : null;
}

export function loadLastDockFilter(s: CalSettings): DockFilterKey | null {
  return valid<DockFilterKey>(s.lastDockFilter, VALID_DOCK);
}

/**
 * 记下本次选的（写进配置 `settings.lastDockFilter`）。
 *
 * ⚠️ 只改内存里的 settings，**调用方负责随后 `store.markSettingsDirty()` 落盘** ——
 * 切筛选是高频操作，由调用方决定何时写，这里不越权触发持久化。
 */
export function saveLastDockFilter(s: CalSettings, k: DockFilterKey): void {
  s.lastDockFilter = k;
}

export function loadLastTaskFilter(s: CalSettings): TaskFilterKey | null {
  return valid<TaskFilterKey>(s.lastTaskFilter, VALID_TASK);
}

export function saveLastTaskFilter(s: CalSettings, k: TaskFilterKey): void {
  s.lastTaskFilter = k;
}

/**
 * 解析「Dock 默认筛选」设置 → 实际该用的初始筛选。
 * - `"last"`（或没设过）→ 上次使用项；无记录则回落「所有未完成」
 * - 具体筛选键 → 固定用它
 */
export function resolveDockFilter(s: CalSettings): DockFilterKey {
  const v = s.defaultDockFilter;
  if (!v || v === "last") return loadLastDockFilter(s) ?? DEFAULT_DOCK_FILTER;
  return VALID_DOCK.includes(v) ? v : DEFAULT_DOCK_FILTER;
}

/** 解析「任务视图默认筛选」设置 → 实际该用的初始筛选（同上） */
export function resolveTaskFilter(s: CalSettings): TaskFilterKey {
  const v = s.defaultTaskFilter;
  if (!v || v === "last") return loadLastTaskFilter(s) ?? DEFAULT_TASK_FILTER;
  return VALID_TASK.includes(v) ? v : DEFAULT_TASK_FILTER;
}
