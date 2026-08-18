import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { cn } from "../../lib/cn";

/**
 * 右键菜单 ContextMenu(chrome 层 UI 标准),基于 Radix ContextMenu 原语。
 *
 * 替换此前手写的 `createPortal` + `fixed` + `e.clientX/clientY` 定位 + data-ctx-* 点外关闭:
 * - 右键触发、pointer 坐标定位、点外/Esc 关闭、选中即关 全部 Radix 内置。
 * - `onSelect` 选中项后菜单自动关闭(区别于 Popover 的"调用方控制关闭")。
 *
 * Content 基类 `.mx-menu`(6px 圆角)+ `--mx-surface`。动画复用 `.mx-popover-content`。
 */

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuPortal = ContextMenuPrimitive.Portal;

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPortal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        "mx-popover-content mx-menu z-[200] min-w-[160px] border border-[var(--mx-border-strong)] bg-[var(--mx-surface)] py-1 shadow-lg",
        className,
      )}
      {...props}
    />
  </ContextMenuPortal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

/**
 * 菜单项:全宽 list item,hover 出底色。`variant="danger"` 为红色危险项(删除等)。
 * `onSelect` 选中后自动关闭菜单(Radix 内置),替代原 onClick + 手动关闭。
 */
const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    variant?: "default" | "danger";
  }
>(({ className, variant = "default", ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "flex w-full items-center gap-2 px-3 py-[6px] text-left text-xs cursor-pointer outline-none select-none",
      "data-[highlighted]:bg-[var(--mx-hover-bg)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
      variant === "danger"
        ? "text-[var(--mx-danger)] data-[highlighted]:bg-[var(--mx-danger-bg)]"
        : "text-[var(--mx-text)]",
      className,
    )}
    {...props}
  />
));
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

export { ContextMenu, ContextMenuTrigger, ContextMenuPortal, ContextMenuContent, ContextMenuItem };
