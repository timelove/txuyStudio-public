//! 应用状态 Tauri command 边界:hydrate / open / close / set_active / save_bounds / save_pane_tree。
//!
//! 约定(与 `pty::commands` 一致):`std::sync::Mutex` 持锁不跨 `.await`——
//! 每个 command 在锁作用域内完成 HashMap/Vec 变更并克隆出要返回的快照,
//! 释放锁后再 `persistence::save` 与返回。

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::persistence;
use super::{default_pane_tree, now_ms, AppState, AppSnapshot, PaneNode, ProjectRecord, WindowBounds};
use crate::pty::PtyRegistry;

/// 启动 hydrate:按 `windowLabel` 返回权威快照。
///
/// - `windowLabel == "main"`(或无 route_hint)→ 返回整份快照(主窗口用)。
/// - `windowLabel` 以 `project-` 开头且 `route_hint` 给了 projectId → 返回**只含该单个项目**
///   的快照(projects 过滤为 1 项,activeProjectId = 该 projectId)。独立项目窗口据此
///   只拿到自己项目的数据,天然隔离。锁作用域内 clone/过滤后即释放,无 `.await` 跨锁。
#[tauri::command]
pub async fn hydrate_window(
    state: State<'_, AppState>,
    window_label: String,
    route_hint: Option<String>,
) -> Result<AppSnapshot, String> {
    let guard = state.inner.lock().map_err(|e| {
        log::error!("hydrate_window: state lock poisoned: {e}");
        e.to_string()
    })?;

    // 独立项目窗口:按 route_hint(projectId)过滤出单个项目。
    if crate::windows::is_project_window(&window_label) {
        if let Some(pid) = route_hint {
            let single = guard
                .projects
                .iter()
                .find(|p| p.id == pid)
                .cloned();
            if let Some(project) = single {
                let mut snap = guard.clone();
                snap.projects = vec![project];
                snap.active_project_id = Some(pid);
                return Ok(snap);
            }
            // route_hint 指向的项目不存在(可能已被删除)→ 回退空快照,
            // 前端会显示空态并提示主窗口。
            log::warn!("hydrate_window: project {pid} not found for window {window_label}, returning empty");
            let mut empty = AppSnapshot::default();
            empty.main_window_bounds = guard.main_window_bounds;
            return Ok(empty);
        }
    }

    Ok(guard.clone())
}

/// 通过系统文件夹选择器添加一个项目。
///
/// 在 Rust 端调起对话框(前端只 invoke 此命令,不触 capability 约束)。
/// 用户取消 → 返回当前快照、不报错;选中目录 → 用末段目录名作项目名,
/// 生成默认单 PowerShell pane tree,设为 active,落盘,返回新快照。
#[tauri::command]
pub async fn open_project(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppSnapshot, String> {
    // blocking_pick_folder 内部走 channel 同步等待回调,不占用 async runtime 线程。
    let picked = app.dialog().file().blocking_pick_folder();
    let folder = match picked.and_then(|f| f.as_path().map(|p| p.to_path_buf())) {
        Some(p) => p,
        None => {
            // 用户取消,返回当前快照,不视为错误。
            log::info!("open_project: user cancelled folder picker");
            return Ok(state.inner.lock().map_err(|e| e.to_string())?.clone());
        }
    };

    let root_path = folder.to_string_lossy().into_owned();
    let name = folder
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("project")
        .to_string();

    let record = ProjectRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        root_path,
        last_opened_ms: now_ms(),
        pane_tree: Some(default_pane_tree()),
    };
    let new_active = record.id.clone();

    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        snap.projects.push(record);
        snap.active_project_id = Some(new_active);
        snap.clone()
    };

    log::info!("open_project: added new project");
    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("open_project: persist failed: {e}");
        return Err(e);
    }
    Ok(snapshot)
}

