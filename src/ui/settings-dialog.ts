/**
 * 设置面板：多日历账户（2026-10-25 重构）。
 *
 * 结构：顶部「账户」段（卡片列表 + 手风琴展开「服务器 / 日历 / 策略」三段，
 * 服务器/日历/同步/附件上限已下沉到账户——附件与 ICS 上限是服务器特性，
 * 2026-10-26 随账户走）+ 全局段（同步间隔 / 默认账户与日历 / 提醒 / 日记 /
 * 本地数据）。老单账户数据由 core/types.ts 的 migrateToAccounts() 迁进
 * accounts[0]，本页读写都走账户。
 */
import { Dialog, showMessage } from "siyuan";
import { newDialog } from "@/ui/dialog";
import { isMobile } from "./device";
import type { CalAccount, CalCalendar, CalSettings } from "../core/types";
import {
  calEventColor,
  calTodoColor,
  enabledAccounts,
  enabledCalendars,
  findCalendarByUrl,
  migrateToAccounts,
  newAccountId,
  normalizeCalendarColors,
  resolveDefaultCalendar
} from "../core/types";
import { testConnection, discoverCalendars, describeNetworkError } from "../core/caldav";
import { clearAuthCache } from "../core/http";
import { forceRefreshChinaCalendar, getLastHolidayError } from "../core/holiday-cn";
import { DOCK_FILTER_OPTIONS, TASK_FILTER_OPTIONS } from "./filter-pref";
import type { PanelCtx } from "./panel";
import { escape } from "./view-common";
import { enableDialogResize } from "./dialog-resize";
import { icons } from "./icons";
import { adoptMobileLayer, isDialogAlive } from "./mobile-layers";

/**
 * 当前打开的设置弹层（单例）。
 *
 * 设置是「只该有一个」的窗口：同一个入口若因任何原因被重复触发
 * （曾出现过 Dock 容器被重复挂载 → 同一元素上叠加两个点击处理器 → 一次点击触发两次），
 * 就会弹出两个一模一样的设置窗口，关一个还剩一个 —— 用户得关两次。
 * 这里做单例收口，重复触发只是把焦点交回已有窗口。
 */
let activeSettings: Dialog | null = null;

/** 新建一个空白账户（「添加账户」用；默认值对齐原单账户 DEFAULT_SETTINGS） */
function blankAccount(seq: number): CalAccount {
  return {
    id: newAccountId(),
    name: `新账户 ${seq}`,
    enabled: true,
    serverUrl: "",
    username: "",
    password: "",
    calendarPath: "",
    serverType: "caldav",
    channel: "auto",
    conflict: "server",
    pastDays: 90,
    futureDays: 370,
    calendars: []
  };
}

