import { memo } from "react";

/**
 * 会话头(C5「开端感」):品牌块 + 名称 + 模型 + session 尾 8 位 + ctx 窗口 + 渐隐分隔线,
 * 随消息流一起滚动。ClaudePane/CodexPane 共用,品牌差异经 brandLetter/brandClass 注入
 * (Claude 紫 C / Codex 青 X),字段差异经 model/sessionId 传入。
 */
export const SessionHeader = memo(function SessionHeader({
  brandLetter,
  brandClass,
  name,
  model,
  sessionId,
  contextWindow,
}: {
  brandLetter: string;
  /** 品牌块底色/前景色 class(如 "bg-[var(--mx-violet)] text-white")。 */
  brandClass: string;
  name: string;
  model?: string;
  sessionId?: string;
  contextWindow?: number;
}) {
  return (
    <div className="flex items-center gap-2 px-1.5 py-1 text-[10px] text-[var(--mx-faint)]">
      <span aria-hidden className={`grid h-4 w-4 shrink-0 place-items-center rounded text-[8px] font-extrabold ${brandClass}`}>
        {brandLetter}
      </span>
      <span className="shrink-0 text-[var(--mx-muted)]">{name}</span>
      {model && <span className="shrink-0 font-mono">{model}</span>}
      {sessionId && <span className="shrink-0 font-mono">#{sessionId.slice(-8)}</span>}
      {contextWindow ? <span className="shrink-0 font-mono">{Math.round(contextWindow / 1000)}k ctx</span> : null}
      <div className="h-px min-w-0 flex-1" style={{ borderTop: "1px solid rgba(148,163,184,0.14)" }} />
    </div>
  );
});
