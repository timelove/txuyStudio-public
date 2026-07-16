import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../../lib/cn";

/**
 * Tabs(chrome 层 UI 标准),基于 Radix Tabs 原语,受控(value/onValueChange)。
 *
 * 用于 3 个 pane(TerminalPane/SessionBrowserPane/FileTreePane)的 tab 条:
 * - 外层 `<Tabs value={activeTabId} onValueChange={(id)=>onSetActiveTab?.(paneId,id)}>` 接管 tab 切换,
 *   替代此前手写的 chip div onMouseDown 切 tab 逻辑(Radix TabsTrigger 内置 onMouseDown→onValueChange)。
 * - TabsList/TabsTrigger 均 asChild:本项目 tab 条无固定背景、chip 样式由调用方 className 全权控制
 *   (保留既有 active border-b-2 等自定义样式,不依赖 Radix data-state)。
 * - 终端/会话/文件树主体**不**用 TabsContent:仍用既有绝对定位 + display 切显隐 + xterm/虚拟化常驻,
 *   Radix Tabs.Root 只管 value 状态,TabsContent 可选不强制。
 *
 * 嵌套:Tooltip 在外、TabsTrigger 在内(`<Tooltip><TooltipTrigger asChild><TabsTrigger asChild>
 * <div chip/></TabsTrigger></TooltipTrigger><TooltipContent/></Tooltip>`)。Radix 各 Trigger 用
 * composeEventHandlers 合并同名 onMouseDown/pointer handler,链式不覆盖(与 Popover/ContextMenu 同范式)。
 */

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn(className)} {...props} />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger ref={ref} className={cn(className)} {...props} />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn(className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
