// BaoCode P2.1 — stepFolds 单元测试
// 跑法(项目根):
//   bun test src/domain/__tests__/stepFolds.test.ts

import { describe, expect, it } from "bun:test";
import type { ClaudeBlock, ClaudeMessage } from "../claudeStream";
import { computeFolds, isQuickStep } from "../stepFolds";

// ── fixtures ──

let _id = 0;
function nextId() {
  return `m${++_id}`;
}
function thinkingMsg(text: string = "thinking..."): ClaudeMessage {
  return {
    id: nextId(),
    role: "assistant",
    blocks: [{ type: "thinking", text }],
    timestamp: null,
    streaming: false,
  };
}
function readMsg(): ClaudeMessage {
  return {
    id: nextId(),
    role: "assistant",
    blocks: [{ type: "tool_use", id: nextId(), name: "Read", inputBrief: "x.ts", input: {}, result: null, status: "done" }],
    timestamp: null,
    streaming: false,
  };
}
function bashReadMsg(): ClaudeMessage {
  return {
    id: nextId(),
    role: "assistant",
    blocks: [{ type: "tool_use", id: nextId(), name: "Bash", inputBrief: "ls", input: { command: "ls -la" }, result: null, status: "done" }],
    timestamp: null,
    streaming: false,
  };
}
function bashRunMsg(): ClaudeMessage {
  return {
    id: nextId(),
    role: "assistant",
    blocks: [{ type: "tool_use", id: nextId(), name: "Bash", inputBrief: "rm", input: { command: "rm -rf node_modules" }, result: null, status: "done" }],
    timestamp: null,
    streaming: false,
  };
}
function psMsg(command: string, status: "done" | "pending" = "done"): ClaudeMessage {
  return {
    id: nextId(),
    role: "assistant",
    blocks: [{ type: "tool_use", id: nextId(), name: "PowerShell", inputBrief: command, input: { command }, result: null, status }],
    timestamp: null,
    streaming: false,
  };
}
function editMsg(): ClaudeMessage {
  return {
    id: nextId(),
    role: "assistant",
    blocks: [{ type: "tool_use", id: nextId(), name: "Edit", inputBrief: "x.ts", input: {}, result: null, status: "done" }],
    timestamp: null,
    streaming: false,
  };
}
function textMsg(text: string = "hi"): ClaudeMessage {
  return {
    id: nextId(),
    role: "user",
    blocks: [{ type: "text", text }],
    timestamp: null,
    streaming: false,
  };
}
function streamingMsg(): ClaudeMessage {
  return {
    id: nextId(),
    role: "assistant",
    blocks: [{ type: "thinking", text: "live..." }],
    timestamp: null,
    streaming: true,
  };
}

const action: import("../stepFolds").CommandAction = (cmd) => {
  if (/^rm|^mkdir|^mv/.test(cmd)) return "run";
  if (/^ls\b|^find\b|^tree\b/.test(cmd)) return "list";
  if (/^grep\b|^rg\b|^ag\b/.test(cmd)) return "search";
  if (/^cat\b|^head\b|^tail\b/.test(cmd)) return "read";
  return "other";
};

// ── isQuickStep ──

