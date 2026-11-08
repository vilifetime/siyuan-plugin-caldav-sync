/**
 * i18n 统一入口。
 *
 * 思源内核会按 `window.siyuan.config.lang` 自动把 `i18n/<lang>.json` 读进
 * `plugin.i18n`（见 siyuan.d.ts 的 `i18n: Record<string, string>`）。
 * 但 `core/*` 模块不是 Plugin 的方法，拿不到 `this.i18n`/`ctx.i18n`，
 * 于是这里放一个进程级单例：index.ts 的 `onload` 里调一次 `setI18n(this.i18n)`，
 * 之后任何地方（含 core）都能用 `t(key)` 取文案。
 *
 * 约定（与既有 `ctx.i18n` / `this.i18n` 钩子一致）：
 *   - key 直接是中文原文（中文文案即键），`i18n/zh_CN.json` 为恒等映射；
 *   - 取不到（英文环境漏翻 / 语言文件缺失）时回退到 key 本身（仍是中文），
 *     保证半成品也能跑、不白屏。
 */
let dict: Record<string, string> = {};

export function setI18n(d: Record<string, string> | undefined): void {
  dict = d && typeof d === "object" ? d : {};
}

/**
 * 取文案；缺失回退到 key 本身（仍是中文），保证半成品也能跑、不白屏。
 *
 * 支持占位符：`t("共 {0} 条", n)` 会把 `{0}` 替换为第 1 个附加参数，
 * 这样模板字符串里的动态值不必拆成数组，key 仍是稳定的纯文本串。
 */
export function t(key: string, ...args: unknown[]): string {
  if (key === undefined || key === null) return key as unknown as string;
  let v = dict[key];
  if (v === undefined || v === null) v = key;
  if (args.length) {
    v = v.replace(/\{(\d+)\}/g, (_m, i) => {
      const a = args[Number(i)];
      return a === undefined || a === null ? "" : String(a);
    });
  }
  return v;
}

/**
 * 当前是否英文界面（日期 / 月份格式化需要按语言换格式，不只是翻译单词）。
 *
 * 刻意不依赖 `window`：`core/*` 同时被前端插件、内核脚本和 Node 测试桩加载，
 * 有些环境没有 `window.siyuan`。项目约定 `zh_CN.json` 是恒等映射（key 即中文原文），
 * 而 `en_US.json` 把「日历」译成 "Calendar"，所以用字典内容本身判定：
 *   - 英文字典 → t("日历") === "Calendar" → true
 *   - 中文字典 / 字典尚未注入 → t("日历") === "日历" → false（按中文处理，不白屏）
 */
export function isEnglish(): boolean {
  return t("日历") !== "日历";
}
