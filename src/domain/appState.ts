import type { ProjectId } from "./projects";
import type { PaneNode } from "./paneTree";

/**
 * 后端 `AppSnapshot` 的前端镜像（与 Rust `state::mod` 类型对齐，camelCase）。
 *
 * 这是「精简身份层」：只持久化项目身份与面板配置，不含 transcript、运行状态、
 * git 信息。前端用 [[deriveProjectSnapshot]] 把它派生为带完整 WorkspaceSnapshot
 * 的运行时模型供 UI 消费。
 */

/** 单个终端面板的持久化配置。kind 见 [[SessionKind]]。 */
export type PaneConfig = {
  paneId: string;
  name: string;
  kind: "claude" | "codex" | "shell" | "test" | "lazygit" | "fresh" | "yazi" | "sessionbrowser";
  command: string;
};

/** 单个项目的持久化记录（身份层）。 */
export type ProjectRecord = {
  id: ProjectId;
  name: string;
  rootPath: string;
  lastOpenedMs: number;
  /** 分屏布局（WT 式 pane tree）。旧数据可能为空，前端 deriver 回退默认单 PowerShell pane。 */
  paneTree?: PaneNode;
};

/** 原生窗口大小/位置。 */
export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** `hydrate_window` 等命令返回的应用快照。 */
export type BackendAppSnapshot = {
  projects: ProjectRecord[];
  activeProjectId: ProjectId | null;
  mainWindowBounds?: WindowBounds;
  /** 界面语言偏好("zh"/"en");undefined/未设 = 跟随系统(前端按 navigator.language 推断)。 */
  locale?: string | null;
};
