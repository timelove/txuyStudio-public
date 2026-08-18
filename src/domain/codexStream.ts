/**
 * codex exec --json 事件流的前端模型与归并纯函数。
 *
 * 后端(`src-tauri/src/codex`)spawn `codex exec --json ...`,逐行读 JSONL 并按顶层 type
 * 分类成 `CodexEventPayload` emit `codex-event`(item 内容透传,本文件按 item.type 归并)。
 *
 * 实测 codex exec --json 顶层事件仅 6 种(thread.started/item.started/item.completed/
 * turn.started/turn.completed + 非法行)。与 claude stream-json 的关键差异:
 * - **item.completed 自带输入+输出**(command_execution 一个 item 含 command+aggregated_output+
 *   exit_code;mcp_tool_call 含 server+tool+arguments+result),无需 tool_use/tool_result 配对,
 *   按 item.id 归并(item.started 的 pending 卡 -> item.completed 同 id 回填)。
 * - 一轮可有多条 agent_message(工具前说明/工具后说明/最终答案),每条独立成消息。
 * - 每轮 exec 跑完即 EOF -> terminated{normal}(当 idle 非错误)。
 *
 * 约定:本文件纯类型 + 纯函数,零 React/Tauri 依赖(避免 import cycle),与 `claudeStream.ts`/
 * `paneTree.ts` 同风格。Tauri invoke/listen 在 `codexTransport.ts`。
 */

// -- 后端事件 payload(与 `CodexEventPayload` 的 snake_case kind 标签对齐) --

/** 后端 emit 的 codex-event 事件外壳。 */
export type CodexEvent = {
  projectId: string;
  tabId: string;
  payload: CodexEventPayload;
};

/** 分类后的事件。`kind` 标签是 snake_case(后端 `#[serde(tag="kind", rename_all="snake_case")]`)。 */
export type CodexEventPayload =
  | { kind: "init"; sessionId: string }
  | { kind: "item_started"; item: CodexItem }
  | { kind: "item_completed"; item: CodexItem }
  | { kind: "turn_started" }
  | { kind: "turn_completed"; usage?: CodexUsage }
  | { kind: "terminated"; reason: string };

/**
 * codex item(item.started/item.completed 的 item 字段,实测结构)。
 * 按 item.type 取字段:agent_message(text)/command_execution(command+aggregated_output+
 * exit_code)/mcp_tool_call(server+tool+arguments+result+error)/reasoning(text)/error(message)。
 * 字段均 optional--codex 版本演进容错,缺失即省略显示。
 */
export type CodexItem = {
  id?: string;
  type?: string;
  /** agent_message / reasoning 正文。 */
  text?: string;
  /** command_execution:执行的命令。 */
  command?: string;
  /** command_execution:聚合输出。 */
  aggregated_output?: string;
  /** command_execution:退出码(null=尚在跑/未知)。 */
  exit_code?: number | null;
  /** in_progress / completed / failed。 */
  status?: string;
  /** mcp_tool_call:MCP server 名。 */
  server?: string;
  /** mcp_tool_call:工具名。 */
  tool?: string;
  /** mcp_tool_call:调用参数。 */
  arguments?: unknown;
  /** mcp_tool_call:结果({content:[{type:"text",text}]} 或 null)。 */
  result?: { content?: Array<{ type?: string; text?: string }> | null; structured_content?: unknown } | null;
  /** mcp_tool_call:错误(null=成功)。 */
  error?: unknown;
  /** error item:错误/警告文案。 */
  message?: string;
  /** custom_tool_call(兼容保留):工具名/输入。 */
  name?: string;
  input?: unknown;
  output?: unknown;
};

/** turn.completed.usage(token 用量,实测字段名)。cached_input_tokens ≈ claude 的 cache_read。 */
export type CodexUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
};

// -- 归并后的 UI 模型 --

