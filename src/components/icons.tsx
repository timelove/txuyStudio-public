/**
 * 内联图标集(跟随主题色,fill=currentColor)。
 *
 * BaoCode 借鉴:图标语义对齐 baocode 的步骤行/会话 UI——
 * - SpeakAiIcon:Remix Icon `speak-ai-line`(baocode 用作「子 agent 消息」步骤图标,
 *   琥珀色,读作「有人在说话」,从工具行里跳出来)。SVG 取自 baocode
 *   `assets/icons/speak-ai-line.svg`(RemixIcon,Apache-2.0)。
 * - SessionIcon:对话气泡(Material chat_bubble_outline 同形),baocode 用在
 *   会话/嵌入对话处;这里作「历史会话」条目的前缀图标。
 */

/** 子 agent / 消息步骤图标(ri:speak-ai-line)。建议 15px,琥珀(--mx-warning)。 */
export function SpeakAiIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`inline-block shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="m20.713 7.128l-.246.566a.506.506 0 0 1-.934 0l-.246-.566a4.36 4.36 0 0 0-2.22-2.25l-.759-.339a.53.53 0 0 1 0-.963l.717-.319A4.37 4.37 0 0 0 19.276.931L19.53.32a.506.506 0 0 1 .942 0l.253.61a4.37 4.37 0 0 0 2.25 2.327l.718.32a.53.53 0 0 1 0 .962l-.76.338a4.36 4.36 0 0 0-2.219 2.251M9 2a8 8 0 0 1 7.934 6.965l2.25 3.539c.148.233.118.58-.225.728L17 14.07V17a2 2 0 0 1-2 2h-1.999L13 22H4v-3.694c0-1.18-.436-2.297-1.244-3.305A8 8 0 0 1 9 2m0 2a6 6 0 0 0-4.684 9.75C5.41 15.114 6 16.667 6 18.306V20h5l.002-3H15v-4.248l1.55-.664l-1.543-2.425l-.057-.442A6 6 0 0 0 9 4m10.49 12.993l1.664 1.11A10.95 10.95 0 0 0 23 12q-.001-1.025-.181-2l-1.943.5q.123.733.124 1.5a8.96 8.96 0 0 1-1.51 4.993" />
    </svg>
  );
}

/** 历史会话图标(对话气泡描边)。建议 14px,当前 accent 色。 */
export function SessionIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`inline-block shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

/** tab 关闭图标(细叉)。
 *  替代字符「×」:字体里 × 字形在字身框内基线定位、天然不居中(grid 居中的是行框
 *  不是字形,2026-10-19 用户反馈 tab 关闭按钮没居中);SVG 按几何中心绘制,配合
 *  按钮的 grid place-items-center 恒居中,且不受主题字体影响。建议 8px(h-2 w-2)。 */
export function TabCloseIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`inline-block shrink-0 ${className}`}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M2 2 L8 8 M8 2 L2 8" />
    </svg>
  );
}
