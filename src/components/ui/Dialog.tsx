import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "../../lib/cn";

/**
 * 模态 Dialog(chrome 层 UI 标准),基于 Radix Dialog 原语。
 *
 * 替换此前各 modal 自手写的 createPortal + Esc effect + 点遮罩关闭:
 * - Esc 关闭、点遮罩关闭、焦点陷阱、scroll lock、aria-modal 全部 Radix 内置。
 * - 动画走 data-state 驱动的 CSS transition(见 app.css `.mx-dialog-*`),
 *   不依赖 tailwindcss-animate 插件。
 *
 * Content 基类复用 `.mx-card`(8px 圆角)+ `--mx-surface` 背景,与全项目圆角 token 一致。
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

/** 遮罩层:全屏半透明深底,淡入淡出。点它关闭(Radix 内置,无需手写 onMouseDown)。 */
const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "mx-dialog-overlay fixed inset-0 z-[200] bg-[var(--mx-surface-2)]",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * 内容卡片:居中,`.mx-card` 圆角 + surface 背景 + 描边 + 阴影。
 * 居中用 `fixed inset-0 m-auto` + 固定宽高(不靠 translate,避免与 keyframe 的 transform
 * translate 冲突致位移翻倍、出现「从左上角飞出」的错位)。动画走 data-state 驱动的淡入淡出 + 轻微缩放。
 * 点击内部不关闭(点遮罩才关,Radix 按 overlay 判定)。
 */
const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "mx-dialog-content mx-card fixed inset-0 z-[200] m-auto h-fit w-fit grid border border-[var(--mx-border-strong)] bg-[var(--mx-surface)] shadow-2xl",
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

/** 标题(Radix 要求 Content 内有 Title,否则 warn;可 sr-only 隐藏视觉)。 */
const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-[var(--mx-text)] font-semibold", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

/** 描述(Radix 要求 Content 内有 Description,否则 warn;可 sr-only 隐藏)。 */
const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-[var(--mx-muted)] text-sm", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
};
