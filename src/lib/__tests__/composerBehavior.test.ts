// BaoCode P4.1 — composerBehavior 单元测试
// 跑法:bun test src/lib/__tests__/composerBehavior.test.ts
import { describe, expect, it } from "bun:test";
import {
  backspaceCaretTrail,
  computeCaretAfterBackspace,
  decideComposerEnter,
} from "../composerBehavior";

describe("decideComposerEnter", () => {
  it("IME composing → newline(绝不提交)", () => {
    expect(
      decideComposerEnter({ isComposing: true, shiftKey: false, hasMentionPanel: false, hasSlashMenu: false, value: "hi" }),
    ).toBe("newline");
  });
  it("Shift+Enter → newline", () => {
    expect(
      decideComposerEnter({ isComposing: false, shiftKey: true, hasMentionPanel: false, hasSlashMenu: false, value: "hi" }),
    ).toBe("newline");
  });
  it("@ 面板开着 → autocomplete", () => {
    expect(
      decideComposerEnter({ isComposing: false, shiftKey: false, hasMentionPanel: true, hasSlashMenu: false, value: "@" }),
    ).toBe("autocomplete");
  });
  it("/ 菜单开着 → autocomplete", () => {
    expect(
      decideComposerEnter({ isComposing: false, shiftKey: false, hasMentionPanel: false, hasSlashMenu: true, value: "/" }),
    ).toBe("autocomplete");
  });
  it("空 value(纯空白)→ newline(不提交空)", () => {
    expect(
      decideComposerEnter({ isComposing: false, shiftKey: false, hasMentionPanel: false, hasSlashMenu: false, value: "   " }),
    ).toBe("newline");
  });
  it("有 value + 无特殊键 → submit", () => {
    expect(
      decideComposerEnter({ isComposing: false, shiftKey: false, hasMentionPanel: false, hasSlashMenu: false, value: "fix bug" }),
    ).toBe("submit");
  });
  it("优先级:composing > shift > 面板 > 空白 > submit", () => {
    // 全为 true(冲突)— composing 优先
    expect(
      decideComposerEnter({ isComposing: true, shiftKey: true, hasMentionPanel: true, hasSlashMenu: true, value: "" }),
    ).toBe("newline");
  });
});

describe("computeCaretAfterBackspace", () => {
  it("空 input → 0", () => {
    expect(computeCaretAfterBackspace("", 5)).toBe(0);
  });
  it("caretPos=0 → 0", () => {
    expect(computeCaretAfterBackspace("hi", 0)).toBe(0);
  });
  it("caretPos > input.length → input.length(限到末尾)", () => {
    expect(computeCaretAfterBackspace("hi", 99)).toBe(2);
  });
  it("正常 ASCII → caret - 1", () => {
    expect(computeCaretAfterBackspace("hello", 3)).toBe(2);
    expect(computeCaretAfterBackspace("a", 1)).toBe(0);
  });
});

describe("backspaceCaretTrail", () => {
  it("'abc', caret=3 → [3, 2, 1, 0](删到 0 后稳定退出)", () => {
    expect(backspaceCaretTrail("abc", 3)).toEqual([3, 2, 1, 0]);
  });
  it("空 input → 0", () => {
    expect(backspaceCaretTrail("", 0)).toEqual([0]);
  });
  it("caretPos 在中间 → 从该点删到 0", () => {
    expect(backspaceCaretTrail("hello", 3)).toEqual([3, 2, 1, 0]);
  });
});
