//! `!` 命令的 spawn / kill + 后台读循环。
//!
//! 与 `claude/commands` 并列:不走 portable-pty/ConPTY(避免 echo/ANSI/prompt 污染输出),
//! 而是 `std::process::Command` 直接 spawn `pwsh.exe -NoProfile -NonInteractive -Command <cmd>`,
//! stdout/stderr 各起一个 `spawn_blocking` 读循环,逐行 emit `shell-event`。
//!
//! 复用 `pty::commands` 的 `command_no_window`(CREATE_NO_WINDOW,powershell.exe 控制台程序
//! release 下必加)、`validate_cwd`(项目根校验)、`pick_shell`(pwsh 优先回退 powershell)。
//!
//! **中断语义**(对齐 `claude/commands`):中断的唯一 emit 源是 `kill_shell_command`(emit
//! `interrupted{id}`);stdout 读循环 EOF 时若 `killed=true` → 静默 return(不重复 emit)。
//! 正常结束(EOF + `killed=false`)由 stdout 读循环 emit `done{exitCode}`。
//!
//! 不变量:
//! 1. `std::sync::Mutex` 持锁不跨 `.await`——短锁作用域内只做 insert/remove/take 字段。
//! 2. 阻塞的 kill+wait / 读循环丢 `spawn_blocking`,且进入前锁已释放。
//! 3. 读循环 fire-and-forget(spawn_blocking 不 await),前端靠事件流感知进度。
//! 4. 前端先 `listen("shell-event")` 再 `invoke("run_shell_command")`,避免丢首批事件。

use std::io::BufRead;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use super::{ShellEvent, ShellEventPayload, ShellRunRegistry, ShellRunSession};
use crate::pty::commands::{command_no_window, pick_shell, validate_cwd, PATH_REFRESH_PS, PNPM_WRAPPER_PS};

/// 全局自增 id 生成器(为每条 `!` 命令生成唯一 id,前端据此配对 start/output/done/interrupted)。
static SHELL_RUN_ID: AtomicU64 = AtomicU64::new(0);

fn next_shell_id() -> String {
    format!("shell-{}", SHELL_RUN_ID.fetch_add(1, Ordering::Relaxed))
}

