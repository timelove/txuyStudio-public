/**
 * claude stream-json 事件流的前端模型与归并纯函数。
 *
 * 后端(`src-tauri/src/claude`)spawn `claude -p --output-format stream-json --verbose`,逐行读 JSON
 * 并分类成 `ClaudeEventPayload` emit `claude-event` 事件(后端已做 thinking_tokens 节流)。
 * 本文件:
 * - 定义事件 payload 类型(与后端 `ClaudeEventPayload` camelCase 对齐);
 * - 定义归并后的 UI 消息模型(`ClaudeMessage`/`ClaudeBlock`);
 * - 提供 `applyEvent(state, payload)` 纯函数,把事件流归并成消息列表。
 *
 * 约定:本文件纯类型 + 纯函数,零 React/Tauri 依赖(避免 import cycle),与 `paneTree.ts`/
 * `aiCliSessions.ts` 同风格。Tauri invoke/listen 在 `claudeTransport.ts`。
 */

// —— 后端事件 payload(与 `ClaudeEventPayload` 的 snake_case kind 标签对齐) ——

// `isPermissionDenied` 用于 hasPendingApproval 判定(审批被拒的 tool_use)。claudeToolConfigs 仅
// `import type` 依赖本文件(类型擦除),故此处值 import 无运行时循环。
import { isPermissionDenied } from "./claudeToolConfigs";

/** 后端 emit 的 claude-event 事件外壳。 */
export type ClaudeEvent = {
  projectId: string;
  tabId: string;
  payload: ClaudeEventPayload;
};

/** 分类后的事件。`kind` 标签是 snake_case(后端 `#[serde(tag="kind", rename_all="snake_case")]`)。 */
export type ClaudeEventPayload =
  | { kind: "init"; claudeSessionId: string; model: string; cwd: string; slashCommands: string[] }
  | { kind: "assistant"; message: ClaudeRawMessage }
  | { kind: "user"; message: ClaudeRawMessage }
  | { kind: "thinking"; text: string }
  | { kind: "result"; success: boolean; durationMs: number; numTurns: number; totalCostUsd: number; stopReason: string | null; error: string | null; usage?: ClaudeUsage; contextWindow?: number }
  | { kind: "terminated"; reason: string }
  | { kind: "compact_status"; status: string | null; result: string | null; error: string | null }
  | { kind: "compact_boundary"; metadata: CompactMetadata }
  | { kind: "background_tasks_changed"; tasks: BackgroundTaskInfo[] }
  | { kind: "task_notification"; taskId: string; toolUseId?: string; status: string; summary: string };

/** 后台任务信息(claude `system subtype=background_tasks_changed` 快照项)。 */
export type BackgroundTaskInfo = {
  taskId: string;
  /** claude 任务类型(实测 "local_bash";subagent 等原样透传)。 */
  taskType: string;
  /** 人读描述(assistant 发起工具调用时的 description)。 */
  description: string;
};

/** claude stream-json 透传的原始 message(assistant/user)。content 是 block 数组。 */
export type ClaudeRawMessage = {
  id?: string;
  role: "user" | "assistant";
  content: ClaudeRawBlock[];
  model?: string;
  /** assistant message 携带的 token 用量(stream-json 透传,用于消息级 token 显示)。 */
  usage?: ClaudeUsage;
};

/** assistant message.usage 的 token 计数字段(claude 实测字段名)。 */
export type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

/** usage 是否含真实 token。glm-5.2 代理流式时 assistant message.usage 恒为 {0,0}(计费未发生),
 * 视为「空」不覆盖已回填的真实值(防止 --resume 重发历史时把 result 回填的 usage 清零)。 */
export function hasUsage(u?: ClaudeUsage): boolean {
  if (!u) return false;
  return (
    (u.input_tokens ?? 0) !== 0 ||
    (u.output_tokens ?? 0) !== 0 ||
    (u.cache_creation_input_tokens ?? 0) !== 0 ||
    (u.cache_read_input_tokens ?? 0) !== 0
  );
}

/** stream-json message.content[] 的 block 类型(claude 实测)。 */
export type ClaudeRawTextBlock = { type: "text"; text: string };
export type ClaudeRawThinkingBlock = { type: "thinking"; thinking: string; signature?: string };
export type ClaudeRawToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ClaudeRawToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown;
  is_error?: boolean;
};
export type ClaudeRawBlock =
  | ClaudeRawTextBlock
  | ClaudeRawThinkingBlock
  | ClaudeRawToolUseBlock
  | ClaudeRawToolResultBlock;

/**
 * compact_boundary 透传的 compact_metadata(后端 `serde_json::Value` 透传,snake_case 字段)。
 * 字段均 optional——claude 不同版本字段略有差异,前端按需取用,缺失即省略显示。
 * - trigger:compact 触发方式(manual/auto)- pre_tokens/post_tokens:压缩前后 token 数 → 压缩比
 * - duration_ms:compact 耗时(GLM 代理约 60-70s)
 * - preserved_segment/preserved_messages:保留的片段/消息
 */
export type CompactMetadata = {
  trigger?: string;
  pre_tokens?: number;
  post_tokens?: number;
  cumulative_dropped_tokens?: number;
  duration_ms?: number;
  preserved_segment?: unknown;
  preserved_messages?: unknown;
};

// —— 归并后的 UI 模型 ——

/** compact_boundary 渲染用的压缩比信息(从 CompactMetadata 抽取,UI 友好)。 */
export type CompactMeta = {
  preTokens?: number;
  postTokens?: number;
  /** 压缩百分比(0-100),pre/post 均有才算。 */
  pct?: number;
  durationMs?: number;
};

