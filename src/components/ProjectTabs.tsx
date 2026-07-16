import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectId, ProjectSnapshot } from "../domain/projects";
import { Button } from "./ui/Button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./ui/ContextMenu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";

type ProjectTabsProps = {
  projects: ProjectSnapshot[];
  activeProjectId: ProjectId | null;
  /** 已钉住的项目(同时在中央并排显示)。 */
  pinnedProjectIds: ProjectId[];
  onSelectProject: (projectId: ProjectId) => void;
  onTogglePin?: (projectId: ProjectId) => void;
  onAddProject?: () => void;
  /** 删除项目:关闭其所有 shell + 从工作区移除。 */
  onCloseProject?: (projectId: ProjectId) => void;
  /** 弹出为独立窗口。 */
  onDetachProject?: (projectId: ProjectId) => void;
  /** 已弹出为独立窗口的项目集合。 */
  detachedProjectIds?: Set<ProjectId>;
};

/** 钉住+当前这块最多占容器宽的比例(其余留给加号/拖拽区)。 */
const PINNED_WIDTH_RATIO = 0.6;

/**
 * 顶部项目栏:左侧「钉住项 + 当前项」合并成一块常驻 chip(竖线分隔,超长按容器宽度比例
 * 尾部省略),整块点击展开下拉列表;右侧加号。
 *
 * - 合并块内容:已钉住项目(顺序同 pinnedProjectIds)+ 当前项目(若未钉住,追加在后),
 *   每项名字之间用 `|` 分隔;点击整块展开下拉。
 * - 超长省略:合并块最大宽 = 容器宽 × `PINNED_WIDTH_RATIO`,超出尾部 `⋯`。
 * - 下拉列表:列全部项目,每项 = 项目名(选中)+ 内联钉住(●/○)+ 删除(✕);active 高亮。
 * - 右键合并块 chip → 弹「更多」菜单(钉住/分离窗口/删除 activeProject)。
 *
 * 下拉用 Radix Popover(PopoverContent 自带 portal,脱离顶栏 overflow 裁切);
 * 右键用 Radix ContextMenu(定位到鼠标坐标)。两者 open/close 均由 Radix 内置。
 */
