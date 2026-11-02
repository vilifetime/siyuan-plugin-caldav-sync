/**
 * 提醒引擎：扫描本地条目，对「设置了提醒时间（VALARM / alarms）」的日程/待办，
 * 在「开始/到期时间 - 提前量」的时刻弹出系统通知（声音由系统通知自带）。
 *
 * 设计要点：
 * - 只提醒带 alarms 的条目（用户约定：没设提醒时间的条目不提醒）。
 * - 仅在提醒时刻晚于当前时才排程；错过的不补（避免一启动就轰炸历史条目）。
 * - 重复条目只排「下一个未来实例」，触发后由周期 rescan 推进到再下一个。
 * - 思源托盘运行时渲染进程不退出，setTimeout 照常触发；rescan 兜底防后台节流。
 */
import type { CalItem } from "./types";
import { occurrencesInRange } from "./ics";
import { parseLocalStamp, stampOfMs } from "./date";
import { t as _t } from "./i18n";


/** 最多提前排程的 horizon，超过的等 rescan 推进 */
const HORIZON_MS = 24 * 86400000;
/** 周期重扫间隔，兜底捕捉新同步条目 / 后台节流漏掉的触发 */
const RESCAN_MS = 60_000;
/**
 * 补发宽限期：提醒时刻刚过去不久（内核启动、设置刚打开、系统休眠唤醒等场景）
 * 也补发一次，避免「设了提醒却什么都没发生」。
 * 更早的仍然不补，防止一启动就轰炸历史条目。
 */
const GRACE_MS = 5 * 60_000;
/** fired 集合容量上限，超出后丢弃最早的记录 */
const FIRED_CAP = 1000;

export interface ReminderFire {
  (item: CalItem, anchorISO: string, alarmMin: number): void;
}

interface ReminderSlot {
  key: string;
  fireAt: number;
  item: CalItem;
  /** 触发所依据的实例开始/到期时刻（本地墙上时间，用作展示与去重 key） */
  anchorISO: string;
  alarmMin: number;
}

export class ReminderEngine {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private rescan: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  /** 已实际触发过的槽位 key（含补发），防止 rescan 把同一条重复补发 */
  private fired = new Set<string>();
  /** 上次打印的排程条数，仅在数量变化时打日志，避免每分钟刷屏 */
  private lastLogged = -1;

  constructor(
    private getItems: () => CalItem[],
    private fire: ReminderFire,
    now?: () => number
  ) {
    this.now = now || (() => Date.now());
  }

  start(): void {
    this.scheduleAll();
    this.rescan = setInterval(() => this.scheduleAll(), RESCAN_MS);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.rescan) {
      clearInterval(this.rescan);
      this.rescan = null;
    }
  }

  /** 外部数据变更后调用（同步完成 / 设置变更），重新排程 */
  reschedule(): void {
    this.scheduleAll();
  }

  /** 计算每个条目下一个未来提醒槽位 */
  private slots(): ReminderSlot[] {
    const now = this.now();
    const fromMs = now;
    const toMs = now + HORIZON_MS;
    const out: ReminderSlot[] = [];
    for (const item of this.getItems()) {
      if (!item.alarms?.length || item.deleted) continue;
      // 已完成的待办不再提醒
      if (item.kind === "todo" && item.percent === 100) continue;
      const occMs = this.nextOccurrences(item, fromMs, toMs);
      if (!occMs.length) continue;
      const anchorMs = Math.min(...occMs);
      const anchorISO = stampFromMs(anchorMs, item.allDay);
      for (const a of item.alarms) {
        const fireAt = anchorMs - a.minutesBefore * 60000;
        if (fireAt < now - GRACE_MS) continue; // 过期超过宽限期：不补，避免轰炸历史条目
        if (fireAt > now + HORIZON_MS) continue; // 太远：等 rescan 推进
        const key = `${item.uid}|${item.recurId || ""}|${a.minutesBefore}|${anchorISO}`;
        if (this.fired.has(key)) continue; // 已提醒过（含刚补发过的），不重复
        out.push({ key, fireAt, item, anchorISO, alarmMin: a.minutesBefore });
      }
    }
    return out;
  }

  scheduleAll(): void {
    const want = new Map(this.slots().map((s) => [s.key, s]));
    // 移除不再需要 / 时点变化的旧 timer
    for (const [key, t] of Array.from(this.timers)) {
      if (!want.has(key)) {
        clearTimeout(t);
        this.timers.delete(key);
      }
    }
    const now = this.now();
    for (const slot of want.values()) {
      if (this.timers.has(slot.key)) continue; // 已排程
      const delay = Math.max(0, slot.fireAt - now);
      const timer = setTimeout(() => {
        this.timers.delete(slot.key);
        // 落进 fired：rescan 时同一个槽位不再补发（宽限期内尤其需要）
        this.fired.add(slot.key);
        this.trimFired();
        try {
          this.fire(slot.item, slot.anchorISO, slot.alarmMin);
        } catch (e) {
          console.warn("[caldav] 提醒触发异常", e);
        }
      }, delay);
      this.timers.set(slot.key, timer);
    }
    // 仅在数量变化时打日志，便于用户在控制台确认「到底排上了没有」
    if (want.size !== this.lastLogged) {
      this.lastLogged = want.size;
      console.info(
        `[caldav] ${_t("提醒排程")} ${want.size} ${_t("条（本地带提醒时间的条目")} ${this.armedCount()} ${_t("个）")}`
      );
    }
  }

  /** 当前已排程的提醒条数（设置页自检用） */
  count(): number {
    return this.timers.size;
  }

  /** 本地「带提醒时间」的条目数：为 0 说明是数据侧没设提醒，而不是投递失败 */
  armedCount(): number {
    return this.getItems().filter((it) => !!it.alarms?.length && !it.deleted).length;
  }

  /** fired 集合控制容量，避免长期运行无限增长 */
  private trimFired(): void {
    if (this.fired.size <= FIRED_CAP) return;
    const drop = this.fired.size - FIRED_CAP;
    let i = 0;
    for (const k of this.fired) {
      this.fired.delete(k);
      if (++i >= drop) break;
    }
  }

  /** 返回条目的若干未来发生时刻（毫秒）：事件用 start，待办用 due(end) */
  private nextOccurrences(item: CalItem, fromMs: number, toMs: number): number[] {
    const anchor = item.kind === "todo" ? item.end || item.start : item.start;
    if (!anchor) return [];
    // 非重复条目直接用锚点时刻；待办只填了到期日、没有 DTSTART 时也走这里
    // （旧实现要求 item.start 必须存在，导致「只有截止日期」的待办永远不提醒）
    if (!item.rrule || !item.start) return [parseLocalStamp(anchor).getTime()];
    // 重复：以 start 展开，再按 start→anchor 的时差平移，得到 anchor 的实例时刻
    const delta = parseLocalStamp(anchor).getTime() - parseLocalStamp(item.start).getTime();
    return occurrencesInRange(item, fromMs - delta, toMs - delta)
      .map((s) => parseLocalStamp(s).getTime() + delta)
      .filter((ms) => ms >= fromMs);
  }
}

function stampFromMs(ms: number, allDay?: boolean): string {
  if (allDay) {
    const d = new Date(ms);
    const p = (n: number) => (n < 10 ? "0" + n : "" + n);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return stampOfMs(ms);
}
