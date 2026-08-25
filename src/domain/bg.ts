/**
 * 背景图功能的小工具:颜色 alpha 化 + 设置形状。
 *
 * 背景图开启时,前景大表面色(--mx-bg/--mx-editor-bg 等)需变半透明让背景透出。
 * token 原值可能是 #hex(midnight 大多)或 rgba(...)(one-dark 的 tabbar/midnight surface),
 * 统一转成带目标 alpha 的 rgba 字符串;解析失败返回 null(调用方跳过该 token)。
 */

/** 背景图设置(路径 + 模糊 + 暗化)。path 为空 = 关闭。localStorage 持久化(纯视觉,不走后端)。 */
export type BgSetting = {
  /** 本地图片绝对路径;空串 = 未启用。 */
  path: string;
  /** 背景图模糊半径(px)。0 = 不模糊。 */
  blur: number;
  /** 暗化遮罩不透明度(0-0.85)。压暗背景保前景可读。 */
  dim: number;
};

export const DEFAULT_BG_SETTING: BgSetting = { path: "", blur: 20, dim: 0.45 };

/**
 * 把 #rgb/#rrggbb/#rrggbbaa 或 rgba()/rgb() 颜色转成 rgba(r,g,b,alpha)。失败返回 null。
 *
 * alpha 是**不透明度上限**而非硬替换:原色自带 alpha 时按预乘合成(最终 alpha = alpha × 原 alpha),
 * 已比目标更透的浅罩保持更透。否则会把 midnight tabbar 这类 0.055 淡罩抬成 0.72 实色块,
 * 背景图反而被挡住(玻璃化要的是"最多这么实",不是"统一这么实")。
 */
export function colorWithAlpha(color: string, alpha: number): string | null {
  const c = color.trim();
  // #hex 形态。
  if (c.startsWith("#")) {
    let hex = c.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = hex.split("").map((x) => x + x).join("");
    if (hex.length !== 6 && hex.length !== 8) return null;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    const orig = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return `rgba(${r}, ${g}, ${b}, ${roundAlpha(alpha * orig)})`;
  }
  // rgb()/rgba() 形态:取前三个数,与原 alpha(缺省 1)预乘。
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const r = parseInt(parts[0] ?? "", 10);
    const g = parseInt(parts[1] ?? "", 10);
    const b = parseInt(parts[2] ?? "", 10);
    if ([r, g, b].some(Number.isNaN)) return null;
    const orig = parts.length >= 4 ? parseFloat(parts[3]) : 1;
    if (Number.isNaN(orig)) return null;
    return `rgba(${r}, ${g}, ${b}, ${roundAlpha(alpha * orig)})`;
  }
  return null;
}

/** 乘积抖到 4 位小数,避免 0.055*0.72=0.039600000000000005 这类浮点尾串进 CSS。 */
function roundAlpha(a: number): number {
  return +a.toFixed(4);
}
