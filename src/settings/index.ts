/**
 * 字体大小设置常量 —— 终端 + Monaco 编辑器的全局字体大小范围。
 *
 * 与后端 [[crate::state::commands::set_terminal_font_size]] 对应:后端仅透传存储,不校验范围;
 * 范围由前端用这些常量守(hydrate 无值/旧 state.json 缺字段时也用 DEFAULT 回退)。
 */

/** 默认字体大小(px)。终端(xterm)+Monaco+消息流共用;放大一号(13->14)提升默认可读性。 */
export const DEFAULT_FONT_SIZE = 14;

/** 最小字体大小(px)。低于则看不清。 */
export const FONT_SIZE_MIN = 10;

/** 最大字体大小(px)。高于则单行字符过少。 */
export const FONT_SIZE_MAX = 22;

/** clamp 字体大小到 [MIN, MAX] 并取整。供 Provider/校验处复用。 */
export function clampFontSize(size: number): number {
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(size)));
}

/**
 * 输入框卡片底部状态栏(model/perm/tokens 等)的字号:随全局 fontSize 等比缩放,
 * 下限 9px(再小看不清)。默认 14px → 10px,与历史固定 text-[10px] 一致。
 * ClaudePane / CodexPane 共用,保证两个 AI 面板状态栏观感一致。
 */
export function statusFontSize(fontSize: number): number {
  return Math.max(9, Math.round(fontSize * 0.72));
}
