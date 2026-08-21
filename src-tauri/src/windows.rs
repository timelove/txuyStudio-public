//! 独立项目窗口(command 边界)。
//!
//! 阶段4:把某个项目弹出到独立原生 Tauri 窗口。窗口加载同一前端入口,
//! 通过 URL query `?mode=project&projectId=<id>` 告知前端进入单项目模式;
//! 后端 `hydrate_window` 以 `windowLabel` 为权威,独立窗口只返回该单个项目快照。
//!
//! 设计要点:
//! - `windowLabel` 形如 `project-<projectId>`,可预测、可定位,便于 dock back 关窗。
//! - 已存在同 label 窗口 → `set_focus` 复用,不重复创建(避免多窗口指向同一项目)。
//! - 不改 `AppState` 项目归属:项目仍在主窗口列表里,主窗口前端按
//!   `detachedWindowLabel` 标记隐藏;独立窗口是运行期附属,不持久化(重启自动 dock back)。
//! - 后端用 `WebviewWindowBuilder` 建窗,不触 capability 约束(自定义 command 不受其限)。

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::state::{archive_recent, AppState, ProjectRecord};

/// 独立项目窗口 label 前缀。主窗口恒为 `"main"`(tauri.conf.json 默认)。
pub const PROJECT_WINDOW_PREFIX: &str = "project-";

/// 空白工作台窗口 label 前缀(`workspace-2`/`workspace-3`…,编号自增)。
/// 与主窗口同构(完整项目栏 + `+` 菜单),但项目按 ownerWindow 隔离:
/// 各自 `open_project`/历史恢复只影响自己;关窗时其项目归档进最近历史(不持久化重建)。
pub const WORKSPACE_WINDOW_PREFIX: &str = "workspace-";

/// 判定一个 window label 是否为独立项目窗口。
pub fn is_project_window(label: &str) -> bool {
    label.starts_with(PROJECT_WINDOW_PREFIX)
}

/// 判定一个 window label 是否为空白工作台窗口(main 之外的多项目窗口)。
pub fn is_workspace_window(label: &str) -> bool {
    label.starts_with(WORKSPACE_WINDOW_PREFIX)
}