export function openSettingsDialog(ctx: PanelCtx): Promise<void> {
  return new Promise((resolve) => {
    if (activeSettings && isDialogAlive(activeSettings)) {
      activeSettings.element.querySelector<HTMLElement>("input, button, select")?.focus({ preventScroll: true });
      resolve();
      return;
    }
    const s = ctx.store.settings;
    // 移动端竖屏放不下 640px 定宽弹窗，改为占满视口
    const mobile = isMobile();
    const dialog = newDialog({
      title: "CalDAV 同步设置",
      content: `<div class="caldav-settings"></div>`,
      width: mobile ? "100vw" : "640px",
      height: mobile ? "100vh" : "86vh",
      containerClassName: mobile ? "caldav-mobile-dialog" : undefined,
      // 设置页被层管理收掉时（比如用户在设置页里又开了别的入口）也要 resolve，
      // 否则调用方 `.then(…, renderAll)` 永远等不到，界面停在旧数据上。
      destroyCallback: () => {
        if (activeSettings === dialog) activeSettings = null;
        resolve();
      }
    });
    activeSettings = dialog;
    // 移动端：设置页是「叠在当前页面之上」的一层 —— 打开时扫掉下面的残留层，
    // 关一次即回到原处（见 ui/mobile-layers.ts）。漏了这一步，关设置页就会
    // 一层层往下顶，得连点好几次。
    adoptMobileLayer(dialog, "sheet");
    const el = dialog.element.querySelector(".caldav-settings") as HTMLElement;
    enableDialogResize(dialog);
    const $ = (sel: string) => el.querySelector(sel) as HTMLInputElement | null;

    /** 当前展开（手风琴）的账户 id；null = 全都收起 */
    let activeAccId: string | null = s.accounts.length === 1 ? s.accounts[0].id : null;
    /** 「删除账户」二次点击确认的 armed id（项目约定：删除类禁用 confirm()） */
    let delArmed: string | null = null;
    let delArmTimer: ReturnType<typeof setTimeout> | null = null;
    /** 「立即清理」二次点击确认 */
    let purgeArmed = false;
    let purgeArmTimer: ReturnType<typeof setTimeout> | null = null;

    const activeAcc = (): CalAccount | undefined =>
      s.accounts.find((a) => a.id === activeAccId);

    /**
     * 展开中账户的卡片元素。**账户字段的查找只允许在它里面做**（配合 accountCardHtml
     * 「收起的卡不渲染 body」）：曾经用 el.querySelector 全局按 data-s 找输入框，收起卡的
     * body 还在 DOM 里（哪怕 hidden），结果全落到第一张卡上 —— 保存第二个账户写进去的
     * 是第一个账户的服务器/用户名/密码（2026-10-25 雄哥实测，见 accountCardHtml 注释）。
     */
    const activeCard = (): HTMLElement | null => {
      if (!activeAccId) return null;
      const cards = el.querySelectorAll<HTMLElement>(".caldav-acc");
      for (const c of Array.from(cards)) if (c.dataset.acc === activeAccId) return c;
      return null;
    };
    /** 展开中账户卡片内的输入框（没有展开的账户时为 null） */
    const $acc = (sel: string): HTMLInputElement | null =>
      activeCard()?.querySelector<HTMLInputElement>(sel) ?? null;

    /**
     * 把展开账户的输入写回账户对象（服务器 / 同步 / 日历勾选与颜色）。
     *
     * 两个调用方，缺任何一边都会丢用户刚填的东西：
     *  1. 保存（bindSave）—— 原保存逻辑的主体，抽出来共用；
     *  2. **任何会 rerender 的操作之前**（停用开关、添加账户、发现日历成功、删除确认）——
     *     rerender 会用账户对象重建全部输入框，不先把输入落进对象，重渲一次就全白了
     *     （2026-10-25：点「发现日历」成功后重渲，刚填的服务器地址/用户名被抹掉；
     *     日历勾选与配色同理，且 discover 的「保留已存在日历配置」也要读它们）。
     */
    function flushAccountInputs(acc: CalAccount): void {
      const card = activeCard();
      if (!card) return;
      const q = (sel: string) => card.querySelector<HTMLInputElement>(sel);
      acc.name = q("input[data-s='accName']")?.value.trim() || acc.name;
      acc.serverUrl = q("input[data-s='server']")?.value.trim() || "";
      acc.username = q("input[data-s='username']")?.value.trim() || "";
      // 密码框留空 = 保持原样。解密失败时输入框本就是空的，用户只想改别的字段
      // 却点保存 —— 若无条件用空值覆盖，密码就被抹掉了（这正是丢密码的直接原因之一）。
      const pwInput = q("input[data-s='password']")?.value || "";
      if (pwInput) {
        acc.password = pwInput;
        ctx.store.secretBroken = false;
        ctx.store.pendingUnlock = false;
      }
      acc.calendarPath = q("input[data-s='path']")?.value.trim() || "";
      acc.serverType = (q("select[data-s='serverType']")?.value || "caldav") as CalAccount["serverType"];
      acc.channel = (q("select[data-s='channel']")?.value || "auto") as CalAccount["channel"];
      acc.conflict = (q("select[data-s='conflict']")?.value || "server") as CalAccount["conflict"];
      acc.pastDays = Math.max(7, +(q("input[data-s='past']")?.value || "0") || 90);
      acc.futureDays = Math.max(30, +(q("input[data-s='future']")?.value || "0") || 370);
      // 附件/ICS 体积上限（MB）：服务器特性，账户级。留空或非法 → 回退默认（与 ics.ts 常量一致）
      acc.attachSizeMaxMB = Math.max(1, +(q("input[data-s='attachMax']")?.value || "0") || 5);
      acc.icsSizeMaxMB = Math.max(1, +(q("input[data-s='icsMax']")?.value || "0") || 10);
      // 勾选的日历
      card.querySelectorAll<HTMLElement>(".caldav-acc-cal").forEach((row) => {
        const c = acc.calendars[+row.dataset.idx!];
        if (!c) return;
        c.enabled = (row.querySelector("input[type='checkbox']") as HTMLInputElement).checked;
        const nameInput = row.querySelector("input[data-role='name']") as HTMLInputElement;
        if (nameInput.value.trim()) c.displayName = nameInput.value.trim();
        // 日程 / 待办各自的默认色（药丸即取色器）。没出药丸的一侧保持原值不动
        const evInput = row.querySelector("input[data-role='eventColor']") as HTMLInputElement | null;
        if (evInput?.value) c.eventColor = evInput.value;
        const tdInput = row.querySelector("input[data-role='todoColor']") as HTMLInputElement | null;
        if (tdInput?.value) c.todoColor = tdInput.value;
      });
      // 补齐缺的一侧 + 把旧 color 镜像成 eventColor（旧版本端读同一份数据不会变灰）
      normalizeCalendarColors(acc.calendars);
    }

    // ── 渲染 ────────────────────────────────────────────────
    const rerender = (): void => {
      el.innerHTML = settingsHtml(s, mobile, activeAccId);
      bindAll();
    };

    // ── 账户段交互 ──────────────────────────────────────────
    function bindAccounts(): void {
      // 展开 / 收起（点卡片头，避开开关与按钮）
      el.querySelectorAll<HTMLElement>(".caldav-acc-head").forEach((head) => {
        head.addEventListener("click", (ev) => {
          const t = ev.target as HTMLElement;
          if (t.closest("input,button")) return; // 开关/删除按钮不触发展开
          const id = head.parentElement!.dataset.acc!;
          activeAccId = activeAccId === id ? null : id;
          rerender();
        });
      });
      // 启用开关：即时生效（不用等保存——停用后视图立刻不显示，用户要能马上看到）
      el.querySelectorAll<HTMLInputElement>("input[data-acc-toggle]").forEach((cb) => {
        cb.addEventListener("change", () => {
          const acc = s.accounts.find((a) => a.id === cb.dataset.accToggle);
          if (!acc) return;
          // 先把展开账户里填了一半的值落回对象：下面这个 rerender 会用账户对象
          // 重建全部输入框，不落盘就全白了（flushAccountInputs 的说明）
          const cur = activeAcc();
          if (cur) flushAccountInputs(cur);
          acc.enabled = cb.checked;
          void ctx.store.persist();
          ctx.refreshPanels?.();
          rerender();
        });
      });
      // 添加账户
      el.querySelector("[data-action='acc-add']")?.addEventListener("click", () => {
        const cur = activeAcc();
        if (cur) flushAccountInputs(cur); // 同上：别让重渲抹掉上一个账户填了一半的值
        const acc = blankAccount(s.accounts.length + 1);
        s.accounts.push(acc);
        activeAccId = acc.id; // 新账户直接展开，顺手就能填
        rerender();
      });
      // 删除账户：第一次点只展开确认条（含「是否清理本地条目」选项），确认才真删
      el.querySelectorAll<HTMLButtonElement>("button[data-action='acc-del']").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.accDel!;
          const card = el.querySelector<HTMLElement>(`.caldav-acc[data-acc="${CSS.escape(id)}"]`);
          const conf = card?.querySelector<HTMLElement>("[data-acc-delconf]");
          if (!conf) return;
          const acc = s.accounts.find((a) => a.id === id);
          if (!acc) return;
          const showing = !conf.hidden;
          // 再点一次头像区域的删除 = 收起确认条
          el.querySelectorAll<HTMLElement>("[data-acc-delconf]").forEach((c) => (c.hidden = true));
          if (showing) return;
          const n = ctx.store
            .getAll()
            .filter((it) => (acc.calendars || []).some((c) => c.url === it.calendarUrl)).length;
          const label = conf.querySelector<HTMLElement>("[data-acc-deln]");
          if (label) label.textContent = String(n);
          const purgeCb = conf.querySelector<HTMLInputElement>("input[type='checkbox']");
          if (purgeCb) purgeCb.checked = false; // 默认不勾选：删除类操作保守起步
          conf.hidden = false;
          // 确认删除
          conf.querySelector("[data-action='acc-del-ok']")?.addEventListener("click", async () => {
            const idx = s.accounts.findIndex((a) => a.id === id);
            if (idx < 0) return;
            const cur = activeAcc();
            if (cur) flushAccountInputs(cur); // 删完也要重渲，先落盘
            const alsoPurge = !!purgeCb?.checked;
            const purged = alsoPurge ? await ctx.store.purgeAccountItems(id) : 0;
            s.accounts.splice(idx, 1);
            if (activeAccId === id) activeAccId = null;
            await ctx.store.persist();
            clearAuthCache();
            ctx.sync.startAutoSync();
            rerender();
            ctx.refreshPanels?.();
            showMessage(
              purged
                ? `已删除账户「${acc.name}」，并清理其 ${purged} 条本地条目（已备份，可恢复）`
                : `已删除账户「${acc.name}」（本地条目保留，可重新添加账户后恢复显示）`,
              6000,
              "info"
            );
          });
          // 取消
          conf.querySelector("[data-action='acc-del-cancel]")?.addEventListener("click", () => {
            conf.hidden = true;
          });
        });
      });
    }

    // ── 服务器 / 测试 / 发现 ────────────────────────────────
    function bindServer(): void {
      // 账户字段一律在**展开卡的 body 里**找（$acc/activeCard），不能用 el.querySelector
      // 全局找 —— 理由见 accountCardHtml 与 activeCard 的注释（2026-10-25 串账户事故）。
      // 没有展开的账户时这些按钮本就不在 DOM 里，自然没人可点。
      // 服务器类型切换：选 iCloud 且地址为空时自动填 https://caldav.icloud.com
      activeCard()
        ?.querySelector<HTMLSelectElement>("select[data-s='serverType']")
        ?.addEventListener("change", (e) => {
          const sel = (e.target as HTMLSelectElement).value;
          if (sel === "icloud") {
            const serverInput = $acc("input[data-s='server']");
            if (serverInput && !serverInput.value.trim()) serverInput.value = "https://caldav.icloud.com";
          }
        });

      activeCard()?.querySelector("[data-action='test']")?.addEventListener("click", () => {
        const acc = activeAcc();
        const server = $acc("input[data-s='server']")?.value.trim() || "";
        const username = $acc("input[data-s='username']")?.value.trim() || "";
        const password = $acc("input[data-s='password']")?.value || "";
        const channel = ($acc("select[data-s='channel']")?.value || "auto") as CalAccount["channel"];
        const msgEl = activeCard()?.querySelector<HTMLElement>("[data-acc-msg]") ?? null;
        if (!server) {
          if (msgEl) {
            msgEl.textContent = "服务器地址不能为空";
            msgEl.classList.remove("is-ok");
            msgEl.classList.add("is-err");
          }
          return;
        }
        if (msgEl) {
          msgEl.textContent = "正在测试连接…";
          msgEl.classList.remove("is-ok", "is-err");
        }
        void testConnection(server, channel, { username, password: password || acc?.password || "" }).then((r) => {
          if (!msgEl) return;
          msgEl.textContent = r.message;
          msgEl.classList.toggle("is-ok", r.ok);
          msgEl.classList.toggle("is-err", !r.ok);
        });
      });

      activeCard()?.querySelector("[data-action='discover']")?.addEventListener("click", async () => {
        const acc = activeAcc();
        if (!acc) return;
        // 先把已填的服务器/用户名/日历配置落回账户：下面 discover 成功后会 rerender
        // 重建输入框，不落盘刚填的全被抹掉；existing 映射也要靠它们保留原配置
        flushAccountInputs(acc);
        const server = $acc("input[data-s='server']")?.value.trim() || "";
        const username = $acc("input[data-s='username']")?.value.trim() || "";
        const password = $acc("input[data-s='password']")?.value || "";
        const channel = ($acc("select[data-s='channel']")?.value || "auto") as CalAccount["channel"];
        const path = $acc("input[data-s='path']")?.value.trim() || "";
        const msgEl = activeCard()?.querySelector<HTMLElement>("[data-acc-msg]") ?? null;
        if (msgEl) {
          msgEl.textContent = "正在发现日历…";
          msgEl.classList.remove("is-ok", "is-err");
        }
        try {
          const r = await discoverCalendars(server, channel, { username, password: password || acc.password }, path);
          // 已存在的日历保留原配置（启用状态/颜色/sync-token），只补新发现的
          const existing = new Map((acc.calendars || []).map((c) => [c.url, c]));
          acc.calendars = r.calendars.map((c) => existing.get(c.url) || { ...c, enabled: true });
          normalizeCalendarColors(acc.calendars);
          rerender();
          const msg2 = activeCard()?.querySelector<HTMLElement>("[data-acc-msg]") ?? null;
          if (msg2) {
            msg2.textContent = `发现 ${r.calendars.length} 个日历，请勾选后保存`;
            msg2.classList.add("is-ok");
          }
        } catch (e: any) {
          if (msgEl) {
            msgEl.textContent = "发现失败: " + describeNetworkError(e, channel);
            msgEl.classList.add("is-err");
          }
        }
      });
    }

    // ── 提醒自检 ────────────────────────────────────────────
    function bindRemind(): void {
      const remindBtn = el.querySelector("[data-action='test-remind']") as HTMLButtonElement | null;
      const remindMsg = el.querySelector("[data-remind-status]") as HTMLElement | null;
      const refreshRemindStatus = () => {
        if (remindMsg) remindMsg.textContent = ctx.reminderStatus?.() || "";
      };
      refreshRemindStatus();
      remindBtn?.addEventListener("click", async () => {
        if (!ctx.testReminder) {
          if (remindMsg) remindMsg.textContent = "当前环境不支持测试提醒";
          return;
        }
        remindBtn.disabled = true;
        if (remindMsg) remindMsg.textContent = "正在发送测试提醒…";
        try {
          const r = await ctx.testReminder();
          if (remindMsg) remindMsg.textContent = r;
        } catch (e: any) {
          if (remindMsg) remindMsg.textContent = "测试失败：" + (e?.message || e);
        } finally {
          remindBtn.disabled = false;
          // 稍后回到排程状态，让「已排程 N 条」能被看到
          setTimeout(refreshRemindStatus, 4000);
        }
      });
    }

    // ── 「本地数据」区块：手动清理 + 恢复 ────────────────────
    function bindPurge(): void {
      const purgeMsg = el.querySelector("[data-purge-msg]") as HTMLElement | null;
      const purgeInfo = el.querySelector("[data-purge-info]") as HTMLElement | null;
      const purgeRestoreBtn = el.querySelector("[data-action='purge-restore']") as HTMLButtonElement | null;
      const purgeNowBtn = el.querySelector("[data-action='purge-now']") as HTMLButtonElement | null;
      // 按钮文案单独放 span 里：图标是 SVG 源码串，**不能用 textContent 写**——
      // textContent 不解析 HTML，会把 <svg ...> 当纯文本显示出来（2026-10-24 实测）。
      const purgeNowLabel = el.querySelector("[data-purge-now-label]") as HTMLElement | null;
      const purgeRestoreLabel = el.querySelector("[data-purge-restore-label]") as HTMLElement | null;

      const refreshPurgeUi = (): void => {
        const orphans = ctx.store.orphanItems();
        const bk = ctx.store.purgeBackup;
        if (purgeInfo) {
          const parts: string[] = [];
          parts.push(
            orphans.length
              ? `当前有 ${orphans.length} 条不属于任何已配置账户的本地条目`
              : ctx.store.activeServerOrigins().size
                ? "当前没有其他服务器的本地条目"
                : "尚未启用任何日历（无法判定哪些条目属于其他服务器）"
          );
          if (bk) {
            parts.push(`上次清理于 ${formatTimeText(bk.at)}，共 ${bk.count} 条${bk.removedServers ? `（来自 ${bk.removedServers}）` : ""}`);
          }
          purgeInfo.textContent = parts.join("；");
        }
        if (purgeRestoreBtn) {
          // 没有备份就禁用并隐藏（点下去无事可做只会让人困惑）
          purgeRestoreBtn.hidden = !bk || !bk.items.length;
          purgeRestoreBtn.disabled = !bk || !bk.items.length;
          if (purgeRestoreLabel) {
            purgeRestoreLabel.textContent = bk && bk.items.length
              ? `恢复上次清理的 ${bk.count} 条`
              : "恢复上次清理的条目";
          }
        }
        if (purgeNowBtn) {
          purgeNowBtn.disabled = !orphans.length;
          // 只改文字节点，图标（SVG）原样保留
          if (purgeNowLabel) {
            purgeNowLabel.textContent = orphans.length ? `清理 ${orphans.length} 条其他服务器的本地条目` : "立即清理其他服务器的本地条目";
          }
        }
      };
      refreshPurgeUi();

      // 「立即清理」：**二次点击确认**（不用 confirm()，见项目约定）。
      // 第一次点只把按钮文案改成「再点一次确认清理」，第二次才真删。
      purgeNowBtn?.addEventListener("click", async () => {
        const orphans = ctx.store.orphanItems();
        if (!orphans.length) {
          if (purgeMsg) {
            purgeMsg.textContent = "没有需要清理的其他服务器条目";
            purgeMsg.classList.remove("is-ok");
            purgeMsg.classList.add("is-err");
          }
          return;
        }
        if (!purgeArmed) {
          purgeArmed = true;
          if (purgeNowLabel) purgeNowLabel.textContent = `再点一次确认清理 ${orphans.length} 条`;
          if (purgeArmTimer) clearTimeout(purgeArmTimer);
          purgeArmTimer = setTimeout(() => {
            purgeArmed = false;
            refreshPurgeUi();
          }, 5000);
          return;
        }
        purgeArmed = false;
        if (purgeArmTimer) clearTimeout(purgeArmTimer);
        // 手动清理**即时生效** —— 用户点了就是明确意图
        const n = await ctx.store.purgeOrphanItems();
        if (purgeMsg) {
          purgeMsg.textContent = n ? `已清理 ${n} 条其他服务器的本地条目（已备份，可恢复）` : "没有需要清理的条目";
          purgeMsg.classList.toggle("is-ok", n > 0);
          purgeMsg.classList.remove("is-err");
        }
        refreshPurgeUi();
        ctx.refreshPanels?.();
      });

      purgeRestoreBtn?.addEventListener("click", async () => {
        const n = await ctx.store.restorePurgedItems();
        if (purgeMsg) {
          purgeMsg.textContent = n ? `已恢复 ${n} 条条目` : "没有可恢复的条目";
          purgeMsg.classList.toggle("is-ok", n > 0);
          purgeMsg.classList.remove("is-err");
        }
        refreshPurgeUi();
        ctx.refreshPanels?.();
      });
    }

    // ── 保存 ────────────────────────────────────────────────
    function bindSave(): void {
      el.querySelector("[data-action='save']")?.addEventListener("click", async () => {
        const msgEl = el.querySelector("[data-acc-msg]") as HTMLElement | null;
        // 展开中的账户：把「服务器 / 同步」输入写回该账户（未展开的账户输入框
        // 根本不在 DOM 里，它们的值原样保留在 settings.accounts 中，不受影响）
        const acc = activeAcc();
        if (acc) {
          // 展开中的账户：把「服务器 / 同步 / 日历」输入写回该账户。未展开的账户
          // 输入框根本不在 DOM 里（accountCardHtml 只给展开卡渲染 body），它们的值
          // 原样保留在 settings.accounts 中，不受影响。
          // ⚠️ 查找一律走 flushAccountInputs 里的 activeCard() 收口：曾经这里是
          // el.querySelector 全局找，收起卡的 body 还在 DOM 里，保存第二个账户
          // 写进去的竟是第一个账户的值（2026-10-25 雄哥实测，见 activeCard 注释）。
          flushAccountInputs(acc);
        }
        // ── 全局字段 ──
        s.syncIntervalMin = Math.max(0, +($("input[data-s='interval']")?.value || "0") || 0);
        const wasRemindOn = s.enableReminders;
        s.enableReminders = ($("input[data-s='reminders']") as HTMLInputElement | null)?.checked;
        s.includeOverdueTodos = ($("input[data-s='includeOverdue']") as HTMLInputElement | null)?.checked;
        // 中国日历叠加层
        s.showHolidaysCN = ($("input[data-s='showHolidaysCN']") as HTMLInputElement | null)?.checked;
        s.showLunarCN = ($("input[data-s='showLunarCN']") as HTMLInputElement | null)?.checked;
        s.showTermCN = ($("input[data-s='showTermCN']") as HTMLInputElement | null)?.checked;
        s.holidayCnSource = (($("select[data-s='holidayCnSource']")?.value || "holiday-cn") as CalSettings["holidayCnSource"]);
        s.holidayCnCustomUrl = ($("input[data-s='holidayCnCustomUrl']")?.value || "").trim();
        s.holidayCnUpdateFreq = (($("select[data-s='holidayCnUpdateFreq']")?.value || "weekly") as CalSettings["holidayCnUpdateFreq"]);
        // 杂项：两处筛选下拉的默认值（"last" = 上次使用项）
        s.defaultDockFilter = (($("select[data-s='defaultDockFilter']")?.value || "last") as CalSettings["defaultDockFilter"]);
        s.defaultTaskFilter = (($("select[data-s='defaultTaskFilter']")?.value || "last") as CalSettings["defaultTaskFilter"]);
        // 默认账户/日历：两级选择（「自动」= 空串）。选中的日历被停用/删掉时
        // resolveDefaultCalendar() 会回退默认账户 → 第一个启用账户的第一个启用日历
        const daSel = $("select[data-s='defaultAcc']")?.value || "";
        s.defaultAccountId = daSel || undefined;
        const dcSel = $("select[data-s='defaultCal']")?.value || "";
        s.defaultCalendarUrl = dcSel || undefined;
        await ctx.store.persist();
        // 凭据或服务器地址可能刚被改过：丢掉 Digest 协商缓存，
        // 否则下次请求会拿着旧 nonce/旧密码重发，白挨一次 401
        clearAuthCache();
        ctx.sync.startAutoSync();
        dialog.destroy();
        resolve();
        // persist() 只落盘、不 emit，所以保存后已打开的面板不会自己重渲染 ——
        // 这里统一刷一次。日历勾选 / 颜色 / 同步窗口这些改了都得立刻看得见。
        ctx.refreshPanels?.();
        // 首次开启提醒：立刻发一条测试提醒，让用户当场看到效果（同时验证投递通道）
        // 注意桌面端 Electron 不会有系统授权弹窗，这一点已写在设置页说明里。
        if (s.enableReminders) {
          if (!wasRemindOn) {
            void ctx.testReminder?.();
            showMessage("提醒已开启，并已发送一条测试提醒", 6000, "info");
          } else {
            showMessage("提醒设置已保存", 4000, "info");
          }
        }
        if (msgEl) msgEl.textContent = "";
      });
      el.querySelector("[data-action='cancel']")?.addEventListener("click", () => {
        dialog.destroy();
        resolve();
      });
    }

    function bindAll(): void {
      bindAccounts();
      bindServer();
      bindRemind();
      bindPurge();
      bindChinaCalendar();
      bindSave();
      bindDefaultPicker();
      // 每个账户 body 里的取色药丸各自绑定（事件委托在 innerHTML 重渲后会丢）
      el.querySelectorAll<HTMLElement>("[data-cals]").forEach(bindColorPills);
    }

    /** 中国日历分组：数据源切换显隐自定义 URL；「立即检查更新」强制拉取当年+次年 */
    function bindChinaCalendar(): void {
      const srcSel = el.querySelector<HTMLSelectElement>("select[data-s='holidayCnSource']");
      const customWrap = el.querySelector<HTMLElement>("#caldav-cn-custom");
      srcSel?.addEventListener("change", () => {
        if (customWrap) customWrap.style.display = srcSel.value === "custom" ? "" : "none";
      });
      el.querySelector("[data-action='cn-refresh']")?.addEventListener("click", async (ev) => {
        const btn = ev.currentTarget as HTMLElement;
        const msg = el.querySelector("[data-cn-msg]") as HTMLElement | null;
        const custom = srcSel?.value === "custom";
        const tmp: CalSettings = {
          ...s,
          holidayCnSource: (srcSel?.value || "holiday-cn") as CalSettings["holidayCnSource"],
          holidayCnCustomUrl: ($("input[data-s='holidayCnCustomUrl']")?.value || "").trim()
        };
        if (custom && !tmp.holidayCnCustomUrl) {
          if (msg) msg.textContent = "请先填写自定义 URL";
          return;
        }
        const y = new Date().getFullYear();
        if (msg) msg.textContent = "检查中…";
        btn.setAttribute("disabled", "true");
        try {
          const ok = await forceRefreshChinaCalendar(tmp, [y, y + 1]);
          if (msg) {
            if (ok) { msg.textContent = "已更新（重新打开日历视图即可见）"; msg.style.color = ""; }
            else {
              const err = getLastHolidayError();
              msg.textContent = "拉取失败：" + (err || "未知原因");
              msg.style.color = "var(--caldav-danger, #d23f3f)";
            }
          }
          ctx.refreshPanels?.();
        } catch {
          if (msg) msg.textContent = "拉取失败（请检查网络或数据源 URL）";
        } finally {
          btn.removeAttribute("disabled");
        }
      });
    }

    /** 默认账户 → 默认日历两级联动：换账户后日历下拉重填为该账户的启用日历（只改 options，不重渲整页） */
    function bindDefaultPicker(): void {
      const accSel = el.querySelector<HTMLSelectElement>("select[data-s='defaultAcc']");
      const calSel = el.querySelector<HTMLSelectElement>("select[data-s='defaultCal']");
      accSel?.addEventListener("change", () => {
        if (!calSel) return;
        const acc = s.accounts.find((a) => a.id === accSel.value && a.enabled);
        const cals = acc ? (acc.calendars || []).filter((c) => c.enabled) : enabledCalendars(s);
        // 原默认日历若仍在新账户的列表里就保持选中，否则回落「自动」
        const keep = !!s.defaultCalendarUrl && cals.some((c) => c.url === s.defaultCalendarUrl);
        calSel.innerHTML =
          `<option value="" ${keep ? "" : "selected"}>自动（所选账户的第一个启用日历）</option>` +
          cals
            .map(
              (c) =>
                `<option value="${escape(c.url)}" ${s.defaultCalendarUrl === c.url ? "selected" : ""}>${escape(c.displayName)}</option>`
            )
            .join("");
      });
    }

    if (ctx.store.secretBroken) {
      // 密码密文是「另一台设备用另一把密钥」写的 —— 多端共用同一份数据，密钥却各不同。
      // 说清楚原因，用户才知道为什么要重输，而不是以为密码被吞了。
      showMessage("密码解不开：这段密文由另一台设备写入。请在本机重新输入一次密码并保存，之后各端都会一致", 8000, "error");
    } else if (ctx.store.pendingUnlock) {
      showMessage("密码待解密（密钥尚未就绪），稍后自动重试；若长时间未恢复，请重新输入密码并保存", 8000, "error");
    }

    rerender();
  });
}

