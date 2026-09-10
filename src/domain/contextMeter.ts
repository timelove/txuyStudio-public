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
