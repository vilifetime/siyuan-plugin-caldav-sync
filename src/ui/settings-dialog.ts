/**
 * 设置面板：服务器参数 / 测试连接 / 发现日历 / 同步策略
 */
import { Dialog, showMessage } from "siyuan";
import { newDialog } from "@/ui/dialog";
import { isMobile } from "./device";
import type { CalCalendar } from "../core/types";
import { calEventColor, calTodoColor, normalizeCalendarColors } from "../core/types";
import { testConnection, discoverCalendars, describeNetworkError } from "../core/caldav";
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
      content: `<div class="caldav-settings">${settingsHtml(s, mobile)}</div>`,
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
    const $ = (sel: string) => el.querySelector(sel) as HTMLInputElement;
    const msgEl = el.querySelector("[data-msg]") as HTMLElement;
    renderCalChecks(el, s.calendars);

    // 提醒自检：测试按钮 + 排程状态（「带提醒时间的条目」为 0 说明是数据侧没设提醒）
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

    if (ctx.store.secretBroken) {
      // 密码密文是「另一台设备用另一把密钥」写的 —— 多端共用同一份数据，密钥却各不同。
      // 说清楚原因，用户才知道为什么要重输，而不是以为密码被吞了。
      msgEl.textContent = "密码解不开：这段密文由另一台设备写入。请在本机重新输入一次密码并保存，之后各端都会一致";
      msgEl.classList.add("is-err");
    } else if (ctx.store.pendingUnlock) {
      msgEl.textContent = "密码待解密（密钥尚未就绪），稍后自动重试；若长时间未恢复，请重新输入密码并保存";
      msgEl.classList.add("is-err");
    }

    // 通道切换提示
    $("select[data-s='channel']").addEventListener("change", () => {
      /* 仅保存时生效 */
    });

    /**
     * 「显示日程事件」→「显示已过期的日程」两级联动。
     *
     * 关闭主开关时**连带把第二层置 false** —— 否则留着 true，下次打开主开关
     * 会突然冒出一堆过期日程，看着像出 bug（Obsidian 侧 2026-10-06 定下的规矩）。
     */
    const showEventsBox = $("input[data-s='showEvents']") as HTMLInputElement;
    const showExpiredBox = $("input[data-s='showExpiredEvents']") as HTMLInputElement;
    const showExpiredRow = el.querySelector<HTMLElement>("[data-sub='showExpired']");
    showEventsBox.addEventListener("change", () => {
      if (showExpiredRow) showExpiredRow.hidden = !showEventsBox.checked;
      if (!showEventsBox.checked) showExpiredBox.checked = false;
    });

    el.querySelector("[data-action='test']")?.addEventListener("click", () => {
      const server = $("input[data-s='server']").value.trim();
      const username = $("input[data-s='username']").value.trim();
      const password = $("input[data-s='password']").value;
      const channel = $("select[data-s='channel']").value as any;
      if (!server) {
        msgEl.textContent = "服务器地址不能为空";
        msgEl.classList.remove("is-ok");
        msgEl.classList.add("is-err");
        return;
      }
      msgEl.textContent = "正在测试连接…";
      msgEl.classList.remove("is-ok", "is-err");
      void testConnection(server, channel, { username, password }).then((r) => {
        msgEl.textContent = r.message;
        msgEl.classList.toggle("is-ok", r.ok);
        msgEl.classList.toggle("is-err", !r.ok);
      });
    });

    el.querySelector("[data-action='discover']")?.addEventListener("click", async () => {
      const server = $("input[data-s='server']").value.trim();
      const username = $("input[data-s='username']").value.trim();
      const password = $("input[data-s='password']").value;
      const channel = $("select[data-s='channel']").value as any;
      const path = $("input[data-s='path']").value.trim();
      msgEl.textContent = "正在发现日历…";
      msgEl.classList.remove("is-ok", "is-err");
      try {
        const r = await discoverCalendars(server, channel, { username, password }, path);
        const existing = new Map(s.calendars.map((c) => [c.url, c]));
        s.calendars = r.calendars.map(
          (c) =>
            existing.get(c.url) || { ...c, enabled: true }
        );
        renderCalChecks(el, s.calendars);
        msgEl.textContent = `发现 ${r.calendars.length} 个日历，请勾选后保存`;
        msgEl.classList.add("is-ok");
      } catch (e: any) {
        msgEl.textContent = "发现失败: " + describeNetworkError(e, channel);
        msgEl.classList.add("is-err");
      }
    });

    el.querySelector("[data-action='save']")?.addEventListener("click", async () => {
      s.serverUrl = $("input[data-s='server']").value.trim();
      s.username = $("input[data-s='username']").value.trim();
      // 密码框留空 = 保持原样。解密失败时输入框本就是空的，用户只想改别的字段
      // 却点保存 —— 若无条件用空值覆盖，密码就被抹掉了（这正是丢密码的直接原因之一）。
      const pwInput = $("input[data-s='password']").value;
      if (pwInput) {
        s.password = pwInput;
        ctx.store.secretBroken = false;
        ctx.store.pendingUnlock = false;
      }
      s.calendarPath = $("input[data-s='path']").value.trim();
      s.channel = $("select[data-s='channel']").value as any;
      s.syncIntervalMin = Math.max(0, +$("input[data-s='interval']").value || 0);
      s.conflict = $("select[data-s='conflict']").value as any;
      s.pastDays = Math.max(7, +$("input[data-s='past']").value || 90);
      s.futureDays = Math.max(30, +$("input[data-s='future']").value || 370);
      const wasRemindOn = s.enableReminders;
      s.enableReminders = ($("input[data-s='reminders']") as HTMLInputElement).checked;
      // 任务视图的两个开关。主开关关闭时第二层必然是 false（change 时已连带置掉，
      // 这里再与一次是兜底 —— 用户可能直接点保存而没触发 change）。
      const wasEventsOn = s.showEventsInTaskView === true;
      const wasExpiredOn = s.showExpiredEventsInTaskView === true;
      s.showEventsInTaskView = showEventsBox.checked;
      s.showExpiredEventsInTaskView = showEventsBox.checked && showExpiredBox.checked;
      const taskViewOptChanged = wasEventsOn !== s.showEventsInTaskView || wasExpiredOn !== s.showExpiredEventsInTaskView;
      // 勾选的日历
      el.querySelectorAll<HTMLElement>(".caldav-set-cal").forEach((row) => {
        const c = s.calendars[+row.dataset.idx!];
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
      normalizeCalendarColors(s.calendars);
      s.defaultCalendarUrl = s.calendars.find((c) => c.enabled)?.url;
      await ctx.store.persist();
      ctx.sync.startAutoSync();
      dialog.destroy();
      resolve();
      // 设置页保存不会自动重渲染主面板，任务视图的两个开关改了要显式刷一次，
      // 否则用户回到任务视图看到的还是老样子，以为没生效。
      if (taskViewOptChanged) ctx.refreshPanels?.();
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
    });
    el.querySelector("[data-action='cancel']")?.addEventListener("click", () => {
      dialog.destroy();
      resolve();
    });
  });
}

