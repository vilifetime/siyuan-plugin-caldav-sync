/**
 * 视图记忆：记住上次用的是哪个视图，下次打开时恢复。
 *
 * 2026-10-07 雄哥要求：「记住当前的视图（日历视图/任务视图），下次初次打开时
 * 默认使用上次视图。」
 *
 * ## 为什么存 localStorage 而不进设置
 *
 * 视图选择是**本机 UI 偏好**，不是业务数据：
 *   - 桌面端可能是宽屏看周视图、手机端只想看任务列表，没必要跨设备同步
 *   - 不该混进 `CalSettings`（那是给用户看的配置，混进内部状态会污染设置页）
 *   - 切换视图是高频操作，走 data.json 意味着每次都落盘
 *
 * ## 两个键的分工（2026-10-20）
 *
 * - `caldav-view-mode`：当前视图（含 task）—— 供初始化时恢复
 * - `caldav-calendar-view`：上次的**日历**视图（年/月/周/日，不含 task）——
 *   供「从任务视图切回日历视图」时用
 *
 * 分开的原因：如果只有一个键，进入 task 时的那次写入会把日历视图记录覆盖成
 * "task"，切回来读到的还是 task，死循环。从任务视图返回时应该回到进任务视图
 * **之前**的那个日历视图（雄哥 2026-10-20 要求，原实现是硬编码落回月视图）。
 *
 * ## 容错
 *
 * localStorage 可能因隐私模式/配额而抛异常，**读写全部包 try**。
 * 读到的值必须落在合法集合内，否则回落默认 —— 不让脏数据把面板卡死。
 */
// type-only import：编译后消失，不与 panel.ts 形成运行期循环依赖
// （思源侧 PanelCtx/ViewMode 仍定义在 panel.ts，未像 Obsidian 侧抽出 panel-ctx）
import type { ViewMode } from "./panel";

// ⚠️ KEY 沿用本插件早期版本就在用的旧值（原在 index.ts 内联）——
// 换 key 会让所有老用户丢一次视图记录，没必要。新键才是本次新增的。
const KEY = "siyuan-plugin-caldav-sync:last-view";

/**
 * 「上次使用的日历视图」专用键（只记年/月/周/日，**不记 task**）。
 */
const KEY_CALENDAR = "caldav-calendar-view";

/** 全部合法视图。读回的值不在其中 → 视为无记录。 */
const VALID: readonly ViewMode[] = ["year", "month", "week", "day", "task"] as const;

/** 只记日历视图（年/月/周/日）。 */
const VALID_CALENDAR: readonly ViewMode[] = ["year", "month", "week", "day"] as const;

/** 无记录时的初值：日历月视图（与面板原本的默认一致） */
export const DEFAULT_VIEW: ViewMode = "month";

/**
 * 读取上次使用的视图。
 * @returns 记录存在且合法则返回它，否则 `null`（表示「没有记录」）。
 */
export function loadViewMode(): ViewMode | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    return VALID.includes(raw as ViewMode) ? (raw as ViewMode) : null;
  } catch {
    // 隐私模式/配额受限：读不到就用默认值，不打扰用户
    return null;
  }
}

/** 记下当前视图。失败静默 —— 记不住只是下次回到默认视图，不影响使用。 */
export function saveViewMode(mode: ViewMode): void {
  try {
    globalThis.localStorage?.setItem(KEY, mode);
  } catch {
    /* 忽略 */
  }
}

/**
 * 记下「上次使用的日历视图」。仅在 `mode` 是日历视图（年/月/周/日）时有意义，
 * task 不该覆盖它 —— 调用方负责过滤，这里也兜一层。
 */
export function saveCalendarView(mode: ViewMode): void {
  if (!VALID_CALENDAR.includes(mode)) return;
  try {
    globalThis.localStorage?.setItem(KEY_CALENDAR, mode);
  } catch {
    /* 忽略 */
  }
}

/**
 * 读上次使用的日历视图（从任务视图返回时用）。
 * @returns 记录存在且合法则返回它，否则 `null`（调用方回落默认月视图）。
 */
export function loadCalendarView(): ViewMode | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY_CALENDAR);
    if (!raw) return null;
    return VALID_CALENDAR.includes(raw as ViewMode) ? (raw as ViewMode) : null;
  } catch {
    return null;
  }
}

/**
 * 首次打开时该用的视图：有记录用记录的，没记录用 `DEFAULT_VIEW`。
 * 供面板初始化 mainCtx.viewMode 时调用。
 */
export function initialViewMode(): ViewMode {
  return loadViewMode() ?? DEFAULT_VIEW;
}
