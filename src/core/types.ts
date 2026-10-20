/** 条目种类 */
export type CalKind = "event" | "todo";

/** 排序方式（Dock 排序菜单 + 月/周视图条目排序共用） */
export type SortMode = "start" | "end" | "priority" | "completed" | "created" | "category" | "title";

/** 本地墙上时间：时间型 "YYYY-MM-DDTHH:mm:ss"，全天 "YYYY-MM-DD" */
export type LocalStamp = string;

export interface Recurrence {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byDay?: string[]; // ["MO", "TU", ...]（WEEKLY/MONTHLY 生效）
  byMonthDay?: number[]; // MONTHLY 生效
  count?: number;
  until?: LocalStamp;
}

export interface Alarm {
  minutesBefore: number; // 提前分钟数
}

/** 本地缓存的一条日历条目（事件或待办） */
/**
 * 附件（iCalendar ATTACH，2026-10-14）。
 *
 * ⚠️ 省力版**只认 URI 形式**（`ATTACH:https://…/a.pdf`），即「文件放在别处、这里存个链接」。
 * 二进制内嵌形式（`VALUE=BINARY;ENCODING=BASE64`）**不解析也不展示** ——
 * 但它仍然被 `raw` 原文带着、`rebuildComponent` 会原样保留，**不会因为编辑而丢失**。
 * 想丢的话得显式改 ATTACH 白名单，目前没有这样的操作。
 */
export interface CalAttachment {
  /**
   * URI 形式（外链）。与 `b64` **二选一**，两者都空 = 无效条目（保存时忽略）。
   */
  uri?: string;
  /**
   * 二进制内联形式：base64 载荷（**未折行**，折行由序列化时统一做）。
   * 对应 RFC 5545 的 `ATTACH;VALUE=BINARY;ENCODING=BASE64:…`。
   *
   * 为什么走这条路：用户的 Radicale 把每个 PUT 进日历集合的文件都当 iCalendar 解析，
   * 传 .txt/.pdf 一律 400（实测，服务端日志 `Failed to parse line`）。所以附件不能
   * 单独放一个文件，只能内联进条目本身、跟着 ICS 一起同步。
   */
  b64?: string;
  /** 文件名：URI 形式取末段，二进制件用上传时的文件名 */
  name: string;
  /** MIME 类型（FMTTYPE / FBTYPE 参数），可能为空 */
  fmttype?: string;
}

export interface CalItem {
  uid: string;
  kind: CalKind;
  calendarUrl: string;
  /** 服务器资源地址（.ics），PUT/DELETE 用 */
  href: string;
  etag?: string;
  summary: string;
  description?: string;
  location?: string;
  categories?: string[];
  allDay: boolean;
  /** 开始（本地墙上时间） */
  start: LocalStamp;
  /** 结束（本地墙上时间；待办为 due，可为空） */
  end?: LocalStamp;
  /** RRULE 描述；不存在则无重复 */
  rrule?: Recurrence;
  /** RECURRENCE-ID：覆盖实例的基准开始时间 */
  recurId?: LocalStamp;
  exdates?: LocalStamp[];
  alarms?: Alarm[];
  /**
   * 附件：URI 形式（外链）与二进制内联形式（`b64`，见 CalAttachment）并存。
   *
   * ⚠️ 这个字段**就是权威来源** —— 解析时把所有 ATTACH 都收进来，编辑时按它重写。
   * 唯一的例外：字段为 `undefined` 时（老数据，解析发生在本次改动之前），
   * `rebuildComponent` 仍会把原文里的二进制件原样带回，避免升级后第一次编辑就丢附件。
   */
  attachments?: CalAttachment[];
  /** 待办：0 无 9 低 5 中 3 高 1 紧急 */
  priority?: number;
  /** 待办状态：needs-action / in-process / completed */
  status?: string;
  /** 待办完成度 0-100 */
  percent?: number;
  completedAt?: LocalStamp;
  /** 创建时间（本地墙上时间；解析 ICS CREATED 或本地新建时写入） */
  createdAt?: LocalStamp;
  /** 本地脏标记：待上传 */
  dirty?: boolean;
  /** 本地删除标记：同步时执行服务端删除 */
  deleted?: boolean;
  /**
   * 该条目的 **ICS 资源原文**（服务端返回的整份 calendar-data）。
   *
   * 这是「编辑不丢数据」的唯一凭据：`itemToEditedICS()` 重新解析它、只重建 UID
   * （+RECURRENCE-ID）匹配的那个组件，其余内容原样带回 —— VTIMEZONE、同资源内的
   * 其它组件、ATTACH 二进制件、ORGANIZER、ATTENDEE、X- 扩展属性全靠它活着。
   *
   * ⚠️ 缺失即退化：`itemToEditedICS` 会退成 `itemToNewICS` 从 CalItem 整份重拼，
   * 上面那些**全部丢失**。所以拉取时必须赋值（`itemsFromICS` 负责），
   * 新建条目在上传成功后也要立刻补上（`sync.ts` pushDirty）。
   */
  raw?: string;
  /** 编辑器会话态：粘贴标题时自动识别其中的日期时间（仅编辑器内使用，不持久化到 ICS） */
  aiParse?: boolean;
}