describe("isQuickStep", () => {
  it("thinking → true", () => {
    expect(isQuickStep(thinkingMsg(), { type: "thinking", text: "x" }, action)).toBe(true);
  });
  it("text → false", () => {
    expect(isQuickStep(textMsg(), { type: "text", text: "x" }, action)).toBe(false);
  });
  it("Read tool → true", () => {
    expect(isQuickStep(readMsg(), readMsg().blocks[0]!, action)).toBe(true);
  });
  it("Edit / Write / MultiEdit / NotebookEdit → false", () => {
    for (const n of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      const m: ClaudeMessage = {
        id: nextId(),
        role: "assistant",
        blocks: [{ type: "tool_use", id: nextId(), name: n, inputBrief: "x", input: {}, result: null, status: "done" }],
        timestamp: null,
        streaming: false,
      };
      expect(isQuickStep(m, m.blocks[0]!, action)).toBe(false);
    }
  });
  it("Bash run (rm) → false", () => {
    expect(isQuickStep(bashRunMsg(), bashRunMsg().blocks[0]!, action)).toBe(false);
  });
  it("Bash list (ls) → true", () => {
    expect(isQuickStep(bashReadMsg(), bashReadMsg().blocks[0]!, action)).toBe(true);
  });
  it("PowerShell run (cargo test) → false(与 Bash 同权走命令分类)", () => {
    const m = psMsg("cargo test");
    expect(isQuickStep(m, m.blocks[0]!, action)).toBe(false);
  });
  it("PowerShell list (ls) → true", () => {
    const m = psMsg("ls src");
    expect(isQuickStep(m, m.blocks[0]!, action)).toBe(true);
  });
  it("status 非 done(pending —— 执行中/等审批)→ false", () => {
    const m = psMsg("ls src", "pending");
    expect(isQuickStep(m, m.blocks[0]!, action)).toBe(false);
  });
  it("MCP tool (mcp__server__x) → false", () => {
    const m: ClaudeMessage = {
      id: nextId(),
      role: "assistant",
      blocks: [{ type: "tool_use", id: nextId(), name: "mcp__server__x", inputBrief: "x", input: {}, result: null, status: "done" }],
      timestamp: null,
      streaming: false,
    };
    expect(isQuickStep(m, m.blocks[0]!, action)).toBe(false);
  });
  it("Task tool → false", () => {
    const m: ClaudeMessage = {
      id: nextId(),
      role: "assistant",
      blocks: [{ type: "tool_use", id: nextId(), name: "Task", inputBrief: "x", input: {}, result: null, status: "done" }],
      timestamp: null,
      streaming: false,
    };
    expect(isQuickStep(m, m.blocks[0]!, action)).toBe(false);
  });
});

// ── computeFolds ──

