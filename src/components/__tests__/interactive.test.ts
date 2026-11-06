// BaoCode P1.5 — interactive reducer + initInteractiveState + deriveAnswer 单测
// 跑法(项目根):
//   bun test src/components/__tests__/interactive.test.ts

import { describe, expect, it } from "bun:test";
import {
  type InteractiveRequest,
  type InteractiveState,
  deriveAnswer,
  initInteractiveState,
  interactiveReducer,
} from "../../domain/interactive";

// ── fixtures ──

const approval: InteractiveRequest = {
  kind: "approval",
  id: "a1",
  title: "Bash",
  steps: [
    {
      prompt: "",
      header: "Bash",
      rows: [
        { label: "Allow once" },
        { label: "__allowAlways__" },
        { label: "__deny__" },
      ],
    },
  ],
};

const question1Step: InteractiveRequest = {
  kind: "question",
  id: "q1",
  title: "Pick color",
  steps: [
    {
      prompt: "Pick a color",
      header: "Color",
      multiple: false,
      rows: [
        { label: "Red" },
        { label: "Blue" },
        { label: "Green" },
      ],
    },
  ],
};

const questionMulti: InteractiveRequest = {
  kind: "question",
  id: "q2",
  title: "Pick features",
  steps: [
    {
      prompt: "Pick features",
      header: "Features",
      multiple: true,
      rows: [
        { label: "A" },
        { label: "B" },
        { label: "C" },
      ],
    },
  ],
};

// ── initInteractiveState ──

describe("initInteractiveState", () => {
  it("无 presets → 每题空 Set,highlighted=0,无 deny", () => {
    const s = initInteractiveState(approval);
    expect(s.picks).toHaveLength(1);
    expect(s.picks[0]?.size).toBe(0);
    expect(s.texts).toEqual([""]);
    expect(s.highlighted).toBe(0);
    expect(s.denyMode).toBe(false);
    expect(s.denyText).toBe("");
    expect(s.step).toBe(0);
  });

  it("有 presets 且长度对齐 → 拷贝 picks(用 Set 引用隔离)", () => {
    const s = initInteractiveState(question1Step, { picks: [new Set([1])] });
    expect(s.picks[0]?.has(1)).toBe(true);
    // 修改 picks 不应影响 presets
    s.picks[0]?.add(2);
    expect(s.picks[0]?.has(2)).toBe(true);
  });

  it("有 presets 但长度不匹配 → 走默认空 picks", () => {
    const s = initInteractiveState(question1Step, { picks: [new Set([0]), new Set([1])] });
    expect(s.picks).toHaveLength(1); // 还是 1,因为题只有 1 步
  });
});

// ── interactiveReducer ──

describe("interactiveReducer — select", () => {
  it("单选模式:select row 替换(非累加)", () => {
    let s = initInteractiveState(question1Step);
    s = interactiveReducer(s, { type: "select", row: 0 }, question1Step.steps[0]!);
    expect(s.picks[0]?.has(0)).toBe(true);
    s = interactiveReducer(s, { type: "select", row: 1 }, question1Step.steps[0]!);
    expect(s.picks[0]?.has(0)).toBe(false);
    expect(s.picks[0]?.has(1)).toBe(true);
    expect(s.picks[0]?.size).toBe(1);
  });

  it("多选模式:select row toggle", () => {
    let s = initInteractiveState(questionMulti);
    s = interactiveReducer(s, { type: "select", row: 0 }, questionMulti.steps[0]!);
    s = interactiveReducer(s, { type: "select", row: 1 }, questionMulti.steps[0]!);
    expect(s.picks[0]?.has(0)).toBe(true);
    expect(s.picks[0]?.has(1)).toBe(true);
    expect(s.picks[0]?.size).toBe(2);
    s = interactiveReducer(s, { type: "select", row: 0 }, questionMulti.steps[0]!);
    expect(s.picks[0]?.has(0)).toBe(false);
    expect(s.picks[0]?.size).toBe(1);
  });

  it("select 同时改 highlighted", () => {
    let s = initInteractiveState(question1Step);
    s = interactiveReducer(s, { type: "highlight", row: 2 }, question1Step.steps[0]!);
    s = interactiveReducer(s, { type: "select", row: 0 }, question1Step.steps[0]!);
    expect(s.highlighted).toBe(0);
  });
});

describe("interactiveReducer — highlight", () => {
  it("clamp 到 [0, rows.length-1]", () => {
    let s = initInteractiveState(question1Step);
    s = interactiveReducer(s, { type: "highlight", row: -5 }, question1Step.steps[0]!);
    expect(s.highlighted).toBe(0);
    s = interactiveReducer(s, { type: "highlight", row: 99 }, question1Step.steps[0]!);
    expect(s.highlighted).toBe(2);
    s = interactiveReducer(s, { type: "highlight", row: 1 }, question1Step.steps[0]!);
    expect(s.highlighted).toBe(1);
  });
});