export interface CalCalendar {
  url: string;
  displayName: string;
  /**
   * @deprecated 旧的「整个日历一个默认颜色」。现在拆成 eventColor / todoColor，
   * 这里只作为迁移来源与向下兼容的镜像值（写数据时恒等于 eventColor），
   * 界面不再单独设置它。读取请一律走 calEventColor() / calTodoColor()。
   */
  color?: string;
  /** 该日历「日程」的默认颜色（HEX）；空则回退 color / 中性灰 */
  eventColor?: string;
  /** 该日历「待办」的默认颜色（HEX）；空则回退 eventColor / color / 中性灰 */
  todoColor?: string;
  enabled: boolean;
  /** 支持 VTODO */
  supportsTodo?: boolean;
  /** 支持 VEVENT */
  supportsEvent?: boolean;
  /** sync-collection 支持的 sync-token，空则回退全量 */
  syncToken?: string;
  /** 描述（如 Nextcloud 共享说明） */
  description?: string;
}

/** 找不到日历 / 日历没设颜色时的中性兜底色 */
export const NEUTRAL_ITEM_COLOR = "#64748b";

/** 日历的「日程默认色」——顺带承担日历自身的身份色（点、徽标等） */
export function calEventColor(cal?: CalCalendar | null): string {
  return cal?.eventColor || cal?.color || NEUTRAL_ITEM_COLOR;
}

/** 日历的「待办默认色」；没单独设过就跟着日程色走（迁移期观感不变） */
export function calTodoColor(cal?: CalCalendar | null): string {
  return cal?.todoColor || cal?.eventColor || cal?.color || NEUTRAL_ITEM_COLOR;
}

/**
 * 老数据迁移：过去的 `color`（一个日历一个色）升级为 eventColor + todoColor。
 * 两者都取原色 —— 存量条目颜色因此**完全不变**，用户想区分再去设置里改待办色。
 * 同时把 color 镜像成 eventColor，万一有旧版本端读同一份数据，不至于整片变灰。
 * 幂等，可重复调用。
 */
export function normalizeCalendarColors(cals: CalCalendar[] | undefined | null): void {
  if (!cals) return;
  for (const c of cals) {
    if (!c) continue;
    const base = c.eventColor || c.color || NEUTRAL_ITEM_COLOR;
    c.eventColor = base;
    c.todoColor = c.todoColor || base;
    c.color = c.eventColor;
  }
}

/** 任务分类定义（编辑弹窗的彩色药丸） */
export interface CategoryDef {
  id: string;
  name: string;
  /** 药丸底色（HEX） */
  color: string;
  /** 图标（emoji 或单字符） */
  icon: string;
}

export const DEFAULT_CATEGORIES: CategoryDef[] = [
  { id: "work", name: "工作", color: "#e05a4c", icon: "🎯" },
  { id: "study", name: "学习", color: "#3d82d6", icon: "📖" },
  { id: "life", name: "生活", color: "#43a05c", icon: "🍀" }
];

export interface CalSettings {
  serverUrl: string;
  username: string;
  password: string;
  /** 可选，直接指定日历集合或主目录；空则自动发现 */
  calendarPath: string;
  /** auto：内核代理优先、失败回退直连 */
  channel: "auto" | "proxy" | "direct";
  /** 自动同步间隔（分钟），0 关闭 */
  syncIntervalMin: number;
  /** 启用提醒通知（托盘运行时，对设置了提醒时间的日程/待办到点弹系统通知） */
  enableReminders?: boolean;
  /** 服务端冲突时：server 服务端优先 / local 本地优先 */
  conflict: "server" | "local";
  /** 显示范围：过去 N 天 / 未来 N 天 */
  pastDays: number;
  futureDays: number;
  calendars: CalCalendar[];
  defaultCalendarUrl?: string;
  /**
   * 日历视图（年/月/周/日）是否显示待办任务，默认 true。
   * 关掉后日历视图只显示日程事件 —— 待办仍可在「任务视图」与 Dock 列表中看到与勾选，
   * 所以这是一个纯展示开关，不影响数据与同步。
   */
  showTodosInCalendar?: boolean;
  /**
   * 任务视图是否把日程事件（VEVENT）也列进来，默认 false（只列待办）。
   * 打开后才会出现第二层开关 showExpiredEventsInTaskView。
   */
  showEventsInTaskView?: boolean;
  /**
   * 任务视图是否显示**已过期**的日程，默认 false。
   * 日程没有「完成」语义，过期的一律归入「已完成」组；默认藏起来是为了
   * 不让一堆开完的会抢走待办的注意力。
   *
   * ⚠️ 主开关 showEventsInTaskView 关闭时必须连带置 false —— 否则留着 true，
   * 下次打开主开关会突然冒出一批过期日程，看着像出 bug。
   */
  showExpiredEventsInTaskView?: boolean;
  /** 任务分类（编辑弹窗药丸选择），空数组时回退 DEFAULT_CATEGORIES */
  categories?: CategoryDef[];
  /** 分类是否允许多选 */
  categoryMulti?: boolean;
  /**
   * 插入日记时是否把逾期待办也写入，并排在日记最前面。
   *
   * 逾期 = 待办的到期日（DUE）早于今天零点、且未完成（percent !== 100）。
   * 默认 false —— 维持旧行为：只写落在当日 / 本周 / 本月范围内的条目。
   * 开启后，范围之外的逾期待办（「所有」范围里本来就含的不会重复计入）
   * 会在「日程与待办」小节最前面追加一个 `### 逾期待办` 子节。
   */
  includeOverdueTodos?: boolean;
  /**
   * 单个内联附件的硬上限（MB），超过在挑选时直接拒绝、不给确认机会。默认 5。
   *
   * 附件以 base64 内联进 ICS 同步，体积会涨约 1/3；服务端普遍限制单条日历数据
   * 大小（Radicale 默认 10MB、PHP 默认 post_max_size 8MB），超了必然 413。
   */
  attachSizeMaxMB?: number;
  /**
   * 整份 ICS（含全部 base64 附件）的硬上限（MB），超过拒绝保存/上传。默认 10。
   *
   * 单文件上限挡不住「多个 4MB 凑 12MB」，所以按真实序列化结果卡总账。
   * 自己的服务器上限更大就把这里调大（报错文案里的数字也取此值）。
   */
  icsSizeMaxMB?: number;
}