/**
 * 归并后的 UI 消息(一条用户输入 / 一条 assistant 回复 / 一个 compact 节点)。
 *
 * compact 节点(`role:"compact"`):
 * - `kind:"boundary"`:`system compact_boundary` 事件归并的边界分隔线(显示「已压缩 pre→post tokens(pct)」)。
 * - `kind:"summary"`:`compact_boundary` 后紧跟的 user 消息(claude 把压缩总结作为新起点),归并成
 *   带 text block 的 summary 消息(MdPreview 渲染,assistant 风格 violet)。由 `expectingCompactSummary` 驱动。
 */
export type ClaudeMessage = {
  /** 消息 id:user 消息用自生成 id;assistant 用 claude 的 message.id;compact 用自生成 id。 */
  id: string;
  role: "user" | "assistant" | "compact" | "notice";
  /** compact 节点的子类型(boundary=边界分隔线 / summary=压缩总结)。非 compact 节点无此字段。 */
  compactKind?: "boundary" | "summary";
  /** compact boundary 的压缩比信息(仅 kind:"boundary" 有)。 */
  compactMeta?: CompactMeta;
  /** notice 节点的载荷(仅 role:"notice" 有):后台任务完成/失败/停止、历史回填等系统级轻提示。 */
  notice?: {
    kind: "bg_done" | "bg_failed" | "bg_stopped" | "history_resumed";
    summary: string;
    /** history_resumed 专用:回填元信息(条数/是否截断/是否失败)。summary 留空,文案由
     *  ClaudePane 渲染时按 history 字段 i18n 本地化(transport 层无 i18n 上下文)。 */
    history?: { count: number; truncated: boolean; failed: boolean };
  };
  blocks: ClaudeBlock[];
  timestamp: string | null;
  model?: string;
  /** 该消息是否仍在流式中(assistant 收到对应 result 前为 true)。 */
  streaming: boolean;
  /** assistant 消息的 token 用量(从 message.usage 提取,用于行尾 token 显示)。 */
  usage?: ClaudeUsage;
  /** 本轮耗时(result 事件回填,assistant 末行显示 ⏱ 时长)。 */
  durationMs?: number;
};

export type ClaudeBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      inputBrief: string;
      /** 原始 input(展开详情用)。 */
      input: unknown;
      /** 配对的工具结果(null=尚未返回)。 */
      result: ClaudeToolResult | null;
      status: "pending" | "running" | "done" | "error";
    };

export type ClaudeToolResult = {
  content: string;
  isError: boolean;
};

/** 会话运行状态(状态栏 + 输入框可用性依据)。 */
export type ClaudeRunStatus = "idle" | "thinking" | "running" | "done" | "error";

/** applyEvent 的累积状态。 */
export type ClaudeStreamState = {
  messages: ClaudeMessage[];
  /** message.id → messages 索引(同 id 的 assistant 事件覆盖最新快照)。 */
  messageIndex: Map<string, number>;
  /** tool_use id → {msgIdx, blockIdx}(配对 tool_result 回填用)。 */
  toolUseIndex: Map<string, { msgIdx: number; blockIdx: number }>;
  status: ClaudeRunStatus;
  meta: { model?: string; cwd?: string; claudeSessionId?: string; slashCommands?: string[]; contextWindow?: number; effort?: string };
  lastResult?: {
    success: boolean;
    durationMs: number;
    numTurns: number;
    totalCostUsd: number;
    error: string | null;
  };
  /** 上一轮是否被中断/异常(terminated)。前端据此提示。 */
  terminatedReason: string | null;
  /** 正在执行 /compact(`system status=compacting` 期间)。前端显「正在压缩…」+ busy 拒绝发新消息。 */
  compactRunning: boolean;
  /** compact 失败原因(`compact_status result=failed` 的 error)。null=无失败。 */
  compactError: string | null;
  /** compact_boundary 已到、等待紧跟的 user 总结消息。下一条 user(非 tool_result)归并成 summary 消息。 */
  expectingCompactSummary: boolean;
  /** 后台任务快照(`background_tasks_changed` 权威替换,[] = 无)。turn 结束后仍在跑的任务由此
   *  驱动「后台 ×N」状态;非轮次事件,不影响 status/busy。/clear 归零(initialState)。 */
  backgroundTasks: BackgroundTaskInfo[];
  /** API error 自动重试状态(非 null=重试中,含第几次/上限/下次重试时刻)。非 applyEvent 事件驱动,
   *  由 ClaudeTransport.scheduleRetry/cancelRetry 维护,emit 时覆写。null=不在重试。 */
  retry: { attempt: number; maxAttempts: number; nextRetryAt: number } | null;
};

export const initialClaudeState: ClaudeStreamState = {
  messages: [],
  messageIndex: new Map(),
  toolUseIndex: new Map(),
  status: "idle",
  meta: {},
  terminatedReason: null,
  compactRunning: false,
  compactError: null,
  expectingCompactSummary: false,
  backgroundTasks: [],
  retry: null,
};

/** 把 tool_result 的 content(可能是 string / block 数组)压成展示用字符串,截断防超长。 */
function flattenToolResultContent(content: string | unknown): string {
  if (typeof content === "string") return content.slice(0, 4000);
  if (Array.isArray(content)) {
    // content 可能是 [{type:"text",text}] / [{type:"image",...}] 混合,取 text 拼接。
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        } else if (block.type === "image") {
          parts.push("[image]");
        }
      }
    }
    return parts.join("\n").slice(0, 4000);
  }
  try {
    return JSON.stringify(content).slice(0, 4000);
  } catch {
    return String(content).slice(0, 4000);
  }
}

