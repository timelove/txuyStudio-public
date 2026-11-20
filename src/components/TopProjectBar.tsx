import type React from "react";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProjectId, ProjectSnapshot } from "../domain/projects";
import type { ProjectRecord } from "../domain/appState";
import type { PinnedLayout } from "../domain/pinnedLayout";
import { projectAccentColor } from "../domain/projects";
import { ProjectTabs } from "./ProjectTabs";
import { WindowControls } from "./WindowControls";
import { Button } from "./ui/Button";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import type { SettingsTab } from "./SettingsModal";

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
  /** 并排可见项目数(钉住 + active);<2 时 ProjectTabs 不渲染布局按钮。 */
  visibleProjectCount?: number;
  /** 并排布局偏好(流向+分组),透传 ProjectTabs → PinnedLayoutButton。 */
  pinnedLayout?: PinnedLayout;
  /** 修改并排布局偏好(部分字段 patch),透传。 */
  onPinnedLayoutChange?: (patch: Partial<PinnedLayout>) => void;
  /** 打开设置弹窗(品牌区齿轮;tab 可指定直达页)。AppShell 持有弹窗状态。 */
  onOpenSettings?: (tab?: SettingsTab) => void;
  /** logo 按钮 ref:设置浮层的弹出锚点(面板从按钮正下方左缘「点到面」展开)。 */
  /** 设置页当前是否打开(logo 按钮 active 态)。 */
  settingsOpen?: boolean;
  /** 关闭设置页(logo 在设置页态再点 = 返回工作区)。 */
  onCloseSettings?: () => void;
};

/** 品牌 logo(与 app-icon.svg 同构:深空底 + 镂空 T + 发光 >;小尺寸去 filter 保清晰)。
 *  className 透传交互态差异(设置入口可点 vs 纯展示 pointer-events-none)。 */
function BrandLogo({ className }: { className?: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 1024 1024"
      aria-hidden
      className={`rounded-[5px] shadow-[0_0_0_1px_var(--mx-selected-border),0_1px_3px_rgba(0,0,0,0.4)] ${className ?? ""}`}
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
  );
}

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
  visibleProjectCount,
  pinnedLayout,
  onPinnedLayoutChange,
  onOpenSettings,
  settingsOpen,
  onCloseSettings,
}: TopProjectBarProps) {
  const { t } = useTranslation();
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  return (
    <header
      data-tauri-drag-region
      className="grid h-[length:var(--mx-titlebar-h)] grid-cols-[auto_1fr_auto] items-center gap-3 px-3"
    >
      {/* 品牌区(logo + 名称):整体可作拖拽把手——子元素 pointer-events-none → mousedown
          命中带 attr 的父容器(该 Tauri 版本只看 target 自身、不向上找祖先),整块可拖;
          select-none 防长按误选文字打断拖拽。logo 是其中唯一交互元素(点击开设置,
          pointer-events-auto + stopPropagation),其余纯展示。 */}
      <div data-tauri-drag-region className="flex select-none items-center gap-2">
        {/* 品牌 logo = 设置页入口(点击 toggle 设置页;2026-10-21 页化后不再是浮层锚点,
            hover 可自由变形)。设置页打开时按钮转 active 底色(状态可读)。 */}
        {onOpenSettings ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  if (settingsOpen) onCloseSettings?.();
                  else onOpenSettings();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                aria-label={t("topbar.settings")}
                className={`pointer-events-auto cursor-pointer rounded-[6px] p-[2px] transition-all duration-150 hover:brightness-125 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--mx-accent)] ${
                  settingsOpen ? "bg-[var(--mx-accent-soft)]" : ""
                }`}
              >
                <BrandLogo />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("topbar.settings")}</TooltipContent>
          </Tooltip>
        ) : (
          <BrandLogo className="pointer-events-none" />
        )}
        <div className="pointer-events-none text-[length:var(--mx-ui-fs)] font-[760] tracking-[0.02em]">txuyStudio</div>
      </div>

      {/* 中部:单项目模式 → 精简栏(项目名 + dock back);否则 → 项目 tabs。 */}
      <div data-tauri-drag-region className="min-w-0">
        {singleProjectMode ? (
          /* 内层 flex 满铺中部(flex stretch),必须自带 drag-region:tauri drag.js 的 bare
             attr 只认「点击的直接目标」(el === composedPath[0]),这层无 attr 时点击空白
             target 落在它身上,向上到带 attr 的父级已不满足 path[0] → 独立窗口拖不动。
             主窗口无此层(ProjectTabs 容器自带 attr),行为对齐。 */
          <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
            <span className="mx-chip flex h-[length:var(--mx-tab-h)] min-w-0 items-center gap-[6px] bg-[var(--mx-selected-bg)] px-[10px] text-xs text-[var(--mx-text-bright)]">
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
              {/* dock back 纯图标按钮(窗口框+左箭头):高度对齐项目 chip,方形 icon 档。
                  叉窗/Alt+F4 关掉整个窗口同为回到主窗口(后端 CloseRequested 统一 emit)。
                  拖拽区内 Radix hover 可能失效,保留原生 title 兜底(同左 chip 做法)。 */}
              <Button
                variant="ghost"
                size="icon-md"
                onClick={onDockBack}
                onMouseDown={(e) => e.stopPropagation()}
                title={t("topbar.backToMain")}
                aria-label={t("topbar.backToMain")}
                className="mx-chip h-[length:var(--mx-tab-h)] w-[length:var(--mx-tab-h)] bg-[var(--mx-surface-soft)] text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="5" width="18" height="14" rx="2.5" />
                  <path d="M14.5 12H8.5" />
                  <path d="M11.5 9l-3 3 3 3" />
                </svg>
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
            visibleProjectCount={visibleProjectCount}
            pinnedLayout={pinnedLayout}
            onPinnedLayoutChange={onPinnedLayoutChange}
          />
        )}
      </div>

      {/* 窗口控制:交互按钮区,stopPropagation 避免被拖拽吞掉点击。 */}
      <div className="flex items-center" onMouseDown={(e) => e.stopPropagation()}>
        <ConductorEntry />
        <StageEntry />
        <div className="-mr-3 ml-1 flex h-[length:var(--mx-titlebar-h)] items-stretch">
          <WindowControls />
        </div>
      </div>
    </header>
  );
}

