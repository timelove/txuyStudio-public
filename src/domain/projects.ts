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

/**
 * 项目稳定标识色:按 id hash 派生 hue(0-359),HSL 低饱和/中亮度(莫兰迪感,避免大红大绿
 * 刺眼;深色背景仍可辨)。同一 id 永远同色(跨会话稳定),多个钉住项目并排(顶栏 chip/下拉
 * 列表)时一眼按色区分;hash 碰撞仅颜色相近,无功能影响。用于 ProjectTabs 色条/圆点/
 * 下划线、TopProjectBar 单项目 dot、ShellSidebar 标头。
 */
export function projectAccentColor(id: ProjectId): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 55%)`;
}
