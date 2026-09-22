import { useState } from "react";

/** 复制图标(剪贴板)。 */
function IconCopy() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

/**
 * 复制按钮(ClaudePane/CodexPane 共用,原两 pane 各一份逐字重复):点击写剪贴板,
 * 1.2s 显「已复制」。显隐由调用方 className 控制——常显淡(opacity-60)hover/分组 hover 变实,
 * 不再「hover 才显形」(可发现性差;且旧 group-hover 与具名组 group/message 不匹配从未生效)。
 */
export function CopyButton({ text, t, className = "" }: { text: string; t: (k: string) => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      className={`inline-flex items-center gap-1 rounded text-[var(--mx-faint)] transition-colors hover:text-[var(--mx-text)] ${className}`}
      title={t("chat.copy")}
    >
      {copied ? <span className="text-[var(--mx-success)]">{t("chat.copied")}</span> : <IconCopy />}
    </button>
  );
}
