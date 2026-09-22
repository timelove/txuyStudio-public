import { memo } from "react";

/** 相邻消息时间间隔超过该值(30 分钟)时插入时间分隔线(长会话的"时间断层"可读性)。 */
export const MESSAGE_GAP_MS = 30 * 60 * 1000;

const hmFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const fullFmt = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** timestamp → epoch ms:claude/codex 消息是 ISO 串,`!` shell 消息是 number,统一兼容。 */
export function messageTimeMs(ts: string | number): number {
  return typeof ts === "number" ? ts : Date.parse(ts);
}

/**
 * 会话流时间分隔线:居中淡时间标签 + 两侧细线。当天只显 HH:mm,跨天带月/日
 * (Intl 按 locale 出格式,不硬编码文案)。timestamp 为 ISO 串或 epoch ms(消息模型并存)。
 * ClaudePane/CodexPane 共用。
 */
export const TimeGapDivider = memo(function TimeGapDivider({ timestamp }: { timestamp: string | number }) {
  const d = new Date(timestamp);
  const label = d.toDateString() === new Date().toDateString() ? hmFmt.format(d) : fullFmt.format(d);
  return (
    <div aria-hidden className="flex items-center gap-2 py-1 text-[10px] text-[var(--mx-faint)]">
      <div className="h-px min-w-4 flex-1" style={{ borderTop: "1px solid rgba(148,163,184,0.10)" }} />
      <span className="shrink-0 tabular-nums">{label}</span>
      <div className="h-px min-w-4 flex-1" style={{ borderTop: "1px solid rgba(148,163,184,0.10)" }} />
    </div>
  );
});
