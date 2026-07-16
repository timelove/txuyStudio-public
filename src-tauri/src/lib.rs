mod filetree;
mod pty;
mod state;
mod system;
mod windows;

use filetree::commands::{list_dir, read_file, start_fs_watch, stop_fs_watch, write_file};
use filetree::FsWatcherRegistry;
use log::LevelFilter;
use pty::commands::{kill_pty, resize_pty, spawn_pty, write_pty};
use pty::PtyRegistry;
use state::commands::{
    close_project, hydrate_window, open_project, save_pane_tree, save_window_bounds,
    set_active_project, set_locale, set_terminal_font_size,
};
use system::commands::{
    check_commands_installed, delete_ai_cli_session, get_ai_cli_session_messages, get_git_branch,
    get_system_memory, list_ai_cli_providers, list_ai_cli_sessions,
};
use tauri::{Emitter, Manager};
use tauri_plugin_log::{Builder as LogBuilder, Target, TargetKind};
use windows::{close_project_window, open_project_window};

/// 解析日志落盘目录，按优先级返回首个**可写**目录（`None` 表示无可用目录）：
///
/// 1. 可执行文件同级的 `logs/`（即安装目录内，便携：程序装哪日志就在哪）；
/// 2. Tauri 标准 `app_log_dir()`（Windows 下 `%LOCALAPPDATA%\com.txuystudio.terminal\logs`，
///    跨机器稳定可写）；
/// 3. 均不可写 → `None`（调用方降级为仅 stdout/webview，绝不阻断启动）。
///
/// 可写性用 `is_writable` 试写探测，而非仅 `create_dir_all`：Program Files 等受保护目录下，
/// 普通用户对已存在目录 `create_dir_all` 可能成功但写文件仍失败，必须试写确认。
///
/// 注意：perMachine MSI 装到 `Program Files\txuyStudio` 时，普通用户对安装目录无写权限，
/// 第 1 项会失败而降级到第 2 项（`%LOCALAPPDATA%`）。若希望日志真正落到安装目录，
/// 需用 perUser 安装（NSIS 默认 currentUser）或装到用户可写位置。
///
/// 绝不能用编译期 `env!("CARGO_MANIFEST_DIR")`：那会把开发机源码路径编译进二进制，
/// 装到别的机器后目录不可创建，令 `tauri-plugin-log` 的 `Builder::setup` 失败 → 闪退。
fn resolve_log_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    // 1. 安装目录内 `logs/`（可执行文件同级）。
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
    {
        let install_logs = exe_dir.join("logs");
        if is_writable(&install_logs) {
            return Some(install_logs);
        }
    }
    // 2. Tauri 标准日志目录（%LOCALAPPDATA%）。
    if let Ok(p) = app.path().app_log_dir() {
        if is_writable(&p) {
            return Some(p);
        }
    }
    None
}

/// 探测目录可写性：先 `create_dir_all`，再试写一个临时文件确认。
/// 仅 `create_dir_all` 成功不足以下结论——受保护目录可能目录已存在、能建子目录但写文件被拒。
fn is_writable(dir: &std::path::Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(format!(".muxy_probe_{}", std::process::id()));
    let ok = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&probe)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(b"0")
        })
        .is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// 构建日志插件。优先用 `resolve_log_dir` 返回的可写目录；无可用目录则降级为仅 stdout/webview，
/// **不阻断启动**。
///
/// 关键：`tauri-plugin-log` 的 `Folder` target 在目录不可创建时返回 `Err`，会令
/// `Builder::setup` 失败进而闪退。这里先用 `is_writable` 试写探测确认目录可写，
/// 探测失败就不挂文件 target，保证进程能起来（日志至少进 stdout/webview）。
fn build_log_plugin(app: &tauri::AppHandle) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let log_dir = resolve_log_dir(app);

    let mut builder = LogBuilder::new()
        .level(LevelFilter::Info);
    match &log_dir {
        Some(dir) => {
            // 在 log 插件注册前用 stderr 报告落盘位置（此时 log 宏尚未生效）。
            eprintln!("[txuyStudio] log dir: {}", dir.display());
            builder = builder.targets([
                Target::new(TargetKind::Folder {
                    path: dir.clone(),
                    file_name: None,
                }),
                Target::new(TargetKind::Stdout),
                Target::new(TargetKind::Webview),
            ]);
        }
        None => {
            // 连兜底目录都不可写。仅 stdout/webview，至少不闪退。
            eprintln!("[txuyStudio] no writable log dir, falling back to stdout/webview only");
            builder = builder.targets([
                Target::new(TargetKind::Stdout),
                Target::new(TargetKind::Webview),
            ]);
        }
    }
    builder.build()
}

#[tauri::command]
fn get_app_info() -> String {
    "txuyStudio AI CLI Workspace".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 日志插件在 setup 内注册（需要 AppHandle 解析日志目录）。
        // 详见 `build_log_plugin`：目录不可用时降级为 stdout，不阻断启动。
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 全局窗口事件:独立项目窗口(`project-` 前缀)被关闭时
        // (用户叉窗 / dock-back 命令 / app 退出),emit `project-window-closed`,
        // 主窗口据此清除 detached 标记、恢复项目显示。统一在 Builder 挂载,
        // 覆盖所有关闭路径,无需在建窗处逐个挂。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let label = window.label();
                if label.starts_with(windows::PROJECT_WINDOW_PREFIX) {
                    log::info!("project window close requested: {label}, emitting project-window-closed");
                    let _ = window.app_handle().emit("project-window-closed", label);
                }
            }
        })
        .setup(|app| {
            // 日志插件在 setup 最早期注册：它需要 AppHandle 来运行时解析日志目录
            //（绝不能用编译期 `env!("CARGO_MANIFEST_DIR")`，否则打包到别的机器
            // 因目录不可创建而令 setup 失败 → 闪退）。`build_log_plugin` 内部在
            // 目录不可用时降级为 stdout，注册本身不会返回 Err。
            let log_plugin = build_log_plugin(&app.handle());
            app.handle().plugin(log_plugin)?;

            // 从磁盘加载持久化状态（失败回退空快照，不阻断启动），
            // 再 manage 为全局 AppState。
            log::info!("txuyStudio starting, loading persisted state…");
            let snapshot = state::persistence::load(app.handle());
            log::info!(
                "state loaded: {} project(s), active = {:?}",
                snapshot.projects.len(),
                snapshot.active_project_id
            );
            app.manage(state::AppState::new(snapshot));
            Ok(())
        })
        .manage(PtyRegistry::default())
        .manage(FsWatcherRegistry::default())
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            // PTY（阶段 3：已按 projectId 归属分桶，close_project 时 kill 整个项目）
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            // 多项目状态与持久化(阶段 2)
            hydrate_window,
            open_project,
            close_project,
            set_active_project,
            set_locale,
            set_terminal_font_size,
            save_window_bounds,
            save_pane_tree,
            // 独立项目窗口(阶段 4:右击项目「在新窗口打开」)
            open_project_window,
            close_project_window,
            // 系统环境查询（内存占用 + git 分支 + 命令安装检测 + AI CLI 会话列表/删除/消息流/provider 注册表）
            get_system_memory,
            get_git_branch,
            check_commands_installed,
            list_ai_cli_providers,
            list_ai_cli_sessions,
            delete_ai_cli_session,
            get_ai_cli_session_messages,
            // 嵌入式文件树(方案 C:list_dir 只读列一层 + notify 实时监听 + read_file 预览 + write_file M2 编辑落盘)
            list_dir,
            read_file,
            start_fs_watch,
            stop_fs_watch,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