/// 新建一个空白工作台窗口,返回窗口 label。
///
/// - label 取最小未占用编号的 `workspace-<n>`(从 2 起:main 是 1 号语义上的第一个),
///   避免与仍存活的旧工作台窗口冲突。
/// - 建窗参数与 [[open_project_window]] 一致(decorations:false + visible:false 防白屏,
///   前端首帧 `show_window` 显示;URL 带 `?mode=workspace` hint,前端按 label 走多项目模式)。
#[tauri::command]
pub async fn open_new_workspace_window(app: AppHandle) -> Result<String, String> {
    // 找最小未占用的 workspace 编号。
    let mut n: u32 = 2;
    let label = loop {
        let candidate = format!("{WORKSPACE_WINDOW_PREFIX}{n}");
        if app.get_webview_window(&candidate).is_none() {
            break candidate;
        }
        n += 1;
    };

    let url = WebviewUrl::App("?mode=workspace".into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title("txuyStudio")
        .inner_size(1100.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .decorations(false)
        .center()
        .visible(false);

    builder
        .build()
        .map_err(|e| {
            log::error!("open_new_workspace_window: failed to build window {label}: {e}");
            e.to_string()
        })?;

    log::info!("open_new_workspace_window: created {label}");
    Ok(label)
}

/// 把项目弹出为独立原生窗口,返回窗口 label。
///
/// - 校验 `project_id` 存在(读快照),不存在返回 Err。
/// - label = `project-<projectId>`;若该窗口已存在 → `set_focus` 复用,直接返回 label。
/// - 否则 `WebviewWindowBuilder` 建窗:复用主窗口的 `decorations:false`/`center`,
///   尺寸略小于主窗口,标题用项目名,URL 带 `?mode=project&projectId=<id>` hint。
#[tauri::command]
pub async fn open_project_window(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<String, String> {
    // 读快照:校验项目存在 + 取项目名(做窗口标题)。锁作用域内 clone 即释放。
    let project_name = {
        let snap = state.inner.lock().map_err(|e| {
            log::error!("open_project_window: state lock poisoned: {e}");
            e.to_string()
        })?;
        snap.projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.name.clone())
            .ok_or_else(|| {
                log::error!("open_project_window: project not found: {project_id}");
                format!("project not found: {project_id}")
            })?
    };

    let label = format!("{PROJECT_WINDOW_PREFIX}{project_id}");

    // 已存在同 label 窗口 → 聚焦复用,不重复创建。
    if let Some(existing) = app.get_webview_window(&label) {
        log::info!("open_project_window: reusing existing window {label}");
        let _ = existing.set_focus();
        return Ok(label);
    }

    // 建新窗:加载同一前端入口,带 query hint 告知前端进入单项目模式。
    // 关闭事件监听统一在 `lib.rs` 的 `Builder::on_window_event` 全局挂载,
    // 过滤 `project-` 前缀窗口 emit `project-window-closed`(覆盖叉窗/dock-back/app 退出)。
    // visible:false:消除独立窗口的白屏(与主窗口同策略),由前端首帧 show_window 显示。
    // 复用 lib.rs 的兜底机制目前仅覆盖 main,独立窗口依赖前端首帧 show——
    // 独立窗口前端 bundle 已被主窗口加载过(WebView2 缓存),首帧极快,无需兜底定时器。
    let url = WebviewUrl::App(format!("?mode=project&projectId={project_id}").into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(&project_name)
        .inner_size(1100.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .decorations(false)
        .center()
        .visible(false);

    builder
        .build()
        .map_err(|e| {
            log::error!("open_project_window: failed to build window {label}: {e}");
            e.to_string()
        })?;

    log::info!("open_project_window: created window {label} for project {project_id}");
    Ok(label)
}

/// 工作台窗口关闭的归档处理(`lib.rs` 的 `on_window_event` 调用)。
///
/// 该窗口 owner 的项目移入最近项目历史(记录整份归档,布局/claude 会话映射保留,
/// 可从 + 菜单「历史项目」恢复),并 kill 其所有 PTY/claude/codex/shell 会话--
/// 前端直接关窗不走 close_project 流程,后端在此兜底清理。归档(短锁)同步完成,
/// kill 是慢操作,clone 出 projectId 集合后放 async spawn,不阻塞关窗。
/// main 窗口不走此路径(持久工作台,项目跨重启保留)。
pub fn archive_workspace_projects(app: &AppHandle, label: &str) {
    let (snapshot, removed_ids) = {
        let state = app.state::<AppState>();
        let mut guard = match state.inner.lock() {
            Ok(g) => g,
            Err(e) => {
                log::error!("archive_workspace_projects: state lock poisoned: {e}");
                return;
            }
        };
        let removed: Vec<ProjectRecord> = guard
            .projects
            .iter()
            .filter(|p| p.owner_window == label)
            .cloned()
            .collect();
        let removed_ids: Vec<String> = removed.iter().map(|p| p.id.clone()).collect();
        if removed.is_empty() {
            guard.workspace_active.remove(label);
            return;
        }
        guard.projects.retain(|p| p.owner_window != label);
        archive_recent(&mut guard, removed);
        guard.workspace_active.remove(label);
        (guard.clone(), removed_ids)
    };

    log::info!("archive_workspace_projects: archived {} project(s) from {label}", removed_ids.len());
    if let Err(e) = crate::state::persistence::save(app, &snapshot) {
        log::error!("archive_workspace_projects: persist failed: {e}");
    }

    // kill 被归档项目的所有会话(PTY/claude/codex/shell,失败仅 warn)。
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for pid in removed_ids {
            let pty = app.state::<crate::pty::PtyRegistry>();
            if let Err(e) = pty.kill_project(&pid).await {
                log::warn!("archive_workspace_projects: pty kill_project failed for {pid}: {e}");
            }
            let claude = app.state::<crate::claude::ClaudeRegistry>();
            if let Err(e) = claude.kill_project(&pid).await {
                log::warn!("archive_workspace_projects: claude kill_project failed for {pid}: {e}");
            }
            let codex = app.state::<crate::codex::CodexRegistry>();
            if let Err(e) = codex.kill_project(&pid).await {
                log::warn!("archive_workspace_projects: codex kill_project failed for {pid}: {e}");
            }
            let shell = app.state::<crate::shell_run::ShellRunRegistry>();
            if let Err(e) = shell.kill_project(&pid).await {
                log::warn!("archive_workspace_projects: shell kill_project failed for {pid}: {e}");
            }
        }
    });
}

/// 关闭指定独立项目窗口(dock back 时由前端调用)。
/// 仅调用窗口的 `close()`;关闭事件统一由建窗时挂的 `CloseRequested` 监听处理
/// (emit `project-window-closed`),覆盖用户叉窗 / dock-back / app 退出三种情形。
/// 找不到窗口(可能已被直接关掉)→ 幂等返回 Ok:此前窗口关闭时已 emit 过事件,
/// 主窗口标记已被清除,此处无需再 emit。
#[tauri::command]
pub async fn close_project_window(app: AppHandle, window_label: String) -> Result<(), String> {
    match app.get_webview_window(&window_label) {
        Some(win) => {
            win.close().map_err(|e| {
                log::error!("close_project_window: failed to close {window_label}: {e}");
                e.to_string()
            })?;
            log::info!("close_project_window: closed {window_label}");
            Ok(())
        }
        None => {
            log::info!("close_project_window: {window_label} not found, idempotent ok");
            Ok(())
        }
    }
}
