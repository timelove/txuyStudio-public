import { useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "./ToggleGroup";
import { cn } from "../../lib/cn";

/**
 * 滑块段选控件(anime.js 风格):ToggleGroup 的 active 高亮不再逐 item 变底色,
 * 而是一枚 accent soft 滑块在槽内平移过渡(300ms ease-out)。
 *
 * 实现是测量而非等分:useLayoutEffect 读 `data-state=on` item 的 offset(在 paint
 * 前完成,初次挂载无跳变),字宽差异(「全部」vs「Claude」)下滑块也精确贴合;
 * value 切换即重测,滑块 width + translateX 双属性过渡。
 *
 * 与 [[ToggleGroup]] 的关系:包一层定位容器 + 滑块 span,item 的 on 态底色由
 * [[SliderItem]] 覆盖为透明(避免与滑块双层底色)。用法与 ToggleGroup 相同。
 */

export function SliderToggleGroup({
  value,
  onValueChange,
  children,
  className,
  pill,
}: {
  /** 受控选中值(必有选中项;点已选中项回传 "" 由调用方判否)。 */
  value: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
  className?: string;
  /** 胶囊形态(滑块 rounded-full,二级 pill tab 用);缺省方形段选。 */
  pill?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ x: -1, w: 0 });
  useLayoutEffect(() => {
    const el = rootRef.current?.querySelector<HTMLElement>("[data-state=on]");
    if (el) setBox({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value, children]);
  return (
    <ToggleGroup
      ref={rootRef}
      type="single"
      value={value}
      onValueChange={onValueChange}
      className={cn("relative", className)}
    >
      {box.x >= 0 && (
        <span
          aria-hidden
          className={`absolute top-0.5 bottom-0.5 left-0 ${pill ? "rounded-full" : "rounded-[var(--mx-radius-sm)]"} bg-[var(--mx-accent-soft)] transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]`}
          style={{ width: box.w, transform: `translateX(${box.x}px)` }}
        />
      )}
      {children}
    </ToggleGroup>
  );
}

/** 滑块版 item:on 态底色让位给滑块(文字高亮保留),其余与 ToggleGroupItem 一致。 */
export function SliderItem({ className, ...props }: ComponentPropsWithoutRef<typeof ToggleGroupItem>) {
  return <ToggleGroupItem {...props} className={cn("data-[state=on]:bg-transparent", className)} />;
}