/// 关闭(移除)一个项目,并 kill 该项目下所有 PTY 会话。
///
/// 顺序:先落盘后 kill——落盘快速且确定,保证崩溃一致(重启后项目不复活、PTY 无归属);
/// kill 是慢操作(spawn_blocking kill+wait),先 kill 再落盘会留「项目仍在但 PTY 已死」中间态。
/// kill 失败仅 warn 不阻断返回(PTY 残留为孤儿,不影响功能,重启后 registry 空)。
/// 若移除的是当前 active,则 active 落到列表首项或 None。
#[tauri::command]
pub async fn close_project(
    app: AppHandle,
    state: State<'_, AppState>,
    pty: State<'_, PtyRegistry>,
    project_id: String,
) -> Result<AppSnapshot, String> {
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        let before = snap.projects.len();
        snap.projects.retain(|p| p.id != project_id);
        if snap.projects.len() == before {
            // 没有匹配项,仍返回当前快照(幂等)。仍尝试 kill_project,兜底清理可能的孤儿 PTY。
            log::info!("close_project: no project matched {project_id}, idempotent");
        }
        let was_active = snap.active_project_id.as_deref() == Some(project_id.as_str());
        if was_active {
            snap.active_project_id = snap.projects.first().map(|p| p.id.clone());
        }
        snap.clone()
    };

    log::info!("close_project: removed {project_id}");
    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("close_project: persist failed: {e}");
        return Err(e);
    }

    // kill 该项目所有 PTY(短锁 remove 桶 + spawn_blocking kill/wait)。失败不阻断。
    if let Err(e) = pty.kill_project(&project_id).await {
        log::warn!("close_project: kill_project failed for {project_id}: {e}");
    }

    Ok(snapshot)
}

/// 设置当前 active 项目(驱动顶部项目下拉高亮 + 左栏/分屏内容)。
#[tauri::command]
pub async fn set_active_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<AppSnapshot, String> {
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        if !snap.projects.iter().any(|p| p.id == project_id) {
            log::error!("set_active_project: project not found: {project_id}");
            return Err(format!("project not found: {project_id}"));
        }
        snap.active_project_id = Some(project_id.clone());
        snap.clone()
    };

    log::info!("set_active_project: active = {project_id}");
    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("set_active_project: persist failed: {e}");
        return Err(e);
    }
    Ok(snapshot)
}

/// 设置界面语言偏好("zh"/"en"),持久化到 state.json。
///
/// 仿 [[set_active_project]] 三段式:短锁改 locale + 克隆 + 释放锁 + save + 返回克隆。
/// `locale` 不做白名单校验(前端只给 zh/en,后端仅作透传存储;非 Tauri 环境 invoke 失败
/// 由前端 catch 降级,本地仍切,不阻断用户体验)。
#[tauri::command]
pub async fn set_locale(
    app: AppHandle,
    state: State<'_, AppState>,
    locale: String,
) -> Result<AppSnapshot, String> {
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        snap.locale = Some(locale.clone());
        snap.clone()
    };

    log::info!("set_locale: locale = {locale}");
    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("set_locale: persist failed: {e}");
        return Err(e);
    }
    Ok(snapshot)
}

/// 持久化主窗口大小/位置。
///
/// 阶段2 仅存 main 窗口 bounds;`windowLabel` 非 "main" 时忽略,
/// 预留给阶段4/5 的独立项目窗口。
#[tauri::command]
pub async fn save_window_bounds(
    app: AppHandle,
    state: State<'_, AppState>,
    window_label: String,
    bounds: WindowBounds,
) -> Result<(), String> {
    if window_label != "main" {
        return Ok(());
    }

    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        snap.main_window_bounds = Some(bounds);
        snap.clone()
    };

    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("save_window_bounds: persist failed: {e}");
        return Err(e);
    }
    Ok(())
}

/// 持久化某项目的分屏 pane tree(前端分屏/关闭/新建后调用)。
///
/// 找不到项目返回 Err;否则更新 `pane_tree` 并落盘。PTY 进程不在此处理——
/// 前端各自管理 transport 的 spawn/kill,本命令只存布局配置。
#[tauri::command]
pub async fn save_pane_tree(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    pane_tree: PaneNode,
) -> Result<(), String> {
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        let project = snap
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or_else(|| {
                log::error!("save_pane_tree: project not found: {project_id}");
                format!("project not found: {project_id}")
            })?;
        project.pane_tree = Some(pane_tree);
        snap.clone()
    };

    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("save_pane_tree: persist failed: {e}");
        return Err(e);
    }
    log::info!("save_pane_tree: updated tree for {project_id}");
    Ok(())
}