/**
 * 「任务视图中显示日程事件」两级开关的**唯一**联动规则：主开关关闭时，
 * 第二层 `showExpiredEventsInTaskView` 恒为 false —— 否则留着 true，
 * 下次打开主开关会突然冒出一批过期日程，看着像出 bug
 * （理由详见 CalSettings 上的注释）。主开关打开时第二层才取 `expiredOn`。
 *
 * 这一对开关的**唯一入口**是日历筛选浮层（ui/panel.ts）—— 设置弹窗里不再放，
 * 避免两处都能改、改完互相打架（2026-10-08 雄哥拍板）。即便哪天要加第二个入口，
 * 也必须走本函数，分开写迟早漂移成两种口径。
 */
export function setTaskViewEventsShown(s: CalSettings, eventsOn: boolean, expiredOn = false): void {
  s.showEventsInTaskView = eventsOn;
  s.showExpiredEventsInTaskView = eventsOn && expiredOn === true;
}

export const DEFAULT_SETTINGS: CalSettings = {
  serverUrl: "",
  username: "",
  password: "",
  calendarPath: "",
  channel: "auto",
  syncIntervalMin: 15,
  enableReminders: false,
  conflict: "server",
  pastDays: 90,
  futureDays: 370,
  calendars: [],
  showTodosInCalendar: true,
  showEventsInTaskView: false,
  showExpiredEventsInTaskView: false,
  categories: DEFAULT_CATEGORIES,
  categoryMulti: false,
  includeOverdueTodos: false,
  attachSizeMaxMB: 5,
  icsSizeMaxMB: 10
};

export interface SyncState {
  lastSync?: string;
  lastError?: string;
  /**
   * 上次同步的**中性提示**（如「对账清理了 N 条幽灵条目」）。
   *
   * 为什么不能塞进 `lastError`：对账是正常自愈，不是失败。塞进去会让状态栏
   * 显示「同步失败」、面板挂红色报错横幅，把一次成功同步报成失败
   * （2026-10-10 实测）。两者必须分通道。
   */
  lastNote?: string;
  /**
   * 自上次全量同步以来，**即时推送**（新建/编辑/删除单条）成功上传的**条目 key**。
   *
   * 为什么要有这个：单条编辑走 `pushAndPersist()` 立刻上云，它的计数原先被整个
   * 丢弃。用户随后点全量同步时会看到「上传 0 · 删除 0」，以为改动没同步
   * （2026-10-10 实测）。故这里先攒着，等下一轮 syncAll 合并进报告再清零。
   *
   * 为什么按 key 存而不是按条数（2026-10-19 雄哥实测：同一事件打勾/编辑几次，
   * 同步就报「上传 N 条」——虚胖）：旧实现按推送轮次累加，同一条目被操作 N 次
   * 就计 N。改成按 key 去重，同一条目只算一条。
   */
  pendingUploadedKeys?: string[];
  /** 同上，即时推送成功删除的条目 key */
  pendingDeletedKeys?: string[];
}

export interface PersistData {
  settings: CalSettings;
  items: CalItem[];
  sync: SyncState;
  /**
   * 凭据加密的主密钥（base64）。**故意与密文放在同一份数据里**：
   * 这份数据会被思源云同步带到别的设备，密钥同行才能保证「换设备/多端」都解得开。
   * 详见 core/secret.ts 里对 v2（设备绑定密钥）被淘汰的原因说明。
   */
  keyring?: string;
}

export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}
