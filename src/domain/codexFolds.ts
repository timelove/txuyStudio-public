// codex 消息流的折叠口径(stepFolds 泛化回调的 codex 实现,2026-11-04 对齐 claude 的
// 「已处理」两层折叠:work fold 轮总结 + steps fold 快步骤归并)。
//
// codex 与 claude 消息模型差异(fold 相关部分):
// - codex 一轮的消息很碎:thinking 是独立 `rs-` 消息、工具卡挂在最近 assistant(可能
//   与 thinking 混块)、agent_message 独立纯文本消息——「消息全 quick」判定仍按 block 级。
// - 工具名归一化后只有 shell / mcp:<server>.<tool> / custom_tool_call 系(claude 是
//   Read/Grep/Bash/...);文件编辑走 shell 命令,无结构化 diff item → edits 统计不采。
// - 无逐消息 durationMs(result 事件才有);轮时长用 answer.timestamp - prompt.timestamp。

import { classifyCommand } from "../lib/commandClassifier";
import type { ClaudeBlock, ClaudeMessage } from "./claudeStream";
import type { CodexBlock, CodexMessage } from "./codexStream";
import type { CommandAction, ToolActionClass } from "./stepFolds";

/** codex 快步骤判定(stepFolds.quickStepOf 回调,签名与 isQuickStep 同构,msg 不消费):
 *  与 claude 同规则,工具名换 codex 口径——thinking quick;未落定(status≠done)不折;
 *  MCP 保守不折;shell 按命令分类(read/search/list quick,run 高价值必显);
 *  custom/function_call 等其余按只读 quick。 */
export function codexQuickStepOf(_msg: ClaudeMessage, block: ClaudeBlock, commandAction: CommandAction): boolean {
  if (block.type === "thinking") return true;
  if (block.type === "text") return false;
  if (block.type !== "tool_use") return false;
  if (block.status !== "done") return false;
  if (block.name.startsWith("mcp:")) return false;
  if (block.name === "shell") {
    const cmd =
      typeof block.input === "object" && block.input && "command" in block.input
        ? String((block.input as { command: unknown }).command ?? "")
        : "";
    const cat = commandAction(cmd);
    return cat === "read" || cat === "search" || cat === "list";
  }
  return true;
}

/** codex 工具 → 动作分类(StepFoldRow.classifyTool / tallySteps 覆盖)。shell 走
 *  commandClassifier 同一分类器(claude/codex 同口径,不养两套规则)。 */
export function codexClassifyTool(block: ClaudeBlock): ToolActionClass {
  if (block.type !== "tool_use") return "use";
  if (block.name === "shell") {
    const cmd =
      typeof block.input === "object" && block.input && "command" in block.input
        ? String((block.input as { command: unknown }).command ?? "")
        : "";
    switch (classifyCommand(cmd)) {
      case "read":
        return "read";
      case "search":
        return "search";
      case "list":
        return "list";
      default:
        return "run";
    }
  }
  return "use";
}

/** 轮时长(stepFolds.workedMsOf 回调):answer.timestamp - prompt.timestamp(codex 无
 *  result 事件回填 durationMs;消息创建时刻 ISO 串)。缺失/非正数返回 null(该轮不折)。 */
export function codexWorkedMsOf(messages: ClaudeMessage[], answerIdx: number, promptIdx: number): number | null {
  const a = Date.parse(messages[answerIdx]?.timestamp ?? "");
  const p = Date.parse(messages[promptIdx]?.timestamp ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(p)) return null;
  const ms = a - p;
  return ms > 0 ? ms : null;
}

/**
 * CodexMessage[] → stepFolds 可消费的 ClaudeMessage 形状(显式映射,不靠 cast):
 * - role:codex 只有 user/assistant(claude 四值联合的子集)✓
 * - blocks:text 同构;thinking 摘掉 codex 专属 ms;tool_use 与 claude 完全
 *   同构(id/name/inputBrief/input/result/status)。
 * 折叠是纯读计算,摘抄形状零副作用;消息对象不共享引用(展开体渲染仍用原始 CodexMessage)。
 */
export function codexMsgsToFoldShape(msgs: CodexMessage[]): ClaudeMessage[] {
  return msgs.map((m) => ({
    id: m.id,
    role: m.role,
    blocks: m.blocks.map(codexBlockToFoldShape),
    timestamp: m.timestamp,
    streaming: m.streaming,
  }));
}

function codexBlockToFoldShape(b: CodexBlock): ClaudeBlock {
  if (b.type === "text") return { type: "text", text: b.text };
  // thinking 保留真实计时 ms(tallySteps「思考 Ns」优先用真值,缺失才字数粗估)。
  if (b.type === "thinking") return { type: "thinking", text: b.text, ...(b.ms != null ? { ms: b.ms } : {}) };
  return {
    type: "tool_use",
    id: b.id,
    name: b.name,
    inputBrief: b.inputBrief,
    input: b.input,
    result: b.result,
    status: b.status,
  };
}
