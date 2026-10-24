/**
 * 日程 / 待办编辑弹窗（基于思源 Dialog）
 */
import { Dialog, showMessage } from "siyuan";
import { newDialog } from "@/ui/dialog";
import { isMobile } from "./device";
import { adoptMobileLayer } from "./mobile-layers";
import type { Alarm, CalAttachment, CalCalendar, CalItem, CalKind, CategoryDef, Recurrence } from "../core/types";
import { DEFAULT_CATEGORIES, calEventColor } from "../core/types";
import { addDays, defaultStartStamp, isDateOnly, parseLocalStamp, stampOfMs, todayStamp } from "../core/date";
import { attachSizeMaxBytes, convertItemKind, icsSizeMaxBytes, itemToEditedICS } from "../core/ics";
import type { PanelCtx } from "./panel";
import { escape } from "./view-common";
import { icons } from "./icons";
import { enableDialogResize } from "./dialog-resize";
import { openCategoryManager } from "./category-manager";

/** 超过这个大小的文件，上传前要先跟用户确认（字节）。内联进 ICS 后体积涨 1/3，且每次编辑都重传 */
export const ATTACH_SIZE_WARN = 800 * 1024;

export interface EditorPreset {
  item?: CalItem; // 编辑现有条目
  kind?: CalKind; // 新建时的种类
  start?: string; // 新建时的开始
  end?: string;
}

export function openEditor(ctx: PanelCtx, preset: EditorPreset): void {
  const editing = preset.item;
  const kind: CalKind = editing ? editing.kind : preset.kind || "event";
  const cals = ctx.store.settings.calendars;
  if (!cals.length) {
    alert("请先在设置中配置并发现 CalDAV 日历");
    return;
  }
  const defaultCal =
    cals.find((c) => c.url === ctx.store.settings.defaultCalendarUrl) ||
    cals.find((c) => c.enabled) ||
    cals[0];

  const isNew = !editing;
  // 新建时的默认开始时间：日期是今天就落在「下一个整点」，其它日期落在当天 09:00
  const newStart = defaultStartStamp(preset.start || todayStamp());
  const it: CalItem = editing
    ? { ...editing }
    : {
        uid: genUid(),
        kind,
        calendarUrl: defaultCal.url,
        href: defaultCal.url.replace(/\/+$/, "") + "/" + genUid() + ".ics",
        summary: "",
        allDay: false,
        start: newStart,
        end: preset.end || addHoursStr(newStart, 1),
        priority: 0,
        status: "NEEDS-ACTION",
        percent: 0,
        createdAt: todayStamp() + "T" + new Date().toTimeString().slice(0, 8)
      };
  // 待办新建时的默认截止：**开始时间 + 8 小时**（2026-10-21 雄哥要求，取代原先的「次日」；与 Obsidian 侧一致）。
  // 定时待办：截止 = 开始 + 8h；全天待办（默认均为定时，极少走到）沿用次日，避免 end=start 的无效值。用户仍可清空或自行修改。
  if (kind === "todo" && isNew) it.end = it.allDay ? addDays(it.start, 1) : addHoursStr(it.start, 8);

  const isTodo = it.kind === "todo";
  // 移动端竖屏（375~430px）放不下 520/560px 定宽弹窗，改为占满视口
  const mobile = isMobile();

  const dialog = newDialog({
    title: isNew ? (isTodo ? "新建待办" : "新建日程") : "编辑" + (isTodo ? "待办" : "日程"),
    content: `<div class="caldav-editor">${editorHtml(
      it,
      cals,
      ctx.store.settings.categories?.length ? ctx.store.settings.categories : DEFAULT_CATEGORIES,
      !!ctx.store.settings.categoryMulti,
      isNew,
      attachSizeMaxBytes(ctx.store.settings),
      ctx.store.settings.serverType === "icloud"
    )}</div>`,
    width: mobile ? "100vw" : isTodo ? "560px" : "520px",
    height: mobile ? "100vh" : "86vh",
    containerClassName: mobile ? "caldav-mobile-dialog" : undefined
  });
  // 移动端：编辑弹窗是「叠在当前页面之上」的一层，同时只留一个。
  // 层的收放一律以 DOM 为准（见 ui/mobile-layers.ts），关闭时不需要再回账。
  adoptMobileLayer(dialog, "sheet");
  const el = dialog.element.querySelector(".caldav-editor") as HTMLElement;
  enableDialogResize(dialog);
  bindEvents(ctx, dialog, el, it, isNew);
}

function addHoursStr(stamp: string, hours: number): string {
  const d = parseLocalStamp(stamp);
  if (isDateOnly(stamp)) return stamp;
  return stampOfMsLocal(d.getTime() + hours * 3600000);
}

function stampOfMsLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function genUid(): string {
  return "sy-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** 编辑器里的「日历身份色」= 该日历的日程默认色（拿不到就中性灰） */
function calColorOf(cals: CalCalendar[], selected: string): string {
  return calEventColor(cals.find((c) => c.url === selected));
}

function inputToInputValue(stamp: string, allDay: boolean): string {
  return allDay ? stamp.slice(0, 10) : stamp.slice(0, 16);
}

function computeDurationLabel(start: string, end: string | undefined, allDay: boolean): string {
  if (!end) return allDay ? "1 天" : "60 分钟";
  const s = parseLocalStamp(start).getTime();
  const e = parseLocalStamp(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return "—";
  if (allDay) {
    const days = Math.round((e - s) / 86400000);
    return `${Math.max(1, days)} 天`;
  }
  const mins = Math.max(0, Math.round((e - s) / 60000));
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  return `${mins} 分钟`;
}

function repeatSummary(r: Recurrence | undefined): string {
  if (!r) return "不重复";
  const freqText: Record<string, string> = { DAILY: "每天", WEEKLY: "每周", MONTHLY: "每月", YEARLY: "每年" };
  const base = freqText[r.freq] || r.freq;
  const interval = r.interval && r.interval > 1 ? `每 ${r.interval} ${r.freq === "DAILY" ? "天" : r.freq === "WEEKLY" ? "周" : r.freq === "MONTHLY" ? "月" : "年"}` : base;
  let end = "";
  if (r.count) end = `，共 ${r.count} 次`;
  if (r.until) end = `，至 ${r.until.slice(0, 10)}`;
  return interval + end;
}

/** 可选提醒提前量（分钟）。0 = 到点时 */
const ALARM_CHOICES = [0, 5, 10, 15, 30, 60, 1440];
/** 提醒最多几个：再多也没人看，顺带避免界面失控 */
const MAX_ALARMS = 8;

function alarmLabel(m: number): string {
  if (m === 0) return "到点时";
  if (m === 1440) return "提前 1 天";
  if (m === 60) return "提前 1 小时";
  return `提前 ${m} 分钟`;
}

/** 单个提醒行：下拉（沿用输入框包裹层，外观与其它字段一致）+ 行尾删除 */
function alarmRowHtml(m: number): string {
  const opts = ALARM_CHOICES.map(
    (v) => `<option value="${v}" ${v === m ? "selected" : ""}>${alarmLabel(v)}</option>`
  ).join("");
  return `<div class="caldav-alarm-row">
      <div class="caldav-field caldav-field-icon caldav-alarm-field">
        <div class="caldav-input-wrap">
          <span class="caldav-input-icon">${icons.bell}</span>
          <select class="caldav-input" data-alarm>${opts}</select>
          <span class="caldav-input-suffix">${icons.chevron}</span>
        </div>
      </div>
      <button type="button" class="caldav-alarm-del" data-action="del-alarm" title="删除这个提醒">${icons.trash}</button>
    </div>`;
}

/** 常用组合：点一下整组加入（已存在的自动跳过） */
const ALARM_PRESETS: { label: string; values: number[] }[] = [
  { label: "提前 1 天 + 提前 1 小时 + 到点时", values: [1440, 60, 0] },
  { label: "提前 15 分钟 + 到点时", values: [15, 0] },
  { label: "提前 1 天 + 提前 30 分钟", values: [1440, 30] }
];

/**
 * 提醒列表的交互：加一行 / 删一行 / 展开预设组合。
 *
 * 背景：这两个按钮（添加提醒时间、添加预设）从首个版本起就只有 HTML、**没有任何处理器**，
 * 点了必然没反应。底层数据模型与提醒引擎一直支持多个提醒，这里把编辑器补齐。
 */
function wireAlarms(el: HTMLElement, errEl: HTMLElement): void {
  const list = el.querySelector<HTMLElement>("[data-alarm-list]");
  const addBtn = el.querySelector<HTMLButtonElement>('[data-action="add-alarm"]');
  const presetBtn = el.querySelector<HTMLButtonElement>('[data-action="add-preset"]');
  const presetPop = el.querySelector<HTMLElement>("[data-alarm-presets]");
  if (!list || !addBtn) return;
  const empty = el.querySelector<HTMLElement>("[data-alarm-empty]");

  const usedValues = () =>
    Array.from(list.querySelectorAll<HTMLSelectElement>("select[data-alarm]")).map((s) => +s.value);
  const syncEmpty = () => {
    if (empty) empty.hidden = list.children.length > 0;
  };
  const flashError = (msg: string) => {
    errEl.textContent = msg;
    setTimeout(() => {
      if (errEl.textContent === msg) errEl.textContent = "";
    }, 2500);
  };
  /** 新行默认值：优先「提前 15 分钟」，已被占用则依次退让，避免一加就重复 */
  const pickDefault = () => {
    const u = new Set(usedValues());
    return [15, 60, 1440, 5, 30, 10, 0].find((m) => !u.has(m)) ?? 15;
  };
  const appendRow = (m: number): boolean => {
    if (list.children.length >= MAX_ALARMS) {
      flashError(`最多添加 ${MAX_ALARMS} 个提醒`);
      return false;
    }
    list.insertAdjacentHTML("beforeend", alarmRowHtml(m));
    syncEmpty();
    return true;
  };

  addBtn.addEventListener("click", () => {
    if (presetPop) presetPop.hidden = true;
    if (appendRow(pickDefault())) list.lastElementChild?.querySelector("select")?.focus();
  });

  presetBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation(); // 别让下面「点别处收起」的监听立刻把它关掉
    if (presetPop) presetPop.hidden = !presetPop.hidden;
  });

  presetPop?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-preset]");
    if (!btn) return;
    const preset = ALARM_PRESETS[+btn.dataset.preset!];
    for (const m of preset?.values || []) {
      if (usedValues().includes(m)) continue; // 已有的不重复加
      if (!appendRow(m)) break;
    }
    presetPop.hidden = true;
  });

  list.addEventListener("click", (ev) => {
    const del = (ev.target as HTMLElement).closest<HTMLElement>('[data-action="del-alarm"]');
    if (!del) return;
    del.closest(".caldav-alarm-row")?.remove();
    syncEmpty();
  });

  // 点卡片里别的地方收起预设浮层（el 随弹窗创建、销毁时一起丢弃，不会累积监听）
  el.addEventListener("click", () => {
    if (presetPop) presetPop.hidden = true;
  });

  syncEmpty();
}

