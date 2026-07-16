/**
 * 字体大小设置常量 —— 终端 + Monaco 编辑器的全局字体大小范围。
 *
 * 与后端 [[crate::state::commands::set_terminal_font_size]] 对应:后端仅透传存储,不校验范围;
 * 范围由前端用这些常量守(hydrate 无值/旧 state.json 缺字段时也用 DEFAULT 回退)。
 */

/** 默认字体大小(px)。与原 TerminalPane 硬编码值一致。 */
export const DEFAULT_FONT_SIZE = 13;

/** 最小字体大小(px)。低于则看不清。 */
export const FONT_SIZE_MIN = 10;

/** 最大字体大小(px)。高于则单行字符过少。 */
export const FONT_SIZE_MAX = 22;

/** clamp 字体大小到 [MIN, MAX] 并取整。供 Provider/校验处复用。 */
export function clampFontSize(size: number): number {
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(size)));
}
