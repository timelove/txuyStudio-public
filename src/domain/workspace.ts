import type { PaneNode } from "./paneTree";
import type { WorkspaceSession, WorkspaceTask } from "./sessions";

/**
 * 单个项目的工作区快照:项目信息 + AI Sessions + Tasks + 终端面板布局。
 *
 * `paneTree` 是 WT 式分屏树,直接驱动中央 `PaneSurface` 渲染;sessions 从 tree 叶子
 * 派生供状态统计(TopCommandBar/StatusBar)。多项目编排见 [[AppSnapshot]]。
 */
export type WorkspaceSnapshot = {
  name: string;
  path: string;
  branch: string;
  modifiedFiles: number;
  riskMode: "guarded" | "permissive";
  sessions: WorkspaceSession[];
  tasks: WorkspaceTask[];
  paneTree: PaneNode;
};
