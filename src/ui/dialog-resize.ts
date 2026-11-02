/**
 * 为思源 Dialog 增加右下角缩放手柄（思源原生 dialog 不带缩放）
 */
import type { Dialog } from "siyuan";
import { isMobile } from "./device";
import { t } from "../core/i18n";


export function enableDialogResize(dialog: Dialog): void {
  const root = dialog.element as HTMLElement;
  // 标记类：供 CSS 压缩标题栏高度、消除内容区多余留白
  root.classList.add("caldav-dialog");
  // 触摸端不挂缩放手柄：没有鼠标拖拽，容器尺寸已由移动端 CSS 固定为满视口
  if (isMobile()) return;
  const container = (root.querySelector(".b3-dialog__container") ||
    root.firstElementChild) as HTMLElement | null;
  if (!container) return;
  // 容器需为定位上下文，且解除原生 max-height 限制以便自由缩放
  container.style.position = "relative";
  container.style.maxHeight = "none";

  const handle = document.createElement("div");
  handle.className = "caldav-resize";
  handle.title = t("拖动调整窗口大小");
  handle.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
    '<path d="M11 5 L13 7"/><path d="M8 8 L13 13"/><path d="M5 11 L9 15"/></svg>';
  container.appendChild(handle);

  const MIN_W = 360;
  const MIN_H = 280;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  let dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const maxW = Math.max(MIN_W, window.innerWidth * 0.96);
    const maxH = Math.max(MIN_H, window.innerHeight * 0.96);
    const w = Math.max(MIN_W, Math.min(maxW, startW + (e.clientX - startX)));
    const h = Math.max(MIN_H, Math.min(maxH, startH + (e.clientY - startY)));
    container.style.width = w + "px";
    container.style.height = h + "px";
  };
  const onUp = () => {
    dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    handle.classList.remove("is-active");
  };
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    const rect = container.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startW = rect.width;
    startH = rect.height;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "nwse-resize";
    handle.classList.add("is-active");
  });
}
