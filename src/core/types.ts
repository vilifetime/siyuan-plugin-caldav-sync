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
  /**
   * iCloud 托管附件（RFC 8607 managed attachments）的 MANAGED-ID。
   * 上传成功后由同步层回填：文件已存进 iCloud 专用存储，本地只留托管 URI +
   * 这个 ID，不再内联 base64 —— iCloud 对内联二进制附件回 507（实测），
   * 托管形态是苹果官方支持的路径（iPhone/iPad 的提醒事项同样走它）。
   * 序列化时写 `ATTACH;MANAGED-ID="<id>":<uri>`，与 uri 并存。
   */
  managedId?: string;
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
  /**
   * 「换日历搬家」的来源资源：上传成功后要把它从原日历里删掉，否则服务端留孤儿。
   *
   * 触发场景：① 编辑器里直接换日历；② 日程↔待办互转时，原日历不支持目标类型
   * （iCloud 的日历只收 VEVENT、提醒事项只收 VTODO）必须搬到支持它的日历。
   *
   * ⚠️ 顺序铁律：**先 PUT 新资源，成功后再删旧的**。先删后建一旦新建被拒（403/400），
   * 服务端那一条就彻底没了（2026-10-24 雄哥实测）。删除失败只记提示、不阻断上传。
   */
  movedFrom?: {
    /** 原日历里的资源地址 */
    href: string;
    /** 原日历集合地址（DELETE 要用原集合的权限与路径） */
    calendarUrl?: string;
    /** 原 etag（带 If-Match 删，避免误删他人改动） */
    etag?: string;
  };
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
  /**
   * 是否已真正向服务端问过 `supported-calendar-component-set`（RFC 4791 §5.2.3）。
   *
   * ⚠️ 为什么需要这个标记：`supportsEvent/supportsTodo` 缺省就是 `true`，光看字段
   * 分不清「服务端确实支持」和「压根没问过、取了默认值」。2026-10-24 之前发现日历
   * 的 PROPFIND **根本没请求**这个属性，于是 iCloud 的「提醒事项」集合也被标成
   * 「既支持日程又支持待办」，往里 PUT VEVENT 被 403（雄哥实测），且当时的降级
   * 策略先删了服务端旧资源才重建，把待办直接删没了。缺此标记的老配置要在同步前补探测。
   */
  componentSetProbed?: boolean;
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

/**
 * 一个日历账户（2026-10-25 多账户重构）。
 *
 * 每个账户 = 一台服务器 + 它的凭据 + 它自己的日历集合。账户之间完全独立：
 * 各自的启用开关、各自的「服务器 / 日历 / 同步」三段设置。
 *
 * 迁移来源：重构前的这些字段都平铺在 CalSettings 上（单账户），
 * `migrateToAccounts()` 负责把老数据原样搬进 accounts[0]，零丢失。
 */
export interface CalAccount {
  /**
   * 账户 ID。迁移/新建时生成，**之后不再变** ——
   * 条目不存账户 ID（靠 calendarUrl 反查），但 UI 的手风琴展开态、
   * 未来可能的账户级缓存都以它为键，变过一次就会全部对不上。
   */
  id: string;
  /** 账户名（用户可改，如「公司 iCloud」「家里 NAS」）。迁移时按类型自动命名 */
  name: string;
  /** 账户级启用开关：停用后该账户的日历不显示、不参与同步、不参与定时任务 */
  enabled: boolean;
  serverUrl: string;
  username: string;
  password: string;
  /** 可选，直接指定日历集合或主目录；空则自动发现 */
  calendarPath: string;
  /**
   * 服务器类型：标准 CalDAV 服务器 / 苹果 iCloud。
   * 选 iCloud 时设置页会把服务器地址自动填成 https://caldav.icloud.com（用户留空时），
   * 留空日历路径即可走完整发现链自动找到 iCloud 日历（iCloud 的 XML 带 xmlns 属性，
   * 解析正则已对齐）。老数据缺此字段时按 caldav 处理，不影响既有连接。
   */
  serverType?: "icloud" | "caldav";
  /** auto：内核代理优先、失败回退直连 */
  channel: "auto" | "proxy" | "direct";
  /** 服务端冲突时：server 服务端优先 / local 本地优先 */
  conflict: "server" | "local";
  /** 显示范围：过去 N 天 / 未来 N 天 */
  pastDays: number;
  futureDays: number;
  /** 该账户发现的日历集合 */
  calendars: CalCalendar[];
}

