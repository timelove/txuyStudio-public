import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * 统一按钮组件(chrome 层 UI 标准)。
 *
 * 解决的痛点:此前每个 modal/侧栏/状态栏各自手敲按钮的 `px-? py-? text-?`,
 * 调一处不影响别处,导致全项目按钮规格永远对不齐。本组件把「尺寸 + 变体」
 * 固化为枚举,新增按钮只声明 `size="sm" variant="ghost"`,具体像素由这里统一。
 *
 * 设计取向与现有 token 对齐:
 * - 圆角:全项目中等圆角,基类用 `--mx-radius-md`(6px),与 app.css 的 radius token + 语义
 *   class 体系一致(见 .mx-card/.mx-menu/.mx-chip/.mx-icon-tile)。
 * - 颜色全部走 `--mx-*` 变量(slate 深蓝底 + cyan 强调),不引入新色。
 * - 默认 `cursor-pointer`:与现有手写按钮一致。
 *
 * 尺寸分两族:
 * - 文字档(xs/sm/md/lg):含 padding + 字号,用于带文字的按钮(modal 关闭、确认)。
 * - 图标档(icon-sm/icon-md/icon-lg):固定方形 `grid place-items-center`,无 padding,
 *   用于纯图标/SVG 按钮(工具栏 +/×/ splitter、状态栏齿轮、窗口控制)。图标按钮的内容
 *   (SVG 或字符)自带尺寸,容器只负责居中与 hover 背板。
 *
 * React 19:用 ref-as-prop(`buttonRef`),无需 forwardRef。
 */

export type ButtonSize =
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "icon-sm" // 20px 方块(工具栏 +/split/×)
  | "icon-md" // 24px 方块(项目加号、dock back)
  | "icon-lg"; // 44px 全高方块(窗口控制按钮)
export type ButtonVariant =
  | "default" // 主按钮:accent 实心
  | "outline" // 次级:描边 + 透明底(modal 关闭/取消常用)
  | "ghost" // 幽灵:无边框,hover 才出底色(工具栏图标按钮)
  | "selected" // 选中态:soft accent 底(语言切换等单选)
  | "danger" // 破坏性:红色描边(删除二次确认常用)
  | "accent"; // 强调底:soft accent 背板(新建 +/加号等 CTA 入口)

type ButtonOwnProps = {
  /** 尺寸档位;默认 md。文字档见 xs~lg,图标档见 icon-*。 */
  size?: ButtonSize;
  /** 视觉变体;默认 outline(modal 里的次级按钮最常见)。 */
  variant?: ButtonVariant;
  /** 透传到原生 <button> 的 ref(React 19 ref-as-prop)。 */
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: ReactNode;
};

// 原生 button 属性里有 `size`(textarea 用),与我们冲突,显式剔除。
type ButtonProps = ButtonOwnProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size" | "ref">;

/** 各尺寸档位(全项目统一于此)。文字档含 padding+字号,图标档固定方形居中。 */
const SIZE: Record<ButtonSize, string> = {
  xs: "px-1.5 py-[1px] text-[10px]",
  sm: "px-2 py-[3px] text-[11px]",
  md: "px-3 py-1 text-xs",
  lg: "px-4 py-1.5 text-sm",
  "icon-sm": "grid h-5 w-5 place-items-center leading-none",
  "icon-md": "grid h-6 w-6 place-items-center leading-none",
  "icon-lg": "grid h-full w-[44px] place-items-center",
};

/** 各变体的颜色表达,全部基于 --mx-* token。 */
const VARIANT: Record<ButtonVariant, string> = {
  default:
    "bg-[var(--mx-accent)] text-[var(--mx-editor-bg)] font-semibold hover:brightness-110",
  outline:
    "border border-[var(--mx-border-strong)] text-[var(--mx-text)] hover:bg-[var(--mx-hover-bg)]",
  ghost:
    "text-[var(--mx-muted)] hover:text-[var(--mx-text)] hover:bg-[var(--mx-hover-bg)]",
  selected:
    "border border-[var(--mx-accent)] bg-[var(--mx-accent-soft)] text-[var(--mx-text)]",
  danger:
    "border border-[var(--mx-danger-border)] text-[var(--mx-danger)] hover:bg-[var(--mx-danger-bg)]",
  accent:
    "bg-[var(--mx-accent-soft)] text-[var(--mx-accent-bright)] hover:bg-[var(--mx-accent-soft)]",
};

export function Button({
  size = "md",
  variant = "outline",
  buttonRef,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={buttonRef}
      type={type}
      className={cn(
        "rounded-[var(--mx-radius-md)] cursor-pointer transition-colors select-none",
        SIZE[size],
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
