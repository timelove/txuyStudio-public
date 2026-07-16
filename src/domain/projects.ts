import type { WorkspaceSnapshot } from "./workspace";

/**
 * 项目身份：多项目工作台的一个项目。
 *
 * `projectId` 是稳定的业务/安全边界身份（PTY 归属、事件路由都依赖它），
 * 不由路径或名称推导。MVP 阶段先用 mock 提供固定 id，后端接入后由 Rust 生成 UUID。
 */
export type ProjectId = string;
export type SurfaceId = string;
export type WindowLabel = string;

export type ProjectSnapshot = {
  id: ProjectId;
  name: string;
  rootPath: string;
  /** 该项目当前承载的工作区视图（阶段 1 每项目单一 surface）。 */
  workspace: WorkspaceSnapshot;
  /** surface 是否已被弹出为独立窗口；阶段 1 先用此字段占位标记。 */
  detachedWindowLabel?: WindowLabel;
};

/**
 * 应用级状态：主窗口左侧项目列表 + 当前 active 项目。
 *
 * 阶段 1 为纯前端 mock 状态；阶段 2 起由后端 `hydrate_window` 提供。
 */
export type AppSnapshot = {
  projects: ProjectSnapshot[];
  activeProjectId: ProjectId | null;
};
