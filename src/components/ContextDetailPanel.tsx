// BaoCode 借鉴 — 上下文使用详情面板(悬浮框内容)
//
// 借鉴 baocode ContextUsagePanel:多色块进度条 + 明细分段表。
// 本项目把「多色块 + 明细表」做成这个可复用面板,由两个入口以 Popover 形式弹出:
//   - ContextFooterChip(每条 assistant 消息底部;2026-10-20 已随 ctx chip 移除)
//   - ContextMeter(作曲区输入框上方,带 usage 时)
// 用悬浮框而非模态 Dialog:不遮挡消息流视野。
//
// 两种数据源(P2,#137):
//   - `authoritative`(CLI get_context_usage 权威账本,优先):categories 分段
//     (System prompt / System tools / Memory files / Skills / Messages / …),
//     totalTokens / autoCompactThreshold 都是 CLI 实账。
//   - `usage`(assistant 快照估算,兜底):三段拆 input / cache write / cache read,
//     分母用可压缩前可用窗口(window − 33k buffer 建模,见 lib/contextUsage)。

import type { ClaudeContextUsage, ClaudeUsage } from "../domain/claudeStream";
import { deriveContextUsage, usableContextWindow } from "../lib/contextUsage";
import { formatTokens } from "../lib/turnMetrics";

/** 分类段的轮换配色(与 estimate 视图的语义色系一致,ACCENT 起手)。 */
const CATEGORY_COLORS = [
  "var(--mx-accent-bright)",
  "var(--mx-violet)",
  "var(--mx-success-bright)",
  "var(--mx-info)",
  "var(--mx-warning-bright)",
];

type Seg = { key: string; label: string; value: number; color: string };

export function ContextDetailPanel({
  usage,
  window,
  authoritative,
  t,
}: {
  usage: ClaudeUsage | undefined | null;
  window: number;
  /** CLI 权威账本(P2)。有效(totalTokens>0)时优先渲染,估算视图退兜底。 */
  authoritative?: ClaudeContextUsage | null;
  t: (k: string, params?: Record<string, unknown>) => string;
}) {
  const auth =
    authoritative && (authoritative.totalTokens > 0 || authoritative.maxTokens > 0)
      ? authoritative
      : null;
  if (auth) return <AuthoritativeView auth={auth} fallbackWindow={window} t={t} />;
  return <EstimateView usage={usage} window={window} t={t} />;
}

/** CLI 权威账本视图:categories 实账分段 + 权威压缩阈值分母。 */
function AuthoritativeView({
  auth,
  fallbackWindow,
  t,
}: {
  auth: ClaudeContextUsage;
  fallbackWindow: number;
  t: (k: string, params?: Record<string, unknown>) => string;
}) {
  const window = auth.maxTokens || fallbackWindow;
  const usable = auth.autoCompactThreshold && auth.autoCompactThreshold > 0
    ? auth.autoCompactThreshold
    : usableContextWindow(window);
  const buffer = Math.max(0, window - usable);
  const usedSegs: Seg[] = auth.categories
    .filter((c) => c.kind === "used" && c.tokens > 0)
    .map((c, i) => ({
      key: `cat:${c.name}`,
      label: c.name,
      value: c.tokens,
      color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }));
  const total = auth.totalTokens || usedSegs.reduce((s, x) => s + x.value, 0);
  const free = Math.max(0, usable - total);
  const pct = Math.min(100, usable > 0 ? (total / usable) * 100 : 0);
  return (
    <div className="space-y-2.5">
      <SegmentBar
        segments={usedSegs}
        buffer={buffer}
        denominator={window}
        used={total}
        window={window}
        pct={pct}
      />
      <div className="space-y-1">
        {usedSegs.map((s) => (
          <SegmentRow key={s.key} seg={s} denominator={window} />
        ))}
        {/* autocompact 预留:CLI 给压缩结果留的余量,不可用,单独成段(不画进 used)。 */}
        {buffer > 0 && (
          <SegmentRow
            seg={{ key: "buffer", label: t("claudepane.contextDetailBuffer"), value: buffer, color: "var(--mx-warning)" }}
            denominator={window}
            dimColor
          />
        )}
        <div className="flex items-center gap-2 border-t border-[var(--mx-border)] pt-1 text-[11px]">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm bg-[var(--mx-border)]"
            aria-hidden
          />
          <span className="flex-1 text-[var(--mx-muted)]">{t("claudepane.contextDetailWindow")}</span>
          <span className="tabular-nums text-[var(--mx-text)]">{formatTokens(window)}</span>
          <span className="w-9" />
        </div>
        {pct >= 85 && free > 0 && (
          <div className="text-[10px] text-[var(--mx-warning-bright)]">
            {t("claudepane.contextNearCompact", { free: formatTokens(free) })}
          </div>
        )}
      </div>
    </div>
  );
}

