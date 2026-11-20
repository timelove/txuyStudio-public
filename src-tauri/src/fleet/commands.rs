//! Fleet Worker Tauri 命令:create / list / merge / remove / preview。
//!
//! 数据真源是 `ProjectRecord.fleet_workers`(持久化);本层只做 git IO + 记录维护。
//! git 调用全部 `spawn_blocking`(阻塞 IO 不占 async runtime 线程);AppState 锁
//! 「持锁不跨 .await」:短锁内 clone/变更记录,放锁后 save。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::state::{now_ms, AppState, FleetWorkerData, ProjectRecord};

use super::git;
use super::{fleet_branch, UNTRACKED_COPY_LIST};

/// 前端 `FleetWorker` 视图记录(记录 + 实时 diff 统计 + busy 状态)。
/// 统计字段独立于持久化记录:diff 每次列出时现算(cheap,单次 numstat)。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetWorkerView {
    #[serde(flatten)]
    pub record: FleetWorkerData,
    /// 分支 diff 统计:相对主仓 HEAD 的 (文件数, 增行, 删行)。计算失败为 0。
    pub changed_files: usize,
    pub added_lines: u64,
    pub removed_lines: u64,
    /// worktree 目录仍在磁盘上(false = 被外部删除,记录是孤儿)
    pub worktree_exists: bool,
}

/// worker worktree 根目录:`<项目根>-fleet/`。兄弟目录,不进仓库内
/// (放仓库内会被 git 当 untracked + 工具递归扫描)。
fn fleet_root_dir(project_root: &Path) -> PathBuf {
    project_root.parent().unwrap_or(project_root).join(format!(
        "{}-fleet",
        project_root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("project")
    ))
}

/// 从 AppState 短锁取项目记录(clone)。持锁不跨 .await:取完即放。
fn find_project(state: &State<'_, AppState>, project_id: &str) -> Result<ProjectRecord, String> {
    let snap = state.inner.lock().map_err(|e| e.to_string())?;
    snap.projects
        .iter()
        .find(|p| p.id == project_id)
        .cloned()
        .ok_or_else(|| format!("project not found: {project_id}"))
}

/// 短锁取项目根路径字符串(只 clone rootPath,轻量)。
fn project_root_of(state: &State<'_, AppState>, project_id: &str) -> Result<String, String> {
    find_project(state, project_id).map(|p| p.root_path)
}

