/**
 * 分类管理弹窗：添加/编辑/删除/排序任务分类，保存后写入 store.settings.categories
 */
import { newDialog } from "@/ui/dialog";
import { isMobile } from "./device";
import { adoptMobileLayer } from "./mobile-layers";
import type { CategoryDef } from "../core/types";
import { DEFAULT_CATEGORIES } from "../core/types";
import type { PanelCtx } from "./panel";
import { escape } from "./view-common";
import { icons } from "./icons";
import { enableDialogResize } from "./dialog-resize";
import { t as _t } from "../core/i18n";


const PALETTE = ["#e05a4c", "#3d82d6", "#43a05c", "#e0972f", "#8a63d2", "#2fa6a0", "#d4568f", "#6b7280"];

function genId(): string {
  return "cat-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

function listHtml(cats: CategoryDef[], editIdx: number | null): string {
  if (!cats.length) {
    return `<div class="caldav-catmgr-empty">${_t("暂无分类，点击「添加新分类」创建")}</div>`;
  }
  return cats
    .map((c, i) => {
      const editing = i === editIdx;
      return `<div class="caldav-catmgr-row ${editing ? "is-editing" : ""}" data-idx="${i}">
  <span class="caldav-catmgr-idx">${i + 1}</span>
  <span class="caldav-catmgr-icon" style="background:${escape(c.color)}">${escape(c.icon)}</span>
  <span class="caldav-catmgr-dot" style="background:${escape(c.color)}"></span>
  ${
    editing
      ? `<input class="caldav-input caldav-catmgr-name-input" data-edit="name" value="${escape(c.name)}" placeholder="${_t("分类名称")}"/>
         <input class="caldav-catmgr-color-input" type="color" data-edit="color" value="${escape(c.color)}" title="${_t("颜色")}"/>
         <input class="caldav-input caldav-catmgr-icon-input" data-edit="icon" value="${escape(c.icon)}" maxlength="2" placeholder="${_t("图标")}" title="${_t("图标（")}emoji ${_t("或单字符）")}"/>`
      : `<span class="caldav-catmgr-name">${escape(c.name)}</span>`
  }
  <span class="caldav-flex"></span>
  <button type="button" class="caldav-catmgr-btn" data-mgr="edit" title="${editing ? _t("完成编辑") : _t("编辑")}">${editing ? icons.check : icons.pencil}</button>
  <button type="button" class="caldav-catmgr-btn" data-mgr="del" title="${_t("删除")}">${icons.trash}</button>
  <span class="caldav-catmgr-arrows">
    <button type="button" class="caldav-catmgr-btn" data-mgr="up" title="${_t("上移")}" ${i === 0 ? "disabled" : ""}><span class="caldav-catmgr-arrow-up">${icons.chevron}</span></button>
    <button type="button" class="caldav-catmgr-btn" data-mgr="down" title="${_t("下移")}" ${i === cats.length - 1 ? "disabled" : ""}>${icons.chevron}</button>
  </span>
</div>`;
    })
    .join("");
}

function mgrHtml(cats: CategoryDef[]): string {
  return `
<div class="caldav-editor-form">
  <div class="caldav-catmgr-actions">
    <button type="button" class="caldav-foot-btn caldav-foot-btn--primary" data-mgr="add">${icons.plus} ${_t("添加新分类")}</button>
    <button type="button" class="caldav-foot-btn caldav-foot-btn--ghost" data-mgr="reset">${icons.reset} ${_t("重置为默认")}</button>
  </div>
  <div class="caldav-catmgr-hint">💡 ${_t("使用")} ↑↓ ${_t("按钮调整分类排序")}</div>
  <div class="caldav-catmgr-list" data-mgr-list>${listHtml(cats, null)}</div>
</div>

<div class="caldav-editor-foot">
  <span class="caldav-catmgr-note">${_t("分类用于任务编辑弹窗的快捷选择，保存在本机插件数据中")}</span>
  <div class="caldav-editor-error" data-error></div>
  <span class="caldav-flex"></span>
  <button type="button" class="caldav-foot-btn caldav-foot-btn--ghost" data-action="cancel">${icons.close} ${_t("取消")}</button>
  <button type="button" class="caldav-foot-btn caldav-foot-btn--primary" data-action="save">${icons.check} ${_t("保存")}</button>
</div>`;
}

export function openCategoryManager(ctx: PanelCtx): void {
  const store = ctx.store;
  // 工作副本：点「保存」才写回 store
  let cats: CategoryDef[] = JSON.parse(
    JSON.stringify(store.settings.categories?.length ? store.settings.categories : DEFAULT_CATEGORIES)
  );
  let editIdx: number | null = null;

  // 移动端竖屏放不下 500px 定宽弹窗，改为占满视口
  const mobile = isMobile();
  const dialog = newDialog({
    title: _t("分类管理"),
    content: `<div class="caldav-catmgr caldav-editor">${mgrHtml(cats)}</div>`,
    width: mobile ? "100vw" : "500px",
    height: mobile ? "100vh" : "72vh",
    containerClassName: mobile ? "caldav-mobile-dialog" : undefined,
    destroyCallback: () => {}
  });
  // 移动端：分类管理是从编辑弹窗里开出来的**次级弹窗** —— 打开时只收掉多余的层，
  // 保住下面的编辑弹窗（它上面可能还压着没保存的修改），关掉即回到编辑（见 ui/mobile-layers.ts）
  adoptMobileLayer(dialog, "sub");
  const el = dialog.element.querySelector(".caldav-catmgr") as HTMLElement;
  enableDialogResize(dialog);
  const errEl = el.querySelector("[data-error]") as HTMLElement;
  const listEl = el.querySelector("[data-mgr-list]") as HTMLElement;

  const commitEdit = () => {
    if (editIdx == null || !cats[editIdx]) {
      editIdx = null;
      return;
    }
    const nameInput = listEl.querySelector<HTMLInputElement>('[data-edit="name"]');
    const colorInput = listEl.querySelector<HTMLInputElement>('[data-edit="color"]');
    const iconInput = listEl.querySelector<HTMLInputElement>('[data-edit="icon"]');
    const name = (nameInput?.value || "").trim();
    if (!name) {
      errEl.textContent = _t("分类名称不能为空");
      return;
    }
    errEl.textContent = "";
    cats[editIdx] = {
      ...cats[editIdx],
      name,
      color: colorInput?.value || cats[editIdx].color,
      icon: (iconInput?.value || "").trim() || cats[editIdx].icon
    };
    editIdx = null;
  };

  const render = () => {
    listEl.innerHTML = listHtml(cats, editIdx);
  };

  el.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    // 顶部动作（添加 / 重置）
    const act = t.closest<HTMLElement>("[data-mgr]");
    if (act && el.contains(act)) {
      const a = act.dataset.mgr!;
      if (a === "add") {
        commitEdit();
        cats.push({ id: genId(), name: `${_t("新分类")} ${cats.length + 1}`, color: PALETTE[cats.length % PALETTE.length], icon: "🏷" });
        editIdx = cats.length - 1;
        render();
        listEl.querySelector<HTMLInputElement>('[data-edit="name"]')?.focus();
        listEl.querySelector<HTMLInputElement>('[data-edit="name"]')?.select();
        return;
      }
      if (a === "reset") {
        cats = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
        editIdx = null;
        errEl.textContent = "";
        render();
        return;
      }
      // 行内动作
      const row = act.closest<HTMLElement>(".caldav-catmgr-row");
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (a === "edit") {
        if (editIdx === idx) {
          commitEdit();
        } else {
          commitEdit();
          editIdx = idx;
        }
        render();
        if (editIdx === idx) listEl.querySelector<HTMLInputElement>('[data-edit="name"]')?.focus();
        return;
      }
      if (a === "del") {
        commitEdit();
        cats.splice(idx, 1);
        render();
        return;
      }
      if (a === "up" && idx > 0) {
        commitEdit();
        [cats[idx - 1], cats[idx]] = [cats[idx], cats[idx - 1]];
        render();
        return;
      }
      if (a === "down" && idx < cats.length - 1) {
        commitEdit();
        [cats[idx + 1], cats[idx]] = [cats[idx], cats[idx + 1]];
        render();
        return;
      }
    }
    if (t.closest('[data-action="cancel"]')) {
      dialog.destroy();
      return;
    }
    if (t.closest('[data-action="save"]')) {
      commitEdit();
      const names = new Set<string>();
      for (const c of cats) {
        if (!c.name.trim()) {
          errEl.textContent = _t("分类名称不能为空");
          return;
        }
        if (names.has(c.name.trim())) {
          errEl.textContent = `${_t("分类名称重复：")}${c.name.trim()}`;
          return;
        }
        names.add(c.name.trim());
      }
      store.settings.categories = cats;
      store.saveSettings();
      dialog.destroy();
    }
  });
}
