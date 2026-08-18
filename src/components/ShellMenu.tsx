import type { ShellKind, SplitDirection } from "../domain/paneTree";
import { NEW_SHELL_GROUPS, SHELL_KIND_META } from "../domain/shellKinds";
import { useTranslation } from "react-i18next";
import { PopoverContent } from "./ui/Popover";

/**
 * 新建 tab / 分屏菜单内容(纯 PopoverContent 叶子):shell 类型按分组
 * (Shell / AI CLI / TUI 工具 / 会话)渲染,组间分隔线 + 小标题。
 *
 * 由调用方(TerminalPane/SessionBrowserPane/FileTreePane/ClaudePane/HtmlPreviewPane)用 `<Popover>` 包 trigger
 * 并控制 open;点外关闭、Esc、边界碰撞全部 Radix Popover 内置,本组件只负责内容渲染。
 * 菜单项点击后由 `onSelect` 回调(调用方负责关 Popover + 执行动作)。
 *
 * `splitDirection`(分屏菜单):有值时为分屏模式,onSelect 回调原样带该 direction(方向由调用方的
 * trigger 按钮决定,菜单内不再选方向)。缺省(新建 tab 菜单)传 undefined,direction 为 undefined。
 *
 * `onSelect` 关闭时机由调用方决定(非"选中即关"),故用普通 button 而非 DropdownMenu.Item。
 */
export function ShellMenu({
  onSelect,
  onOpenChange,
  splitDirection,
}: {
  onSelect: (kind: ShellKind, direction?: SplitDirection) => void;
  onOpenChange?: (open: boolean) => void;
  /** 有值 = 分屏菜单:onSelect 原样带该 direction(方向已由 trigger 决定)。 */
  splitDirection?: SplitDirection;
}) {
  const { t } = useTranslation();
  return (
    <PopoverContent align="start" sideOffset={4} className="w-[132px]">
      {NEW_SHELL_GROUPS.map((group, gi) => (
        <div key={group.title}>
          {gi > 0 && <div className="my-1 border-t border-[var(--mx-border-strong)]" />}
          <div className="px-3 pb-0.5 text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">{t(group.title)}</div>
          {group.kinds.map((kind) => {
            const meta = SHELL_KIND_META[kind];
            return (
              <button
                key={kind}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-[4px] text-left text-[11px] text-[var(--mx-text)] hover:bg-[var(--mx-hover-bg)] cursor-pointer"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(kind, splitDirection);
                }}
              >
                <span
                  className="mx-icon-tile grid h-4 w-4 place-items-center text-[10px] font-bold"
                  style={{ background: meta.accent, color: "#0b1020" }}
                >
                  {meta.glyph}
                </span>
                {t(meta.label)}
              </button>
            );
          })}
        </div>
      ))}
    </PopoverContent>
  );
}
