import type { ProjectId, ProjectSnapshot } from "../domain/projects";
import type { ProjectRecord } from "../domain/appState";
import { projectAccentColor } from "../domain/projects";
import { ProjectTabs } from "./ProjectTabs";
import { WindowControls } from "./WindowControls";
import { Button } from "./ui/Button";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";

type TopProjectBarProps = {
  projects: ProjectSnapshot[];
  activeProjectId: ProjectId | null;
  pinnedProjectIds: ProjectId[];
  onSelectProject: (projectId: ProjectId) => void;
  onTogglePin: (projectId: ProjectId) => void;
  onAddProject?: () => void;
  onCloseProject?: (projectId: ProjectId) => void;
  /** 弹出为独立窗口(主窗口模式)。 */
  onDetachProject?: (projectId: ProjectId) => void;
  /** 已弹出的项目集合(下拉/右键里标记「已在独立窗口打开」)。 */
  detachedProjectIds?: Set<ProjectId>;
  /** 独立项目窗口模式:渲染精简栏(项目名 + dock back),不渲染项目 tabs。 */
  singleProjectMode?: boolean;
  /** 独立窗口「回到主窗口」。 */
  onDockBack?: () => void;
  /** 最近项目历史(+ 菜单「历史项目」数据源;透传 ProjectTabs 渲染)。 */
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

/**
 * 顶栏 = 自绘窗口标题栏(IDEA 新 UI 做法,`decorations:false`)。
 * 整行 `data-tauri-drag-region` 可拖动移动窗口;
 * 其内交互元素(input/button)用 onMouseDown stopPropagation 覆盖,恢复点击。
 * 中部项目平铺为 tab(`ProjectTabs`),宽度不够尾部收「更多」;右端挂窗口控制按钮。
 *
 * 单项目模式(`singleProjectMode`):独立项目窗口用,中部只显示当前项目名 + dock back 按钮,
 * 不渲染项目切换 tabs(独立窗口只承载一个项目)。
 */
export function TopProjectBar({
  projects,
  activeProjectId,
  pinnedProjectIds,
  onSelectProject,
  onTogglePin,
  onAddProject,
  onCloseProject,
  onDetachProject,
  detachedProjectIds,
  singleProjectMode,
  onDockBack,
  recentProjects,
  onOpenRecent,
  onRemoveRecent,
  onOpenRecentToWindow,
  onNewWindow,
}: TopProjectBarProps) {
  const { t } = useTranslation();
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  return (
    <header
      data-tauri-drag-region
      className="grid h-[length:var(--mx-titlebar-h)] grid-cols-[auto_1fr_auto] items-center gap-3 px-3"
    >
      {/* 品牌区:纯展示,不 stopPropagation → 冒泡到 header,可作为拖拽把手。
          子元素 pointer-events-none → mousedown 命中带 attr 的父容器(该 Tauri 版本只看
          target 自身、不向上找祖先),整块可拖;select-none 防长按误选文字打断拖拽。 */}
      <div data-tauri-drag-region className="flex select-none items-center gap-2">
        {/* 品牌 logo:与 app-icon.svg 同构(深空底 + 镂空 T + 发光 >),小尺寸去 filter 保清晰。 */}
        <svg
          width="20"
          height="20"
          viewBox="0 0 1024 1024"
          aria-hidden
          className="pointer-events-none rounded-[5px] shadow-[0_0_0_1px_var(--mx-selected-border),0_1px_3px_rgba(0,0,0,0.4)]"
        >
          <defs>
            <linearGradient id="mxLogoBg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#070a12" />
              <stop offset="1" stopColor="#0f1428" />
            </linearGradient>
            <radialGradient id="mxLogoAmbient" cx="0.5" cy="0.5" r="0.6">
              <stop offset="0" stopColor="#22d3ee" stopOpacity="0.22" />
              <stop offset="1" stopColor="#070a12" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect x="0" y="0" width="1024" height="1024" rx="224" ry="224" fill="url(#mxLogoBg)" />
          <rect x="0" y="0" width="1024" height="1024" rx="224" ry="224" fill="url(#mxLogoAmbient)" />
          {/* 青色描边边框:与圆角底重合,凸显 logo 与顶栏背景的边界(全息风格统一)。 */}
          <rect x="3" y="3" width="1018" height="1018" rx="222" ry="222"
                fill="none" stroke="#22d3ee" strokeWidth="6" opacity="0.55" />
          <rect x="450" y="332" width="280" height="64" rx="8" fill="none" stroke="#22d3ee" strokeWidth="18" />
          <rect x="558" y="332" width="64" height="360" rx="8" fill="none" stroke="#22d3ee" strokeWidth="18" />
          <path
            d="M 318 512 L 418 602 L 318 692"
            fill="none"
            stroke="#e2e8f0"
            strokeWidth="40"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div className="pointer-events-none text-[length:var(--mx-ui-fs)] font-[760] tracking-[0.02em]">txuyStudio</div>
      </div>

      {/* 中部:单项目模式 → 精简栏(项目名 + dock back);否则 → 项目 tabs。 */}
      <div data-tauri-drag-region className="min-w-0">
        {singleProjectMode ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="mx-chip flex h-[length:var(--mx-tab-h)] min-w-0 items-center gap-[6px] bg-[var(--mx-selected-bg)] px-[10px] text-xs text-white">
              {/* 项目稳定色 dot(与主窗口顶栏 chip/下拉同色源,跨窗口同项目同色)。 */}
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: activeProject ? projectAccentColor(activeProject.id) : "var(--mx-accent)" }}
              />
              {/* 拖拽区(data-tauri-drag-region)内:Radix Tooltip 依赖 pointermove/hover,
                  纯 hover 应触发;但拖拽按下时失效,故保留原生 title 兜底(≤5 处保留之一)。 */}
              <span className="truncate" title={activeProject?.rootPath ?? ""}>
                {activeProject?.name ?? t("topbar.project")}
              </span>
            </span>
            {onDockBack && (
              <Tooltip>
              <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-md"
                onClick={onDockBack}
                onMouseDown={(e) => e.stopPropagation()}
                className="mx-chip h-[length:var(--mx-tab-h)] gap-1 bg-[var(--mx-surface-soft)] px-[10px] text-xs text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
              >
                {t("topbar.backToMainBtn")}
              </Button>
              </TooltipTrigger>
              <TooltipContent>{t("topbar.backToMain")}</TooltipContent>
              </Tooltip>
            )}
          </div>
        ) : (
          <ProjectTabs
            projects={projects}
            activeProjectId={activeProjectId}
            pinnedProjectIds={pinnedProjectIds}
            onSelectProject={onSelectProject}
            onTogglePin={onTogglePin}
            onAddProject={onAddProject}
            onCloseProject={onCloseProject}
            onDetachProject={onDetachProject}
            detachedProjectIds={detachedProjectIds}
            recentProjects={recentProjects}
            onOpenRecent={onOpenRecent}
            onRemoveRecent={onRemoveRecent}
            onOpenRecentToWindow={onOpenRecentToWindow}
            onNewWindow={onNewWindow}
          />
        )}
      </div>

      {/* 窗口控制:交互按钮区,stopPropagation 避免被拖拽吞掉点击。 */}
      <div className="flex items-center" onMouseDown={(e) => e.stopPropagation()}>
        <div className="-mr-3 ml-1 flex h-[length:var(--mx-titlebar-h)] items-stretch">
          <WindowControls />
        </div>
      </div>
    </header>
  );
}
