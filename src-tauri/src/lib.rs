mod claude;
mod codex;
mod filetree;
mod pty;
mod shell_run;
mod state;
mod system;
mod windows;

use claude::commands::{
    claude_settings_changed, exec_claude_tool_local, get_claude_config_path, get_claude_session_model,
    kill_claude, list_claude_models, read_claude_history_events, send_claude_message, set_claude_model,
    start_claude_session,
};
use claude::ClaudeRegistry;
use codex::commands::{
    codex_config_changed, get_codex_current_model, get_codex_session_model, kill_codex,
    list_codex_models, send_codex_message, set_codex_session_model,
};
use codex::CodexRegistry;
use filetree::commands::{ensure_dir, list_dir, list_files, read_file, start_fs_watch, stop_fs_watch, write_file};
use filetree::FsWatcherRegistry;
use log::LevelFilter;
use pty::commands::{kill_pty, resize_pty, spawn_pty, write_pty};
use pty::PtyRegistry;
use shell_run::commands::{kill_shell_command, run_shell_command};
use shell_run::ShellRunRegistry;
use state::commands::{
    add_claude_allowed_tool, close_project, hydrate_window, open_project, open_recent_project,
    remove_recent_project, save_pane_tree, save_window_bounds, set_active_project,
    set_codex_sandbox, set_locale, set_terminal_font_size, set_theme,
};
use system::commands::{
    check_commands_installed, delete_ai_cli_session, get_ai_cli_session_messages, get_git_branch,
    get_system_memory, list_ai_cli_providers, list_ai_cli_sessions, reveal_in_folder,
};
use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_log::{Builder as LogBuilder, Target, TargetKind};
use windows::{close_project_window, open_new_workspace_window, open_project_window};

/// 已被前端 show 过的窗口 label 集合(多窗口隔离:主窗口与每个独立项目窗口各自首帧 show)。
/// `show()` 本身幂等;此集合仅用于日志去重 + 让兜底定时器在前端已 show 时跳过。
struct WindowsShown(Mutex<HashSet<String>>);

impl WindowsShown {
    /// 标记 label 为已 show。返回 true 表示由本调用者首次标记(应由其负责真正 show)。
    fn mark(&self, label: &str) -> bool {
        let mut set = self.0.lock().expect("WindowsShown mutex poisoned");
        set.insert(label.to_string())
    }
}

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

