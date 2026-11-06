import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * 当前问题吸顶条:最新 user 消息滚出视口后悬浮在消息流顶部。
 * 收起时严格单行省略;点击展开完整问题,再点收起。只负责展示,可见性由调用方判定。
 * 单行放得下时不显示展开箭头(没有可展开的内容,视觉更干净)。
 */
export function CurrentPromptBanner({
  text,
  expanded,
  onToggle,
}: {
  text: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  // 收起态是否溢出单行:truncate 下 scrollWidth > clientWidth 即超一行。
  // 展开态渲染成 wrap 不复测(保留收起时的判定);text 或容器宽度变化时重测。
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-4 pt-3">
      <button
        type="button"
        onClick={onToggle}
        onMouseDown={(e) => e.stopPropagation()}
        aria-expanded={expanded}
        title={expanded ? t("chat.collapseCurrentPrompt") : t("chat.expandCurrentPrompt")}
        className="pointer-events-auto flex w-full max-w-[54.25rem] cursor-pointer items-start gap-2 rounded-lg border border-[var(--mx-border-strong)] bg-[var(--mx-card-bg)]/95 px-3 py-2 text-left shadow-xl backdrop-blur transition-colors hover:border-[var(--mx-accent)]"
      >
        <span aria-hidden className="mt-[1px] shrink-0 font-mono text-[11px] font-semibold text-[var(--mx-accent)]">
          ›
        </span>
        <span className="min-w-0 flex-1">
          <span ref={textRef} className={expanded ? "block max-h-[35vh] overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--mx-text)]" : "block truncate text-xs text-[var(--mx-text)]"}>
            {text}
          </span>
        </span>
        {expanded || overflows ? (
          <svg
            className={`mt-[3px] h-3 w-3 shrink-0 text-[var(--mx-muted)] transition-transform ${expanded ? "rotate-180" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        ) : null}
      </button>
    </div>
  );
}
