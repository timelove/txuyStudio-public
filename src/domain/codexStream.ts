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

import { totalInputTokens } from "./contextMeter";

/** 后端 emit 的 codex-event 事件外壳。 */
export type CodexEvent = {
  projectId: string;
  tabId: string;
  payload: CodexEventPayload;
};

/** 分类后的事件。`kind` 标签是 snake_case(后端 `#[serde(tag="kind", rename_all="snake_case")]`)。 */
export type CodexEventPayload =
  | { kind: "init"; sessionId: string }
  | { kind: "user"; message: { id?: string; role?: string; content?: unknown } }
  | { kind: "item_started"; item: CodexItem }
  | { kind: "item_completed"; item: CodexItem }
  | { kind: "turn_started" }
  | { kind: "turn_completed"; usage?: CodexUsage }
  /** app-server 增量通知(itemType: agentMessage|reasoning|commandOutput;field: text|summary|output)。 */
  | { kind: "item_delta"; itemId: string; itemType: string; field: string; delta: string }
  /** app-server 权威用量(后端取 tokenUsage.last=最后一轮=当前上下文口径;camelCase,归一化见 normalizeUsage)。 */
  | { kind: "usage_updated"; usage: unknown; contextWindow?: number | null }
  /** app-server 实时审批请求(request 外壳 = {key, method, params},key 供响应路由)。 */
  | { kind: "approval_requested"; request: { key?: string; method?: string; params?: unknown } }
  /** app-server 审批已解决(后端 respond 后广播;前端撤卡)。 */
  | { kind: "approval_resolved"; requestId: string }
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
  /** app-server reasoning:摘要分段数组(completed 全文;delta 流式逐段)。 */
  summary?: unknown;
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

/**
 * 归一化用量对象为 CodexUsage(snake_case)。两来源字段形态不同:
 * - exec 模式 turn.completed.usage:原生 snake_case(input_tokens);
 * - app-server thread/tokenUsage/updated.last:camelCase(inputTokens)。
 * 双 casing 兼容读取,未知形态返回 undefined(调用方保留旧值)。
 */
function normalizeUsage(v: unknown): CodexUsage | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const val = o[k];
      if (typeof val === "number") return val;
    }
    return undefined;
  };
  return {
    input_tokens: num("input_tokens", "inputTokens"),
    cached_input_tokens: num("cached_input_tokens", "cachedInputTokens"),
    cache_write_input_tokens: num("cache_write_input_tokens", "cacheWriteInputTokens"),
    output_tokens: num("output_tokens", "outputTokens"),
    reasoning_output_tokens: num("reasoning_output_tokens", "reasoningOutputTokens"),
  };
}

// -- 归并后的 UI 模型 --

export type CodexBlock =
  | { type: "text"; text: string }
  | {
      type: "thinking";
      text: string;
      /** 思考耗时毫秒(started→completed 实测;历史回放无)。text 与 ms 双空时渲染层
       *  不展示(上游中转常不回可读 summary,2026-11-05 起空思考不留占位)。 */
      ms?: number;
    }
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
    permission?: string;
  };
  /** 最近一轮 token 用量(turn.completed / usage_updated 回填)。 */
  lastUsage?: CodexUsage;
  /** app-server 待决策审批(approval_requested 入,approval_resolved / 本地响应出)。 */
  pendingApproval?: CodexPendingApproval;
  terminatedReason: string | null;
  /** 仅内存:进行中 reasoning 的 started 时刻(itemId → epoch ms)。completed 时算耗时;
   *  上游中转不回可读 summary 时**不展示**思考块(2026-11-05),此表只服务于「有内容时」
   *  的时长结算,替代原先挂在空块上的 startedAt。initialCodexState 恒初始化。 */
  reasoningStartedAt: Map<string, number>;
};