/// 创建一个 Fleet Worker:`git worktree add` + 拷 untracked 本地文件 + 落记录。
///
/// 不建 tab(建 tab 是前端动作:`handleAddTab(projectId, paneId, kind, worktreePath, branch)`)。
/// taskId 校验:非空、只允许 `[A-Za-z0-9._-]`(它是目录名+分支名组成部分,防路径注入)。
/// 幂等保护:同项目同 taskId 已存在 → Err(前端提示重名)。
#[tauri::command]
pub async fn create_fleet_worker(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    task_id: String,
    provider: String,
) -> Result<FleetWorkerData, String> {
    let task_id = task_id.trim().to_string();
    if task_id.is_empty() {
        return Err("task id is empty".into());
    }
    if !task_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return Err(format!("invalid task id: {task_id} (allowed: letters/digits/._-)"));
    }
    if provider != "claude" && provider != "codex" {
        return Err(format!("invalid provider: {provider} (expected claude|codex)"));
    }

    // 重名检查 + 取项目根(短锁)。
    let root_path = {
        let snap = state.inner.lock().map_err(|e| e.to_string())?;
        let project = snap
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| format!("project not found: {project_id}"))?;
        if project.fleet_workers.iter().any(|w| w.id == task_id) {
            return Err(format!("fleet worker already exists: {task_id}"));
        }
        project.root_path.clone()
    };

    let branch = fleet_branch(&task_id);
    let root = PathBuf::from(&root_path);
    let worktree_path = fleet_root_dir(&root).join(&task_id);

    // git 是阻塞 IO,丢 spawn_blocking。
    let root2 = root.clone();
    let wt = worktree_path.clone();
    let branch2 = branch.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // 前置:主仓必须是 git 仓。脏工作区不阻断(worker 分支从 HEAD 拉出,不含未提交改动,
        // 用户未提交的内容本来就不在任何分支里)。
        git::repo_root(&root2)?;
        git::worktree_add(&root2, &wt, &branch2)?;
        // 拷 untracked 本地文件清单(.env 等)。源缺省跳过,已存在不覆盖(worktree add
        // 不会带出 untracked,不存在「旧文件」场景,防御性判断而已)。
        for rel in UNTRACKED_COPY_LIST {
            let src = root2.join(rel);
            if src.is_file() {
                let dst = wt.join(rel);
                if !dst.exists() {
                    if let Some(parent) = dst.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::copy(&src, &dst);
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    let record = FleetWorkerData {
        id: task_id.clone(),
        project_id: project_id.clone(),
        provider,
        branch: branch.clone(),
        worktree_path: worktree_path.to_string_lossy().into_owned(),
        created_ms: now_ms(),
        tab_id: None,
    };

    // 落记录:短锁 push + clone 快照,放锁后 save。
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        let project = snap
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or_else(|| format!("project not found: {project_id}"))?;
        project.fleet_workers.push(record.clone());
        snap.clone()
    };
    if let Err(e) = crate::state::persistence::save(&app, &snapshot) {
        log::error!("create_fleet_worker: persist failed: {e}");
        return Err(e);
    }
    log::info!("create_fleet_worker: {task_id} -> {} ({branch})", record.worktree_path);
    Ok(record)
}

/// 列出某项目的全部 workers(含实时 diff 统计)。hydrate 之外 FleetPanel 的数据源。
///
/// diff 统计按 worker 逐个 spawn_blocking 太碎:一次 blocking 里全部算完。
#[tauri::command]
pub async fn list_fleet_workers(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<FleetWorkerView>, String> {
    let project = find_project(&state, &project_id)?;
    if project.fleet_workers.is_empty() {
        return Ok(Vec::new());
    }
    let root = PathBuf::from(&project.root_path);

    let workers = project.fleet_workers.clone();
    let views = tauri::async_runtime::spawn_blocking(move || {
        workers
            .into_iter()
            .map(|record| {
                let (changed_files, added_lines, removed_lines) = git::diff_stat(
                    &root,
                    "HEAD",
                    &record.branch,
                )
                .unwrap_or((0, 0, 0));
                let worktree_exists = Path::new(&record.worktree_path).is_dir();
                FleetWorkerView {
                    record,
                    changed_files,
                    added_lines,
                    removed_lines,
                    worktree_exists,
                }
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(views)
}

/// merge 干跑预判:`git merge-tree` 只算冲突文件列表,不动任何东西。
/// 返回 (冲突文件列表, 主仓是否干净)。前端合并确认框的数据源。
/// 旧 git(<2.38)不支持 --write-tree → Err,前端降级提示「直接试合并」。
#[tauri::command]
pub async fn preview_fleet_merge(
    state: State<'_, AppState>,
    project_id: String,
    worker_id: String,
) -> Result<PreviewResult, String> {
    let project = find_project(&state, &project_id)?;
    let root = PathBuf::from(&project.root_path);
    let branch = project
        .fleet_workers
        .iter()
        .find(|w| w.id == worker_id)
        .map(|w| w.branch.clone())
        .ok_or_else(|| format!("fleet worker not found: {worker_id}"))?;

    let (conflicts, dirty) = tauri::async_runtime::spawn_blocking(move || {
        let dirty = git::has_uncommitted(&root)?;
        let conflicts = git::merge_tree_conflicts(&root, "HEAD", &branch)?;
        Ok::<_, String>((conflicts, dirty))
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(PreviewResult { conflicts, dirty })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    /// 冲突文件列表(空 = 可干净合并)
    pub conflicts: Vec<String>,
    /// 主仓当前分支是否有未提交改动(merge 前需用户先提交)
    pub dirty: bool,
}

/// 合并回流:冲突预判 → merge --no-ff → 清理(worktree remove + branch -D + 删记录)。
///
/// 「决策手动、执行自动」的执行侧:前端已展示过 preview 并让用户确认,此命令一把梭。
/// 有冲突时 Err 带冲突文件列表,不动磁盘(merge-tree 干跑发现,未真 merge,无善后)。
/// 主仓脏 → Err(要求先提交,否则 merge 可能与未提交改动搅在一起)。
#[tauri::command]
pub async fn merge_fleet_worker(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    worker_id: String,
) -> Result<(), String> {
    let project = find_project(&state, &project_id)?;
    let root = PathBuf::from(&project.root_path);
    let worker = project
        .fleet_workers
        .iter()
        .find(|w| w.id == worker_id)
        .cloned()
        .ok_or_else(|| format!("fleet worker not found: {worker_id}"))?;

    // 干跑预判 + 真 merge + 清理,一次 blocking 完成(同一 cwd 顺序操作,无并发窗口)。
    let root2 = root.clone();
    let branch = worker.branch.clone();
    let task_id = worker.id.clone();
    let worktree_path = PathBuf::from(&worker.worktree_path);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if git::has_uncommitted(&root2)? {
            return Err("main workspace has uncommitted changes, commit or stash first".into());
        }
        let conflicts = git::merge_tree_conflicts(&root2, "HEAD", &branch)?;
        if !conflicts.is_empty() {
            return Err(format!(
                "merge would conflict on {} file(s): {}",
                conflicts.len(),
                conflicts.join(", ")
            ));
        }
        let msg = format!("merge(fleet): {task_id}");
        git::merge_branch(&root2, &branch, &msg)?;
        // 合并成功 → 清理 worktree + 分支(记录由调用方删)。
        git::worktree_remove(&root2, &worktree_path)?;
        git::branch_delete(&root2, &branch)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    // 失败原因落日志(前端只显示在面板小字,用户报障时日志可查)。
    .map_err(|e| {
        log::warn!("merge_fleet_worker: {worker_id} failed: {e}");
        e
    })?;

    // 删记录 + save。
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        let project = snap
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or_else(|| format!("project not found: {project_id}"))?;
        project.fleet_workers.retain(|w| w.id != worker_id);
        snap.clone()
    };
    if let Err(e) = crate::state::persistence::save(&app, &snapshot) {
        log::error!("merge_fleet_worker: persist failed: {e}");
        return Err(e);
    }
    log::info!("merge_fleet_worker: merged {worker_id} into main and cleaned up");
    Ok(())
}

/// 丢弃 worker:删 worktree(--force 容忍未提交改动)+ 删分支 + 删记录。不做合并。
#[tauri::command]
pub async fn remove_fleet_worker(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    worker_id: String,
) -> Result<(), String> {
    let root_path = project_root_of(&state, &project_id)?;
    let project = find_project(&state, &project_id)?;
    let worker = project
        .fleet_workers
        .iter()
        .find(|w| w.id == worker_id)
        .cloned()
        .ok_or_else(|| format!("fleet worker not found: {worker_id}"))?;

    let root = PathBuf::from(&root_path);
    let worktree_path = PathBuf::from(&worker.worktree_path);
    let branch = worker.branch.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        git::worktree_remove(&root, &worktree_path)?;
        git::branch_delete(&root, &branch)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        log::warn!("remove_fleet_worker: {worker_id} failed: {e}");
        e
    })?;

    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        let project = snap
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or_else(|| format!("project not found: {project_id}"))?;
        project.fleet_workers.retain(|w| w.id != worker_id);
        snap.clone()
    };
    if let Err(e) = crate::state::persistence::save(&app, &snapshot) {
        log::error!("remove_fleet_worker: persist failed: {e}");
        return Err(e);
    }
    log::info!("remove_fleet_worker: discarded {worker_id}");
    Ok(())
}

/// `-fleet/` 目录下、**无 worker 记录**的外部 worktree:其他 AI 会话/工具按同目录
/// 约定建的,或记录丢失的残留。FleetPanel 可列出并一键删除,不用手动敲 git 命令。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalWorktree {
    /// 目录名(显示用,如 "fix-codex")。
    pub name: String,
    pub worktree_path: String,
    /// 分支名(detached HEAD → None;删除时不删分支)。
    pub branch: Option<String>,
    /// 分支相对主仓 HEAD 的 diff 统计(detached 为 0)。
    pub changed_files: usize,
    pub added_lines: u64,
    pub removed_lines: u64,
}

/// 列出外部 worktree:`git worktree list` 里位于 `<根>-fleet/` 直接子级、且不在
/// worker 记录里的条目(目录已被外部删掉的 worktree 不在 git 列表里,自然排除;
/// 记录孤儿由 [`FleetWorkerView::worktree_exists`] 另行警示)。
#[tauri::command]
pub async fn list_external_worktrees(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<ExternalWorktree>, String> {
    let project = find_project(&state, &project_id)?;
    let root = PathBuf::from(&project.root_path);
    let fleet_root = fleet_root_dir(&root).to_string_lossy().to_lowercase();
    let known: Vec<String> = project
        .fleet_workers
        .iter()
        .map(|w| w.worktree_path.to_lowercase())
        .collect();

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ExternalWorktree>, String> {
        let mut out = Vec::new();
        for (path, branch) in git::worktree_list(&root)? {
            // 只认 fleet 根直接子级(主仓根、别处 worktree 不掺和)。
            let parent = Path::new(&path)
                .parent()
                .map(|p| p.to_string_lossy().to_lowercase());
            if parent.as_deref() != Some(fleet_root.as_str()) {
                continue;
            }
            if known.iter().any(|k| *k == path.to_lowercase()) {
                continue;
            }
            let (changed_files, added_lines, removed_lines) = match &branch {
                Some(b) => git::diff_stat(&root, "HEAD", b).unwrap_or((0, 0, 0)),
                None => (0, 0, 0),
            };
            out.push(ExternalWorktree {
                name: Path::new(&path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&path)
                    .to_string(),
                worktree_path: path,
                branch,
                changed_files,
                added_lines,
                removed_lines,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除外部 worktree:`worktree remove`(--force)+ 删分支。无记录可动(不碰 AppState)。
///
/// 安全闸(删除是不可逆动作,双保险):目标必须位于 `<根>-fleet/` 直接子级;
/// branch 若删必须 `fleet/` 前缀——非 fleet 分支一律拒绝,防误删主分支。
/// 目标目录已不存在时幂等继续(只清分支)。
#[tauri::command]
pub async fn remove_external_worktree(
    state: State<'_, AppState>,
    project_id: String,
    worktree_path: String,
    branch: Option<String>,
) -> Result<(), String> {
    if let Some(b) = &branch {
        if !b.starts_with("fleet/") {
            return Err(format!("refuse to delete non-fleet branch: {b}"));
        }
    }
    let root_path = project_root_of(&state, &project_id)?;
    let root = PathBuf::from(&root_path);
    let target = PathBuf::from(&worktree_path);
    if target.exists() {
        let fleet_root = fleet_root_dir(&root)
            .canonicalize()
            .map_err(|e| format!("canonicalize fleet root: {e}"))?;
        let parent = target
            .canonicalize()
            .map_err(|e| format!("canonicalize worktree: {e}"))?
            .parent()
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if parent != fleet_root.to_string_lossy().to_lowercase() {
            return Err("path is not a direct child of the fleet root".into());
        }
    }

    let root2 = root.clone();
    let worktree = target.clone();
    let branch2 = branch.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        git::worktree_remove(&root2, &worktree)?;
        if let Some(b) = branch2 {
            git::branch_delete(&root2, &b)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    log::info!("remove_external_worktree: {worktree_path} cleaned up");
    Ok(())
}

/// 挂载/卸载 worker 的 tab 关联:前端建 tab 后把 tabId 写进记录(关 tab 置 None)。
///
/// hydrate 恢复时前端会把已有 tab 的 tabId 重新绑定;关 tab 时调 `set_fleet_worker_tab
/// (…, None)` 保留 worker 记录(记录不死,可重新挂载新 tab 续聊)。
#[tauri::command]
pub async fn set_fleet_worker_tab(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    worker_id: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        let project = snap
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or_else(|| format!("project not found: {project_id}"))?;
        let worker = project
            .fleet_workers
            .iter_mut()
            .find(|w| w.id == worker_id)
            .ok_or_else(|| format!("fleet worker not found: {worker_id}"))?;
        worker.tab_id = tab_id.clone();
        snap.clone()
    };
    if let Err(e) = crate::state::persistence::save(&app, &snapshot) {
        log::error!("set_fleet_worker_tab: persist failed: {e}");
        return Err(e);
    }
    log::info!("set_fleet_worker_tab: {worker_id} tabId = {tab_id:?}");
    Ok(())
}
