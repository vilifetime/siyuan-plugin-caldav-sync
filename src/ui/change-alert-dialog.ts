/**
 * 「一次同步改动数量告警」确认弹窗（2026-11-01）。
 *
 * 背景：任务块 ⇄ VTODO 改成**如实双向**同步之后（去掉了「服务端只能把块往前推」的单向
 * 保险），误改的兜底换成「拦数量」—— 一轮改动超过设置里的告警值时，先把明细摆给用户看，
 * 用户点头才动手。这个弹窗就是那道闸。
 *
 * ⚠️ 项目约定：删除/批量类操作**禁用原生 confirm()**（会阻断思源的 UI 线程且样式突兀），
 *    一律走思源 Dialog。
 */
import { newDialog } from "@/ui/dialog";
import { isMobile } from "./device";
import type { BlockChangeAlert } from "../core/block-sync";
import { escape } from "./view-common";

function rowHtml(label: string, n: number): string {
  return `<div class="caldav-blkinfo-row">
    <span class="caldav-blkinfo-k">${escape(label)}</span>
    <span class="caldav-blkinfo-v caldav-blkinfo-v--mono">${n} 条</span>
  </div>`;
}

function alertHtml(info: BlockChangeAlert): string {
  const lines: string[] = [];
  if (info.written) lines.push(rowHtml("回写任务块", info.written));
  if (info.created) lines.push(rowHtml("新建待办", info.created));
  if (info.updated) lines.push(rowHtml("更新待办", info.updated));
  if (info.deleted) lines.push(rowHtml("删除待办", info.deleted));
  return `
<div class="caldav-editor-form">
  <p class="caldav-set-hint">
    本轮任务块对账算出来的改动共 <b>${info.total}</b> 条，超过告警值 <b>${info.threshold}</b>。
    改动过大的一轮往往不是常态（可能是扫描范围配错、缓存被清、服务端被重建），请先过一眼：
  </p>
  <div class="caldav-blkinfo">${lines.join("")}</div>
  <p class="caldav-set-hint">
    改动 <b>${info.total}</b> 条（同一条待办若既回写文档又更新服务端，只算一条）。
    「继续同步」按上面明细执行；「取消」则本轮一条都不改（增量水位线也不推进，下一轮会重新对账）。
  </p>
</div>
<div class="caldav-editor-foot">
  <span class="caldav-flex"></span>
  <button type="button" class="caldav-foot-btn caldav-foot-btn--ghost" data-act="cancel">取消</button>
  <button type="button" class="caldav-foot-btn caldav-foot-btn--primary" data-act="ok">继续同步（${info.total} 条）</button>
</div>`;
}

/**
 * 弹出确认窗。
 *
 * @returns true = 用户同意继续；false = 取消（弹窗异常关闭也按取消处理 —— 宁可不动）
 */
export function confirmBlockChanges(info: BlockChangeAlert): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
      try {
        dialog.destroy();
      } catch {
        /* 已销毁就算了 */
      }
    };
    const mobile = isMobile();
    const dialog = newDialog({
      title: `任务块同步：本轮改动 ${info.total} 条`,
      content: `<div class="caldav-editor caldav-change-alert">${alertHtml(info)}</div>`,
      // 桌面端不写死高度：内容就三四行，让弹窗自己贴合内容（写 86vh 会留一大片空白）
      width: mobile ? "100vw" : "460px",
      height: mobile ? "100vh" : undefined,
      containerClassName: mobile ? "caldav-mobile-dialog" : undefined,
      destroyCallback: () => {
        // 关闭（Esc / 点遮罩 / 点叉）一律按「取消」处理：宁可不动用户数据
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }
    });
    const root = dialog.element.querySelector(".caldav-change-alert") as HTMLElement | null;
    root?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement)?.closest?.("[data-act]") as HTMLElement | null;
      if (!btn) return;
      done(btn.dataset.act === "ok");
    });
  });
}