/** 生成一个新账户 ID（迁移与「添加账户」共用） */
export function newAccountId(): string {
  return `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 老数据迁移：单账户 settings → accounts 数组。**幂等，可重复调用。**
 *
 * 老数据里 serverUrl/凭据/日历都平铺在 CalSettings 上，这里整体搬进
 * accounts[0]，之后 settings 上不再保留这些字段（避免两处真相漂移）。
 * 老字段全空（全新安装）时建空数组，不造一个空账户占位。
 *
 * ⚠️ 幂等判据是「**老键还在不在**」而不是「accounts 是不是数组」——
 * store.load() 会先合并 DEFAULT_SETTINGS（自带 accounts: []），
 * 只看数组会让老数据被误判成「已是新结构」而跳过迁移。
 */
export function migrateToAccounts(s: any): void {
  const hasOldKeys = "serverUrl" in s || "username" in s || "password" in s || "calendarPath" in s || "calendars" in s;
  if (!hasOldKeys) return;
  const hasOld = !!(s.serverUrl || s.username || s.password || (Array.isArray(s.calendars) && s.calendars.length));
  if (!Array.isArray(s.accounts)) s.accounts = [];
  // 只有 accounts 为空时才用平铺字段造第一个账户。两者**共存**时（云同步把旧副本与
  // 新数据混在一起的极端情况）平铺字段只是残留，绝不能拿它覆盖现有账户数组 ——
  // 那是一次性抹掉用户其余全部账户的静默数据丢失。
  if (hasOld && !s.accounts.length) {
    s.accounts = [
      {
        id: newAccountId(),
        name: s.serverType === "icloud" ? "iCloud 账户" : "CalDAV 账户",
        enabled: true,
        serverUrl: s.serverUrl || "",
        username: s.username || "",
        password: s.password || "",
        calendarPath: s.calendarPath || "",
        serverType: s.serverType || "caldav",
        channel: s.channel || "auto",
        conflict: s.conflict || "server",
        pastDays: typeof s.pastDays === "number" ? s.pastDays : 90,
        futureDays: typeof s.futureDays === "number" ? s.futureDays : 370,
        calendars: Array.isArray(s.calendars) ? s.calendars : []
      }
    ];
  }
  // 老字段从 settings 上摘掉：留着就会被 persist 原样写回，变成第二处真相
  for (const k of ["serverUrl", "username", "password", "calendarPath", "serverType", "channel", "conflict", "pastDays", "futureDays", "calendars"]) {
    delete s[k];
  }
}

/** 所有启用账户 */
export function enabledAccounts(s: CalSettings): CalAccount[] {
  return (s.accounts || []).filter((a) => a && a.enabled);
}

/**
 * **真正在用**的日历集合 = 启用账户下的启用日历。
 *
 * 全仓唯一入口 —— 视图 / Dock / 日记 / 同步都走它，避免十几处
 * `settings.calendars.filter(enabled)` 各写一遍、漏改一处就表现为
 * 「停用账户的条目还在显示」。
 */
export function enabledCalendars(s: CalSettings): CalCalendar[] {
  const out: CalCalendar[] = [];
  for (const a of enabledAccounts(s)) {
    for (const c of a.calendars || []) if (c.enabled) out.push(c);
  }
  return out;
}

/** 按日历集合地址反查所属账户（同步层按它取凭据与通道） */
export function accountOfUrl(s: CalSettings, calUrl: string): CalAccount | undefined {
  if (!calUrl) return undefined;
  for (const a of s.accounts || []) {
    for (const c of a.calendars || []) {
      if (c.url === calUrl) return a;
    }
  }
  return undefined;
}

/** 按日历集合地址找日历配置（跨所有账户，含停用日历） */
export function findCalendarByUrl(s: CalSettings, calUrl: string): CalCalendar | undefined {
  if (!calUrl) return undefined;
  for (const a of s.accounts || []) {
    const hit = (a.calendars || []).find((c) => c.url === calUrl);
    if (hit) return hit;
  }
  return undefined;
}

/** 按条目反查所属账户 */
export function accountOfItem(s: CalSettings, item: CalItem): CalAccount | undefined {
  return accountOfUrl(s, item.calendarUrl);
}

/**
 * 新建条目的默认日历：全局一个 `defaultCalendarUrl`，失效时回退到
 * **第一个启用账户的第一个启用日历**（账户停用/日历删掉时不能指着空气）。
 */
export function resolveDefaultCalendar(s: CalSettings): CalCalendar | undefined {
  const all = enabledCalendars(s);
  if (s.defaultCalendarUrl) {
    const hit = all.find((c) => c.url === s.defaultCalendarUrl);
    if (hit) return hit;
  }
  return all[0];
}

export interface CalSettings {
  /**
   * 多日历账户（2026-10-25）。「服务器 / 日历 / 同步」三类设置已下沉到这里，
   * 每个账户一套；全局只留不分服务器的设置（同步间隔、提醒、日记、显示、
   * 附件上限、默认日历）。老数据由 migrateToAccounts() 一次性迁移。
   */
  accounts: CalAccount[];
  /** 自动同步间隔（分钟），0 关闭。全局一个周期，跑的时候把所有启用账户过一遍 */
  syncIntervalMin: number;
  /** 启用提醒通知（托盘运行时，对设置了提醒时间的日程/待办到点弹系统通知） */
  enableReminders?: boolean;
  /**
   * 新建条目的默认日历（全局一个，不区分账户）。
   * 停用/删除后由 resolveDefaultCalendar() 回退到第一个启用账户的第一个启用日历。
   */
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
 * 「清理本地条目」的备份（删账户时勾选清理产生）。
 *
 * 存的是**条目快照**（含 raw 原文），恢复时直接写回本地仓库即可，
 * 不需要再跟服务端同步一趟。
 *
 * ⚠️ 它存在**数据文件的顶层**（PersistData.purgeBackup），不是 settings 里 ——
 * settings 会被 Obsidian 的「配置备份」单独抄走（core/config-backup.ts 明确
 * 只存配置、不存条目），把条目快照塞进 settings 会让那个备份文件凭空膨胀
 * 几十 MB，破坏它「轻量配置备份」的定位。
 */
export interface PurgeBackup {
  /** 清理时间（ISO 字符串） */
  at: string;
  /** 清理后保留的账户名（可能有多个，顿号分隔） */
  keptServer: string;
  /** 被清理的账户名 */
  removedServers: string;
  /** 被清理的条目数 */
  count: number;
  /** 被清理的条目快照 */
  items: CalItem[];
  /** 一并被移除的日历配置（恢复时连配置一起还原，可直接重新启用） */
  calendars?: CalCalendar[];
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
  accounts: [],
  syncIntervalMin: 15,
  enableReminders: false,
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
  /**
   * 最近一次「清理旧服务器条目」的备份（见 PurgeBackup）。
   *
   * 放顶层而不是 settings 里 —— settings 会被 Obsidian 的「配置备份」单独抄走，
   * 那个文件明确只存配置不存条目（见 core/config-backup.ts 的取舍说明）。
   */
  purgeBackup?: PurgeBackup;
}

export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}
