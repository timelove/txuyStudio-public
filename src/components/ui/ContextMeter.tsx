import { contextTone } from "../../domain/contextMeter";
import type { ClaudeContextUsage, ClaudeUsage } from "../../domain/claudeStream";
import { ContextDetailPanel } from "../ContextDetailPanel";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";

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
 *
 * `usage` + `t` 可选:都传了就渲染成可点按钮,点击弹 **Popover 悬浮框**显示明细
 * (不遮挡视野);不传则仍是纯 `<span>`(CodexPane 未接,保持原样零风险)。
 */
export function ContextMeter({
  used,
  window,
  usage,
  authoritative,
  t,
}: {
  used: number;
  window: number;
  usage?: ClaudeUsage | null;
  /** CLI 权威账本(P2,meta.contextUsage)。传了优先用它渲染明细(categories 实账)。 */
  authoritative?: ClaudeContextUsage | null;
  t?: (k: string, params?: Record<string, unknown>) => string;
}) {
  const ctx = Math.max(0, used);
  const pct = ctx > 0 ? Math.min(100, (ctx / window) * 100) : 0;
  const left = Math.max(0, window - ctx);
  const fill =
    pct >= 95 ? "var(--mx-danger-bright)" : pct >= 80 ? "var(--mx-warning)" : "var(--mx-muted)";
  const title = `窗口上限 ${window.toLocaleString()} tokens\n已用 ${ctx.toLocaleString()}(${pct.toFixed(1)}%) · 剩余 ${left.toLocaleString()}`;
  const inner = (
    <>
      <span className="relative h-1 w-11 shrink-0 overflow-hidden rounded-full bg-[var(--mx-border-strong)]">
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, background: fill }}
        />
      </span>
      <span className="shrink-0 whitespace-nowrap tabular-nums">
        {formatTokens(ctx)} / {formatTokens(window)}
      </span>
    </>
  );
  const base = `flex shrink-0 items-center gap-1.5 ${contextTone(pct)}`;
  const clickable = !!usage && !!t;
  if (!clickable) {
    return (
      <span className={base} title={title}>
        {inner}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={title}
          data-testid="ctx-meter"
          className={`${base} cursor-pointer rounded px-0.5 transition-colors hover:bg-[var(--mx-hover-bg)]`}
        >
          {inner}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[300px] max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--mx-border)] bg-[var(--mx-surface)] p-3 shadow-xl"
      >
        <ContextDetailPanel usage={usage} window={window} authoritative={authoritative} t={t!} />
      </PopoverContent>
    </Popover>
  );
}