function settingsHtml(s: PanelCtx["store"]["settings"], mobile: boolean): string {
  return `
<div class="caldav-settings-form">
  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.server}</span>服务器</div>
    <div class="caldav-field">
      <label class="caldav-field-label">服务器地址</label>
      <input class="caldav-input" data-s="server" placeholder="http://192.168.1.10:5232/ 或 https://dav.example.com/" value="${escape(s.serverUrl)}"/>
    </div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">用户名</label>
        <input class="caldav-input" data-s="username" value="${escape(s.username)}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">密码</label>
        <input class="caldav-input" type="password" data-s="password" value="${escape(s.password)}" placeholder="留空则保持不变" autocomplete="new-password"/>
      </div>
    </div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">日历路径（可选，留空自动发现）</label>
        <input class="caldav-input" data-s="path" placeholder="如 http://host:5232/user/personal/" value="${escape(s.calendarPath)}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">请求通道</label>
        <div class="caldav-input-wrap">
          <select class="caldav-input" data-s="channel">
            <option value="auto" ${s.channel === "auto" ? "selected" : ""}>自动（内核代理优先）</option>
            <option value="proxy" ${s.channel === "proxy" ? "selected" : ""}>仅思源内核代理</option>
            <option value="direct" ${s.channel === "direct" ? "selected" : ""}>仅浏览器直连</option>
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
      <button class="caldav-foot-btn caldav-foot-btn--ghost" data-action="test">${icons.check} 测试连接</button>
      <button class="caldav-foot-btn caldav-foot-btn--primary" data-action="discover">${icons.calendar} 发现日历</button>
      <span class="caldav-set-msg" data-msg></span>
    </div>
  </div>

  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.calendar}</span>日历</div>
    <div class="caldav-set-cals" data-cals></div>
  </div>

  <div class="caldav-section caldav-section--card">
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.sync}</span>同步</div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">自动同步间隔（分钟，0 关闭）</label>
        <input class="caldav-input" type="number" min="0" data-s="interval" value="${s.syncIntervalMin}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">冲突策略</label>
        <div class="caldav-input-wrap">
          <select class="caldav-input" data-s="conflict">
            <option value="server" ${s.conflict === "server" ? "selected" : ""}>服务端优先</option>
            <option value="local" ${s.conflict === "local" ? "selected" : ""}>本地优先</option>
          </select>
          <span class="caldav-input-suffix">${icons.chevron}</span>
        </div>
      </div>
    </div>
    <div class="caldav-field-row">
      <div class="caldav-field">
        <label class="caldav-field-label">同步过去（天）</label>
        <input class="caldav-input" type="number" min="7" data-s="past" value="${s.pastDays}"/>
      </div>
      <div class="caldav-field">
        <label class="caldav-field-label">同步未来（天）</label>
        <input class="caldav-input" type="number" min="30" data-s="future" value="${s.futureDays}"/>
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
    <div class="caldav-section-title"><span class="caldav-section-icon">${icons.taskList}</span>任务视图</div>
    <label class="caldav-check-row">
      <input type="checkbox" data-s="showEvents" ${s.showEventsInTaskView === true ? "checked" : ""}/>
      <span>显示日程事件（默认只列待办；打开后日程也进同一列表，按「逾期 / 今天 / 明天 / 本周 / 下周后」分组）</span>
    </label>
    <label class="caldav-check-row caldav-check-row--sub" data-sub="showExpired"
           ${s.showEventsInTaskView === true ? "" : "hidden"}>
      <input type="checkbox" data-s="showExpiredEvents" ${s.showExpiredEventsInTaskView === true ? "checked" : ""}/>
      <span>显示已过期的日程（过期的按「已完成」处理，默认藏起来以免抢走待办的注意力）</span>
    </label>
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

function renderCalChecks(el: HTMLElement, cals: CalCalendar[]): void {
  // 老数据（只有单个 color）在这里就地升级：eventColor/todoColor 都继承原色，观感不变
  normalizeCalendarColors(cals);
  const box = el.querySelector("[data-cals]") as HTMLElement;
  if (!cals.length) {
    box.innerHTML = `<div class="caldav-set-hint">尚未发现日历，请先填写服务器信息并点击「发现日历」</div>`;
    return;
  }
  box.innerHTML = cals
    .map(
      (c, i) => `
    <div class="caldav-set-cal" data-idx="${i}">
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
  bindColorPills(box);
}
