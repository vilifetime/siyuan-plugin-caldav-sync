/**
 * 大文件确认流的端到端交互测试（jsdom，真实插件链路，手动/CI 跑：node test/attach-confirm.mjs）。
 *
 * 钉三件 2026-10-15 雄哥截图报的事：
 *  ① **重复提示**：超 800KB 的文件，挑选时先 setMsg 一段红色说明、确认栏又把
 *     文件名/大小/阈值说一遍 —— 同一信息连报两遍，一次普通确认被做成报错的样子。
 *     判据：附件区文本里文件名只出现一遍，且确认期间 msg 行必须为空、非错误样式。
 *  ② **改了上限不生效的观感**：提示语的上限是开弹窗那一刻的快照，设置里把 5 改成 7
 *     之后旧弹窗还显示 5.0 MB。判据：挑选文件时提示语按当前设置实时刷新。
 *  ③ **确认/取消/作废三态**：取消→栏消失、不加附件、提示中性；确认→二进制行真的
 *     加进来；没点确认又选一个新文件→旧确认作废（不发消息）、只留新文件的栏。
 *  ④ **保存不再等上传**（2026-10-15 雄哥报「删了附件保存，窗口假死很久」）：上传挂起时
 *     点保存必须立即关窗，本地落盘与上传解耦。判据：打桩 updateItem 为永不 resolve，
 *     点保存后 settle 若干轮，`.caldav-editor` 必须已断开文档。
 *
 * 另外回归硬上限拒绝（超过单文件上限直接红字拒、不出确认栏）与「设置放行」：
 * 默认回退 5MB 拒 6MB；把设置改成 7 后同一文件放行。
 *
 * DOM 与事件都走真实插件：seedStore → 页签 → 任务视图 → 点待办 → 编辑弹窗 →
 * 切「备注附件」标签 → 直接往 file input 里塞 File 派发 change。
 */
import { setupBrowserDom, loadBuiltPlugin, seedStore, settle } from "./helpers.mjs";

setupBrowserDom();
const Mod = loadBuiltPlugin();
const PluginClass = Mod.default || Mod;
const plugin = new PluginClass({ app: { appId: "test" }, name: "siyuan-plugin-caldav-sync", i18n: {} });
await plugin.onload();
seedStore(plugin);

const click = (el) => el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

// 打开待办编辑器：任务视图 → 点一条待办（与 verify-note-attach.mjs 同一链路）
const reg = globalThis.__syRegistrations;
const tabEl = document.createElement("div");
document.body.appendChild(tabEl);
const tabCustom = { element: tabEl, data: { key: "tab" } };
reg.tab[0].init.call(tabCustom, tabCustom);
click(tabEl.querySelector('[data-action="toggle-view"]'));
const taskRow = [...tabEl.querySelectorAll(".cal-task[data-open]")].find((el) => (el.textContent || "").includes("测试条目 2"));
if (!taskRow) throw new Error("任务视图里找不到种子待办");
click(taskRow);
const editorEl = document.querySelector(".caldav-editor");
if (!editorEl) throw new Error("编辑弹窗没打开");
click(editorEl.querySelector('.caldav-tab[data-tab="note"]'));

const attach = editorEl.querySelector(".caldav-attach");
const fileInput = editorEl.querySelector("[data-attach-file]");
const msgEl = editorEl.querySelector("[data-attach-msg]");
const hintEl = editorEl.querySelector("[data-attach-hint]");
if (!attach || !fileInput || !msgEl || !hintEl) throw new Error("附件区结构不完整");

