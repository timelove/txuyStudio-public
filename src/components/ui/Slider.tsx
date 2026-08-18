import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "../../lib/cn";

/**
 * Slider(chrome 层 UI 标准),基于 Radix Slider 原语(shadcn copy-in 纯手写,不走 CLI)。
 *
 * 水平滑块 = track(深色凹槽)+ range(accent 填充)+ thumb(accent 圆点)。颜色全走
 * `--mx-*` token(不用 shadcn 默认 primary/background 语义),与项目深蓝/cyan 主题一致。
 *
 * 受控用法(数组值,Radix 约定):
 * ```tsx
 * <Slider value={[n]} min={MIN} max={MAX} step={1} onValueChange={(v) => onChange(v[0])} />
 * ```
 */
const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn("relative flex w-full touch-none select-none items-center", className)}
    {...props}
  />
));
Slider.displayName = SliderPrimitive.Root.displayName;

const SliderTrack = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Track>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Track>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Track
    ref={ref}
    className={cn(
      "relative h-1.5 w-full grow overflow-hidden rounded-[var(--mx-radius-full)] bg-[var(--mx-border-strong)]",
      className,
    )}
    {...props}
  />
));
SliderTrack.displayName = SliderPrimitive.Track.displayName;

const SliderRange = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Range>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Range>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Range
    ref={ref}
    className={cn("absolute h-full bg-[var(--mx-accent)]", className)}
    {...props}
  />
));
SliderRange.displayName = SliderPrimitive.Range.displayName;

const SliderThumb = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Thumb>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Thumb>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Thumb
    ref={ref}
    className={cn(
      "block h-3.5 w-3.5 rounded-[var(--mx-radius-full)] bg-[var(--mx-accent)] shadow-[0_0_0_1px_var(--mx-selected-border)] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mx-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--mx-bg)] disabled:pointer-events-none disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
SliderThumb.displayName = SliderPrimitive.Thumb.displayName;

export { Slider, SliderTrack, SliderRange, SliderThumb };
