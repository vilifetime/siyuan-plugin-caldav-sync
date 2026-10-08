/**
 * CalDAV日历任务 —— 思源笔记插件入口
 * 左侧 Dock：精简导航（视图切换 + 设置）；主日历视图：主窗口页签
 */
import { Dialog, Plugin, openTab, openMobileFileById, showMessage, type Custom, type MobileCustom, type Tab } from "siyuan";
// pushMsg 在部分思源版本的 siyuan.d.ts 里没有声明（运行时通常存在），故用命名空间做存在性容错调用
import * as siyuanApi from "siyuan";
import "@/index.css";
import { CalStore } from "@/core/store";
import { SyncEngine } from "@/core/sync";
import { setSecretSeed } from "@/core/secret";
import { setDirectFallbackToProxy } from "@/core/http";
import { occurrencesInRange } from "@/core/ics";
import { todayStamp, fmtDateCn, fmtTime, stampOfMs, parseLocalStamp } from "@/core/date";
import type { CalItem } from "@/core/types";
import { todoDueOccurrences } from "@/ui/view-common";
import { ReminderEngine } from "@/core/reminder";
import { renderPanel, renderDockPanel, notifyViewChange, toggleTodoDone, VIEW_CHANGE_EVENT, type PanelCtx, type ViewMode } from "@/ui/panel";
import { isMobile } from "@/ui/device";
import { adoptMobileLayer, closeAllMobileLayers, isDialogAlive } from "@/ui/mobile-layers";
import { openEditor } from "@/ui/editor";
import { openSettingsDialog } from "@/ui/settings-dialog";
import { showReminderToast, clearReminderToasts } from "@/ui/reminder-toast";
import { newDialog } from "@/ui/dialog";

/**
 * Dock / 页签的类型标识。思源拿它记账（侧栏位置、已打开模型），**改了等于换一个插件**，
 * 用户已保存的 Dock 布局会失配。所以它只当「标识」用，不再兼作数据文件名。
 */
