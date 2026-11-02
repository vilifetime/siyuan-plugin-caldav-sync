/**
 * 应用内提醒卡片 —— 到点提醒的「保证可见」主通道。
 *
 * 为什么不拿系统通知当主通道（v0.1.7 的失效原因）：
 *  1. **不会弹授权窗是必然的**：思源 Electron 主进程没有注册权限处理器，内核默认放行
 *     所有权限请求，`Notification.requestPermission()` 不显示任何 UI 就直接 resolve；
 *     把它当成用户可见的授权流程本身就是错的。
 *  2. **Windows 上 toast 可能被静默丢弃**：Electron 的系统通知要求应用存在
 *     「开始菜单快捷方式 + AUMID + ToastActivatorCLSID」，便携版/绿色版思源缺这一环，
 *     `new Notification()` 不报错也不显示。
 * 所以：到点提醒以本卡片为准（只要思源窗口可见就一定看得见），
 * 系统通知降级为「尽力而为」的附加通道，见 index.ts 的 notifySystem()。
 *
 * 挂载点放在 document.body：页面被切走或视图容器 `overflow` 裁剪都不影响它。
 */
import { icons } from "./icons";
import { t } from "../core/i18n";


export interface ReminderToastOptions {
  title: string;
  body: string;
  /** 点击「打开」 */
  onOpen?: () => void;
  /** 点击「稍后提醒」，参数为分钟数 */
  onSnooze?: (minutes: number) => void;
}

/** 可见状态下多久自动收起（窗口隐藏时不计时，恢复可见后才开始计时） */
const AUTO_DISMISS_MS = 60_000;
/** 同屏最多保留几张卡片，超出先移除最旧的 */
const MAX_CARDS = 4;
/** 「稍后提醒」的固定间隔 */
const SNOOZE_MINUTES = 5;

interface CardState {
  card: HTMLElement;
  /** 可见态下的自动收起计时器；隐藏态为 null */
  timer: ReturnType<typeof setTimeout> | null;
  cleanup: () => void;
}

let layer: HTMLElement | null = null;
const cards: HTMLElement[] = [];
const states = new WeakMap<HTMLElement, CardState>();
let visibilityBound = false;

/** 少数 WebView / 测试环境没有 rAF，退化到宏任务（typeof 对未声明标识符是安全的） */
const nextFrame: (cb: () => void) => void =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 0);

function ensureLayer(): HTMLElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement("div");
  layer.className = "caldav-reminder-layer";
  document.body.appendChild(layer);
  if (!visibilityBound) {
    visibilityBound = true;
    // 窗口被切走/最小化时暂停计时，否则用户切回来时卡片早已超时消失
    document.addEventListener("visibilitychange", syncVisibility);
  }
  return layer;
}

function syncVisibility(): void {
  for (const card of cards) {
    const st = states.get(card);
    if (!st) continue;
    if (document.hidden) pauseTimer(st);
    else startTimer(st);
  }
}

function startTimer(st: CardState): void {
  if (st.timer !== null || document.hidden) return;
  st.timer = setTimeout(() => dismiss(st.card), AUTO_DISMISS_MS);
}

function pauseTimer(st: CardState): void {
  if (st.timer === null) return;
  clearTimeout(st.timer);
  st.timer = null;
}

function dismiss(card: HTMLElement): void {
  const st = states.get(card);
  if (!st) return;
  states.delete(card);
  const i = cards.indexOf(card);
  if (i >= 0) cards.splice(i, 1);
  pauseTimer(st);
  st.cleanup();
  card.classList.remove("is-in");
  // 退场动画结束后再摘除节点
  setTimeout(() => card.remove(), 180);
  if (!cards.length && layer) {
    layer.remove();
    layer = null;
  }
}

/** 弹出一张到点提醒卡片 */
export function showReminderToast(opts: ReminderToastOptions): void {
  const host = ensureLayer();
  while (cards.length >= MAX_CARDS) dismiss(cards[0]);

  const card = document.createElement("div");
  card.className = "caldav-reminder-card";
  card.innerHTML = `
  <div class="caldav-reminder-head">
    <span class="caldav-reminder-icon">${icons.bell}</span>
    <span class="caldav-reminder-title"></span>
    <button class="caldav-reminder-x" type="button" data-act="close" title="${t("关闭")}" aria-label="${t("关闭")}">${icons.close}</button>
  </div>
  <div class="caldav-reminder-body"></div>
  <div class="caldav-reminder-acts">
    <button class="caldav-reminder-act is-primary" type="button" data-act="open">${t("打开")}</button>
    <button class="caldav-reminder-act" type="button" data-act="snooze">${t("稍后")} ${SNOOZE_MINUTES} ${t("分钟")}</button>
  </div>`;
  // 条目标题可能含 < > &，必须用 textContent 回填，不能拼进 innerHTML
  (card.querySelector(".caldav-reminder-title") as HTMLElement).textContent = opts.title;
  (card.querySelector(".caldav-reminder-body") as HTMLElement).textContent = opts.body;

  const onClick = (ev: Event) => {
    const btn = (ev.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
    if (!btn || !card.contains(btn)) return;
    const act = btn.dataset.act;
    if (act === "close") {
      dismiss(card);
    } else if (act === "open") {
      dismiss(card);
      try {
        opts.onOpen?.();
      } catch {
        /* 忽略：打开失败不影响提醒本身 */
      }
    } else if (act === "snooze") {
      dismiss(card);
      try {
        opts.onSnooze?.(SNOOZE_MINUTES);
      } catch {
        /* 忽略 */
      }
    }
  };
  // 鼠标悬停暂停自动收起，避免读到一半被收走
  const onEnter = () => {
    const st = states.get(card);
    if (st) pauseTimer(st);
  };
  const onLeave = () => {
    const st = states.get(card);
    if (st) startTimer(st);
  };
  card.addEventListener("click", onClick);
  card.addEventListener("pointerenter", onEnter);
  card.addEventListener("pointerleave", onLeave);

  const st: CardState = {
    card,
    timer: null,
    cleanup: () => {
      card.removeEventListener("click", onClick);
      card.removeEventListener("pointerenter", onEnter);
      card.removeEventListener("pointerleave", onLeave);
    }
  };
  states.set(card, st);
  cards.push(card);
  host.appendChild(card);
  // 下一帧再置入场态，保证过渡动画触发
  nextFrame(() => card.classList.add("is-in"));
  startTimer(st);
}

/** 清空全部提醒卡片（插件卸载时调用，避免残留） */
export function clearReminderToasts(): void {
  for (const card of [...cards]) dismiss(card);
  if (layer) {
    layer.remove();
    layer = null;
  }
}