/** 把 tool_use input 压成展示用 brief(截断)。 */
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

/** 生成简易 id(非加密,仅前端去重用)。 */
function genId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/**
 * 把 blocks 里仍 pending/running 的 tool_use 标记为 done(停止 spinner)。
 *
 * 轮次结束(result)/进程终止(terminated)时调用:此时不会再有 tool_result 回填,仍 pending 的
 * tool_use(tool_use_id 不匹配/事件丢失/中断)若不兜底会永久转圈。保留 result=null(UI 显空/未返回),
 * 仅切 status 让 spinner 停。无 pending 时原样返回(避免无谓新对象,不破坏不可变引用相等)。
 */
function finalizePendingTools(blocks: ClaudeBlock[]): ClaudeBlock[] {
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

/**
 * 合并同 message.id 的 assistant blocks(增量归并)。
 *
 * claude/glm stream-json 对同一条 assistant 消息是**逐 block 增量推送**的:每个 assistant 事件的
 * `content` 只含「新完成的那个 block」(实测顺序 thinking → text → tool_use…),共用同一 message.id。
 * 官方 CLI 与 glm 代理皆然(写盘的 jsonl 历史也是一行一个 block)。因此不能用新快照整体替换旧
 * blocks——那会丢掉先到的 thinking 块(「思考输出缺失」的根因)。按稳定 key 增量合并:
 * - tool_use 按 id 匹配:同 id 已存在则更新 input/name,保留已回填的 result/status;
 * - thinking:一轮通常一个,已存在则替换(带 signature 的完整块,可能重投);
 * - text:追加为新块(每个 text 事件是一段完整正文)。
 */
function mergeAssistantBlocks(oldBlocks: ClaudeBlock[], newBlocks: ClaudeBlock[]): ClaudeBlock[] {
  const merged = [...oldBlocks];
  for (const nb of newBlocks) {
    if (nb.type === "tool_use") {
      const idx = merged.findIndex((b) => b.type === "tool_use" && b.id === nb.id);
      if (idx >= 0) {
        const ob = merged[idx] as Extract<ClaudeBlock, { type: "tool_use" }>;
        merged[idx] = {
          ...nb,
          // 增量推送的 tool_use 块不带 result;已回填的结果/状态不能被新块的 null 覆盖。
          result: ob.result ?? nb.result,
          status: ob.result ? ob.status : nb.status,
        };
        continue;
      }
      merged.push(nb);
      continue;
    }
    if (nb.type === "thinking") {
      // 同一轮 thinking 块通常只有一个;已存在则替换(带 signature 的完整块)。
      const idx = merged.findIndex((b) => b.type === "thinking");
      if (idx >= 0) {
        merged[idx] = nb;
        continue;
      }
      merged.push(nb);
      continue;
    }
    // text 块:追加。
    merged.push(nb);
  }
  return merged;
}

/**
 * 纯函数:把一个事件 payload 归并进 state,返回新 state(不可变更新)。
 *
 * 归并规则:
 * - init:记 meta,清 terminatedReason,status=running(会话开始)。
 * - assistant:按 message.id 归并——messageIndex 无则追加;有则**增量合并 blocks**(mergeAssistantBlocks)。
 *   同 id 的 assistant 事件逐 block 增量到达(thinking → text → tool_use),每个事件只带新 block,
 *   按 tool_use id / thinking / text 追加合并,而非整体替换(否则先到的 thinking 被后到的 text 覆盖)。
 *   遍历合并后的 blocks 建 toolUseIndex。status=running。
 * - user:若 content 含 tool_result → 用 toolUseIndex 找对应 tool_use 回填 result + status=done/error;
 *   若是用户输入文本 → 追加 user 消息(stream-json 一般不回显用户输入,此分支少触发)。
 * - thinking:status=thinking。后端 thinking_tokens 是纯计数心跳(text 空,仅驱动状态);真实思考
 *   内容随 assistant 的 thinking block 到达。仅当 payload 带非空文本时累积到最近 assistant 消息。
 * - result:status=done/error,把最近 assistant 消息置 streaming=false,记 lastResult。
 * - terminated:status=error,记 terminatedReason,最近 assistant 消息 streaming=false。
 */
export function applyEvent(state: ClaudeStreamState, payload: ClaudeEventPayload): ClaudeStreamState {
  // 浅拷贝顶层 + messages(Map/索引也要重建,保证不可变)。
  const next: ClaudeStreamState = {
    ...state,
    messages: [...state.messages],
    messageIndex: new Map(state.messageIndex),
    toolUseIndex: new Map(state.toolUseIndex),
    meta: { ...state.meta },
  };

  switch (payload.kind) {
    case "init": {
      // 仅真正首启(此前无 session id,含 /clear 后的 meta 重置)才置 running。
      // 后台任务全部完成后 claude 会再推一个 init(同 session_id,实测),无条件置 running 会把
      // 空闲会话误判 busy 卡死。非首启路径的 running 语义由各调用方保证:发消息/批准由
      // appendUserMessage 乐观置 running;mode/effort 重启后轮次在途同理;打开 tab 握手由
      // transport.starting 覆写回 idle;resumeSession 切历史会话本就无在途轮(置 running 反而
      // 是 busy 卡死的 bug,此处顺带修正)。
      const firstInit = !next.meta.claudeSessionId;
      next.meta = {
        ...next.meta,
        model: payload.model || next.meta.model,
        cwd: payload.cwd || next.meta.cwd,
        claudeSessionId: payload.claudeSessionId || next.meta.claudeSessionId,
        slashCommands: payload.slashCommands ?? next.meta.slashCommands ?? [],
      };
      next.terminatedReason = null;
      if (firstInit) next.status = "running";
      return next;
    }
    case "assistant": {
      next.status = "running";
      next.terminatedReason = null;
      const msg = payload.message;
      // 真实 assistant 消息的 model 回填 meta.model(每轮校正):setModel 乐观更新 meta.model 后,
      // 下一轮真实 assistant 事件把实际跑的 model 写回 meta.model--切换成功则落到新值,失败则自动
      // 纠正回旧值。synthetic 消息(model="<synthetic>",已被 transport settingModel flag 吞掉)跳过。
      const realModel = typeof msg.model === "string" && msg.model && msg.model !== "<synthetic>" ? msg.model : null;
      if (realModel) next.meta = { ...next.meta, model: realModel };
      const msgId = msg.id ?? genId("assistant");
      const existing = next.messageIndex.get(msgId);
      const blocks: ClaudeBlock[] = msg.content.map((b): ClaudeBlock => {
        if (b.type === "text") return { type: "text", text: b.text };
        if (b.type === "thinking") return { type: "thinking", text: b.thinking };
        if (b.type === "tool_use") {
          return {
            type: "tool_use",
            id: b.id,
            name: b.name,
            inputBrief: briefInput(b.input),
            input: b.input,
            result: null,
            status: "pending",
          };
        }
        // tool_result 不出现在 assistant 消息里(它在 user 消息);兜底跳过。
        return { type: "text", text: "" };
      });
      // 增量合并:同 message.id 的后续事件只带新 block(thinking/text/tool_use 逐块到达),
      // 用 mergeAssistantBlocks 追加合并而非整体替换(否则先到的 thinking 会被后到的 text 覆盖)。
      // tool_use 已回填的 result/status 由合并函数保留。
      if (existing !== undefined) {
        const oldMsg = next.messages[existing];
        const merged = mergeAssistantBlocks(oldMsg.blocks, blocks);
        next.messages[existing] = {
          id: msgId,
          role: "assistant",
          blocks: merged,
          timestamp: oldMsg.timestamp,
          model: msg.model ?? oldMsg.model,
          streaming: true,
          usage: hasUsage(msg.usage) ? msg.usage : (oldMsg.usage ?? msg.usage),
        };
      } else {
        next.messages.push({
          id: msgId,
          role: "assistant",
          blocks,
          timestamp: new Date().toISOString(),
          model: msg.model,
          streaming: true,
          usage: msg.usage,
        });
        next.messageIndex.set(msgId, next.messages.length - 1);
      }
      // 重建 toolUseIndex(以最新 blocks 为准)。
      const idx = next.messageIndex.get(msgId)!;
      const cur = next.messages[idx];
      cur.blocks.forEach((b, blockIdx) => {
        if (b.type === "tool_use") {
          next.toolUseIndex.set(b.id, { msgIdx: idx, blockIdx });
        }
      });
      return next;
    }
    case "user": {
      // user 消息通常含 tool_result(claude 把工具结果包在 user role 里)。
      // compact summary 的 user message.content 可能是裸 string(claude 把压缩总结作为新起点的
      // user 消息,content 直接是总结文本而非 block 数组),先归一化成 block 数组。
      const msg = payload.message;
      const rawContent = msg.content;
      const normalizedContent: ClaudeRawBlock[] = Array.isArray(rawContent)
        ? rawContent
        : typeof rawContent === "string"
          ? [{ type: "text", text: rawContent }]
          : [];

      // compact_boundary 后等总结:若处于 expectingCompactSummary 且本条 user 不含 tool_result,
      // 归一化 content 为 text → push role:"compact" kind:"summary" 消息(压缩总结卡片)。
      const hasToolResult = normalizedContent.some((b) => b.type === "tool_result");
      if (next.expectingCompactSummary && !hasToolResult) {
        const summaryText = normalizedContent
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("\n")
          .trim();
        if (summaryText) {
          const id = genId("compact-summary");
          next.messages.push({
            id,
            role: "compact",
            compactKind: "summary",
            blocks: [{ type: "text", text: summaryText }],
            timestamp: new Date().toISOString(),
            streaming: false,
          });
          next.messageIndex.set(id, next.messages.length - 1);
        }
        next.expectingCompactSummary = false;
        return next;
      }

      const toolResults = normalizedContent.filter((b) => b.type === "tool_result") as Extract<
        ClaudeRawBlock,
        { type: "tool_result" }
      >[];
      if (toolResults.length > 0) {
        // 精确配对:tool_use_id → toolUseIndex(正常路径,claude 官方 id 一致)。
        const matched = new Set<number>(); // 已配对的 toolResult 索引
        for (let ti = 0; ti < toolResults.length; ti++) {
          const tr = toolResults[ti];
          const pos = next.toolUseIndex.get(tr.tool_use_id);
          if (!pos) {
            // 诊断:glm 代理等可能改 tool_use id 导致精确配对失败。打印让根因可见
            // (顺序兜底会停 spinner,但 id 不匹配的根源需另查 transport/后端归并)。
            console.warn("[claudeStream] tool_result 精确配对失败:tool_use_id 不在 index", {
              tool_use_id: tr.tool_use_id,
              knownIds: [...next.toolUseIndex.keys()],
            });
            continue;
          }
          const target = next.messages[pos.msgIdx];
          const block = target?.blocks[pos.blockIdx];
          if (block && block.type === "tool_use") {
            const isError = tr.is_error === true;
            target.blocks[pos.blockIdx] = {
              ...block,
              result: { content: flattenToolResultContent(tr.content), isError },
              status: isError ? "error" : "done",
            };
            matched.add(ti);
          }
        }
        // 顺序兜底:仍未配对的 tool_result → 回填到「最近 assistant 消息里第一个仍 pending 的 tool_use」。
        // 场景:精确配对失败(id 不匹配)时 tool_result 内容已到、命令已执行完,但 block.result=null、
        // status=running → spinner 永转(直到轮末 result 兜底,而这轮可能卡住需手动中断)。按 pending 顺序
        // 回填让 spinner 在结果到达即停 + 显 output。claude 一般串行执行工具,顺序对应安全;并发多工具
        // 稀有场景下可能错配内容到相邻卡片(轻微),但停 spinner + 显 output 优先于精确性。
        for (let i = next.messages.length - 1; i >= 0 && matched.size < toolResults.length; i--) {
          if (next.messages[i].role !== "assistant") continue;
          const m = next.messages[i];
          for (let bi = 0; bi < m.blocks.length && matched.size < toolResults.length; bi++) {
            const b = m.blocks[bi];
            if (b.type !== "tool_use" || b.status === "done" || b.status === "error" || b.result) continue;
            let ti = 0;
            while (ti < toolResults.length && matched.has(ti)) ti++;
            if (ti >= toolResults.length) break;
            const tr = toolResults[ti];
            const isError = tr.is_error === true;
            m.blocks[bi] = {
              ...b,
              result: { content: flattenToolResultContent(tr.content), isError },
              status: isError ? "error" : "done",
            };
            matched.add(ti);
          }
        }
        // tool_result 不改 state.status(claude 可能继续处理)。
        return next;
      }
      // 纯用户文本(stream-json 一般不回显,兜底):追加 user 消息。
      const textParts = normalizedContent
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text);
      if (textParts.length > 0) {
        const id = msg.id ?? genId("user");
        next.messages.push({
          id,
          role: "user",
          blocks: textParts.map((t) => ({ type: "text", text: t })),
          timestamp: new Date().toISOString(),
          streaming: false,
        });
        next.messageIndex.set(id, next.messages.length - 1);
      }
      return next;
    }
    case "thinking": {
      next.status = "thinking";
      // 后端 thinking_tokens 是纯计数心跳(text 恒空),真实思考内容随 assistant 的 thinking block
      // 到达(经 assistant 分支 mergeAssistantBlocks 合并)。仅当 payload 带非空文本时才累积到
      // 最近 assistant 消息的 thinking block,防空心跳污染已合并的真实思考。
      if (!payload.text) return next;
      for (let i = next.messages.length - 1; i >= 0; i--) {
        if (next.messages[i].role === "assistant") {
          const m = next.messages[i];
          const lastBlock = m.blocks[m.blocks.length - 1];
          if (lastBlock && lastBlock.type === "thinking") {
            m.blocks[m.blocks.length - 1] = {
              ...lastBlock,
              text: lastBlock.text + payload.text,
            };
          } else {
            m.blocks = [...m.blocks, { type: "thinking", text: payload.text }];
          }
          break;
        }
      }
      return next;
    }
    case "result": {
      next.status = payload.success ? "done" : "error";
      next.lastResult = {
        success: payload.success,
        durationMs: payload.durationMs ?? 0,
        numTurns: payload.numTurns ?? 0,
        // totalCostUsd 可能缺(claude headless 某些 result 不含 cost),兜底 0 防 toFixed 崩。
        totalCostUsd: typeof payload.totalCostUsd === "number" ? payload.totalCostUsd : 0,
        error: payload.error ?? null,
      };
      // 记录上下文窗口上限(glm result.modelUsage.<model>.contextWindow,200k 或 1m),供 ctx 显示 + 占用百分比。
      if (payload.contextWindow) {
        next.meta = { ...next.meta, contextWindow: payload.contextWindow };
      }
      // 全量扫兜底:轮次结束,所有 assistant 消息里仍 pending/running 的 tool_use 都不会再有
      // tool_result 回填(glm 改 id/事件时序/快照重置等),标记 done 停 spinner。**不能只扫最后
      // 一条**:同轮多条 assistant 消息(工具在前面、文本总结在后面)时,孤儿 tool_use 在非末条
      // 消息里,只扫末条会跨轮永久转圈。finalizePendingTools 无 pending 时返回原引用,零成本。
      for (let i = 0; i < next.messages.length; i++) {
        const m = next.messages[i];
        if (m.role !== "assistant") continue;
        next.messages[i] = { ...m, blocks: finalizePendingTools(m.blocks) };
      }
      // 最近 assistant 消息置 streaming=false + 回填本轮真实用量:glm 代理把 token 用量放在
      // result.usage(assistant message.usage 流式时恒为 0),回填让 ctx/sessionTokens/行尾 token 取到真实值。
      // 不限 streaming:result 是轮末事件,最近 assistant 即本轮;resume 重发已在 assistant 分支用
      // hasUsage 保护,不会被这里的 0 值覆盖。
      for (let i = next.messages.length - 1; i >= 0; i--) {
        if (next.messages[i].role === "assistant") {
          const prev = next.messages[i];
          next.messages[i] = {
            ...prev,
            streaming: false,
            usage: payload.usage ?? prev.usage,
            // 回填本轮耗时(assistant 末行显示 ⏱)。durationMs 仅 result 有,流式中不显示。
            durationMs: payload.durationMs ?? prev.durationMs,
          };
          break;
        }
      }
      return next;
    }
    case "terminated": {
      // interrupted(用户中断/主动重启换 mode/批准重启):非异常,置 idle 不显错误,下次 send 自动 --resume 续接。
      // eof/spawn failed:真异常,置 error + terminatedReason,最近 assistant 消息 streaming=false。
      if (payload.reason === "interrupted") {
        next.status = "idle";
        next.terminatedReason = null;
        next.compactRunning = false;
        // 被中断的轮 assistant 可能还在 streaming,置 false 避免永久转圈。
        // 同时兜底:全部 assistant 消息里仍 pending 的 tool_use 标记 done(中断后不会再有
        // tool_result,且孤儿 tool_use 可能不在末条消息,只扫末条会跨轮转圈),停止 spinner。
        for (let i = 0; i < next.messages.length; i++) {
          const m = next.messages[i];
          if (m.role !== "assistant") continue;
          next.messages[i] = { ...m, blocks: finalizePendingTools(m.blocks), streaming: false };
        }
        return next;
      }
      next.status = "error";
      next.terminatedReason = payload.reason;
      next.compactRunning = false;
      // 兜底:全部 assistant 消息仍 pending 的 tool_use 标记 done(进程终止后不会再有 tool_result;
      // 孤儿 tool_use 可能不在末条消息,只扫末条会跨轮转圈),停止 spinner。
      for (let i = 0; i < next.messages.length; i++) {
        const m = next.messages[i];
        if (m.role !== "assistant") continue;
        next.messages[i] = { ...m, blocks: finalizePendingTools(m.blocks), streaming: false };
      }
      return next;
    }
    case "compact_status": {
      // compact 状态进度:status="compacting" 开始(busy);result="success"|"failed" 结束。
      if (payload.status === "compacting") {
        next.compactRunning = true;
        next.compactError = null;
      }
      if (payload.result === "failed") {
        next.compactRunning = false;
        next.compactError = payload.error ?? "compact failed";
      } else if (payload.result === "success") {
        next.compactRunning = false;
        next.compactError = null;
        // success 后紧跟 compact_boundary + user 总结(boundary 设 expectingCompactSummary 兜底,
        // 此处也设防 boundary 缺失时直接吃总结)。
        next.expectingCompactSummary = true;
      }
      // compact 进行中算 busy,但不改 status(避免与 running/thinking 冲突);前端用 compactRunning 单独判。
      return next;
    }
    case "compact_boundary": {
      // compact 成功边界:push 一条 boundary 分隔线消息(带压缩比),并标记等总结。
      const m = payload.metadata;
      const pre = typeof m.pre_tokens === "number" ? m.pre_tokens : undefined;
      const post = typeof m.post_tokens === "number" ? m.post_tokens : undefined;
      const pct = pre && post && pre > 0 ? Math.round((1 - post / pre) * 100) : undefined;
      const id = genId("compact-boundary");
      next.messages.push({
        id,
        role: "compact",
        compactKind: "boundary",
        compactMeta: { preTokens: pre, postTokens: post, pct, durationMs: m.duration_ms },
        blocks: [],
        timestamp: new Date().toISOString(),
        streaming: false,
      });
      next.messageIndex.set(id, next.messages.length - 1);
      next.compactRunning = false;
      next.compactError = null;
      next.expectingCompactSummary = true;
      return next;
    }
    case "background_tasks_changed": {
      // 后台任务快照:权威替换(任务启动/完成/变化时推,含 result 之后的空闲期)。
      // 非轮次事件:不动 status(空闲期照旧 idle,「后台 ×N」由 summarize 单独判),不追加消息。
      // 内容相等时原样返回(保持引用稳定,避免无谓重渲染)。
      const same =
        next.backgroundTasks.length === payload.tasks.length &&
        next.backgroundTasks.every(
          (t, i) =>
            t.taskId === payload.tasks[i].taskId &&
            t.taskType === payload.tasks[i].taskType &&
            t.description === payload.tasks[i].description,
        );
      if (same) return state;
      next.backgroundTasks = payload.tasks;
      return next;
    }
    case "task_notification": {
      // 后台任务完成/失败/停止通知:在消息流末尾插入轻量 notice 提示(绿勾/红叉/琥珀方块居中行)。
      // 幂等:确定性 id `notice:<taskId>:<status>` + messageIndex 查重,同 (taskId, status) 只插
      // 一次(claude 偶发重推);其余 status(未知/中间态)忽略。
      if (payload.status !== "completed" && payload.status !== "failed" && payload.status !== "stopped") {
        return state;
      }
      const noticeId = `notice:${payload.taskId}:${payload.status}`;
      if (next.messageIndex.has(noticeId)) return state;
      next.messages.push({
        id: noticeId,
        role: "notice",
        notice: {
          kind:
            payload.status === "completed"
              ? "bg_done"
              : payload.status === "failed"
                ? "bg_failed"
                : "bg_stopped",
          summary: payload.summary,
        },
        blocks: [],
        timestamp: new Date().toISOString(),
        streaming: false,
      });
      next.messageIndex.set(noticeId, next.messages.length - 1);
      return next;
    }
    default: {
      // 兜底:未知 kind 不改 state。
      return next;
    }
  }
}

