/** siyuan 模块桩：模拟思源插件 API 的运行时行为（CJS） */
class EventBus {
  constructor() { this.h = {}; }
  on(t, fn) { (this.h[t] ||= []).push(fn); }
  off() {}
  emit(t, d) { (this.h[t] || []).forEach((f) => f(d)); }
}

class Plugin {
  constructor(options = {}) {
    this.app = options.app || { appId: "test" };
    this.name = options.name || "test-plugin";
    this.i18n = options.i18n || {};
    this.data = {};
    this.eventBus = new EventBus();
    this.commands = [];
    this.__stores = new Map();
    globalThis.__syRegistrations = { topbar: [], dock: [], tab: [], commands: [], icons: [] };
  }
  addIcons(svg) { globalThis.__syRegistrations.icons.push(svg); }
  addTopBar(o) { globalThis.__syRegistrations.topbar.push(o); }
  addDock(o) { globalThis.__syRegistrations.dock.push(o); }
  addTab(o) { globalThis.__syRegistrations.tab.push(o); }
  addCommand(o) { globalThis.__syRegistrations.commands.push(o); }
  async loadData(k) { return this.__stores.get(k); }
  async saveData(k, d) { this.__stores.set(k, JSON.parse(JSON.stringify(d))); }
  async removeData(k) { this.__stores.delete(k); }
  /**
   * 模拟思源 Plugin.getOpenedTab()：键为去掉插件名后的自定义类型，
   * 值为该类型的已打开模型（每个模型带 .tab 页签实例）。
   * 思源内部把自定义类型拼成 `插件名 + 页签类型`，这里同样按此约定还原键名。
   */
  getOpenedTab() {
    const reg = globalThis.__syRegistrations;
    const out = {};
    (reg.tab || []).forEach((o) => {
      out[o.type] = [];
    });
    (reg.customModels || []).forEach((m) => {
      const key = String(m.type).replace(this.name, "");
      if (!out[key]) out[key] = [];
      out[key].push(m);
    });
    return out;
  }
}

class Dialog {
  constructor(options = {}) {
    // 忠实还原思源 Dialog 的 DOM：外层是无类名的壳（this.element），
    // 里面才是带递增 z-index 与遮罩的 .b3-dialog，容器才挂 containerClassName。
    // 插件的层管理要靠「内容根 → 最外层壳」这条链定位弹层，桩必须同构。
    this.options = options;
    this.destroying = false;
    this.element = document.createElement("div");

    const box = document.createElement("div");
    box.className = "b3-dialog";
    box.style.zIndex = String((globalThis.__syZIndex = (globalThis.__syZIndex || 0) + 1));
    const scrim = document.createElement("div");
    scrim.className = "b3-dialog__scrim";

    const container = document.createElement("div");
    // 这里模拟思源 v3.2.0+ 的行为：containerClassName 会被拼进 b3-dialog__container
    // 的 class。本插件 minAppVersion 已提到 3.2.0，挂类完全由思源负责（插件不自己动手）。
    container.className = "b3-dialog__container" + (options.containerClassName ? " " + options.containerClassName : "");
    container.style.width = options.width || "auto";
    container.style.height = options.height || "auto";
    container.innerHTML =
      `<svg class="b3-dialog__close"></svg>` +
      `<div class="b3-dialog__header">${options.title || ""}</div>` +
      `<div class="b3-dialog__body">${options.content || ""}</div>`;

    box.appendChild(scrim);
    box.appendChild(container);
    this.element.appendChild(box);
    // b3-dialog--open 是真正决定显形的开关：思源 base.css 里
    // `.b3-dialog__scrim{opacity:0}` / `.b3-dialog--open .b3-dialog__container{opacity:1}`，
    // 而 destroy() 只是摘掉这个类 —— 元素还在，遮罩已透明但整屏仍吃点击。
    this.element.classList.add("b3-dialog--open");
    document.body.appendChild(this.element);

    this.container = container;
    // 真实思源 Dialog 的两条关闭路径（移动端产物里就是
    // `scrim.addEventListener("click", … this.destroy() …)` 与
    // `element.querySelector(".b3-dialog__close").addEventListener("click", … this.destroy())`）。
    // 桩里补上，测试才能像用户那样「点右上角关闭」来数层数。
    container.querySelector(".b3-dialog__close").addEventListener("click", () => this.destroy());
    scrim.addEventListener("click", () => this.destroy());
    globalThis.__lastDialog = { options };
    globalThis.__lastDialogInstance = this;
  }
  open() {}
  /**
   * 忠实还原思源 Dialog.destroy()：先摘掉 b3-dialog--open 让容器淡出，
   * 一个 timeout 之后才移除元素并回调 destroyCallback（移动端产物里就是
   * `setTimeout(() => { this.element.remove(); this.destroyCallback(h) }, TIMEOUT_DBLCLICK)`）。
   * 桩里用 __syDialogCloseDelay 缩短等待（默认 15ms），但**必须保持异步**：
   * 同步回调会掩盖「旧层的迟到回调误清新层引用」这类真实 bug。
   * 另外 destroy() 自带 destroying 幂等闸，重复调用不产生第二次回调。
   */
  destroy() {
    if (this.destroying) return;
    this.destroying = true;
    this.element.classList.remove("b3-dialog--open");
    setTimeout(() => {
      this.element.remove();
      if (typeof this.options?.destroyCallback === "function") this.options.destroyCallback();
    }, globalThis.__syDialogCloseDelay ?? 15);
  }
}

module.exports = {
  Plugin,
  Dialog,
  Menu: class {},
  Setting: class {},
  openTab(o) {
    const reg = globalThis.__syRegistrations;
    reg.lastOpenTab = o;
    if (o && o.custom) {
      // 自定义页签：返回带 close() 的页签实例，并登记为「已打开模型」，
      // 供 Plugin.getOpenedTab() 复现思源的真实行为（插件卸载清理依赖它）。
      const tab = {
        id: o.custom.id,
        title: o.custom.title,
        closed: false,
        updateTitle(t) { this.title = t; },
        close() {
          this.closed = true;
          (reg.closedTabs ||= []).push(this.id);
        }
      };
      (reg.customModels ||= []).push({ type: o.custom.id, tab });
      return Promise.resolve(tab);
    }
    return Promise.resolve({ id: "non-custom", updateTitle() {}, close() {} });
  },
  openMobileFileById(app, id, action) {
    globalThis.__syRegistrations.lastOpenMobile = { app, id, action };
  },
  // SPIKE issue#5：把「主窗口页签」搬进独立窗口。记录调用供契约测试断言。
  openWindow(o) {
    const reg = globalThis.__syRegistrations;
    reg.lastOpenWindow = o;
  },
  // 通过 SY_FRONTEND 环境变量切换前端类型（mobile / desktop），供移动端回归测试驱动
  getFrontend: () => process.env.SY_FRONTEND || "desktop",
  getBackend: () => "desktop",
  fetchPost: async () => {},
  fetchSyncPost: async () => ({ code: 0 }),
  // 记录站内提示与通知中心消息，供「提醒投递链路」回归测试断言
  showMessage: (text, timeout, type, id) => {
    (globalThis.__syMessages ||= []).push({ text, timeout, type, id });
  },
  pushMsg: (options) => {
    (globalThis.__syPushes ||= []).push(options);
  },
  confirm: async () => true,
  openDock: () => {},
  platformUtils: {},
  Constants: {}
};