/// 执行一条 `!` 命令(spawn 一次性 powershell,fire-and-forget 读循环 emit 输出)。
///
/// cwd:前端传当前项目根(`state.meta.cwd`);缺失/校验失败则不设 cwd(继承后端进程目录)。
///
/// 持锁不跨 .await:短锁作用域内只 insert session + 存 id;spawn 与读循环在锁外。
#[tauri::command]
pub async fn run_shell_command(
    app: AppHandle,
    state: State<'_, ShellRunRegistry>,
    project_id: String,
    tab_id: String,
    command: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let id = next_shell_id();

    // 1) 短锁:insert/取 session + 存 id + busy 检查 + 复位 killed。
    //    用 `lock().map(|g| ...)` 链式(MutexGuard 在闭包内用完即 drop),不用 `if let`
    //    (后者临时 Result 的 Err 变体持 PoisonError<guard>,生命周期延伸到 if 块结束,
    //    与 by_project 的 drop 顺序冲突报「does not live long enough」)。
    {
        let mut by_project = state.by_project.lock().map_err(|e| {
            log::error!("run_shell_command: state lock poisoned: {e}");
            e.to_string()
        })?;
        let sessions = by_project.entry(project_id.clone()).or_default();
        let session = sessions
            .entry(tab_id.clone())
            .or_insert_with(|| ShellRunSession {
                child: Mutex::new(None),
                killed: Mutex::new(false),
                id: Mutex::new(None),
            });
        // 同 tab 已有存活 child → 拒绝并发执行(前端 canSend 应已拦,这里兜底)。
        let busy = session.child.lock().map(|g| g.is_some()).unwrap_or(false);
        if busy {
            return Err("shell command already running: interrupt it first".to_string());
        }
        let _ = session.killed.lock().map(|mut g| *g = false);
        let _ = session.id.lock().map(|mut g| *g = Some(id.clone()));
    }

    // 2) 校验 cwd(前端传的项目根)。校验失败不阻断,只 warn + 不设 current_dir。
    let cwd_validated = match &cwd {
        Some(path) => match validate_cwd(std::path::Path::new(path)) {
            Ok(p) => Some(p),
            Err(reason) => {
                log::warn!("run_shell_command: cwd rejected ({reason}): {path}, using default");
                None
            }
        },
        None => None,
    };

    // 3) 通知前端「开始」(先 emit start 再 spawn,保证前端在收到第一批 output 前已 push 好消息槽位)。
    let _ = app.emit(
        "shell-event",
        ShellEvent {
            project_id: project_id.clone(),
            tab_id: tab_id.clone(),
            payload: ShellEventPayload::Start {
                id: id.clone(),
                command: command.clone(),
            },
        },
    );

    // 4) 构造命令:pwsh/powershell -NoProfile -NonInteractive -Command <cmd>。
    //    -NoProfile:不加载用户 profile(避免别名/模块污染 + 加速)。
    //    -NonInteractive:不进交互 prompt(命令跑完即退,不会卡在等输入)。
    let shell_program = pick_shell();
    log::info!(
        "run_shell_command: id={id} tab {tab_id} project {project_id} shell={shell_program} cwd={} cmd={}",
        cwd_validated
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "(default)".to_string()),
        command.chars().take(200).collect::<String>()
    );
    // 前置 PATH 补全 + pnpm wrapper:让 `!` 命令也能用 app 启动后新装的 CLI,
    // 并绕过 volta Rust shim 在 PTY 下的 bug(与 PTY spawn 一致,见 PNPM_WRAPPER_PS 注释)。
    let full_command = format!("{PATH_REFRESH_PS}; {PNPM_WRAPPER_PS}; {command}");
    let mut cmd = command_no_window(&shell_program);
    cmd.arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(&full_command);
    if let Some(p) = &cwd_validated {
        cmd.current_dir(p);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // 5) spawn。取 stdout + stderr;child 存 registry(短锁 set)。
    let mut child = cmd.spawn().map_err(|e| {
        log::error!("run_shell_command: failed to spawn for tab {tab_id}: {e}");
        let _ = app.emit(
            "shell-event",
            ShellEvent {
                project_id: project_id.clone(),
                tab_id: tab_id.clone(),
                payload: ShellEventPayload::Done {
                    id: id.clone(),
                    exit_code: None,
                },
            },
        );
        e.to_string()
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "shell stdout not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "shell stderr not captured".to_string())?;

    {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        if let Some(session) = by_project
            .get(&project_id)
            .and_then(|sessions| sessions.get(&tab_id))
        {
            if let Ok(mut g) = session.child.lock() {
                *g = Some(child);
            }
        }
    }

    // 6) fire-and-forget 读循环:stderr 只 emit output;stdout EOF 后收尾(emit done 或静默)。
    let app_handle = app.clone();
    let pid = project_id.clone();
    let tid = tab_id.clone();
    let id_done = id.clone();

    // stderr 读循环:逐行 emit output{stream:"stderr"}。EOF 后不收尾(收尾由 stdout 读循环负责,
    // 因 stdout EOF 才是命令真正结束的可靠信号)。
    let app_err = app.clone();
    let pid_err = project_id.clone();
    let tid_err = tab_id.clone();
    let id_err = id.clone();
    tokio::task::spawn_blocking(move || {
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_err.emit(
                "shell-event",
                ShellEvent {
                    project_id: pid_err.clone(),
                    tab_id: tid_err.clone(),
                    payload: ShellEventPayload::Output {
                        id: id_err.clone(),
                        chunk: line,
                        stream: "stderr".to_string(),
                    },
                },
            );
        }
    });

    // stdout 读循环:逐行 emit output{stream:"stdout"};EOF 后据 killed 决定 emit done / 静默。
    tokio::task::spawn_blocking(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_handle.emit(
                "shell-event",
                ShellEvent {
                    project_id: pid.clone(),
                    tab_id: tid.clone(),
                    payload: ShellEventPayload::Output {
                        id: id_done.clone(),
                        chunk: line,
                        stream: "stdout".to_string(),
                    },
                },
            );
        }

        // stdout EOF = 命令结束。短锁取 killed + child(分步避免借用生命周期问题)。
        let (killed, mut child_opt) = {
            let reg = app_handle.state::<ShellRunRegistry>();
            let by_project = match reg.by_project.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let session = by_project.get(&pid).and_then(|s| s.get(&tid));
            let killed = session
                .and_then(|s| s.killed.lock().ok())
                .map(|g| *g)
                .unwrap_or(false);
            let child = session
                .and_then(|s| s.child.lock().ok())
                .and_then(|mut g| g.take());
            (killed, child)
        };
        // killed=true:用户已通过 kill_shell_command emit interrupted,这里静默(仅 kill+wait 清进程)。
        if killed {
            if let Some(mut c) = child_opt {
                let _ = c.kill();
                let _ = c.wait();
            }
            log::info!("run_shell_command: id={id_done} eof after kill (silent)");
            return;
        }
        // 正常结束:wait 拿 exit code。child_opt=None 说明 wait 兜底线程(步骤 7)已 take 走 child
        // 并 emit done(孙子进程继承 stdout 致本读循环迟迟不 EOF 的场景)——跳过 emit,避免二次
        // done 覆盖兜底的 exit_code(前端 applyShellEvent 的 done 对已 done 消息会重写 status/exitCode)。
        if child_opt.is_none() {
            return;
        }
        let exit_code = child_opt
            .as_mut()
            .and_then(|c| c.wait().ok())
            .and_then(|s| s.code());
        let _ = app_handle.emit(
            "shell-event",
            ShellEvent {
                project_id: pid,
                tab_id: tid,
                payload: ShellEventPayload::Done {
                    id: id_done.clone(),
                    exit_code,
                },
            },
        );
        log::info!("run_shell_command: id={id_done} done exit_code={exit_code:?}");
    });

    // 7) wait 兜底线程:try_wait 轮询 child,子进程退出即 take + emit done。
    //    背景:若命令 spawn 了后台/守护/GUI 进程(孙子)继承 stdout pipe,父进程退出后 stdout 仍
    //    不 EOF,步骤 6 的 stdout 读循环永不结束 → done 永不发 → 前端 ShellRow 卡「运行中」。兜底
    //    用 try_wait(非阻塞,短锁 try_lock 不 take child、不阻塞 kill_shell_command)探测真实退出,
    //    补发 done。与正常路径协同:无孙子时读循环 EOF 先 take child + emit done,本线程 try_wait 取
    //    child=None 即 return(不重复 emit);有孙子时读循环卡住,本线程 take + emit done。kill 路径
    //    置 killed 后本线程 return(interrupted 由 kill_shell_command emit,不重复)。
    let app_wait = app.clone();
    let pid_wait = project_id.clone();
    let tid_wait = tab_id.clone();
    let id_wait = id.clone();
    tokio::task::spawn_blocking(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        // 短锁 try_wait(锁忙则下轮再试,绝不阻塞 kill_shell_command)。
        let exit_code = {
            let state = app_wait.state::<ShellRunRegistry>();
            let Ok(reg) = state.by_project.try_lock() else {
                continue;
            };
            let Some(session) = reg.get(&pid_wait).and_then(|s| s.get(&tid_wait)) else {
                return; // 项目/tab 已移除(关 tab/项目),兜底退出。
            };
            // 用户已中断(killed=true)→ interrupted 由 kill_shell_command emit,兜底退出。
            let killed = session.killed.lock().ok().map(|g| *g).unwrap_or(false);
            if killed {
                return;
            }
            let Some(mut guard) = session.child.lock().ok() else {
                return;
            };
            let Some(child) = guard.as_mut() else {
                return; // child 已被读循环 take(正常结束),兜底退出。
            };
            match child.try_wait() {
                Ok(Some(status)) => status.code(),
                Ok(None) => continue, // 仍在跑,继续轮询。
                Err(_) => return,     // try_wait 失败,放弃(读循环的 done 仍可能发出)。
            }
        };
        // 子进程已退出:take child 释放句柄。take 失败(被读循环 take 走)说明读循环会 emit done,兜底退出。
        let taken = {
            let state = app_wait.state::<ShellRunRegistry>();
            let Ok(reg) = state.by_project.try_lock() else {
                continue;
            };
            reg.get(&pid_wait)
                .and_then(|s| s.get(&tid_wait))
                .and_then(|s| s.child.lock().ok())
                .and_then(|mut g| g.take())
                .is_some()
        };
        if !taken {
            return;
        }
        log::info!("run_shell_command: id={id_wait} wait-probe done exit_code={exit_code:?}");
        let _ = app_wait.emit(
            "shell-event",
            ShellEvent {
                project_id: pid_wait,
                tab_id: tid_wait,
                payload: ShellEventPayload::Done {
                    id: id_wait,
                    exit_code,
                },
            },
        );
        return;
    });

    Ok(())
}

