import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PaneNode, ShellKind } from "../domain/paneTree";
import type { PaneRef } from "../domain/paneTree";
import { listPanes } from "../domain/paneTree";
import { NEW_SHELL_GROUPS, SHELL_KIND_META } from "../domain/shellKinds";
import type { ProjectSnapshot } from "../domain/projects";
import { projectAccentColor } from "../domain/projects";
import { Button } from "./ui/Button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";

type ShellSidebarProps = {
  /** 中央同时显示的可见项目(含 active)。 */
  visibleProjects: ProjectSnapshot[];
  /** 每项目一棵 pane tree(键为 projectId)。 */
  treesByProject: Record<string, PaneNode>;
  /** 当前焦点(复合身份)。 */
  focused: PaneRef | null;
  onFocusPane: (ref: PaneRef) => void;
  /** 关闭某项目的某 pane。 */
  onClosePane: (projectId: string, paneId: string) => void;
  /** 在某项目内新建 shell(作用于该项目)。 */
  onCreateShell: (projectId: string, kind: ShellKind) => void;
};

/**
 * 左栏(窄,44px):**按项目分组**列出所有可见项目的 shell。
 * 每组一个项目色小标头(项目名首字) + 该项目叶子图标列;点击图标设焦点并把该项目设 active;
 * 底部 `+` 打开新建菜单(作用于焦点项目)。
 *
 * 多项目并排时左栏成为「项目→shell」二级导航;单项目时退化为原来的单列。
 *
 * 新建菜单用 `createPortal` 渲染到 body 并以 fixed 定位:
 * 左栏 44px,容器有 `overflow-y-auto`(裁切),若用 absolute 定位,
 * 宽 124px 的菜单会被裁掉(「点不到/看不到」)。Portal 脱离裁切容器。
 */
export function ShellSidebar({
  visibleProjects,
  treesByProject,
  focused,
  onFocusPane,
  onClosePane,
  onCreateShell,
}: ShellSidebarProps) {
  const { t } = useTranslation();
  // 新建菜单 open/close 由 Radix Popover 管(点外、Esc 内置),无需 menuPos/openMenuFrom/点外 effect。
  const [menuOpen, setMenuOpen] = useState(false);

  // 新建菜单作用于「焦点项目」,无焦点时回退第一个可见项目。
  const newShellProjectId = focused?.projectId ?? visibleProjects[0]?.id;

  const menuItems = (
    <>
      {NEW_SHELL_GROUPS.map((group, gi) => (
        <div key={group.title}>
          {gi > 0 && <div className="my-1 border-t border-[var(--mx-border-strong)]" />}
          <div className="px-3 pb-0.5 text-[length:var(--mx-ui-fs-xs)] uppercase tracking-wide text-[var(--mx-faint)]">{t(group.title)}</div>
          {group.kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-[6px] text-left text-xs text-[var(--mx-text)] hover:bg-[var(--mx-hover-bg)] cursor-pointer"
              onClick={() => {
                if (newShellProjectId) onCreateShell(newShellProjectId, kind);
                setMenuOpen(false);
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <span
                className="mx-icon-tile grid h-4 w-4 place-items-center text-[10px] font-bold"
                style={{ background: SHELL_KIND_META[kind].accent, color: "#0b1020" }}
              >
                {SHELL_KIND_META[kind].glyph}
              </span>
              {t(SHELL_KIND_META[kind].label)}
            </button>
          ))}
        </div>
      ))}
    </>
  );

  return (
    <>
      <nav
        className="flex min-h-0 w-full flex-col items-center gap-[8px] overflow-y-auto px-0 pb-2"
        aria-label={t("sidebar.openShellsByProject")}
      >
        {visibleProjects.map((project, idx) => {
          const tree = treesByProject[project.id];
          const panes = tree ? listPanes(tree) : [];
          // 项目色:用项目 id 哈希稳定色(与顶栏 chip/内容区分隔线同色源,跨 UI 一致区分)。
          const projectColor = projectAccentColor(project.id);
          return (
            <section key={project.id} className="flex w-full flex-col items-center gap-[6px]">
              {/* 项目色条:3px 全宽,纯项目色。hover 区仅 3px 高,Tooltip 体验差,保留原生 title。 */}
              <div
                className="h-[3px] w-full"
                style={{ background: projectColor }}
                title={project.name}
              />
              {/* 该项目叶子图标列。 */}
              <ul className="m-0 grid w-full list-none place-items-center gap-[6px] p-0">
                {panes.map((pane) => {
                  // pane 的活动 tab 决定图标 shellKind/title(pane 自身不再有 shellKind/title)。
                  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
                  const shellKind = activeTab?.shellKind ?? "shell";
                  const tabTitle = activeTab?.title ?? "PowerShell";
                  const meta = SHELL_KIND_META[shellKind] ?? SHELL_KIND_META.shell;
                  const isFocused = focused?.projectId === project.id && focused.paneId === pane.id;
                  return (
                    <li key={pane.id} className="group relative flex w-full justify-center">
                      <Tooltip>
                      <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-md"
                        onClick={() => onFocusPane({ projectId: project.id, paneId: pane.id })}
                        className={[
                          "h-[length:var(--mx-sidebar-icon)] w-[length:var(--mx-sidebar-icon)] text-[length:var(--mx-ui-fs)] font-bold",
                          isFocused
                            ? "bg-[var(--mx-selected-bg)] text-white hover:bg-[var(--mx-selected-bg)]"
                            : "bg-[var(--mx-surface-soft)] text-[var(--mx-text)] hover:bg-[var(--mx-border-soft)]",
                        ].join(" ")}
                      >
                        <span className="grid place-items-center" style={{ color: isFocused ? "#fff" : meta.accent }}>
                          {meta.glyph}
                        </span>
                        {/* 左侧色条:区分 shellKind,聚焦时点亮。 */}
                        <span
                          aria-hidden
                          className="absolute bottom-[4px] h-[2px] w-3.5 rounded-none"
                          style={{ background: meta.accent, opacity: isFocused ? 0.95 : 0.4 }}
                        />
                      </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t(tabTitle)}</TooltipContent>
                      </Tooltip>
                      {panes.length > 1 && (
                        <Tooltip>
                        <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            onClosePane(project.id, pane.id);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="absolute top-[-4px] right-[2px] h-[16px] w-[16px] bg-[var(--mx-surface)] text-[10px] text-[var(--mx-muted)] opacity-0 transition-opacity duration-100 hover:text-[var(--mx-danger-bright)] group-hover:opacity-100"
                        >
                          ×
                        </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("sidebar.closePane")}</TooltipContent>
                        </Tooltip>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}

        {/* 底部新建按钮:Popover trigger,菜单 PopoverContent 自带 portal(脱离 52px 栏裁切)。
            side="right" align="center" ≈ 原 fixed+translateY(-50%)「按钮右侧垂直居中」。 */}
        <div className="mt-auto flex justify-center">
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <Tooltip>
            <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="accent"
                size="icon-md"
                onMouseDown={(e) => e.stopPropagation()}
                className="h-[length:var(--mx-sidebar-icon)] w-[length:var(--mx-sidebar-icon)] text-[length:var(--mx-ui-fs-lg)] text-[var(--mx-accent-bright)]"
              >
                +
              </Button>
            </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("sidebar.newShell")}</TooltipContent>
            </Tooltip>
            <PopoverContent side="right" align="center" sideOffset={6} className="w-[124px]">
              {menuItems}
            </PopoverContent>
          </Popover>
        </div>
      </nav>
    </>
  );
}
