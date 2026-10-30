// BaoCode P2.1 — StepFolds 渐进折叠(纯函数)
//
// 借鉴:BaoCode step_folds.dart(StepFolds.of 计算 + rowAt 渲染)
//
// 规则:
//  - steps:连续 ≥2 quick steps(单 block:thinking / 简单 tool_use)折叠成 1 行
//  - work:已结束的 turn(用户消息 → 末条 assistant 答案之间)整段折叠成 1 行
//    「已处理 4m32s · 5 个文件 +120 -8」,置于答案气泡之前(baocode WorkFoldLine 同构)
//  - live turn:不折叠,实时展示
//  - plan / 复杂 Edit / subagent(Task):不参与 steps 折叠(高价值步骤必显)
//
// 设计:纯函数,无副作用,易测。集成侧在 ClaudePane 渲染时
// `useMemo([messages, live])` 派生 foldMap。

import type { ClaudeBlock, ClaudeMessage } from "./claudeStream";

/** 命令分类回调(从 commandClassifier.classifyCommand 透传,避免本文件反向依赖 lib)。
 *  签名严格匹配:`(cmd: string) => "read"|"search"|"list"|"run"|"other"` */
export type CommandAction = (cmd: string) => "read" | "search" | "list" | "run" | "other";

/** 单个 fold 段。kind 区分 steps(连续 quick step 折叠) / work(整段已完成 turn 折叠)。 */
export type StepFold = {
  kind: "steps" | "work";
  /** 起始 message 索引(0-based,state.messages 数组下标)。 */
  start: number;
  /** 结束 message 索引(包含)。 */
  end: number;
  /** 折叠时显示的摘要(可空 → UI 兜底「N 个步骤」)。 */
  summary?: string;
  /** work fold 专用:本轮耗时 ms(result 回填 durationMs)。 */
  workedMs?: number;
  /** work fold 专用:本轮编辑统计(文件数 / +行 / -行,baocode TurnEdits 同构)。 */
  edits?: { files: number; added: number; removed: number };
};

/** 每个 message index 的 fold 归属(扁平,两层可并存):
 *  - `steps / work`:该 message 所属的 fold(段内任意位置都持有引用,null=不属于)
 *  - 可见性由 UI 侧按「fold 起始行渲染折叠行 + open 状态」派生,纯函数不掺 UI 态。
 *  - 规则:work 优先于 steps——work 折叠收起时整段隐藏(steps 行不渲染);
 *    work 展开后段内 items 恢复,其中属于 steps fold 的仍按 steps 折叠(渐进两层)。 */
export type RowFold = {
  steps: StepFold | null;
  work: StepFold | null;
};

export type ComputeFoldsOptions = {
  /** 当前会话是否活跃(任一 message.streaming=true);true 时不折叠任何 step。
   *  调用方应把「can_use_tool 挂起等审批」也合成进来 —— 挂起时消息 streaming 已结束
   *  (CLI 阻塞等答复),但轮次仍等用户决策,照常折叠会把审批卡藏掉。 */
  live: boolean;
  commandAction: CommandAction;
  /** 连续几个 quick step 才折叠(默认 2,baoCode 风格)。 */
  threshold?: number;
  /** work fold 最小 turn durationMs(默认 0;本阶段先不做 work fold,留接口)。 */
  workMinMs?: number;
};

export type ComputeFoldsResult = {
  /** 每个 message index 的 fold 描述(长度 = messages.length)。 */
  rows: RowFold[];
  /** 检测到的 step folds(供调试 / 列表显示)。 */
  stepFolds: StepFold[];
  /** 检测到的 work folds(本阶段恒空)。 */
  workFolds: StepFold[];
};

/** 单 block 是否算 quick step(参与 steps 折叠)。
 *  规则:
 *  - thinking block:true(是 quick step)
 *  - tool_use:status 非 done(pending/running —— 执行中,或 can_use_tool 挂起等审批;
 *    error 同理展开)一律 false:未落定的步骤折掉会把审批卡/运行态一起藏掉
 *    (用户实测:只见「2 个步骤」折叠行、没有选择框)
 *  - tool_use:done 且高价值(Edit/Write/MultiEdit/NotebookEdit/Task/exit_plan_mode/
 *    TodoWrite/mcp__*)→ false(重要,显)
 *  - tool_use:done 且 Bash/PowerShell → 命令分类 read/search/list 为 true、run 为 false
 *  - tool_use:done 且其余(Read/Grep/Glob/WebFetch/WebSearch 等只读)→ true
 *  - text block:false(占位 user 文本) */
