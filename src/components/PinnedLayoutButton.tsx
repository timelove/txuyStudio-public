import { useState } from "react";
import type { PinnedLayout, PinnedFlowLayout } from "../domain/pinnedLayout";
import { generateGroupPresets, resolveGroups } from "../domain/pinnedLayout";
import { useTranslation } from "react-i18next";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/Popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import { ToggleGroup, ToggleGroupItem } from "./ui/ToggleGroup";
import { Button } from "./ui/Button";

/**
 * 并排布局按钮(顶栏 ProjectTabs 内,✦ 按钮旁):钉住 ≥2 个项目时出现。
 *
 * Popover 两段:
 * - 流向 ToggleGroup(横向/纵向,与 shell.pane.splitHorizontal/Vertical 术语对齐)。
 *   纵向 = 分组语义整体旋转 90°([1,2] 横向流是上 1 下 2,纵向流是左 1 右 2)。
 * - 分组预设网格:generateGroupPresets(count) 动态生成(如 n=3 → [3]/[2,1]/[1,2]/[1,1,1]),
 *   每个预设画 mini 示意图(与真实两层 grid 同构)。点选存原始形态,失配由渲染期归一。
 *
 * 选中态按 resolveGroups(layout.groups, count) 归一后比较——钉住数暂变时,归一结果
 * 恰好等于某预设则该预设自然亮起,n 恢复后原形态自动回选中。
 */
export function PinnedLayoutButton({
  layout,
  onChange,
  count,
}: {
  layout: PinnedLayout;
  onChange: (patch: Partial<PinnedLayout>) => void;
  /** 当前并排可见项目数(含未钉住的 active)。<2 时由调用方隐藏本按钮。 */
  count: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const presets = generateGroupPresets(count);
  // 选中比较用归一后的形态(join key),存储不动。
  const resolvedKey = resolveGroups(layout.groups, count).join(",");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-md"
              className="h-[length:var(--mx-tab-h)] w-[length:var(--mx-tab-h)] text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
              onMouseDown={(e) => e.stopPropagation()}
            >
              ▦
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("project.layout.button")}</TooltipContent>
      </Tooltip>

      <PopoverContent side="bottom" align="end" sideOffset={2} className="w-[248px] px-3 py-2">
        {/* 流向:横/纵互斥分段控件。点已选项 Radix 回传空串,判否保住必有选中项。 */}
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-[length:var(--mx-ui-fs-xs)] text-[var(--mx-muted)]">
            {t("project.layout.flow")}
          </span>
          <ToggleGroup
            type="single"
            value={layout.flow}
            onValueChange={(v) => {
              if (v === "row" || v === "column") onChange({ flow: v as PinnedFlowLayout });
            }}
          >
            <ToggleGroupItem value="row">{t("project.layout.flowRow")}</ToggleGroupItem>
            <ToggleGroupItem value="column">{t("project.layout.flowColumn")}</ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div aria-hidden className="my-2 h-px bg-[var(--mx-border)]" />

        {/* 分组预设:按当前项目数动态生成,mini 示意图直观点选。 */}
        <div className="flex items-center justify-between pb-[6px]">
          <span className="text-[length:var(--mx-ui-fs-xs)] text-[var(--mx-muted)]">
            {t("project.layout.groups")}
          </span>
          <span className="text-[length:var(--mx-ui-fs-xs)] text-[var(--mx-faint)]">
            {t("project.layout.groupHint", { count })}
          </span>
        </div>
        <div className="flex flex-wrap gap-[6px]">
          {presets.map((preset) => {
            const selected = preset.join(",") === resolvedKey;
            return (
              <button
                key={preset.join(",")}
                type="button"
                aria-label={preset.join("+")}
                aria-pressed={selected}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onChange({ groups: preset })}
                className={`grid h-[30px] w-[42px] cursor-pointer place-items-center rounded-[var(--mx-radius-sm)] border transition-colors ${
                  selected
                    ? "border-[var(--mx-accent)] bg-[var(--mx-accent-soft)] text-[var(--mx-accent-bright)]"
                    : "border-[var(--mx-border)] text-[var(--mx-muted)] hover:border-[var(--mx-border-strong)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                }`}
              >
                <PresetIcon groups={preset} flow={layout.flow} />
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 分组预设 mini 示意图:纯 div 两层 flex,与 AppShell 的两层嵌套 grid 同构——
 * 外层 = 组(flow="row" 时组沿纵向堆叠,column 时沿横向),内层 = 组内格子(流向相反)。
 * 格子 bg-current + opacity 随按钮前景色,选中态自动跟 accent 走。
 */
function PresetIcon({ groups, flow }: { groups: number[]; flow: PinnedFlowLayout }) {
  return (
    <div
      className="flex h-[20px] w-[32px] gap-[2px]"
      style={{ flexDirection: flow === "row" ? "column" : "row" }}
    >
      {groups.map((g, i) => (
        <div
          key={i}
          className="flex min-h-0 min-w-0 flex-1 gap-[2px]"
          style={{ flexDirection: flow === "row" ? "row" : "column" }}
        >
          {Array.from({ length: g }).map((_, j) => (
            <span key={j} className="block min-h-0 min-w-0 flex-1 rounded-[1px] bg-current opacity-70" />
          ))}
        </div>
      ))}
    </div>
  );
}