/**
 * 指挥入口(顶栏固定):徽标 = 需关注会话数,`conductor-event` 实时推送。
 * 刻意不做初始快照拉取——应用启动时会话全空、徽标从 0 起走事件订阅即可,
 * 拉快照反而会在主窗口误 ack(快照副作用是推进已读水位)。
 * 点击开/聚焦指挥窗;窗口「关闭 = 隐藏」,本入口是常驻重开点(封层管理)。
 */
function ConductorEntry() {
  const { t } = useTranslation();
  const [attention, setAttention] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ attentionCount?: number }>("conductor-event", (e) => {
      if (cancelled) return;
      const n = e.payload?.attentionCount;
      if (typeof n === "number") setAttention(n);
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {}); // 非 Tauri 环境:静默
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() =>
            void invoke("open_conductor_window").catch((e) =>
              console.warn("[conductor] open failed:", e),
            )
          }
          aria-label={t("topbar.conductor")}
          className="mx-chip relative mr-1 flex h-[length:var(--mx-tab-h)] w-[length:var(--mx-tab-h)] cursor-pointer items-center justify-center bg-[var(--mx-surface-soft)] text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
        >
          {/* 广播波纹图标(值班副官:多会话注意力聚合)。 */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="2.2" />
            <path d="M7.7 7.7a6 6 0 0 0 0 8.6" />
            <path d="M16.3 7.7a6 6 0 0 1 0 8.6" />
            <path d="M4.9 4.9a10 10 0 0 0 0 14.2" />
            <path d="M19.1 4.9a10 10 0 0 1 0 14.2" />
          </svg>
          {attention > 0 && (
            <span className="absolute -right-1 -top-1 min-w-[15px] rounded-full bg-[#ef4444] px-[3px] text-center text-[9px] font-bold leading-[15px] text-white">
              {attention > 99 ? "99+" : attention}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{t("topbar.conductor")}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Agent 实况独立窗入口(2026-11-19,顶栏常驻):点击开/聚焦实况游戏台大屏
 * (label `agent-stage`)。窗口「关闭 = 隐藏」与指挥窗同款,本入口是重开点。
 * 徽标 = 最近 60s 拍数(conductor-tool-event 实时推送,不拉快照)。
 */
function StageEntry() {
  const { t } = useTranslation();
  const [hot, setHot] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    // 拍事件里带的是增量帧,不是全量;热度徽标只在有新拍时闪一下(15s 后自清),
    // 避免为计数再订阅全量快照(快照有 ack 副作用)。
    let decay = 0;
    listen<{ beats?: unknown[] }>("conductor-tool-event", (e) => {
      if (cancelled) return;
      const now = Date.now();
      if (e.payload?.beats?.length) {
        decay = now + 15_000;
        setHot((n) => Math.min(n + e.payload!.beats!.length, 99));
      }
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {}); // 非 Tauri 环境:静默
    const id = window.setInterval(() => {
      if (Date.now() > decay) setHot(0);
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      unlisten?.();
    };
  }, []);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() =>
            void invoke("open_stage_window").catch((e) =>
              console.warn("[stage] open failed:", e),
            )
          }
          aria-label={t("topbar.stage")}
          className="mx-chip relative mr-1 flex h-[length:var(--mx-tab-h)] w-[length:var(--mx-tab-h)] cursor-pointer items-center justify-center bg-[var(--mx-surface-soft)] text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
        >
          {/* 像素闪电图标(实况游戏台:每次工具调用一拍)。 */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          {hot > 0 && (
            <span className="absolute -right-1 -top-1 min-w-[15px] rounded-full bg-[var(--mx-accent)] px-[3px] text-center text-[9px] font-bold leading-[15px] text-white">
              {hot > 99 ? "99+" : hot}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{t("topbar.stage")}</TooltipContent>
    </Tooltip>
  );
}