/** assistant 快照估算视图(兜底,CLI 账本拿不到时):三段 cache 拆分。 */
function EstimateView({
  usage,
  window,
  t,
}: {
  usage: ClaudeUsage | undefined | null;
  window: number;
  t: (k: string, params?: Record<string, unknown>) => string;
}) {
  const info = deriveContextUsage(usage, window);
  if (!info) {
    return <div className="text-[11px] text-[var(--mx-faint)]">—</div>;
  }
  const segments: Seg[] = [
    {
      key: "input",
      label: t("claudepane.contextDetailInput"),
      value: info.breakdown.input,
      color: "var(--mx-accent-bright)",
    },
    ...(info.breakdown.cacheCreation > 0
      ? [
          {
            key: "cacheWrite",
            label: t("claudepane.contextDetailCacheWrite"),
            value: info.breakdown.cacheCreation,
            color: "var(--mx-warning-bright)",
          },
        ]
      : []),
    ...(info.breakdown.cacheRead > 0
      ? [
          {
            key: "cacheHit",
            label: t("claudepane.contextDetailCacheHit"),
            value: info.breakdown.cacheRead,
            color: "var(--mx-success-bright)",
          },
        ]
      : []),
  ];
  return (
    <div className="space-y-2.5">
      <SegmentBar
        segments={segments}
        buffer={info.buffer}
        denominator={info.window}
        used={info.used}
        window={info.window}
        pct={info.pct}
      />
      <div className="space-y-1">
        {segments.map((s) => (
          <SegmentRow key={s.key} seg={s} denominator={info.window} />
        ))}
        {/* autocompact 预留(借鉴 baocode「Autocompact buffer」段):CLI 给压缩结果留的余量,
            不可用,单独成段(占用% 的分母 = window − buffer,不画进 used)。 */}
        <SegmentRow
          seg={{ key: "buffer", label: t("claudepane.contextDetailBuffer"), value: info.buffer, color: "var(--mx-warning)" }}
          denominator={info.window}
          dimColor
        />
        <div className="flex items-center gap-2 border-t border-[var(--mx-border)] pt-1 text-[11px]">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm bg-[var(--mx-border)]"
            aria-hidden
          />
          <span className="flex-1 text-[var(--mx-muted)]">{t("claudepane.contextDetailWindow")}</span>
          <span className="tabular-nums text-[var(--mx-text)]">{formatTokens(info.window)}</span>
          <span className="w-9" />
        </div>
        {/* 逼近压缩阈值(可用窗口的 ≥85%)提示:用户此前以为还有空间,实际马上 auto-compact。 */}
        {info.pct >= 85 && info.free > 0 && (
          <div className="text-[10px] text-[var(--mx-warning-bright)]">
            {t("claudepane.contextNearCompact", { free: formatTokens(info.free) })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 多色块进度条 + 「已用 / 窗口 (pct%)」行。段宽按 denominator(整窗)占比;buffer 段琥珀。 */
function SegmentBar({
  segments,
  buffer,
  denominator,
  used,
  window,
  pct,
}: {
  segments: Seg[];
  buffer: number;
  denominator: number;
  used: number;
  window: number;
  pct: number;
}) {
  return (
    <div className="space-y-1">
      <div className="h-2 w-full overflow-hidden rounded-sm bg-[var(--mx-border)]">
        <div className="flex h-full">
          {segments.map((s) => (
            <div
              key={s.key}
              style={{ width: `${(s.value / denominator) * 100}%`, background: s.color }}
              title={`${s.label}: ${formatTokens(s.value)}`}
            />
          ))}
          {buffer > 0 && (
            <div
              className="opacity-45"
              style={{ width: `${(buffer / denominator) * 100}%`, background: "var(--mx-warning)" }}
              title={`${formatTokens(buffer)}`}
            />
          )}
        </div>
      </div>
      <div className="flex items-center justify-between text-[10px] text-[var(--mx-faint)]">
        <span className="tabular-nums">
          {formatTokens(used)} / {formatTokens(window)}
        </span>
        <span className="tabular-nums font-medium text-[var(--mx-text)]">{Math.round(pct)}%</span>
      </div>
    </div>
  );
}

/** 明细表一行:色块 + 标签 + tokens + 占比。 */
function SegmentRow({
  seg,
  denominator,
  dimColor = false,
}: {
  seg: Seg;
  denominator: number;
  /** buffer 段的琥珀要用半透明(与进度条段一致,读作「预留」而非「占用」)。 */
  dimColor?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span
        className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${dimColor ? "opacity-45" : ""}`}
        style={{ background: seg.color }}
        aria-hidden
      />
      <span className="flex-1 text-[var(--mx-muted)]">{seg.label}</span>
      <span className="tabular-nums text-[var(--mx-text)]">{formatTokens(seg.value)}</span>
      <span className="w-9 text-right tabular-nums text-[var(--mx-faint)]">
        {Math.round((seg.value / denominator) * 100)}%
      </span>
    </div>
  );
}
