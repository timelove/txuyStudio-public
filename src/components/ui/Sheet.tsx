import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "../../lib/cn";

/**
 * 侧边抽屉(Sheet),基于 Radix Dialog 原语(与 Dialog 同源:Esc / 点遮罩 / 焦点陷阱 /
 * scroll lock 全部内置),仅定位与动画不同:
 *
 * - Content 固定 `inset-y-0 left-0`(左侧全高),宽由 className 给(调用方定,如 w-[640px]);
 *   打开时从左滑入(`.mx-sheet-content`,app.css data-state 驱动 keyframes,不依赖插件)。
 *   从左弹是刻意的:设置入口在左上角(TopProjectBar 齿轮),面板贴着入口侧出现,视觉动线连贯
 *   (从右弹时点击位置与面板相隔整个窗口宽度,落差大——用户 2026-10-20 反馈)。
 * - 适用「宽内容设置页」:模态 Dialog 居中卡片放不下宽表单/列表,侧边抽屉贴近 IDE 设置面板
 *   的心智(2026-10-20 设置改版:供应商管理等宽内容入驻)。
 *
 * 与 Dialog 一样要求 Content 内有 Title(无障碍,可 sr-only)。
 */

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("mx-dialog-overlay fixed inset-0 z-[200] bg-[var(--mx-overlay)]", className)}
    {...props}
  />
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "mx-sheet-content fixed inset-y-0 left-0 z-[200] flex w-[640px] max-w-[92vw] flex-col border-r border-[var(--mx-border-strong)] bg-[var(--mx-surface)] shadow-2xl",
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("font-semibold text-[var(--mx-text)]", className)}
    {...props}
  />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-[var(--mx-muted)]", className)}
    {...props}
  />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

export { Sheet, SheetTrigger, SheetClose, SheetPortal, SheetOverlay, SheetContent, SheetTitle, SheetDescription };