describe("computeFolds", () => {
  it("空 messages → 空 rows", () => {
    const r = computeFolds([], { live: false, commandAction: action });
    expect(r.rows).toEqual([]);
    expect(r.stepFolds).toEqual([]);
  });

  it("live=true → 不折叠任何 step", () => {
    const msgs = [streamingMsg(), streamingMsg(), streamingMsg()];
    const r = computeFolds(msgs, { live: true, commandAction: action });
    expect(r.rows.every((row) => row.steps === null && row.work === null)).toBe(true);
    expect(r.stepFolds).toEqual([]);
  });

  it("单 quick step → 不折叠(默认 threshold=2)", () => {
    const msgs = [thinkingMsg()];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    expect(r.rows[0]!.steps === null).toBe(true);
    expect(r.stepFolds).toEqual([]);
  });

  it("连续 3 quick step → 1 fold(0..2)", () => {
    const msgs = [thinkingMsg(), readMsg(), thinkingMsg()];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    expect(r.stepFolds).toHaveLength(1);
    expect(r.stepFolds[0]).toEqual({ kind: "steps", start: 0, end: 2, summary: "3 个 quick step" });
    // rows 0/1/2 item=false;fold 在 row 0
    expect(r.rows[0]!.steps?.start).toBe(0);
    expect(r.rows[1]!.steps?.start).toBe(0);
    expect(r.rows[2]!.steps?.start).toBe(0);
  });

  it("含 Edit → 折断 fold", () => {
    const msgs = [thinkingMsg(), readMsg(), editMsg(), readMsg()];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    // 0..1 折(2 quick),Edit 独立(不折),后面 1 个 read 不折
    expect(r.stepFolds).toHaveLength(1);
    expect(r.stepFolds[0]!.end).toBe(1);
    expect(r.rows[2]!.steps === null).toBe(true); // Edit 显
    expect(r.rows[3]!.steps === null).toBe(true); // 单 read 不折
  });

  it("user text message 不参与 fold", () => {
    const msgs = [textMsg(), thinkingMsg(), readMsg(), thinkingMsg()];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    // user 在 0,不参与;1-2 是 quick(2 个)折;3 是单 quick 不折
    expect(r.stepFolds).toHaveLength(1);
    expect(r.stepFolds[0]!.start).toBe(1);
    expect(r.rows[0]!.steps === null && r.rows[0]!.work === null).toBe(true); // user 显
  });

  it("threshold=3 时 2 quick 不折", () => {
    const msgs = [thinkingMsg(), readMsg()];
    const r = computeFolds(msgs, { live: false, commandAction: action, threshold: 3 });
    expect(r.stepFolds).toEqual([]);
    expect(r.rows.every((row) => row.steps === null && row.work === null)).toBe(true);
  });

  it("threshold=3 时 3 quick 折", () => {
    const msgs = [thinkingMsg(), readMsg(), thinkingMsg()];
    const r = computeFolds(msgs, { live: false, commandAction: action, threshold: 3 });
    expect(r.stepFolds).toHaveLength(1);
  });

  it("Bash run (rm) 阻断 fold", () => {
    const msgs = [thinkingMsg(), bashRunMsg(), thinkingMsg()];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    expect(r.stepFolds).toEqual([]);
    expect(r.rows.every((row) => row.steps === null && row.work === null)).toBe(true);
  });

  it("等审批的 PowerShell(status pending)阻断 fold:审批卡所在行必显", () => {
    // 用户实测:待审批步骤被折进 fold,只剩「2 个步骤」提示、没有选择框
    const msgs = [thinkingMsg(), readMsg(), psMsg("cargo test", "pending")];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    expect(r.rows[2]!.steps === null && r.rows[2]!.work === null).toBe(true);
  });

  it("连续两个 pending PowerShell → 全部展开不折", () => {
    const r = computeFolds([psMsg("a", "pending"), psMsg("b", "pending")], { live: false, commandAction: action });
    expect(r.stepFolds).toEqual([]);
    expect(r.rows.every((row) => row.steps === null && row.work === null)).toBe(true);
  });

  // ── work fold(整轮折叠,P2.2)──

  it("无 user prompt → 无 work fold(思考流不折整轮)", () => {
    const r = computeFolds([thinkingMsg(), readMsg()], { live: false, commandAction: action });
    expect(r.workFolds).toEqual([]);
  });

  it("user → 2 工具步 → 答案(带 durationMs)→ 整轮折 1 行,置于答案前", () => {
    const answer: ClaudeMessage = {
      id: nextId(), role: "assistant", blocks: [{ type: "text", text: "done" }],
      timestamp: null, streaming: false, durationMs: 272_000,
    };
    const msgs = [textMsg(), readMsg(), bashReadMsg(), answer];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    expect(r.workFolds).toHaveLength(1);
    expect(r.workFolds[0]).toMatchObject({ kind: "work", start: 1, end: 2, workedMs: 272_000 });
    // 答案本身不受 work fold 影响(item=true)
    expect(r.rows[3]!.work === null && r.rows[3]!.steps === null).toBe(true);
    expect(r.rows[1]!.work?.kind).toBe("work");
  });

  it("答案无 durationMs → 不折(缺时长信息折了丢信息)", () => {
    const answer: ClaudeMessage = {
      id: nextId(), role: "assistant", blocks: [{ type: "text", text: "done" }],
      timestamp: null, streaming: false,
    };
    const msgs = [textMsg(), readMsg(), bashReadMsg(), answer];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    expect(r.workFolds).toEqual([]);
  });

  it("轮内只有 1 个有效步骤 → 不折(<threshold 2)", () => {
    const answer: ClaudeMessage = {
      id: nextId(), role: "assistant", blocks: [{ type: "text", text: "done" }],
      timestamp: null, streaming: false, durationMs: 5000,
    };
    const msgs = [textMsg(), readMsg(), answer];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    expect(r.workFolds).toEqual([]);
  });

  it("轮内含 plan 卡 → 从 plan 之后开始折(plan 卡本身必显)", () => {
    const planMsg: ClaudeMessage = {
      id: nextId(), role: "assistant",
      blocks: [{ type: "tool_use", id: nextId(), name: "exit_plan_mode", inputBrief: "p", input: {}, result: null, status: "done" }],
      timestamp: null, streaming: false,
    };
    const answer: ClaudeMessage = {
      id: nextId(), role: "assistant", blocks: [{ type: "text", text: "done" }],
      timestamp: null, streaming: false, durationMs: 60_000,
    };
    const msgs = [textMsg(), readMsg(), planMsg, bashReadMsg(), readMsg(), answer];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    expect(r.workFolds).toHaveLength(1);
    // plan(index 2)必显:fold 从 3 开始
    expect(r.workFolds[0]).toMatchObject({ start: 3, end: 4 });
    expect(r.rows[2]!.work === null && r.rows[2]!.steps === null).toBe(true);
  });

  it("edits 统计:Edit diff + Write 全 add,文件去重", () => {
    const editA: ClaudeMessage = {
      id: nextId(), role: "assistant",
      blocks: [{ type: "tool_use", id: nextId(), name: "Edit", inputBrief: "a.ts",
        input: { file_path: "a.ts", old_string: "x\ny", new_string: "x\nz\nw" }, result: null, status: "done" }],
      timestamp: null, streaming: false,
    };
    const writeB: ClaudeMessage = {
      id: nextId(), role: "assistant",
      blocks: [{ type: "tool_use", id: nextId(), name: "Write", inputBrief: "b.ts",
        input: { file_path: "b.ts", content: "1\n2\n3" }, result: null, status: "done" }],
      timestamp: null, streaming: false,
    };
    const editA2: ClaudeMessage = {
      id: nextId(), role: "assistant",
      blocks: [{ type: "tool_use", id: nextId(), name: "Edit", inputBrief: "a.ts",
        input: { file_path: "a.ts", old_string: "q", new_string: "r" }, result: null, status: "done" }],
      timestamp: null, streaming: false,
    };
    const answer: ClaudeMessage = {
      id: nextId(), role: "assistant", blocks: [{ type: "text", text: "done" }],
      timestamp: null, streaming: false, durationMs: 90_000,
    };
    const msgs = [textMsg(), editA, writeB, editA2, answer];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    expect(r.workFolds).toHaveLength(1);
    // a.ts 两次 Edit + b.ts Write = 2 个文件;diff x\ny → x\nz\nw = -1 +2,写 b = +3,a 二次 -1 +1
    expect(r.workFolds[0]!.edits).toEqual({ files: 2, added: 6, removed: 2 });
  });

  it("live=true → work fold 也不折(轮次进行中)", () => {
    const answer: ClaudeMessage = {
      id: nextId(), role: "assistant", blocks: [{ type: "text", text: "partial" }],
      timestamp: null, streaming: true,
    };
    const msgs = [textMsg(), readMsg(), bashReadMsg(), answer];
    const r = computeFolds(msgs, { live: true, commandAction: action });
    expect(r.workFolds).toEqual([]);
    expect(r.rows.every((row) => row.steps === null && row.work === null)).toBe(true);
  });

  it("long sequence(5 quick + 1 edit + 3 quick)→ 2 folds", () => {
    const msgs = [
      thinkingMsg(), readMsg(), thinkingMsg(), readMsg(), thinkingMsg(),
      editMsg(),
      thinkingMsg(), readMsg(), thinkingMsg(),
    ];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    expect(r.stepFolds).toHaveLength(2);
    expect(r.stepFolds[0]).toMatchObject({ start: 0, end: 4 });
    expect(r.stepFolds[1]).toMatchObject({ start: 6, end: 8 });
  });

  it("整段 streaming → live 短路", () => {
    const msgs = [streamingMsg(), streamingMsg()];
    const r = computeFolds(msgs, { live: false, commandAction: action });
    // streaming 视为非 quick,无 fold
    expect(r.stepFolds).toEqual([]);
    expect(r.rows.every((row) => row.steps === null && row.work === null)).toBe(true);
  });
});
