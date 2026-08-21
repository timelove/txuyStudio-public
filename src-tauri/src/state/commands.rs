//! 应用状态 Tauri command 边界:hydrate / open / close / set_active / save_bounds / save_pane_tree。
//!
//! 约定(与 `pty::commands` 一致):`std::sync::Mutex` 持锁不跨 `.await`——
//! 每个 command 在锁作用域内完成 HashMap/Vec 变更并克隆出要返回的快照,
//! 释放锁后再 `persistence::save` 与返回。

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::persistence;
use super::{
    archive_recent, collect_tab_ids, default_pane_tree, now_ms, set_active_for_window, AppState,
    AppSnapshot, PaneNode, ProjectRecord, WindowBounds,
};
use crate::claude::ClaudeRegistry;
use crate::pty::PtyRegistry;

/// 启动 hydrate:按 `windowLabel` 返回权威快照。
///
/// - `windowLabel == "main"` 或 `workspace-N`(工作台窗口)→ 返回本窗口拥有的项目
///   (ownerWindow 匹配;main 兼容旧数据全量)+ 全量最近项目历史;active 按窗口取。
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

    // 工作台窗口(main / workspace-N):只回本窗口拥有的项目;active 按窗口取并校验。
    // (recent_projects 历史全量附带,各窗口的 + 菜单都能看到、都能恢复。)
    let mut snap = guard.clone();
    snap.projects.retain(|p| p.owner_window == window_label);
    let active = if window_label == "main" {
        snap.active_project_id.clone()
    } else {
        snap.workspace_active.get(&window_label).cloned()
    };
    // active 失效(指向他窗项目/已删项目)-> 回退本窗口首项或 None。
    snap.active_project_id = match active {
        Some(a) if snap.projects.iter().any(|p| p.id == a) => Some(a),
        _ => snap.projects.first().map(|p| p.id.clone()),
    };
    Ok(snap)
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
    window_label: Option<String>,
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

    let owner = window_label.unwrap_or_else(|| "main".to_string());
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
        owner_window: owner.clone(),
        last_opened_ms: now_ms(),
        pane_tree: Some(default_pane_tree()),
        claude_allowed_tools: Vec::new(),
        claude_tab_sessions: Default::default(),
    };
    let new_active = record.id.clone();

    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        // 历史去重:项目回到打开列表,同 rootPath 的历史条目移除。
        snap.recent_projects.retain(|p| p.root_path != record.root_path);
        snap.projects.push(record);
        set_active_for_window(&mut snap, &owner, &new_active);
        snap.clone()
    };

    log::info!("open_project: added new project");
    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("open_project: persist failed: {e}");
        return Err(e);
    }
    Ok(snapshot)
}

