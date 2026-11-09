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
        {/* 垂直对齐:单行(收起)用 items-center 真居中;展开多行时 icon/箭头贴首行
            (items-start),mt 手工补正按 leading-relaxed 行高调,仅展开态需要——单行态
            若保留 mt 会参与 flex 居中计算,反而把它顶偏。
            图标用 SVG 而非文字字形 ›:字形在字体回退(尤其中文环境 CJK fallback)下
            墨迹纵向位置不稳定,收起态盒居中、展开态 mt 补正都在赌字形 metrics;SVG
            墨迹由 path 决定、盒内恒居中,且与右侧展开箭头同尺寸同 mt,展开态两箭头
            互相严格对齐。 */}
        <button
          type="button"
          onClick={onToggle}
          onMouseDown={(e) => e.stopPropagation()}
          aria-expanded={expanded}
          title={expanded ? t("chat.collapseCurrentPrompt") : t("chat.expandCurrentPrompt")}
          className={`pointer-events-auto flex w-full max-w-[54.25rem] cursor-pointer gap-2 rounded-lg border border-[var(--mx-border-strong)] bg-[var(--mx-card-bg)]/95 px-3 py-2 text-left shadow-xl backdrop-blur transition-colors hover:border-[var(--mx-accent)] ${expanded ? "items-start" : "items-center"}`}
        >
        <svg
          className={`h-3 w-3 shrink-0 text-[var(--mx-accent)] ${expanded ? "mt-[3px]" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span className="min-w-0 flex-1">
          <span ref={textRef} className={expanded ? "block max-h-[35vh] overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--mx-text)]" : "block truncate text-xs text-[var(--mx-text)]"}>
            {text}
          </span>
        </span>
        {expanded || overflows ? (
          <svg
            className={`h-3 w-3 shrink-0 text-[var(--mx-muted)] transition-transform ${expanded ? "mt-[3px] rotate-180" : ""}`}
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