/**
 * ISO 时间戳 → 本地可读时间（如 "2026/10/24 17:40"）。
 *
 * 解析不了就原样返回，绝不显示 "Invalid Date" —— 那看着像出了故障。
 */
function formatTimeText(iso: string): string {
  const ms = Date.parse(iso || "");
  if (Number.isNaN(ms)) return iso || "某个时间";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 设置页 HTML。**导出供回归测试渲染校验**（按钮图标是否被当纯文本显示等）。 */
export function settingsHtml(s: CalSettings, mobile: boolean, expandedId?: string | null): string {
  // 兼容老结构入参（测试与历史数据）：平铺字段迁进 accounts 后再渲染
  migrateToAccounts(s as any);
  const accounts = s.accounts;
  const accList = accounts.length
    ? accounts.map((a) => accountCardHtml(a, mobile, expandedId)).join("")
    : `<div class="caldav-set-hint">还没有添加任何日历账户。点击下方「添加账户」接入 iCloud、Baïkal、Radicale 等 CalDAV 服务器，可同时添加多个。</div>`;
  return `
<div class="caldav-settings-form">
  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.server}</span>日历账户</div>
    <div class="caldav-acc-list">${accList}</div>
    <div class="caldav-actions-row">
      <button class="caldav-btn caldav-btn--sm" type="button" data-action="acc-add">${icons.plus} 添加账户</button>
    </div>
  </div>

  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.sync}</span>同步</div>
    <div class="caldav-field">
      <label class="caldav-field-label">自动同步间隔（分钟，0 关闭；全局一个周期，会同步所有启用账户）</label>
      <input class="caldav-input" type="number" min="0" data-s="interval" value="${s.syncIntervalMin}"/>
    </div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">新建条目的默认账户</label>
        <div class="caldav-input-wrap">
          <select class="caldav-input" data-s="defaultAcc">
            <option value="" ${!s.defaultAccountId ? "selected" : ""}>自动（第一个启用账户）</option>
            ${enabledAccounts(s)
              .map(
                (a) =>
                  `<option value="${escape(a.id)}" ${s.defaultAccountId === a.id ? "selected" : ""}>${escape(a.name)}</option>`
              )
              .join("")}
          </select>
          <span class="caldav-input-suffix">${icons.chevron}</span>
        </div>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">新建条目的默认日历</label>
        <div class="caldav-input-wrap">
          <select class="caldav-input" data-s="defaultCal">
            <option value="" ${!s.defaultCalendarUrl ? "selected" : ""}>自动（所选账户的第一个启用日历）</option>
            ${defaultCalOptions(s)}
          </select>
          <span class="caldav-input-suffix">${icons.chevron}</span>
        </div>
      </div>
    </div>
  </div>

  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.bell}</span>提醒</div>
    <label class="caldav-check-row">
      <input type="checkbox" data-s="reminders" ${s.enableReminders ? "checked" : ""}/>
      <span>启用提醒通知（仅对设置了提醒时间的日程/待办生效；过点 5 分钟内仍会补发一次）</span>
    </label>
    <div class="caldav-remind-row">
      <button class="caldav-btn" type="button" data-action="test-remind">${icons.bell} 测试提醒</button>
      <span class="caldav-set-hint" data-remind-status></span>
    </div>
    <p class="caldav-set-hint caldav-remind-note">
      到点提醒以「应用内提醒卡片」为准。系统通知能否弹出取决于运行环境：桌面端 Electron
      不提供授权窗口（不会弹窗，内核默认放行），Windows 便携版思源还会因缺少开始菜单快捷方式
      被系统丢弃系统通知 —— 两者都属于已知限制，不影响应用内提醒卡片。
    </p>
  </div>

  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.doc}</span>日记</div>
    <label class="caldav-check-row">
      <input type="checkbox" data-s="includeOverdue" ${s.includeOverdueTodos ? "checked" : ""}/>
      <span>插入日记时包含逾期待办（默认只写当日 / 本周 / 本月范围内的条目，逾期任务不写）</span>
    </label>
  </div>

  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.flag}</span>中国日历</div>
    <p class="caldav-set-hint">在月 / 周 / 日视图的日期数字栏上叠加显示节假日、农历与节气。纯展示，不写入 CalDAV、不参与同步。</p>
    <label class="caldav-check-row">
      <input type="checkbox" data-s="showHolidaysCN" ${s.showHolidaysCN ? "checked" : ""}/>
      <span>显示节假日（国务院每年公布，联网拉取；调休补班标「班」）</span>
    </label>
    <label class="caldav-check-row">
      <input type="checkbox" data-s="showLunarCN" ${s.showLunarCN ? "checked" : ""}/>
      <span>显示农历（内置算法，无需联网）</span>
    </label>
    <label class="caldav-check-row">
      <input type="checkbox" data-s="showTermCN" ${s.showTermCN ? "checked" : ""}/>
      <span>显示节气（内置算法，无需联网）</span>
    </label>
    <div class="caldav-field">
      <label class="caldav-field-label">节假日数据源</label>
      <div class="caldav-input-wrap">
        <select class="caldav-input" data-s="holidayCnSource">
          <option value="timor" ${(s.holidayCnSource || "holiday-cn") === "timor" ? "selected" : ""}>timor.tech（国内部署，推荐）</option>
          <option value="holiday-cn" ${(s.holidayCnSource || "holiday-cn") === "holiday-cn" ? "selected" : ""}>NateScarlet/holiday-cn（jsdelivr，国内常受限）</option>
          <option value="chinese-days" ${s.holidayCnSource === "chinese-days" ? "selected" : ""}>vsme/chinese-days</option>
          <option value="custom" ${s.holidayCnSource === "custom" ? "selected" : ""}>自定义 URL…</option>
        </select>
        <span class="caldav-input-suffix">${icons.chevron}</span>
      </div>
    </div>
    <div class="caldav-field" id="caldav-cn-custom" style="${s.holidayCnSource === "custom" ? "" : "display:none"}">
      <label class="caldav-field-label">自定义数据源 URL（支持 {year} 占位；返回 NateScarlet 的 [{date,name,isOffDay}] 或 timor 的 {holiday:{...}} 均可）</label>
      <input class="caldav-input" type="text" data-s="holidayCnCustomUrl" value="${escape(s.holidayCnCustomUrl || "")}" placeholder="https://your-mirror/{year}.json"/>
    </div>
    <div class="caldav-field">
      <label class="caldav-field-label">更新频率</label>
      <div class="caldav-input-wrap">
        <select class="caldav-input" data-s="holidayCnUpdateFreq">
          <option value="weekly" ${(s.holidayCnUpdateFreq || "weekly") === "weekly" ? "selected" : ""}>每周静默复查一次</option>
          <option value="daily" ${s.holidayCnUpdateFreq === "daily" ? "selected" : ""}>每天静默复查一次</option>
          <option value="manual" ${s.holidayCnUpdateFreq === "manual" ? "selected" : ""}>仅手动（不自动）</option>
        </select>
        <span class="caldav-input-suffix">${icons.chevron}</span>
      </div>
    </div>
    <div class="caldav-actions-row">
      <button class="caldav-btn caldav-btn--sm" type="button" data-action="cn-refresh">${icons.refreshThin} 立即检查更新</button>
      <span class="caldav-set-msg" data-cn-msg></span>
    </div>
  </div>

  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.filter}</span>杂项</div>
    <p class="caldav-set-hint">
      下面两个下拉的**默认值** —— 也就是刚打开时自动选中哪一项。
      默认都是「上次使用项」：记住你上次选的，下次打开直接回到它（记在本机，不随数据同步）。
      也可以固定成某一项，那样每次打开都用它。
    </p>
    <div class="caldav-field">
      <label class="caldav-field-label">左侧 Dock 区默认筛选</label>
      <div class="caldav-input-wrap">
        <select class="caldav-input" data-s="defaultDockFilter">
          <option value="last" ${(s.defaultDockFilter || "last") === "last" ? "selected" : ""}>上次使用项</option>
          ${DOCK_FILTER_OPTIONS.map(
            (o) => `<option value="${o.key}" ${s.defaultDockFilter === o.key ? "selected" : ""}>${o.label}</option>`
          ).join("")}
        </select>
        <span class="caldav-input-suffix">${icons.chevron}</span>
      </div>
    </div>
    <div class="caldav-field">
      <label class="caldav-field-label">任务视图默认筛选</label>
      <div class="caldav-input-wrap">
        <select class="caldav-input" data-s="defaultTaskFilter">
          <option value="last" ${(s.defaultTaskFilter || "last") === "last" ? "selected" : ""}>上次使用项</option>
          ${TASK_FILTER_OPTIONS.map(
            (o) => `<option value="${o.key}" ${s.defaultTaskFilter === o.key ? "selected" : ""}>${o.label}</option>`
          ).join("")}
        </select>
        <span class="caldav-input-suffix">${icons.chevron}</span>
      </div>
    </div>
    <p class="caldav-set-hint">「上次使用项」没有记录时，两处都回落到「所有未完成」。</p>
  </div>

  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.layers}</span>本地数据</div>
    <p class="caldav-set-hint">
      删除账户时可选「同时清理该账户的本地条目」（清理前自动备份，可随时恢复）；
      下面这两个按钮用于手动清理**不属于任何已配置账户**的本地条目 ——
      比如曾经连过、现已不在设置里的旧服务器数据。只清本地缓存，服务端不动。
    </p>
    <div class="caldav-actions-row">
      <button class="caldav-btn caldav-btn--sm" data-action="purge-now">${icons.trash}<span data-purge-now-label>立即清理其他服务器的本地条目</span></button>
      <button class="caldav-btn caldav-btn--sm" data-action="purge-restore">${icons.reset}<span data-purge-restore-label>恢复上次清理的条目</span></button>
      <span class="caldav-set-msg" data-purge-msg></span>
    </div>
    <p class="caldav-set-hint" data-purge-info></p>
  </div>

</div>

<div class="caldav-editor-foot">
  <span class="caldav-set-hint">密码保存在本机插件数据中，请勿在公共环境使用</span>
  <span class="caldav-flex"></span>
  <button class="caldav-foot-btn caldav-foot-btn--ghost" data-action="cancel">${icons.close} 取消</button>
  <button class="caldav-foot-btn caldav-foot-btn--primary" data-action="save">${icons.check} 保存</button>
</div>`;
}

/**
 * 「新建条目的默认日历」下拉的选项：默认账户（defaultAccountId）的启用日历；
 * 没选账户时列全部启用日历。当前默认日历即使不在列表里（属于其他账户，或账户
 * 刚被停用）也要补回 —— 和编辑器日历下拉同一个兼容思路，保证原值可见、可选。
 */
function defaultCalOptions(s: CalSettings): string {
  const acc = enabledAccounts(s).find((a) => a.id === s.defaultAccountId);
  const base = acc ? (acc.calendars || []).filter((c) => c.enabled) : enabledCalendars(s);
  const cur = s.defaultCalendarUrl ? findCalendarByUrl(s, s.defaultCalendarUrl) : undefined;
  const list = cur && !base.some((c) => c.url === cur.url) ? [...base, cur] : base;
  return list
    .map(
      (c) =>
        `<option value="${escape(c.url)}" ${s.defaultCalendarUrl === c.url ? "selected" : ""}>${escape(c.displayName)}</option>`
    )
    .join("");
}

/** 一张账户卡片（手风琴：点头部展开「服务器 / 日历 / 同步」三段） */
function accountCardHtml(a: CalAccount, mobile: boolean, expandedId?: string | null): string {
  const enabledCals = (a.calendars || []).filter((c) => c.enabled).length;
  const summary = a.serverUrl
    ? `${a.serverUrl} · ${enabledCals}/${(a.calendars || []).length} 日历启用`
    : "尚未填写服务器地址";
  // 收起的卡片**不渲染 body**。曾经是「渲染 + hidden」，2026-10-25 雄哥实测因此丢数据：
  // 添加第二个账户填 iCloud，「测试连接」永远在读第一个账户、把结果写进它（隐藏着）的
  // 消息位（看着就是没反应），强行保存后新账户的服务器/用户名/密码全变成第一个账户的值。
  // 根因：body 里全是 data-s="…" 的账户输入框，而读取方是 el.querySelector 按 data-s
  // 找控件 —— 收起卡的 body 只要还在 DOM 里，查找就只会命中**第一张卡**的输入框。
  // 手风琴本来一次只展开一张卡，body 只给展开卡渲染，语义与实现终于一致。
  return `
<div class="caldav-acc ${a.enabled ? "" : "is-off"} ${expandedId === a.id ? "is-open" : ""}" data-acc="${escape(a.id)}">
  <div class="caldav-acc-head">
    <span class="caldav-acc-dot" style="background:${calEventColor(a.calendars?.[0])}"></span>
    <span class="caldav-acc-name">${escape(a.name)}</span>
    <span class="caldav-acc-sum" title="${escape(a.serverUrl)}">${escape(summary)}</span>
    <label class="caldav-acc-switch" title="${a.enabled ? "停用该账户（其日历不再显示、不参与同步）" : "启用该账户"}">
      <input type="checkbox" data-acc-toggle="${escape(a.id)}" ${a.enabled ? "checked" : ""}/>
    </label>
    <button class="caldav-icon-btn" type="button" data-action="acc-del" data-acc-del="${escape(a.id)}" title="删除该账户">${icons.trash}</button>
  </div>
  <div class="caldav-acc-delconf" data-acc-delconf hidden>
    <div class="caldav-set-hint">
      删除账户「${escape(a.name)}」？该账户在本地共有 <b data-acc-deln>0</b> 条条目。
      服务端数据不受影响，重新添加同名账户即可再次同步。
    </div>
    <label class="caldav-check-row">
      <input type="checkbox"/>
      <span>同时清理该账户的本地条目（只清本地，清理前自动备份，可一键恢复）</span>
    </label>
    <div class="caldav-actions-row">
      <button class="caldav-btn caldav-btn--sm" type="button" data-action="acc-del-ok">${icons.trash} 确认删除</button>
      <button class="caldav-btn caldav-btn--sm caldav-btn--ghost" type="button" data-action="acc-del-cancel">取消</button>
    </div>
  </div>
  ${expandedId === a.id
    ? `
  <div class="caldav-acc-body">
    <div class="caldav-section-title caldav-acc-subtitle"><span class="caldav-section-icon">${icons.server}</span>服务器</div>
    <div class="caldav-field">
      <label class="caldav-field-label">账户名称</label>
      <input class="caldav-input" data-s="accName" value="${escape(a.name)}"/>
    </div>
    <div class="caldav-field">
      <label class="caldav-field-label">服务器类型</label>
      <div class="caldav-input-wrap">
        <select class="caldav-input" data-s="serverType">
          <option value="caldav" ${a.serverType !== "icloud" ? "selected" : ""}>CalDAV（标准服务器）</option>
          <option value="icloud" ${a.serverType === "icloud" ? "selected" : ""}>iCloud</option>
        </select>
        <span class="caldav-input-suffix">${icons.chevron}</span>
      </div>
    </div>
    <p class="caldav-set-hint">选「iCloud」时地址会自动填为 https://caldav.icloud.com，留空「日历路径」即可自动发现日历（iCloud 地址会跳转到节点主机，已做适配）；选「CalDAV」可连接任意标准服务器。</p>
    <div class="caldav-field">
      <label class="caldav-field-label">服务器地址</label>
      <input class="caldav-input" data-s="server" placeholder="http://192.168.1.10:5232/ 或 https://dav.example.com/" value="${escape(a.serverUrl)}"/>
    </div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">用户名</label>
        <input class="caldav-input" data-s="username" value="${escape(a.username)}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">密码</label>
        <input class="caldav-input" type="password" data-s="password" value="${escape(a.password)}" placeholder="留空则保持不变" autocomplete="new-password"/>
      </div>
    </div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">日历路径（可选，留空自动发现）</label>
        <input class="caldav-input" data-s="path" placeholder="如 http://host:5232/user/personal/" value="${escape(a.calendarPath)}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">请求通道</label>
        <div class="caldav-input-wrap">
          <select class="caldav-input" data-s="channel">
            <option value="auto" ${a.channel === "auto" ? "selected" : ""}>自动（内核代理优先）</option>
            <option value="proxy" ${a.channel === "proxy" ? "selected" : ""}>仅思源内核代理</option>
            <option value="direct" ${a.channel === "direct" ? "selected" : ""}>仅浏览器直连</option>
          </select>
          <span class="caldav-input-suffix">${icons.chevron}</span>
        </div>
      </div>
    </div>
    ${
      mobile
        ? `<p class="caldav-set-hint caldav-net-note">移动端请保持「自动」：手机 WebView 会拦截明文 HTTP 的浏览器直连（报 Failed to fetch），
      直连失败时插件会自动改走内核代理。</p>`
        : ""
    }
    <div class="caldav-actions-row">
      <button class="caldav-foot-btn caldav-foot-btn--ghost" type="button" data-action="test">${icons.check} 测试连接</button>
      <button class="caldav-foot-btn caldav-foot-btn--primary" type="button" data-action="discover">${icons.calendar} 发现日历</button>
      <span class="caldav-set-msg" data-acc-msg></span>
    </div>

    <div class="caldav-section-title caldav-acc-subtitle"><span class="caldav-section-icon">${icons.calendar}</span>日历</div>
    <div class="caldav-acc-cals" data-cals>${calChecksHtml(a.calendars || [])}</div>

    <div class="caldav-section-title caldav-acc-subtitle"><span class="caldav-section-icon">${icons.sync}</span>策略</div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">冲突策略</label>
        <div class="caldav-input-wrap">
          <select class="caldav-input" data-s="conflict">
            <option value="server" ${a.conflict === "server" ? "selected" : ""}>服务端优先</option>
            <option value="local" ${a.conflict === "local" ? "selected" : ""}>本地优先</option>
          </select>
          <span class="caldav-input-suffix">${icons.chevron}</span>
        </div>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">同步过去（天）</label>
        <input class="caldav-input" type="number" min="7" data-s="past" value="${a.pastDays}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">同步未来（天）</label>
        <input class="caldav-input" type="number" min="30" data-s="future" value="${a.futureDays}"/>
      </div>
    </div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">附件大小限制（MB）</label>
        <input class="caldav-input" type="number" min="1" data-s="attachMax" value="${a.attachSizeMaxMB ?? 5}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">单个ICS文件限制（MB）</label>
        <input class="caldav-input" type="number" min="1" data-s="icsMax" value="${a.icsSizeMaxMB ?? 10}"/>
      </div>
    </div>
    <p class="caldav-set-hint">
      附件大小限制是单个文件的上限，超过直接在编辑时拒绝；单个 ICS 文件限制是整条日历数据（含全部附件）的上限，
      超过服务器会拒绝（HTTP 413）。这两项是**服务器特性**（随账户走）：默认 5 / 10 对齐 Radicale 的默认上限，
      iCloud / 自己的服务器上限更大就把数值调大。
    </p>
  </div>`
    : ""}
</div>`;
}

/** 账户内的日历勾选列表（含名称与「日程 / 任务」取色药丸） */
function calChecksHtml(cals: CalCalendar[]): string {
  // 老数据（只有单个 color）在这里就地升级：eventColor/todoColor 都继承原色，观感不变
  normalizeCalendarColors(cals);
  if (!cals.length) {
    return `<div class="caldav-set-hint">尚未发现日历，请先填写服务器信息并点击「发现日历」</div>`;
  }
  return cals
    .map(
      (c, i) => `
    <div class="caldav-acc-cal" data-idx="${i}">
      <input type="checkbox" ${c.enabled ? "checked" : ""}/>
      <input class="caldav-input" data-role="name" value="${escape(c.displayName)}" title="${escape(c.url)}"/>
      <span class="caldav-set-cal-tags">${
        // 顺序固定为「日程」在前、「任务」在后；只给该日历支持的组件出药丸（不支持就没有对应色可配）
        (c.supportsEvent ? colorPillHtml("eventColor", "日程", calEventColor(c)) : "") +
        (c.supportsTodo ? colorPillHtml("todoColor", "任务", calTodoColor(c)) : "")
      }</span>
    </div>`
    )
    .join("");
}

/**
 * 药丸（色块）上的文字自己挑黑/白：颜色深浅不定，写死白字在浅色（如柠檬绿）上读不清。
 * 用 WCAG 相对亮度阈值切一刀，任何色值都能保证对比。
 */
function contrastText(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || "").trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.42 ? "#1f2937" : "#ffffff";
}