export type CodexBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_use";
      /** item.id(item.started/item.completed 同 id 归并)。 */
      id: string;
      /** 归一化工具名(command_execution->"shell";mcp_tool_call->"mcp:<server>.<tool>";custom_tool_call->name)。 */
      name: string;
      inputBrief: string;
      /** 原始输入(展开详情用)。 */
      input: unknown;
      /** 工具结果(null=尚未返回)。 */
      result: CodexToolResult | null;
      status: "pending" | "running" | "done" | "error";
    };

export type CodexToolResult = {
  content: string;
  isError: boolean;
};

/** 会话运行状态(状态栏 + 输入框可用性依据)。codex 无独立 thinking 态(item 粒度驱动)。 */
export type CodexRunStatus = "idle" | "running" | "done" | "error";

/** applyEvent 的累积状态。 */
export type CodexStreamState = {
  messages: CodexMessage[];
  /** item.id -> {msgIdx, blockIdx}(item.started 建 pending 卡,item.completed 同 id 回填)。 */
  itemIndex: Map<string, { msgIdx: number; blockIdx: number }>;
  status: CodexRunStatus;
  meta: {
    model?: string;
    sessionId?: string;
    /** 上下文窗口上限(catalog 的 context_window,组件回填)。 */
    contextWindow?: number;
    reasoningEffort?: string;
    sandbox?: string;
  };
  /** 最近一轮 token 用量(turn.completed 回填)。 */
  lastUsage?: CodexUsage;
  terminatedReason: string | null;
};

export type CodexMessage = {
  id: string;
  role: "user" | "assistant";
  blocks: CodexBlock[];
  timestamp: string | null;
  /** 是否流式中(turn_completed 前为 true;codex 非流式,仅用于 UI 状态)。 */
  streaming: boolean;
  usage?: CodexUsage;
};

export const initialCodexState: CodexStreamState = {
  messages: [],
  itemIndex: new Map(),
  status: "idle",
  meta: {},
  terminatedReason: null,
};

/** 生成简易 id(非加密,仅前端去重用)。 */
function genId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** 把工具输入压成展示用 brief(截断)。 */
function briefInput(input: unknown): string {
  let s: string;
  if (typeof input === "string") {
    s = input;
  } else {
    try {
      s = JSON.stringify(input);
    } catch {
      s = String(input);
    }
  }
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

/** 把任意 unknown 压成展示字符串(截断防超长)。 */
function flattenText(v: unknown, max = 4000): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, max);
  try {
    return JSON.stringify(v, null, 2).slice(0, max);
  } catch {
    return String(v).slice(0, max);
  }
}

