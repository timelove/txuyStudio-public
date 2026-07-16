import type { PaneConfig, ProjectRecord, BackendAppSnapshot } from "./appState";
import type { PaneNode } from "./paneTree";
import { defaultPaneTree, listPanes, migratePaneNode } from "./paneTree";
import type { ProjectSnapshot } from "./projects";
import { SHELL_KIND_META } from "./shellKinds";
import type {
  SessionStatus,
  WorkspaceSession,
  WorkspaceTask,
} from "./sessions";
import type { WorkspaceSnapshot } from "./workspace";

/**
 * 把后端精简身份层派生为前端运行时模型。
 *
 * 后端只持久化项目身份与**分屏 pane tree + tab 栈配置**(不存 transcript/运行状态/git 信息),
 * 这里补齐 UI 所需的默认值:每个 pane 的每个 tab 派生为一个 WorkspaceSession(status 默认 running、
 * accent 按 shellKind 取色、transcript 空);tasks 暂空。git 字段(branch/modifiedFiles/riskMode)
 * 在尚未接 git 的本阶段用占位默认值。
 *
 * 一个 pane 有 N 个 tab → 派生 N 个 session,`session.id = tab.id`(解耦 paneId),
 * `session.paneId = pane.id`(供 TerminalPane 知道归属)。
 *
 * shellKind → accent / 默认标题统一取自 [[shellKinds]] 的 SHELL_KIND_META(单一真源)。
 */

const DEFAULT_BRANCH = "main";

export function deriveSessions(tree: PaneNode, rootPath: string): WorkspaceSession[] {
  // 迁移旧形态(无 tabs 的 pane)→ 新形态,保证 deriver 只处理 tabs 语义。
  const migrated = migratePaneNode(tree);
  const sessions: WorkspaceSession[] = [];
  for (const pane of listPanes(migrated)) {
    for (const tab of pane.tabs) {
      const status: SessionStatus = "running";
      const meta = SHELL_KIND_META[tab.shellKind] ?? SHELL_KIND_META.shell;
      sessions.push({
        // id 复用 tabId:tab 即稳定身份,贯穿 transport 池 / React key / PTY sessionId。
        id: tab.id,
        paneId: pane.id,
        name: tab.title || meta.defaultTitle,
        kind: tab.shellKind,
        command: tab.shellKind,
        cwd: tab.cwd ?? rootPath,
        status,
        summary: "",
        durationLabel: "",
        accent: meta.accent,
        transcript: [],
      });
    }
  }
  return sessions;
}

function deriveWorkspace(record: ProjectRecord): WorkspaceSnapshot {
  // 旧数据 paneTree 缺失 → 默认单 PowerShell pane;旧形态 pane(无 tabs)由 deriver 内迁移。
  const paneTree: PaneNode = migratePaneNode(record.paneTree ?? defaultPaneTree());
  const sessions: WorkspaceSession[] = deriveSessions(paneTree, record.rootPath);
  const tasks: WorkspaceTask[] = [];
  return {
    name: record.name,
    path: record.rootPath,
    branch: DEFAULT_BRANCH,
    modifiedFiles: 0,
    riskMode: "guarded",
    sessions,
    tasks,
    paneTree,
  };
}

/** 单个项目派生。 */
export function deriveProjectSnapshot(record: ProjectRecord): ProjectSnapshot {
  return {
    id: record.id,
    name: record.name,
    rootPath: record.rootPath,
    workspace: deriveWorkspace(record),
  };
}

/** 整组派生:后端快照 → 前端 ProjectSnapshot[]。 */
export function deriveProjects(snapshot: BackendAppSnapshot): ProjectSnapshot[] {
  return snapshot.projects.map(deriveProjectSnapshot);
}

// 兼容旧引用(避免大范围破坏);deriver 不再消费 PaneConfig。
export type { PaneConfig };