/**
 * 「任务」/「日程」药丸 = 该日历对应类型的默认色选择器（取代原来左侧那个独立色块）。
 *
 * 实现要点：药丸是个 <label>，里面嵌一个**铺满整块的透明原生 input[type=color]**。
 * 点击直接落在原生取色输入上 → 弹出系统取色器，和改造前左侧色块是同一套交互，
 * 不需要 JS 去模拟 click —— 移动端 WebView 里模拟 click 是弹不出取色器的。
 */
function colorPillHtml(role: "todoColor" | "eventColor", label: string, color: string): string {
  return `<label class="caldav-set-cal-tag" data-role-pill="${role}"
      style="--tag-color:${escape(color)};--tag-fg:${contrastText(color)}"
      title="点击选择该日历「${label}」的默认颜色">
      <input type="color" data-role="${role}" value="${escape(color)}"/>
      <span>${label}</span>
    </label>`;
}

/** 取色过程中让药丸底色实时跟随（原生取色器拖色会连续触发 input） */
function bindColorPills(box: HTMLElement): void {
  box.querySelectorAll<HTMLElement>(".caldav-set-cal-tag").forEach((pill) => {
    const input = pill.querySelector("input[type='color']") as HTMLInputElement | null;
    if (!input) return;
    const sync = () => {
      pill.style.setProperty("--tag-color", input.value);
      pill.style.setProperty("--tag-fg", contrastText(input.value));
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
  });
}