/** mcp_tool_call.result.content[] 拼接为文本。 */
function flattenMcpResult(item: CodexItem): string {
  const content = item.result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

/**
 * 已知 codex 启动 config 警告(每轮重复发,非对话内容,过滤掉)。
 * 实测样本:"`[features].web_search` is deprecated because web search is enabled by default. ..."
 */
function isConfigDeprecationWarning(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("is deprecated") || m.includes("`[features]`");
}

/** 工具类 item 类型(item.started 时建 pending 卡;agent_message/reasoning/error 等 started 忽略)。 */
function isToolItem(itemType: string | undefined): boolean {
  return itemType === "command_execution" || itemType === "mcp_tool_call" || itemType === "custom_tool_call" || itemType === "function_call";
}

/** 从 item 归一化工具名。 */
function toolNameOf(item: CodexItem): string {
  if (item.type === "command_execution") return "shell";
  if (item.type === "mcp_tool_call") return item.server ? `mcp:${item.server}.${item.tool ?? ""}` : `mcp:${item.tool ?? ""}`;
  return item.name ?? item.type ?? "tool";
}

/** 从 item 归一化输入(展示/详情用)。 */
function toolInputOf(item: CodexItem): unknown {
  if (item.type === "command_execution") return { command: item.command ?? "" };
  if (item.type === "mcp_tool_call") return item.arguments ?? {};
  return item.input ?? {};
}

/** 从 item.completed 归一化结果。 */
function toolResultOf(item: CodexItem): CodexToolResult {
  if (item.type === "command_execution") {
    const failed = item.exit_code != null && item.exit_code !== 0;
    return { content: flattenText(item.aggregated_output ?? ""), isError: failed };
  }
  if (item.type === "mcp_tool_call") {
    const errText = typeof item.error === "string" ? item.error : item.error ? flattenText(item.error) : "";
    if (errText) return { content: errText, isError: true };
    return { content: flattenMcpResult(item), isError: false };
  }
  // custom_tool_call 系:output 可能是字符串或 {content:[...]}。
  return { content: flattenText(item.output ?? ""), isError: false };
}

/**
 * 把 blocks 里仍 pending/running 的 tool_use 标记为 done(停止 spinner)。
 * turn_completed(轮次结束)/terminated 时调用:孤儿 item(事件丢失/中断)不会永久转圈。
 */
function finalizePendingTools(blocks: CodexBlock[]): CodexBlock[] {
  let changed = false;
  const out = blocks.map((b) => {
    if (b.type === "tool_use" && (b.status === "pending" || b.status === "running")) {
      changed = true;
      return { ...b, status: "done" as const };
    }
    return b;
  });
  return changed ? out : blocks;
}

/** 找最近一条 assistant 消息下标(无则 -1)。 */
function lastAssistantIdx(messages: CodexMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return i;
  }
  return -1;
}

/** 追加/更新一条 assistant 消息(同 id 覆盖,异 id 追加)。返回消息下标。 */
function upsertAssistantMessage(
  state: CodexStreamState,
  id: string,
  makeBlocks: (existing: CodexMessage | undefined) => CodexBlock[],
): number {
  const existingIdx = state.messages.findIndex((m) => m.id === id && m.role === "assistant");
  if (existingIdx >= 0) {
    const old = state.messages[existingIdx];
    state.messages[existingIdx] = { ...old, blocks: makeBlocks(old), streaming: true };
    return existingIdx;
  }
  state.messages.push({
    id,
    role: "assistant",
    blocks: makeBlocks(undefined),
    timestamp: new Date().toISOString(),
    streaming: true,
  });
  return state.messages.length - 1;
}

/**
 * 纯函数:把一个事件 payload 归并进 state,返回新 state(不可变更新)。
 *
 * 归并规则:
 * - init:记 meta.sessionId(thread_id,后续轮 resume 用)。
 * - item_started:工具类 item -> 在最近 assistant 消息追加 pending tool_use 卡 + itemIndex 登记;
 *   文本类(agent_message/reasoning)忽略(等 completed 一次性到,无流式)。
 * - item_completed:按 item.type 归并:
 *   - agent_message -> 独立 assistant 消息(id=item.id);
 *   - reasoning -> 最近 assistant 消息的 thinking block(无则新建);
 *   - command_execution/mcp_tool_call/custom_tool_call -> itemIndex 命中则回填同 id 卡,
 *     未命中(无 started)直接 push 已完成的卡;
 *   - error -> 过滤 config 弃用警告(每轮重复),其余以 ⚠ 文本提示。
 * - turn_started:status=running(新轮)。
 * - turn_completed:status=done + lastUsage 回填 + 最近 assistant streaming=false + 全量扫
 *   finalizePendingTools(孤儿 spinner 兜底)。
 * - terminated:normal/interrupted -> idle(不显错误);其余 -> error + terminatedReason。
 */