/**
 * 恢复会话的历史回填:把 `read_claude_history_events` 读出的事件序列(glm 代理 `--resume`
 * 不重放历史的兜底,事件与实时流同构)批量归并进 state,末尾插 history_resumed notice。
 *
 * 与直接循环 applyEvent 的关键差异:
 * - **收尾强制 status=idle / 清 terminatedReason**:applyEvent 的 assistant case 无条件置
 *   running(「轮次进行中」语义),历史注入是静态回放非在途轮,不复位会 busy 卡死(不能发消息)。
 * - **streaming 收尾置 false**:jsonl 里的 assistant 消息是完整快照,没有后续 result 事件配对,
 *   不清会永远转圈。
 * - notice 幂等(确定性 id):↻ 反复切换会话时 state 已被 backfill 前置重置,同 id 不叠加。
 */
export function applyHistoryEvents(
  state: ClaudeStreamState,
  payloads: ClaudeEventPayload[],
  history: { count: number; truncated: boolean; failed: boolean },
): ClaudeStreamState {
  let next = state;
  for (const p of payloads) next = applyEvent(next, p);
  next = {
    ...next,
    status: "idle",
    terminatedReason: null,
    messages: next.messages.map((m) => ({ ...m, streaming: false })),
  };
  const noticeId = "notice:history_resumed";
  if (!next.messageIndex.has(noticeId)) {
    const messages = [...next.messages];
    const messageIndex = new Map(next.messageIndex);
    messages.push({
      id: noticeId,
      role: "notice",
      notice: { kind: "history_resumed", summary: "", history },
      blocks: [],
      timestamp: new Date().toISOString(),
      streaming: false,
    });
    messageIndex.set(noticeId, messages.length - 1);
    next = { ...next, messages, messageIndex };
  }
  return next;
}

