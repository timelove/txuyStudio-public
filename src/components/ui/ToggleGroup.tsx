import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "../../lib/cn";

/**
 * ToggleGroup(chrome 层 UI 标准),基于 Radix ToggleGroup 原语。
 *
 * 用于「单选分段控件」语义:一组互斥选项中选一个(语言切换、主题切换等)。
 * 替换此前散落的手写「N 个 Button + variant=selected 判断」:
 * - 选中态由 Radix data-state=on/on 驱动,无需调用方手动比较当前值。
 * - 内置键盘导航(方向键在 item 间移动 + Space/Enter 选中)、role=radiogroup(role=radio)无障碍语义。
 * - 数据驱动:调用方对 SUPPORTED_LOCALES 之类数组 `.map` 即可,加选项只改数组。
 *
 * 观感为连体分段控件:整体外框(border + 透明底 + 6px 圆角),item off 透明、
 * item on 走 accent soft 底。item 圆角走 --mx-radius-sm(与外框 md 略小的内嵌层次)。
 *
 * 用法(单选):
 *   <ToggleGroup type="single" value={locale} onValueChange={(v)=>v && changeLanguage(v)}>
 *     <ToggleGroupItem value="zh">中文</ToggleGroupItem>
 *     <ToggleGroupItem value="en">English</ToggleGroupItem>
 *   </ToggleGroup>
 *
 * 注:`type="single"` 时 onValueChange 回传被选中项的 value;点中已选中项会回传 ""
 * (取消选中)。语言切换这类「必有选中项」场景,调用方对空串判否即可(见 SettingsModal)。
 */

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn(
      "inline-flex items-center gap-0.5 rounded-[var(--mx-radius-md)] border border-[rgba(148,163,184,0.28)] bg-[rgba(2,6,23,0.4)] p-0.5",
      className,
    )}
    {...props}
  />
));
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName;

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Item
    ref={ref}
    className={cn(
      // 选中态 data-state=on 走 accent soft 底 + 前景高亮;off 透明 hover 出底色。
      "flex items-center justify-center rounded-[var(--mx-radius-sm)] px-2 py-[3px] text-[11px] text-[var(--mx-muted)] transition-colors cursor-pointer select-none",
      "hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]",
      "data-[state=on]:bg-[rgba(34,211,238,0.16)] data-[state=on]:text-[#bae6fd] data-[state=on]:font-medium",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--mx-accent)]",
      className,
    )}
    {...props}
  >
    {children}
  </ToggleGroupPrimitive.Item>
));
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;

export { ToggleGroup, ToggleGroupItem };
