/**
 * 前端 ↔ 内核 调度数据契约（档2·真·内核后端）。
 *
 * 前端把「提醒调度所需的精简条目 + 当前设置」推给内核 kernel.js；内核据此
 * 在 Node 进程里常驻调度，到点触发 Webhook。本模块零 DOM 依赖，前后端共用。
 */
import type { CalItem, CalSettings } from "./types";

/**
 * 内核调度只需条目的一个投影（不必把整条 CalItem 全量序列化过 RPC）。
 * 这里刻意只保留提醒引擎与 Webhook 载荷真正读取的字段，
 * 其余（附件、块对账缓存等）内核用不到，省带宽也避免误用。
 */
export interface ReminderSnapshot {
  /** 精简后的条目列表（已过滤掉内核不需要的字段，但结构兼容 CalItem） */
  items: CalItem[];
  /** 当前设置（ReminderEngine 需要 todoReminderAnchor；Webhook 需要 enableWebhook/webhookUrl） */
  settings: CalSettings;
}

/** 把一条完整 CalItem 投影为内核调度所需的精简结构（保持 CalItem 兼容形状） */
export function projectReminderItem(it: CalItem): CalItem {
  return {
    uid: it.uid,
    kind: it.kind,
    calendarUrl: it.calendarUrl,
    href: it.href,
    summary: it.summary,
    description: it.description,
    location: it.location,
    allDay: it.allDay,
    start: it.start,
    end: it.end,
    rrule: it.rrule,
    recurId: it.recurId,
    exdates: it.exdates,
    alarms: it.alarms,
    priority: it.priority,
    percent: it.percent,
    status: it.status,
    deleted: it.deleted,
    blockId: it.blockId
  } as CalItem;
}
