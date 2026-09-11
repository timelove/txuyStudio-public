/**
 * ctx 占比着色(ClaudePane/CodexPane 输入卡底部状态栏共用):
 * ≥95% 红(逼近上限,必须 /compact)、≥80% 橙(建议 /compact)、其余默认 muted 灰。
 * 阈值常量集中此处,两 pane 一致。
 */
export function contextTone(pct: number): string {
  if (pct >= 95) return "text-[var(--mx-danger-bright)]";
  if (pct >= 80) return "text-[var(--mx-warning)]";
  return "";
}

/** 窗口抬升档位粒度(50k 的整数倍,抬出来的数干净:400k/450k…)。 */
const LIFT_STEP_TOKENS = 50_000;

/**
 * 估算「当前上下文总输入」token,兼容两种 usage 字段语义(不同网关/事件源不一致):
 * - 官方 Anthropic 互斥语义:总输入 = input + cache_creation + cache_read(三段不重叠);
 * - 部分网关重叠语义:input_tokens 已含全部缓存(input=总量,cache_* 是其中子集)——
 *   直接相加会双倍(用户实测「ctx 超 1m」根因之一)。
 *
 * 判别:input ≥ 缓存段之和的 95% 视为重叠语义取 max(input, 缓存和)(≈总量);否则互斥
 * 语义取和。两种语义下均得真实总输入;全未命中(缓存和=0)时两种语义同值,均正确。
 *
 * 已知限制(行为用例验证):互斥语义下的冷启动轮(compact 后 cache 大面积失效、命中率
 * <51%)数值形态与重叠语义相同,会被判为重叠式而低估一轮(input 偏小侧)——下一轮 cache
 * 升温即恢复正确。对比旧公式在重叠语义下恒定双倍的误差,可接受。
 */
export function totalInputTokens(input: number, ...cacheParts: number[]): number {
  const cacheSum = cacheParts.reduce((a, b) => a + b, 0);
  if (cacheSum > 0 && input >= cacheSum * 0.95) return Math.max(input, cacheSum);
  return input + cacheSum;
}

/**
 * 动态抬升 ctx 窗口兜底:网关代理模型(如 glm-5.3)真实上下文窗口可能远超 200k 兜底
 * (实测本机会话输入到过 376k 仍正常跑),此时占比虚高一倍、剩余算出负数、占比恒 100%。
 * 实测 ctx 突破兜底窗口 → 抬到 ≥ ctx×1.02 的最小 50k 档(留 2% 余量防边界恒 100%);
 * 未突破原样返回。只升不降(会话内以峰值为准,compact 后回落不影响窗口)。
 * 轻微保守:真实窗口若比抬升值大(如 1m 窗口 ctx 370k → 抬到 400k),占比偏早进入
 * 橙红提示——提前 /compact 无害;反向(显示宽松实则快满)才是危险方向。
 */
export function liftContextWindow(fallback: number, peakCtx: number): number {
  if (peakCtx <= fallback) return fallback;
  return Math.ceil((peakCtx * 1.02) / LIFT_STEP_TOKENS) * LIFT_STEP_TOKENS;
}