/**
 * 批准本地执行的工具块 UI 反馈:原地 patch tool_use block 的 status/result。批准被拒工具后
 * txuyStudio 本地执行该工具、结果经 stdin tool_result 回传给 claude(见 ClaudeTransport.
 * approveToolRun)--这条路径**不走 applyEvent 事件流**,UI 侧由本函数显式更新(执行中
 * running/完成后回填结果摘要),否则工具卡停留在旧 denied 药丸误导用户。
 */
export function patchToolBlock(
  state: ClaudeStreamState,
  toolUseId: string,
  patch: { status: "running" | "done" | "error"; resultContent: string | null },
): ClaudeStreamState {
  const loc = state.toolUseIndex.get(toolUseId);
  if (!loc) return state;
  const target = state.messages[loc.msgIdx];
  const block = target.blocks[loc.blockIdx];
  if (block.type !== "tool_use") return state;
  const messages = [...state.messages];
  const blocks = [...target.blocks];
  blocks[loc.blockIdx] = {
    ...block,
    status: patch.status,
    result: patch.resultContent != null
      ? { content: patch.resultContent, isError: patch.status === "error" }
      : block.result,
  };
  messages[loc.msgIdx] = { ...target, blocks };
  return { ...state, messages };
}

/**
 * 乐观插入用户消息(send 时调用,不等后端)。返回新 state。
 * stream-json 模式下 claude 不回显用户输入,故前端自己插一条 user 消息保证可见。
 * 用户主动发新消息 → 清 compactRunning/expectingCompactSummary(新轮开始,旧 compact 状态不应残留)。
 */