/** 从 URI 取文件名（附件行显示用；与 ics.ts 的 attachmentName 同口径） */
function nameOfUri(uri: string): string {
  const last = uri.split(/[?#]/)[0].split("/").filter(Boolean).pop();
  return last ? decodeURIComponent(last) : "附件";
}

/** base64 载荷的原始字节数（用于界面显示大小；不含折行空白） */
function b64Bytes(b64: string): number {
  const s = b64.replace(/\s+/g, "");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

/** 字节数 → 人话（1024 进制） */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** ArrayBuffer → base64。
 *
 *  必须分块拼字符串：`String.fromCharCode(...bytes)` 一次展开几十万个参数会爆栈
 *  （RangeError: Maximum call stack size exceeded），几百 KB 的文件就够触发。
 */
async function arrayBufferToBase64(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000; // 32K，远低于各引擎的展开上限
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 → 字节数组（附件下载用；与 arrayBufferToBase64 互逆）。
 *  atob 一次吃整个字符串没问题（5MB 附件 ≈ 6.7MB 字符，Chromium 无压力）。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 下载文件名净化：路径分隔符/通配符/控制字符换成下划线。
 *  附件名可能来自服务端任意客户端（甚至手改过的 ICS），带 "/" 时 a.download
 *  在部分平台上直接保存失败（2026-10-19 加，任务视图那版漏了这层）。 */
function safeAttachName(name: string): string {
  return (name || "附件").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "附件";
}

/** 把内联二进制附件下载回本地文件（2026-10-19 雄哥报「编辑待办里附件没法下载」）。
 *
 *  机制与 panel.ts 任务视图的 downloadAttachment 完全一致（atob → Blob →
 *  a[download]），两处差别只在反馈：编辑器用行内 setMsg，不用 alert。 */
function downloadAttachment(a: CalAttachment): void {
  const bytes = base64ToBytes(a.b64 || "");
  // ⚠️ TS 5.x 的 lib.dom 要求 BlobPart 绑定 ArrayBuffer：Uint8Array<ArrayBufferLike>
  // 直接传会报 TS2322（esbuild 不查类型所以 build 一直绿，tsc --noEmit 红）。
  // Obsidian 侧同代码已修，这里对齐（2026-10-20）。
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: a.fmttype || "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = safeAttachName(a.name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 马上 revoke 个别浏览器来不及发起下载，留一点时间再收
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** 把已取回的字节（iCloud 托管附件下载）落盘为本地文件，与 downloadAttachment 同款交互。 */
function downloadBytes(bytes: Uint8Array, a: CalAttachment): void {
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: a.fmttype || "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = safeAttachName(a.name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * 附件行的 HTML（2026-10-14）。
 *
 * 布局按雄哥示意图：**一行一个输入框 + 右侧「删除」**，下面跟操作按钮。
 * 刻意**不画「取消」**（示意图里那个是画多了）—— 删除是即时的行级操作，
 * 真要反悔就把链接删掉重新填，没有「取消」的必要。
 *
 * 两种行：
 *  - **URI 行**：input 里填外链；
 *  - **二进制行**：上传的本地文件转成 base64 内联进 ICS，没有可编辑的输入框，
 *    只显示**小图标 + 文件名 + 大小**（图标 14px），带「下载 / 删除」两个按钮
 *    （2026-10-19 补下载：雄哥报「已有附件没法下载」，此前只能上传不能取回）。
 *
 * ⚠️ 二进制行的图标尺寸只能靠 CSS（icons.ts 的 svg 一律不写 width/height 属性，
 * 见该文件顶部「宿主坑 2」的说明）。漏了 `.caldav-attach-bin svg { width/height }`
 * 时，浏览器把无尺寸的内联 svg 当 100% 宽算 —— 表现就是回形针巨化占满整行
 * （2026-10-14 雄哥截图报的正是这个）。
 *
 * 每行都带 `data-attach-i="下标"`。`atts` 数组是唯一事实来源，DOM 只是它的投影，
 * 增删改之后整份重绘，所以下标永远对得上。
 *
 * ⚠️ 二进制行**不能**把 base64 塞进 DOM 属性——800 KB 的文件就是 1 MB 的字符串，
 * 放进 attribute 会让整个编辑器 DOM 变得难以为继；base64 只活在 `atts` 里。
 */
function attachRowHtml(a: CalAttachment, i: number): string {
  const del = `<button type="button" class="caldav-btn caldav-btn--sm caldav-btn--danger" data-attach-del title="删除该附件">${icons.trash} 删除</button>`;
  if (a.b64) {
    const dl = `<button type="button" class="caldav-btn caldav-btn--sm" data-attach-dl title="下载该附件到本地">${icons.download} 下载</button>`;
    return `<div class="caldav-attach-row caldav-attach-row--bin" data-attach-i="${i}">
      <span class="caldav-attach-bin">${icons.paperclip}<span class="caldav-attach-bin-name">${escape(a.name || "附件")}</span><span class="caldav-attach-bin-size">${escape(sizeText(b64Bytes(a.b64)))}</span></span>
      ${dl}${del}
    </div>`;
  }
  return `<div class="caldav-attach-row" data-attach-i="${i}">
      <input class="caldav-input caldav-attach-input" data-attach-uri value="${escape(a.uri || "")}" placeholder="https://…" />
      ${
        // 托管附件（iCloud，带 MANAGED-ID）：文件在服务端托管存储里，插件能取回
        // 字节下载；纯外链没有可下载的内容，用户自己复制链接打开。
        a.managedId
          ? `<button type="button" class="caldav-btn caldav-btn--sm" data-attach-dl title="下载该附件到本地">${icons.download} 下载</button>`
          : ""
      }${del}
    </div>`;
}

function attachRowsHtml(list: CalAttachment[]): string {
  if (!list.length) {
    return `<div class="caldav-attach-empty">暂无附件</div>`;
  }
  return list.map(attachRowHtml).join("");
}

/**
 * 附件区顶部提示语。抽成函数是为了**实时刷新**：editorHtml 渲染时的上限是
 * 开弹窗那一刻的快照，用户在设置里把上限从 5 改到 7 之后，旧弹窗的提示语
 * 还挂着 5.0 MB，看着就像设置没生效（2026-10-15 雄哥报的就是这个）。
 * 挑选文件时按当前设置重写一次，显示的上限与实际校验的上限就一致了。
 */
function attachHintHtml(maxBytes: number, isIcloud?: boolean): string {
  if (isIcloud) {
    return (
      `上传的文件会存进 iCloud 的托管附件空间（苹果官方附件机制，iPhone/iPad 的提醒事项同样走它），` +
      `待办里只记托管链接，不再内联进日历；也可直接粘贴外链。` +
      `单个文件上限 ${sizeText(maxBytes)}（上限可在设置里调整），超过 ${sizeText(ATTACH_SIZE_WARN)} 会先跟你确认。`
    );
  }
  return (
    `上传的文件会转成 base64 内联进待办、随日历一起同步（RFC 5545 标准形式，任何客户端都能读）；也可直接粘贴外链。` +
    `单个文件上限 ${sizeText(maxBytes)}（再大服务器会拒收，上限可在设置里调整），超过 ${sizeText(ATTACH_SIZE_WARN)} 会先跟你确认。`
  );
}

/**
 * 大文件上传前的确认（行内确认栏，**不用 confirm()**）。
 *
 * 项目约定不用 confirm()：原生确认框在思源里样式割裂、移动端体验也差。
 * 这里在附件区尾部挂一条确认栏，Promise 等用户点，用完即撤。
 *
 * ⚠️ 文件信息和「为什么要确认」**只在本栏说一遍**（2026-10-15 雄哥截图报的
 *    重复提示）：早先挑选 handler 还先 setMsg 一段红色说明，同样的文件名/大小/
 *    阈值连着出现两遍，一次普通确认被做成了报错的样子。现在挑选侧不再预发消息，
 *    确认栏也走中性色（--caldav-accent），红色只留给真错误（硬上限拒绝）。
 *
 * 返回值的第三种状态：没点确认就又选了一个大文件 → 上一条作废
 * （resolve("superseded")）。不撤的话旧 Promise 永远悬挂、旧 handler 永远不返回。
 */
type ConfirmLargeFileResult = "ok" | "cancel" | "superseded";
let cancelPendingConfirm: (() => void) | null = null;
function confirmLargeFile(host: HTMLElement, file: File, isIcloud = false): Promise<ConfirmLargeFileResult> {
  return new Promise((resolve) => {
    cancelPendingConfirm?.(); // 上一次没确认就选了新文件 → 作废上一条
    host.querySelector("[data-attach-confirm]")?.remove(); // 别叠第二条
    const bar = document.createElement("div");
    bar.className = "caldav-attach-confirm";
    bar.setAttribute("data-attach-confirm", "");
    const text = document.createElement("span");
    text.className = "caldav-attach-confirm-text";
    // iCloud 托管上传没有「内联涨 1/3、每次编辑重传」的问题（文件在托管存储里，
    // ICS 只记链接），确认文案按实际行为写，不制造不存在的担忧。
    text.textContent = isIcloud
      ? `「${file.name}」当前为 ${sizeText(file.size)}，附件建议不超过 ${sizeText(ATTACH_SIZE_WARN)}。仍要上传到 iCloud 吗？`
      : `「${file.name}」当前为 ${sizeText(file.size)}，附件建议不超过 ${sizeText(ATTACH_SIZE_WARN)}。` +
        `内联进日历后体积会涨约 1/3，每次编辑这个待办都会重传一遍。仍要内联吗？`;
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "caldav-btn caldav-btn--sm caldav-btn--primary";
    ok.setAttribute("data-attach-confirm-ok", "");
    ok.textContent = "确定上传";
    const no = document.createElement("button");
    no.type = "button";
    no.className = "caldav-btn caldav-btn--sm";
    no.setAttribute("data-attach-confirm-no", "");
    no.textContent = "取消";
    bar.append(text, ok, no);
    const done = (r: ConfirmLargeFileResult): void => {
      cancelPendingConfirm = null;
      bar.remove();
      resolve(r);
    };
    cancelPendingConfirm = () => done("superseded");
    ok.addEventListener("click", () => done("ok"));
    no.addEventListener("click", () => done("cancel"));
    host.appendChild(bar);
    ok.focus();
  });
}

function editorHtml(
  it: CalItem,
  cals: CalCalendar[],
  cats: CategoryDef[],
  catMulti: boolean,
  isNew: boolean,
  attachMaxBytes: number,
  isIcloud: boolean
): string {
  const isTodo = it.kind === "todo";
  const r = it.rrule;
  const startDate = it.start.slice(0, 10);
  const startTime = it.allDay ? "" : it.start.slice(11, 16);
  const endDate = it.end ? it.end.slice(0, 10) : "";
  const endTime = it.end && !it.allDay ? it.end.slice(11, 16) : "";
  const initialDuration = computeDurationLabel(it.start, it.end || it.start, it.allDay);
  const alarmRows = (it.alarms || []).map((a) => alarmRowHtml(a.minutesBefore)).join("");

  return `
<div class="caldav-editor-head">
  <div class="caldav-tabs">
    <button class="caldav-tab is-active" data-tab="basic">${isTodo ? "任务设置" : "日程设置"}</button>
    <button class="caldav-tab" data-tab="note">${isTodo ? "备注附件" : "日程备注"}</button>
  </div>
</div>

<div class="caldav-editor-form">
  <div class="caldav-tab-panel" data-panel="basic">
    <div class="caldav-section">
      <div class="caldav-title-head">
        <label class="caldav-field-label caldav-title-label">${isTodo ? "待办标题" : "事件标题"}</label>
        <label class="caldav-switch-line caldav-title-aiparse">
          <span class="caldav-switch-label">粘贴自动识别日期</span>
          <span class="caldav-switch">
            <input type="checkbox" data-f="aiParse" ${it.aiParse === false ? "" : "checked"}/>
            <span class="caldav-switch-track"></span>
          </span>
        </label>
        <div class="caldav-title-cal">
          <span class="caldav-title-cal-label">日历</span>
          <div class="caldav-input-wrap caldav-cal-wrap" style="--cal-color:${escape(calColorOf(cals, it.calendarUrl))}">
            <span class="caldav-input-icon caldav-input-icon--static caldav-cal-icon">${icons.calendar}</span>
            <input type="hidden" data-f="calendar" value="${escape(it.calendarUrl)}"/>
            <button type="button" class="caldav-input caldav-cal-trigger" data-action="cal-toggle">
              <span class="caldav-cal-name">${escape(cals.find((c) => c.url === it.calendarUrl)?.displayName || it.calendarUrl)}</span>
              <span class="caldav-input-suffix">${icons.chevron}</span>
            </button>
            <div class="caldav-cal-pop" data-cal-pop hidden>
              ${cals
                .map(
                  (c) =>
                    `<button type="button" class="caldav-cal-option ${c.url === it.calendarUrl ? "is-active" : ""}" data-cal-url="${escape(c.url)}"><span class="caldav-cal-dot" style="background:${escape(calEventColor(c))}"></span>${escape(c.displayName)}</button>`
                )
                .join("")}
            </div>
          </div>
        </div>
      </div>
      <div class="caldav-title-row">
        <div class="caldav-input-wrap caldav-title-wrap">
          <input class="caldav-input caldav-title-input" data-f="summary" placeholder="${isTodo ? "请输入待办标题" : "请输入事件标题"}" value="${escape(it.summary)}"/>
          <button type="button" class="caldav-input-suffix caldav-title-action" data-action="ai-parse" title="自动识别标题中的日期时间">${icons.sparkle}</button>
        </div>
      </div>
    </div>

    <div class="caldav-section caldav-section--card">
      <div class="caldav-section-title"><span class="caldav-section-icon">${icons.clock}</span>日期时间</div>
      <div class="caldav-all-day-row">
        <label class="caldav-switch-line caldav-all-day-switch">
          <span class="caldav-switch-label">全天</span>
          <span class="caldav-switch">
            <input type="checkbox" data-f="allDay" ${it.allDay ? "checked" : ""}/>
            <span class="caldav-switch-track"></span>
          </span>
        </label>
        <button type="button" class="caldav-all-day-clear" data-clear-datetime title="清除日期时间">
          ${icons.trash}<span>清除日期时间</span>
        </button>
        <div class="caldav-duration-row caldav-duration-row--inline" ${isTodo || it.allDay ? 'style="display:none"' : ""}>
          <span class="caldav-datetime-label">持续</span>
          <span class="caldav-duration-val" data-duration>${initialDuration}</span>
        </div>
      </div>

      <div class="caldav-datetime-row">
        <span class="caldav-datetime-label">开始</span>
        <div class="caldav-datetime-inputs">
          <div class="caldav-input-wrap caldav-input-wrap--date">
            <span class="caldav-input-icon">${icons.calendar}</span>
            <input class="caldav-input caldav-date-input" data-f="startDate" type="date" value="${startDate}"/>
          </div>
          <button type="button" class="caldav-input-clear" data-clear="startDate" title="清除日期">${icons.trash}</button>
          <div class="caldav-input-wrap caldav-input-wrap--time" ${it.allDay ? 'style="display:none"' : ""}>
            <input type="hidden" data-f="startTime" value="${startTime}"/>
            <button type="button" class="caldav-input caldav-time-trigger" data-time="startTime">
              <span class="caldav-input-icon">${icons.clock}</span>
              <span class="caldav-time-text" data-time-text="startTime">${startTime || "--:--"}</span>
            </button>
            <div class="caldav-time-pop" data-time-pop="startTime" hidden></div>
          </div>
          <button class="caldav-input-clear caldav-input-clear--time" data-clear="startTime" title="清除时间" ${it.allDay ? 'style="display:none"' : ""}>${icons.trash}</button>
        </div>
      </div>

      <div class="caldav-datetime-row">
        <span class="caldav-datetime-label">结束</span>
        <div class="caldav-datetime-inputs">
          <div class="caldav-input-wrap caldav-input-wrap--date">
            <span class="caldav-input-icon">${icons.calendar}</span>
            <input class="caldav-input caldav-date-input" data-f="endDate" type="date" value="${endDate}"/>
          </div>
          <button type="button" class="caldav-input-clear" data-clear="endDate" title="清除日期">${icons.trash}</button>
          <div class="caldav-input-wrap caldav-input-wrap--time" ${it.allDay ? 'style="display:none"' : ""}>
            <input type="hidden" data-f="endTime" value="${endTime}"/>
            <button type="button" class="caldav-input caldav-time-trigger" data-time="endTime">
              <span class="caldav-input-icon">${icons.clock}</span>
              <span class="caldav-time-text" data-time-text="endTime">${endTime || "--:--"}</span>
            </button>
            <div class="caldav-time-pop" data-time-pop="endTime" hidden></div>
          </div>
          <button class="caldav-input-clear caldav-input-clear--time" data-clear="endTime" title="清除时间" ${it.allDay ? 'style="display:none"' : ""}>${icons.trash}</button>
        </div>
      </div>
    </div>

    <div class="caldav-section caldav-section--card">
      <div class="caldav-section-title"><span class="caldav-section-icon">${icons.bell}</span>提醒设置</div>
      <div class="caldav-alarm-list" data-alarm-list>${alarmRows}</div>
      <div class="caldav-alarm-empty" data-alarm-empty ${alarmRows ? "hidden" : ""}>未设置提醒时间（到点时不会提醒）</div>
      <div class="caldav-alarm-actions">
        <button type="button" class="caldav-add-btn" data-action="add-alarm">${icons.plus} 添加提醒时间</button>
        <button type="button" class="caldav-add-btn" data-action="add-preset">${icons.layers} 添加预设</button>
        <div class="caldav-alarm-presets" data-alarm-presets hidden>
          <div class="caldav-alarm-presets-hint">常用组合，点一下整组加入</div>
          ${ALARM_PRESETS.map(
            (p, i) =>
              `<button type="button" class="caldav-alarm-preset" data-preset="${i}">${escape(p.label)}<span>加 ${p.values.length} 个</span></button>`
          ).join("")}
        </div>
      </div>
    </div>

    <div class="caldav-section caldav-section--card">
      <div class="caldav-section-title"><span class="caldav-section-icon">${icons.repeat}</span>重复设置</div>
      <button type="button" class="caldav-row-btn" data-action="toggle-repeat-detail">
        <span class="caldav-row-btn-text">${repeatSummary(r)}</span>
        <span class="caldav-row-btn-arrow">${icons.chevron}</span>
      </button>
      <div class="caldav-row-detail" data-detail="repeat" style="display:${r ? "block" : "none"}">
        <label class="caldav-switch-line caldav-switch-line--inline">
          <span class="caldav-switch-label">启用重复</span>
          <span class="caldav-switch">
            <input type="checkbox" data-f="repeatOn" ${r ? "checked" : ""}/>
            <span class="caldav-switch-track"></span>
          </span>
        </label>
        <div class="caldav-repeat-fields" style="display:${r ? "flex" : "none"}">
          <select class="caldav-input" data-f="freq">
            <option value="DAILY" ${r?.freq === "DAILY" ? "selected" : ""}>每天</option>
            <option value="WEEKLY" ${r?.freq === "WEEKLY" || !r ? "selected" : ""}>每周</option>
            <option value="MONTHLY" ${r?.freq === "MONTHLY" ? "selected" : ""}>每月</option>
            <option value="YEARLY" ${r?.freq === "YEARLY" ? "selected" : ""}>每年</option>
          </select>
          <input class="caldav-input caldav-num" data-f="interval" type="number" min="1" value="${r?.interval || 1}" title="间隔"/>
          <div class="caldav-weekdays">${["一", "二", "三", "四", "五", "六", "日"]
            .map((l, i) => {
              const code = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][i];
              return `<label class="caldav-wd ${r?.byDay?.includes(code) ? "is-on" : ""}" data-wd="${code}">${l}</label>`;
            })
            .join("")}</div>
          <select class="caldav-input" data-f="endMode">
            <option value="never" ${!r?.count && !r?.until ? "selected" : ""}>永不结束</option>
            <option value="count" ${r?.count ? "selected" : ""}>次数</option>
            <option value="until" ${r?.until ? "selected" : ""}>日期</option>
          </select>
          <input class="caldav-input caldav-num" data-f="count" type="number" min="1" value="${r?.count || 10}" style="display:${r?.count ? "" : "none"}"/>
          <input class="caldav-input" data-f="until" type="date" value="${r?.until ? r.until.slice(0, 10) : ""}" style="display:${r?.until ? "" : "none"}"/>
        </div>
      </div>
    </div>

    <div class="caldav-section caldav-section--card">
      <div class="caldav-section-title"><span class="caldav-section-icon">${icons.layers}</span>更多信息</div>
      <div class="caldav-field caldav-field-icon">
        <label class="caldav-field-label">${icons.pin} 地点</label>
        <div class="caldav-input-wrap">
          <span class="caldav-input-icon">${icons.pin}</span>
          <input class="caldav-input" data-f="location" value="${escape(it.location || "")}" placeholder="可选"/>
        </div>
      </div>
      ${
        isTodo
          ? `<div class="caldav-field-row">
        <div class="caldav-field caldav-field-icon">
          <label class="caldav-field-label">${icons.flag} 优先级</label>
          <div class="caldav-input-wrap">
            <span class="caldav-input-icon">${icons.flag}</span>
            <select class="caldav-input" data-f="priority">
              <option value="0" ${!it.priority ? "selected" : ""}>无</option>
              <option value="9" ${it.priority === 9 ? "selected" : ""}>低</option>
              <option value="5" ${it.priority === 5 ? "selected" : ""}>中</option>
              <option value="3" ${it.priority === 3 ? "selected" : ""}>高</option>
              <option value="1" ${it.priority === 1 ? "selected" : ""}>紧急</option>
            </select>
            <span class="caldav-input-suffix">${icons.chevron}</span>
          </div>
        </div>
        <div class="caldav-field">
          <label class="caldav-field-label">进度</label>
          <div class="caldav-progress-row">
            <input type="range" data-f="percent" min="0" max="100" step="10" value="${it.percent ?? 0}"/>
            <span class="caldav-progress-val">${it.percent ?? 0}%</span>
          </div>
        </div>
      </div>`
          : ""
      }
      <div class="caldav-field">
        <div class="caldav-cat-head">
          <label class="caldav-field-label">${icons.tag} 任务分类</label>
          <button type="button" class="caldav-cat-manage" data-action="cat-manage" title="管理分类">${icons.gear}</button>
          <label class="caldav-cat-multi" title="允许多选">
            <span class="caldav-switch">
              <input type="checkbox" data-f="catMulti" ${catMulti ? "checked" : ""}/>
              <span class="caldav-switch-track"></span>
            </span>
            多选
          </label>
        </div>
        <input type="hidden" data-f="categories" value="${escape((it.categories || []).join(","))}"/>
        <div class="caldav-cat-pills" data-cat-pills>
          <button type="button" class="caldav-cat-pill caldav-cat-pill--none" data-cat="">
            <span class="caldav-cat-check">${icons.check}</span>无分类
          </button>
          ${cats
            .map(
              (c) =>
                `<button type="button" class="caldav-cat-pill" data-cat="${escape(c.name)}" style="--cat-color:${escape(c.color)}"><span class="caldav-cat-emoji">${escape(c.icon)}</span>${escape(c.name)}</button>`
            )
            .join("")}
        </div>
      </div>
    </div>
  </div>

  <div class="caldav-tab-panel" data-panel="note" style="display:none">
    <div class="caldav-section caldav-section--card">
      <div class="caldav-section-title"><span class="caldav-section-icon">${icons.doc}</span>备注</div>
      <textarea class="caldav-input caldav-textarea" data-f="description" rows="8" placeholder="添加备注...">${escape(it.description || "")}</textarea>
    </div>
    ${
      isTodo
        ? `<div class="caldav-section caldav-section--card caldav-attach" data-attach>
      <div class="caldav-section-title"><span class="caldav-section-icon">${icons.paperclip}</span>附件</div>
      <div class="caldav-attach-rows" data-attach-rows>
        ${attachRowsHtml(it.attachments || [])}
      </div>
      <div class="caldav-attach-actions">
        <input type="file" data-attach-file hidden />
        <button type="button" class="caldav-btn caldav-btn--sm" data-attach-upload>${icons.paperclip} 上传文件</button>
        <button type="button" class="caldav-btn caldav-btn--sm" data-attach-add>${icons.plus} 添加链接</button>
      </div>
      <div class="caldav-attach-hint" data-attach-hint>${attachHintHtml(attachMaxBytes, isIcloud)}</div>
      <div class="caldav-attach-msg" data-attach-msg></div>
    </div>`
        : ""
    }
  </div>
</div>

<div class="caldav-editor-foot">
  <div class="caldav-editor-error" data-error></div>
  ${!isNew ? `<button type="button" class="caldav-foot-btn caldav-foot-btn--danger" data-action="delete">${icons.trash} 删除</button>` : ""}
  ${!isNew ? `<button type="button" class="caldav-foot-btn caldav-foot-btn--convert" data-action="convert" title="转换为${it.kind === "todo" ? "日程" : "待办"}">${it.kind === "todo" ? icons.calendar + " 转为日程" : icons.tasks + " 转为待办"}</button>` : ""}
  <span class="caldav-flex"></span>
  <button type="button" class="caldav-foot-btn caldav-foot-btn--ghost" data-action="cancel">${icons.close} 取消</button>
  <button type="button" class="caldav-foot-btn caldav-foot-btn--primary" data-action="save">${icons.check} 保存</button>
</div>
</div>`;
}

function bindEvents(ctx: PanelCtx, dialog: Dialog, el: HTMLElement, it: CalItem, isNew: boolean): void {
  const isTodo = it.kind === "todo";
  const cals = ctx.store.settings.calendars;
  const f = (name: string) => el.querySelector(`[data-f="${name}"]`) as HTMLInputElement;
  const errEl = el.querySelector("[data-error]") as HTMLElement;

  // Tab 切换
  el.querySelectorAll<HTMLElement>(".caldav-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab!;
      el.querySelectorAll<HTMLElement>(".caldav-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === target));
      el.querySelectorAll<HTMLElement>(".caldav-tab-panel").forEach((p) => {
        (p as HTMLElement).style.display = p.dataset.panel === target ? "block" : "none";
      });
    });
  });

  // ---- 附件区（仅待办；2026-10-14）----
  // 提到外层：保存时（collectItem）要读它，而附件区只在待办下渲染。
  // `undefined` = 这次编辑没碰到附件（日程根本没有附件区），别去动 it.attachments。
  let attachList: CalAttachment[] | undefined;
  // 服务器类型决定附件行为：iCloud 走托管上传（不内联 base64），附件区文案、
  // 确认栏口径、保存时的体积预检都按它分叉（见 attachHintHtml /
  // confirmLargeFile / collectItem 的 isIcloud 分支）。放函数体作用域：
  // 附件区只在待办下渲染，但 collectItem 在块外也要用。
  const isIcloud = ctx.store.settings.serverType === "icloud";
  const attachRows = el.querySelector<HTMLElement>("[data-attach-rows]");
  if (attachRows) {
    const fileInput = el.querySelector<HTMLInputElement>("[data-attach-file]");
    const msgEl = el.querySelector<HTMLElement>("[data-attach-msg]");
    const hintEl = el.querySelector<HTMLElement>("[data-attach-hint]");
    // 提示语实时刷新：开弹窗后的上限快照会过期（设置里改大后旧弹窗仍显示老数字），
    // 每次挑选文件时按当前设置重写，保证显示与校验一致。
    const refreshHint = (): void => {
      if (hintEl) hintEl.innerHTML = attachHintHtml(attachSizeMaxBytes(ctx.store.settings), isIcloud);
    };
    const setMsg = (text: string, isErr = false): void => {
      if (!msgEl) return;
      msgEl.textContent = text;
      msgEl.classList.toggle("is-error", isErr);
    };
    /**
     * 附件列表：**唯一事实来源**。DOM 只是它的投影（见 attachRowHtml）。
     * 初始值来自条目本身；之后所有增删改都改这个数组再整份重绘。
     */
    let atts: CalAttachment[] = (it.attachments || []).map((a) => ({ ...a }));
    attachList = atts;
    const redraw = (): void => {
      attachRows.innerHTML = attachRowsHtml(atts);
    };

    // 输入即时同步回 atts（保存时直接读数组，不再从 DOM 反推）
    attachRows.addEventListener("input", (e) => {
      const inp = e.target as HTMLInputElement;
      if (!inp.matches("[data-attach-uri]")) return;
      const row = inp.closest<HTMLElement>("[data-attach-i]");
      const i = row ? Number(row.dataset.attachI) : -1;
      if (i < 0 || i >= atts.length) return;
      const uri = inp.value.trim();
      // 保留 fmttype / b64，只换 uri；文件名跟着 URI 变（用户贴的链接可能就是文件名）
      atts[i] = { ...atts[i], uri, name: uri ? nameOfUri(uri) : atts[i].name };
    });

    // 下载：二进制行（内联件）本地解码；托管附件行（iCloud 等带 MANAGED-ID）走
    // 同步层从服务端取回原始字节（需要鉴权，且二进制不能被 utf8 文本化破坏）。
    attachRows.addEventListener("click", async (e) => {
      const dlBtn = (e.target as HTMLElement).closest<HTMLElement>("[data-attach-dl]");
      if (dlBtn) {
        const row = dlBtn.closest<HTMLElement>("[data-attach-i]");
        const i = row ? Number(row.dataset.attachI) : -1;
        const a = i >= 0 && i < atts.length ? atts[i] : undefined;
        if (a?.b64) {
          try {
            downloadAttachment(a);
            setMsg(`已开始下载「${a.name || "附件"}」`);
          } catch (err) {
            setMsg(err instanceof Error ? err.message : String(err), true);
          }
        } else if (a?.uri) {
          try {
            setMsg(`正在从服务器取回「${a.name || "附件"}」…`);
            const bytes = await ctx.sync.fetchAttachmentBytes(a.uri);
            downloadBytes(bytes, a);
            setMsg(`已开始下载「${a.name || "附件"}」`);
          } catch (err) {
            setMsg(err instanceof Error ? err.message : String(err), true);
          }
        }
        return;
      }
      // 删除：行级即时操作，不需要确认（删错了可以再加回来）
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-attach-del]");
      if (!btn) return;
      const row = btn.closest<HTMLElement>("[data-attach-i]");
      const i = row ? Number(row.dataset.attachI) : -1;
      if (i >= 0 && i < atts.length) atts.splice(i, 1);
      redraw();
      setMsg("");
    });

    // 手工加一行空链接（服务端已有链接、或用户想贴外链）
    el.querySelector("[data-attach-add]")?.addEventListener("click", () => {
      atts.push({ uri: "", name: "附件" });
      redraw();
      const last = attachRows.querySelectorAll<HTMLInputElement>("[data-attach-uri]");
      last[last.length - 1]?.focus();
    });

    // 上传：读本地文件 → base64 → 内联进条目（不再单独 HTTP 上传）
    el.querySelector("[data-attach-upload]")?.addEventListener("click", () => fileInput?.click());
    fileInput?.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = ""; // 允许连续选同一个文件
      if (!file) return;
      // 硬上限：超过直接拒绝，连确认都不给。服务端普遍限制单条日历数据大小
      // （Radicale 默认 10MB、PHP 默认 post_max_size 8MB），base64 还要涨 1/3 ——
      // 放进去的结果只有一个：这个待办永远 413 同步不过（2026-10-15 74MB 实测）。
      // 上限取自设置（附件大小限制），老数据缺省回默认 5MB。
      //
      // ⚠️ 提示语在这里**实时重算**（2026-10-15 雄哥报「改了 7M 还提示 5M」）：
      //    editorHtml 渲染时的上限是开弹窗那一刻的快照，用户在设置里改大上限后，
      //    旧弹窗的提示语还挂着老数字，看着就像设置没生效。挑选这一刻按当前
      //    设置重写提示语，保证「显示的上限」与「实际校验的上限」永远一致。
      const maxBytes = attachSizeMaxBytes(ctx.store.settings);
      refreshHint();
      if (file.size > maxBytes) {
        setMsg(
          `「${file.name}」${sizeText(file.size)}，超过单文件上限 ${sizeText(maxBytes)}，服务器会拒绝接收。请压缩后重试，或改用「添加链接」引用外部地址。`,
          true
        );
        return;
      }
      // 大文件先确认：内联后体积涨 1/3，且每次编辑都会把整份 ICS（含这个 base64）
      // 重传一遍。小文件无所谓，大的必须让用户知情。
      // ⚠️ 只由确认栏说话（2026-10-15 雄哥截图报的重复提示）：这里不再预发
      //     setMsg，文件信息连报两遍还把普通确认渲染成了报错的样子；说明文
      //     全部并进确认栏（见 confirmLargeFile），红色只留给上面的硬上限拒绝。
      if (file.size > ATTACH_SIZE_WARN) {
        setMsg(""); // 上一条提示别和确认栏同时在场
        const host = attachRows.closest<HTMLElement>(".caldav-attach") || attachRows;
        const r = await confirmLargeFile(host, file, isIcloud);
        if (r === "cancel") setMsg("已取消上传");
        if (r !== "ok") return;
      }
      setMsg(`正在读取「${file.name}」…`);
      try {
        const b64 = await arrayBufferToBase64(await file.arrayBuffer());
        atts.push({ b64, name: file.name, fmttype: file.type || undefined });
        redraw();
        setMsg(`已添加「${file.name}」，保存后生效`);
      } catch (err) {
        setMsg(err instanceof Error ? err.message : String(err), true);
      }
    });
  }

  // 日历自定义下拉：图标颜色随所选日历，弹层为暖色浅底（原生 select 弹层无法去除系统蓝高亮）
  const calInput = f("calendar");
  const calWrap = calInput.closest<HTMLElement>(".caldav-input-wrap");
  const calPop = calWrap?.querySelector<HTMLElement>("[data-cal-pop]");
  const applyCalendar = (url: string) => {
    calInput.value = url;
    const cal = cals.find((c) => c.url === url);
    calWrap?.style.setProperty("--cal-color", calEventColor(cal));
    const nameEl = calWrap?.querySelector<HTMLElement>(".caldav-cal-name");
    if (nameEl && cal) nameEl.textContent = cal.displayName;
    calPop?.querySelectorAll(".caldav-cal-option").forEach((o) => o.classList.toggle("is-active", (o as HTMLElement).dataset.calUrl === url));
  };
  calWrap?.querySelector<HTMLElement>('[data-action="cal-toggle"]')?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (calPop) calPop.hidden = !calPop.hidden;
  });
  calPop?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const opt = (ev.target as HTMLElement).closest<HTMLElement>(".caldav-cal-option");
    if (!opt) return;
    applyCalendar(opt.dataset.calUrl || "");
    if (calPop) calPop.hidden = true;
  });

  // 全天切换显示/隐藏时间输入
  const timeWraps = Array.from(el.querySelectorAll<HTMLElement>(".caldav-input-wrap--time"));
  const timeClears = Array.from(el.querySelectorAll<HTMLElement>(".caldav-input-clear--time"));
  const durationRow = el.querySelector<HTMLElement>(".caldav-duration-row");

  // ---- 自定义时间选择器 ----
  // 原生 <input type="time"> 的弹出面板由浏览器绘制，选中项固定是系统高亮色（蓝），
  // 换主题也不会变（CSS 改不动它），所以改成自绘的「时 / 分」两列弹层，配色全走主题变量。
  const timePops = Array.from(el.querySelectorAll<HTMLElement>("[data-time-pop]"));

  function closeTimePops(): void {
    timePops.forEach((p) => (p.hidden = true));
  }

  /** 把 hidden input 的值同步到触发按钮上的文字（清空时显示 --:--） */
  function syncTimeText(name: string): void {
    const inp = f(name);
    const textEl = el.querySelector<HTMLElement>(`[data-time-text="${name}"]`);
    if (textEl) textEl.textContent = inp.value || "--:--";
  }

  function renderTimePop(pop: HTMLElement, name: string): void {
    const raw = f(name).value;
    const cur = /^\d{2}:\d{2}$/.test(raw) ? raw : "09:00";
    const [ch, cm] = cur.split(":");
    // 自然顺序：小时 00..23、分钟 00,05..55。未落在 5 分钟刻度上的已有值保留，避免一打开就被改掉
    const hoursAll = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
    const minutesAll: string[] = [];
    for (let m = 0; m < 60; m += 5) minutesAll.push(String(m).padStart(2, "0"));
    if (!minutesAll.includes(cm)) minutesAll.push(cm);
    minutesAll.sort();
    const col = (key: string, values: string[], active: string) =>
      `<div class="caldav-time-col" data-col="${key}">${values
        .map(
          (v) =>
            `<button type="button" class="caldav-time-item${
              v === active ? " is-active" : ""
            }" data-time-val="${v}">${v}</button>`
        )
        .join("")}</div>`;
    pop.innerHTML = col("h", hoursAll, ch) + col("m", minutesAll, cm);
    // 选中项滚动到列的视口顶部：上方是更早的值（上滚可取）、下方是更晚的值（下滚可取）。
    // 注意 a.offsetTop 是相对定位祖先（弹层）的偏移，必须减去列自身的 offsetTop 折算成「列内滚动量」，
    // 否则会多算弹层的 padding 与列的横向偏移，导致滚动被钳到最大、选中块被顶到中下部甚至被上边框裁切。
    const pos = () => {
      pop.querySelectorAll<HTMLElement>(".caldav-time-col").forEach((c) => {
        const a = c.querySelector<HTMLElement>(".caldav-time-item.is-active");
        if (a) c.scrollTop = Math.max(0, a.offsetTop - c.offsetTop);
      });
    };
    // 与 Obsidian 侧保持一字不差：显式走 window.requestAnimationFrame，
    // 避免绑到错误的 window 对象上（Obsidian 的 popout 是独立 window，
    // 社区审核 0.4.10 报过这一条）。
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(pos);
    else window.setTimeout(pos, 0);
  }

  /** "YYYY-MM-DDTHH:mm" 加一小时，返回同格式（跨天会进位到次日） */
  function plusHour(stamp: string): string {
    const d = parseLocalStamp(stamp);
    d.setHours(d.getHours() + 1);
    return stampOfMs(d.getTime()).slice(0, 16);
  }

  /**
   * 开始时间变化后的结束时间联动：
   *  - 日程：结束时间为空、或早于开始时间 → 置为「开始 + 1 小时」
   *  - 待办：开始/结束都允许为空；仅当已有结束时间早于开始时间时才置为「开始 + 1 小时」
   * 比较用完整的「日期 + 时间」，因此跨天的结束时间（如 17 日 23:00 → 18 日 10:00）
   * 不会被误判成「早于开始」而遭到改写。
   */
  function syncEndAfterStartChange(): void {
    const sd = f("startDate").value;
    const st = f("startTime").value;
    if (!sd || !st) return; // 开始时间被清空或未选择时不做联动
    const startStamp = `${sd}T${st}`;
    const ed = f("endDate").value;
    const et = f("endTime").value;
    const endStamp = ed && et ? `${ed}T${et}` : "";
    if (!endStamp && isTodo) return; // 待办允许结束留空
    if (endStamp && endStamp >= startStamp) return; // 结束不早于开始，保持原值
    const next = plusHour(startStamp);
    f("endDate").value = next.slice(0, 10);
    f("endTime").value = next.slice(11, 16);
    syncTimeText("endTime");
    f("endTime").dispatchEvent(new Event("input")); // 让「持续」时长跟着重算
  }

  function toggleTimePop(name: string): void {
    const pop = timePops.find((p) => p.dataset.timePop === name);
    if (!pop) return;
    const open = !pop.hidden;
    closeTimePops();
    if (open) return;
    renderTimePop(pop, name);
    pop.hidden = false;
  }

  // 点击弹层外部收起（点在各自 wrap 内不收，便于输入框聚焦/点选）
  el.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (calPop && !calPop.hidden && !calWrap?.contains(t)) calPop.hidden = true;

    // 时间选择器：触发按钮展开/收起，选项落值（弹层内容每次打开时重建，故用事件委托）
    const timeTrigger = t.closest<HTMLElement>("[data-time]");
    if (timeTrigger) {
      toggleTimePop(timeTrigger.dataset.time!);
      return;
    }
    const timeItem = t.closest<HTMLElement>("[data-time-val]");
    if (timeItem) {
      const pop = timeItem.closest<HTMLElement>("[data-time-pop]");
      const name = pop?.dataset.timePop || "";
      const colKey = timeItem.closest<HTMLElement>(".caldav-time-col")?.dataset.col || "h";
      const inp = f(name);
      const raw = inp.value;
      const [h, m] = (/^\d{2}:\d{2}$/.test(raw) ? raw : "09:00").split(":");
      inp.value = colKey === "h" ? `${timeItem.dataset.timeVal}:${m}` : `${h}:${timeItem.dataset.timeVal}`;
      syncTimeText(name);
      if (name === "startTime") syncEndAfterStartChange(); // 开始时间变了 → 按规则联动结束时间
      inp.dispatchEvent(new Event("input")); // 让「持续」时长跟着重算
      pop
        ?.querySelectorAll<HTMLElement>(`.caldav-time-col[data-col="${colKey}"] .caldav-time-item`)
        .forEach((b) => b.classList.toggle("is-active", b === timeItem));
      return;
    }
    if (!t.closest(".caldav-input-wrap--time")) closeTimePops();
  });

  // 任务分类药丸：单选/多选，点「无分类」清空
  const catHidden = f("categories");
  const pillsWrap = el.querySelector<HTMLElement>("[data-cat-pills]");
  const multiInput = f("catMulti");
  const syncPills = () => {
    const picked = catHidden.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    pillsWrap?.querySelectorAll<HTMLElement>(".caldav-cat-pill").forEach((p) => {
      const name = p.dataset.cat || "";
      p.classList.toggle("is-active", name ? picked.includes(name) : !picked.length);
    });
  };
  pillsWrap?.addEventListener("click", (ev) => {
    const pill = (ev.target as HTMLElement).closest<HTMLElement>(".caldav-cat-pill");
    if (!pill) return;
    const name = pill.dataset.cat || "";
    const picked = catHidden.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!name) {
      catHidden.value = "";
    } else if (multiInput.checked) {
      const i = picked.indexOf(name);
      if (i >= 0) picked.splice(i, 1);
      else picked.push(name);
      catHidden.value = picked.join(",");
    } else {
      catHidden.value = picked.length === 1 && picked[0] === name ? "" : name;
    }
    syncPills();
  });
  multiInput.addEventListener("change", () => {
    // 关闭多选时只保留第一个已选分类
    if (!multiInput.checked && catHidden.value.includes(",")) {
      catHidden.value = catHidden.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)[0] || "";
    }
    ctx.store.settings.categoryMulti = multiInput.checked;
    ctx.store.saveSettings();
    syncPills();
  });
  el.querySelector<HTMLElement>('[data-action="cat-manage"]')?.addEventListener("click", () => {
    openCategoryManager(ctx);
  });
  syncPills();

  const updateDuration = () => {
    const durEl = el.querySelector<HTMLElement>("[data-duration]");
    if (!durEl) return;
    const allDay = f("allDay").checked;
    const start = f("startDate").value + (allDay ? "" : "T" + f("startTime").value + ":00");
    const end = f("endDate").value ? f("endDate").value + (allDay ? "" : "T" + f("endTime").value + ":00") : undefined;
    durEl.textContent = computeDurationLabel(start, end, allDay);
  };
  f("allDay").addEventListener("change", () => {
    const allDay = f("allDay").checked;
    timeWraps.forEach((w) => (w.style.display = allDay ? "none" : ""));
    timeClears.forEach((c) => (c.style.display = allDay ? "none" : ""));
    if (durationRow) durationRow.style.display = allDay || isTodo ? "none" : "";
    if (!allDay) {
      // 取消「全天」时补默认时间，与新建默认一致：落在下一个整点，而不是固定 9:00
      const ds = defaultStartStamp(f("startDate").value);
      if (!f("startTime").value) f("startTime").value = ds.slice(11, 16);
      if (!f("endTime").value) f("endTime").value = addHoursStr(ds, 1).slice(11, 16);
    }
    syncTimeText("startTime");
    syncTimeText("endTime");
    updateDuration();
  });

  // 日期/时间变化时更新持续时长
  for (const name of ["startDate", "startTime", "endDate", "endTime"]) {
    f(name).addEventListener("input", updateDuration);
  }

  // 清空日期/时间按钮
  el.querySelectorAll<HTMLElement>("[data-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.clear!;
      const inp = f(target);
      inp.value = "";
      inp.dispatchEvent(new Event("input"));
      syncTimeText(target); // 日期没有配套文字节点，命中不到时静默跳过
    });
  });

  // 「清除日期时间」：一键清掉开始/结束的日期与时间共 4 个字段
  // （2026-10-13 雄哥要求，与 Obsidian 侧一致）。复用「置空 + 派发 input」路径，
  // 下游联动与手动逐字段清空时完全相同。
  el.querySelector<HTMLElement>("[data-clear-datetime]")?.addEventListener("click", () => {
    for (const name of ["startDate", "startTime", "endDate", "endTime"]) {
      const inp = f(name);
      if (!inp) continue;
      inp.value = "";
      inp.dispatchEvent(new Event("input"));
      syncTimeText(name);
    }
  });

  // 重复详情展开 / 折叠
  const repeatDetail = el.querySelector<HTMLElement>("[data-detail='repeat']")!;
  const repeatBtn = el.querySelector<HTMLElement>("[data-action='toggle-repeat-detail']")!;
  const repeatBtnText = repeatBtn.querySelector<HTMLElement>(".caldav-row-btn-text")!;
  const toggleRepeat = () => {
    const open = repeatDetail.style.display !== "none";
    repeatDetail.style.display = open ? "none" : "block";
    repeatBtn.classList.toggle("is-open", !open);
  };
  repeatBtn.addEventListener("click", toggleRepeat);

  // 重复开关
  const repeatFields = el.querySelector<HTMLElement>(".caldav-repeat-fields")!;
  f("repeatOn").addEventListener("change", () => {
    const on = f("repeatOn").checked;
    repeatFields.style.display = on ? "flex" : "none";
    repeatBtnText.textContent = on ? repeatSummary(collectRepeat(el)) : "不重复";
  });

  // 星期选择
  el.querySelectorAll<HTMLElement>(".caldav-wd").forEach((wd) => {
    wd.addEventListener("click", () => wd.classList.toggle("is-on"));
  });
  // 结束模式
  f("endMode").addEventListener("change", () => {
    const mode = f("endMode").value;
    f("count").style.display = mode === "count" ? "" : "none";
    f("until").style.display = mode === "until" ? "" : "none";
  });

  // 进度
  const percent = el.querySelector('[data-f="percent"]') as HTMLInputElement | null;
  percent?.addEventListener("input", () => {
    (el.querySelector(".caldav-progress-val") as HTMLElement).textContent = percent.value + "%";
  });

  // 把识别结果写入日期/时间字段并同步显示
  const applyParsed = (p: ParsedDateTime): void => {
    f("startDate").value = p.startDate;
    f("startDate").dispatchEvent(new Event("input"));
    if (p.startTime) { f("startTime").value = p.startTime; syncTimeText("startTime"); }
    if (p.endDate) { f("endDate").value = p.endDate; f("endDate").dispatchEvent(new Event("input")); }
    if (p.endTime) { f("endTime").value = p.endTime; syncTimeText("endTime"); }
  };

  // 粘贴自动识别日期：勾选开关后，在标题框粘贴含日期文本即抽取填入对应字段
  const summaryInput = f("summary");
  summaryInput.addEventListener("paste", (e: ClipboardEvent) => {
    if (!f("aiParse").checked) return; // 未勾选 → 走原生粘贴
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    const inp = e.target as HTMLInputElement;
    const s = inp.selectionStart ?? inp.value.length;
    const en = inp.selectionEnd ?? inp.value.length;
    inp.setRangeText(text, s, en, "end"); // 标题保留原文，仅抽取日期填入字段
    e.preventDefault();
    const p = parseDateTimeFromText(text);
    if (p) applyParsed(p);
  });

  // ✨ 按钮：手动对当前标题触发一次识别（不依赖开关）
  el.querySelector('[data-action="ai-parse"]')?.addEventListener("click", () => {
    const p = parseDateTimeFromText(f("summary").value);
    if (!p) {
      errEl.textContent = "未在标题中识别到日期时间。";
      setTimeout(() => (errEl.textContent = ""), 2500);
      return;
    }
    applyParsed(p);
  });

  // 提醒设置：多行列表 + 常用组合预设
  wireAlarms(el, errEl);

  el.querySelector('[data-action="cancel"]')?.addEventListener("click", () => dialog.destroy());

  // 删除：改为弹窗内二次确认（思源原生 confirm 在本插件 iframe 里点击无响应，
  // 且失败时无法反馈，这里不依赖它，同时保留失败提示）
  const delBtn = el.querySelector<HTMLButtonElement>('[data-action="delete"]');
  if (delBtn) {
    const idleHtml = delBtn.innerHTML;
    let armed = false;
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    const disarm = () => {
      armed = false;
      if (armTimer) clearTimeout(armTimer);
      armTimer = null;
      delBtn.innerHTML = idleHtml;
      delBtn.classList.remove("is-armed");
    };
    delBtn.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        delBtn.innerHTML = `${icons.trash} 再点一次确认删除`;
        delBtn.classList.add("is-armed");
        armTimer = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      delBtn.disabled = true;
      delBtn.innerHTML = "删除中…";
      // 与保存同理：本地已标记删除并入队后台上传，不等网络往返就关窗。
      // 服务端删除失败时条目留在本地（deleted+dirty），下次同步自动重试，
      // 结果看页脚状态条 —— 好过把窗口冻在「删除中…」一分钟（2026-10-15 实测）。
      void ctx.sync.removeItem(it).catch((e) => {
        console.warn("[caldav] 删除后的后台上传失败:", e);
      });
      dialog.destroy();
    });
  }
  el.querySelector('[data-action="save"]')?.addEventListener("click", () => {
    try {
      const saved = collect(ctx, el, it, attachList);
      // 本地保存（putAndEmit + persist）在 create/updateItem 里同步完成，上传走
      // 推送队列在后台跑。⚠️ 曾经在这里 `await` 上传成功才关窗 —— 服务端响应慢时
      // （家用 NAS 上行慢、服务端卡死）窗口能假死一分钟以上，用户以为还在传大附件
      // （2026-10-15 实测：删掉 5MB 附件后保存仍卡约 1 分钟，真实原因是服务器
      // 根本不响应 HTTP）。上传结果走页脚状态条（lastNote/lastError），不阻塞编辑窗。
      void (isNew ? ctx.sync.createItem(saved) : ctx.sync.updateItem(saved)).catch((e) => {
        console.warn("[caldav] 保存后的后台上传失败:", e);
      });
      dialog.destroy();
    } catch (e: any) {
      errEl.textContent = e?.message || String(e);
    }
  });

  // 转换为另一种种类（待办↔日程）：先收集当前表单（保留未保存的编辑），翻 kind 并重渲染编辑器，
  // 不立即落库，让用户能在保存前再调整字段（时间映射与专属字段处理见 convertItemKind）。
  el.querySelector('[data-action="convert"]')?.addEventListener("click", () => {
    try {
      const target: CalKind = it.kind === "todo" ? "event" : "todo";
      const collected = collect(ctx, el, it, attachList); // 复用收集逻辑，未保存编辑不丢
      // 目标类型不被当前日历接受时必须换日历（iCloud 的「日历」只收 VEVENT、
      // 「提醒事项」只收 VTODO，硬转必 403）。UID/附件/重复规则全部保留，只是搬家。
      const cals = ctx.store.settings.calendars.filter((c) => c.enabled);
      const cur = cals.find((c) => c.url === collected.calendarUrl);
      const accepted = (cal?: CalCalendar): boolean =>
        !cal || (target === "event" ? cal.supportsEvent !== false : cal.supportsTodo !== false);
      if (!accepted(cur)) {
        const dest = cals.find((c) => accepted(c));
        if (!dest) {
          errEl.textContent = `没有支持${target === "event" ? "日程" : "待办"}的日历（当前日历只收${target === "event" ? "待办" : "日程"}），请先到设置里启用一个`;
          return;
        }
        collected.movedFrom = { href: collected.href, calendarUrl: collected.calendarUrl, etag: collected.etag };
        collected.calendarUrl = dest.url;
        collected.href = dest.url.replace(/\/+$/, "") + "/" + collected.uid + ".ics";
        collected.etag = undefined;
        showMessage(
          `当前日历不支持${target === "event" ? "日程" : "待办"}，已切换到「${dest.displayName}」；保存后原日历里那一份会被删除`,
          8000,
          "info"
        );
      }
      const converted = convertItemKind(collected, target);
      dialog.destroy();
      openEditor(ctx, { item: converted });
    } catch (e: any) {
      errEl.textContent = e?.message || String(e);
    }
  });
}

function collectRepeat(el: HTMLElement): Recurrence {
  const f = (name: string) => el.querySelector(`[data-f="${name}"]`) as HTMLInputElement;
  const v = (name: string) => f(name).value.trim();
  const r: Recurrence = {
    freq: f("freq").value as Recurrence["freq"],
    interval: Math.max(1, +f("interval").value || 1)
  };
  if (r.freq === "WEEKLY" || r.freq === "MONTHLY") {
    const on = Array.from(el.querySelectorAll(".caldav-wd.is-on")).map((e) => (e as HTMLElement).dataset.wd!);
    if (on.length) r.byDay = on;
  }
  const mode = f("endMode").value;
  if (mode === "count") r.count = Math.max(1, +f("count").value || 1);
  if (mode === "until") r.until = v("until");
  return r;
}

function collect(ctx: PanelCtx, el: HTMLElement, it: CalItem, attachList?: CalAttachment[]): CalItem {
  const f = (name: string) => el.querySelector(`[data-f="${name}"]`) as HTMLInputElement;
  const v = (name: string) => f(name).value.trim();

  it.summary = v("summary");
  if (!it.summary) throw new Error("标题不能为空");
  it.calendarUrl = v("calendar");
  const cal = ctx.store.settings.calendars.find((c) => c.url === it.calendarUrl);
  // 更换日历 = 移动资源
  if (cal && !it.href.startsWith(cal.url.replace(/\/+$/, ""))) {
    // 记下原地址：上传成功后要把旧日历里那份删掉，否则服务端留孤儿
    // （删除顺序是「先建新的、成功再删旧的」，见 sync.ts deleteMovedFrom）。
    it.movedFrom = { href: it.href, calendarUrl: it.calendarUrl, etag: it.etag };
    it.href = cal.url.replace(/\/+$/, "") + "/" + it.uid + ".ics";
    it.etag = undefined; // 新资源无 etag
  }
  it.allDay = f("allDay").checked;
  const startDate = v("startDate");
  const startTime = v("startTime");
  const endDate = v("endDate");
  const endTime = v("endTime");
  const stampOf = (d: string, t: string) => (!d ? "" : it.allDay ? d : `${d}T${t || "00:00"}:00`);
  if (it.kind === "todo") {
    // 待办的开始/截止时间均可留空
    it.start = stampOf(startDate, startTime);
    it.end = stampOf(endDate, endTime);
    if (it.start && it.end && parseLocalStamp(it.end).getTime() < parseLocalStamp(it.start).getTime()) {
      throw new Error("结束时间不能早于开始时间");
    }
  } else if (it.allDay) {
    if (!startDate) throw new Error("请填写开始日期");
    it.start = startDate;
    it.end = endDate || addDays(startDate, 1);
  } else {
    if (!startDate) throw new Error("请填写开始日期");
    if (!startTime) throw new Error("请填写开始时间");
    it.start = `${startDate}T${startTime}:00`;
    if (!endDate || !endTime) throw new Error("请填写结束日期和时间");
    it.end = `${endDate}T${endTime}:00`;
    if (parseLocalStamp(it.end).getTime() <= parseLocalStamp(it.start).getTime()) throw new Error("结束时间需晚于开始时间");
  }
  // 重复
  if (f("repeatOn").checked) {
    it.rrule = collectRepeat(el);
  } else {
    it.rrule = undefined;
  }
  // 提醒：列表里一行一个，按提前量去重后写回。
  // （曾经只写 alarms[0]，且前端只有一个下拉 —— 从别处同步来的多个提醒一保存就被丢掉）
  const alarms: Alarm[] = [];
  el.querySelectorAll<HTMLSelectElement>("select[data-alarm]").forEach((s) => {
    const m = Math.max(0, Math.round(+s.value || 0));
    if (!alarms.some((a) => a.minutesBefore === m)) alarms.push({ minutesBefore: m });
  });
  it.alarms = alarms.length ? alarms : undefined;
  it.location = v("location") || undefined;
  it.categories = v("categories")
    ? v("categories").split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    : undefined;
  it.description = v("description") || undefined;
  // 附件：以附件区维护的 atts 为准（URI 外链 + 二进制内联两种形式）。
  // ⚠️ 删光时要写 `[]` 而**不是 undefined** —— undefined 在 rebuildComponent 里是
  //    「老数据、插件还没接管附件」的信号，会把原文里的二进制件原样带回来，
  //    用户的删除就失效了。空数组才表示「明确不要附件」。
  if (attachList) it.attachments = attachList.filter((a) => (a.uri || "").trim() || (a.b64 || "").trim());
  // 总体积闸门（保存前，2026-10-15）：单文件上限挡不住「多个 4MB 凑 12MB」，
  // 所以这里按**真实序列化出的 ICS** 卡总账。超了服务端必然 413（Radicale 默认
  // 10MB / PHP 默认 8MB），这个待办会卡在「同步失败」里每次同步重传一遍。
  // 上限取自设置（单个ICS文件限制），老数据缺省回默认 10MB。
  //
  // ⚠️ iCloud 托管附件场景要用「托管化草案」算账：保存这一刻 b64 还在本地
  //    （托管上传发生在随后的同步层），草案若含 base64 会把体积算虚高——
  //    7MB 文件 base64 后 9.3MB，贴着默认上限走，存心让人存不进去。
  //    托管后的 ICS 只记一行 ATTACH 链接，把 b64 换成占位 uri 再算，
  //    量的才是最终会上服务器的体积。
  const draftForSize: CalItem =
    ctx.store.settings.serverType === "icloud" && it.attachments?.some((a) => (a.b64 || "").trim())
      ? {
          ...it,
          attachments: it.attachments.map((a) =>
            (a.b64 || "").trim()
              ? { ...a, b64: undefined, uri: a.uri || `https://icloud-managed.invalid/${encodeURIComponent(a.name || "attachment")}` }
              : a
          )
        }
      : it;
  const icsDraft = itemToEditedICS(draftForSize);
  const icsBytes = new TextEncoder().encode(icsDraft).length;
  const icsMax = icsSizeMaxBytes(ctx.store.settings);
  if (icsBytes > icsMax) {
    const bigNames = (it.attachments || [])
      .filter((a) => a.b64)
      .map((a) => `「${a.name}」`)
      .join("、");
    throw new Error(
      `附件总体积过大（ICS 约 ${sizeText(icsBytes)}）：${bigNames}。` +
        `CalDAV服务器默认 ${sizeText(icsMax)}，请删掉大附件或改用外链。`
    );
  }
  if (it.kind === "todo") {
    it.priority = +f("priority").value || 0;
    it.percent = Math.min(100, Math.max(0, +f("percent").value || 0));
    it.status = it.percent === 100 ? "COMPLETED" : it.percent > 0 ? "IN-PROCESS" : "NEEDS-ACTION";
    if (it.percent === 100 && !it.completedAt) it.completedAt = stampNow();
    if (it.percent < 100) it.completedAt = undefined;
  }
  return it;
}