describe("interactiveReducer — back", () => {
  it("step=0 时 back 是 noop", () => {
    const s = initInteractiveState(question1Step);
    const s2 = interactiveReducer(s, { type: "back" }, question1Step.steps[0]!);
    expect(s2).toBe(s);
  });

  it("multi-step 时 back 真的 step-- 并清 deny 状态", () => {
    const req: InteractiveRequest = {
      kind: "question",
      id: "qm",
      title: "Multi",
      steps: [
        { prompt: "q1", rows: [{ label: "A" }] },
        { prompt: "q2", rows: [{ label: "B" }] },
      ],
    };
    let s: InteractiveState = { ...initInteractiveState(req), step: 1, denyMode: true, denyText: "x" };
    s = interactiveReducer(s, { type: "back" }, req.steps[1]!);
    expect(s.step).toBe(0);
    expect(s.denyMode).toBe(false);
    expect(s.denyText).toBe("");
  });
});

describe("interactiveReducer — deny", () => {
  it("enterDenyMode 设 denyMode=true", () => {
    let s = initInteractiveState(approval);
    s = interactiveReducer(s, { type: "enterDenyMode" }, approval.steps[0]!);
    expect(s.denyMode).toBe(true);
  });

  it("setDenyText 写入 text", () => {
    let s = initInteractiveState(approval);
    s = interactiveReducer(s, { type: "setDenyText", text: "太危险" }, approval.steps[0]!);
    expect(s.denyText).toBe("太危险");
  });

  it("cancelDeny 清 deny 状态", () => {
    let s: InteractiveState = { ...initInteractiveState(approval), denyMode: true, denyText: "x" };
    s = interactiveReducer(s, { type: "cancelDeny" }, approval.steps[0]!);
    expect(s.denyMode).toBe(false);
    expect(s.denyText).toBe("");
  });
});

// ── deriveAnswer ──

describe("deriveAnswer — approval", () => {
  it("未进 deny 模式,无 allowAlways → decision=allow", () => {
    const s = initInteractiveState(approval);
    expect(deriveAnswer(approval, s)).toEqual({ kind: "approval", decision: "allow" });
  });

  it("allowAlways 标志 → decision=allowAlways", () => {
    const s = initInteractiveState(approval);
    expect(deriveAnswer(approval, s, { allowAlways: true })).toEqual({
      kind: "approval",
      decision: "allowAlways",
    });
  });

  it("deny 模式 → decision=deny,message 用 denyText", () => {
    const s: InteractiveState = { ...initInteractiveState(approval), denyMode: true, denyText: "会删东西" };
    expect(deriveAnswer(approval, s)).toEqual({
      kind: "approval",
      decision: "deny",
      message: "会删东西",
    });
  });

  it("opts.denyMessage 覆盖 denyText", () => {
    const s: InteractiveState = { ...initInteractiveState(approval), denyText: "auto" };
    expect(deriveAnswer(approval, s, { denyMessage: "manual" })).toEqual({
      kind: "approval",
      decision: "deny",
      message: "manual",
    });
  });
});

describe("deriveAnswer — question", () => {
  it("单题未选 → picks=[[]], skipped=false", () => {
    const s = initInteractiveState(question1Step);
    const ans = deriveAnswer(question1Step, s) as { kind: "question"; picks: string[][]; skipped: boolean };
    expect(ans.kind).toBe("question");
    expect(ans.picks).toEqual([[]]);
    expect(ans.skipped).toBe(false);
  });

  it("单题选了 row=1 → picks=[['Blue']]", () => {
    let s = initInteractiveState(question1Step);
    s = interactiveReducer(s, { type: "select", row: 1 }, question1Step.steps[0]!);
    const ans = deriveAnswer(question1Step, s) as { picks: string[][] };
    expect(ans.picks).toEqual([["Blue"]]);
  });

  it("skipped=true → picks=[]", () => {
    const s = initInteractiveState(question1Step);
    const ans = deriveAnswer(question1Step, s, { skipped: true });
    expect(ans).toEqual({ kind: "question", picks: [], skipped: true });
  });

  it("多题选了 row=0+2 → picks=[['A','C']]", () => {
    let s = initInteractiveState(questionMulti);
    s = interactiveReducer(s, { type: "select", row: 0 }, questionMulti.steps[0]!);
    s = interactiveReducer(s, { type: "select", row: 2 }, questionMulti.steps[0]!);
    const ans = deriveAnswer(questionMulti, s) as { picks: string[][] };
    expect(ans.picks).toEqual([["A", "C"]]);
  });
});
