import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "../../lib/cn";

/**
 * Popover(chrome 层 UI 标准),基于 Radix Popover 原语。
 *
 * 替换此前各处手写的 createPortal/absolute + mousedown 点外关闭 + data-* 标记协议:
 * - 点外关闭、Esc 关闭、边界碰撞(collisionPadding/avoidCollisions)、焦点管理全部 Radix 内置。
 * - 定位由 anchor(trigger/anchor 元素)+ side/align/sideOffset 决定,无需手算 left/top。
 *
 * Content 基类 `.mx-menu`(6px 圆角)+ `--mx-surface` 背景。动画走 data-state CSS transition。
 */

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverPortal = PopoverPrimitive.Portal;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPortal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "mx-popover-content mx-menu z-[200] border border-[rgba(148,163,184,0.18)] bg-[var(--mx-surface)] py-1 shadow-lg",
        className,
      )}
      {...props}
    />
  </PopoverPortal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverPortal, PopoverContent };