/// 中断当前 `!` 命令(kill powershell 进程)。仿 `kill_claude`,是 interrupted 的唯一 emit 源。
///
/// 短锁:killed=true(读循环 EOF 静默)+ take child + 读 id,放锁后 spawn_blocking kill+wait,
/// emit `interrupted{id}`(前端按 id 精确复位消息)。无在跑 child → 幂等(仍按 id emit interrupted)。
#[tauri::command]
pub async fn kill_shell_command(
    app: AppHandle,
    state: State<'_, ShellRunRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<(), String> {
    let (child_opt, id) = {
        let by_project = state.by_project.lock().map_err(|e| {
            log::error!("kill_shell_command: state lock poisoned: {e}");
            e.to_string()
        })?;
        let session = by_project
            .get(&project_id)
            .and_then(|sessions| sessions.get(&tab_id));
        if let Some(session) = session {
            let _ = session.killed.lock().map(|mut g| *g = true);
            let child = session.child.lock().ok().and_then(|mut g| g.take());
            let id = session.id.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
            (child, id)
        } else {
            (None, String::new())
        }
    };

    let pid = project_id.clone();
    let tid = tab_id.clone();
    if let Some(mut child) = child_opt {
        tokio::task::spawn_blocking(move || {
            let _ = child.kill();
            let _ = child.wait();
        })
        .await
        .map_err(|e| e.to_string())?;
        log::info!("kill_shell_command: killed tab {tid} project {pid} id={id}");
    } else {
        log::info!("kill_shell_command: tab {tid} project {pid} not running, idempotent ok");
    }
    // 中断的唯一 emit 源(读循环 EOF killed=true 时静默,不重复 emit)。id 精确配对前端消息。
    let _ = app.emit(
        "shell-event",
        ShellEvent {
            project_id: pid,
            tab_id: tid,
            payload: ShellEventPayload::Interrupted { id },
        },
    );
    Ok(())
}
