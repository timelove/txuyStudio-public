import { invoke } from "@tauri-apps/api/core";
import type { PaneNode } from "./paneTree";
import { findPane } from "./paneTree";

/**
 * Fleet Worker 领域类型与后端命令封装(worktree 隔离的多 AI 并行会话)。
 *
 * worker = 自带 git worktree 的 claude/codex 会话;类型与 `src-tauri/src/fleet/commands.rs`
 * 的 `FleetWorkerData`/`FleetWorkerView` 镜像(camelCase 对齐,同 appState.ts 先例)。
 * 磁盘 worktree 在项目外兄弟目录 `<项目根>-fleet/<taskId>`,分支 `fleet/<taskId>`。
 */

/** 持久化记录(与后端 FleetWorkerData 镜像;存 ProjectRecord.fleet_workers)。 */
export type FleetWorker = {
  id: string;
  projectId: string;
  /** "claude" | "codex" */
  provider: string;
  /** 分支名,固定 `fleet/<taskId>`。 */
  branch: string;
  worktreePath: string;
  createdMs: number;
  tabId?: string | null;
};

/** list_fleet_workers 的视图记录(记录 + 实时 diff 统计)。 */
export type FleetWorkerView = FleetWorker & {
  /** 分支相对主仓 HEAD 的 diff 文件数;git 失败为 0。 */
  changedFiles: number;
  addedLines: number;
  removedLines: number;
  /** worktree 目录仍在磁盘上(false = 被外部删除,记录是孤儿)。 */
  worktreeExists: boolean;
};

/** preview_fleet_merge 的返回:冲突预判 + 主仓干净度。 */
export type FleetMergePreview = {
  /** 冲突文件列表(空 = 可干净合并)。 */
  conflicts: string[];
  /** 主仓当前分支是否有未提交改动(merge 前需用户先提交)。 */
  dirty: boolean;
};

/** 创建 worker(worktree add + 拷 untracked 清单 + 落记录)。非 git 仓项目 Err。 */
export async function createFleetWorker(projectId: string, taskId: string, provider: "claude" | "codex"): Promise<FleetWorker> {
  return invoke<FleetWorker>("create_fleet_worker", { projectId, taskId, provider });
}

/** 列出某项目的全部 workers(含实时 diff 统计)。FleetPanel 的数据源。 */
export async function listFleetWorkers(projectId: string): Promise<FleetWorkerView[]> {
  return invoke<FleetWorkerView[]>("list_fleet_workers", { projectId });
}

/** merge 干跑预判(不动任何东西)。旧 git(<2.38)Err,调用方降级提示。 */
export async function previewFleetMerge(projectId: string, workerId: string): Promise<FleetMergePreview> {
  return invoke<FleetMergePreview>("preview_fleet_merge", { projectId, workerId });
}

/** 合并回流(冲突预判 → merge --no-ff → 清理 worktree/分支/记录)。 */
export async function mergeFleetWorker(projectId: string, workerId: string): Promise<void> {
  return invoke<void>("merge_fleet_worker", { projectId, workerId });
}

/** 丢弃 worker(删 worktree + 删分支 + 删记录,不合并)。 */
export async function removeFleetWorker(projectId: string, workerId: string): Promise<void> {
  return invoke<void>("remove_fleet_worker", { projectId, workerId });
}

/** `-fleet/` 目录下、无 worker 记录的外部 worktree(其他 AI 会话/工具按同目录约定建的)。 */
export type ExternalWorktree = {
  /** 目录名(显示用,如 "fix-codex")。 */
  name: string;
  worktreePath: string;
  /** 分支名;detached HEAD → null(删除时不删分支)。 */
  branch: string | null;
  changedFiles: number;
  addedLines: number;
  removedLines: number;
};

/** 列出外部 worktree(FleetPanel「外部 worktree」节的数据源)。 */
export async function listExternalWorktrees(projectId: string): Promise<ExternalWorktree[]> {
  return invoke<ExternalWorktree[]>("list_external_worktrees", { projectId });
}

/** 删除外部 worktree(worktree remove --force + 删 fleet/ 分支;无记录可动)。 */
export async function removeExternalWorktree(
  projectId: string,
  worktreePath: string,
  branch: string | null,
): Promise<void> {
  return invoke<void>("remove_external_worktree", { projectId, worktreePath, branch });
}

/** 挂载/卸载 worker 的 tab 关联(建 tab 后绑定 tabId;关 tab 置 null 保留记录)。 */
export async function setFleetWorkerTab(projectId: string, workerId: string, tabId: string | null): Promise<void> {
  return invoke<void>("set_fleet_worker_tab", { projectId, workerId, tabId });
}

/**
 * Fleet Worker 前缀(fleet/<taskId> 分支名)。tab title 以此开头 = worker tab。
 * 创建流程显式把 worker tab 的 title 设为分支名(落盘,hydrate 后依然生效),
 * 以此为零接线判据,与 ClaudeTabChip/CodexTabChip 的 Fleet 徽标同口径。
 */
export const FLEET_BRANCH_PREFIX = "fleet/";

/**
 * 该 pane 的「Fleet 继承 cwd」:活动 tab 是 worker(fleet/ 分支)时返回其
 * worktree 路径,否则 undefined(调用方回退默认 cwd,如项目根)。
 *
 * 与普通 pane 的既有设计(新 tab 不继承活动 tab 的 cwd)对立面的定向突破:
 * 仅 fleet pane 内新建终端/AI tab 时继承 worktree,让「worker 旁边开的
 * shell/claude」天然落在同一 worktree;notes(cwd 是文件路径)与
 * SessionBrowser 恢复(pendingResume 注入)不受影响——它们有显式 override。
 */
export function fleetPaneCwd(tree: PaneNode, paneId: string): string | undefined {
  const pane = findPane(tree, paneId);
  if (!pane) return undefined;
  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
  if (!activeTab) return undefined;
  if (!activeTab.title.startsWith(FLEET_BRANCH_PREFIX)) return undefined;
  return activeTab.cwd ?? undefined;
}