const DOCK_TYPE = "caldav-sync-dock";
const TAB_TYPE = "caldav-sync-tab";
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
/** 写入日记的小节标题，同时作为「重复点击→替换而非追加」的识别标记 */
const DIARY_SECTION_TITLE = "今日日程与待办";

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
   * 移动端全屏承载面板（移动端没有页签，改用 Dialog 承载同一套 renderPanel）。
   * dialog 与其中的面板一起记账：回调按**实例**自证身份，旧层的迟到回调不会碰新层。
   */
  private mobilePanel: {
    dialog: Dialog;
    panel: { destroy: () => void; refresh: () => void };
    dispose: () => void;
  } | null = null;
  private viewChangeHandler: ((e: Event) => void) | null = null;
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

  async onload(): Promise<void> {
    const self = this;
    this.addIcons(ICONS);
    // 加载时先清场：覆盖安装 / 集市热更新只换 JS，页面上已有的插件全屏弹层会留下，
    // 它们不属于本实例、回调也属于旧模块，但照样挡着整屏 —— 每关一层下面还压着一层。
    closeAllMobileLayers();

    // 移动端 WebView 会拦掉明文 HTTP 的浏览器直连（报 Failed to fetch），
    // 直连在网络层失败时自动改走内核代理 —— 见 core/http.ts 的说明。
    setDirectFallbackToProxy(isMobile());

    // 先拿到设备标识（思源 conf.system.id + 工作空间路径）作为凭据加密密钥来源，
    // 再加载 store —— 顺序不能反，否则密文解不开会被当成「密码丢失」。
    await this.ensureSecretSeed();

    this.store = new CalStore({
      // 读：新文件名优先，读不到再回退历史文件名并一次性迁移（见 loadPluginData）
      loadData: () => this.loadPluginData(),
      saveData: (d) => this.saveData(DATA_FILE, d)
    });
    await this.store.load();
    // 设备标识若迟到（getConf 失败/慢），v2 旧密文会停在「待解密」。稍后补一次；
    // 即便仍解不开，也绝不会把磁盘上的密文覆盖成空串（见 CalStore.unlockPassword）。
    if (this.store.pendingUnlock) {
      setTimeout(() => void this.retrySecretUnlock(), 2500);
    }
    this.sync = new SyncEngine(this.store, () => this.store.settings.channel);
    this.mainCtx = this.createCtx();

    // 设置变更 / 同步落盘后：重算提醒开关并重新排程
    this.store.onChange(() => {
      this.reconcileReminders();
      this.reminder?.reschedule();
    });

    // 左侧 Dock：精简导航（视图按钮在主窗口打开/切换日历页签）
    this.addDock({
      config: {
        position: "LeftBottom",
        size: { width: 240, height: 0 },
        icon: "iconCalDavSync",
        title: "日历任务管理",
        hotkey: "⌥⇧C"
      },
      data: { key: "dock" },
      type: DOCK_TYPE,
      init: function (this: Custom | MobileCustom) {
        self.mountDock(this.element as HTMLElement);
        // 点击插件图标展开 Dock 时，默认在主窗口打开日历视图
        // 延迟执行：init 阶段 SiYuan 布局尚未完全就绪，立即 openTab 可能被忽略；
        // 等布局稳定（约 350ms）后再开，确保「日历」页签稳定弹出。
        // 移动端跳过：侧栏抽屉刚展开就被全屏面板盖住会让人摸不着北，
        // 改由抽屉内的「日历视图 / 任务视图」按钮或顶部「插件」菜单触发。
        if (!isMobile()) {
          setTimeout(() => self.openPanelTab("month"), 350);
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

    // 主窗口日历页签（单例）
    this.addTab({
      type: TAB_TYPE,
      init: function (this: Custom) {
        if (self.disposers.has("tab")) return;
        const panel = renderPanel(this.element as HTMLElement, self.mainCtx);
        self.tabPanel = panel;
        self.disposers.set("tab", () => {
          panel.destroy();
          self.tabPanel = null;
        });
        notifyViewChange(self.mainCtx.viewMode);
      },
      beforeDestroy: function () {
        self.disposers.get("tab")?.();
        self.disposers.delete("tab");
      }
    });

    // 监听视图切换，同步更新已打开页签的标题
    this.viewChangeHandler = (e: Event) => {
      const mode = (e as CustomEvent).detail as ViewMode;
      const title = mode === "task" ? "任务" : "日历";
      if (self.tab) {
        self.tab.updateTitle(title);
      }
      const header = self.mobilePanel?.dialog.element.querySelector(".b3-dialog__header");
      if (header) header.textContent = title;
    };
    document.addEventListener(VIEW_CHANGE_EVENT, this.viewChangeHandler);

    // 命令（可在「设置 → 快捷键」中绑定）
    this.addCommand({
      langKey: "syncNow",
      langText: "立即同步 CalDAV",
      hotkey: "",
      callback: () => void this.sync.syncAll()
    });
    this.addCommand({
      langKey: "addTask",
      langText: "新建待办",
      hotkey: "",
      callback: () => openEditor(this.mainCtx, { kind: "todo" })
    });
    this.addCommand({
      langKey: "openPanel",
      langText: "打开日历与任务",
      hotkey: "",
      callback: () => this.openPanelTab()
    });
    this.addCommand({
      langKey: "insertToday",
      langText: "把今日日程与待办插入日记",
      hotkey: "",
      callback: () => void this.insertTodayToDiary()
    });

    // 移动端入口：移动端没有 Dock 图标列，addTopBar 会归入右上「插件」菜单，
    // 这是手机上最直接调出日历/任务面板的路径。
    // 标题带插件名，免得和别的日历类插件在菜单里撞名。
    if (isMobile()) {
      this.addTopBar({
        icon: "iconCalDavSync",
        title: "CalDAV日历任务",
        position: "right",
        callback: () => this.openPanelTab()
      });
    }

    if (this.store.isConfigured()) {
      this.sync.startAutoSync(() => this.reminder?.reschedule());
      setTimeout(() => void this.sync.syncAll().then(() => this.reminder?.reschedule()), 3000);
    }
    // 按当前设置决定是否启动提醒引擎（设置可能已开启）
    this.reconcileReminders();
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
      onNav: (m) => this.openPanelTab(m),
      onSync: () => this.sync.syncAll(),
      onSettings: () => this.openSetting(),
      // 只给日期，具体时刻由编辑弹窗按「下一个整点」补（见 core/date.defaultStartStamp）
      onAddEvent: () => openEditor(this.mainCtx, { kind: "event", start: this.mainCtx.cursor }),
      onAddTask: () => openEditor(this.mainCtx, { kind: "todo" }),
      onSort: (mode) => {
        this.mainCtx.sortMode = mode;
        this.tabPanel?.refresh();
      },
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

  onunload(): void {
    // 先关掉本插件打开的自定义页签：思源只会摘掉自己接管的注册项（Dock / 顶栏 / 工具栏），
    // 页签不管，不关就会在主窗口留一个空白「日历」页签，还会被写进 conf，重启后依然在。
    this.closePanelTabs();
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
    const title = mode && mode !== "task" ? "日历" : mode === "task" ? "任务" : "日历与任务";
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
    return this.mainCtx.viewMode === "task" ? "任务" : "日历";
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
      console.warn(`[caldav] 数据迁移到 ${DATA_FILE} 失败，保留旧文件 ${LEGACY_DATA_FILE}，本次仍用旧数据`, e);
      return legacy;
    }
    console.info(`[caldav] 数据文件已迁移：${LEGACY_DATA_FILE} → ${DATA_FILE}`);
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
    return {
      store: this.store,
      sync: this.sync,
      i18n: (k) => (this.i18n as any)?.[k] || k,
      insertTodayToDiary: () => this.insertTodayToDiary(),
      unsaved: new Set(),
      viewMode: "month" as ViewMode,
      cursor: todayStamp(),
      sortMode: "start",
      testReminder: () => this.testReminder(),
      refreshPanels: () => this.refreshPanels(),
      reminderStatus: () => this.reminderStatus()
    };
  }

  /** 提醒状态摘要：让用户能区分「数据侧没设提醒」与「投递通道不通」 */
  private reminderStatus(): string {
    if (isMobile()) return "移动端不启用系统通知";
    if (!this.store.settings.enableReminders) return "未开启提醒";
    if (!this.reminder) return "提醒引擎未运行（重新勾选保存可重启）";
    return `已排程 ${this.reminder.count()} 条 · 带提醒时间的条目 ${this.reminder.armedCount()} 个`;
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
  }

  /** 按设置决定是否启用提醒引擎（开关切换/启动时调用） */
  private reconcileReminders(): void {
    // 移动端 WebView 里系统通知不可靠，不启用提醒引擎
    const want = !!this.store.settings.enableReminders && !isMobile();
    if (want && !this.reminder) {
      this.reminder = new ReminderEngine(
        () => this.store.getAll(),
        (item, anchorISO, alarmMin) => this.fireReminder(item, anchorISO, alarmMin)
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
    const cal = this.store.settings.calendars.find((c) => c.url === item.calendarUrl);
    const when = item.allDay
      ? `全天 · ${fmtDateCn(anchorISO)}`
      : `${fmtDateCn(anchorISO)} ${fmtTime(anchorISO)}`;
    const lead = alarmMin > 0 ? `（提前 ${alarmMin} 分钟）` : "";
    return {
      title: item.summary || (item.kind === "todo" ? "待办提醒" : "日程提醒"),
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

    const text = `⏰ ${title}　${body}`;
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
      calendarUrl: this.store.settings.calendars[0]?.url || "",
      href: "",
      summary: "提醒功能测试",
      allDay: false,
      start: when
    };
    this.fireReminder(demo, when, 0);
    return "已发出测试提醒：应出现应用内提醒卡片（系统通知视运行环境而定）";
  }

  /**
   * 把今日日程与待办汇总插入当天日记。
   *
   * 两个关键约束：
   * 1. `occurrencesInRange()` 对「无重复规则」的条目会**回退返回 `item.start`**（见 core/ics.ts），
   *    该值可能根本不在窗口内 —— 视图侧按日期落格时会被自然丢掉，这里若照单全收就会把
   *    「不是今天」的条目也写进日记。所以事件必须再按窗口过滤一次。
   * 2. 待办的时间归属一律取到期日（DUE），与视图/统计口径一致，走 todoDueOccurrences。
   *
   * 写入后打开该日记文档并使其成为当前活动页签（移动端关闭全屏面板后定位到文档），
   * 同时弹出结果提示 —— 避免「点了没反应、又点一遍」导致重复插入。
   */
  async insertTodayToDiary(): Promise<string> {
    try {
      const today = todayStamp();
      const startMs = parseLocalStamp(today + "T00:00:00").getTime();
      const endMs = startMs + 86400000;
      const enabled = new Set(this.store.settings.calendars.filter((c) => c.enabled).map((c) => c.url));

      const rows: { ms: number; line: string }[] = [];
      for (const it of this.store.getAll()) {
        if (it.deleted || it.dirty || !enabled.has(it.calendarUrl)) continue;
        if (it.kind === "todo" && it.percent === 100) continue;
        const occs =
          it.kind === "todo" ? todoDueOccurrences(it, startMs, endMs) : occurrencesInRange(it, startMs, endMs);
        for (const occ of occs) {
          if (!occ) continue;
          const ms = parseLocalStamp(occ).getTime();
          if (!Number.isFinite(ms) || ms < startMs || ms >= endMs) continue; // 只收真正落在今天的实例
          const timed = !it.allDay && /T\d{1,2}:\d{2}/.test(occ);
          const mark = it.kind === "todo" ? "☑️" : "📅";
          rows.push({ ms, line: `- ${mark} ${timed ? occ.slice(11, 16) : "全天"} ${it.summary || "(无标题)"}` });
        }
      }
      rows.sort((a, b) => a.ms - b.ms);
      if (!rows.length) return this.notify("今天没有日程或待办");

      const md = `## ${DIARY_SECTION_TITLE}\n${rows.map((r) => r.line).join("\n")}\n`;
      const docId = await this.resolveDailyNoteId(today);
      if (!docId) return this.notify("没有打开的笔记本，无法创建今日日记", "error");

      // 上一次写过就整段替换：重复点击是「刷新」而不是无限追加
      const replaced = await this.clearPrevDiarySection(docId);
      const ins = await fetch("/api/block/insertBlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentID: docId, dataType: "markdown", data: md })
      })
        .then((r) => r.json())
        .catch(() => ({}) as any);
      if (ins?.code) return this.notify(`写入日记失败：${ins.msg || ins.code}`, "error");

      this.openDocAsActive(docId);
      return this.notify(`已${replaced ? "更新" : "写入"}今日日记「${DIARY_SECTION_TITLE}」${rows.length} 条`);
    } catch (e) {
      // 任何异常都要有反馈：静默失败会让用户以为没执行而重复点击
      return this.notify(`插入日记失败：${(e as Error)?.message || e}`, "error");
    }
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

  /** 定位今天的日记文档：优先 hpath / 标题命中，找不到再新建 */
  private async resolveDailyNoteId(today: string): Promise<string | null> {
    const rows: any[] =
      (await this.kernelData("/api/query/sql", {
        stmt: `select id, content, hpath from blocks where type = 'd' and (content like '%${today}%' or hpath like '%${today}%') limit 20`
      })) || [];
    const titleOf = (r: any) => String(r.content || "").trim();
    const pathOf = (r: any) => String(r.hpath || "");
    // 日记路径模板必然含日期，hpath 命中比「正文里提过这个日期」可信得多
    const hit =
      rows.find((r) => pathOf(r).includes(today) && titleOf(r) === today) ||
      rows.find((r) => pathOf(r).includes(today)) ||
      rows.find((r) => titleOf(r) === today);
    if (hit?.id) return hit.id;

    const notebooks: any[] = (await this.kernelData("/api/notebook/lsNotebooks", {}))?.notebooks || [];
    const nb = notebooks.find((n) => !n.closed);
    if (!nb) return null;
    return (await this.kernelData("/api/filetree/createDocWithMd", { notebook: nb.id, path: "/" + today, markdown: "" })) || null;
  }

  /**
   * 删除上一次插入的「今日日程与待办」小节（标题块 + 紧跟其后的连续列表块）。
   * 只认标题文本完全匹配的块，且在第一个非列表块处停下，不会误删用户其它内容。
   */
  private async clearPrevDiarySection(docId: string): Promise<boolean> {
    const kids: any[] = (await this.kernelData("/api/query/sql", {
      stmt: `select id, type, content from blocks where parent_id = '${docId}' order by sort`
    })) || [];
    const del: string[] = [];
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].type !== "h" || String(kids[i].content || "").trim() !== DIARY_SECTION_TITLE) continue;
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
