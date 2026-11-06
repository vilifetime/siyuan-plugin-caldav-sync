/**
 * CalDAV日历任务 —— 思源笔记插件入口
 * 左侧 Dock：精简导航（视图切换 + 设置）；主日历视图：主窗口页签
 */
import { Dialog, Plugin, openTab, openWindow, openMobileFileById, showMessage, type Custom, type MobileCustom, type Tab } from "siyuan";
// pushMsg 在部分思源版本的 siyuan.d.ts 里没有声明（运行时通常存在），故用命名空间做存在性容错调用
import * as siyuanApi from "siyuan";
import "@/index.css";
import { CalStore } from "@/core/store";
import { SyncEngine } from "@/core/sync";
import { setSecretSeed } from "@/core/secret";
import { setDirectFallbackToProxy, httpRequest } from "@/core/http";
import { setHolidayTransport, setHolidayRuntime } from "@/core/holiday-cn";
import { readFirstFrameSnapshot, writeFirstFrameSnapshot } from "@/core/first-frame";
import { occurrencesInRange } from "@/core/ics";
import { todayStamp, fmtDateCn, fmtTime, stampOfMs, parseLocalStamp, diffDays } from "@/core/date";
import type { CalItem } from "@/core/types";
import { enabledAccounts, enabledCalendars, findCalendarByUrl, resolveDefaultCalendar } from "@/core/types";
import { todoDueOccurrences } from "@/ui/view-common";
import { initialViewMode as readLastView, saveViewMode as writeLastView, saveCalendarView } from "@/ui/view-pref";
import { ReminderEngine } from "@/core/reminder";
import { projectReminderItem, type ReminderSnapshot } from "@/core/kernel-shared";
import { renderPanel, renderDockPanel, notifyViewChange, toggleTodoDone, VIEW_CHANGE_EVENT, type PanelCtx, type ViewMode } from "@/ui/panel";
import { isMobile } from "@/ui/device";
import { adoptMobileLayer, closeAllMobileLayers, isDialogAlive } from "@/ui/mobile-layers";
import { openEditor } from "@/ui/editor";
import { openSettingsDialog } from "@/ui/settings-dialog";
import { askDiaryRange } from "@/ui/diary-range-dialog";
import { diarySpanOf, spanContains, diaryTargetStamp, targetOptionsOf, type DiaryRange, type DiaryTarget } from "@/ui/diary-range";
import { dailyNoteAttrName, diaryWhenLabel, renderDailyNotePath, sqlText, baseNameOf } from "@/ui/diary-note";
import { showReminderToast, clearReminderToasts } from "@/ui/reminder-toast";
import { newDialog } from "@/ui/dialog";
import { confirmBlockChanges } from "@/ui/change-alert-dialog";
import type { KernelCaller } from "@/core/block-api";
import { getTaskBlockById, getBlockRootId, setBlockSkip, listNotebooks, getBlockDetail, BLOCK_SKIP_ATTR } from "@/core/block-api";
import { runBlockSync, convertBlock, unsyncBlock, clearBlockSync } from "@/core/block-sync";
import { setI18n, t as _t } from "./core/i18n";


/**
 * 从思源 protyle 实例里取它所属的文档（root）ID。
 * 用于「关闭文档时扫描」：destroy-protyle / switch-protyle 的 detail.protyle 就是编辑实例，
 * 文档根块 ID 在 protyle.block.rootID（部分版本路径略有差异，这里多兜底一级）。
 */
function docIdOf(protyle: any): string | undefined {
  if (!protyle) return undefined;
  return (
    protyle?.protyle?.block?.rootID ||
    protyle?.block?.rootID ||
    protyle?.protyle?.block?.id ||
    protyle?.block?.id ||
    undefined
  );
}

/**
 * Dock / 页签的类型标识。思源拿它记账（侧栏位置、已打开模型），**改了等于换一个插件**，
 * 用户已保存的 Dock 布局会失配。所以它只当「标识」用，不再兼作数据文件名。
 */
const DOCK_TYPE = "caldav-sync-dock";
const TAB_TYPE = "caldav-sync-tab";
/** 独立窗口存在态标记（localStorage key，同源窗口共享）；单例判定用 */
const SECONDARY_WIN_KEY = "siyuan-caldav-sync-win";
/** 插件数据文件名：带 .json 后缀，便于在文件管理器里直接双击查看/编辑 */
const DATA_FILE = "caldav-sync.json";

/**
 * 0.2.12 及更早版本的数据文件名（无扩展名，历史上直接复用了 DOCK_TYPE 的值）。
 * 这里刻意写成字面量而不是 `= DOCK_TYPE` —— 它是**冻结的历史值**，
 * 将来谁再动 DOCK_TYPE 都不能连带改掉它，否则老用户的数据就找不回来了。
 */
const LEGACY_DATA_FILE = "caldav-sync-dock";
/** 更早期原型留下的空壳文件：任何已发布版本都不读它，迁移时顺手清掉 */
const STALE_DATA_FILES = ["caldav-data.json"];
/**
 * 写入日记的小节标题的**基础部分**，同时作为「重复点击→替换而非追加」的识别标记。
 *
 * ⚠️ 实际写入的标题可能带区间后缀（本周/本月，见 ui/diary-range.ts 的
 * diarySpanOf），所以匹配旧小节时必须用**实际要写的那一行**，不能用本常量
 * 硬匹配 —— 否则跨日范围永远命中不了，每次点击都追加一个重复小节。
 */
const DIARY_SECTION_BASE = _t("日程与待办");

const ICONS = `<symbol id="iconCalDavSync" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M9 16l2 2 4-4"/></symbol>`;

/**
 * 思源 Dialog 被 destroy() 后会置 `destroying`（移动端产物里就是 `this.destroying=!0`），
 * 但从那一刻到「真正移除元素 + 回调 destroyCallback」之间还隔着一个 timeout：
 * 这期间它已经不可见（`b3-dialog--open` 被摘掉、遮罩与容器 opacity 归零），
 * 元素却还在 DOM 里。判定「这一层还算不算活着」必须看它，
 * 否则刚点过关闭就再点入口会复用一个正在消失的层 —— 表现为「点了没反应」。
 * 读不到该字段（版本差异）时按「没在销毁」处理，退化成原行为。
 */
export default class CalDavPlugin extends Plugin {
  store!: CalStore;
  sync!: SyncEngine;
  /** 主窗口页签共享状态（单例，Dock 导航与页签共用） */
  mainCtx!: PanelCtx;
  /** 提醒引擎（开启提醒通知时存在） */
  private reminder?: ReminderEngine;
  /** 「稍后提醒」的临时计时器（仅本次会话有效） */
  private snoozeTimers = new Set<ReturnType<typeof setTimeout>>();
  private disposers = new Map<string, () => void>();
  private tabPanel: { refresh: () => void } | null = null;
  private tab: Tab | null = null;
  /**
   * [SPIKE issue #5] 插件「可用」信号：store / mainCtx / i18n 就绪后 resolve。
   *
   * 独立窗口里思源 `loadPlugins()` 默认不 await 插件的 async onload()，会先恢复布局、
   * 后等 onload 跑完；自定义页签的 init 因此可能早于 mainCtx 就绪被调到。此时先占位，
   * 等这里 resolve 再补渲染。**init 绝不能抛错** —— 异常会冒泡到思源 getEmojiConf 回调，
   * 令 layoutReady 永不 resolve，新窗口就永远停在 #loading 转圈（issue #5 首轮实测现象）。
   */
  private resolveReady: () => void = () => {};
  private readyPromise = new Promise<void>((resolve) => { this.resolveReady = resolve; });
  /**
   * [SPIKE issue #5] 当前是否是思源的「独立窗口」（window.html）。
   * 从属窗口只读：不写 petal 数据、不启动自动同步/提醒/内核推送，避免与主窗口实例
   * 互相覆盖同一份 caldav-sync.json → 内核高频 dataChange → 插件 teardown → 窗口消失。
   */
  private isSecondaryWindow = false;
  /** 正在应用对端窗口传来的数据变更：期间本窗口任何 persist 都不广播，避免回环 */
  private applyingRemote = false;
  /** 跨窗口数据变更通知通道（BroadcastChannel；不可用时降级到 localStorage storage 事件） */
  private bc: BroadcastChannel | null = null;
  /** 独立窗口单例：正在开窗口，防连按重复开 */
  private openingWindow = false;
  /** 独立窗口存活探活：pending 的 pong 回调（BroadcastChannel ping/pong 用） */
  private pendingWinAlive: ((alive: boolean) => void) | null = null;
  /** 渲染就绪信号：在 createCtx 之后 resolve，供独立窗口页签延迟补挂载用（比 readyPromise 更准时） */
  private resolveCtxReady: () => void = () => {};
  private ctxReady: Promise<void> = new Promise<void>((res) => { this.resolveCtxReady = res; });
  /**
   * 移动端全屏承载面板（移动端没有页签，改用 Dialog 承载同一套 renderPanel）。
   * dialog 与其中的面板一起记账：回调按**实例**自证身份，旧层的迟到回调不会碰新层。
   */
  private mobilePanel: {
    dialog: Dialog;
    panel: { destroy: () => void; refresh: () => void };
    dispose: () => void;
  } | null = null;
  private viewChangeHandler: ((e: Event) => void) | null = null;

  /**
   * 档2·真·内核后端：前端↔内核 RPC 方法名（与 src/kernel.ts 严格对齐）。
   * 内核 bind `pushReminderData` 收快照；内核 broadcast `requestReminderData` 拉首份。
   */
  private static readonly KERNEL_RPC_PUSH = "pushReminderData";
  private static readonly KERNEL_RPC_REQUEST = "requestReminderData";
  /** 推送提醒快照的去抖计时器（避免刷新/同步高频时反复大数组序列化） */
  private reminderPushTimer: ReturnType<typeof setTimeout> | null = null;
  /** requestReminderData 的处理器引用（onunload 时需同一引用解绑） */
  private kernelRequestHandler = (): void => {
    this.pushReminderSnapshot();
  };

  /**
   * 主窗口「上次用的视图」。
   *
   * Dock 里原来有「日历视图 / 任务视图」两个按钮，现合并成一个（2026-10-10 雄哥要求）：
   * 点它就打开**这里记着的那个视图**，所以必须跨会话记住 —— 初始化时从
   * 配置读（settings.lastView），之后每次视图变化（见 viewChangeHandler）写回。
   */
  /**
   * ⚠️ 这里**不能**在字段初始化时就读 —— 那时 store 还没 load，settings 是空的。
   * 真正在 `onload()` 里 store.load() 之后赋值（见下方 `this.lastViewMode = ...`）。
   */
  private lastViewMode: ViewMode = "month";
  /** Dock 面板的挂载记录（思源可能重建侧栏容器，需按「当前活着的元素」重新挂载） */
  private dockMount: { el: HTMLElement; refresh: () => void; destroy: () => void } | null = null;
  /** 移动端侧栏 DOM 观察器：插件 Dock 容器空着被显示出来时补挂面板 */
  private dockObserver: MutationObserver | null = null;
  /**
   * 思源给插件 Dock 内容套的那层「自带滚动」的容器。它用的是浏览器原生滚动条
   * （右侧一条常驻竖杠，Windows 下还带上下箭头），叠在我们自己的列表滚动条外圈。
   * 运行时向上探测到它之后打 .caldav-scroll-host 标记，交给 CSS 做成透明 + 悬停显形。
   * 卸载时要把标记摘掉 —— 那是思源的元素，不能留。
   */
  private dockScrollHost: HTMLElement | null = null;
  /**
   * 正在跑的同步（null = 空闲）。
   * 用 promise 而非 boolean：并发调用方要能**等**上一轮跑完再接上，
   * 单纯`if (busy) return` 会把请求静默丢弃（见 runSync）。
   */
  private inflight: Promise<unknown> | null = null;

