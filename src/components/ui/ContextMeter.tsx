import { contextTone } from "../../domain/contextMeter";

/** token 数格式化:<1k 原数、1k–1M 显 k、≥1M 显 m(与两 pane 的 formatTokens 同规格)。 */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${parseFloat((n / 1000).toFixed(1))}k`;
  return `${parseFloat((n / 1_000_000).toFixed(1))}m`;
}

/**
 * ctx 占用迷你仪表(ClaudePane/CodexPane 输入卡底栏共用):
 * 44px 进度条(直观占用,≥80% 橙 / ≥95% 红,否则 muted)+「已用 / 窗口」精确分数(自解释,
 * 无「剩」字、无需心算);hover title 显窗口/已用/剩余/百分比全量明细。
 * 字号继承父级(底栏 statusFontPx),组件自身不设字号。
 */
export function ContextMeter({ used, window }: { used: number; window: number }) {
  const ctx = Math.max(0, used);
  const pct = ctx > 0 ? Math.min(100, (ctx / window) * 100) : 0;
  const left = Math.max(0, window - ctx);
  const fill =
    pct >= 95 ? "var(--mx-danger-bright)" : pct >= 80 ? "var(--mx-warning)" : "var(--mx-muted)";
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 ${contextTone(pct)}`}
      title={`窗口上限 ${window.toLocaleString()} tokens\n已用 ${ctx.toLocaleString()}(${pct.toFixed(1)}%) · 剩余 ${left.toLocaleString()}`}
    >
      <span className="relative h-1 w-11 shrink-0 overflow-hidden rounded-full bg-[var(--mx-border-strong)]">
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, background: fill }}
        />
      </span>
      <span className="shrink-0 whitespace-nowrap tabular-nums">
        {formatTokens(ctx)} / {formatTokens(window)}
      </span>
    </span>
  );
}