/// 关闭(移除)一个项目,并 kill 该项目下所有 PTY 会话与 claude 会话。
///
/// 顺序:先落盘后 kill——落盘快速且确定,保证崩溃一致(重启后项目不复活、PTY/claude 无归属);
/// kill 是慢操作(spawn_blocking kill+wait),先 kill 再落盘会留「项目仍在但会话已死」中间态。
/// kill 失败仅 warn 不阻断返回(残留为孤儿,不影响功能,重启后 registry 空)。
/// 若移除的是当前 active,则 active 落到列表首项或 None。
#[tauri::command]
pub async fn close_project(
    app: AppHandle,
    state: State<'_, AppState>,
    pty: State<'_, PtyRegistry>,
    claude: State<'_, ClaudeRegistry>,
    codex: State<'_, crate::codex::CodexRegistry>,
    shell: State<'_, crate::shell_run::ShellRunRegistry>,
    project_id: String,
) -> Result<AppSnapshot, String> {
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        let before = snap.projects.len();
        // 先取出被移除的记录:整份归档进最近项目历史(id/布局/claude 会话映射保留,
        // 历史恢复时原样移回 projects),+ 菜单「历史项目」据此可恢复。
        let removed: Vec<ProjectRecord> = snap
            .projects
            .iter()
            .filter(|p| p.id == project_id)
            .cloned()
            .collect();
        snap.projects.retain(|p| p.id != project_id);
        if snap.projects.len() == before {
            // 没有匹配项,仍返回当前快照(幂等)。仍尝试 kill_project,兜底清理可能的孤儿 PTY。
            log::info!("close_project: no project matched {project_id}, idempotent");
        }
        archive_recent(&mut snap, removed);
        let was_active = snap.active_project_id.as_deref() == Some(project_id.as_str());
        if was_active {
            // active 落到本窗口(main)剩余首项或 None。
            snap.active_project_id = snap
                .projects
                .iter()
                .find(|p| p.owner_window == "main")
                .map(|p| p.id.clone());
        }
        // 各工作台窗口的 active 若指向被删项目:回退到该窗口剩余首项,没有则清掉。
        let stale_labels: Vec<String> = snap
            .workspace_active
            .iter()
            .filter(|(_, pid)| pid.as_str() == project_id.as_str())
            .map(|(l, _)| l.clone())
            .collect();
        for label in stale_labels {
            let fallback = snap
                .projects
                .iter()
                .find(|p| p.owner_window == label)
                .map(|p| p.id.clone());
            match fallback {
                Some(id) => {
                    snap.workspace_active.insert(label, id);
                }
                None => {
                    snap.workspace_active.remove(&label);
                }
            }
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
    // 同步 kill 该项目所有 claude 自渲染会话(与 PTY 同模式)。失败不阻断。
    if let Err(e) = claude.kill_project(&project_id).await {
        log::warn!("close_project: claude kill_project failed for {project_id}: {e}");
    }
    // 同步 kill 该项目所有 codex 自渲染会话(与 claude 同模式)。失败不阻断。
    if let Err(e) = codex.kill_project(&project_id).await {
        log::warn!("close_project: codex kill_project failed for {project_id}: {e}");
    }
    // 同步 kill 该项目所有 `!` 命令进程(与 PTY/claude 同模式)。失败不阻断。
    if let Err(e) = shell.kill_project(&project_id).await {
        log::warn!("close_project: shell kill_project failed for {project_id}: {e}");
    }

    Ok(snapshot)
}

/// 从最近项目历史恢复一个项目(rootPath 定位),整份记录原样移回 `projects`。
///
/// 历史条目保留了 id/pane tree/claude 会话映射,恢复 = 回到关闭前的状态(布局还原、
/// claude 可 --resume 续接)。归属窗口取调用方 `window_label`(缺省 main),
/// 恢复后设为该窗口 active。找不到匹配 rootPath -> Err(前端提示)。
#[tauri::command]
pub async fn open_recent_project(
    app: AppHandle,
    state: State<'_, AppState>,
    root_path: String,
    window_label: Option<String>,
) -> Result<AppSnapshot, String> {
    let owner = window_label.unwrap_or_else(|| "main".to_string());
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| {
            log::error!("open_recent_project: state lock poisoned: {e}");
            e.to_string()
        })?;
        let idx = snap
            .recent_projects
            .iter()
            .position(|p| p.root_path == root_path)
            .ok_or_else(|| {
                log::error!("open_recent_project: no recent project at {root_path}");
                format!("no recent project at {root_path}")
            })?;
        let mut record = snap.recent_projects.remove(idx);
        record.owner_window = owner.clone();
        record.last_opened_ms = now_ms();
        let new_active = record.id.clone();
        snap.projects.push(record);
        set_active_for_window(&mut snap, &owner, &new_active);
        snap.clone()
    };

    log::info!("open_recent_project: restored {root_path} to window {owner}");
    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("open_recent_project: persist failed: {e}");
        return Err(e);
    }
    Ok(snapshot)
}

/// 从最近项目历史删除一个条目(rootPath 定位;+ 菜单历史项的 ✕)。
///
/// 只删历史记录,不影响任何打开中的项目;幂等(无匹配也返回当前快照)。
#[tauri::command]
pub async fn remove_recent_project(
    app: AppHandle,
    state: State<'_, AppState>,
    root_path: String,
) -> Result<AppSnapshot, String> {
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| {
            log::error!("remove_recent_project: state lock poisoned: {e}");
            e.to_string()
        })?;
        snap.recent_projects.retain(|p| p.root_path != root_path);
        snap.clone()
    };

    log::info!("remove_recent_project: removed {root_path}");
    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("remove_recent_project: persist failed: {e}");
        return Err(e);
    }
    Ok(snapshot)
}

