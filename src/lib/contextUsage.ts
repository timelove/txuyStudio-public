// BaoCode 借鉴 — 单条 assistant 消息的 context 占用统计(纯函数)
//
// 借鉴:BaoCode ContextUsagePanel 多色块进度条 + 拆分 used/cache_read/cache_creation
// (紫色=主输入, 黄色=cache creation 写入, 蓝色=cache read 命中, 绿色=free 剩余)。
// 我们这里 footer 太挤 → 简化为:迷你条 + 文本"Xk/Yk (Z%)" + hover tooltip 拆分明细。
//
// 计算:
//  - used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
//    (与现有 claudeInputTokens 一致;cache 命中仍占 window,但来源是 prompt cache)
//  - window = model 上下文窗口(200k/1m;init 时回填)
//  - pct = min(100, used / window * 100)

import type { ClaudeUsage } from "../domain/claudeStream";

/** 从 usage 派生 used tokens(主输入 + cache creation + cache read)。
 *  与现有 claudeInputTokens 同口径(本库不重复 import 避免循环)。 */
export function deriveContextUsed(usage: ClaudeUsage | undefined | null): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

export type ContextBreakdown = {
  input: number;
  cacheCreation: number;
  cacheRead: number;
};

/** 拆分各 cache 段(用于 hover tooltip)。 */
export function deriveContextBreakdown(usage: ClaudeUsage | undefined | null): ContextBreakdown {
  if (!usage) return { input: 0, cacheCreation: 0, cacheRead: 0 };
  return {
    input: usage.input_tokens ?? 0,
    cacheCreation: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  };
}

export type ContextUsageInfo = {
  used: number;
  window: number;
  /** autocompact 预留(min(33k, window);面板单独画一段,不算进 used)。 */
  buffer: number;
  /** 剩余可用 = usable − used(下限 0)。 */
  free: number;
  pct: number; // 0-100,cap 100 —— 分母是**可压缩前可用窗口**(window − buffer)
  breakdown: ContextBreakdown;
};

/**
 * autocompact 预留(借鉴 baocode ContextUsagePanel 的「Autocompact buffer」段,
 * 其 CLI mock 里 200k 窗口报 33k)。claude CLI 逼近窗口尾部会自动压缩,buffer 是
 * 给压缩结果留的余量 —— 这部分**不可用**,占用百分比按「可用窗口」= window − buffer
 * 计,而非画满整个窗口(此前分母用模型原始窗口,1m 模型下显示 50% 时实际可能已
 * 逼近压缩阈值)。真实值只有 control 协议 get_context_usage 能拿到(P2 spike);
 * 先按 baocode 同款 33k 建模。
 */
export const AUTOCOMPACT_BUFFER_TOKENS = 33_000;

/** 可用窗口 = window − buffer(下限 1 防 0 除;buffer 不超过窗口本身)。 */
export function usableContextWindow(window: number): number {
  return Math.max(1, window - Math.min(AUTOCOMPACT_BUFFER_TOKENS, window));
}

/** 派生单条消息的 context 占用信息。
 *  @param usage  该 message 的 token 用量
 *  @param window 模型 context window 容量(从 state.meta.contextWindow 或 inferContextWindow 来)
 *  @returns null 当 usage 缺失 / 无 token / window=0 */
export function deriveContextUsage(
  usage: ClaudeUsage | undefined | null,
  window: number,
): ContextUsageInfo | null {
  const used = deriveContextUsed(usage);
  if (used <= 0) return null;
  if (window <= 0) return null;
  const buffer = Math.min(AUTOCOMPACT_BUFFER_TOKENS, window);
  const usable = usableContextWindow(window);
  return {
    used,
    window,
    buffer,
    free: Math.max(0, usable - used),
    pct: Math.min(100, (used / usable) * 100),
    breakdown: deriveContextBreakdown(usage),
  };
}

/** tooltip 文案(i18n 透传 — 调用方传 t 函数)。
 *  格式:主输入 X · cache 写入 Y · cache 命中 Z(本轮 prompt 总 U) */
export function buildContextTooltip(
  info: ContextUsageInfo,
  formatTokens: (n: number) => string,
): string {
  const { input, cacheCreation, cacheRead } = info.breakdown;
  return [
    `${formatTokens(input)} main input`,
    cacheCreation > 0 ? `${formatTokens(cacheCreation)} cache write` : null,
    cacheRead > 0 ? `${formatTokens(cacheRead)} cache hit` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
