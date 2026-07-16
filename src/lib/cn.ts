import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 className 的统一工具(同 shadcn/ui 标准实现)。
 *
 * - `clsx`:处理条件类(`cn("a", cond && "b", { c: true })`)。
 * - `tailwind-merge`:消除 Tailwind 冲突类(如 `px-2 px-4` → `px-4`),
 *   让 `<Button className="px-4">` 能安全覆盖组件内置的 `px-2`。
 *
 * 全项目组件拼 className 都应走这里,避免手写 `["a", cond ? "b" : "c"].join(" ")`
 * 既冗长又会留下冲突类。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
