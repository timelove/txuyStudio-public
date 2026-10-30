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

use crate::state::{archive_recent, AppState, ProjectRecord, WindowBounds};

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

/// 启动时恢复主窗口大小/位置(#132):`lib.rs` setup 在任何 show 之前调用。
///
/// - bounds 以**逻辑像素**存取(前端保存时物理 px / scaleFactor 归一),恢复时 Tauri 按
///   当前窗口 scale_factor 换算物理 px——跨 DPI/换显示器重启近似还原。
/// - 屏外防护:恢复位置前把矩形中心换算为物理 px,校验是否落在任一显示器矩形内;
///   不在(显示器被拔/换布局)→ 只恢复大小、跳过位置,避免窗口出现在不可见区域。
/// - 大小钳制到 tauri.conf.json 的 min(1080x720),防异常小值把窗口卡死。
/// - `maximized` 记忆:最后 set_maximized(true)(还原态 bounds 已先恢复,退出最大化
///   即回到上次 normal 大小,与 VS Code/Chrome 行为一致)。
/// - width=0 的「仅标志」条目:跳过 size/position,只 apply 最大化。
pub fn restore_main_window_bounds(app: &AppHandle, bounds: WindowBounds) {
    let Some(win) = app.get_webview_window("main") else {
        log::warn!("restore_main_window_bounds: main window not found, skip");
        return;
    };
    if bounds.width > 0 && bounds.height > 0 {
        let w = bounds.width.max(1080);
        let h = bounds.height.max(720);
        if let Err(e) = win.set_size(tauri::LogicalSize::new(w as f64, h as f64)) {
            log::warn!("restore_main_window_bounds: set_size failed: {e}");
        }
        // 中心点逻辑 px × 当前 scale = 物理 px,对 available_monitors(物理矩形)校验。
        // 注意 i32 position 与 u32 size 混合运算须统一转 f64(编译器不认 i32+u32)。
        let scale = win.scale_factor().unwrap_or(1.0);
        let cx = (bounds.x as f64 + w as f64 / 2.0) * scale;
        let cy = (bounds.y as f64 + h as f64 / 2.0) * scale;
        let on_screen = win
            .available_monitors()
            .map(|mons| {
                mons.iter().any(|m| {
                    let p = m.position();
                    let s = m.size();
                    let (px, py) = (p.x as f64, p.y as f64);
                    (px..px + s.width as f64).contains(&cx) && (py..py + s.height as f64).contains(&cy)
                })
            })
            .unwrap_or(false);
        if on_screen {
            if let Err(e) = win.set_position(tauri::LogicalPosition::new(bounds.x as f64, bounds.y as f64)) {
                log::warn!("restore_main_window_bounds: set_position failed: {e}");
            }
        } else {
            log::info!("restore_main_window_bounds: saved center off-screen, position skipped");
        }
    }
    if bounds.maximized {
        if let Err(e) = win.maximize() {
            log::warn!("restore_main_window_bounds: maximize failed: {e}");
        }
    }
    log::info!(
        "restore_main_window_bounds: restored {}x{} at ({},{}), maximized={}",
        bounds.width, bounds.height, bounds.x, bounds.y, bounds.maximized
    );
}

/// 主窗口关闭时兜底补存 bounds(#132):`lib.rs` 的 `on_window_event` CloseRequested 调用。
///
/// 前端运行期防抖(350ms)保存为主路径;关窗前最后一段变化(拖完即关等)在此同步补上。
/// 最大化:只更新 `maximized` 标志(x/y/w/h 保留快照里上次 normal 态;无快照则造零尺寸
/// 「仅标志」条目);最小化:跳过(Windows 最小化时 outer_position 是 -32000 假值)。
/// 同步落盘(CloseRequested 后紧接退出流程,没有异步机会);失败仅 warn 不阻断关窗。
pub fn persist_main_bounds_on_close(app: &AppHandle, win: &tauri::Window) {
    if win.is_minimized().unwrap_or(false) {
        return;
    }
    let bounds = if win.is_maximized().unwrap_or(false) {
        // 只报标志:保留已存的 normal bounds(width=0 让 save 走「仅标志」分支)。
        WindowBounds { x: 0, y: 0, width: 0, height: 0, maximized: true }
    } else {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            return;
        };
        let scale = win.scale_factor().unwrap_or(1.0);
        WindowBounds {
            x: (pos.x as f64 / scale).round() as i32,
            y: (pos.y as f64 / scale).round() as i32,
            width: (size.width as f64 / scale).round() as u32,
            height: (size.height as f64 / scale).round() as u32,
            maximized: false,
        }
    };
    let state = app.state::<AppState>();
    let snapshot = match state.inner.lock() {
        Ok(mut snap) => {
            if bounds.width == 0 {
                // 仅标志:原地改 maximized,normal 态字段保留(无记录则存零尺寸条目)。
                match snap.main_window_bounds.as_mut() {
                    Some(b) => b.maximized = bounds.maximized,
                    None => snap.main_window_bounds = Some(bounds),
                }
            } else {
                snap.main_window_bounds = Some(bounds);
            }
            snap.clone()
        }
        Err(e) => {
            log::error!("persist_main_bounds_on_close: state lock poisoned: {e}");
            return;
        }
    };
    if let Err(e) = crate::state::persistence::save(app, &snapshot) {
        log::warn!("persist_main_bounds_on_close: persist failed: {e}");
    }
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

    // kill 被归档项目的所有会话(PTY/claude/codex/shell + fs watcher,失败仅 warn)。
    for pid in removed_ids {
        kill_project_sessions(app, &pid);
    }
}

/// kill 单个项目的全部后端会话:PTY / claude / codex `!` shell + 停 fs watcher。
///
/// 用于直接关窗的兜底(前端 unmount cleanup 不可达):
/// - 工作台窗口归档(archive_workspace_projects);
/// - **独立项目窗口(project-)被叉掉 / dock back**:窗口 JS 来不及发 kill_pty 等命令,
///   此前 PTY/claude/codex/shell 子进程 + PtySession/读线程全部孤儿,detach/dock 循环累积。
///
/// watcher 同步停(短锁 + drop);进程 kill 是慢操作(taskkill /T),spawn 内 await,
/// 不阻塞关窗。失败仅 warn。
pub fn kill_project_sessions(app: &AppHandle, project_id: &str) {
    if app.state::<crate::filetree::FsWatcherRegistry>().stop_project(project_id) {
        log::info!("kill_project_sessions: fs watcher stopped for {project_id}");
    }
    let app = app.clone();
    let pid = project_id.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = app.state::<crate::pty::PtyRegistry>().kill_project(&pid).await {
            log::warn!("kill_project_sessions: pty kill failed for {pid}: {e}");
        }
        if let Err(e) = app.state::<crate::claude::ClaudeRegistry>().kill_project(&pid).await {
            log::warn!("kill_project_sessions: claude kill failed for {pid}: {e}");
        }
        if let Err(e) = app.state::<crate::codex::CodexRegistry>().kill_project(&pid).await {
            log::warn!("kill_project_sessions: codex kill failed for {pid}: {e}");
        }
        if let Err(e) = app.state::<crate::shell_run::ShellRunRegistry>().kill_project(&pid).await {
            log::warn!("kill_project_sessions: shell kill failed for {pid}: {e}");
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