export function ProjectTabs({ projects, activeProjectId, pinnedProjectIds, onSelectProject, onTogglePin, onAddProject, onCloseProject, onDetachProject, detachedProjectIds }: ProjectTabsProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chipContentRef = useRef<HTMLSpanElement | null>(null);
  const [containerW, setContainerW] = useState(0);
  const [chipOverflow, setChipOverflow] = useState(false);
  // 下拉 open 由 Radix Popover 管;右键由 Radix ContextMenu 管(均无需手写点外关闭)。
  const [open, setOpen] = useState(false);

  // 容器宽度:用于按比例裁剪钉住块。ResizeObserver 监听。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerW(el.clientWidth);
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 合并块要显示的项目:已钉住项目(顺序同 pinnedProjectIds,且仍存在于 projects)+
  // 当前项目(若未钉住,追加在后)。用于顶栏常驻 chip 展示。
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const pinnedProjects = pinnedProjectIds
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is ProjectSnapshot => !!p);
  const activeInPinned = activeProject && pinnedProjects.some((p) => p.id === activeProject.id);
  const chipProjects = activeInPinned
    ? pinnedProjects
    : activeProject
      ? [...pinnedProjects, activeProject]
      : pinnedProjects;

  // 整体溢出检测:内容真实宽(scrollWidth) > 可视宽(clientWidth) → 标记溢出,尾部显示 ⋯。
  // 依赖 containerW(影响 maxWidth → clientWidth)和 chipProjects(内容)。
  useEffect(() => {
    const el = chipContentRef.current;
    if (!el) return;
    setChipOverflow(el.scrollWidth - el.clientWidth > 1);
  }, [containerW, chipProjects]);

  // 下拉/右键菜单的 open/close 全由 Radix Popover/ContextMenu 自管,无需手写点外 effect。

  // 合并块最大宽(按容器比例),超出尾部省略。容器宽度未测得时给一个保守上限。
  const chipMaxW = containerW > 0 ? Math.floor(containerW * PINNED_WIDTH_RATIO) : 240;

  return (
    <div ref={containerRef} data-tauri-drag-region className="flex w-full min-w-0 select-none items-center gap-[6px]">
      {/* 合并块:钉住项 + 当前项(若未钉住)并排,竖线分隔,超长尾部省略;
          点击展开下拉(Popover),右键弹「更多」菜单(ContextMenu,对当前 active 项目)。
          PopoverTrigger 与 ContextMenuTrigger 链式 asChild 包同一 button:点击 toggle 下拉、右键弹菜单。 */}
      <Popover open={open} onOpenChange={setOpen}>
        <ContextMenu>
          <Tooltip>
          <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                style={chipProjects.length > 0 ? { maxWidth: `${chipMaxW}px` } : undefined}
                className={[
                  "mx-chip flex h-[24px] min-w-0 items-center gap-[6px] px-[10px] text-xs transition-colors cursor-pointer",
                  activeProject
                    ? "bg-[var(--mx-selected-bg)] text-white"
                    : "bg-[rgba(15,23,42,0.5)] text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]",
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeProject ? "bg-[#22d3ee]" : "bg-[var(--mx-faint)]"}`}
                />
                {chipProjects.length > 0 ? (
                  <span
                    ref={chipContentRef}
                    className="flex min-w-0 items-center gap-[4px] overflow-hidden"
                  >
                    {chipProjects.map((p, i) => (
                      <span key={p.id} className="flex shrink-0 items-center gap-[4px]">
                        {i > 0 && <span aria-hidden className="shrink-0 text-[var(--mx-muted)] opacity-60">|</span>}
                        <span className="whitespace-nowrap">{p.name}</span>
                      </span>
                    ))}
                    {chipOverflow && (
                      <span aria-hidden className="ml-[2px] shrink-0 text-[var(--mx-muted)]">⋯</span>
                    )}
                  </span>
                ) : (
                  <span className="truncate">{t("project.select")}</span>
                )}
                <span aria-hidden className="shrink-0 text-[16px] leading-none text-[var(--mx-muted)]">▾</span>
              </button>
            </ContextMenuTrigger>
          </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{activeProject ? activeProject.name : t("project.select")}</TooltipContent>
          </Tooltip>

          {/* 右键「更多」菜单(对 activeProject):钉住/分离窗口/删除。onSelect 自动关闭。 */}
          {activeProject && (
            <ContextMenuContent>
              {onTogglePin && (
                <ContextMenuItem
                  onSelect={() => onTogglePin(activeProject.id)}
                >
                  {pinnedProjectIds.includes(activeProject.id) ? t("project.unpin") : t("project.pin")}
                </ContextMenuItem>
              )}
              {onDetachProject && (
                <ContextMenuItem
                  onSelect={() => onDetachProject(activeProject.id)}
                >
                  {detachedProjectIds?.has(activeProject.id) ? t("project.focusDetached") : t("project.detach")}
                </ContextMenuItem>
              )}
              {onCloseProject && (
                <ContextMenuItem
                  variant="danger"
                  onSelect={() => {
                    if (window.confirm(t("project.deleteConfirm", { name: activeProject.name }))) {
                      onCloseProject(activeProject.id);
                    }
                  }}
                >
                  {t("project.delete")}
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          )}
        </ContextMenu>

        {/* 下拉列表:PopoverContent 自带 portal(脱离顶栏 overflow 裁切),定位由 anchor 自动算。 */}
        <PopoverContent side="bottom" align="start" sideOffset={2} className="min-w-[200px] max-w-[320px]">
          {projects.length === 0 ? (
            <div className="px-3 py-[6px] text-xs text-[var(--mx-muted)]">{t("project.none")}</div>
          ) : (
            projects.map((p) => {
              const isActive = p.id === activeProjectId;
              const isPinned = pinnedProjectIds.includes(p.id);
              return (
                <div
                  key={p.id}
                  className={[
                    "group flex items-center gap-2 px-3 py-[6px] text-xs",
                    isActive ? "bg-[var(--mx-selected-bg)] text-white" : "text-[var(--mx-text)] hover:bg-[var(--mx-hover-bg)]",
                  ].join(" ")}
                >
                  {/* 项目名:点击选中。 */}
                  <Tooltip>
                  <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectProject(p.id);
                      setOpen(false);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
                  >
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? "bg-[#22d3ee]" : "bg-[var(--mx-faint)]"}`}
                    />
                    <span className="truncate">{p.name}</span>
                  </button>
                  </TooltipTrigger>
                  <TooltipContent>{p.name}</TooltipContent>
                  </Tooltip>
                  {/* 内联钉住:已钉 ●(亮),未钉 ○(hover 显)。 */}
                  {onTogglePin && (
                    <Tooltip>
                    <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTogglePin(p.id);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      aria-pressed={isPinned}
                      className={[
                        "mx-icon-tile grid h-[16px] w-[16px] shrink-0 place-items-center text-[12px] leading-none cursor-pointer transition-colors",
                        isPinned
                          ? "text-[#22d3ee] opacity-100 hover:bg-[rgba(34,211,238,0.18)]"
                          : "text-[#94a3b8] opacity-0 group-hover:opacity-100 hover:bg-[var(--mx-hover-bg)] hover:text-[#e2e8f0]",
                      ].join(" ")}
                    >
                      {isPinned ? "●" : "○"}
                    </button>
                    </TooltipTrigger>
                    <TooltipContent>{isPinned ? t("project.unpin") : t("project.pin")}</TooltipContent>
                    </Tooltip>
                  )}
                  {/* 内联删除:hover 显,危险红。 */}
                  {onCloseProject && (
                    <Tooltip>
                    <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(t("project.deleteConfirm", { name: p.name }))) {
                          onCloseProject(p.id);
                        }
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="mx-icon-tile grid h-[16px] w-[16px] shrink-0 place-items-center text-[12px] leading-none cursor-pointer text-[#94a3b8] opacity-0 group-hover:opacity-100 hover:bg-[rgba(244,63,94,0.18)] hover:text-[#f87171]"
                    >
                      ✕
                    </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("project.delete")}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              );
            })
          )}
        </PopoverContent>
      </Popover>

      {/* 加号(始终可见) */}
      {onAddProject && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="accent"
              size="icon-md"
              onClick={onAddProject}
              onMouseDown={(e) => e.stopPropagation()}
              className="h-[24px] w-[24px] text-[14px] text-[#bae6fd]"
            >
              +
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("project.add")}</TooltipContent>
        </Tooltip>
      )}

    </div>
  );
}