function stampNow(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface ParsedDateTime {
  startDate: string;
  startTime?: string;
  endDate?: string;
  endTime?: string;
}

const WEEKDAY_NUM: Record<string, number> = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function ymdStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDaysDate(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * 从自由文本识别日期时间（中文常见表达），用于编辑器「粘贴自动识别日期」。
 * 支持：今天/明天/后天、周几（含下周/本周，排除「每」前缀的重复表达）、
 *       年月日 / 月日 / 公历节日；时间支持 14:00、9点、9点半、下午3点 等。
 * 仅识别到日期则只填日期；识别到时间则填开始（结束默认 +1 小时）；
 * 若一段文本含两个时间（如「14点到16点」）则分别作为起止。返回 null 表示啥都没识别到。
 */
function parseDateTimeFromText(text: string): ParsedDateTime | null {
  const base = new Date();
  const startOfToday = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  let dateObj: Date | null = null;

  // 1) 相对日词
  const REL: [string, number][] = [
    ["今天", 0], ["今日", 0], ["明日", 1], ["明天", 1], ["大后天", 3], ["后天", 2],
    ["昨日", -1], ["昨天", -1], ["今", 0],
  ];
  for (const [k, off] of REL) {
    if (text.includes(k)) { dateObj = addDaysDate(base, off); break; }
  }

  // 2) 周几（排除「每」前缀的重复表达）
  if (!dateObj) {
    const WD = /(每)?\s*(下|本|这|上)?\s*(周|星期|礼拜)\s*([0-6一二三四五六日])/g;
    let m: RegExpExecArray | null;
    while ((m = WD.exec(text))) {
      if (m[1] === "每") continue;
      const raw = m[4];
      let w: number;
      if (WEEKDAY_NUM[raw] !== undefined) w = WEEKDAY_NUM[raw];
      else { const n = +raw; w = n === 7 ? 0 : n; }
      const days = (w - base.getDay() + 7) % 7; // 未来最近的该星期几
      dateObj = addDaysDate(base, days);
      break;
    }
  }

  // 3) 年月日
  if (!dateObj) {
    const y = /(\d{4})[年./\-](\d{1,2})[月./\-](\d{1,2})(?:日|号)?/.exec(text);
    if (y) dateObj = new Date(+y[1], +y[2] - 1, +y[3]);
  }
  // 4) 月日（今年；已过则顺延明年）
  if (!dateObj) {
    const md = /(\d{1,2})[月./\-](\d{1,2})(?:日|号)?/.exec(text);
    if (md) {
      const d = new Date(base.getFullYear(), +md[1] - 1, +md[2]);
      if (d.getTime() < startOfToday.getTime()) d.setFullYear(base.getFullYear() + 1);
      dateObj = d;
    }
  }
  // 5) 公历节日
  if (!dateObj) {
    const FEST: [string, number, number][] = [
      ["元旦", 1, 1], ["情人节", 2, 14], ["妇女节", 3, 8], ["劳动节", 5, 1],
      ["儿童节", 6, 1], ["国庆", 10, 1], ["圣诞节", 12, 25],
    ];
    for (const [k, mm, dd] of FEST) {
      if (text.includes(k)) {
        const d = new Date(base.getFullYear(), mm - 1, dd);
        if (d.getTime() < startOfToday.getTime()) d.setFullYear(base.getFullYear() + 1);
        dateObj = d;
        break;
      }
    }
  }

  // 时间（必须带 点/时/:/半 之一，避免误判纯数字；后续时间继承前一时段）
  const times: { h: number; m: number }[] = [];
  let lastPeriod: "am" | "pm" | null = null;
  const TIME = /(上午|早上|早晨|凌晨|中午|下午|傍晚|晚上|夜里|半夜)?\s*(\d{1,2})(?:(?:[:：](\d{1,2}))|点\s*(半|(\d{1,2})\s*分)?|时\s*(半|(\d{1,2})\s*分)?)/g;
  let tm: RegExpExecArray | null;
  while ((tm = TIME.exec(text))) {
    let h = +tm[2];
    let m = 0;
    if (tm[3] !== undefined && tm[3] !== "") m = +tm[3];
    else if (tm[4] === "半") m = 30;
    else if (tm[5] !== undefined && tm[5] !== "") m = +tm[5];
    const mod = tm[1];
    if (mod === "上午" || mod === "早上" || mod === "早晨" || mod === "凌晨") { if (h === 12) h = 0; lastPeriod = "am"; }
    else if (mod === "中午") { if (h < 12) h += 12; lastPeriod = "pm"; }
    else if (mod === "下午" || mod === "傍晚" || mod === "晚上" || mod === "夜里") { if (h < 12) h += 12; lastPeriod = "pm"; }
    else if (mod === "半夜") { if (h === 12) h = 0; lastPeriod = "am"; }
    else {
      if (lastPeriod === "pm" && h < 12) h += 12;
      else if (lastPeriod === "am" && h === 12) h = 0;
    }
    h = Math.max(0, Math.min(23, h));
    m = Math.max(0, Math.min(59, m));
    times.push({ h, m });
  }

  if (!dateObj && times.length === 0) return null;
  const date = dateObj ?? base;
  const startDate = ymdStr(date);
  if (times.length === 0) return { startDate };

  const fmt = (t: { h: number; m: number }) =>
    `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
  const t0 = times[0];
  if (times.length >= 2) {
    return { startDate, startTime: fmt(t0), endDate: startDate, endTime: fmt(times[1]) };
  }
  const end = addDaysDate(date, 0);
  end.setHours(t0.h, t0.m + 60, 0, 0);
  return {
    startDate,
    startTime: fmt(t0),
    endDate: ymdStr(end),
    endTime: fmt({ h: end.getHours(), m: end.getMinutes() }),
  };
}