export function appendUserMessage(state: ClaudeStreamState, text: string): ClaudeStreamState {
  const id = genId("user");
  const next: ClaudeStreamState = {
    ...state,
    messages: [...state.messages, { id, role: "user", blocks: [{ type: "text", text }], timestamp: new Date().toISOString(), streaming: false }],
    messageIndex: new Map(state.messageIndex),
    toolUseIndex: new Map(state.toolUseIndex),
    meta: { ...state.meta },
    status: "running",
    terminatedReason: null,
    compactRunning: false,
    expectingCompactSummary: false,
  };
  next.messageIndex.set(id, next.messages.length - 1);
  return next;
}

// -- 对外汇总语义(状态栏 + tab chip 共用) --

/** 对外汇总的会话语义态。优先级从高到低:error > retrying > waiting > running > bg > idle。 */
export type ClaudeSessionKind = "error" | "retrying" | "waiting" | "running" | "bg" | "idle";

/** 对外汇总的会话状态(状态栏 + tab chip 共用)。与 `ClaudeRunStatus`(applyEvent 内部状态机)区分:
 *  这里是面向 UI 的「这个 tab 现在处于什么语义态」,把散落的 status/compactRunning/retry/
 *  hasPendingPlan/hasPendingApproval 收敛成单一值,供 StatusBar 跨 tab 汇总与 tab chip 状态点复用。 */
