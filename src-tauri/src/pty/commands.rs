//! PTY Tauri command 边界：spawn / write / resize / kill。
//!
//! spawn 核心逻辑(ConPTY 初始化脚本/幂等 attach/合批读循环)已抽至
//! `txuy-core::pty::session`(P0);本文件只做 Tauri 胶水——State 解包、
//! `app.emit("pty-output")` 输出回调注入、内置 oh-my-posh 资源路径解析
//! (resource_dir 是 Tauri 打包概念)。进程/路径工具经 `txuy-core::proc`
//! re-export,claude/codex/shell_run/system 模块的既有引用路径不变。
//!
//! 不变量:前端必须先 `listen("pty-output")` 再 `invoke("spawn_pty")`,避免丢首批输出。

use std::path::PathBuf;

use portable_pty::PtySize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::{PtyOutput, PtyRegistry, PtyOutputSink, PtySpawnConfig};

// 跨模块共用工具的稳定 re-export(claude/codex/shell_run/system 的既有
// `crate::pty::commands::*` 引用零改动;实现在 txuy-core::proc)。
pub(crate) use txuy_core::proc::{
    command_no_window, pick_shell, resolve_on_path, strip_verbatim_prefix, validate_cwd,
};
pub(crate) use txuy_core::pty::session::{PATH_REFRESH_PS, PNPM_WRAPPER_PS};

/// 定位应用内置的 oh-my-posh 二进制与主题文件。
///
/// 从 Tauri resource_dir 取 `resources/oh-my-posh.exe` 与 `resources/txuy-theme.omp.json`，
/// 两者都存在则返回 `(exe, theme)`；任一缺失返回 None（调用方退回裸 prompt hook）。
/// **不探测本机 PATH**：无条件优先用内置资源，保证任意 Windows 机器体验一致。
///
/// dev 模式下 resource_dir 指向 `src-tauri/` 本身，`resources/` 子路径与 build 产物一致。
fn bundled_omp_paths(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let resource_dir = app.path().resource_dir().ok()?;
    let exe = resource_dir.join("resources").join("oh-my-posh.exe");
    let theme = resource_dir.join("resources").join("txuy-theme.omp.json");
    if !exe.is_file() || !theme.is_file() {
        return None;
    }
    // resource_dir 在 Windows 上可能返回 `\\?\` verbatim 前缀，ConPTY/PowerShell 处理
    // verbatim 路径有问题，喂给 PowerShell 前用既有 strip_verbatim_prefix 剥离。
    Some((
        strip_verbatim_prefix(&exe),
        strip_verbatim_prefix(&theme),
    ))
}

/// 启动一个 PTY 会话，返回 sessionId。后台线程读取 shell 输出并 emit `pty-output`。
///
/// 参数语义详见 `txuy_core::pty::session::PtySpawnConfig`(project_id/cwd 校验/shell_kind
/// 自动启动 CLI/确定性 session_id 的幂等 attach)。
#[tauri::command]
pub async fn spawn_pty(
    app: AppHandle,
    state: State<'_, PtyRegistry>,
    project_id: String,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    shell_kind: Option<String>,
    launch_override: Option<String>,
    // 确定性会话 key(前端传 tabId,跨 WebView 重载稳定)。
    session_id: Option<String>,
) -> Result<String, String> {
    // 输出回调注入:core 读循环经 sink 送出,壳侧转 tauri 事件(前端 listen 消费)。
    let emit_app = app.clone();
    let sink: PtyOutputSink = std::sync::Arc::new(move |out: PtyOutput| {
        let _ = emit_app.emit("pty-output", out);
    });
    let cfg = PtySpawnConfig {
        project_id,
        rows,
        cols,
        cwd,
        shell_kind,
        launch_override,
        session_id,
        omp: bundled_omp_paths(&app),
    };
    txuy_core::pty::session::spawn_pty_session(&state, cfg, sink).await
}

/// 向指定会话写入用户输入（键盘按键）。
#[tauri::command]
pub async fn write_pty(
    state: State<'_, PtyRegistry>,
    project_id: String,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
    let sessions = by_project
        .get_mut(&project_id)
        .ok_or_else(|| format!("project not found: {project_id}"))?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// 调整会话尺寸（窗口/面板缩放时）。
#[tauri::command]
pub async fn resize_pty(
    state: State<'_, PtyRegistry>,
    project_id: String,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
    let sessions = by_project
        .get_mut(&project_id)
        .ok_or_else(|| format!("project not found: {project_id}"))?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 关闭并清理会话：先从注册表移除（释放全局锁），再 spawn_blocking 执行 kill/wait。
///
/// 关键：`child.kill()/wait()` 是阻塞操作，若在持锁时执行会卡住其它 pane 的
/// write/resize/kill；因此只在一个极短锁作用域内 `remove`，拿到 session 后立即放锁，
/// 再把阻塞的 kill/wait 丢到 spawn_blocking 线程。session drop 时 master 一并释放，
/// reader 线程随之收到 EOF 退出。
#[tauri::command]
pub async fn kill_pty(
    state: State<'_, PtyRegistry>,
    project_id: String,
    session_id: String,
) -> Result<(), String> {
    // 短锁作用域：仅 remove，绝不持锁做阻塞工作。
    let mut session = {
        let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        let sessions = by_project
            .get_mut(&project_id)
            .ok_or_else(|| format!("project not found: {project_id}"))?;
        sessions
            .remove(&session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };

    // 阻塞的杀树+收尸放 spawn_blocking,避免阻塞 async runtime 与全局 PTY 锁。
    tokio::task::spawn_blocking(move || {
        txuy_core::proc::kill_pty_child_tree(&mut session.child);
        log::info!("kill_pty: session {session_id} closed");
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}