export function isQuickStep(
  msg: ClaudeMessage,
  block: ClaudeBlock,
  commandAction: CommandAction,
): boolean {
  if (block.type === "thinking") return true;
  if (block.type === "text") return false;
  if (block.type === "tool_use") {
    // 未落定的工具调用不折叠(执行中 / 等审批;error 展开显错误信息)
    if (block.status !== "done") return false;
    // 高价值工具不折叠
    if (
      block.name === "Edit" ||
      block.name === "Write" ||
      block.name === "MultiEdit" ||
      block.name === "NotebookEdit" ||
      block.name === "Task" ||
      block.name === "exit_plan_mode" ||
      block.name === "ExitPlanMode" ||
      block.name === "TodoWrite" || // 待办更新:状态药丸有意义,必显
      block.name.startsWith("mcp__") // MCP 工具:保守不折叠
    ) {
      return false;
    }
    if (block.name === "Bash" || block.name === "PowerShell") {
      // 走命令分类(run → 重要,显;read/search/list → quick)。PowerShell 与 Bash
      // 同权 —— Windows 端 CLI 的命令工具名就是 PowerShell,漏判会让待审批的
      // PowerShell 步骤落到下方 default-true 被折掉(审批卡跟着消失)。
      const cmd = typeof block.input === "object" && block.input && "command" in block.input
        ? String((block.input as { command: unknown }).command ?? "")
        : "";
      const cat = commandAction(cmd);
      return cat === "read" || cat === "search" || cat === "list";
    }
    // Read / Glob / Grep / WebSearch / WebFetch 等只读工具:quick
    return true;
  }
  return false;
}

/** 单 message 是否全是 quick step(整条消息只有一个 block 且 quick)。 */
function isMessageAllQuick(
  msg: ClaudeMessage,
  commandAction: CommandAction,
): boolean {
  if (msg.blocks.length === 0) return false;
  return msg.blocks.every((b) => isQuickStep(msg, b, commandAction));
}

/** 派生 steps 折叠。
 *  算法:从 i=0 扫到 N-1,遇 first quick start → 找连续 quick 段长度 ≥ threshold,
 *  生成一个 StepFold;否则散点不折叠。 */
function deriveStepFolds(
  messages: ClaudeMessage[],
  commandAction: CommandAction,
  threshold: number,
): StepFold[] {
  const folds: StepFold[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    // 跳过 non-quick / streaming
    if (m.streaming || !isMessageAllQuick(m, commandAction)) {
      i++;
      continue;
    }
    // 找连续 quick 段
    let j = i + 1;
    while (j < messages.length) {
      const mj = messages[j]!;
      if (mj.streaming || !isMessageAllQuick(mj, commandAction)) break;
      j++;
    }
    const length = j - i;
    if (length >= threshold) {
      folds.push({ kind: "steps", start: i, end: j - 1, summary: `${length} 个 quick step` });
    }
    i = j;
  }
  return folds;
}

export function computeFolds(
  messages: ClaudeMessage[],
  options: ComputeFoldsOptions,
): ComputeFoldsResult {
  const threshold = options.threshold ?? 2;
  const rows: RowFold[] = messages.map(() => ({ steps: null, work: null }));

  // live:不折叠
  if (options.live) {
    return { rows, stepFolds: [], workFolds: [] };
  }

  const stepFolds = deriveStepFolds(messages, options.commandAction, threshold);
  const workFolds = deriveWorkFolds(messages);

  // 归属标记(扁平):段内每行都持有 fold 引用;渲染层据此决定「折叠行放哪、哪些行隐藏」。
  // work 段内的 steps 归属仍保留(work 展开后段内 quick steps 继续按 steps 收拢)。
  for (const fold of workFolds) {
    for (let k = fold.start; k <= fold.end; k++) {
      rows[k] = { ...rows[k]!, work: fold };
    }
  }
  for (const fold of stepFolds) {
    for (let k = fold.start; k <= fold.end; k++) {
      rows[k] = { ...rows[k]!, steps: fold };
    }
  }

  return { rows, stepFolds, workFolds };
}

/**
 * work fold 派生(baocode StepFolds.of 的 work 段平移):
 * 每个「已结束的 turn」= user 消息(prompt)→ 该轮最后一条 assistant 消息。把
 * prompt 之后、**最后一条 assistant 答案之前** 的中间步骤整段折成一行,置于答案前。
 *
 * - 答案 = 轮内最后一条 assistant 消息(纯文本回复;若无则不折,工具轮没有可分离的答案)。
 * - workedMs = 答案消息的 durationMs(result 回填;没有则不折 —— 没有时长信息的轮
 *   折了反而丢信息)。
 * - edits = 段内 Edit/Write/MultiEdit/NotebookEdit 的文件级 +N/-M 统计(diffLines 逐
 *   block 算,Edit 用 old/new,Write 全 add)。
 * - 有效步骤数 ≥ workThreshold(默认 2)才折:一轮只跑了一个工具就折纯属噪音。
 * - 轮内含 plan 卡(exit_plan_mode)→ 从 plan 之后开始折(plan 卡本身必显,
 *   baocode PlanItem 同规则)。
 */
