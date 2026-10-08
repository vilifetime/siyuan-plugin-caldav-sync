/**
 * 「插入日记」的范围与目标计算（2026-10-08 从 Obsidian 侧同步回来，并新增「写到哪一篇日记」）。
 *
 * 雄哥要求：原按钮直接插「今日」，改为**先问范围** —— 当日 / 本周 / 本月 / 所有；
 * 选「本周 / 本月」时再问一层**目标**：写到今天的日记，还是写到本周一的日记 /
 * 本月 1 日的日记（默认今天，与旧行为一致）。
 *
 * 这里只做**纯计算**，不碰文件与 UI —— 便于写契约测试（见 test/diary.test.mjs）。
 * 「本周」沿用项目既有约定：**自然周，周一起算**（与任务视图的分组一致）。
 */
import { addDays, dateStampOfMs, parseLocalStamp, startOfWeek, todayStamp } from "../core/date";
import type { LocalStamp } from "../core/types";

/** 范围种类 */
export type DiaryRange = "day" | "week" | "month" | "all";

/**
 * 写进哪一篇日记：
 *  - `today`     今天的日记（默认，也是旧行为）
 *  - `spanStart` 区间首日的日记 —— 本周=周一、本月=1 号
 */
export type DiaryTarget = "today" | "spanStart";

export interface DiarySpan {
  /** 起始日期（含） */
  from: string;
  /** 结束日期（不含）—— 统一用「次日零点」表示，便于与毫秒区间比较 */
  toExclusive: string;
  /** 展示用的标签，供弹窗与通知复用 */
  label: string;
  /** 写入日记时的小节标题。跨日范围要带上区间，否则读者不知道这段是哪天的 */
  sectionTitle: string;
}

export interface DiaryTargetOption {
  key: DiaryTarget;
  /**
   * 弹窗里的紧凑文案（「今天的日记」这种）。
   *
   * ⚠️ 不能再写成「插入到今天的日记」这种完整长句：子选项现在**跟在「本周 /
   * 本月」右侧的同一行**（见 diary-range-dialog.ts），长句会把范围行撑爆。
   */
  compact: string;
  /** 结果提示里的短文案（「今天」/「本周一（10-05）」） */
  short: string;
}

/** 小节标题的基础部分：范围不同才追加区间后缀 */
const SECTION_BASE = "日程与待办";

/** 把日期字符串当成「当日零点」的毫秒值 */
function midnightMs(stamp: string): number {
  return parseLocalStamp(stamp + "T00:00:00").getTime();
}

/** 日期加一天（月末会自动进位，交给 Date 处理） */
function nextDay(stamp: string): string {
  return addDays(stamp, 1);
}

/** 当月最后一天 +1 = 下月首日 */
function nextMonth(stamp: string): string {
  const d = parseLocalStamp(stamp + "T00:00:00");
  return dateStampOfMs(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime());
}

/** 本月 1 日 */
function monthFirst(today: string): string {
  return today.slice(0, 8) + "01";
}

/**
 * 算出某个范围对应的日期区间。
 *
 * `all` 不设上界 —— 传一个足够远的未来（今天 +100 年），这样调用方可以一律用
 * `ms >= from && ms < toExclusive` 判断，不必写分支。
 */
export function diarySpanOf(range: DiaryRange, today: LocalStamp = todayStamp()): DiarySpan {
  switch (range) {
    case "day":
      return {
        from: today,
        toExclusive: nextDay(today),
        label: "当日",
        sectionTitle: SECTION_BASE,
      };

    case "week": {
      // 自然周：周一起算，与任务视图「本周」分组的口径一致
      const from = startOfWeek(today);
      const to = addDays(from, 7);
      return {
        from,
        toExclusive: to,
        label: "本周",
        // 跨日的范围必须标出区间，否则读者不知道这段覆盖哪天
        sectionTitle: `${SECTION_BASE}（${from} ~ ${addDays(to, -1)}）`,
      };
    }

    case "month": {
      const from = monthFirst(today);
      return {
        from,
        toExclusive: nextMonth(from),
        label: "本月",
        sectionTitle: `${SECTION_BASE}（${from.slice(0, 7)}）`,
      };
    }

    case "all": {
      // 下界只是个哨兵（不代表「第一篇日记」），上界放到遥远的未来
      return {
        from: "1900-01-01",
        toExclusive: addDays(today, 36500),
        label: "所有",
        sectionTitle: SECTION_BASE,
      };
    }
  }
}

/** 区间是否包含某个毫秒时间点（统一用「左闭右开」） */
export function spanContains(span: DiarySpan, ms: number): boolean {
  return ms >= midnightMs(span.from) && ms < midnightMs(span.toExclusive);
}

/**
 * 某个范围下可选的「写到哪一篇日记」。
 *
 * 只有**本周 / 本月**才真的存在两个选项：当日的首日就是今天，「所有」的首日是
 * 1900-01-01 那个哨兵 —— 都不构成选择，故只回一项，调用方据此不渲染子选项区。
 *
 * 顺序即显示顺序，第一项（今天）是默认项 —— 与旧行为「直接插今日」一致。
 */
export function targetOptionsOf(range: DiaryRange, today: LocalStamp = todayStamp()): DiaryTargetOption[] {
  const todayOpt: DiaryTargetOption = { key: "today", compact: "今天的日记", short: "今天" };
  if (range === "week") {
    const mon = startOfWeek(today);
    return [todayOpt, { key: "spanStart", compact: `本周一的日记（${mon}）`, short: `本周一（${mon}）` }];
  }
  if (range === "month") {
    const first = monthFirst(today);
    return [todayOpt, { key: "spanStart", compact: `本月 1 日的日记（${first}）`, short: `本月 1 日（${first}）` }];
  }
  // day：首日就是今天；all：首日是哨兵 —— 都只有「今天」有意义
  return [todayOpt];
}

/**
 * 实际要写进哪一天的日记。
 *
 * ⚠️ 这里对「区间首日」做了收敛：`spanStart` 只对 week / month 有意义，
 * 其余一律落回今天 —— 否则「所有」会去建一篇 1900-01-01 的日记。
 */
export function diaryTargetStamp(
  range: DiaryRange,
  target: DiaryTarget = "today",
  today: LocalStamp = todayStamp()
): string {
  if (target !== "spanStart") return today;
  if (range !== "week" && range !== "month") return today;
  return diarySpanOf(range, today).from;
}
