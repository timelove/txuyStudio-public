import { memo } from "react";
import { CopyButton } from "../ui/CopyButton";

/**
 * user 消息气泡(左右对话框右侧):中性色气泡 + 人形徽标——user 恒中性,AI 侧才是品牌色
 * (Claude 紫/Codex 青),避免在 CodexPane 里 user 与品牌青同色系弱化分边。
 * ClaudePane/CodexPane 共用。
 *
 * hover 操作(↻ 重发/⧉ 复制)常显淡(opacity-60)hover 变实:可发现性优先,
 * 且不依赖「hover 才显形」(旧 group-hover 与具名组 group/message 不匹配从未生效过)。
 */
export const ChatUserBubble = memo(function ChatUserBubble({
  text,
  time,
  onResend,
  t,
}: {
  text: string;
  time?: string;
  onResend?: (text: string) => void;
  t: (k: string) => string;
}) {
  return (
    <div className="group/message flex items-start justify-end gap-1.5">
      <div className="min-w-0 max-w-[85%]">
        {/* 气泡右下角收小圆角(对话框朝向感);user 不显示消耗时长/tokens。 */}
        <div dir="auto" className="whitespace-pre-wrap break-words rounded-lg rounded-br-[4px] bg-[var(--mx-user-bubble)] px-3 py-1.5 leading-relaxed text-[var(--mx-text)]">
          {text}
        </div>
        <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[10px] tabular-nums text-[var(--mx-faint)]">
          {time && <span>{time}</span>}
          {onResend && (
            <button
              type="button"
              title={t("chat.resend")}
              onClick={() => onResend(text)}
              className="cursor-pointer opacity-60 transition-opacity hover:text-[var(--mx-text)] group-hover/message:opacity-100"
            >
              ↻
            </button>
          )}
          <CopyButton text={text} t={t} className="ml-0 opacity-60 group-hover/message:opacity-100" />
        </div>
      </div>
      {/* 角色徽标:user 人形图标(中性底),置于气泡右侧。 */}
      <span aria-hidden className="flex h-[1.625em] shrink-0 items-center">
        <span className="grid h-[18px] w-[18px] place-items-center rounded-md bg-[var(--mx-user-bubble-badge)] text-[var(--mx-muted)]">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </span>
      </span>
    </div>
  );
});
