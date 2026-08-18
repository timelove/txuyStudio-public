import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../../lib/cn";

/**
 * Tooltip(chrome 层 UI 标准),基于 Radix Tooltip 原语。
 *
 * 替换全项目散落的原生 `title=`:统一 ~400ms 延迟弹出、深色背景小圆角浮层,
 * z-[300] 高于 modal(z-[200]),使模态内 tooltip 仍可盖在其上。
 *
 * 用法(由 main.tsx 的 <TooltipProvider delayDuration={400}> 全局包裹):
 *   <Tooltip>
 *     <TooltipTrigger asChild><Button>…</Button></TooltipTrigger>
 *     <TooltipContent>{t("…")}</TooltipContent>
 *   </Tooltip>
 *
 * 与 Popover/ContextMenu 触发器同元素时:Radix 各 Trigger 用 `composeEventHandlers(props.X,
 * radixHandler)` 合并同名 handler 并各自 spread `{...triggerProps}`,故多层 asChild 嵌套时
 * handler 链式合并而非覆盖(确认见 react-popover/react-context-menu/react-tooltip 源码)。
 */

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "mx-tooltip-content z-[300] border border-[var(--mx-border)] bg-[var(--mx-editor-bg)] px-2 py-1 text-[11px] leading-none text-[var(--mx-text)] shadow-md rounded-[var(--mx-radius-sm)]",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