/** 模拟用户选文件：往 file input 塞一个 File 再派发 change */
const pick = (name, bytes) => {
  const f = new window.File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
  Object.defineProperty(fileInput, "files", { value: [f], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
};

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log("  [PASS] " + name);
  else {
    console.log("  [FAIL] " + name + (detail === undefined ? "" : " —— " + detail));
    failed++;
  }
};

console.log("大文件确认流：硬上限拒绝（默认回退 5MB）");

pick("超大文件.jpg", 6 * 1024 * 1024);
await settle();
check("超过单文件上限：红色报错且带可操作建议", msgEl.classList.contains("is-error") && msgEl.textContent.includes("超过单文件上限 5.0 MB") && msgEl.textContent.includes("外部地址"), msgEl.textContent);
check("超过单文件上限：不出确认栏（直接拒，不给确认机会）", !attach.querySelector("[data-attach-confirm]"));
check("超过单文件上限：不加附件行", !attach.querySelector(".caldav-attach-row--bin"));
check("提示语显示默认回退上限 5.0 MB", hintEl.textContent.includes("单个文件上限 5.0 MB"), hintEl.textContent.slice(0, 80));

console.log("\n大文件确认流：设置改大后放行 + 提示语实时刷新（雄哥报的场景）");

plugin.store.settings.accounts[0].attachSizeMaxMB = 7; // 等价于设置弹窗保存（2026-10-26 起上限在账户上）
pick("超大文件.jpg", 6 * 1024 * 1024);
await settle();
const bar = attach.querySelector("[data-attach-confirm]");
check("上限改 7MB 后 6MB 文件放行（出确认栏）", !!bar);
check(
  "提示语实时刷新成 7.0 MB（开弹窗时还是 5.0 的快照）",
  hintEl.textContent.includes("单个文件上限 7.0 MB"),
  hintEl.textContent.slice(0, 80)
);

console.log("\n大文件确认流：确认栏文案只说一遍、且不是错误样式");

const nameCount = (attach.textContent.match(/超大文件.jpg/g) || []).length;
check("文件名在整个附件区只出现一遍（不再重复提示）", nameCount === 1, `实际 ${nameCount} 遍`);
check("确认期间 msg 行为空（没有并排的红色说明）", msgEl.textContent === "" && !msgEl.classList.contains("is-error"), JSON.stringify(msgEl.textContent));
check("确认栏自带说明文与询问", !!bar && bar.textContent.includes("体积会涨") && bar.textContent.includes("仍要内联吗"), bar && bar.textContent);
check(
  "确认栏是建议口吻（「当前为 X」「建议不超过」，不写「超过 N」）",
  !!bar && bar.textContent.includes("当前为") && bar.textContent.includes("建议不超过") && !bar.textContent.includes("，超过"),
  bar && bar.textContent
);
check("确认栏有确定/取消两个按钮", !!bar?.querySelector("[data-attach-confirm-ok]") && !!bar?.querySelector("[data-attach-confirm-no]"));

console.log("\n大文件确认流：取消");

click(bar.querySelector("[data-attach-confirm-no]"));
await settle();
check("取消后确认栏消失", !attach.querySelector("[data-attach-confirm]"));
check("取消提示是中性的（不是红色错误）", msgEl.textContent === "已取消上传" && !msgEl.classList.contains("is-error"), JSON.stringify(msgEl.textContent));
check("取消后没有加附件", !attach.querySelector(".caldav-attach-row--bin"));

console.log("\n大文件确认流：确认上传 → 附件真的加进来");

pick("南坞古道.jpg", 900 * 1024);
await settle();
const bar2 = attach.querySelector("[data-attach-confirm]");
click(bar2.querySelector("[data-attach-confirm-ok]"));
// base64 读取是异步的，等二进制行出现
for (let i = 0; i < 50 && !attach.querySelector(".caldav-attach-row--bin"); i++) await settle(1);
const binRow = attach.querySelector(".caldav-attach-row--bin");
check("确认后二进制行出现", !!binRow);
check("二进制行显示文件名", !!binRow && binRow.textContent.includes("南坞古道.jpg"), binRow && binRow.textContent);
check("提示「已添加」且不是错误", msgEl.textContent.includes("已添加") && !msgEl.classList.contains("is-error"), JSON.stringify(msgEl.textContent));

console.log("\n大文件确认流：没点确认又选新文件 → 旧的作废");

pick("甲.jpg", 900 * 1024);
await settle();
pick("乙.jpg", 900 * 1024);
await settle();
const bars = attach.querySelectorAll("[data-attach-confirm]");
check("连续选两个大文件只留一个确认栏（不叠第二条）", bars.length === 1, `实际 ${bars.length} 个`);
check("确认栏换成新文件", bars.length === 1 && bars[0].textContent.includes("乙.jpg") && !bars[0].textContent.includes("甲.jpg"), bars[0] && bars[0].textContent);
// 新 pick 会先把 msg 清空；旧确认被作废时**不该**再往里写东西
// （回退成布尔判断时旧 handler 会走取消分支刷「已取消上传」，正好被这条抓住）
check("被作废的旧确认不写消息（不刷「已取消上传」）", msgEl.textContent === "" && !msgEl.classList.contains("is-error"), JSON.stringify(msgEl.textContent));
click(attach.querySelector("[data-attach-confirm-no]")); // 收尾清掉
await settle();

console.log("\n大文件确认流：保存不再等上传（窗口假死回归，2026-10-15 实测）");

// 上传永不完成（模拟服务端卡死）：旧代码 `await updateItem().then(() => dialog.destroy())`
// 会把窗口冻到超时；新代码本地落盘后立即关窗，上传走后台推送队列。
const realUpdate = plugin.sync.updateItem.bind(plugin.sync);
plugin.sync.updateItem = () => new Promise(() => {});
click(editorEl.querySelector('[data-action="save"]'));
// Dialog.destroy() 的移除定时器是 15ms（桩里 __syDialogCloseDelay），settle 每轮 20ms
await settle(10);
check("上传挂起时点保存，窗口立即关闭（不再假死）", !editorEl.isConnected, "editorEl 还留在文档里 —— 保存又被同步等待卡住了");
plugin.sync.updateItem = realUpdate;

// 切视图会留下 350ms 的 openPanelTab 定时器，跑完再退，别让它成为 unhandled rejection
await settle(20);

if (failed) {
  console.log(`[attach-confirm] ${failed} 项未过`);
  process.exit(1);
}
console.log("[attach-confirm] 大文件确认流实测通过（只说一遍 / 实时刷新 / 三态 / 硬上限拒绝）");
