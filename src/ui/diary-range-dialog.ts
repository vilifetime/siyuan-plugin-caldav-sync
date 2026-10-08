/**
 * 「插入日记」的范围 + 目标选择弹窗（2026-10-08，对齐 Obsidian 侧并新增目标子选项）。
 *
 * 雄哥要求：原按钮直接插「今日」，改为先问范围 —— 当日 / 本周 / 本月 / 所有（默认当日）；
 * 选「本周 / 本月」时再问一层：写到今天的日记，还是写到本周一的日记 / 本月 1 日的日记。
 *
 * 为什么用 `Dialog` 而非浮层：这是**有默认值的写文件确认**，需要明确的
 * 「确认 / 取消」；浮层适合「选种类」这类轻量选择。
 */
import { newDialog } from "@/ui/dialog";
import { isMobile } from "./device";
import { adoptMobileLayer } from "./mobile-layers";
import type { DiaryRange, DiaryTarget } from "./diary-range";
import { diarySpanOf, targetOptionsOf } from "./diary-range";

/** 顺序即显示顺序，第一项是默认项 */
const RANGES: { key: DiaryRange; label: string; hint: string }[] = [
  { key: "day", label: "当日", hint: "今天的日程与待办" },
  { key: "week", label: "本周", hint: "本周一至本周日（自然周，周一起算）" },
  { key: "month", label: "本月", hint: "本月 1 日至本月最后一天" },
  { key: "all", label: "所有", hint: "全部历史与未来的条目" }
];

/**
 * 弹出选择框。
 * @param onPick 点「确认插入」时回调；取消 / 关闭则不调用。
 */
export function askDiaryRange(onPick: (range: DiaryRange, target: DiaryTarget) => void): void {
  let pickedRange: DiaryRange = "day";
  let pickedTarget: DiaryTarget = "today";

  const mobile = isMobile();
  const dialog = newDialog({
    title: "插入日记",
    content: `
<div class="caldav-range">
  <div class="caldav-range-lead">要把哪个范围的日程与待办写入日记？</div>
  <fieldset class="caldav-range-opts">
    <legend class="sr-only">插入范围</legend>
    ${RANGES.map(
      (o) => `
    <label class="caldav-range-opt${o.key === "day" ? " is-checked" : ""}">
      <input type="radio" name="caldav-range" value="${o.key}"${o.key === "day" ? " checked" : ""}/>
      <span class="caldav-range-opt-body">
        <span class="caldav-range-opt-label">${o.label}</span>
        <span class="caldav-range-opt-hint">${o.hint}</span>
      </span>
    </label>`
    ).join("")}
  </fieldset>
  <!-- 只有「本周 / 本月」才有两个目标可选（见 targetOptionsOf），此时才展开 -->
  <div class="caldav-range-sub" data-sub hidden>
    <div class="caldav-range-sub-lead">插入到哪一篇日记？</div>
    <fieldset class="caldav-range-opts caldav-range-opts--sub" data-sub-opts></fieldset>
  </div>
  <div class="caldav-editor-foot">
    <span class="caldav-flex"></span>
    <button class="caldav-foot-btn caldav-foot-btn--ghost" data-act="cancel">取消</button>
    <button class="caldav-foot-btn caldav-foot-btn--primary" data-act="ok">确认插入</button>
  </div>
</div>`,
    width: mobile ? "100vw" : "420px",
    height: mobile ? "100vh" : "auto",
    containerClassName: mobile ? "caldav-mobile-dialog" : undefined,
    destroyCallback: () => {}
  });
  // 移动端：这是从面板里开出来的一层，登记后由层管理器收掉下面的残留层
  adoptMobileLayer(dialog, "sub");

  const el = dialog.element.querySelector(".caldav-range") as HTMLElement;
  const subWrap = el.querySelector<HTMLElement>("[data-sub]")!;
  const subOpts = el.querySelector<HTMLElement>("[data-sub-opts]")!;
  const rangeInputs = Array.from(el.querySelectorAll<HTMLInputElement>('input[name="caldav-range"]'));

  /** 选中态由 JS 切 class，不用 CSS `:has(input:checked)` —— 见下方说明 */
  const markChecked = (inputs: HTMLInputElement[], current: HTMLInputElement) => {
    inputs.forEach((other) => {
      other.closest<HTMLElement>(".caldav-range-opt")?.classList.toggle("is-checked", other === current);
    });
  };

  /**
   * 重建目标子选项区。
   *
   * 换范围就重建 DOM（选项文案随范围变：本周一 / 本月 1 日），比预渲染四种
   * 再靠 hidden 切换更省心 —— 也避免「上次选的 spanStart 留在新范围上」这种
   * 状态残留（week 的 spanStart 与 month 的 spanStart 是两回事）。
   */
  const renderSub = () => {
    const opts = targetOptionsOf(pickedRange);
    // 只有一项时不渲染子选项区：问「插入到今天的日记 / 插入到今天的日记」没有意义
    if (opts.length < 2) {
      subWrap.hidden = true;
      subOpts.innerHTML = "";
      pickedTarget = "today";
      return;
    }
    subWrap.hidden = false;
    subOpts.innerHTML = opts
      .map(
        (o, i) => `
    <label class="caldav-range-opt${i === 0 ? " is-checked" : ""}">
      <input type="radio" name="caldav-target" value="${o.key}"${i === 0 ? " checked" : ""}/>
      <span class="caldav-range-opt-body">
        <span class="caldav-range-opt-label">${o.label}</span>
        <span class="caldav-range-opt-hint">${
          o.key === "today" ? "与旧行为一致" : diarySpanOf(pickedRange).from
        }</span>
      </span>
    </label>`
      )
      .join("");
    pickedTarget = "today";
    const inputs = Array.from(subOpts.querySelectorAll<HTMLInputElement>('input[name="caldav-target"]'));
    inputs.forEach((r) => {
      r.addEventListener("change", () => {
        if (!r.checked) return;
        pickedTarget = r.value as DiaryTarget;
        markChecked(inputs, r);
      });
    });
  };

  rangeInputs.forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      pickedRange = r.value as DiaryRange;
      markChecked(rangeInputs, r);
      renderSub();
    });
  });
  // 默认「当日」只有「今天」一个目标，子选项区保持隐藏
  renderSub();

  el.querySelector('[data-act="cancel"]')?.addEventListener("click", () => dialog.destroy());
  el.querySelector('[data-act="ok"]')?.addEventListener("click", () => {
    const range = pickedRange;
    const target = pickedTarget;
    dialog.destroy();
    onPick(range, target);
  });

  // 焦点默认落在「取消」上：这一步会写文件，防误触更安全
  window.setTimeout(() => {
    el.querySelector<HTMLElement>('[data-act="cancel"]')?.focus();
  }, 0);
}