export type ClaudeSessionSummary = {
  kind: ClaudeSessionKind;
  /** 是否处于活跃态(占资源/需关注),用于 StatusBar 计数。running/retrying/waiting/bg 为 true。 */
  active: boolean;
  /** 后台任务运行数(仅 kind:"bg" 有值)。AI 本轮空闲、可继续对话,但有 N 个后台任务在跑。 */
  bgTasks?: number;
  /** 上下文占用%(0-100,取最近 assistant usage / contextWindow)。无 usage 时 undefined。 */
  ctxPct?: number;
  /** 当前会话 model(init/前端切换回填)。供 StatusBar 聚焦 tab 显示。 */
  model?: string;
  /** 当前 effort(用户期望值,乐观回填 meta.effort)。undefined=auto(不传 --effort)。供 StatusBar 切换。 */
  effort?: string;
};

/**
 * 是否有待决策的计划:最后一条 assistant 消息的末块是 exit_plan_mode。
 * 批准/拒绝后会追加 user 消息 -> 末消息变 user -> false,自然反映「已处理」(暂停解除)。
 *
 * 从 ClaudePane 提纯为纯函数,ClaudePane 与 summarize 共用(单一真相源)。
 */
export function hasPendingPlan(state: ClaudeStreamState): boolean {
  if (state.messages.length === 0) return false;
  const last = state.messages[state.messages.length - 1];
  if (last.role !== "assistant") return false;
  const lastBlock = last.blocks[last.blocks.length - 1];
  return (
    !!lastBlock &&
    lastBlock.type === "tool_use" &&
    (lastBlock.name === "exit_plan_mode" || lastBlock.name === "ExitPlanMode")
  );
}