/// 显示窗口(由前端首帧 splash 渲染后调用),消除 WebView2 冷启动阶段的原生白屏。
///
/// 背景:窗口默认 `visible:false`(见 `tauri.conf.json`)。WebView2 冷启动 + 加载
/// `index.html` + 解析 JS bundle 期间,若窗口已显示则是纯白屏(内联 splash 此时尚未
/// 被 WebView 解析)。改为等前端首帧渲染完毕、splash 已上屏后再 show,
/// 用户看到的第一帧即深色 splash。
///
/// 兜底:setup 内另挂一个 4s 定时器强制 show 主窗口——万一前端 JS 崩溃/调不到本命令,
/// 窗口不会永远不出现。前端正常路径会先于该定时器触发 show。
/// `show()` 本身幂等;`WindowsShown` 集合仅用于日志区分来源 + 让定时器在前端已 show 时跳过,
/// 且按 window label 隔离(主窗口与每个独立项目窗口各自首帧 show)。
///
/// 复用于独立项目窗口:它们同样 `visible:false` 建窗,前端首帧调用本命令 show。
#[tauri::command]
fn show_window(app: tauri::AppHandle, window: tauri::Window) {
    let label = window.label().to_string();
    let shown = app.state::<WindowsShown>();
    // mark 返回 true 表示本调用者首次标记该窗口 → 由其真正 show,避免并发双路径重复日志。
    if shown.mark(&label) {
        let _ = window.show();
        log::debug!("show_window: window {label} shown by frontend");
    } else {
        log::trace!("show_window: window {label} already shown, skip");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 日志插件在 setup 内注册（需要 AppHandle 解析日志目录）。
        // 详见 `build_log_plugin`：目录不可用时降级为 stdout，不阻断启动。
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 自动更新:检查 GitHub Releases 的 latest.json(TAURI_SIGNING_* 签名验签);
        // 前端 SettingsModal 消费(检查/下载/安装/重启),process 插件提供 relaunch。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
                // 工作台窗口关闭:其项目归档进最近历史 + kill 会话(main 不走此路径)。
                if windows::is_workspace_window(label) {
                    windows::archive_workspace_projects(window.app_handle(), label);
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
            let mut snapshot = state::persistence::load(app.handle());
            // 启动兜底:workspace 窗口不持久化重建,若上次会话被强杀/崩溃,其项目没走
            // CloseRequested 归档流程,会以 owner=workspace-N 滞留(主窗口不可见、也不在
            // 历史)。这里统一归档进最近项目历史(workspace_active 一并清空,窗口已不存在)。
            {
                let orphaned: Vec<state::ProjectRecord> = snapshot
                    .projects
                    .iter()
                    .filter(|p| p.owner_window.starts_with(windows::WORKSPACE_WINDOW_PREFIX))
                    .cloned()
                    .collect();
                if !orphaned.is_empty() {
                    log::info!(
                        "startup: archiving {} orphaned workspace project(s) into recent history",
                        orphaned.len()
                    );
                    snapshot
                        .projects
                        .retain(|p| !p.owner_window.starts_with(windows::WORKSPACE_WINDOW_PREFIX));
                    state::archive_recent(&mut snapshot, orphaned);
                    snapshot.workspace_active.clear();
                    if let Err(e) = state::persistence::save(app.handle(), &snapshot) {
                        log::error!("startup: archive orphaned projects persist failed: {e}");
                    }
                }
            }
            log::info!(
                "state loaded: {} project(s), active = {:?}",
                snapshot.projects.len(),
                snapshot.active_project_id
            );
            app.manage(state::AppState::new(snapshot));

            // 注册「已 show 窗口」记录集(供 show_window 命令 + 兜底定时器去重)。
            app.manage(WindowsShown(Mutex::new(HashSet::new())));

            // 白屏消除策略(dev / release 区分):
            //
            // - **release(打包)**:主窗口默认 visible:false,由前端首帧 show_window 显示。
            //   WebView2 冷启动 + 加载 index.html + 解析 JS bundle 期间若窗口已显示则是纯白屏
            //   (内联 splash 此时尚未被解析);等前端首帧 splash 上屏后再 show,首帧即深色 splash。
            //   另挂 4s 兜底定时器:前端 JS 崩溃/卡死调不到 show_window 时强制 show,避免窗口永不出现。
            //   打包后 WebView2 加载本地静态 bundle 远快于 4s,正常路径稳定先于定时器。
            //
            // - **dev**:`cfg!(debug_assertions)` 下立即 show 主窗口——dev 下 WebView2 加载
            //   Vite dev server(localhost:1420)冷启动慢(依赖优化扫描 3s+),若等前端首帧 show,
            //   窗口会隐藏近 4s 才出现,观感比改之前(立即可见、仅短暂白屏)更差。dev 白屏可接受,
            //   故 dev 立即可见;前端首帧仍会调 show_window(幂等,WindowsShown 已标记 main 则跳过)。
            let app_handle = app.handle().clone();
            if cfg!(debug_assertions) {
                if let Some(main_win) = app_handle.get_webview_window("main") {
                    // 标记 main 已 show,使前端后续 show_window 调用走幂等跳过分支(不重复日志)。
                    let _ = app_handle.state::<WindowsShown>().mark("main");
                    let _ = main_win.show();
                    // dev 标识:任务栏标题加 (dev),与 prod 视觉区分(dev 数据目录也已独立,见 persistence)。
                    let _ = main_win.set_title("txuyStudio (dev)");
                    log::debug!("show_window: dev build, main window shown immediately");
                }
            } else {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(4000));
                    if let Some(main_win) = app_handle.get_webview_window("main") {
                        let shown = app_handle.state::<WindowsShown>();
                        if shown.mark("main") {
                            let _ = main_win.show();
                            log::warn!("show_window: fallback timer forced main window visible (frontend did not call show_window in time)");
                        }
                    }
                });
            }
            Ok(())
        })
        .manage(PtyRegistry::default())
        .manage(FsWatcherRegistry::default())
        .manage(ClaudeRegistry::default())
        .manage(CodexRegistry::default())
        .manage(ShellRunRegistry::default())
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            // 启动白屏消除:窗口默认 hidden,前端首帧渲染后调 show_window 显示。
            show_window,
            // PTY（阶段 3：已按 projectId 归属分桶，close_project 时 kill 整个项目）
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            // claude 自渲染对话(stream-json 长进程;start 启动/重启,send 写 stdin,/compact 真生效)
            start_claude_session,
            // 恢复会话历史回填:读 jsonl 转与实时事件同构的序列(glm 代理 --resume 不重放历史的兜底)
            read_claude_history_events,
            // 批准被拒工具时本地执行(Bash/Edit/Write),结果经 tool_result 原地回传(claude cli 同语义)
            exec_claude_tool_local,
            send_claude_message,
            get_claude_config_path,
            get_claude_session_model,
            set_claude_model,
            kill_claude,
            claude_settings_changed,
            list_claude_models,
            // codex 自渲染对话(每轮短命 codex exec --json + resume 续接;send 即 spawn,
            // 事件流见 codex/mod.rs;model 目录读 cc-switch-model-catalog.json)
            send_codex_message,
            kill_codex,
            list_codex_models,
            get_codex_current_model,
            codex_config_changed,
            get_codex_session_model,
            set_codex_session_model,
            // `!` 命令内联执行 PowerShell(不走 PTY;一次性进程,stdout/stderr 逐行流式 emit shell-event)
            run_shell_command,
            kill_shell_command,
            // 多项目状态与持久化(阶段 2)
            hydrate_window,
            open_project,
            close_project,
            set_active_project,
            // 最近项目历史(+ 菜单「历史项目」恢复/删除)
            open_recent_project,
            remove_recent_project,
            set_locale,
            set_terminal_font_size,
            set_theme,
            set_codex_sandbox,
            save_window_bounds,
            save_pane_tree,
            add_claude_allowed_tool,
            // 独立项目窗口(阶段 4:右击项目「在新窗口打开」)
            open_project_window,
            close_project_window,
            // 空白工作台窗口(多主窗口:+ 菜单「新窗口」,项目按窗口归属隔离)
            open_new_workspace_window,
            // 系统环境查询（内存占用 + git 分支 + 命令安装检测 + AI CLI 会话列表/删除/消息流/provider 注册表）
            get_system_memory,
            get_git_branch,
            check_commands_installed,
            list_ai_cli_providers,
            list_ai_cli_sessions,
            delete_ai_cli_session,
            get_ai_cli_session_messages,
            // 资源管理器定位文件/目录(/select 选中或打开所在文件夹)
            reveal_in_folder,
            // 嵌入式文件树(方案 C:list_dir 只读列一层 + notify 实时监听 + read_file 预览 + write_file M2 编辑落盘)
            list_dir,
            list_files,
            read_file,
            start_fs_watch,
            stop_fs_watch,
            write_file,
            // 笔记 pane:首次建笔记时创建 notes/ 目录(write_file 不建父目录)。
            ensure_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
