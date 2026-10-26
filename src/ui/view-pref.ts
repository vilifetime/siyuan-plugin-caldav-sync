/**
 * 视图记忆：记住上次用的是哪个视图，下次打开时恢复。
 *
 * 2026-10-07 雄哥要求：「记住当前的视图（日历视图/任务视图），下次初次打开时
 * 默认使用上次视图。」
 *
 * ## 2026-10-27：存储从 localStorage 改到配置（`CalSettings`）
 *
 * 原先按「视图选择是本机 UI 偏好，不该跨设备同步」的理由存了 localStorage，
 * 结果**从来没生效过** —— 思源每次启动的内核端口是**随机**的（实测
 * 9905 / 11038 / 4008 / 8351 …），而 localStorage 按 origin —— **含端口** ——
 * 隔离：记录写进去了（Electron 的 leveldb 里能看到一串不同端口下的记录），
 * 但下次启动是另一个 origin，一条也读不回来。IndexedDB / cookie 同样按 origin
 * 隔离，一起失效，所以浏览器存储在思源里这条路是死的。
 *
 * 故按雄哥 2026-10-27 的要求改存配置：`settings.lastView` / `settings.lastCalendarView`，
 * 跟着 data.json 一起同步到其他设备。代价是多端互相覆盖，但只影响「上次哪个视图」。
 *
 * ## 两个字段的分工（2026-10-20）
 *
 * - `lastView`：当前视图（含 task）—— 供初始化时恢复
 * - `lastCalendarView`：上次的**日历**视图（年/月/周/日，不含 task）——
 *   供「从任务视图切回日历视图」时用
 *
 * 分开的原因：如果只有一个字段，进入 task 时的那次写入会把日历视图记录覆盖成
 * "task"，切回来读到的还是 task，死循环。从任务视图返回时应该回到进任务视图
 * **之前**的那个日历视图（雄哥 2026-10-20 要求，原实现是硬编码落回月视图）。
 *
 * ## 容错
 *
 * 读到的值必须落在合法集合内，否则回落默认 —— 不让脏数据把面板卡死。
 */
// type-only import：编译后消失，不与 panel.ts 形成运行期循环依赖
// （思源侧 PanelCtx/ViewMode 仍定义在 panel.ts，未像 Obsidian 侧抽出 panel-ctx）
import type { ViewMode } from "./panel";
import type { CalSettings } from "../core/types";

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
export function loadViewMode(s: CalSettings): ViewMode | null {
  const raw = s.lastView;
  if (!raw) return null;
  return VALID.includes(raw as ViewMode) ? (raw as ViewMode) : null;
}

/**
 * 记下当前视图（写进配置 `settings.lastView`）。
 *
 * ⚠️ 只改内存里的 settings，**调用方负责随后 `store.markSettingsDirty()` 落盘** ——
 * 切视图是高频操作，由调用方决定何时写，这里不越权触发持久化。
 */
export function saveViewMode(s: CalSettings, mode: ViewMode): void {
  s.lastView = mode;
}

/**
 * 记下「上次使用的日历视图」。仅在 `mode` 是日历视图（年/月/周/日）时有意义，
 * task 不该覆盖它 —— 调用方负责过滤，这里也兜一层。
 */
export function saveCalendarView(s: CalSettings, mode: ViewMode): void {
  if (!VALID_CALENDAR.includes(mode)) return;
  s.lastCalendarView = mode;
}

/**
 * 读上次使用的日历视图（从任务视图返回时用）。
 * @returns 记录存在且合法则返回它，否则 `null`（调用方回落默认月视图）。
 */
export function loadCalendarView(s: CalSettings): ViewMode | null {
  const raw = s.lastCalendarView;
  if (!raw) return null;
  return VALID_CALENDAR.includes(raw as ViewMode) ? (raw as ViewMode) : null;
}

/**
 * 首次打开时该用的视图：有记录用记录的，没记录用 `DEFAULT_VIEW`。
 * 供面板初始化 mainCtx.viewMode 时调用。
 */
export function initialViewMode(s: CalSettings): ViewMode {
  return loadViewMode(s) ?? DEFAULT_VIEW;
}