export function applyEvent(state: CodexStreamState, payload: CodexEventPayload): CodexStreamState {
  const next: CodexStreamState = {
    ...state,
    messages: [...state.messages],
    itemIndex: new Map(state.itemIndex),
    meta: { ...state.meta },
  };

  switch (payload.kind) {
    case "init": {
      next.meta = { ...next.meta, sessionId: payload.sessionId || next.meta.sessionId };
      next.terminatedReason = null;
      return next;
    }
    case "item_started": {
      const item = payload.item;
      if (!isToolItem(item.type)) return next;
      const itemId = item.id ?? genId("item");
      const name = toolNameOf(item);
      const input = toolInputOf(item);
      // 挂到最近一条 assistant 消息;无则新建一条(工具可能先于任何 agent_message)。
      const lastIdx = lastAssistantIdx(next.messages);
      const msgIdx = lastIdx >= 0
        ? lastIdx
        : upsertAssistantMessage(next, genId("assistant"), () => []);
      const m = next.messages[msgIdx];
      next.messages[msgIdx] = {
        ...m,
        blocks: [
          ...m.blocks,
          { type: "tool_use", id: itemId, name, inputBrief: briefInput(input), input, result: null, status: "running" },
        ],
      };
      next.itemIndex.set(itemId, { msgIdx, blockIdx: next.messages[msgIdx].blocks.length - 1 });
      return next;
    }
    case "item_completed": {
      const item = payload.item;
      const itemType = item.type ?? "";
      if (itemType === "agent_message") {
        const text = item.text ?? "";
        if (text.trim()) {
          upsertAssistantMessage(next, item.id ?? genId("agent"), () => [{ type: "text", text }]);
        }
        return next;
      }
      if (itemType === "reasoning") {
        const text = item.text ?? "";
        if (!text) return next;
        const lastIdx = lastAssistantIdx(next.messages);
        if (lastIdx < 0) return next;
        const m = next.messages[lastIdx];
        const lastBlock = m.blocks[m.blocks.length - 1];
        if (lastBlock && lastBlock.type === "thinking") {
          const blocks = [...m.blocks];
          blocks[blocks.length - 1] = { ...lastBlock, text: lastBlock.text + text };
          next.messages[lastIdx] = { ...m, blocks };
        } else {
          next.messages[lastIdx] = { ...m, blocks: [...m.blocks, { type: "thinking", text }] };
        }
        return next;
      }
      if (isToolItem(itemType)) {
        const itemId = item.id ?? genId("item");
        const pos = next.itemIndex.get(itemId);
        const result = toolResultOf(item);
        const isError = result.isError;
        if (pos) {
          // item.started 已建 pending 卡:回填 result + status。
          const target = next.messages[pos.msgIdx];
          const block = target?.blocks[pos.blockIdx];
          if (block && block.type === "tool_use" && block.id === itemId) {
            const blocks = [...target.blocks];
            blocks[pos.blockIdx] = { ...block, result, status: isError ? "error" : "done" };
            next.messages[pos.msgIdx] = { ...target, blocks };
            return next;
          }
        }
        // 无 started(或位置失效):直接 push 已完成的卡到最近 assistant 消息。
        const lastIdx = lastAssistantIdx(next.messages);
        const msgIdx = lastIdx >= 0
          ? lastIdx
          : upsertAssistantMessage(next, genId("assistant"), () => []);
        const m = next.messages[msgIdx];
        const name = toolNameOf(item);
        const input = toolInputOf(item);
        next.messages[msgIdx] = {
          ...m,
          blocks: [
            ...m.blocks,
            { type: "tool_use", id: itemId, name, inputBrief: briefInput(input), input, result, status: isError ? "error" : "done" },
          ],
        };
        next.itemIndex.set(itemId, { msgIdx, blockIdx: next.messages[msgIdx].blocks.length - 1 });
        return next;
      }
      if (itemType === "error") {
        const message = item.message ?? "";
        // 过滤 codex 启动 config 弃用警告(每轮重复发,非对话内容)。
        if (!message.trim() || isConfigDeprecationWarning(message)) return next;
        // 其余 error(如 stream 错误)以 ⚠ 文本提示,不阻断。
        upsertAssistantMessage(next, item.id ?? genId("error"), () => [{ type: "text", text: `⚠ ${message}` }]);
        return next;
      }
      // 未知 item.type:跳过(版本演进容错)。
      return next;
    }
    case "turn_started": {
      next.status = "running";
      next.terminatedReason = null;
      return next;
    }
    case "turn_completed": {
      next.status = "done";
      if (payload.usage) {
        next.lastUsage = payload.usage;
      }
      // 全量扫兜底:轮次结束,孤儿工具卡(item.completed 丢失/中断)不再转圈。
      for (let i = 0; i < next.messages.length; i++) {
        const m = next.messages[i];
        if (m.role !== "assistant") continue;
        next.messages[i] = { ...m, blocks: finalizePendingTools(m.blocks), streaming: false, usage: payload.usage ?? m.usage };
      }
      return next;
    }
    case "terminated": {
      // normal(每轮 exec 正常 EOF)/interrupted(用户中断):idle 不显错误;其余(spawn failed 等):error。
      if (payload.reason === "normal" || payload.reason === "interrupted") {
        next.status = "idle";
        next.terminatedReason = null;
      } else {
        next.status = "error";
        next.terminatedReason = payload.reason;
      }
      for (let i = 0; i < next.messages.length; i++) {
        const m = next.messages[i];
        if (m.role !== "assistant") continue;
        next.messages[i] = { ...m, blocks: finalizePendingTools(m.blocks), streaming: false };
      }
      return next;
    }
    default:
      return next;
  }
}

