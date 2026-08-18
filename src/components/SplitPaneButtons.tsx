import { useState } from "react";
import type { ShellKind, SplitDirection } from "../domain/paneTree";
import { useTranslation } from "react-i18next";
import { Popover, PopoverTrigger } from "./ui/Popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import { Button } from "./ui/Button";
import { ShellMenu } from "./ShellMenu";

/**
 * 分屏按钮组(pane 工具栏用):横向(horizontal,左右两列)/ 纵向(vertical,上下两行)两个按钮。
 * 方向语义见 paneTree:horizontal = grid-cols-2(左右,WT duplicate-right);
 * vertical = grid-rows-2(上下,WT duplicate-down)。
 *
 * 图标用 ▥(三横条,视觉上是「上下堆叠」= 纵向分屏):
 * - 纵向 vertical:原样 ▥(上下分屏,与图标三横条堆叠吻合)。
 * - 横向 horizontal:rotate-90(把三横条立起来 = 左右两列)。
 * 两个按钮各自独立 Popover + ShellMenu;同一时刻只开一个(openDir 互斥)。
 */
export function SplitPaneButtons({
  onSplit,
}: {
  onSplit: (kind: ShellKind, direction: SplitDirection) => void;
}) {
  const { t } = useTranslation();
  const [openDir, setOpenDir] = useState<SplitDirection | null>(null);
  const dirs: SplitDirection[] = ["horizontal", "vertical"];
  return (
    <>
      {dirs.map((dir) => (
        <Popover key={dir} open={openDir === dir} onOpenChange={(o) => setOpenDir(o ? dir : null)}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={`text-[var(--mx-muted)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)] ${dir === "vertical" ? "rotate-90" : ""}`}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  ▥
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{t(dir === "horizontal" ? "shell.pane.splitHorizontal" : "shell.pane.splitVertical")}</TooltipContent>
          </Tooltip>
          {openDir === dir && (
            <ShellMenu
              splitDirection={dir}
              onSelect={(kind) => {
                setOpenDir(null);
                onSplit(kind, dir);
              }}
            />
          )}
        </Popover>
      ))}
    </>
  );
}
