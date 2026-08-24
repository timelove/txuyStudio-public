import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectId, ProjectSnapshot } from "../domain/projects";
import type { ProjectRecord } from "../domain/appState";
import { projectAccentColor } from "../domain/projects";
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
  /** 最近项目历史(+ 菜单「历史项目」数据源;已打开的项过滤不显示)。 */
  recentProjects?: ProjectRecord[];
  /** + 菜单历史项点击:恢复该项目并钉住。 */
  onOpenRecent?: (rootPath: string) => void | Promise<void>;
  /** + 菜单历史项 ✕:从历史删除记录。 */
  onRemoveRecent?: (rootPath: string) => void;
  /** 历史项右键「在新窗口打开」:恢复该项目并弹独立项目窗口。 */
  onOpenRecentToWindow?: (rootPath: string) => void | Promise<void>;
  /** + 菜单「新窗口」:新建空白工作台窗口。 */
  onNewWindow?: () => void;
};

/** 钉住+当前这块最多占容器宽的比例(其余留给加号/拖拽区)。 */
const PINNED_WIDTH_RATIO = 0.6;

/**
 * 顶部项目栏:左侧「钉住项 + 当前项」合并成一块常驻 chip(竖线分隔,超长按容器宽度比例
 * 尾部省略),整块点击展开下拉列表;右侧 sparkles 图标按钮(下拉:新项目/新窗口/历史项目)。
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
export function ProjectTabs({ projects, activeProjectId, pinnedProjectIds, onSelectProject, onTogglePin, onAddProject, onCloseProject, onDetachProject, detachedProjectIds, recentProjects, onOpenRecent, onRemoveRecent, onOpenRecentToWindow, onNewWindow }: ProjectTabsProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chipContentRef = useRef<HTMLSpanElement | null>(null);
  const [containerW, setContainerW] = useState(0);
  const [chipOverflow, setChipOverflow] = useState(false);
  // 下拉 open 由 Radix Popover 管;右键由 Radix ContextMenu 管(均无需手写点外关闭)。
  const [open, setOpen] = useState(false);
  // 「+」菜单下拉 open(与项目切换下拉独立)。
  const [addOpen, setAddOpen] = useState(false);

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

  // 历史项目:过滤掉当前已打开的(rootPath 相同即视为已打开,包括钉住/active/独立窗口
  // 承载的)——已打开的无需「恢复」,列表只留真正可重开的条目。
  const visibleRecent = (recentProjects ?? []).filter(
    (r) => !projects.some((p) => p.rootPath === r.rootPath),
  );

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
                  "mx-chip flex h-[length:var(--mx-chip-h)] min-w-0 items-center gap-[6px] px-[10px] text-xs transition-colors cursor-pointer",
                  activeProject
                    ? "bg-[var(--mx-selected-bg)] text-white"
                    : "bg-[var(--mx-surface-soft)] text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]",
                ].join(" ")}
              >
                {chipProjects.length > 0 ? (
                  <span
                    ref={chipContentRef}
                    className="flex min-w-0 items-center gap-[4px] overflow-hidden"
                  >
                    {chipProjects.map((p, i) => {
                      // active 项目名用**该项目色**文字标出(色不占字宽,切换 active 不抖动;
                      // 替代下划线--下划线属「tab 下划线」语义,用户要的是内容区 A|B 间的分隔线
                      // 而非顶栏 tab 下划线)。色条每项目一色(id hash 派生,跨会话稳定),并排区分。
                      const isActive = p.id === activeProjectId;
                      const color = projectAccentColor(p.id);
                      return (
                        <span key={p.id} className="flex shrink-0 items-center gap-[4px]">
                          {i > 0 && <span aria-hidden className="shrink-0 text-[var(--mx-muted)] opacity-60">|</span>}
                          <span className="whitespace-nowrap" style={isActive ? { color } : undefined}>
                            {p.name}
                          </span>
                        </span>
                      );
                    })}
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
                  {/* 项目名:点击选中。右键弹 ContextMenu(钉住/分离/删除)。 */}
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
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
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? "" : "opacity-80"}`}
                          style={{ background: projectAccentColor(p.id) }}
                        />
                        <span className="truncate">{p.name}</span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {onTogglePin && (
                        <ContextMenuItem onSelect={() => onTogglePin(p.id)}>
                          {pinnedProjectIds.includes(p.id) ? t("project.unpin") : t("project.pin")}
                        </ContextMenuItem>
                      )}
                      {onDetachProject && (
                        <ContextMenuItem onSelect={() => onDetachProject(p.id)}>
                          {detachedProjectIds?.has(p.id) ? t("project.focusDetached") : t("project.detach")}
                        </ContextMenuItem>
                      )}
                      {onCloseProject && (
                        <ContextMenuItem
                          variant="danger"
                          onSelect={() => {
                            if (window.confirm(t("project.deleteConfirm", { name: p.name }))) {
                              onCloseProject(p.id);
                            }
                          }}
                        >
                          {t("project.delete")}
                        </ContextMenuItem>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
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
                          ? "text-[var(--mx-accent)] opacity-100 hover:bg-[var(--mx-selected-bg)]"
                          : "text-[var(--mx-muted)] opacity-0 group-hover:opacity-100 hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text-bright)]",
                      ].join(" ")}
                    >
                      {isPinned ? "●" : "○"}
                    </button>
                    </TooltipTrigger>
                    <TooltipContent>{isPinned ? t("project.unpin") : t("project.pin")}</TooltipContent>
                    </Tooltip>
                  )}
                  {/* 内联在新窗口打开:已弹出时变灰+「已弹出」标, hover 显。 */}
                  {onDetachProject && (
                    <Tooltip>
                    <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDetachProject(p.id);
                        setOpen(false);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className={[
                        "mx-icon-tile grid h-[16px] w-[16px] shrink-0 place-items-center text-[11px] leading-none cursor-pointer transition-colors",
                        detachedProjectIds?.has(p.id)
                          ? "text-[var(--mx-muted)]"
                          : "text-[var(--mx-muted)] opacity-0 group-hover:opacity-100 hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-accent)]",
                      ].join(" ")}
                    >
                      {detachedProjectIds?.has(p.id) ? "▣" : "↗"}
                    </button>
                    </TooltipTrigger>
                    <TooltipContent>{detachedProjectIds?.has(p.id) ? t("project.focusDetached") : t("project.detach")}</TooltipContent>
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
                      className="mx-icon-tile grid h-[16px] w-[16px] shrink-0 place-items-center text-[12px] leading-none cursor-pointer text-[var(--mx-muted)] opacity-0 group-hover:opacity-100 hover:bg-[var(--mx-danger-bg)] hover:text-[var(--mx-danger)]"
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

      {/* 「打开」入口下拉(始终可见):新项目 / 新窗口 / 历史项目(带 ✕ 删除)。
          触发按钮 = sparkles 四角星 SVG(契合应用青色全息/AI 工作台气质,同 logo 发光风),
          tooltip 说明菜单内容;菜单项全文字,无图标。 */}
      {onAddProject && (
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="accent"
                  size="icon-md"
                  onMouseDown={(e) => e.stopPropagation()}
                  className="h-[length:var(--mx-tab-h)] w-[length:var(--mx-tab-h)] text-[var(--mx-accent-bright)]"
                >
                  {/* sparkles(lucide 24 viewBox 缩放 15px):主四角星 + 两小星点缀。 */}
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    aria-hidden
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
                    <path d="M20 3v4" />
                    <path d="M22 5h-4" />
                    <path d="M4 17v2" />
                    <path d="M5 18H3" />
                  </svg>
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("project.addMenu")}</TooltipContent>
          </Tooltip>

          <PopoverContent side="bottom" align="start" sideOffset={2} className="min-w-[240px] max-w-[340px]">
            {/* 新项目:系统文件夹选择器(原 + 按钮行为)。 */}
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                onAddProject();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="flex w-full cursor-pointer select-none items-center gap-2 px-3 py-[6px] text-left text-xs text-[var(--mx-text)] hover:bg-[var(--mx-hover-bg)]"
            >
              {t("project.newProject")}
            </button>
            <div aria-hidden className="my-1 h-px bg-[var(--mx-border)]" />
            {/* 新窗口:空白工作台窗口(项目按窗口归属隔离)。 */}
            {onNewWindow && (
              <button
                type="button"
                onClick={() => {
                  setAddOpen(false);
                  onNewWindow();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className="flex w-full cursor-pointer select-none items-center gap-2 px-3 py-[6px] text-left text-xs text-[var(--mx-text)] hover:bg-[var(--mx-hover-bg)]"
              >
                {t("project.newWindow")}
              </button>
            )}
            <div aria-hidden className="my-1 h-px bg-[var(--mx-border)]" />
            {/* 历史项目:关闭项目/工作台关窗时后端归档;点击恢复并钉住,✕ 删历史记录。 */}
            <div className="px-3 pt-[2px] pb-[4px] text-[length:var(--mx-ui-fs-xs)] font-[600] tracking-[0.04em] text-[var(--mx-muted)]">
              {t("project.recentSection")}
            </div>
            {visibleRecent.length === 0 ? (
              <div className="px-3 py-[6px] text-xs text-[var(--mx-faint)]">{t("project.recentEmpty")}</div>
            ) : (
              visibleRecent.map((rec) => (
                <div
                  key={rec.rootPath}
                  className="group flex items-center gap-2 px-3 py-[6px] text-xs hover:bg-[var(--mx-hover-bg)]"
                >
                  {/* 名字按钮:点击恢复+钉住;右键弹「在新窗口打开」(恢复+弹独立项目窗口,
                      与打开列表条目的 ContextMenu 同模式)。 */}
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        onClick={() => {
                          setAddOpen(false);
                          void onOpenRecent?.(rec.rootPath);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        title={rec.rootPath}
                        className="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2 text-left text-[var(--mx-text)]"
                      >
                        {/* 历史项色点按 rootPath hash 派生:恢复后 id 相同,跨「历史->打开」色一致。 */}
                        <span
                          aria-hidden
                          className="h-1.5 w-1.5 shrink-0 rounded-full opacity-80"
                          style={{ background: projectAccentColor(rec.rootPath) }}
                        />
                        <span className="truncate">{rec.name}</span>
                      </button>
                    </ContextMenuTrigger>
                    {onOpenRecentToWindow && (
                      <ContextMenuContent>
                        <ContextMenuItem
                          onSelect={() => {
                            setAddOpen(false);
                            void onOpenRecentToWindow(rec.rootPath);
                          }}
                        >
                          {t("project.detach")}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    )}
                  </ContextMenu>
                  {onRemoveRecent && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveRecent(rec.rootPath);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="mx-icon-tile grid h-[16px] w-[16px] shrink-0 cursor-pointer place-items-center text-[12px] leading-none text-[var(--mx-muted)] opacity-0 transition-colors group-hover:opacity-100 hover:bg-[var(--mx-danger-bg)] hover:text-[var(--mx-danger)]"
                        >
                          ✕
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t("project.recentRemove")}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              ))
            )}
          </PopoverContent>
        </Popover>
      )}

    </div>
  );
}
