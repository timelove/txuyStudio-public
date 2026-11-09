/**
 * Fleet Worker 图标:git 分支形(worktree 的本质——从主仓拉出的并行分支)。
 *
 * 取代原 ⛵ emoji(用户反馈「感觉不搭」):彩色 emoji 与全应用的等宽字形 + 线性 SVG
 * 设计语言不同构(⎇ 分支字形、C/X provider 字母、线性 chevron 都是单色体系);
 * 且 emoji 墨迹随平台字体漂移,不可控。SVG 墨迹由 path 决定、随 currentColor
 * 继承,尺寸/描边由 className 控制(默认 12px,描边 2.5 与小尺寸 chevron 同口径)。
 */
export function FleetIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg
      className={`${className} shrink-0`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}