function deriveWorkFolds(messages: ClaudeMessage[], workThreshold = 2): StepFold[] {
  const folds: StepFold[] = [];
  // 1) 收集 prompt 索引:非 streaming 的 user 消息(appendUserMessage 乐观插入的那条;
  //    tool_result 的 user 行在 jsonl 里也会回显,但 applyEvent 的纯文本兜底分支只在
  //    content 含 text 时 push——tool_result-only 的 user 行不会进 messages,无歧义)。
  const prompts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && !m.streaming) prompts.push(i);
  }
  // 2) 逐轮:turn 范围 = (prompt, nextPrompt 或数组末尾]。
  for (let t = 0; t < prompts.length; t++) {
    const prompt = prompts[t];
    const turnEnd = (t + 1 < prompts.length ? prompts[t + 1] : messages.length) - 1;
    if (turnEnd <= prompt) continue;
    // 答案 = 轮内最后一条 assistant 消息。
    let answer = -1;
    for (let i = turnEnd; i > prompt; i--) {
      if (messages[i].role === "assistant") {
        answer = i;
        break;
      }
    }
    if (answer <= prompt) continue;
    const workedMs = messages[answer].durationMs;
    if (workedMs == null || workedMs <= 0) continue;
    // 起点默认 prompt+1;轮内有 plan 卡则从 plan 之后折(plan 前的规划步骤保留展示)。
    let start = prompt + 1;
    for (let i = answer - 1; i > prompt; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.blocks.some((b) => b.type === "tool_use" && (b.name === "exit_plan_mode" || b.name === "ExitPlanMode"))) {
        start = i + 1;
        break;
      }
    }
    if (answer <= start) continue;
    // 有效步骤数(不含 thinking-only 的空壳消息):<threshold 不折。
    let shown = 0;
    for (let i = start; i < answer; i++) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const nonThinking = m.blocks.filter((b) => b.type !== "thinking");
      if (nonThinking.length > 0) shown++;
    }
    if (shown < workThreshold) continue;
    const edits = turnEdits(messages, start, answer);
    folds.push({ kind: "work", start, end: answer - 1, workedMs, edits });
  }
  return folds;
}

/** 段内编辑统计:Edit(old→new diff)/ MultiEdit(逐 edit)/ Write(全 add)。
 *  files 按 file_path 去重(baocode TurnEdits 同构)。 */
function turnEdits(messages: ClaudeMessage[], start: number, end: number): { files: number; added: number; removed: number } {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (const b of m.blocks) {
      if (b.type !== "tool_use") continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      const fp = typeof input.file_path === "string" ? input.file_path : null;
      if (b.name === "Edit" || b.name === "MultiEdit") {
        if (!fp) continue;
        files.add(fp);
        if (b.name === "Edit") {
          const oldS = typeof input.old_string === "string" ? input.old_string : "";
          const newS = typeof input.new_string === "string" ? input.new_string : "";
          for (const l of diffLinesLite(oldS, newS)) {
            if (l === "+") added++;
            else if (l === "-") removed++;
          }
        } else if (Array.isArray(input.edits)) {
          for (const e of input.edits) {
            if (!e || typeof e !== "object") continue;
            const oldS = typeof (e as Record<string, unknown>).old_string === "string" ? ((e as Record<string, unknown>).old_string as string) : "";
            const newS = typeof (e as Record<string, unknown>).new_string === "string" ? ((e as Record<string, unknown>).new_string as string) : "";
            for (const l of diffLinesLite(oldS, newS)) {
              if (l === "+") added++;
              else if (l === "-") removed++;
            }
          }
        }
      } else if (b.name === "Write") {
        if (!fp) continue;
        files.add(fp);
        const content = typeof input.content === "string" ? input.content : "";
        added += content.split("\n").length;
      }
    }
  }
  return { files: files.size, added, removed };
}

/** 行级 diff 计数(只数 +/-,不需要词级高亮;从 domain/diff 的 diffLines 简化,
 *  避免本文件 import 循环 —— diff.ts 不依赖本文件,但保持 domain 内无环更稳)。 */
function diffLinesLite(oldStr: string, newStr: string): ("+" | "-")[] {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  // 超大输入保护:直接数行(全 del + 全 add)。
  if (a.length > 500 || b.length > 500) {
    return [...a.map(() => "-" as const), ...b.map(() => "+" as const)];
  }
  // LCS DP(O(n*m),短输入)。
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: ("+" | "-")[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push("-");
      i++;
    } else {
      out.push("+");
      j++;
    }
  }
  while (i < n) {
    out.push("-");
    i++;
  }
  while (j < m) {
    out.push("+");
    j++;
  }
  return out;
}