  async onload(): Promise<void> {
    const self = this;

    // [SPIKE issue #5] 独立窗口 URL 是 /stage/build/app/window.html（主窗口是 index.html）。
    // 不用思源 isWindow() 的 `document.getElementById("toolbar")` 判据：onload 时 DOM
    // 可能还没插入 toolbar，会误把主窗口判成从属窗口、导致配置完全不落盘。
    this.isSecondaryWindow = /window\.html/i.test(window.location.pathname);
    if (this.isSecondaryWindow) {
      console.info("[caldav][spike] 独立窗口：从属模式");
      // 标记独立窗口已开，供主窗口单例探活（同源 localStorage 跨窗口共享）
      this.markSecondaryWindowOpen();
    } else {
      // 主窗口启动：清掉可能由「上一次会话崩溃 / 未按 onunload 退出」残留的陈旧标记，
      // 否则会把热键永久锁死。真正存活的窗口会由 openCalendarWindow 的 ping/pong 探活确认。
      this.clearSecondaryWindowOpen();
    }

    // [SPIKE issue #5] 自定义页签必须在**第一个 await 之前**同步注册。
    // 思源新窗口 loadPlugins() 默认不 await 插件的 async onload()，布局恢复会先跑；
    // 注册晚一步，newModelByInitData 就找不到 models[customModelType]，抛出的异常会
    // 冒泡到 getEmojiConf 回调、令 layoutReady 永不 resolve → 独立窗口永远停在 loading 转圈。
    // 同时 init 全程 try/catch + 上下文未就绪时延迟补渲染，保证绝不阻断思源窗口初始化。
    this.addTab({
      type: TAB_TYPE,
      init: function (this: Custom) {
        try {
          if (self.disposers.has("tab")) return;
          // 关键：直接挂到实时 this.element，绝不以 isConnected 门控。
          // openWindow 把页签从主窗口迁移到独立窗口时，元素会短暂 disconnected；
          // 渲染进节点的内容一旦元素连上即显示，若判 isConnected 反而会把挂载永久跳过 → 整窗空白
          // （第五轮起独立窗口用不同 tab id 后，openTab 新建实例、迁移瞬间元素断开，正是这个门控导致空白）。
          // 元素若尚未就绪（极少数时序），用 setTimeout 重试兜底。
          let mountTries = 0;
          const tryMount = () => {
            if (self.disposers.has("tab")) return;
            const el = this.element as HTMLElement | null;
            if (!el) {
              if (mountTries++ < 60) setTimeout(tryMount, 16);
              return;
            }
            self.mountTabPanel(el);
          };
          if (!self.mainCtx) {
            // 新窗口布局恢复早于本插件 onload 完成：先占位，ctxReady 后补挂载。
            // 用 ctxReady（createCtx 之后 resolve）而非 readyPromise，避免早 resolve 时 mainCtx 尚未就绪而永不挂载。
            void self.ctxReady.then(tryMount).catch((err) => {
              console.warn("[caldav][spike] 独立窗口页签延迟补渲染失败", err);
            });
            return;
          }
          tryMount();
        } catch (err) {
          console.warn("[caldav][spike] 自定义页签 init 失败（已忽略，避免阻断窗口初始化）", err);
        }
      },
      beforeDestroy: function () {
        self.disposers.get("tab")?.();
        self.disposers.delete("tab");
      }
    });
    console.info("[caldav][spike] addTab 同步注册完成", this.name + TAB_TYPE);

    this.addIcons(ICONS);
    // 加载时先清场：覆盖安装 / 集市热更新只换 JS，页面上已有的插件全屏弹层会留下，
    // 它们不属于本实例、回调也属于旧模块，但照样挡着整屏 —— 每关一层下面还压着一层。
    closeAllMobileLayers();

    // 移动端 WebView 会拦掉明文 HTTP 的浏览器直连（报 Failed to fetch），
    // 直连在网络层失败时自动改走内核代理 —— 见 core/http.ts 的说明。
    setDirectFallbackToProxy(isMobile());

    // [issue #5 · C 项] 独立窗口不联网预热节假日：只复用主窗口已写入的共享缓存。
    // 独立窗口是另一个渲染进程，内存缓存不共享；此前它每次 renderView 都把三年 × 多候选
    // 重拉一遍，国内 jsdelivr/raw 全超时 → 内核代理回退直连刷屏、徽标迟迟不出现。
    // 主窗口照常按更新频率拉取并写共享快照；设置页「立即检查更新」仍可强制拉取。
    // 农历/节气走内置算法、同步渲染，不受此开关影响。
    setHolidayRuntime({ networkAllowed: !this.isSecondaryWindow });

    // 中国日历·节假日拉取改走 SiYuan 内核代理（服务端 fetch，绕开浏览器 CORS、
    // 走本机真实网络/代理，国内 GitHub/raw 即便浏览器直连被墙也能经此拿到）。
    setHolidayTransport(async (url, ms, headers) => {
      try {
        const r = await httpRequest(url, { method: "GET", timeoutMs: ms, headers }, "auto");
        if (r.status < 200 || r.status >= 300) return { ok: false, error: "HTTP " + r.status };
        let data: unknown;
        try {
          data = JSON.parse(r.body);
        } catch (e) {
          return { ok: false, error: _t("JSON 解析失败：{0}", (e as Error).message) };
        }
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: String(e instanceof Error ? e.message : e) };
      }
    });

    // 先拿到设备标识（思源 conf.system.id + 工作空间路径）作为凭据加密密钥来源，
    // 再加载 store —— 顺序不能反，否则密文解不开会被当成「密码丢失」。
    await this.ensureSecretSeed();


    // [issue #5 · L2 乐观首帧] 独立窗口先吃主窗口写的同源共享快照，让 store.load() 秒回，
    // 跳过「内核读盘往返 + 解析 2.6MB 数据 + 逐账户凭据解密」实测约 175ms；随后后台再做
    // 一次真实读盘校正（恢复账户/凭据并重绘）。
    // 安全红线：快照递归剔除所有凭据类字段（见 core/first-frame.ts）；乐观期一律不落盘，
    // 绝不把「无凭据」的乐观内存写回数据文件（会丢密码）。主窗口每次真实读盘/落盘都刷新快照。
    let firstFrame = this.isSecondaryWindow ? readFirstFrameSnapshot() : null;
    let firstFrameActive = !!firstFrame; // 乐观期：禁止任何落盘
    const loadDataForStore = (): Promise<any> => {
      if (firstFrame) {
        const data = firstFrame.data;
        firstFrame = null; // 快照只用一次，之后一律走真实读盘
        return Promise.resolve(data);
      }
      return this.loadPluginData();
    };
    this.store = new CalStore({
      // 读：新文件名优先，读不到再回退历史文件名并一次性迁移（见 loadPluginData）
      loadData: () => {
        const p = loadDataForStore();
        // 主窗口：启动读盘及后续每次重载都刷新共享快照，供独立窗口乐观首帧使用。
        if (!this.isSecondaryWindow) {
          void p.then((d) => { writeFirstFrameSnapshot(d); }).catch(() => { /* 忽略 */ });
        }
        return p;
      },
      // [SPIKE issue #5] 独立窗口现在正常落盘：勾选待办 / 改设置都必须写回。
      // 「写 → dataChange → 关窗」的循环已通过覆写 onDataChanged（只 reload 不 teardown）
      // 彻底阻断，因此不再需要把从属窗口设为只读。落盘后顺便广播给其它窗口（见 saveDataAndNotify）。
      saveData: (d) => {
        if (!this.isSecondaryWindow) writeFirstFrameSnapshot(d);
        if (firstFrameActive) return Promise.resolve(); // 乐观期：丢弃写盘，等真实读盘校正
        return this.saveDataAndNotify(DATA_FILE, d);
      }
    });
    try {
      await this.store.load();
    } catch (e) {
      if (!firstFrameActive) throw e;
      // 快照骨架与当前 store 版本不兼容：立刻退回真实读盘，宁可慢也不空白。
      console.warn("[caldav][first-frame] 快照载入失败，回退真实读盘", e);
      await this.store.load();
      firstFrameActive = false;
    }
    this.setupCrossWindowSync();

    // 上次视图存在配置里（settings.lastView），必须在 load() 之后读。
    // 早先是 localStorage —— 思源每次启动端口随机，localStorage 按 origin（含端口）
    // 隔离，写进去的记录下次永远读不回来，等于「记住上次视图」一直是失效的。
    this.lastViewMode = readLastView(this.store.settings);
    // 设备标识若迟到（getConf 失败/慢），v2 旧密文会停在「待解密」。稍后补一次；
    // 即便仍解不开，也绝不会把磁盘上的密文覆盖成空串（见 CalStore.unlockPassword）。
    if (this.store.pendingUnlock) {
      setTimeout(() => void this.retrySecretUnlock(), 2500);
    }
    this.sync = new SyncEngine(this.store, () => "auto");
    this.mainCtx = this.createCtx();
    // 渲染就绪信号：独立窗口页签延迟补挂载以本信号为准（createCtx 之后才真正可渲染）。
    try { this.resolveCtxReady(); } catch { /* 忽略 */ }

    // [L2] 真实数据校正：乐观首帧只有 items/settings（无凭据）。setTimeout(0) 让首帧
    // 挂载（ctxReady.then 微任务）先完成后，再后台从磁盘完整载入、恢复凭据并刷新面板。
    // 只有真实读盘成功才解除落盘锁 —— 读盘失败宁可暂保持只读，也不能把乐观数据写回文件。
    // reloadFromDisk 用 applyingRemote 抑制广播，避免触发跨窗口回环。
    if (firstFrameActive) {
      setTimeout(() => {
        void this.reloadFromDisk().then((ok) => {
          if (ok) firstFrameActive = false;
          else console.warn("[caldav][first-frame] 真实读盘失败，独立窗口暂保持只读以免写坏凭据");
        }).catch((e) => {
          console.warn("[caldav][first-frame] 校正失败，独立窗口暂保持只读", e);
        });
      }, 0);
    }

    // i18n：把思源按 window.siyuan.config.lang 自动加载的 plugin.i18n 喂给全局单例，
    // 之后任何模块（含 core）都能用 t(key) 取文案。必须在 createCtx 之后、首次渲染前完成。
    setI18n(this.i18n as unknown as Record<string, string> | undefined);
    // [SPIKE issue #5] 核心依赖（store / mainCtx / i18n）已就绪，放行独立窗口里挂起的补渲染。
    // 兜底定时器：万一 onload 后续环节抛错，也不让新窗口页签永远空白（重复 resolve 无害）。
    this.resolveReady();
    setTimeout(() => this.resolveReady(), 2000);
    console.info("[caldav][spike] onload 核心就绪，放行页签渲染");

    // 设置变更 / 同步落盘后：重算提醒开关并重新排程
    this.store.onChange(() => {
      this.reconcileReminders();
      this.reminder?.reschedule();
      // 档2·内核后端：设置里有 webhook/提醒锚点变化，需同步给内核重新排程
      this.pushReminderSnapshot();
    });

    // 左侧 Dock：精简导航（视图按钮在主窗口打开/切换日历页签）
    this.addDock({
      config: {
        position: "LeftBottom",
        size: { width: 240, height: 0 },
        icon: "iconCalDavSync",
        title: _t("日历任务管理"),
        hotkey: "⌥⇧C"
      },
      data: { key: "dock" },
      type: DOCK_TYPE,
      init: function (this: Custom | MobileCustom) {
        self.mountDock(this.element as HTMLElement);
        // 点击插件图标展开 Dock 时，默认在主窗口打开面板 —— 用**上次用过的视图**
        // （与 Dock 里那个「打开上次视图」按钮口径一致，否则展开是月视图、
        // 点按钮又跳回周视图，自相矛盾）。
        // 延迟执行：init 阶段 SiYuan 布局尚未完全就绪，立即 openTab 可能被忽略；
        // 等布局稳定（约 350ms）后再开，确保「日历」页签稳定弹出。
        // 移动端跳过：侧栏抽屉刚展开就被全屏面板盖住会让人摸不着北，
        // 改由抽屉内的按钮或顶部「插件」菜单触发。
        if (!isMobile()) {
          setTimeout(() => self.openPanelTab(self.lastViewMode), 350);
        }
      },
      update: function (this: Custom | MobileCustom) {
        // 移动端再次激活同一个 Dock 时思源**只调 update、不调 init**
        // （app/src/mobile/util/initFramework.ts 的 updateDock），
        // 不实现它就等于后续点击全部石沉大海。
        self.mountDock(this.element as HTMLElement);
      },
      destroy: () => self.unmountDock()
    });
    // 移动端：侧栏渲染本身就会挑一个 Dock 作为当前项并把它的容器显示出来，
    // 那条路径不经过 init/update —— 容器会空着给人看（就是「一片空白」）。
    this.watchMobileDock();

    // 监听视图切换，同步更新已打开页签的标题（页签注册已前移到 onload 开头，见上方注释）
    this.viewChangeHandler = (e: Event) => {
      const mode = (e as CustomEvent).detail as ViewMode;
      const title = mode === "task" ? _t("任务") : _t("日历");
      if (self.tab) {
        self.tab.updateTitle(title);
      }
      const header = self.mobilePanel?.dialog.element.querySelector(".b3-dialog__header");
      if (header) header.textContent = title;
      // 记住这次视图：Dock 的合并按钮（打开上次视图）下次要用
      if (mode) self.lastViewMode = mode;
      writeLastView(this.store.settings, mode);
      // 日历视图单独记一份（2026-10-20）：从任务视图返回时要回到进任务视图
      // 之前的那个日历视图，而不是统一落回月视图。task 不覆盖它。
      saveCalendarView(this.store.settings, mode);
      this.store.markSettingsDirty();
    };
    document.addEventListener(VIEW_CHANGE_EVENT, this.viewChangeHandler);

    // 命令（可在「设置 → 快捷键」中绑定）
    this.addCommand({
      langKey: "syncNow",
      langText: _t("立即同步 CalDAV"),
      hotkey: "",
      callback: () => void this.runSync(true)
    });
    this.addCommand({
      langKey: "addTask",
      langText: _t("新建待办"),
      hotkey: "",
      callback: () => openEditor(this.mainCtx, { kind: "todo" })
    });
    this.addCommand({
      langKey: "openPanel",
      langText: _t("打开日历与任务"),
      hotkey: "",
      callback: () => this.openPanelTab()
    });
    this.addCommand({
      langKey: "insertToday",
      // 不再写死「今日」：点了会先问范围（当日/本周/本月/所有）
      langText: _t("把日程与待办插入日记"),
      hotkey: "",
      callback: () => this.askInsertDiary()
    });

    // [SPIKE issue #5] 全局快捷键 → 独立窗口（最小闭环探针，验证通过后产品化）。
    // hotkey 必须非空：思源仅在带 globalCallback 的命令上注册系统级 globalShortcut，
    // 且 accelerator 取 keymap 的 custom；hotkey 为空则 custom 为空、根本不会注册。
    // callback 覆盖「焦点在应用内」，globalCallback 覆盖「焦点不在应用内 / 窗口最小化」。
    this.addCommand({
      langKey: "openCalendarWindow",
      langText: _t("在独立窗口打开日历"),
      hotkey: "⌥⇧⌘K",
      callback: () => this.openCalendarWindow(),
      globalCallback: () => this.openCalendarWindow()
    });

    // 移动端入口：移动端没有 Dock 图标列，addTopBar 会归入右上「插件」菜单，
    // 这是手机上最直接调出日历/任务面板的路径。
    // 标题带插件名，免得和别的日历类插件在菜单里撞名。
    if (isMobile()) {
      this.addTopBar({
        icon: "iconCalDavSync",
        title: _t("CalDAV日历任务"),
        position: "right",
        callback: () => this.openPanelTab()
      });
    }

    // 文档任务块的块菜单入口（issue #2 的单笔转换）：
    // 「同步此任务到 CalDAV」/「取消同步」/「重新同步到 CalDAV」三态。
    // ⚠️ 总开关没打开就**一个菜单项都不挂** —— 功能没启用就不该在界面上出现。
    this.eventBus.on("open-menu-content", (e: any) => void this.onBlockMenu(e));
    // 块图标把手菜单入口（点块左侧 ⋮⋮ 图标把手）：与 open-menu-content 双入口并存。
    // 两个入口都只做「识别任务块」，真正注入由 injectBlockSyncMenu 等 #commonMenu 挂到
    // document 后完成（对齐番茄钟的靠上位置，且避开内核把插件项收进「插件」分组）。
    this.eventBus.on("click-blockicon", (e: any) => this.onBlockIconMenu(e));
    // 关闭当前文档时扫描该文档的任务块（受 onDocClose 开关 gate）：捕获刚关掉的文档里的改动 / 删除。
    // 用 destroy-protyle（detail = {protyle}）—— 文档 tab 真正销毁时才派发，比 switch-protyle（仅切换）精确。
    this.eventBus.on("destroy-protyle", (e: any) => this.onDocClose(e));