/**
 * 是否有待批准的敏感操作:最近一条 assistant 消息里有「需审批被拒」且未 resolved 的 tool_use。
 * 批准/拒绝后 block.id 进 resolvedApprovals -> 该 block 不再计入 -> 状态栏提示解除。
 *
 * 从 ClaudePane 提纯为纯函数。resolvedApprovals 是 ClaudePane 组件级 Set(批准/拒绝后更新),
 * 作为参数传入;summarize 在 registry/StatusBar 路径(无组件态)传 undefined -> 跳过此判定。
 */
export function hasPendingApproval(state: ClaudeStreamState, resolvedApprovals?: Set<string>): boolean {
  if (state.messages.length === 0) return false;
  const last = state.messages[state.messages.length - 1];
  if (last.role !== "assistant") return false;
  return last.blocks.some(
    (b) =>
      b.type === "tool_use" &&
      isPermissionDenied(b) &&
      !(resolvedApprovals ?? EMPTY_SET).has(b.id),
  );
}
const EMPTY_SET: Set<string> = new Set();

/**
 * 把 ClaudeStreamState 归并成对外汇总语义。优先级:error > retrying > waiting > running > bg > idle。
 *  - error:status=error(进程异常/崩溃,非 interrupted--interrupted 在 applyEvent 已置 idle)。
 *  - retrying:state.retry 非空(API error 自动重试中,橙,最高优先异常,盖住 running)。
 *  - waiting:hasPendingPlan || hasPendingApproval(需用户确认,紫)。
 *  - running:busy(status running/thinking)|| compactRunning || shellRunning(正在干活,cyan)。
 *  - bg:backgroundTasks.length > 0(本轮已结束、可对话,但有后台任务在跑,琥珀;busy 时被 running
 *    盖住,turn 结束后透出)。附 bgTasks 计数。
 *  - idle:其余(done 后 idle / 未启动)。
 *
 * @param shellRunning `!` 命令是否在跑(同 tab 的 ShellRunTransport 状态)。tab chip 传(true 算 running);
 *   StatusBar 汇总不传(shell 是用户主动命令非 AI 会话,不计入 AI 会话活跃态)。
 * @param resolvedApprovals 已批准/拒绝的 tool_use id 集合(ClaudePane 组件态)。registry 路径不传 ->
 *   跳过 hasPendingApproval 判定(只看 hasPendingPlan)。
 */

/** 默认上下文窗口上限(未到 result 事件前兜底;与 ClaudePane 的 CONTEXT_WINDOW 一致)。 */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * 按 model 名推断上下文窗口上限(兜底):claude CLI 只对内置认识的官方 model 在
 * result.modelUsage 填 contextWindow;代理类自定义 model(如 "GLM-5.2[1m]")claude CLI 不认识 →
 * 事件里拿不到真实上限(回退默认 200k)。但这类代理常在 model 名后缀标注窗口,如 "[1m]"/"[200k]",
 * 此处解析该后缀自动还原真实容量,使 ctx 上限/占用百分比反映真实窗口(而非恒 200k)。
 *
 * 优先级(调用方):state.meta.contextWindow(result 真实值)> inferContextWindow(model)> 默认 200k。
 */
export function inferContextWindow(model?: string): number {
  if (model) {
    // 匹配 "[1m]" / "[200k]" / "[1.5m]" 等后缀(k=千、m=百万),大小写不敏感。
    const m = model.match(/\[(\d+(?:\.\d+)?)\s*([km])\]/i);
    if (m) {
      const n = parseFloat(m[1]);
      return m[2].toLowerCase() === "m" ? Math.round(n * 1_000_000) : Math.round(n * 1_000);
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 当前上下文占用%(0-100):取最近一条 assistant message 的 usage
 * (input_tokens + cache_creation_input_tokens + cache_read_input_tokens ≈ 当前上下文占用)
 * / contextWindow。无 usage 或全 0 返回 undefined。复用 ClaudePane 的 contextInfo 逻辑(单一真相源)。
 */
function computeCtxPct(state: ClaudeStreamState): number | undefined {
  const window = state.meta?.contextWindow ?? inferContextWindow(state.meta?.model);
  let usage: ClaudeUsage | undefined;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role === "assistant" && m.usage) {
      usage = m.usage;
      break;
    }
  }
  if (!usage) return undefined;
  const ctx =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  if (ctx <= 0) return undefined;
  return Math.min(100, (ctx / window) * 100);
}

export function summarize(
  state: ClaudeStreamState,
  shellRunning?: boolean,
  resolvedApprovals?: Set<string>,
): ClaudeSessionSummary {
  // 上下文占用/effort/model 与语义态正交,各分支均带(状态变 error 时 ctx% 不消失)。
  const ctxPct = computeCtxPct(state);
  const extra = { ctxPct, model: state.meta.model, effort: state.meta.effort };

  if (state.status === "error") return { kind: "error", active: false, ...extra };
  if (state.retry) return { kind: "retrying", active: true, ...extra };
  if (hasPendingPlan(state) || hasPendingApproval(state, resolvedApprovals)) {
    return { kind: "waiting", active: true, ...extra };
  }
  const busy = state.status === "running" || state.status === "thinking";
  if (busy || state.compactRunning || shellRunning) {
    return { kind: "running", active: true, ...extra };
  }
  if (state.backgroundTasks.length > 0) {
    return { kind: "bg", active: true, bgTasks: state.backgroundTasks.length, ...extra };
  }
  return { kind: "idle", active: false, ...extra };
}