/// 设置当前 active 项目(驱动顶部项目下拉高亮 + 左栏/分屏内容)。
#[tauri::command]
pub async fn set_active_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    window_label: Option<String>,
) -> Result<AppSnapshot, String> {
    let owner = window_label.unwrap_or_else(|| "main".to_string());
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        if !snap.projects.iter().any(|p| p.id == project_id) {
            log::error!("set_active_project: project not found: {project_id}");
            return Err(format!("project not found: {project_id}"));
        }
        set_active_for_window(&mut snap, &owner, &project_id);
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

/// 设置终端 + Monaco 编辑器字体大小(px),持久化到 state.json。
///
/// 仿 [[set_locale]] 三段式:短锁改 `terminal_font_size` + 克隆 + 释放锁 + save + 返回克隆。
/// 前端已 clamp 到 `10..=22`;后端仅透传存储,不做范围校验(非 Tauri 环境 invoke 失败由前端
/// catch 降级,本地仍切,不阻断)。
#[tauri::command]
pub async fn set_terminal_font_size(
    app: AppHandle,
    state: State<'_, AppState>,
    font_size: u32,
) -> Result<AppSnapshot, String> {
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        snap.terminal_font_size = Some(font_size);
        snap.clone()
    };

    log::info!("set_terminal_font_size: font_size = {font_size}");
    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("set_terminal_font_size: persist failed: {e}");
        return Err(e);
    }
    Ok(snapshot)
}

/// 设置界面主题 id("midnight"/"one-dark"),持久化到 state.json。
///
/// 仿 [[set_locale]] 三段式:短锁改 `theme_id` + 克隆 + 释放锁 + save + 返回。
/// 不做白名单校验(前端只给已知 id;后端仅透传存储;非 Tauri 环境 invoke 失败由前端
/// catch 降级,本地仍切,不阻断)。
#[tauri::command]
pub async fn set_theme(
    app: AppHandle,
    state: State<'_, AppState>,
    theme_id: String,
) -> Result<AppSnapshot, String> {
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        snap.theme_id = Some(theme_id.clone());
        snap.clone()
    };

    log::info!("set_theme: theme_id = {theme_id}");
    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("set_theme: persist failed: {e}");
        return Err(e);
    }
    Ok(snapshot)
}

/// 设置 Codex 会话默认 sandbox 档位(codex exec -s),持久化到 state.json。
///
/// 仿 [[set_theme]] 三段式:短锁改 `codex_sandbox` + 克隆 + 释放锁 + save + 返回。
/// 不做白名单校验(前端只给已知档位;后端仅透传存储)。仅影响新建 codex 会话的初始档,
/// 已开会话不跟随(transport 内部档位独立,状态栏可单独切)。
#[tauri::command]
pub async fn set_codex_sandbox(
    app: AppHandle,
    state: State<'_, AppState>,
    sandbox: String,
) -> Result<AppSnapshot, String> {
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        snap.codex_sandbox = Some(sandbox.clone());
        snap.clone()
    };

    log::info!("set_codex_sandbox: sandbox = {sandbox}");
    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("set_codex_sandbox: persist failed: {e}");
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
        let live_ids: std::collections::HashSet<String> =
            collect_tab_ids(&pane_tree).into_iter().collect();
        project.pane_tree = Some(pane_tree);
        // 修剪 claude_tab_sessions:移除新 tree 中已不存在的 tab(关 tab 后其 session_id 不再需要)。
        project.claude_tab_sessions.retain(|tid, _| live_ids.contains(tid));
        snap.clone()
    };

    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("save_pane_tree: persist failed: {e}");
        return Err(e);
    }
    log::info!("save_pane_tree: updated tree for {project_id}");
    Ok(())
}

/// 给某项目累加一个 Claude 工具白名单条目(用户在确认框点「批准且不再问」时调用)。
///
/// 仿 [[save_pane_tree]] 三段式:短锁找项目 + push(去重)+ 克隆 + 释放锁 + save + 返回。
/// 下次 `start_claude_session`(重启)会读 `claude_allowed_tools` 拼成 `--allowedTools`,该工具免确认。
#[tauri::command]
pub async fn add_claude_allowed_tool(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    tool: String,
) -> Result<(), String> {
    let snapshot = {
        let mut snap = state.inner.lock().map_err(|e| e.to_string())?;
        let project = snap
            .projects
            .iter_mut()
            .find(|p| p.id == project_id)
            .ok_or_else(|| {
                log::error!("add_claude_allowed_tool: project not found: {project_id}");
                format!("project not found: {project_id}")
            })?;
        if !project.claude_allowed_tools.contains(&tool) {
            project.claude_allowed_tools.push(tool.clone());
        }
        snap.clone()
    };

    if let Err(e) = persistence::save(&app, &snapshot) {
        log::error!("add_claude_allowed_tool: persist failed: {e}");
        return Err(e);
    }
    log::info!("add_claude_allowed_tool: {project_id} += {tool}");
    Ok(())
}