/** app-server 审批请求(前端渲染卡 + 响应路由 key)。 */
export type CodexPendingApproval = {
  key: string;
  method: string;
  params: unknown;
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
  reasoningStartedAt: new Map(),
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
    reasoningStartedAt: new Map(state.reasoningStartedAt),
    meta: { ...state.meta },
  };

  switch (payload.kind) {
    case "init": {
      next.meta = { ...next.meta, sessionId: payload.sessionId || next.meta.sessionId };
      next.terminatedReason = null;
      return next;
    }
    case "user": {
      // 手机经中继发来的用户消息回显(codex 原生事件不回显输入)。桌面端自己发的在
      // `appendUserMessage` 已本地插入,后端不回显 → 这里只会收到手机来源的。
      const msg = payload.message;
      const raw = msg.content;
      const texts: string[] = Array.isArray(raw)
        ? raw
            .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
            .map((b) => b.text ?? "")
        : typeof raw === "string"
          ? [raw]
          : [];
      const text = texts.filter((t) => t.length > 0).join("\n");
      if (!text) return next;
      const id = msg.id ?? genId("user");
      if (next.messages.some((m) => m.id === id)) return next;
      next.messages.push({
        id,
        role: "user",
        blocks: [{ type: "text", text }],
        timestamp: new Date().toISOString(),
        streaming: false,
      });
      return next;
    }
    case "item_started": {
      const item = payload.item;
      // reasoning started:只记 started 时刻,**不建消息**——上游中转常不回可读 summary,
      // 空思考块(「思考 · Ns」占位)用户要求不展示(2026-11-05);等 delta/completed 带
      // 到真内容时才出现思考块,时长从这张表结算。
      if (item.type === "reasoning") {
        const rid = item.id ?? genId("reasoning");
        next.reasoningStartedAt.set(rid, Date.now());
        return next;
      }
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
        // app-server 形态(item.summary 数组,流式 delta 与 started 计时都挂 `rs-${id}`
        // 独立消息)→ completed 全量替换并结算 ms。**summary 为空 = 不展示**(不建消息;
        // started 计时条目清掉),上游中转不回可读 summary 时消息流里无思考痕迹。exec
        // 形态(item.text)→ 原逻辑挂最近 assistant 的 thinking(exec 无 delta/started,
        // completed 一次性到,text 空同样跳过)。
        const summaryText = Array.isArray(item.summary) ? item.summary.filter((s) => typeof s === "string").join("") : "";
        const rid = item.id ?? genId("reasoning");
        if (summaryText) {
          const startedAt = next.reasoningStartedAt.get(rid);
          next.reasoningStartedAt.delete(rid);
          upsertAssistantMessage(next, `rs-${rid}`, (existing) => {
            const prev = existing?.blocks.find((b) => b.type === "thinking");
            // 时长优先取 started 时刻表;delta 先于 completed 建消息(无表项)时退回
            // 流式下无法计时长(不显),真实历史场景 delta→completed 间隔毫秒级。
            const ms = startedAt != null ? Date.now() - startedAt : undefined;
            return [{ type: "thinking", text: summaryText, ...(ms != null ? { ms } : {}) }];
          });
          return next;
        }
        next.reasoningStartedAt.delete(rid);
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
      // 计时表按轮清空:reasoning 条目属于单轮,残留(中断/丢 completed)会让下轮
      // thinkingNow 误判「思考中」。
      next.reasoningStartedAt.clear();
      return next;
    }
    case "item_delta": {
      // app-server 流式增量。agentMessage 按itemId 独立消息累计(completed 同 id 全量覆盖);
      // reasoning 挂 `rs-${itemId}` 独立消息累计(completed summary 全量替换);commandOutput
      // 忽略(聚合输出 completed 全量到,工具卡为整块渲染)。
      const { itemId, itemType, field, delta } = payload;
      if (!delta) return next;
      if (itemType === "agentMessage" && field === "text") {
        upsertAssistantMessage(next, itemId, (existing) => {
          const prev = existing?.blocks.find((b) => b.type === "text");
          const prevText = prev && prev.type === "text" ? prev.text : "";
          return [{ type: "text", text: prevText + delta }];
        });
        return next;
      }
      if (itemType === "reasoning" && field === "summary") {
        // 首个 summary delta 到达才建 `rs-${itemId}` 消息(此前 started 只记时刻不建消息,
        // 空 summary 不展示);completed 同 id 全量替换 + 结算 ms。
        upsertAssistantMessage(next, `rs-${itemId}`, (existing) => {
          const prev = existing?.blocks.find((b) => b.type === "thinking");
          const prevText = prev && prev.type === "thinking" ? prev.text : "";
          return [{ type: "thinking", text: prevText + delta }];
        });
        return next;
      }
      return next;
    }
    case "usage_updated": {
      // 权威用量(后端取 tokenUsage.last=最后一轮,ctx% 口径正确;total 是会话累计,
      // 旧口径拿来做 ctx 会虚高超窗);contextWindow 回填 meta(exec 模式只能从 catalog
      // 查,app-server 服务端直接给)。
      const u = normalizeUsage(payload.usage);
      if (u) next.lastUsage = u;
      if (typeof payload.contextWindow === "number" && payload.contextWindow > 0) {
        next.meta = { ...next.meta, contextWindow: payload.contextWindow };
      }
      return next;
    }
    case "approval_requested": {
      const { key, method, params } = payload.request;
      if (!key) return next;
      next.pendingApproval = { key, method: method ?? "", params: params ?? null };
      return next;
    }
    case "approval_resolved": {
      // 后端 respond(或超时/他端决策)后的权威广播:无条件撤卡(响应路径本地也会清,
      // 广播是兜底多视图同步)。
      next.pendingApproval = undefined;
      return next;
    }
    case "turn_completed": {
      next.status = "done";
      if (payload.usage) {
        next.lastUsage = payload.usage;
      }
      // 计时表按轮清空(残留条目防 thinkingNow 误判,同 turn_started)。
      next.reasoningStartedAt.clear();
      // 全量扫兜底:轮次结束,孤儿工具卡(item.completed 丢失/中断)不再转圈。
      // 引用保持:blocks 无变化且非 streaming 的消息保留原对象(避免每轮整树 reconcile);
      // usage 仅回填最近一条 assistant(同 claude result 语义,行尾 token 显示用)。
      let usageFilled = false;
      for (let i = next.messages.length - 1; i >= 0; i--) {
        const m = next.messages[i];
        if (m.role !== "assistant") continue;
        const blocks = finalizePendingTools(m.blocks);
        const fillUsage = !usageFilled && !!payload.usage;
        if (fillUsage) usageFilled = true;
        if (blocks !== m.blocks || m.streaming || fillUsage) {
          next.messages[i] = { ...m, blocks, streaming: false, usage: fillUsage ? payload.usage : m.usage };
        }
      }
      return next;
    }
    case "terminated": {
      // normal(exec 每轮正常 EOF)/interrupted(用户中断):idle 不显错误;exit(长进程崩溃)/
      // 其余(spawn failed 等):error(重发消息时后端 ensure 重拉进程 + thread/resume 续接)。
      if (payload.reason === "normal" || payload.reason === "interrupted") {
        next.status = "idle";
        next.terminatedReason = null;
      } else {
        next.status = "error";
        next.terminatedReason = payload.reason;
      }
      // 中断/进程退出后审批请求不再可答(进程死了或轮已断),撤卡防悬空。
      next.pendingApproval = undefined;
      // 计时表清空(轮已断,残留条目防 thinkingNow 误判)。
      next.reasoningStartedAt.clear();
      for (let i = 0; i < next.messages.length; i++) {
        const m = next.messages[i];
        if (m.role !== "assistant") continue;
        // 引用保持:blocks 无变化且本就非 streaming 的消息保留原对象。
        const blocks = finalizePendingTools(m.blocks);
        if (blocks !== m.blocks || m.streaming) {
          next.messages[i] = { ...m, blocks, streaming: false };
        }
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
  // totalInputTokens:openai 语义 input 已含 cached,直接相加会双倍(见 contextMeter 注释)。
  const ctxBase = u ? totalInputTokens(u.input_tokens ?? 0, u.cached_input_tokens ?? 0, u.cache_write_input_tokens ?? 0) : 0;
  const window = state.meta?.contextWindow;
  const ctxPct = ctxBase > 0 && window ? Math.min(100, (ctxBase / window) * 100) : undefined;
  const extra = { ctxPct, model: state.meta.model, reasoningEffort: state.meta.reasoningEffort };

  if (state.status === "error") return { kind: "error", active: false, ...extra };
  if (state.status === "running" || shellRunning) return { kind: "running", active: true, ...extra };
  return { kind: "idle", active: false, ...extra };
}
