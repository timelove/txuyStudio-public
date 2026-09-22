import { Button } from "./Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

/**
 * AI pane ◱ 展开/还原按钮(ClaudePane/CodexPane 共用,原两 pane 各一份逐字重复)。
 * 展开态切换图标与文案(◱ 展开 / ◫ 还原);状态真身是 AppShell 的展开记忆(expandedPaneIds),
 * 按钮只做展示与触发,不持有状态。
 */
export function PaneExpandButton({
  expanded,
  onToggle,
  t,
}: {
  expanded?: boolean;
  onToggle: () => void;
  t: (k: string) => string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-[13px] text-[var(--mx-muted)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onToggle}
        >
          {expanded ? "◫" : "◱"}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{expanded ? t("shell.pane.restore") : t("shell.pane.expand")}</TooltipContent>
    </Tooltip>
  );
}
