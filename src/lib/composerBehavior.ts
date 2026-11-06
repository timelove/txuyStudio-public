// BaoCode P4.1 — Composer 输入行为不变量(纯函数)
//
// 借鉴:BaoCode composer_controller.dart(formatText/replaceText/URL 链接预删),
// 我们这里是受控 <textarea> 不引入 Quilleditor,但要一份"输入行为不变量"基线
// 防止 refactor 时把好行为改坏。
//
// 本阶段抽出 2 个纯函数:
//  - decideComposerEnter:Enter 键决策(submit / newline / autocomplete)
//  - computeCaretAfterBackspace:Backspace 后 caret 位置计算
//
// 集成到 ClaudePane 的 onKeyDown 留 GUI 收口(本阶段只产库 + 单测,定基线)。

export type EnterDecision = "submit" | "newline" | "autocomplete";

export type ComposerEnterState = {
  /** IME composition 进行中(compositionstart ~ compositionend)。true → newline(绝不提交) */
  isComposing: boolean;
  /** 用户按了 Shift(true → newline) */
  shiftKey: boolean;
  /** @ 面板开着(mention autocomplete) */
  hasMentionPanel: boolean;
  /** / 菜单开着(slash command autocomplete) */
  hasSlashMenu: boolean;
  /** 输入框内容(空内容不提交,newline) */
  value: string;
};

/** Enter 行为决策:
 *  - isComposing → newline(IME 期间不提交,标准浏览器行为)
 *  - shiftKey → newline
 *  - hasMentionPanel || hasSlashMenu → autocomplete(交给弹窗处理)
 *  - 空 value → newline(不提交空内容)
 *  - 其它 → submit */
export function decideComposerEnter(state: ComposerEnterState): EnterDecision {
  if (state.isComposing) return "newline";
  if (state.shiftKey) return "newline";
  if (state.hasMentionPanel || state.hasSlashMenu) return "autocomplete";
  if (!state.value.trim()) return "newline";
  return "submit";
}

/** Backspace 后 caret 位置计算(纯函数)。
 *  - input 为空 → 0
 *  - caretPos <= 0 → 0
 *  - caretPos > input.length → input.length(已到末尾)
 *  - 其它 → caretPos - 1(标准 backspace 行为)
 *  注:实际 DOM 中 backspace 处理 surrogate pair 时 caret 可能跳 2;
 *  本函数覆盖 ASCII / BMP 字符场景(surrogate case 留扩展)。 */
export function computeCaretAfterBackspace(input: string, caretPos: number): number {
  if (!input) return 0;
  if (caretPos <= 0) return 0;
  if (caretPos > input.length) return input.length;
  return caretPos - 1;
}

/** 连续 Backspace 删到空的 caret 轨迹(纯函数)。
 *  返回每个删除步骤后的 caret 位置数组;首项 = caretPos(删除前),
 *  末项 = 0(全删完)。 */
export function backspaceCaretTrail(input: string, caretPos: number): number[] {
  const out: number[] = [caretPos];
  let curInput = input;
  let curCaret = caretPos;
  while (curInput.length > 0 && curCaret > 0) {
    curInput = curInput.slice(0, curCaret - 1) + curInput.slice(curCaret);
    curCaret = computeCaretAfterBackspace(curInput, curCaret);
    out.push(curCaret);
  }
  return out;
}
