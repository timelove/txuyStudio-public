// BaoCode P1.1 — InteractivePanel 域类型 + reducer
//
// 借鉴:BaoCode interaction_panel.dart 中 QuestionRequest + ApprovalRequest 统一驱动:
// 同一组件,同一键盘行为(1-9/方向键/Space/Enter/Esc/Backspace)。
// 我们这里 ApprovalRequest 已存在(PermissionConfirmCard 取代之),QuestionRequest 是
// 未来 claude 新 question 协议字段的预留(当前 stream-json 暂未发,本组件渲染路径已支持)。
//
// 设计要点:
// - InteractiveStep 是单题;QuestionRequest 可多步(数组),ApprovalRequest 总是 1 步。
// - reducer 是纯函数,组件挂载/状态变化/键盘事件都走它,便于单测。
// - onAnswer 是组件唯一出口;若调用方不想接收,提供一个 noop 兜底。

import type { ReactNode } from "react";

/** 单选项;label 是主文案,description 是次行(灰字),textHint 是 "请输入" 占位,
 *  preview 是 hover 时浮层(图/代码块)。 */
export type InteractiveRow = {
  label: string;
  description?: string;
  /** 该行内嵌文本输入(仅 question 类型;textHint 表「请输入」占位)。 */
  textHint?: string;
  /** hover 浮层预览(图/代码块,React 节点;不在 SSR 路径用)。 */
  preview?: ReactNode;
};

/** 单步题目:question 可多步(每步独立 prompt),approval 总 1 步。 */
export type InteractiveStep = {
  prompt: string;
  /** 短 tag,顶部 chip(如 "Library" / "Color")。 */
  header?: string;
  /** 仅 question 类型:多选模式(Space toggle)。 */
  multiple?: boolean;
  /** 顶部详细区(Approval 跑命令预览 / 计划预览)。 */
  detail?: ReactNode;
  rows: InteractiveRow[];
};

export type InteractiveRequest =
  | { kind: "question"; id: string; title: string; steps: InteractiveStep[] }
  /** approval 总是 1 步;deny 行(row.label === "__deny__") 渲染 textarea。 */
  | { kind: "approval"; id: string; title: string; steps: [InteractiveStep] };

export type InteractiveAnswer =
  | { kind: "question"; picks: string[][]; skipped: boolean }
  | {
      kind: "approval";
      decision: "allow" | "allowAlways" | "deny";
      /** deny 模式下的 reason;allow 路径无。 */
      message?: string;
    };

// ───── reducer state ─────

/** reducer 内部状态。组件持有 + reducer 推。 */
export type InteractiveState = {
  step: number;             // 当前在第几题(0-based)
  picks: Set<number>[];     // 每题选了哪些 row index
  texts: string[];          // 每题行内文本输入值(预留)
  highlighted: number;      // 当前键盘高亮的 row(0-based)
  /** approval 的 deny 模式:展开 textarea 输入 reason。 */
  denyMode: boolean;
  denyText: string;
};

export const initialInteractiveState: InteractiveState = {
  step: 0,
  picks: [],
  texts: [],
  highlighted: 0,
  denyMode: false,
  denyText: "",
};

/** reducer 事件。组件内 onKeyDown / 按钮 onClick 派发这些事件。 */
export type InteractiveEvent =
  | { type: "select"; row: number }            // 点击 / 数字键:切换/单选
  | { type: "highlight"; row: number }         // 方向键
  | { type: "next" }                           // Enter / next 按钮
  | { type: "back" }                           // ← / back 按钮
  | { type: "skip" }                           // Esc(question 跳过)
  | { type: "dismiss" }                        // Esc(approval 拒绝无 reason)
  | { type: "enterDenyMode" }                  // approval 选 deny 行
  | { type: "setDenyText"; text: string }
  | { type: "cancelDeny" }                     // 取消 deny 模式
  | { type: "submitDeny" };                    // 提交带 reason 的 deny

/** 由 request + 初始 picks 派生 reducer 初始 state。
 *  取代直接读 initialInteractiveState,确保多步题 picks 数组长度对齐。 */
export function initInteractiveState(
  request: InteractiveRequest,
  presets?: { picks?: Set<number>[]; texts?: string[] },
): InteractiveState {
  const stepCount = request.steps.length;
  const picks: Set<number>[] =
    presets?.picks && presets.picks.length === stepCount
      ? presets.picks.map((s) => new Set(s))
      : Array.from({ length: stepCount }, () => new Set<number>());
  const texts: string[] =
    presets?.texts && presets.texts.length === stepCount
      ? presets.texts.slice()
      : Array.from({ length: stepCount }, () => "");
  return {
    step: 0,
    picks,
    texts,
    highlighted: 0,
    denyMode: false,
    denyText: "",
  };
}

/** 纯函数 reducer:接收当前 state + event + 当前 step,返回新 state(不可变更新)。 */
export function interactiveReducer(
  state: InteractiveState,
  ev: InteractiveEvent,
  step: InteractiveStep,
): InteractiveState {
  switch (ev.type) {
    case "select": {
      const picks = state.picks.map((s) => new Set(s));
      const cur = picks[state.step];
      if (step.multiple) {
        if (cur.has(ev.row)) cur.delete(ev.row);
        else cur.add(ev.row);
      } else {
        cur.clear();
        cur.add(ev.row);
      }
      return { ...state, picks, highlighted: ev.row };
    }
    case "highlight": {
      const max = step.rows.length - 1;
      const next = Math.max(0, Math.min(max, ev.row));
      return { ...state, highlighted: next };
    }
    case "next": {
      // 最后一题:enter 触发 advance 由 caller(看 isLast + onAnswer)决定;
      // reducer 只负责保证已选 + 状态干净;advance 是 caller 把 step++ 后的 state 喂进来。
      return state;
    }
    case "back": {
      if (state.step === 0) return state;
      return { ...state, step: state.step - 1, denyMode: false, denyText: "" };
    }
    case "skip": {
      // question 跳过:返回 state 不变;caller 收到 skip 事件后构造
      // {kind:"question", picks:[], skipped:true} 提交。
      return state;
    }
    case "dismiss": {
      return state;
    }
    case "enterDenyMode": {
      return { ...state, denyMode: true };
    }
    case "setDenyText": {
      return { ...state, denyText: ev.text };
    }
    case "cancelDeny": {
      return { ...state, denyMode: false, denyText: "" };
    }
    case "submitDeny": {
      // caller 收到 submitDeny 后构造 answer 并 reset state。
      return state;
    }
  }
}

/** 工具:从 state + request 派生最终 answer(纯函数,组件 + 单测共用)。 */
export function deriveAnswer(
  request: InteractiveRequest,
  state: InteractiveState,
  opts?: { skipped?: boolean; denyMessage?: string; allowAlways?: boolean },
): InteractiveAnswer {
  if (request.kind === "question") {
    if (opts?.skipped) {
      return { kind: "question", picks: [], skipped: true };
    }
    const picks = state.picks.map((s) => Array.from(s).map((i) => request.steps[state.picks.indexOf(s)]?.rows[i]?.label ?? ""));
    return { kind: "question", picks, skipped: false };
  }
  // approval
  if (state.denyMode || opts?.denyMessage !== undefined) {
    return { kind: "approval", decision: "deny", message: opts?.denyMessage ?? state.denyText };
  }
  if (opts?.allowAlways) {
    return { kind: "approval", decision: "allowAlways" };
  }
  return { kind: "approval", decision: "allow" };
}