    // [SPIKE issue #5] 从属窗口不跑「定时 / 调度」类后台任务（自动同步、提醒引擎、
    // 内核 RPC 推送）：避免在同一份数据上重复跑调度、重复弹提醒。但用户**手动**交互
    // 仍正常落盘（勾待办 / 改设置 / 手动同步都会 saveData），并通过 onDataChanged
    // 钩子与对端同步。真正阻断「关窗循环」的是 onDataChanged（只 reload 不 teardown）。
    if (!this.isSecondaryWindow) {
      if (this.store.isConfigured()) {
        this.sync.startAutoSync(() => this.reminder?.reschedule());
        setTimeout(() => void this.runSync(false), 3000);
      }
      // 按当前设置决定是否启动提醒引擎（设置可能已开启）
      this.reconcileReminders();

      // 档2·内核后端：监听内核拉首份数据请求 + 冷启动主动推一次快照。
      // 若没有打包 kernel.js（旧版），bind/call 都会静默失败，不影响前端既有提醒通道。
      try {
        this.kernel.rpc.bind(CalDavPlugin.KERNEL_RPC_REQUEST, this.kernelRequestHandler);
      } catch {
        /* 无内核后端：忽略 */
      }
      this.pushReminderSnapshot();
    }
  }

  /**
   * 块菜单钩子：给**任务列表块**加同步入口。
   *
   * 三态（由块的状态决定，见 core/block-api.ts 的 skip 标记）：
   *   未同步 → 「同步此任务到 CalDAV」  建 VTODO（X-SIYUAN-BLOCK-ID 锚住块 ID）
   *   已同步 → 「取消同步」            删 VTODO + 打 skip 标记（不打标记下轮会被重建）
   *   已忽略 → 「重新同步到 CalDAV」    清标记 → 立刻建回来
   *
   * 全程 try/catch：菜单是思源主流程上的钩子，插件抛错会污染用户的右键菜单体验。
   */
  /**
   * 从 open-menu-content 的 detail 里定位「任务列表块」（思源的 NodeListItem）。
   *
   * 真实 DOM（本机思源实测，2026-10-28）：
   *   - 右键时 detail.element 通常是任务项**内部**的 <div data-type="NodeParagraph" class="p">（段落），
   *     而不是任务块本身；
   *   - 真正的任务块（NodeListItem）是它的父节点：<li data-subtype="t" data-type="NodeListItem" class="li protyle-task--done">，
   *     其 data-node-id 才是该任务的块 ID；
   *   - 复选框渲染为 <div class="protyle-action protyle-action--task"><svg>，既不是 .protyle-task 也不是 input[type=checkbox]。
   *   - 已完成态：li 上 data-task="X"（或 class 含 protyle-task--done）、未完成 data-task=" "。
   *
   * 策略：从 element 自身或向上 closest('[data-type="NodeListItem"][data-subtype="t"]') 取到任务项。
   * 兼容 detail.blockElements（部分版本把命中块放在这里）。
   * 也兼容 click-blockicon 入口：该事件无 detail.element，块信息在 detail.data.dom。
   */
  private resolveTaskNode(detail: any): HTMLElement | undefined {
    const roots: any[] = [];
    if (detail?.element) roots.push(detail.element);
    if (Array.isArray(detail?.blockElements)) roots.push(...detail.blockElements);
    // click-blockicon 入口：块信息在 detail.data.dom（无 detail.element），须一并纳入
    if (detail?.data?.dom) roots.push(detail.data.dom);
    for (const el of roots) {
      if (!el || typeof el.closest !== "function") continue;
      // 自身即任务项（NodeListItem + subtype=t）
      if (
        el.getAttribute?.("data-type") === "NodeListItem" &&
        el.getAttribute?.("data-subtype") === "t" &&
        el.getAttribute?.("data-node-id")
      ) {
        return el;
      }
      // 自身是任务项内部的段落/复选框/动作 div → 向上找最近的 NodeListItem
      const li =
        el.closest?.('[data-type="NodeListItem"][data-subtype="t"]') ||
        el.closest?.('li[data-subtype="t"]');
      if (li) return li as HTMLElement;
    }
    return undefined;
  }

  private async onBlockMenu(e: any): Promise<void> {
    try {
      const s = this.store.settings;
      const detail = e?.detail;
      if (!s.blockSyncEnabled) return;
      // detail.element 通常是任务项内部的段落（NodeParagraph），真正的任务块（NodeListItem）
      // 是它的祖先，需向上 closest 取到。resolveTaskNode 已处理自身/祖先两种情况。
      const el = this.resolveTaskNode(detail);
      if (!el) return;
      const nodeId = el.getAttribute("data-node-id") || "";
      if (!nodeId) return;
      // 同步加到菜单第一层并保证渲染，再异步抬高到「添加到数据库」之前（与番茄钟同高）。
      // 注入逻辑见 injectBlockSyncMenu：失败/超时仍保证显示，不会丢项。
      this.injectBlockSyncMenu(nodeId, el, s);
    } catch (err) {
      console.warn("[caldav] 块菜单钩子失败（已忽略）", err);
    }
  }

  /**
   * 构建「任务块 ⇄ VTODO」三态同步菜单项，两个入口（open-menu-content / click-blockicon）共用。
   *
   * 三态（由块状态决定）：
   *   已映射 → 「取消同步（删除对应的 CalDAV 待办）」  删 VTODO + 打 skip 标记（防下轮重建）
   *   未映射 + 有 skip 标记 → 「重新同步到 CalDAV」    清标记 → 立刻建回
   *   未映射 + 无标记 → 「同步此任务到 CalDAV」        建 VTODO（X-SIYUAN-BLOCK-ID 锚住块 ID）
   *
   * ⚠️ 同步读取「忽略标记」：直接读块 DOM 上的 BLOCK_SKIP_ATTR（setBlockSkip 写的同一个属性）。
   * 绝不能 await 内核查询 —— 钩子是 async 时 await 会把 menu.addItem 推迟到微任务之后，
   * 而思源派发菜单事件后**同步**就渲染菜单，被推迟的 addItem 会丢失（菜单项不出现）。
   */
  private buildBlockSyncMenuItems(nodeId: string, el: HTMLElement, s: any): any[] {
    const caller = this.kernelCaller();
    // 两个固定项：始终出现（功能已启用时）。用户主动触发，不受 onManualSync/onStartup gate。
    const fixed = [
      {
        icon: "iconCalDavSync",
        label: _t("扫描任务块（当前文档）"),
        click: () => void this.scanBlockDoc(nodeId),
      },
      {
        icon: "iconCalDavSync",
        label: _t("扫描任务块（全部）"),
        click: () => void this.scanBlockAll(),
      }
    ];
    const sep = { type: "separator" };
    const mapped = this.store.getAll().find((it) => it.kind === "todo" && it.blockId === nodeId);
    if (mapped) {
      return [
        ...fixed,
        sep,
        {
          icon: "iconCalDavSync",
          label: _t("查看对应 VTODO"),
          click: () => this.showVtodoDetail(mapped),
        },
        {
          icon: "iconCalDavSync",
          label: _t("取消同步（删除对应的 CalDAV 待办）"),
          click: () => {
            void unsyncBlock({ store: this.store, sync: this.sync, caller }, mapped).then(
              () => {
                this.refreshPanels();
                showMessage(_t("已取消同步，该块后续不会再被扫描"), 4000);
              },
              (err) => showMessage(`${_t("取消同步失败：")}${String((err as Error)?.message || err)}`, 6000)
            );
          }
        }
      ];
    }
    const skipped = !!el.getAttribute(BLOCK_SKIP_ATTR);
    return [
      ...fixed,
      sep,
      {
        icon: "iconCalDavSync",
        label: skipped ? _t("重新同步到 CalDAV") : _t("同步此任务到 CalDAV"),
        click: () => {
          void (async () => {
            const block = await getTaskBlockById(caller, nodeId, s.blockSyncPrefix);
            if (!block) {
              showMessage(_t("没读到这个任务块（可能已被删除）"), 4000);
              return;
            }
            if (skipped) {
              await setBlockSkip(caller, nodeId, false);
              await convertBlock({ store: this.store, sync: this.sync, caller }, block);
            } else {
              await convertBlock({ store: this.store, sync: this.sync, caller }, block);
            }
            this.refreshPanels();
            showMessage(_t("已同步到 CalDAV"), 4000);
          })().catch((err) =>
            showMessage(`${_t("同步失败：")}${String((err as Error)?.message || err)}`, 6000)
          );
        }
      }
    ];
  }

  /**
   * 查看「任务块 ⇄ VTODO」当前绑定的 VTODO 详情（弹窗展示，避免钻多层子菜单）。
   * 数据取自本地 store（即上次同步后的映射项）：日历名称、待办名称、开始日期、
   * 结束日期、当前状态、UID。
   */
  private showVtodoDetail(item: any): void {
    const settings = this.store.settings;
    const cal = findCalendarByUrl(settings, item.calendarUrl);
    const calName = cal?.displayName || item.calendarUrl || _t("未知日历");
    const statusText: Record<string, string> = {
      "needs-action": _t("未完成（未开始）"),
      "in-process": _t("进行中"),
      "completed": _t("已完成"),
    };
    const status = item.status ? (statusText[item.status] || item.status) : _t("未完成（未开始）");
    const dateCn = (stamp: string): string => (stamp ? `${stamp.slice(0, 4)}${_t("年")}${fmtDateCn(stamp)}` : _t("—"));
    const full = (stamp: string, allDay: boolean): string => {
      if (!stamp) return _t("—");
      const dp = dateCn(stamp);
      return allDay ? dp : `${dp} ${fmtTime(stamp)}`;
    };
    const esc = (t: string): string =>
      t.replace(/[&<>"']/g, (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<string, string>)[c]);
    const rows: [string, string][] = [
      ["日历名称", calName],
      ["待办名称", item.summary || _t("—")],
      ["开始日期", full(item.start, item.allDay)],
      ["结束日期", item.end ? full(item.end, item.allDay) : _t("无（仅开始日期）")],
      ["当前状态", status],
      ["UID", item.uid || _t("—")],
    ];
    const body = rows
      .map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
      .join("");
    newDialog({
      title: _t("对应 VTODO 详情"),
      content:
        `<style>.caldav-vtodo-detail{padding:4px 2px;font-size:14px}.caldav-vtodo-detail .row{display:flex;justify-content:space-between;gap:18px;padding:7px 2px;border-bottom:1px solid var(--b3-border-color)}.caldav-vtodo-detail .k{color:var(--b3-theme-on-surface-light);flex:0 0 auto}.caldav-vtodo-detail .v{text-align:right;word-break:break-all}.caldav-vtodo-detail .tip{margin-top:10px;font-size:12px;color:var(--b3-theme-on-surface-light);opacity:.7}</style>` +
        `<div class="caldav-vtodo-detail">${body}<div class="tip">${_t("数据来自上次同步后的本地缓存")}</div></div>`,
      width: "440px",
    });
  }

  /**
   * 块图标把手菜单入口（click-blockicon）：点块左侧图标把手（⋮⋮）弹出的菜单。
   * 该路径下插件**完全掌控 label**，故用一个名为「任务块 ⇄ VTODO」的子菜单收拢三态同步项，
   * 不再受思源内核对 open-menu-content 自动套的「插件」子菜单（其名不可改）限制。
   *
   * ⚠️ 全程同步 addItem，禁止在注入前 await（否则项丢失）。
   */
  /**
   * 把「任务块 ⇄ VTODO」同步子菜单注入到块菜单（右键 open-menu-content 与点 ⋮⋮ click-blockicon
   * 两种入口共用），并定位在「添加到数据库」(addToDatabase) 之前，与番茄钟同高。
   *
   * 为什么要「等 #commonMenu 挂载后再注入」(已读内核 + 番茄钟源码确认)：
   *   思源块菜单的 DOM 容器是 #commonMenu，但它在钩子执行瞬间常尚未挂载到 document
   *   （尤其是 click-blockicon 把手菜单）。旧版先往 window.siyuan.menus.menu.addItem 再加完用
   *   DOM 搬运，项会被加进游离/随后被内核替换的容器而丢失 —— 这正是把手菜单「时有时无」的根因。
   *   番茄钟的成熟做法是：等 #commonMenu 真正挂到 document 且稳定后，直接用 MenuItem 把项插入
   *   #commonMenu .b3-menu__items 容器 DOM，因此两种入口都稳定靠上且对齐番茄钟。
   */
  /**
   * 把菜单项同步加到「当前菜单实例」第一层（绕过思源内核把插件项收进写死「插件」子菜单的机制），
   * 并返回新建的菜单项 DOM 元素。
   *
   * 关键：直接用 window.siyuan.menus.menu.addItem —— 该实例就是块菜单的渲染源
   * （5efa636 版仅此一步即稳定显示，已验证可靠）。这样**保证项一定被渲染、绝不丢失**，
   * 不再依赖 window.siyuan.MenuItem（思源并未把它挂到 window.siyuan 上，依赖它会导致注入被整体跳过）。
   */
  private addFirstLevelMenuItem(item: any): HTMLElement | null {
    const main = (window as any)?.siyuan?.menus?.menu;
    if (!main || typeof main.addItem !== "function") return null;
    const el = main.addItem(item); // 内核 Menu.addItem 返回新建的 .b3-menu__item 元素
    return el && el.nodeType === 1 ? (el as HTMLElement) : null;
  }

  /**
   * 把刚加到菜单实例的项「抬高」到「添加到数据库」之前，与番茄钟同高。
   * 等 #commonMenu 真正挂到 document 后再用 DOM 移动（钩子同步期移动会被丢，
   * 尤其 click-blockicon 把手菜单）。本步骤失败/超时不影响显示——项已在 addFirstLevelMenuItem
   * 时落进当前菜单实例（第一层），一定会被渲染。
   */
  private liftToTopWhenReady(el: HTMLElement): void {
    if (!el || el.dataset.caldavLifted === "1") return;
    el.dataset.caldavLifted = "1"; // 防重复抬高
    const anchorSel = '#addToDatabase,[data-id="addToDatabase"]';
    const whenElementExist = (sel: string): Promise<HTMLElement | null> =>
      new Promise((resolve) => {
        let tries = 0;
        const tick = () => {
          const found = typeof document !== "undefined" ? (document.querySelector(sel) as HTMLElement | null) : null;
          if (found) return resolve(found);
          if (tries++ > 120) return resolve(null); // ~2s 超时兜底
          if (typeof window !== "undefined" && window.requestAnimationFrame) window.requestAnimationFrame(tick);
          else setTimeout(tick, 16);
        };
        tick();
      });
    void whenElementExist("#commonMenu .b3-menu__items").then((container) => {
      if (!container) return; // 超时：项已在菜单第一层，保留原位
      const anchor = container.querySelector(anchorSel) as HTMLElement | null;
      const anchorNode: Node | null = anchor && anchor.parentNode === container ? anchor : container.firstChild;
      container.insertBefore(el, anchorNode);
    });
  }

  private injectBlockSyncMenu(nodeId: string, el: HTMLElement, s: any): void {
    // 先把「任务块 ⇄ VTODO」子菜单同步加到当前菜单实例第一层（保证一定渲染、不丢项），
    // 再异步抬到「添加到数据库」之前与番茄钟同高。失败/超时仍保证显示。
    const item = {
      id: "caldavBlockSync",
      icon: "iconCalDavSync",
      label: _t("任务块 ⇄ VTODO"),
      type: "submenu",
      submenu: this.buildBlockSyncMenuItems(nodeId, el, s),
    };
    const added = this.addFirstLevelMenuItem(item);
    if (added) this.liftToTopWhenReady(added);
  }

  private onBlockIconMenu(e: any): void {
    try {
      const s = this.store.settings;
      if (!s.blockSyncEnabled) return;
      const detail = e?.detail;
      const el = this.resolveTaskNode(detail);
      if (!el) return;
      const nodeId = el.getAttribute("data-node-id") || "";
      if (!nodeId) return;
      // 与右键正文入口一致：同步加第一层 + 异步抬高（失败仍显示，不会丢项）。
      this.injectBlockSyncMenu(nodeId, el, s);
    } catch (err) {
      console.warn("[caldav] 块图标菜单钩子失败（已忽略）", err);
    }
  }

  /**
   * 移动端侧栏里，本插件 Dock 的容器元素。
   * 思源给每个插件 Dock 的内容容器打 `data-mobile-plugin-dock-content="<插件名+类型>"`
   * （见 app/src/mobile/util/initFramework.ts: syncMobilePluginDockElements）。
   * 只从 document 里找 —— 缓存的旧引用可能是已被换掉的游离节点。
   */
  private liveDockElement(): HTMLElement | null {
    const type = this.name + DOCK_TYPE;
    const nodes = document.querySelectorAll<HTMLElement>("[data-mobile-plugin-dock-content]");
    for (const node of Array.from(nodes)) {
      if (node.dataset.mobilePluginDockContent === type) return node;
    }
    return null;
  }

  /**
   * 把 Dock 面板挂到元素上（幂等）。
   *
   * 为什么不能像其他 disposable 一样只挂一次：思源移动端把插件的 MobileCustom
   * 缓存在模块级 Map 里（app/src/mobile/dock/pluginDockState.ts），首次激活调 init，
   * 之后每次激活**只调 update**，且从不重建。侧栏 DOM 一旦被重建，缓存的 custom
   * 仍指向游离的旧元素 —— 面板就永久空白了。所以以「当前活着的元素」为准。
   */
  private mountDock(el: HTMLElement | null | undefined): void {
    const target = this.liveDockElement() || el || null;
    if (!target) return;
    // 同一元素且面板还在：只刷新数据，保住搜索词与筛选状态
    if (this.dockMount?.el === target && target.querySelector(".caldav-dock-brand")) {
      this.dockMount.refresh();
      return;
    }
    this.unmountDock();
    const panel = renderDockPanel(target, {
      store: this.store,
      // 不传 mode 时用主窗口当前视图 —— Dock 的合并按钮（打开上次视图）走这条
      onNav: (m) => this.openPanelTab(m ?? this.mainCtx.viewMode),
      onSync: () => this.runSync(false),
      onSettings: () => this.openSetting(),
      viewMode: () => this.mainCtx.viewMode,
      onOpenEditor: (item) => openEditor(this.mainCtx, { item }),
      onToggleDone: (item) => toggleTodoDone(this.mainCtx, item)
    });
    this.dockMount = { el: target, refresh: panel.refresh, destroy: panel.destroy };
    this.markDockScrollHost(target);
  }

  /**
   * 向上找第一个「可滚动」祖先（思源给插件 Dock 内容套的容器），打标记让 CSS 接管
   * 它的滚动条样式（透明背景 + 悬停显形）。找不到就什么都不做，不影响功能。
   *
   * 两道护栏：只向上探 3 层，且遇到带 id 的元素（#sidebar / #layouts / #dockLeft…
   * 都是思源框架级容器）立刻停 —— 那些容器是多个插件共用的，改了滚动条会波及别人。
   */
  private markDockScrollHost(root: HTMLElement): void {
    let found: HTMLElement | null = null;
    try {
      let p: HTMLElement | null = root.parentElement;
      for (let i = 0; p && i < 3 && p !== document.body; i++) {
        if (p.id) break;
        const oy = getComputedStyle(p).overflowY;
        if (oy === "auto" || oy === "scroll") {
          found = p;
          break;
        }
        p = p.parentElement;
      }
    } catch {
      /* 测试环境没有 getComputedStyle：静默跳过，纯样式增强不影响功能 */
    }
    if (found === this.dockScrollHost) return;
    this.dockScrollHost?.classList.remove("caldav-scroll-host");
    this.dockScrollHost = found;
    found?.classList.add("caldav-scroll-host");
  }

  private unmountDock(): void {
    const mount = this.dockMount;
    this.dockMount = null;
    if (mount) {
      try {
        mount.destroy();
      } catch {
        /* 卸载阶段尽力而为 */
      }
    }
    this.dockScrollHost?.classList.remove("caldav-scroll-host");
    this.dockScrollHost = null;
  }

  /**
   * 移动端补挂：侧栏布局渲染（renderMobileSidePanelLayout）会挑一个 Dock 当当前项
   * 并显示它的容器，那条路径不调 init/update；用户若再点已激活的图标，思源的
   * click 处理也会直接 return（只对合成点击才调 updateDock）。
   * 所以自己做一层观察：容器出现且是空的，就补挂上面板，之后交给 update 维护。
   */
  private watchMobileDock(): void {
    if (!isMobile() || this.dockObserver) return;
    const tick = () => {
      const el = this.liveDockElement();
      if (el && !el.firstChild) this.mountDock(el);
    };
    const panels = ["#sidebar", "#sidebarRight"]
      .map((sel) => document.querySelector<HTMLElement>(sel))
      .filter((n): n is HTMLElement => Boolean(n));
    if (typeof MutationObserver === "function" && panels.length) {
      this.dockObserver = new MutationObserver(tick); // 侧栏 DOM 不常变，回调很轻
      panels.forEach((p) => this.dockObserver!.observe(p, { childList: true, subtree: true }));
    }
    // 首次补挂：容器此刻可能还没建出来，稍后再看两眼（观察器已能覆盖后续变化）
    setTimeout(tick, 400);
    setTimeout(tick, 1500);
  }

  /**
   * [SPIKE issue #5] 思源对「插件数据文件变更」的默认处理是 **重载整个插件**：
   * `shouldReloadOnDataChange = (p) => p.onDataChanged === Plugin.prototype.onDataChanged`，
   * 未覆写时 `runDataChange` 把任务提升为 reload → teardown → 调 `onunload()`。
   * 而本插件 `onunload()` 会 `closePanelTabs()`，把独立窗口里唯一的日历页签关掉，
   * 窗口无页签 → 思源自动关窗（issue #5 第二轮实测：日历显示一会儿后窗口自动消失）。
   *
   * 覆写后该分支只调用本钩子，不卸载、不销毁页签 → 独立窗口不再因数据变更被关。
   *
   * 关键点：覆写后思源不再替我们重载数据，所以本钩子必须**主动重新加载最新数据到内存**
   * 并刷新 UI。否则独立窗口 / 主窗口各自写盘后，对端内存仍是旧值，下次写盘会把对方刚落盘
   * 的改动覆盖掉 —— 等于「落盘了又丢」。这里只 `load()`（读盘）不 `save()`（写盘），
   * 因此不会形成「写 → 广播 → 写」的死循环（store.load 只读取内存，不触发 persist）。
   */
  /**
   * [SPIKE issue #5] 思源对「插件数据文件变更」的默认处理是 **重载整个插件**，会关掉
   * 独立窗口唯一的页签 → 独立窗口被思源自动关掉。覆写后只走本钩子，不卸载、不销毁页签。
   *
   * ⚠️ 但思源内置的 dataChange 广播在「另一 BrowserWindow（独立窗口）写入」场景下并不可靠，
   * 主窗口收不到这次通知 —— 所以独立窗口的改动在主窗口看不到，必须手动点同步才刷新。
   * 这里只是**兜底**路径；真正可靠的跨窗口通知由 `setupCrossWindowSync()` 用
   * BroadcastChannel + localStorage storage 事件补齐，两者都汇入 `reloadFromDisk()`。
   */
  onDataChanged(): void {
    void this.reloadFromDisk();
  }

  /**
   * 从磁盘重新载入内存数据并刷新所有面板。供「对端窗口改了数据」时调用（双通道都汇入这里）。
   * 用 `applyingRemote` 在 800ms 内抑制本窗口的 persist 广播，避免回环：
   * `store.load()` 末尾的 `adoptKeyring` 会排一个 persistSoon，那次写盘不应再广播出去。
   */
  private async reloadFromDisk(): Promise<boolean> {
    this.applyingRemote = true;
    let ok = false;
    try {
      await this.store.load();
      ok = true;
    } catch (e) {
      /* 读取失败不阻塞；绝不向上冒泡，否则可能重新触发思源的插件 teardown */
      console.warn("[caldav] 从磁盘重载失败（保留当前内存数据）", e);
    }
    this.refreshPanels();
    setTimeout(() => { this.applyingRemote = false; }, 800);
    // [L2] 乐观首帧的落盘锁只在真实数据就位后才解除，读盘失败时保持只读更安全。
    return ok;
  }

  /**
   * 落盘并广播给其它窗口。先写磁盘（env.saveData）再广播，保证对端读到的是最新文件。
   * 仅在非「应用对端变更」期间才广播，避免回环。双通道：
   * BroadcastChannel（现代标准）+ localStorage storage 事件（Electron 跨窗口兜底）。
   */
  private async saveDataAndNotify(file: string, data: unknown): Promise<void> {
    await this.saveData(file, data);
    if (!this.applyingRemote) this.bumpCrossWindow();
  }

  /** 把「本窗口落盘」广播出去（双通道；各自独立兜底，互不依赖） */
  private bumpCrossWindow(): void {
    if (this.bc) {
      try { this.bc.postMessage({ t: "data" }); } catch { /* 忽略 */ }
    }
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        localStorage.setItem("siyuan-caldav-sync-bump", String(Date.now()));
      }
    } catch { /* localStorage 不可用：忽略，仍走 BroadcastChannel */ }
  }

  /**
   * 建立跨窗口数据变更通知：独立窗口 ↔ 主窗口双向。任一窗口落盘后，其它窗口即时
   * 重新从磁盘载入并刷新，于是「独立窗口改了待办/设置」能立刻反映到主窗口日历，
   * 不必再手动点同步。
   *
   * 双通道都汇入 `reloadFromDisk()`：
   * - BroadcastChannel：现代标准，同源 Electron 窗口之间可直达；
   * - localStorage `storage` 事件：Electron 跨窗口的可靠兜底（同一 origin 共享 localStorage，
   *   写入方不会收到自己的 storage 事件，天然不回环）。
   *
   * 不可用时（老内核 / 测试环境无 BroadcastChannel、无 localStorage）静默降级，不影响主流程。
   */
  private setupCrossWindowSync(): void {
    // 用 `window.BroadcastChannel` 而非裸全局 BroadcastChannel：在 Node 测试环境（jsdom）
    // 里裸全局 BroadcastChannel 是 libuv 长生命周期句柄，会阻止事件循环退出、让测试挂起；
    // 而真正的浏览器/Electron 渲染进程用 window.BroadcastChannel，页面关闭即释放，无需手动 unref。
    try {
      if (typeof window !== "undefined" && typeof window.BroadcastChannel === "function") {
        this.bc = new window.BroadcastChannel("siyuan-caldav-sync-data");
        this.bc.onmessage = (ev: MessageEvent) => this.onCrossWindowMessage(ev);
      }
    } catch {
      this.bc = null;
    }
    try {
      if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("storage", (e: StorageEvent) => {
          if (e.key === "siyuan-caldav-sync-bump") void this.reloadFromDisk();
        });
      }
    } catch { /* 忽略 */ }
  }

  /**
   * 跨窗口消息分发（BroadcastChannel）：
   * - `{t:"data"}`：对端落盘 → 重载内存并刷新（= reloadFromDisk）
   * - `{t:"ping"}`：主窗口探活 → 仅独立窗口回 `{t:"pong"}`（自身不会收到自己发的 ping）
   * - `{t:"pong"}`：独立窗口存活应答 → 解除 openCalendarWindow 的探活等待
   */
  private onCrossWindowMessage(ev: MessageEvent): void {
    let msg: { t?: string } | null = null;
    try { msg = ev && ev.data ? (ev.data as { t?: string }) : null; } catch { msg = null; }
    if (!msg || typeof msg.t !== "string") return;
    if (msg.t === "data") {
      void this.reloadFromDisk();
    } else if (msg.t === "ping") {
      // 只有真正存活的独立窗口才应答；主窗口发的 ping 自己收不到（发送方排除），不会自答。
      if (this.isSecondaryWindow) {
        try { this.bc?.postMessage({ t: "pong" }); } catch { /* 忽略 */ }
      }
    } else if (msg.t === "pong") {
      if (this.pendingWinAlive) {
        const r = this.pendingWinAlive;
        this.pendingWinAlive = null;
        r(true);
      }
    }
  }

  /**
   * 探活：发 ping，等至多 ~350ms 的 pong。收到 pong → 确有存活的独立窗口；超时/无 BC → 无。
   * 发送方不会收到自己发的 ping（BroadcastChannel 规范），故主窗口不会自答、独立窗口会应答。
   */
  private winAliveCheck(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (!this.bc) { resolve(false); return; }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pendingWinAlive = null;
        resolve(false);
      }, 350);
      this.pendingWinAlive = (alive: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingWinAlive = null;
        resolve(alive);
      };
      try { this.bc.postMessage({ t: "ping" }); } catch {
        settled = true;
        clearTimeout(timer);
        this.pendingWinAlive = null;
        resolve(false);
      }
    });
  }

  /** 独立窗口单例辅助：以 localStorage 标记跨窗口共享「独立窗口存在态」 */
  private secondaryWindowOpen(): boolean {
    try {
      if (typeof localStorage === "undefined" || !localStorage) return false;
      return localStorage.getItem(SECONDARY_WIN_KEY) === "1";
    } catch {
      return false;
    }
  }
  private markSecondaryWindowOpen(): void {
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        localStorage.setItem(SECONDARY_WIN_KEY, "1");
      }
    } catch { /* 忽略 */ }
  }
  private clearSecondaryWindowOpen(): void {
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        localStorage.removeItem(SECONDARY_WIN_KEY);
      }
    } catch { /* 忽略 */ }
  }

  onunload(): void {
    // 先关掉跨窗口通知通道，避免泄漏/残留句柄
    try { this.bc?.close(); } catch { /* 忽略 */ }
    this.bc = null;
    // 先关掉本插件打开的自定义页签：思源只会摘掉自己接管的注册项（Dock / 顶栏 / 工具栏），
    // 页签不管，不关就会在主窗口留一个空白「日历」页签，还会被写进 conf，重启后依然在。
    // [SPIKE issue #5] 独立窗口里这个页签就是窗口唯一内容，关掉它思源会直接关窗；
    // 禁用/卸载时由思源关窗顺带清理即可，别自己动手。
    if (!this.isSecondaryWindow) {
      this.closePanelTabs();
    } else {
      // 独立窗口关闭：清掉单例标记，否则主窗口热键会误以为窗口还开着、不再新建
      this.clearSecondaryWindowOpen();
    }
    this.sync.stopAutoSync();
    this.reminder?.stop();
    this.reminder = undefined;
    // 侧栏观察器与 Dock 面板一并收掉（思源只摘自己接管的注册项，容器元素不动）
    this.dockObserver?.disconnect();
    this.dockObserver = null;
    this.unmountDock();
    // 收起未到点的稍后提醒与残留的提醒卡片
    for (const t of this.snoozeTimers) clearTimeout(t);
    this.snoozeTimers.clear();
    clearReminderToasts();
    // 移动端全屏面板先收起（含上一版代码可能遗留、不在账上的层），避免插件卸载后残留
    const mobile = this.mobilePanel;
    this.mobilePanel = null;
    this.tabPanel = null;
    try {
      mobile?.dispose();
    } catch {
      /* 忽略 */
    }
    closeAllMobileLayers();
    for (const d of this.disposers.values()) d();
    this.disposers.clear();
    if (this.viewChangeHandler) {
      document.removeEventListener(VIEW_CHANGE_EVENT, this.viewChangeHandler);
      this.viewChangeHandler = null;
    }
    // 档2·内核后端：清掉去抖计时器并解绑拉数据请求
    if (this.reminderPushTimer) {
      clearTimeout(this.reminderPushTimer);
      this.reminderPushTimer = null;
    }
    try {
      this.kernel.rpc.unbind(CalDavPlugin.KERNEL_RPC_REQUEST, this.kernelRequestHandler);
    } catch {
      /* 忽略 */
    }
    this.tabPanel = null;
  }

  /**
   * 从工作空间移除插件时的清理。
   * 思源保证 `uninstall` 在 `onunload` 之后运行一次，两条路径都可能留下页签，再兜一次。
   */
  uninstall(): void {
    this.closePanelTabs();
  }

  /**
   * 关闭本插件在主窗口打开的自定义页签。
   *
   * 思源在禁用/卸载插件时不会关闭已打开的自定义页签 —— 于是主窗口残留一个空白
   * 「日历」页签，且 `saveLayout` 已把它写进 conf，重启后依旧在。
   * 这里走 `Tab.close()`（内部 `parent.removeTab`），顺带让思源重存布局把这条抹掉。
   * 拆除阶段总预算只有 5 秒且同步 JS 不可中断，所以必须同步做完。
   */
  private closePanelTabs(): void {
    const tabs: Tab[] = [];
    // ① 官方接口：本插件注册过的自定义页签实例（Custom.tab 即页签本体）
    try {
      const opened = this.getOpenedTab?.();
      if (opened) {
        for (const models of Object.values(opened)) {
          for (const model of models || []) {
            if (model?.tab) tabs.push(model.tab);
          }
        }
      }
    } catch (e) {
      console.warn("[caldav] getOpenedTab 失败", e);
    }
    // ② 兜底：openTab 返回的实例（getOpenedTab 缺失或布局尚未就绪时）
    if (!tabs.length && this.tab) tabs.push(this.tab);
    for (const tab of tabs) {
      try {
        tab.close();
      } catch (e) {
        console.warn("[caldav] 关闭日历页签失败", e);
      }
    }
    this.tab = null;
  }

  /**
   * [SPIKE issue #5] 把日历面板挂到自定义页签容器。
   * 抽成方法是为了让「立即挂载」与「独立窗口里 onload 就绪后补挂载」共用同一条路径，
   * 并补齐 disposers 记账，避免新窗口页签关闭时残留监听。
   */
  private mountTabPanel(el: HTMLElement): void {
    if (!el || !this.mainCtx || this.disposers.has("tab")) return;
    const panel = renderPanel(el, this.mainCtx);
    this.tabPanel = panel;
    this.disposers.set("tab", () => {
      panel.destroy();
      this.tabPanel = null;
    });
    notifyViewChange(this.mainCtx.viewMode);
  }

  /**
   * 打开日历面板：
   *  - 桌面端 → 主窗口页签；同一 id 的 custom 页签思源会自动聚焦已存在的实例（不再新建）
   *  - 移动端 → 全屏 Dialog（见 openMobilePanel）
   */
  openPanelTab(mode?: ViewMode): void {
    if (mode) {
      this.mainCtx.viewMode = mode;
      notifyViewChange(mode);
      // 刷新旧面板只是顺带：它可能已经销毁（引用还在），一旦抛错就会把下面的
      // 「打开面板」整段吞掉 —— 那也是「点了入口没反应」的一种成因。这里兜住。
      try {
        this.tabPanel?.refresh();
      } catch (e) {
        console.warn("[caldav] 刷新面板失败（已忽略）", e);
      }
    }
    if (isMobile()) {
      this.openMobilePanel();
      return;
    }
    // 页签是单例、标题要跟内容一致。没传 mode 时（命令面板的「打开日历与任务」）
    // 按 mainCtx 里当前生效的视图定标题 —— 面板渲染的就是那个视图。
    const effective = mode ?? this.mainCtx.viewMode;
    const title = effective === "task" ? _t("任务") : _t("日历");
    const tabPromise = openTab({
      app: this.app,
      custom: {
        icon: "iconCalDavSync",
        title,
        // 注意：data 会被 SiYuan 序列化进布局，必须可 JSON 序列化；
        // 插件实例（含 app/store/循环引用）不可放入，改用闭包 self 访问。
        data: { type: TAB_TYPE },
        id: this.name + TAB_TYPE
      },
      keepCursor: false
    });
    if (tabPromise && typeof tabPromise.then === "function") {
      void tabPromise.then((tab) => {
        this.tab = tab;
        tab.updateTitle(title);
      });
    }
  }

  /**
   * [SPIKE issue #5] 把日历页签弹成**独立窗口** —— 只验证「全局热键 → 独立窗口」闭环，
   * 验证通过后再正式产品化（单例复用 / 视图同步 / 尺寸与热键可配等）。
   *
   * 机制（均已对思源内核源码核实，勿凭印象改）：
   *  1. `openWindow` 只接受 `openTab()` 返回的**已存在 Tab 实例**，故必须先 openTab、
   *     在其 Promise 回调里再 openWindow。内部会把该页签 `layoutToJSON` 序列化，
   *     交给主进程开一个新的 `window.html` 窗口加载这份布局，并 `removeTab` 原页签。
   *  2. 全局快捷键由 `addCommand` 的 `globalCallback` 触发系统级 `globalShortcut`，
   *     焦点不在应用内（含窗口最小化/后台）时也能调到本方法。
   *  3. 复用现有 `TAB_TYPE`：新窗口重建页签时，插件会重新 onload → addTab 重新注册
   *     → 自定义页签 init 重跑 → renderPanel 重绘。**新窗口能否正确重建插件自定义
   *     页签，是本 spike 要实机验证的最大未知点**；复用类型正是为了顺带验证它。
   *  4. 移动端 `openWindow`/`openTab` 是空实现（plugin/API.ts 里 TODO），故桌面端限定。
   *
   * 阶段说明：spike 阶段刻意不做单例/热键可配/尺寸记忆，也不新增页签类型或字典文案，
   * 保持改动面最小、可随时回退。
   */
  private async openCalendarWindow(): Promise<void> {
    // 移动端 openWindow 为空实现，且无系统级全局快捷键；不参与本次闭环验证。
    if (isMobile()) return;
    // 单例（存活感知）：用 BroadcastChannel ping/pong 探活，避免「窗口崩溃/空白/未按 onunload
    // 退出」残留的 localStorage 标记把主窗口热键永久锁死。真有存活窗口会回 pong；探不到就当
    // 没开，清掉陈旧标记并重开。openingWindow 防连按重复开。
    if (this.openingWindow) return;
    this.openingWindow = true;
    try {
      // 快速路径（提速核心）：localStorage 标记不存在 = 绝大多数「无独立窗口」场景 → 不必等
      // BC 探活的 350ms 超时，立即开窗口。BC 探活（winAliveCheck）只用于发现「窗口崩溃却没走
      // onunload、残留陈旧标记」的稀有态，那种才走慢路径。即便快速路径偶发误判，同 id 的
      // openTab 在窗口已存活时也会自动聚焦既有实例、不会新建重复窗口，故安全。
      if (!this.secondaryWindowOpen()) {
        this.openCalendarTabAndWindow();
        return;
      }
      const alive = await this.winAliveCheck();
      if (alive) return; // 确有存活的独立窗口，不重复开
      this.clearSecondaryWindowOpen(); // 探活失败 → 标记必陈旧，清掉
      this.openCalendarTabAndWindow();
    } finally {
      this.openingWindow = false;
    }
  }

  /**
   * openTab（同 id 聚焦既有实例）→ openWindow 整体搬到独立窗口。
   * 抽出来供「快速路径 / 探活慢路径」两条分支共用，避免重复。
   */
  private openCalendarTabAndWindow(): void {
    const effective = this.mainCtx.viewMode;
    const title = effective === "task" ? _t("任务") : _t("日历");
    const tabPromise = openTab({
      app: this.app,
      custom: {
        icon: "iconCalDavSync",
        title,
        // 同 id（与主窗口 openPanelTab 一致）：思源对同 id 的 custom 页签会聚焦已存在实例，
        // openWindow 随后把它整体「搬」到独立窗口。元素一路 isConnected=true → 渲染稳定，
        // 不会出现不同 id 新建实例迁移时页签空白的坑（第五~七轮反复踩过）。代价是打开独立
        // 窗口时主窗口那个月历 tab 被搬走（关掉），但可重新打开，雄哥确认可接受。
        data: { type: TAB_TYPE },
        id: this.name + TAB_TYPE
      },
      keepCursor: false
    });
    void Promise.resolve(tabPromise).then((tab) => {
      if (!tab) return; // 某些版本/移动端 openTab 返回空，静默跳过
      try {
        openWindow({
          tab,
          alwaysOnTop: true,
          width: 1000,
          height: 700
        });
      } catch (e) {
        // 弹窗失败不能影响其他提醒/命令，只记日志
        console.warn("[caldav][spike] openWindow 失败", e);
      }
    }).catch((e) => {
      console.warn("[caldav][spike] openTab 失败", e);
    });
  }

  /**
   * 移动端承载：思源的 addTab / openTab 在移动端是空实现
   * （app/src/plugin/API.ts 里 `openTab = () => {}`），移动端也没有页签栏，
   * 所以改用全屏 Dialog 承载同一套 renderPanel —— mainCtx / store / sync 全部复用，
   * 不重复实例化；关掉弹层即释放。
   */
  private openMobilePanel(): void {
    const cur = this.mobilePanel;
    if (cur) {
      // 只有「确认还看得见」才复用。引用不新鲜（正在销毁 / 已被摘出 DOM / 被藏起来）
      // 一律摘掉重开 —— 否则就是「点了入口什么都不出来」，而且此后每次都这样。
      if (!isDialogAlive(cur.dialog)) {
        this.detachMobilePanel(cur.dialog);
        try {
          cur.dialog.destroy(); // 幂等：已销毁过则内部直接返回
        } catch {
          /* 元素可能已被移除，忽略 */
        }
      } else {
        // 已有页面层：复用，不再新建 —— 既保证「连点几个入口只有一层」，
        // 也消掉开合时的闪动（切视图只是重画，不换弹层）。
        // 顺手再扫一遍 DOM 收掉不在账上的残留层：覆盖安装/热更新留下的旧页面
        // 往往压在当前页**下面**，只会让它多按几次「关闭」才退得回去。
        adoptMobileLayer(cur.dialog, "page");
        return;
      }
    }
    // 显式标注类型：destroyCallback 里要引用 dialog 自身，交给推断会绕成循环
    const dialog: Dialog = newDialog({
      title: this.mobileTitle(),
      content: `<div class="caldav-mobile-host"></div>`,
      containerClassName: "caldav-mobile-dialog",
      width: "100vw",
      height: "100vh",
      destroyCallback: () => {
        this.detachMobilePanel(dialog);
      }
    });
    // 「页面」层：登记时收掉先前所有层（含编辑弹窗与历史残留层），
    // 见 ui/mobile-layers.ts —— 那里以 DOM 为准，能收到不在账上的层。
    adoptMobileLayer(dialog, "page");
    const host = dialog.element.querySelector(".caldav-mobile-host") as HTMLElement | null;
    if (!host) return;
    const panel = renderPanel(host, this.mainCtx);
    this.mobilePanel = { dialog, panel, dispose: () => panel.destroy() };
    this.tabPanel = panel;
    notifyViewChange(this.mainCtx.viewMode);
  }

  /**
   * 摘掉移动端页面层的引用，并释放其中的面板。
   *
   * 必须是**按实例自证身份**的：思源的 destroyCallback 是异步的（先淡出，一个 timeout
   * 之后才移除元素并回调），这期间用户完全可能已经开了新的页面层。旧层若照着
   * `this.mobilePanel = null` 一路清下去，就会把新层的引用抹掉 —— 守卫随之失效，
   * 之后每点一次入口都新建一层（满屏叠层），每次开合还闪一下。
   */
  private detachMobilePanel(dialog: Dialog): void {
    const cur = this.mobilePanel;
    if (!cur || cur.dialog !== dialog) return;
    this.mobilePanel = null;
    this.tabPanel = null;
    try {
      cur.dispose();
    } catch {
      /* 忽略 */
    }
  }

  /** 收起移动端全屏页面层（面板与弹层一起收），供需要让位的场景调用（如打开日记文档） */
  private closeMobilePanel(): void {
    const cur = this.mobilePanel;
    if (!cur) return;
    this.mobilePanel = null;
    this.tabPanel = null;
    try {
      cur.dispose();
    } catch {
      /* 忽略 */
    }
    // 关键：不能只调 destroy()。思源销毁弹层是「先摘 b3-dialog--open 让遮罩与容器
    // 淡出，一个 timeout 后才移除元素」，而 .b3-dialog 本身是 position:fixed 铺满全屏 ——
    // 那段时间它看不见却照样吃点击。扫层会先 display:none 再销毁，一步到位。
    closeAllMobileLayers();
  }

  private mobileTitle(): string {
    return this.mainCtx.viewMode === "task" ? _t("任务") : _t("日历");
  }

  /** 打开 Dock 面板（聚焦已开面板） */
  openDockPanel(): void {
    document.querySelector(`[data-type="${DOCK_TYPE}"]`)?.dispatchEvent(new MouseEvent("click"));
  }

  /**
   * 取思源 conf 里的设备/工作空间标识，作为凭据加密的密钥来源。
   * conf 不参与云同步，且与插件 iframe 端口无关，因此换端口/重启都不会导致密码解不开。
   */
  private async ensureSecretSeed(): Promise<void> {
    // 非浏览器环境（单元测试）没有可用的同源根，直接跳过，走兼容密钥
    if (typeof location === "undefined" || !location.origin) return;
    try {
      const res = await fetch(location.origin + "/api/system/getConf", { method: "POST" });
      const j: any = await res.json();
      const conf = j?.data?.conf || j?.data || {};
      const id = conf?.system?.id || "";
      const ws = conf?.system?.workspaceDir || "";
      if (id) {
        setSecretSeed(`${id}|${ws}`);
      } else {
        console.warn("[caldav] 未取到设备标识，凭据将使用兼容密钥");
      }
    } catch (e) {
      console.warn("[caldav] 读取设备标识失败，凭据将使用兼容密钥:", e);
    }
  }

  /** v2 旧密文依赖设备标识；迟到时补算一次并重试解密（不影响 v3 密文） */
  private async retrySecretUnlock(): Promise<void> {
    try {
      if (!this.store.pendingUnlock) return;
      await this.ensureSecretSeed();
      await this.store.retryUnlock();
    } catch (e) {
      console.warn("[caldav] 重试解密失败:", e);
    }
  }

  /**
   * 读取插件数据：新文件名优先；读不到再回退历史文件名，并做一次**无损迁移**。
   *
   * 三条铁律（和数据/密码处理同一套思路：宁可响亮失败，绝不静默变空）：
   *   1. 「读到空」= 文件不存在，可以回退旧名；**「读出错」不吞异常** ——
   *      读新文件报错时若当成「不存在」，就会拿旧文件的数据把用户较新的数据覆盖掉，
   *      还会顺手把好文件删了。这种情况让它抛出去（启动即报错，用户能看见、文件不动）。
   *   2. 迁移顺序不可颠倒：**先写新文件、确认成功，再删旧文件**。反过来一旦写失败
   *      （磁盘满 / 内核忙 / 进程被杀），数据就新旧两处皆无 → 用户看到「设置和任务全空」。
   *   3. 写失败时保留旧文件、把老数据交给内存，本次会话照常可用，下次启动再试。
   *
   * 迁移每台设备只跑一次（跑完新文件就存在了），不会每次启动都探测一遍旧名。
   */
  private async loadPluginData(): Promise<any> {
    const fresh = await this.loadData(DATA_FILE);
    if (fresh) return fresh;

    const legacy = await this.loadData(LEGACY_DATA_FILE);
    if (!legacy) {
      // 全新安装：没有可迁移的数据，顺手清掉更早期原型留下的空壳文件
      await this.removeDataSafe([...STALE_DATA_FILES]);
      return undefined;
    }

    try {
      await this.saveData(DATA_FILE, legacy);
    } catch (e) {
      console.warn(`[caldav] ${_t("数据迁移到")} ${DATA_FILE} ${_t("失败，保留旧文件")} ${LEGACY_DATA_FILE}${_t("，本次仍用旧数据")}`, e);
      return legacy;
    }
    console.info(`[caldav] ${_t("数据文件已迁移：")}${LEGACY_DATA_FILE} → ${DATA_FILE}`);
    // 新文件已落地，旧文件与空壳都可以收了（删不掉也无所谓，下次启动再清）
    await this.removeDataSafe([LEGACY_DATA_FILE, ...STALE_DATA_FILES]);
    return legacy;
  }

  /** 删数据文件：尽力而为，文件不存在或内核拒绝都无所谓，绝不能影响启动 */
  private async removeDataSafe(names: string[]): Promise<void> {
    for (const name of names) {
      try {
        await this.removeData(name);
      } catch {
        /* 不存在 / 无权限 / 内核未实现：忽略 */
      }
    }
  }

  private createCtx(): PanelCtx {
    const self = this;
    return {
      store: this.store,
      sync: this.sync,
      i18n: (k) => (this.i18n as any)?.[k] || k,
      // ⚠️ 必须把 range / target 都透传下去 —— 写成
      // `() => this.insertTodayToDiary()` 会**吞掉选择**，永远走默认「当日 + 今天」。
      // 症状：选了「本周」却提示「当日没有日程或待办」（Obsidian 侧 2026-10-07 实测踩过）。
      insertTodayToDiary: (range, target) => this.insertTodayToDiary(range, target),
      unsaved: new Set(),
      // 恢复上次用的视图：Dock 的合并按钮点下去打开的就是它（见 lastViewMode 注释）
      viewMode: this.lastViewMode,
      // 「列表」正交开关（2026-10-25 方案 A）：默认关 —— 列表是**呈现方式**，
      // 不是第五种时间段，记住它会让下次打开面板时用户摸不着头脑（怎么没有月历了？）
      listMode: false,
      cursor: todayStamp(),
      sortMode: "start",
      testReminder: () => this.testReminder(),
      refreshPanels: () => this.refreshPanels(),
      reminderStatus: () => this.reminderStatus(),
      // 工具栏同步按钮（2026-10-09）：走 runSync，提示/重绘/重排提醒统一在入口做
      syncNow: () => this.runSync(true),
      // 文档任务块（issue #2）：设置页要用 —— 列笔记本、立即扫描、一键清理
      listNotebooks: () => listNotebooks(this.kernelCaller()),
      scanBlocksNow: () => this.scanBlocksNow(),
      clearBlockItems: () => this.clearBlockItems(),
      // 文档任务块：编辑弹窗「文档任务块信息」页签（只读显示笔记本 / 文档 / 块名 / 块 ID）
      blockDetail: (id) => getBlockDetail(this.kernelCaller(), id),
      // 档2·内核后端：把 `this.kernel` 以 getter 实时透传到上下文。
      // 必须用 getter（读 self.kernel 而非捕获 onload 时的值）——内核连接成功前 this.kernel 是 null，
      // 若直接写 `kernel: this.kernel` 会永远停在 null。设置页「测试 Webhook」与保存后推快照都依赖它。
      get kernel() {
        return self.kernel;
      },
      // 设置保存后由设置页调用，让内核立即拿到新设置重排程（见 settings-dialog bindSave）。
      pushReminderSnapshot: () => self.pushReminderSnapshot()
    };
  }

  /**
   * 执行一次同步。
   *
   * 已有同步在跑时**排队等它跑完**再跑一轮，而不是直接返回：静默丢弃的代价很实在
   * ——「命令面板点同步」与「自动同步」撞车时，用户看着像点了没反应。
   */
  async runSync(manual: boolean): Promise<unknown> {
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* 上一轮的结果与本次无关，忽略 */
      }
    }
    const task = this.doRunSync(manual);
    this.inflight = task;
    try {
      return await task;
    } finally {
      if (this.inflight === task) this.inflight = null;
    }
  }

  private async doRunSync(manual: boolean): Promise<unknown> {
    try {
      const report = await this.sync.syncAll();
      this.refreshPanels();
      this.reminder?.reschedule();
      // 文档任务块对账（issue #2）：拉取完成后跑，保证「服务端完成态」是最新的。
      // 单独兜错：块同步出错不能把整轮同步的成果报成失败。
      // ⚠️ 受两个开关 gate：手动同步走 onManualSync，非手动（启动扫）走 onStartup；
      // 二者互不重叠，各自独立。「立即扫描」按钮与块菜单单笔不走这里、不受 gate。
      const wantBlock =
        manual
          ? this.store.settings.blockSyncOnManualSync !== false
          : this.store.settings.blockSyncOnStartup !== false;
      try {
        const blk = wantBlock ? await this.blockSyncPass() : undefined;
        if (blk?.text && manual) this.notify(blk.text, "info");
        if (blk?.text) this.refreshPanels();
      } catch (e) {
        console.warn("[caldav] 文档任务块对账失败（已忽略）", e);
      }
      if (manual) {
        // 冲突策略已下沉到账户；提示只做概括文案，取第一个启用账户的口径
        const strategyLabel = enabledAccounts(this.store.settings)[0]?.conflict === "local" ? _t("本地优先") : _t("服务端优先");
        if (report.errors.length > 0) {
          this.notify(`${_t("同步完成，但有")} ${report.errors.length} ${_t("处出错：")}${report.errors[0] ?? ""}`, "error");
        } else if (report.conflicts.length > 0) {
          this.notify(
            `${_t("同步完成，但有")} ${report.conflicts.length} ${_t("处冲突（按「")}${strategyLabel}${_t("」策略处理）：")}${report.conflicts[0] ?? ""}`,
            "info"
          );
        } else {
          this.notify(
            `${_t("同步完成：拉取")} ${report.fetched} ${_t("条，上传")} ${report.uploaded} ${_t("条，删除")} ${report.deleted} ${_t("条（")}${report.elapsedMs}ms${_t("）")}`
          );
        }
      }
      return report;
    } catch (e) {
      this.notify(`${_t("同步失败：")}${String((e as Error)?.message || e)}`, "error");
      return undefined;
    }
  }

  // ── 文档任务块 ⇄ VTODO（issue #2，2026-10-28）──
  //
  // 总开关 blockSyncEnabled 没打开就**完全不启用**：不自动扫描、块菜单不挂入口、
  // 不做状态同步，「立即扫描」按钮也只提示「功能未启用」。

  /** 内核调用器：core 层的块读写通过它打进来（本文件是唯一持内核入口的地方） */
  private kernelCaller(): KernelCaller {
    return (url, body) => this.kernelEnvelope(url, body);
  }

  /**
   * 内核接口：返回**完整响应信封** `{code,msg,data,limit,truncated}`。
   *
   * 与 kernelData 的区别：后者只取 `data`，把 `truncated` 丢了。
   * 而 `truncated` 恰恰是「扫描结果有没有被内核截断」的唯一信号 ——
   * 内核 SQL 接口**没写 LIMIT 时只回 64 行**，超出的行静默丢弃；
   * 任务块扫描一旦被截断，就不能推进增量水位线（没扫全，推了就永久漏块）。
   */
  private async kernelEnvelope(url: string, body: unknown): Promise<any> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return await res.json();
    } catch (e) {
      console.warn("[caldav] 内核接口调用失败:", url, e);
      return undefined;
    }
  }

  /**
   * 当前打开着的文档 ID（范围 =「打开的文档」时用）。
   * 从 siyuan 布局树里收集 docId，桌面端与移动端两套布局都走一遍；
   * 拿不到就返回空数组 —— 空数组的含义是「没有打开的文档」，扫描结果为空，
   * **绝不退化成全库**（那是另一种语义，静默扩大范围会吓到人）。
   */
  private openDocIds(): string[] {
    const ids = new Set<string>();
    const walk = (n: any): void => {
      if (!n || typeof n !== "object") return;
      if (typeof n.docId === "string" && n.docId) ids.add(n.docId);
      if (Array.isArray(n.children)) for (const c of n.children) walk(c);
    };
    try {
      const g = globalThis as any;
      walk(g?.siyuan?.layouts);
      walk(g?.siyuan?.mobile?.layouts);
    } catch {
      /* 布局还没就绪：返回空数组即可 */
    }
    return Array.from(ids);
  }

  /** 跑一遍块对账（同步周期末尾 / 设置区「立即扫描」/ 块菜单「扫描任务块」共用）。
   *  @param docIds 限定只扫这些文档（按 root_id）。传入时范围只收口到这些文档。
   *  @param opts.full 强制全量扫描（手动「扫描全部」/「立即扫描」用；其余按增量 + 安全网）。 */
  private async blockSyncPass(docIds?: string[], opts?: { full?: boolean }): Promise<{ text: string } | undefined> {
    if (!this.store.settings.blockSyncEnabled) return undefined;
    const res = await runBlockSync({
      store: this.store,
      sync: this.sync,
      caller: this.kernelCaller(),
      openDocIds: () => this.openDocIds(),
      docIds,
      full: opts?.full,
      // 改动数量告警：超过设置里的「一次同步改动数量告警值」先弹窗让用户确认
      confirm: (info) => confirmBlockChanges(info)
    });
    if (res.cancelled) return { text: res.message || _t("已取消本轮任务块同步") };
    if (!res.scanned && !res.created && !res.updated && !res.written && !res.deleted) {
      return res.errors.length ? { text: res.errors[0] } : undefined;
    }
    const mode = res.mode === "incremental" ? _t("增量") : _t("全量");
    const parts = [`${_t("扫到")} ${res.scanned} ${_t("个任务块（")}${mode}${_t("）")}`];
    if (res.created) parts.push(`${_t("新建")} ${res.created}`);
    if (res.updated) parts.push(`${_t("更新")} ${res.updated}`);
    if (res.written) parts.push(`${_t("回写")} ${res.written}`);
    if (res.deleted) parts.push(`${_t("删除")} ${res.deleted}`);
    const text = `${_t("文档任务块同步：")}${parts.join(_t("，"))}` + (res.errors.length ? `${_t("（")}${res.errors.length} ${_t("处出错：")}${res.errors[0]}${_t("）")}` : "");
    return { text };
  }

  /** 设置区「立即扫描」按钮（用户主动要求「扫一遍」→ 走全量，不受增量水位线限制） */
  private async scanBlocksNow(): Promise<string> {
    if (!this.store.settings.blockSyncEnabled) return _t("文档任务块识别与映射未启用（先在上方打开开关）");
    const r = await this.blockSyncPass(undefined, { full: true });
    this.refreshPanels();
    return r?.text || _t("扫描完成，没有需要同步的任务块");
  }

  /** 设置区「一键清理」：删掉全部块来源 VTODO（文档里的块不动） */
  private async clearBlockItems(): Promise<string> {
    const res = await clearBlockSync({
      store: this.store,
      sync: this.sync,
      caller: this.kernelCaller()
    });
    this.refreshPanels();
    if (res.errors.length) return `${_t("清理完成")} ${res.deleted} ${_t("条，")}${res.errors.length} ${_t("处出错：")}${res.errors[0]}`;
    return res.deleted ? `${_t("已清理")} ${res.deleted} ${_t("条文档任务块转来的待办")}` : _t("没有可清理的条目");
  }

  /**
   * 文档 tab 真正关闭时：扫描**该文档**的任务块（受 onDocClose + 总开关 gate）。
   * 从 protyle 取出文档 root ID，按文档收口扫描 —— 这样即便范围设的是「打开的文档」，
   * 刚关掉的文档也能被扫到（否则它已不在 open 集合里，删除会漏检）。
   */
  private onDocClose(e: any): void {
    try {
      const s = this.store.settings;
      if (!s.blockSyncEnabled || !s.blockSyncOnDocClose) return;
      const docId = docIdOf(e?.detail?.protyle);
      if (!docId) return;
      void this.blockSyncPass([docId])
        .then((r) => {
          if (r?.text) this.refreshPanels();
        })
        .catch((err) => console.warn("[caldav] 关闭文档时扫描任务块失败（已忽略）", err));
    } catch (err) {
      console.warn("[caldav] 关闭文档事件处理失败（已忽略）", err);
    }
  }

  /** 块菜单「扫描任务块（当前文档）」：从点击的块反推所属文档，按该文档收口扫描 */
  private async scanBlockDoc(nodeId: string): Promise<void> {
    const s = this.store.settings;
    if (!s.blockSyncEnabled) return;
    const rootId = await getBlockRootId(this.kernelCaller(), nodeId);
    if (!rootId) {
      showMessage(_t("没读到这个任务块所属的文档（可能已被删除）"), 4000);
      return;
    }
    try {
      const r = await this.blockSyncPass([rootId]);
      this.refreshPanels();
      showMessage(r?.text || _t("已扫描当前文档的任务块"), 4000, "info");
    } catch (err) {
      showMessage(`${_t("扫描失败：")}${String((err as Error)?.message || err)}`, 6000);
    }
  }

  /** 块菜单「扫描任务块（全部）」：按设置范围扫全部（属用户主动触发，不受 onManualSync/onStartup gate）
   *  —— 走**全量**：用户点「全部」就是要全扫一遍，不该被增量水位线挡住。 */
  private async scanBlockAll(): Promise<void> {
    if (!this.store.settings.blockSyncEnabled) return;
    try {
      const r = await this.blockSyncPass(undefined, { full: true });
      this.refreshPanels();
      showMessage(r?.text || _t("已扫描全部文档的任务块"), 4000, "info");
    } catch (err) {
      showMessage(`${_t("扫描失败：")}${String((err as Error)?.message || err)}`, 6000);
    }
  }

  /** 提醒状态摘要：让用户能区分「数据侧没设提醒」与「投递通道不通」 */
  private reminderStatus(): string {
    if (isMobile()) return _t("移动端不启用系统通知");
    if (!this.store.settings.enableReminders) return _t("未开启提醒");
    if (!this.reminder) return _t("提醒引擎未运行（重新勾选保存可重启）");
    return `${_t("已排程")} ${this.reminder.count()} ${_t("条")} · ${_t("带提醒时间的条目")} ${this.reminder.armedCount()} ${_t("个")}`;
  }

  /** 设置入口 */
  openSetting(): void {
    void openSettingsDialog(this.mainCtx);
  }

  /**
   * 让已打开的面板整体重渲染（设置页保存后由 settings-dialog 回调）。
   *
   * 两个刷新都单独兜错：面板引用可能还指向已销毁的实例（思源会重建侧栏/页签），
   * 一处抛错就会把另一处也吞掉 —— 那正是「点了入口没反应」的常见成因。
   */
  private refreshPanels(): void {
    try {
      this.tabPanel?.refresh();
    } catch (e) {
      console.warn("[caldav] 刷新面板失败（已忽略）", e);
    }
    try {
      this.dockMount?.refresh();
    } catch (e) {
      console.warn("[caldav] 刷新 Dock 失败（已忽略）", e);
    }
    // 档2·内核后端：同步完成/面板刷新后顺带把最新快照推给内核（去抖）
    this.pushReminderSnapshot();
  }

  /**
   * 档2·真·内核后端：把当前「提醒快照」（精简条目 + 设置）推给内核 kernel.js。
   *
   * 前端关闭页面后仍能在到点时触发 Webhook 的是内核调度，它依赖这份快照。
   * - 去抖 800ms：同步成功会高频触发 refreshPanels，避免反复序列化大数组推 RPC。
   * - 没有打包 kernel.js（旧版/未构建）：`this.kernel` 存在但 call 会 reject，静默忽略。
   * - 不打印任何条目内容到日志（条目可能含隐私），更不碰 webhookUrl。
   */
  /** 把当前提醒快照推给内核（设置变更/同步落盘后调用，确保内核拿到最新的 webhook 开关与地址） */
  pushReminderSnapshot(): void {
    if (this.reminderPushTimer) clearTimeout(this.reminderPushTimer);
    this.reminderPushTimer = setTimeout(() => {
      this.reminderPushTimer = null;
      try {
        if (!this.kernel) return; // 理论上 Plugin 基类的 kernel 必存在，保守兜底
        const items = this.store.getAll().map(projectReminderItem);
        const snapshot: ReminderSnapshot = { items, settings: this.store.settings };
        // 内核未就绪（尚未 bind pushReminderData）时 call 会 reject，忽略即可
        void this.kernel.rpc.call[CalDavPlugin.KERNEL_RPC_PUSH](snapshot).catch(() => {});
      } catch (e) {
        console.warn("[caldav] 推送提醒快照失败（已忽略）", e);
      }
    }, 800);
  }

  /** 按设置决定是否启用提醒引擎（开关切换/启动时调用） */
  private reconcileReminders(): void {
    // 移动端 WebView 里系统通知不可靠，不启用提醒引擎
    const want = !!this.store.settings.enableReminders && !isMobile();
    if (want && !this.reminder) {
      this.reminder = new ReminderEngine(
        () => this.store.getAll(),
        (item, anchorISO, alarmMin) => this.fireReminder(item, anchorISO, alarmMin),
        undefined,
        () => this.store.settings
      );
      this.reminder.start();
      console.info("[caldav] 提醒引擎已启动");
    } else if (!want && this.reminder) {
      this.reminder.stop();
      this.reminder = undefined;
      console.info("[caldav] 提醒引擎已停止");
    }
  }

  /**
   * 请求系统通知授权。
   *
   * ⚠️ 在思源桌面端这里**不会弹出任何授权窗口**，这是必然的而非故障：
   * Electron 主进程没有注册权限处理器，内核默认放行全部权限请求，
   * `requestPermission()` 不显示 UI 就直接 resolve（授权 UI 只有浏览器才有）。
   * 保留此调用只是为了让将来内核引入权限 UI 时行为正确。
   */
  private async ensureNotifyPermission(): Promise<void> {
    try {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "default") await Notification.requestPermission();
    } catch (e) {
      console.warn("[caldav] 通知授权调用失败", e);
    }
  }

  /** 提醒文案：标题 + 时间 / 日历 / 提前量 */
  private reminderText(item: CalItem, anchorISO: string, alarmMin: number): { title: string; body: string } {
    const cal = findCalendarByUrl(this.store.settings, item.calendarUrl);
    const when = item.allDay
      ? `${_t("全天")} · ${fmtDateCn(anchorISO)}`
      : `${fmtDateCn(anchorISO)} ${fmtTime(anchorISO)}`;
    const lead = alarmMin > 0 ? `${_t("（提前")} ${alarmMin} ${_t("分钟）")}` : "";
    return {
      title: item.summary || (item.kind === "todo" ? _t("待办提醒") : _t("日程提醒")),
      body: `${when}${cal?.displayName ? " · " + cal.displayName : ""}${lead}`
    };
  }

  /**
   * 到点触发：三通道投递，任一条失败都不影响其余通道。
   *  ① 应用内提醒卡片 —— 主通道，只要思源窗口可见就一定看得见
   *  ② 系统通知 —— 尽力而为；Windows 便携版缺开始菜单快捷方式时会被系统静默丢弃
   *  ③ 思源通知中心 / toast —— 窗口被切到后台时的留存记录
   * v0.1.7 的问题正是只依赖 ②，且 ③ 调了一个实际不存在的 API（window.siyuan.pushMsg）。
   */
  private fireReminder(item: CalItem, anchorISO: string, alarmMin: number): void {
    const { title, body } = this.reminderText(item, anchorISO, alarmMin);
    const open = () => this.openPanelTab(item.kind === "todo" ? "task" : "month");

    showReminderToast({
      title,
      body,
      onOpen: open,
      onSnooze: (min) => this.snoozeReminder(item, anchorISO, alarmMin, min)
    });
    this.notifySystem(title, body, open);

    const text = `⏰ ${title}${_t("　")}${body}`;
    try {
      showMessage(text, 8000, "info", "caldav-reminder");
    } catch {
      /* 忽略：老版本思源可能没有该导出 */
    }
    try {
      // pushMsg 会把提醒留在思源通知中心（窗口在后台时的留存记录）
      (siyuanApi as any).pushMsg?.({ msg: text, timeout: 6000, type: "info", id: "caldav-reminder" });
    } catch {
      /* 忽略 */
    }
  }

  /** 系统通知：失败只记日志，不影响其它通道 */
  private notifySystem(title: string, body: string, onClick: () => void): void {
    try {
      if (typeof Notification === "undefined" || Notification.permission === "denied") return;
      const n = new Notification(title, { body, silent: false });
      n.onclick = () => {
        try {
          onClick();
        } catch {
          /* 忽略 */
        }
        try {
          n.close();
        } catch {
          /* 忽略 */
        }
      };
      n.onerror = () =>
        console.info(
          "[caldav] 系统通知未显示（Windows 便携版缺少开始菜单快捷方式时属正常），已由应用内提醒承担"
        );
      setTimeout(() => {
        try {
          n.close();
        } catch {
          /* 忽略 */
        }
      }, 20000);
    } catch (e) {
      console.info("[caldav] 系统通知不可用，已由应用内提醒承担:", e);
    }
  }

  /** 稍后提醒：N 分钟后再走一遍同一投递链路（仅本次会话有效，不写入 ICS） */
  private snoozeReminder(item: CalItem, anchorISO: string, alarmMin: number, minutes: number): void {
    const t = setTimeout(() => {
      this.snoozeTimers.delete(t);
      this.fireReminder(item, anchorISO, alarmMin);
    }, Math.max(1, minutes) * 60000);
    this.snoozeTimers.add(t);
  }

  /**
   * 设置页「测试提醒」：在用户手势里请求授权，并立即走一遍完整投递链路。
   * 用来区分「数据侧没设提醒」与「投递通道不通」——这是排查提醒问题时最关键的一刀。
   */
  async testReminder(): Promise<string> {
    await this.ensureNotifyPermission();
    const when = stampOfMs(Date.now() + 60000);
    const demo: CalItem = {
      uid: "caldav-test-reminder",
      kind: "event",
      calendarUrl: resolveDefaultCalendar(this.store.settings)?.url || "",
      href: "",
      summary: _t("提醒功能测试"),
      allDay: false,
      start: when
    };
    this.fireReminder(demo, when, 0);
    return _t("已发出测试提醒：应出现应用内提醒卡片（系统通知视运行环境而定）");
  }

  /**
   * 把日程与待办汇总插入日记。
   *
   * 2026-10-08 起支持**范围 + 目标**（对齐 Obsidian 侧）：
   *  - `range`  当日 / 本周 / 本月 / 所有，默认当日（命令行与旧行为一致）
   *  - `target` 写到今天的日记还是区间首日的日记（本周=周一 / 本月=1 号），默认今天
   * 范围计算见 ui/diary-range.ts（纯函数）。
   *
   * 两个关键约束：
   * 1. `occurrencesInRange()` 对「无重复规则」的条目会**回退返回 `item.start`**（见 core/ics.ts），
   *    该值可能根本不在窗口内 —— 视图侧按日期落格时会被自然丢掉，这里若照单全收就会把
   *    「不在范围内」的条目也写进日记。所以每个实例必须再按窗口过滤一次。
   * 2. 待办的时间归属一律取到期日（DUE），与视图/统计口径一致，走 todoDueOccurrences。
   *
   * 写入后打开该日记文档并使其成为当前活动页签（移动端关闭全屏面板后定位到文档），
   * 同时弹出结果提示 —— 避免「点了没反应、又点一遍」导致重复插入。
   */
  async insertTodayToDiary(range: DiaryRange = "day", target: DiaryTarget = "today"): Promise<string> {
    try {
      const today = todayStamp();
      const span = diarySpanOf(range, today);
      const startMs = parseLocalStamp(span.from + "T00:00:00").getTime();
      const endMs = parseLocalStamp(span.toExclusive + "T00:00:00").getTime();
      // 目标日记：默认今天，选「本周/本月 + 区间首日」时才换成周一 / 1 号
      const targetStamp = diaryTargetStamp(range, target, today);
      const targetLabel = (targetOptionsOf(range, today).find((o) => o.key === target) || { short: _t("今天") }).short;
      const enabled = new Set(enabledCalendars(this.store.settings).map((c) => c.url));

      const rows: { ms: number; line: string }[] = [];
      // 跨日范围（本周/本月/所有）必须逐行带日期，否则一串 09:00 分不清是哪天；
      // 当日范围全在同一天，只写时间更清爽。
      // ⚠️ 判据是「区间天数 > 1」，**不能**写成 `toExclusive > from` ——
      //    当日范围的 toExclusive 是明天，那样判会误判成跨日、给每行都加日期。
      const spanDays = diffDays(span.toExclusive, span.from);
      const crossDay = spanDays > 1;
      // 逾期待办（开关开启时）：DUE 早于今天零点且未完成 —— 排在日记最前面，与范围内条目分开成小节
      const overdueRows: { ms: number; line: string }[] = [];
      const includeOverdue = !!this.store.settings.includeOverdueTodos;
      const todayMidnight = parseLocalStamp(today + "T00:00:00").getTime();
      for (const it of this.store.getAll()) {
        if (it.deleted || it.dirty || !enabled.has(it.calendarUrl)) continue;
        if (it.kind === "todo" && it.percent === 100) continue;
        const occs =
          it.kind === "todo" ? todoDueOccurrences(it, startMs, endMs, "due") : occurrencesInRange(it, startMs, endMs);
        let inRange = false;
        for (const occ of occs) {
          if (!occ) continue;
          const ms = parseLocalStamp(occ).getTime();
          if (!Number.isFinite(ms) || !spanContains(span, ms)) continue; // 只收真正落在范围内的实例
          const timed = !it.allDay && /T\d{1,2}:\d{2}/.test(occ);
          const mark = it.kind === "todo" ? "☑️" : "📅";
          const when = diaryWhenLabel(occ, timed, crossDay);
          rows.push({ ms, line: `- ${mark} ${when} ${it.summary || _t("(无标题)")}` });
          inRange = true;
        }
        // 逾期待办：仅当开关开启、且本条没落在范围内（避免「所有」范围重复计入）时，按 DUE 收集到最前面
        if (includeOverdue && it.kind === "todo" && it.end && !inRange) {
          const dueMs = parseLocalStamp(it.end).getTime();
          if (Number.isFinite(dueMs) && dueMs < todayMidnight) {
            const dueTimed = !it.allDay && /T\d{1,2}:\d{2}/.test(it.end);
            const dueLabel = dueTimed ? it.end.slice(11, 16) : _t("全天");
            overdueRows.push({
              ms: dueMs,
              line: `- ⏰ ${it.end.slice(0, 10)} ${dueLabel} ${it.summary || _t("(无标题)")}`
            });
          }
        }
      }
      rows.sort((a, b) => a.ms - b.ms);
      overdueRows.sort((a, b) => a.ms - b.ms); // 逾期最久（DUE 最早）排最前
      if (!rows.length && !overdueRows.length) return this.notify(`${span.label}${_t("没有日程或待办")}`);

      const overdueMd = overdueRows.length
        ? `### ${_t("逾期待办")}\n${overdueRows.map((r) => r.line).join("\n")}\n`
        : "";
      const md = `## ${span.sectionTitle}\n${overdueMd}${rows.map((r) => r.line).join("\n")}\n`;
      const docId = await this.resolveDailyNoteId(targetStamp);
      if (!docId) return this.notify(_t("没有打开的笔记本，无法创建日记"), "error");

      // 上一次写过就整段替换：重复点击是「刷新」而不是无限追加。
      // ⚠️ 必须用实际要写的标题（跨日范围带区间后缀），不能用固定常量匹配。
      const replaced = await this.clearPrevDiarySection(docId, span.sectionTitle);
      const ins = await fetch("/api/block/insertBlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentID: docId, dataType: "markdown", data: md })
      })
        .then((r) => r.json())
        .catch(() => ({}) as any);
      if (ins?.code) return this.notify(`${_t("写入日记失败：")}${ins.msg || ins.code}`, "error");

      this.openDocAsActive(docId);
      const total = rows.length + overdueRows.length;
      return this.notify(
        `${_t("已")}${replaced ? _t("更新") : _t("写入")}${targetLabel}${_t("的日记「")}${span.sectionTitle}${_t("」")}${total} ${_t("条")}`
      );
    } catch (e) {
      // 任何异常都要有反馈：静默失败会让用户以为没执行而重复点击
      return this.notify(`${_t("插入日记失败：")}${(e as Error)?.message || e}`, "error");
    }
  }

  /**
   * 弹出「范围 + 目标」选择框，确认后插入日记。
   * 面板按钮与命令面板都走这里 —— 用户点的是「插入日记」，范围得让他自己选。
   */
  askInsertDiary(): void {
    askDiaryRange((range, target) => void this.insertTodayToDiary(range, target));
  }

  /** 统一反馈出口：站内提示 + 返回文案（命令面板/调用方复用同一句） */
  private notify(text: string, type: "info" | "error" = "info"): string {
    try {
      showMessage(text, type === "error" ? 5000 : 3000, type);
    } catch {
      /* 忽略 */
    }
    return text;
  }

  /** 内核接口调用：只取 data，失败返回 undefined（不抛，交给调用方决定文案） */
  private async kernelData(url: string, body: unknown): Promise<any> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return (await res.json())?.data;
    } catch (e) {
      console.warn("[caldav] 内核接口调用失败:", url, e);
      return undefined;
    }
  }

  /**
   * 定位某一天的日记文档；找不到就按思源的日记规则新建一篇。
   *
   * 不一定是「今天」—— 选「本周 + 周一」时这里收到的是周一那一天。
   *
   * ⚠️ 为什么不能靠「标题/路径里含这个日期」去猜（2026-10-14 修）：
   * 用户报的现象是「插进去了，但不在 daily note 里」。根因是旧实现只做
   * `content like '%日期%'` 这种模糊匹配，且**只取前 20 条**（`limit 20`）——
   *  1. 命中的是「正文里提过这个日期的普通文档」，不是日记；
   *  2. 日记若排在 20 条之外（工作空间文档多时很常见）就彻底找不到；
   *  3. 找不到时在**第一个未关闭笔记本的根目录**建 `/日期`，
   *     而用户真正的日记在笔记本设置配的 `dailyNoteSavePath`（如 `/日记/2026-10-14`），
   *     于是内容进了另一篇文档 —— 用户打开 daily note 当然看不到。
   *
   * 现在三级定位，逐级收紧：
   *  ① **日记专属属性** `custom-dailynote-yyyymmdd`（思源建日记时自动打，见 Issue #9807）
   *     —— 唯一可靠判据，不会误伤普通文档，也不受行数限制；
   *  ② **笔记本的日记保存路径**：读 `dailyNoteSavePath` 模板，渲染出该天的确切 hpath 再精确查；
   *  ③ 都查不到才新建，且**必须建在 ② 渲染出来的路径上**（今天则直接用内核的
   *     `createDailyNote`，让内核按自己的规则建并自动打属性）。
   */
  private async resolveDailyNoteId(day: string): Promise<string | null> {
    // ① 日记专属属性：最可靠，直接按属性名精确查
    const byAttr: any[] =
      (await this.kernelData("/api/query/sql", {
        stmt: `select id from blocks where type = 'd' and id in (
                 select block_id from attributes where name = '${sqlText(dailyNoteAttrName(day))}'
               ) limit 1`
      })) || [];
    if (byAttr[0]?.id) return byAttr[0].id;

    // ② 按笔记本设置里的「日记保存路径」模板定位
    const nb = await this.dailyNoteNotebook();
    const hPath = nb?.dailyNoteSavePath ? renderDailyNotePath(nb.dailyNoteSavePath, day) : "";
    if (nb && hPath) {
      const byPath: any[] =
        (await this.kernelData("/api/query/sql", {
          stmt: `select id from blocks where type = 'd' and hpath = '${sqlText(hPath)}' limit 1`
        })) || [];
      if (byPath[0]?.id) return byPath[0].id;

      // ③ 建：今天走内核官方接口（自动按笔记本规则建 + 打日记属性）；
      //    其它日期内核接口不支持，只能按同一路径手建，再补上日记属性。
      if (day === todayStamp()) {
        const created = await this.kernelData("/api/filetree/createDailyNote", { notebook: nb.id });
        if (created) return String(created);
      }
      const id = await this.kernelData("/api/filetree/createDocWithMd", {
        notebook: nb.id,
        path: hPath,
        markdown: ""
      });
      if (id) {
        await this.kernelData("/api/attr/setBlockAttrs", {
          id: String(id),
          attrs: { [dailyNoteAttrName(day)]: day.replace(/-/g, "") }
        });
        return String(id);
      }
    }

    // 兜底：没有可用模板（笔记本没配日记路径）时，退回「精确标题匹配 + 根目录新建」。
    // 只认标题**完全等于**日期的文档，不再用 like 模糊匹配（那是旧实现的坑）。
    const byTitle: any[] =
      (await this.kernelData("/api/query/sql", {
        stmt: `select id, content, hpath from blocks where type = 'd' and content = '${sqlText(day)}' limit 1`
      })) || [];
    if (byTitle[0]?.id) return byTitle[0].id;
    if (!nb) return null;
    return (
      (await this.kernelData("/api/filetree/createDocWithMd", { notebook: nb.id, path: "/" + day, markdown: "" })) ||
      null
    );
  }

  /**
   * 挑一个「能建日记」的笔记本，并带回它的日记保存路径模板。
   *
   * 优先选**配了日记路径**的笔记本（`dailyNoteSavePath` 非空且不为 `/`）——
   * 只有这类笔记本建出来的日记才在用户预期的位置。全都��配时退回第一个未关闭的，
   * 此时 `dailyNoteSavePath` 为空，调用方会走兜底分支。
   */
  private async dailyNoteNotebook(): Promise<{ id: string; dailyNoteSavePath?: string } | null> {
    const notebooks: any[] = (await this.kernelData("/api/notebook/lsNotebooks", {}))?.notebooks || [];
    const open = notebooks.filter((n) => !n.closed && n?.id);
    if (!open.length) return null;
    let fallback: { id: string; dailyNoteSavePath?: string } | null = null;
    for (const n of open) {
      const conf: any = (await this.kernelData("/api/notebook/getNotebookConf", { notebook: n.id })) || {};
      const tpl = typeof conf.dailyNoteSavePath === "string" ? conf.dailyNoteSavePath.trim() : "";
      const usable = tpl && tpl !== "/" ? tpl : "";
      if (usable) return { id: n.id, dailyNoteSavePath: usable };
      if (!fallback) fallback = { id: n.id };
    }
    return fallback;
  }

  /**
   * 删除上一次插入的小节（标题块 + 紧跟其后的连续列表块），让重复点击变成「刷新」。
   *
   * ⚠️ `title` 必须是**实际写入的那一行标题**：跨日范围的小节标题带区间后缀，
   * 若按固定常量匹配就永远命中不了 —— 结果是每次点击都追加一个重复小节。
   * 只认标题文本完全匹配的块，且在第一个非列表块处停下，不会误删用户其它内容。
   */
  private async clearPrevDiarySection(docId: string, title: string = DIARY_SECTION_BASE): Promise<boolean> {
    const kids: any[] = (await this.kernelData("/api/query/sql", {
      stmt: `select id, type, content from blocks where parent_id = '${docId}' order by sort`
    })) || [];
    const del: string[] = [];
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].type !== "h" || String(kids[i].content || "").trim() !== title) continue;
      del.push(kids[i].id);
      for (let j = i + 1; j < kids.length && (kids[j].type === "l" || kids[j].type === "i"); j++) del.push(kids[j].id);
    }
    if (!del.length) return false;
    for (const id of del) await this.kernelData("/api/block/deleteBlock", { id });
    return true;
  }

  /** 打开文档并使其成为当前活动页签 */
  private openDocAsActive(id: string): void {
    try {
      if (isMobile()) {
        // 移动端面板是 100vw/100vh 的 Dialog，不关掉会盖住日记
        this.closeMobilePanel();
        openMobileFileById(this.app, id, ["cb-get-focus"]);
        return;
      }
      void openTab({ app: this.app, doc: { id }, keepCursor: true });
    } catch (e) {
      console.warn("[caldav] 打开日记文档失败", e);
    }
  }
}
