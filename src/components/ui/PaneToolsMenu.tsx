import { useState } from "react";

import { Button } from "./Button";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

/**
 * AI pane 头部「⋯ 工具」菜单(ClaudePane/CodexPane 共用)。
 *
 * 承接原 `/` slash 命令面板的能力入口(skills/mcp/plugins 等资源查看 + compact/rewind 等
 * 会话动作):slash 面板已按产品决策移除,这些动作全部收拢到本菜单,由各 pane 组装 groups 传入。
 *
 * 视觉对齐 ShellMenu 范式(项目菜单标准):uppercase 分组小标题 + 组间 border-strong 分隔线 +
 * mx-icon-tile glyph 图标(tile 底/前景色按组 tone:资源=violet、会话=accent、定位=muted)+
 * hover-bg 行高亮。组件只管渲染与开合;动作回调与文案由调用方提供。点击任一项后菜单自动关闭
 * (弹出二级 Dialog 的场景需要菜单让位) */

/** 单条菜单项:label 主文案;hint 右侧浅色注释(如命令原文 /compact);glyph 图标字符。 */
export type PaneToolsMenuItem = { label: string; hint?: string; glyph?: string; onClick: () => void };

/** 分组 tone 决定组内 glyph tile 的底/前景色(资源=violet、会话=accent、定位=muted)。 */
export type PaneToolsMenuGroup = {
  label?: string;
  tone?: "violet" | "accent" | "muted";
  items: PaneToolsMenuItem[];
};

/** 宽度自适应工具侧栏阈值:AI pane 内容区 ≥ 此宽度时右侧自动展开工具侧栏
 *  (ClaudePane/CodexPane 共用;对话区仍留 ~700px 可读 + 侧栏 248px)。 */
export const TOOL_SIDEBAR_MIN_PANE_W = 960;

const TONE_TILE: Record<NonNullable<PaneToolsMenuGroup["tone"]>, string> = {
  violet: "bg-[var(--mx-violet-soft)] text-[var(--mx-violet)]",
  accent: "bg-[var(--mx-accent-soft)] text-[var(--mx-accent)]",
  muted: "bg-[var(--mx-hover-bg)] text-[var(--mx-muted)]",
};

export function PaneToolsMenu({ groups, tooltip }: { groups: PaneToolsMenuGroup[]; tooltip: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-[14px] leading-none text-[var(--mx-muted)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
              onMouseDown={(e) => e.stopPropagation()}
            >
              ⋯
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-[240px]" align="end">
        {groups.map((group, gi) => (
          <div key={gi}>
            {gi > 0 && <div className="my-1 border-t border-[var(--mx-border-strong)]" />}
            {group.label && (
              <div className="px-3 pb-0.5 text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">
                {group.label}
              </div>
            )}
            {group.items.map((item) => (
              <button
                key={item.label}
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-[4px] text-left text-[11px] text-[var(--mx-text)] hover:bg-[var(--mx-hover-bg)]"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.glyph && (
                  <span
                    aria-hidden
                    className={`mx-icon-tile grid h-4 w-4 shrink-0 place-items-center text-[10px] font-bold ${TONE_TILE[group.tone ?? "muted"]}`}
                  >
                    {item.glyph}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint && (
                  <span className="shrink-0 font-mono text-[10px] text-[var(--mx-faint)]">{item.hint}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
