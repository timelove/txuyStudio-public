import { useMemo } from "react";
import type { ProjectSnapshot } from "../domain/projects";
import type { PaneNode, ShellKind } from "../domain/paneTree";
import { deriveSessions } from "../domain/projectDeriver";
import type { TerminalTransport } from "../domain/terminalTransport";
import { PaneSurface } from "./PaneSurface";

type ProjectColumnProps = {
  project: ProjectSnapshot;
  paneTree: PaneNode;
  /** 该列内被聚焦的 paneId(焦点不在本项目时为 null)。 */
  focusedPaneId: string | null;
  onFocusPane: (paneId: string) => void;
  /** 按复合键取该项目某 pane 某 tab 的 transport(由 AppShell 闭包注入 projectId)。 */
  getTransport: (paneId: string, tabId: string) => TerminalTransport;
  onSplitPane: (paneId: string, kind: ShellKind) => void;
  onClosePane: (paneId: string) => void;
  onAddTab: (paneId: string, kind: ShellKind) => void;
  onCloseTab: (paneId: string, tabId: string) => void;
  onSetActiveTab: (paneId: string, tabId: string) => void;
  onMeasurePane?: (paneId: string, size: { width: number; height: number }) => void;
};

/**
 * 中央并排区的「一个项目列」:该项目自己的 WT 式分屏树(每 pane 内含 tab 栈)。
 *
 * 多项目并排时,每列是独立的 pane tree;React key 与 transport 都按 `(projectId, paneId, tabId)`
 * 复合键隔离(PaneSurface 的 keyPrefix + AppShell 的 triple 池),根除跨项目 `ps-1` 撞车。
 */
export function ProjectColumn({
  project,
  paneTree,
  focusedPaneId,
  onFocusPane,
  getTransport,
  onSplitPane,
  onClosePane,
  onAddTab,
  onCloseTab,
  onSetActiveTab,
  onMeasurePane,
}: ProjectColumnProps) {
  // deriveSessions 已遍历 pane 的 tabs,每个 tab 派生一个 session(id=tabId, paneId=pane.id)。
  const sessions = useMemo(() => deriveSessions(paneTree, project.rootPath), [paneTree, project.rootPath]);

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <div className="min-h-0 min-w-0 flex-1">
        <PaneSurface
          paneTree={paneTree}
          sessions={sessions}
          focusedPaneId={focusedPaneId}
          onFocusPane={onFocusPane}
          getTransport={getTransport}
          onSplitPane={onSplitPane}
          onClosePane={onClosePane}
          onAddTab={onAddTab}
          onCloseTab={onCloseTab}
          onSetActiveTab={onSetActiveTab}
          onMeasurePane={onMeasurePane}
          keyPrefix={project.id}
          projectId={project.id}
        />
      </div>
    </section>
  );
}