/**
 * 乐观插入用户消息(send 时调用,不等后端)。codex exec 不回显用户输入,前端自插。
 * 用户发新消息 = 新轮开始(status=running)。
 */
export function appendUserMessage(state: CodexStreamState, text: string): CodexStreamState {
  const id = genId("user");
  const next: CodexStreamState = {
    ...state,
    messages: [...state.messages, { id, role: "user", blocks: [{ type: "text", text }], timestamp: new Date().toISOString(), streaming: false }],
    itemIndex: new Map(state.itemIndex),
    meta: { ...state.meta },
    status: "running",
    terminatedReason: null,
  };
  return next;
}

// -- 对外汇总语义(状态栏 + tab chip 共用) --

/** 对外汇总的会话语义态。codex 无 plan/approval 等待态(无交互审批),简化为三态。 */
export type CodexSessionKind = "error" | "running" | "idle";

/** 对外汇总的会话状态(状态栏 + tab chip 共用)。 */
export type CodexSessionSummary = {
  kind: CodexSessionKind;
  /** 是否活跃(占资源),StatusBar 计数用。running 为 true。 */
  active: boolean;
  /** 上下文占用%(0-100,lastUsage(input+cached)/contextWindow)。无数据时 undefined。 */
  ctxPct?: number;
  /** 当前会话 model(spawn -m 或 config.toml 默认,组件回填)。 */
  model?: string;
  /** 当前 reasoning effort(用户期望值,乐观回填)。 */
  reasoningEffort?: string;
};

/**
 * 把 CodexStreamState 归并成对外汇总语义。优先级:error > running > idle。
 *
 * @param shellRunning `!` 命令是否在跑(同 tab 的 ShellRunTransport 状态)。tab chip 传
 *   (true 算 running);StatusBar 汇总不传(shell 是用户主动命令非 AI 会话)。
 */
export function summarize(state: CodexStreamState, shellRunning?: boolean): CodexSessionSummary {
  const u = state.lastUsage;
  const ctxBase = u ? (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0) + (u.cache_write_input_tokens ?? 0) : 0;
  const window = state.meta?.contextWindow;
  const ctxPct = ctxBase > 0 && window ? Math.min(100, (ctxBase / window) * 100) : undefined;
  const extra = { ctxPct, model: state.meta.model, reasoningEffort: state.meta.reasoningEffort };

  if (state.status === "error") return { kind: "error", active: false, ...extra };
  if (state.status === "running" || shellRunning) return { kind: "running", active: true, ...extra };
  return { kind: "idle", active: false, ...extra };
}
