/**
 * 「插入日记」的范围 + 目标选择弹窗（2026-10-08，对齐 Obsidian 侧并新增目标子选项）。
 *
 * 雄哥要求：原按钮直接插「今日」，改为先问范围 —— 当日 / 本周 / 本月 / 所有（默认当日）；
 * 选「本周 / 本月」时再问一层：写到今天的日记，还是写到本周一的日记 / 本月 1 日的日记。
 *
 * 2026-10-08 二次调整（雄哥）：「子选项跟在本周或本月的右侧同一行」，不再单独占一段 ——
 * 于是每个范围行自带一个 `[data-inline]` 槽，子选项渲染进**当前选中那一行**的槽里，
 * 换范围时清空其它行再重建（避免「本周一」选项残留在别处）。
 *
 * 为什么用 `Dialog` 而非浮层：这是**有默认值的写文件确认**，需要明确的
 * 「确认 / 取消」；浮层适合「选种类」这类轻量选择。
 */
import { newDialog } from "@/ui/dialog";
import { isMobile } from "./device";
import { adoptMobileLayer } from "./mobile-layers";
import type { DiaryRange, DiaryTarget } from "./diary-range";
import { targetOptionsOf } from "./diary-range";

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
    <div class="caldav-range-opt${o.key === "day" ? " is-checked" : ""}" data-range-row="${o.key}">
      <div class="caldav-range-head">
        <label class="caldav-range-pick">
          <input type="radio" name="caldav-range" value="${o.key}"${o.key === "day" ? " checked" : ""}/>
          <span class="caldav-range-opt-label">${o.label}</span>
        </label>
        <!-- 子选项槽：只有被选中的范围行才往里渲染（见 renderSub） -->
        <span class="caldav-range-inline" data-inline></span>
      </div>
      <span class="caldav-range-opt-hint">${o.hint}</span>
    </div>`
    ).join("")}
  </fieldset>
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
  const rangeInputs = Array.from(el.querySelectorAll<HTMLInputElement>('input[name="caldav-range"]'));

  /**
   * 选中态由 JS 切 class，不用 CSS `:has(input:checked)` —— 见下方说明。
   *
   * `scope` 必须显式给：子选项的 radio 身处的 `.caldav-range-inline` 也在
   * `.caldav-range-opt` 内，若一律 closest(".caldav-range-opt")，切换目标时会把
   * **外层范围行**的选中态一并改掉。
   */
  const markChecked = (inputs: HTMLInputElement[], current: HTMLInputElement, scope: string) => {
    inputs.forEach((other) => {
      other.closest<HTMLElement>(scope)?.classList.toggle("is-checked", other === current);
    });
  };

  /**
   * 重建目标子选项。
   *
   * 先清空**所有**行的槽再渲染到选中行 —— 只清当前行的话，「本周」换成「本月」后
   * 本周行里那份「本周一」会留在原地（同一份 DOM 被两处引用过）。
   * 换范围就整块重建 DOM（选项文案随范围变），比预渲染四种再靠 hidden 切换更省心，
   * 也避免「上次选的 spanStart 留在新范围上」这种状态残留。
   */
  const renderSub = () => {
    const opts = targetOptionsOf(pickedRange);
    el.querySelectorAll<HTMLElement>("[data-inline]").forEach((n) => (n.innerHTML = ""));
    pickedTarget = "today";
    // 只有一项时不渲染：问「今天的日记 / 今天的日记」没有意义
    if (opts.length < 2) return;
    const host = el.querySelector<HTMLElement>(`[data-range-row="${pickedRange}"] [data-inline]`);
    if (!host) return;
    host.innerHTML = opts
      .map(
        (o, i) => `
      <label class="caldav-range-target${i === 0 ? " is-checked" : ""}">
        <input type="radio" name="caldav-target" value="${o.key}"${i === 0 ? " checked" : ""}/>
        <span class="caldav-range-target-text">${o.compact}</span>
      </label>`
      )
      .join("");
    const inputs = Array.from(host.querySelectorAll<HTMLInputElement>('input[name="caldav-target"]'));
    inputs.forEach((r) => {
      r.addEventListener("change", () => {
        if (!r.checked) return;
        pickedTarget = r.value as DiaryTarget;
        markChecked(inputs, r, ".caldav-range-target");
      });
    });
  };

  rangeInputs.forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      pickedRange = r.value as DiaryRange;
      markChecked(rangeInputs, r, ".caldav-range-opt");
      renderSub();
    });
  });
  // 默认「当日」只有「今天」一个目标，子选项槽保持空
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
