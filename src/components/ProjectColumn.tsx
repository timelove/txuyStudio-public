import { useMemo } from "react";
import type { ProjectSnapshot } from "../domain/projects";
import type { PaneNode, ShellKind, SplitDirection } from "../domain/paneTree";
import { deriveSessions } from "../domain/projectDeriver";
import type { TerminalTransport } from "../domain/terminalTransport";
import type { ClaudeTransport } from "../domain/claudeTransport";
import type { CodexTransport } from "../domain/codexTransport";
import type { ShellRunTransport } from "../domain/shellRunTransport";
import { PaneSurface } from "./PaneSurface";

type ProjectColumnProps = {
  project: ProjectSnapshot;
  paneTree: PaneNode;
  /** 该列内被聚焦的 paneId(焦点不在本项目时为 null)。 */
  focusedPaneId: string | null;
  onFocusPane: (paneId: string) => void;
  /** 按复合键取该项目某 pane 某 tab 的 transport(由 AppShell 闭包注入 projectId)。 */
  getTransport: (paneId: string, tabId: string) => TerminalTransport;
  /** 按复合键取该项目某 pane 某 tab 的 ClaudeTransport(claudepane 用)。 */
  getClaudeTransport: (paneId: string, tabId: string) => ClaudeTransport;
  /** 按复合键取该项目某 pane 某 tab 的 CodexTransport(codexpane 用)。 */
  getCodexTransport: (paneId: string, tabId: string) => CodexTransport;
  /** 按复合键取该项目某 pane 某 tab 的 ShellRunTransport(`!` 命令用)。 */
  getShellRunTransport: (paneId: string, tabId: string) => ShellRunTransport;
  onSplitPane: (paneId: string, kind: ShellKind, direction: SplitDirection) => void;
  onClosePane: (paneId: string) => void;
  onAddTab: (paneId: string, kind: ShellKind) => void;
  onResumeSession: (provider: "claude" | "codex", sessionId: string, cwd?: string | null) => void;
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
  getClaudeTransport,
  getCodexTransport,
  getShellRunTransport,
  onSplitPane,
  onClosePane,
  onAddTab,
  onResumeSession,
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
          getClaudeTransport={getClaudeTransport}
          getCodexTransport={getCodexTransport}
          getShellRunTransport={getShellRunTransport}
          onSplitPane={onSplitPane}
          onClosePane={onClosePane}
          onAddTab={onAddTab}
          onResumeSession={onResumeSession}
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
