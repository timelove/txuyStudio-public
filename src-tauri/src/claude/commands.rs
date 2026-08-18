//! claude stream-json 子进程的 spawn / kill + 后台读循环。
//!
//! 与 `pty/commands` 并列:不走 portable-pty/ConPTY,而是 `std::process::Command` 直接 spawn
//! `claude.exe -p <prompt> --output-format stream-json --verbose [--resume <id>]`。
//! stdout 逐行读 JSON(`BufReader::lines()`),分类后 emit `claude-event`。
//!
//! 复用 `pty::commands` 的 `command_no_window`(CREATE_NO_WINDOW,claude.exe 控制台程序 release 下
//! 必加)、`validate_cwd`(项目根校验)。
//!
//! 四条不变量(对齐 `pty/commands` 的约定):
//! 1. `std::sync::Mutex` 持锁不跨 `.await`——短锁作用域内只做 insert/remove/取字段。
//! 2. 阻塞的 kill+wait 丢 `spawn_blocking`,且进入前锁已释放。
//! 3. 读循环是 fire-and-forget(spawn_blocking 不 await),返回后前端靠事件流感知进度。
//! 4. 前端必须先 `listen("claude-event")` 再 `invoke("start_claude_session")`,避免丢首批事件
//!    (与 `pty-output` 同约束,前端 ClaudeTransport 内部保证)。

use std::io::{BufRead, Write};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use super::{
    ClaudeEvent, ClaudeEventPayload, ClaudeRegistry, ClaudeSession, ClaudeStatus, SessionConfig,
};
use crate::pty::commands::{command_no_window, resolve_on_path, validate_cwd};
use crate::state::AppState;

/// thinking_tokens 攒批阈值:累计到这么多字符就 flush 一次 emit,避免逐 token IPC 风暴。
const THINKING_BATCH_CHARS: usize = 200;
/// thinking_tokens flush 间隔:即使没到阈值,这么久也 flush 一次,让 UI 感知「在思考」。
const THINKING_FLUSH_INTERVAL: Duration = Duration::from_millis(50);

/// 启动/重启 claude 长进程(幂等「确保一个新进程在跑」)。
///
/// 一个 claude tab = 一个长生命周期进程:`--input-format stream-json --output-format stream-json`
/// 模式,stdin 持续喂消息、stdout 持续吐事件、EOF 才退出。多轮同进程、session_id 不变 →
/// `/compact` 真生效、`--resume` 不断裂。
///
/// 调用场景(transport 层 `ensureStarted`):
/// - 首启:`resume_id=None`(全新会话)。
/// - 崩溃恢复/换 mode/批准重启/中断后续接:`resume_id=Some`(带 `--resume`,session 保留)。
///
/// 幂等性:若旧 child 存活 → 置 `killed=true` + take child+stdin,放锁后 spawn_blocking
/// kill+wait 旧进程(让旧读循环退出,不发 error Terminated),再启新进程。
///
/// 持锁不跨 .await:短锁作用域内只做取/放字段 + take child;阻塞 kill+wait 在 spawn_blocking
/// 且锁已释放。
#[tauri::command]
pub async fn start_claude_session(
    app: AppHandle,
    state: State<'_, ClaudeRegistry>,
    app_state: State<'_, AppState>,
    project_id: String,
    tab_id: String,
    cwd: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Option<Vec<String>>,
    resume_session_id: Option<String>,
    effort: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    // 1) 短锁:取/建 session;若旧 child 存活 → killed=true + take child+stdin(放锁后 kill 旧进程)。
    // 0) 读持久化的 claude_session_id(跨重启 --resume 用)。首启播种到新 session;session 已存在
    //    (本运行期内已启)不覆盖(保留 live id)。ClaudeRegistry 仅内存,重启即丢,故从 AppState 读。
    let persisted_sid: Option<String> = {
        let snap = app_state.inner.lock().map_err(|e| e.to_string())?;
        snap.projects
            .iter()
            .find(|p| p.id == project_id)
            .and_then(|p| p.claude_tab_sessions.get(&tab_id).cloned())
    };

    // 用户指定恢复某历史会话(前端 ↻ 输入 session id,或 SessionBrowser 恢复):
    // **显式覆盖** persisted id--前端 resumeSession 在调本命令前已 kill 旧进程(进程已死),
    // 故传 resume_session_id 即「切换到另一条历史会话」的明确意图,必须覆盖 persisted(否则
    // 旧 persisted id 仍在 -> resume_sid 被过滤 -> 恢复的还是旧的已终止会话,用户 ↻ 无效)。
    // 正常重启(mode/effort 切换)不传 resume_session_id(None),走 persisted 续接当前会话。
    let resume_sid = resume_session_id.clone();
    let initial_sid = resume_sid.clone().or(persisted_sid);

    let old_child = {
        let mut by_project = state.by_project.lock().map_err(|e| {
            log::error!("start_claude_session: state lock poisoned: {e}");
            e.to_string()
        })?;
        let sessions = by_project.entry(project_id.clone()).or_default();
        let session = sessions
            .entry(tab_id.clone())
            .or_insert_with(move || ClaudeSession {
                claude_session_id: Mutex::new(initial_sid.clone()),
                child: Mutex::new(None),
                stdin: Mutex::new(None),
                config: Mutex::new(SessionConfig::default()),
                status: Mutex::new(ClaudeStatus::Idle),
                model: Mutex::new(None),
                settings_env_hash: Mutex::new(None),
                killed: Mutex::new(false),
            });
        // 旧 child 存活:标记 killed(让旧读循环 EOF 不发 error)+ take child+stdin。
        let old = session.child.lock().ok().and_then(|mut g| g.take());
        if old.is_some() {
            if let Ok(mut k) = session.killed.lock() {
                *k = true;
            }
            let _ = session.stdin.lock().ok().and_then(|mut g| g.take());
        }
        // 用户显式恢复(↻ 切换到另一条历史会话):覆写 registry 的 claude_session_id,
        // 使后续 spawn 读到的 --resume id 是新会话而非旧已终止会话(与下方 update_claude_session_id
        // 持久化到 AppState 同步)。session 已存在(已终止 tab)时尤其关键:旧 id 仍在 registry。
        if let Some(sid) = &resume_sid {
            if let Ok(mut g) = session.claude_session_id.lock() {
                *g = Some(sid.clone());
            }
        }
        old
    };
    // 放锁后 kill+wait 旧进程树(让旧读循环退出;killed=true 故不发 error Terminated)。
    // 用 kill_child_tree 而非 child.kill():Windows 下 .cmd 包装使 node 成为孙子进程,
    // child.kill() 只杀 cmd.exe 不杀 node -> 旧进程树残留继续输出(见 kill_child_tree 注释)。
    // resume_sid 传入时立即持久化到 AppState(不等 init): 跨重启续接; init 后 update_claude_session_id 幂等覆盖.
    if let Some(sid) = &resume_sid {
        let _ = update_claude_session_id(&app, &project_id, &tab_id, sid.clone());
    }
    if let Some(mut c) = old_child {
        let _ = tokio::task::spawn_blocking(move || {
            kill_child_tree(&mut c);
        })
        .await;
    }

    // 2) 短锁:写 config(mode/cwd)+ cleared killed=false + 读 claude_session_id(决定 --resume)。
    // 文件 IO 在锁外:先算 spawn 时刻的 settings.json env 段哈希(锁内仅写入,见下方 block 2)。
    let spawn_env_hash = claude_settings_env_hash();
    let (resume_id, mode_str, cwd_validated, effort_str, model_str) = {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        let session = by_project
            .get(&project_id)
            .and_then(|s| s.get(&tab_id))
            .ok_or("session missing after ensure")?;
        let mode = permission_mode.as_deref().unwrap_or("acceptEdits").to_string();
        let cwd_v = match &cwd {
            Some(path) => match validate_cwd(std::path::Path::new(path)) {
                Ok(p) => Some(p),
                Err(reason) => {
                    log::warn!("start_claude_session: cwd rejected ({reason}): {path}, using default");
                    None
                }
            },
            None => None,
        };
        if let Ok(mut cfg) = session.config.lock() {
            *cfg = SessionConfig {
                permission_mode: mode.clone(),
                cwd: cwd_v.clone(),
                effort: effort.clone(),
                model: model.clone(),
            };
        }
        // 记录 spawn 时的 settings.json env 段哈希(文件 IO 已在锁外完成,锁内仅写入),
        // 供 claude_settings_changed 比对检测 cc-switch 等工具的供应商切换。
        if let Ok(mut h) = session.settings_env_hash.lock() {
            *h = Some(spawn_env_hash);
        }
        // 注意:此处**不清 killed**。killed 是给「旧读循环」EOF 时判断用的(旧进程被 kill 后,
        // 旧读循环将退出,需 take 走 killed=true 避免误发 error Terminated)。新读循环启动时,
        // killed 已被旧读循环的 take_killed_flag 取走(=false),自然正确。若在此清 false,
        // 会与旧读循环的异步 EOF 产生竞态:旧读循环读到 false → 误判崩溃 → emit Terminated{eof}。
        let rid = session
            .claude_session_id
            .lock()
            .ok()
            .and_then(|g| g.clone());
        (rid, mode, cwd_v, effort, model)
    };

    // 3) 构造命令:claude -p --input-format stream-json --output-format stream-json --verbose
    //    --permission-mode <mode> [--allowedTools ...] [--resume <id>] [--cwd]。
    //    不传 positional prompt(长进程 prompt 走 stdin)。stdin/stdout piped、stderr null。
    //
    //    **Windows .cmd 包装**:claude 经 volta/npm 装为 `claude.cmd` shim(批处理 → node claude.js)。
    //    长进程模式下 stdin 必须 piped 且正确传递到 shim 内部的 node 进程。直接 `Command::new
    //    ("claude.cmd")` spawn 时,批处理层的 stdin pipe 重定向可能丢失 → claude 收到 stdin EOF
    //    立刻退出(实测:Rust 直接 spawn .cmd 长进程立刻 EOF;node `spawn("cmd",["/c",...])` 稳定)。
    //    故 Windows 上用 `cmd.exe /c claude.cmd <args>` 包装,与诊断脚本一致,保证 stdin pipe 传递。
    let claude_program = resolve_on_path("claude")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "claude".to_string());
    log::info!("start_claude_session: resolved claude program = {claude_program}");
    #[cfg(windows)]
    let mut cmd = {
        // .cmd/.bat 用 cmd /c 包装;裸 .exe 直接 spawn(旧版短命模型本就如此,且短命不喂 stdin 故无此问题)。
        let needs_shell = claude_program.ends_with(".cmd") || claude_program.ends_with(".bat");
        if needs_shell {
            let mut c = command_no_window("cmd.exe");
            c.arg("/c").arg(&claude_program);
            c
        } else {
            command_no_window(&claude_program)
        }
    };
    #[cfg(not(windows))]
    let mut cmd = command_no_window(&claude_program);
    cmd.arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--permission-mode")
        .arg(&mode_str);
    // 工具白名单(--allowedTools):合并「项目持久化 allowlist」∪「本次前端透传」,去重。
    // 短锁读 app_state(同步,不跨 .await)。
    {
        let mut tools: Vec<String> = {
            let snap = app_state.inner.lock().map_err(|e| e.to_string())?;
            snap.projects
                .iter()
                .find(|p| p.id == project_id)
                .map(|p| p.claude_allowed_tools.clone())
                .unwrap_or_default()
        };
        if let Some(extra) = &allowed_tools {
            tools.extend(extra.iter().cloned());
        }
        tools.sort();
        tools.dedup();
        for t in &tools {
            cmd.arg("--allowedTools").arg(t);
        }
        if !tools.is_empty() {
            log::info!("start_claude_session: allowedTools = {:?}", tools);
        }
    }
    if let Some(id) = &resume_id {
        cmd.arg("--resume").arg(id);
    }
    if let Some(e) = &effort_str {
        cmd.arg("--effort").arg(e);
    }
    // --model:显式指定 model(别名或 id)。前端切换 model 经此 flag 重启进程生效--运行中进程
    // 写 `/model <name>`(stdin local command)对后续轮次不可靠,须重启。别名(default/sonnet/
    // opus/…)由 claude 按 ANTHROPIC_DEFAULT_*_MODEL 解析。
    if let Some(m) = &model_str {
        cmd.arg("--model").arg(m);
    }
    if let Some(p) = &cwd_validated {
        cmd.current_dir(p);
    }
    cmd.stdin(Stdio::piped())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());

    log::info!(
        "start_claude_session: tab {tab_id} project {project_id} resume={} cwd={}",
        resume_id.is_some(),
        cwd_validated
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "(default)".to_string())
    );

    // 4) spawn。取 stdout + stdin;child+stdin 存 registry(短锁 set);killed=false。
    let mut child = cmd.spawn().map_err(|e| {
        log::error!("start_claude_session: failed to spawn claude for tab {tab_id}: {e}");
        let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Error);
        let _ = app.emit(
            "claude-event",
            ClaudeEvent {
                project_id: project_id.clone(),
                tab_id: tab_id.clone(),
                payload: ClaudeEventPayload::Terminated {
                    reason: format!("spawn failed: {e}"),
                },
            },
        );
        e.to_string()
    })?;
    let stdout = child.stdout.take().ok_or_else(|| "claude stdout not captured".to_string())?;
    let stdin = child.stdin.take().ok_or_else(|| "claude stdin not captured".to_string())?;

    {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        if let Some(session) = by_project
            .get(&project_id)
            .and_then(|sessions| sessions.get(&tab_id))
        {
            if let Ok(mut g) = session.child.lock() {
                *g = Some(child);
            }
            if let Ok(mut g) = session.stdin.lock() {
                *g = Some(stdin);
            }
            if let Ok(mut k) = session.killed.lock() {
                *k = false;
            }
            if let Ok(mut s) = session.status.lock() {
                *s = ClaudeStatus::Idle;
            }
        }
    }

    // 5) fire-and-forget 读循环。
    let app_handle = app.clone();
    let pid = project_id.clone();
    let tid = tab_id.clone();
    tokio::task::spawn_blocking(move || {
        run_read_loop(app_handle, pid, tid, stdout);
    });

    Ok(())
}

/// 写 stdin 一条 stream-json user 消息(发一轮对话 / 触发 local command 如 /compact /clear)。
///
/// 长进程模式下「发消息」与「启动进程」正交:本命令只写 stdin,不 spawn。进程未启/已死时
/// stdin=None → 返回 Err,transport 层 `ensureStarted` 据此先调 `start_claude_session`。
///
/// busy 检查:status=Running/Compacting → Err(前端应先 interrupt)。take stdin(写出期间置 None
/// 防并发,放回在 spawn_blocking 末尾)。
///
/// 持锁不跨 .await:status/stdin 锁短作用域同步取放;`write_all` 在 spawn_blocking 内,async
/// 侧只 await JoinHandle。
#[tauri::command]
pub async fn send_claude_message(
    app: AppHandle,
    state: State<'_, ClaudeRegistry>,
    project_id: String,
    tab_id: String,
    prompt: String,
) -> Result<(), String> {
    // 1) 短锁:检查 busy + take stdin + 置 Running(即时 local command 如 /clear 除外,见下方
    //    `is_instant_local_command`:不置 Running,避免 /clear 不发 result 时 busy 死锁)。
    let stdin = {
        let by_project = state.by_project.lock().map_err(|e| {
            log::error!("send_claude_message: state lock poisoned: {e}");
            e.to_string()
        })?;
        let session = by_project
            .get(&project_id)
            .and_then(|s| s.get(&tab_id))
            .ok_or_else(|| "claude session not started: call start_claude_session first".to_string())?;
        {
            let st = session.status.lock().map_err(|e| e.to_string())?;
            if *st == ClaudeStatus::Running || *st == ClaudeStatus::Compacting {
                return Err("claude session busy: interrupt the current turn first".to_string());
            }
        }
        // 即时 local command(当前仅 /clear):不置 Running。/clear 是「清空会话」的即时命令,
        // 可能不发 result 复位 → 若置 Running 而 claude 不发 result,status 卡 Running → busy
        // 死锁(下次 send 被 busy 检查拦)。不置 Running(保持 Idle)对两种情况都安全:claude
        // 发了 result(置 Idle)幂等无害,不发 result 则避免死锁。/compact 不在此列——它是长
        // 操作,需 busy 保护,且 compact 结束会发 result 复位 Idle(实测见 research-stream-json-compact.md)。
        let is_instant_local_command = prompt.trim() == "/clear";
        if !is_instant_local_command {
            if let Ok(mut s) = session.status.lock() {
                *s = ClaudeStatus::Running;
            }
        }
        session.stdin.lock().ok().and_then(|mut g| g.take())
    };

    // 2) 构造 stream-json user 消息行(实测格式)。
    let line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": &prompt }] }
    })
    .to_string()
        + "\n";

    // 3) spawn_blocking 写入(同步 IO 不阻塞 async worker;锁完全在 blocking 线程内,不跨 .await)。
    let app2 = app.clone();
    let pid = project_id.clone();
    let tid = tab_id.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        if let Some(mut s) = stdin {
            s.write_all(line.as_bytes())?;
            s.flush()?;
            // 放回 stdin(供下次 send 用)。若 session 已被 kill/remove → 丢弃(drop 关闭)。
            // 用独立块显式 drop 锁 guard 与 State 引用,避免借用生命周期冲突。
            {
                let reg = app2.state::<ClaudeRegistry>();
                let by_project = match reg.by_project.lock() {
                    Ok(g) => g,
                    Err(_) => return Ok(()),
                };
                let sess_opt = by_project
                    .get(&pid)
                    .and_then(|sessions| sessions.get(&tid));
                if let Some(sess) = sess_opt {
                    if let Ok(mut g) = sess.stdin.lock() {
                        *g = Some(s);
                    }
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("send_claude_message join: {e}"))?
    .map_err(|e| format!("send_claude_message write: {e}"))?;

    Ok(())
}

/// 中断当前轮(kill 整个长进程)。headless stream-json 无中断信号,中断靠 kill 进程。
///
/// 短锁:killed=true(读循环 EOF 不发 error)+ take child+stdin(置 None),放锁后 spawn_blocking
/// kill+wait,emit `Terminated{reason:"interrupted"}`(前端当 idle 不显错误)。下次 send 自动
/// `start_claude_session`(带 --resume,session 保留)续接 —— 与短命模型 kill+下轮 --resume 语义一致。
///
/// 若当前无在跑 child(进程已退)→ 幂等返回 Ok(仍 emit interrupted 让前端复位状态)。
#[tauri::command]
pub async fn kill_claude(
    app: AppHandle,
    state: State<'_, ClaudeRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<(), String> {
    let child_opt = {
        let by_project = state.by_project.lock().map_err(|e| {
            log::error!("kill_claude: state lock poisoned: {e}");
            e.to_string()
        })?;
        let session = by_project
            .get(&project_id)
            .and_then(|sessions| sessions.get(&tab_id));
        if let Some(session) = session {
            if let Ok(mut k) = session.killed.lock() {
                *k = true;
            }
            let _ = session.stdin.lock().ok().and_then(|mut g| g.take());
            session.child.lock().ok().and_then(|mut g| g.take())
        } else {
            None
        }
    };

    let app_handle = app.clone();
    let pid = project_id.clone();
    let tid = tab_id.clone();
    if let Some(mut child) = child_opt {
        tokio::task::spawn_blocking(move || {
            kill_child_tree(&mut child);
        })
        .await
        .map_err(|e| e.to_string())?;
        log::info!("kill_claude: killed tab {tid} project {pid}");
    } else {
        log::info!("kill_claude: tab {tid} project {pid} not running, idempotent ok");
    }
    // emit interrupted 让前端复位(applyEvent 把 interrupted 当 idle 非 error)。
    let _ = app_handle.emit(
        "claude-event",
        ClaudeEvent {
            project_id: pid,
            tab_id: tid,
            payload: ClaudeEventPayload::Terminated {
                reason: "interrupted".to_string(),
            },
        },
    );
    Ok(())
}

/// 取 claude 配置路径(target: "agents"/"skills" → `~/.claude/<target>` 目录;
/// "mcp" → `~/.claude.json` 文件)。前端 /agents /skills /mcp 选中后 openPath 打开管理。
#[tauri::command]
pub fn get_claude_config_path(target: String) -> Result<String, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|e| format!("home dir not found: {e}"))?;
    let p = if target == "mcp" {
        std::path::Path::new(&home).join(".claude.json")
    } else {
        std::path::Path::new(&home).join(".claude").join(&target)
    };
    Ok(p.to_string_lossy().into_owned())
}

/// 取某 claude 会话当前 model(短锁读 registry)。
///
/// 供独立窗口(detach)新建 ClaudeTransport 时回填 `meta.model`:detach 后新窗口 transport 是全新
/// 实例(state 空、meta.model 空),而长进程不重启则 init 不重发 -> 状态栏 model 恒空。前端 transport
/// 初始化时调本命令,把后端记录的当前 model(init 回填 + `/model` 切换 + 真实 assistant 事件同步)
/// 回填 meta.model,使独立窗口打开即显示当前 model。session 不存在或 model 未记录返回 None。
#[tauri::command]
pub fn get_claude_session_model(
    state: State<'_, ClaudeRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<Option<String>, String> {
    let by_project = state.by_project.lock().map_err(|e| {
        log::error!("get_claude_session_model: state lock poisoned: {e}");
        e.to_string()
    })?;
    let model = by_project
        .get(&project_id)
        .and_then(|sessions| sessions.get(&tab_id))
        .and_then(|session| session.model.lock().ok())
        .and_then(|g| g.clone());
    Ok(model)
}

/// 写某 claude 会话当前 model 到 registry(短锁)。
///
/// 前端 `setModel`(`/model` 切换,乐观更新)与真实 assistant 事件(每轮 model 校正)后调,
/// 把当前 model 同步到后端,供独立窗口 detach 后 `get_claude_session_model` 读回填。
/// init 事件后端已自行写(run_read_loop 调 update_claude_session_model),无需前端再调。
#[tauri::command]
pub fn set_claude_model(
    app: AppHandle,
    project_id: String,
    tab_id: String,
    model: String,
) -> Result<(), String> {
    update_claude_session_model(&app, &project_id, &tab_id, model)
}

// —— 辅助函数(均短锁,失败静默不阻断主流程) ——

/// 列出 claude 配置(`~/.claude/settings.json` 的 `env` 段)里所有可用 model id。
///
/// 收集 key 以 `_MODEL` 结尾(**不含** `_MODEL_NAME` 这类显示名)的 env 条目值--即
/// `ANTHROPIC_MODEL` 与各 `ANTHROPIC_DEFAULT_*_MODEL` 的实际解析值(如 "GLM-5.2[1M]")。
/// 去重、保持稳定顺序(`ANTHROPIC_MODEL` 优先置顶)。供前端模型选择器每次打开时实时拉取--
/// cc-switch 切供应商改写这些 env 后,下次打开即见新 provider 的可选模型,无需改前端预置表。
/// 文件缺失/无 env/无匹配项返回空数组(前端据此时只展示「当前」行)。
#[tauri::command]
pub fn list_claude_models() -> Result<Vec<String>, String> {
    let env = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .and_then(|home| {
            std::fs::read_to_string(std::path::Path::new(&home).join(".claude").join("settings.json")).ok()
        })
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|v| v.get("env").and_then(|e| e.as_object().cloned()));
    let env = match env {
        Some(e) => e,
        None => return Ok(Vec::new()),
    };
    let mut models: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let push = |models: &mut Vec<String>, seen: &mut std::collections::HashSet<String>, val: &str| {
        let v = val.trim();
        if !v.is_empty() && seen.insert(v.to_string()) {
            models.push(v.to_string());
        }
    };
    // ANTHROPIC_MODEL 优先置顶(当前默认 model)。
    if let Some(val) = env.get("ANTHROPIC_MODEL").and_then(|v| v.as_str()) {
        push(&mut models, &mut seen, val);
    }
    // 其余 *_MODEL(不含 _MODEL_NAME),按 key 字典序稳定遍历。
    let mut keys: Vec<&String> = env.keys().filter(|k| k.ends_with("_MODEL") && !k.ends_with("_NAME")).collect();
    keys.sort();
    for k in keys {
        if k == "ANTHROPIC_MODEL" {
            continue;
        }
        if let Some(val) = env.get(k).and_then(|v| v.as_str()) {
            push(&mut models, &mut seen, val);
        }
    }
    Ok(models)
}

/// 读 `~/.claude/settings.json` 的 `env` 段并算哈希(仅 env 段:theme 等无关字段由 claude CLI
/// 自己改写,不应触发刷新)。文件缺失/解析失败返回空串的哈希(稳定值,仍可检测「从无到有」)。
fn claude_settings_env_hash() -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let env_json = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .and_then(|home| {
            std::fs::read_to_string(std::path::Path::new(&home).join(".claude").join("settings.json")).ok()
        })
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|v| v.get("env").map(|e| e.to_string()))
        .unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    env_json.hash(&mut hasher);
    hasher.finish()
}

/// 检测 `~/.claude/settings.json` 的 `env` 段相对本会话 spawn 时刻是否已变化。
///
/// cc-switch 等供应商切换工具改写 settings.json 的 BASE_URL/AUTH_TOKEN/ANTHROPIC_MODEL 等,
/// 但 env 是 claude 进程**启动时**自读的,运行中的长进程不会感知。前端打开模型选择器时调本
/// 命令,返回 true 则重启进程(--resume 保留 session)拾取新配置,init 回填新 model 后选择器
/// 「当前」即刷新。会话未 spawn 过(无基线)返回 false。
#[tauri::command]
pub fn claude_settings_changed(
    state: State<'_, ClaudeRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<bool, String> {
    let stored = {
        let by_project = state.by_project.lock().map_err(|e| {
            log::error!("claude_settings_changed: state lock poisoned: {e}");
            e.to_string()
        })?;
        by_project
            .get(&project_id)
            .and_then(|sessions| sessions.get(&tab_id))
            .and_then(|session| session.settings_env_hash.lock().ok())
            .and_then(|g| *g)
    };
    Ok(stored.map(|h| claude_settings_env_hash() != h).unwrap_or(false))
}

/// 设某 session 的状态(短锁)。失败静默(锁中毒不阻断主流程)。
fn set_session_status(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    status: ClaudeStatus,
) -> Result<(), String> {
    let registry = app.state::<ClaudeRegistry>();
    let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut g) = session.status.lock() {
            *g = status;
        }
    }
    Ok(())
}

/// kill 整个 claude 进程树并收尸。
///
/// Windows 上 claude 经 `cmd.exe /c claude.cmd` 包装 spawn(见 `start_claude_session`),直接
/// `child.kill()` 只 `TerminateProcess` 外层 `cmd.exe`,**不杀** shim 内部 spawn 的真正
/// `node claude.js` 孙子进程。后者存活后继续往 stdout pipe 写 -> 读循环不退出 -> 前端表现为
/// 「双 esc 中断后会话仍在继续」。用 `taskkill /F /T /PID` 终止整棵进程树(cmd.exe + node)根治;
/// taskkill 不可用(spawn 失败)时回退 `child.kill()`(至少杀 cmd.exe,语义不劣于现状)。非
/// Windows 无 `.cmd` 包装,`child.kill()` 即可。末尾 `wait()` 收尸防僵尸。
pub(super) fn kill_child_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        // child.id() 返回 u32 pid(进程已死也返回历史值)。taskkill 找不到 pid 时进程多半已退,
        // status() 返回 Ok(非 0),不 fallback,由末尾 wait() 收尸;仅 taskkill spawn 失败才 fallback。
        let pid = child.id();
        let killed = match command_no_window("taskkill.exe")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status() {
            Ok(_) => true,
            Err(e) => {
                log::warn!("kill_child_tree: taskkill failed for pid {pid}, fallback to child.kill: {e}");
                false
            }
        };
        if !killed {
            let _ = child.kill();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// 读循环:逐行读 claude 长进程 stdout,解析 stream-json,分类 emit `claude-event`。
///
/// 长进程模式下进程**不退出**(多轮同进程)。`result` 仅标志一轮结束(置 Idle,child 保持 Some);
/// 真正的进程退出 = stdout EOF。EOF 语义按 `killed` 标志分裂:
/// - `killed=true`(主动 kill/重启/中断):置 Idle,不发 error Terminated(中断由 kill_claude 主动 emit)。
/// - `killed=false`(崩溃/异常退出):emit `Terminated{eof}` + 置 Error,transport 下次 send 重启。
///
/// 分类:
/// - `system init` → 回填 registry.claude_session_id + emit Init
/// - `system thinking_tokens` → 攒批 emit Thinking
/// - `system status` → compact 状态(status=compacting 开始 / compact_result=success|failed 结束)+ emit CompactStatus
/// - `system compact_boundary` → emit CompactBoundary{metadata}
/// - `assistant` → flush thinking + emit Assistant
/// - `user` → 跳过 `isReplay && local-command-stdout`(Compacted Tip 噪音);否则 flush + emit User
/// - `result` → flush thinking + 置 Idle(进程不退)+ emit Result
fn run_read_loop(app: AppHandle, project_id: String, tab_id: String, stdout: std::process::ChildStdout) {
    let reader = std::io::BufReader::new(stdout);
    let mut thinking_buf = String::new();
    let mut last_thinking_flush = Instant::now();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                log::warn!("claude read error, tab {tab_id}: {e}");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // 解析 JSON。非 JSON 行(极少,claude 偶发输出)warn 跳过,不阻断。
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("claude non-json line, tab {tab_id}: {e}: {}", trimmed.chars().take(200).collect::<String>());
                continue;
            }
        };

        let evt_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match evt_type {
            "system" => {
                let subtype = v.get("subtype").and_then(|t| t.as_str()).unwrap_or("");
                if subtype == "init" {
                    // 回填 claude_session_id(仅首次,长进程内多轮不换 id)。
                    if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                        let _ = update_claude_session_id(&app, &project_id, &tab_id, sid.to_string());
                    }
                    let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
                    // 同步当前 model 到 registry(供独立窗口 detach 后 get_claude_session_model 回填)。
                    // init 是 claude 启动首事件,model 权威;非空才写。
                    if !model.is_empty() {
                        let _ = update_claude_session_model(&app, &project_id, &tab_id, model.clone());
                    }
                    let cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("").to_string();
                    let slash_commands = v
                        .get("slash_commands")
                        .and_then(|s| s.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let _ = app.emit(
                        "claude-event",
                        ClaudeEvent {
                            project_id: project_id.clone(),
                            tab_id: tab_id.clone(),
                            payload: ClaudeEventPayload::Init {
                                claude_session_id: v
                                    .get("session_id")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                model,
                                cwd,
                                slash_commands,
                            },
                        },
                    );
                } else if subtype == "thinking_tokens" {
                    thinking_buf.push('.');
                    if thinking_buf.len() >= THINKING_BATCH_CHARS
                        || last_thinking_flush.elapsed() >= THINKING_FLUSH_INTERVAL
                    {
                        let _ = app.emit(
                            "claude-event",
                            ClaudeEvent {
                                project_id: project_id.clone(),
                                tab_id: tab_id.clone(),
                                payload: ClaudeEventPayload::Thinking {
                                    text: std::mem::take(&mut thinking_buf),
                                },
                            },
                        );
                        last_thinking_flush = Instant::now();
                    }
                } else if subtype == "status" {
                    // compact 状态:status="compacting" 开始;compact_result=success|failed 结束。
                    let status = v.get("status").and_then(|s| s.as_str()).map(|s| s.to_string());
                    let result = v
                        .get("compact_result")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                    let error = v
                        .get("compact_error")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                    // 后端 status 联动:compacting → Compacting;result 到达 → 复位 Idle(compact 仍是进行中轮的一部分,
                    // 但 compact 引擎已结束,下一轮 result 才真正结束本 compact 轮)。
                    if status.as_deref() == Some("compacting") {
                        let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Compacting);
                    } else if result.is_some() {
                        let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Running);
                    }
                    let _ = app.emit(
                        "claude-event",
                        ClaudeEvent {
                            project_id: project_id.clone(),
                            tab_id: tab_id.clone(),
                            payload: ClaudeEventPayload::CompactStatus { status, result, error },
                        },
                    );
                } else if subtype == "compact_boundary" {
                    // compact 成功边界:透传完整 compact_metadata。
                    let metadata = v.get("compact_metadata").cloned().unwrap_or(serde_json::Value::Null);
                    let _ = app.emit(
                        "claude-event",
                        ClaudeEvent {
                            project_id: project_id.clone(),
                            tab_id: tab_id.clone(),
                            payload: ClaudeEventPayload::CompactBoundary { metadata },
                        },
                    );
                }
            }
            "assistant" => {
                flush_thinking(&app, &project_id, &tab_id, &mut thinking_buf);
                let message = v.get("message").cloned().unwrap_or(serde_json::Value::Null);
                let _ = app.emit(
                    "claude-event",
                    ClaudeEvent {
                        project_id: project_id.clone(),
                        tab_id: tab_id.clone(),
                        payload: ClaudeEventPayload::Assistant { message },
                    },
                );
            }
            "user" => {
                // 跳过 isReplay && local-command-stdout(Compacted Tip 回放噪音,非真实用户消息)。
                let is_replay = v.get("isReplay").and_then(|b| b.as_bool()).unwrap_or(false);
                let content_str = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("");
                if is_replay && content_str.contains("<local-command-stdout>") {
                    continue;
                }
                flush_thinking(&app, &project_id, &tab_id, &mut thinking_buf);
                let message = v.get("message").cloned().unwrap_or(serde_json::Value::Null);
                let _ = app.emit(
                    "claude-event",
                    ClaudeEvent {
                        project_id: project_id.clone(),
                        tab_id: tab_id.clone(),
                        payload: ClaudeEventPayload::User { message },
                    },
                );
            }
            "result" => {
                flush_thinking(&app, &project_id, &tab_id, &mut thinking_buf);
                // 长进程:result 仅标志一轮结束,置 Idle(child 保持 Some,进程不退)。
                let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Idle);
                let success = v.get("subtype").and_then(|s| s.as_str()) == Some("success");
                let is_error = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(!success);
                let payload = ClaudeEventPayload::Result {
                    success: success && !is_error,
                    duration_ms: v.get("duration_ms").and_then(|d| d.as_u64()).unwrap_or(0),
                    num_turns: v.get("num_turns").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
                    total_cost_usd: v
                        .get("total_cost_usd")
                        .and_then(|c| c.as_f64())
                        .unwrap_or(0.0),
                    stop_reason: v
                        .get("stop_reason")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string()),
                    error: if is_error {
                        v.get("result").and_then(|r| r.as_str()).map(|s| s.to_string())
                    } else {
                        None
                    },
                    usage: v.get("usage").cloned(),
                    context_window: v
                        .get("modelUsage")
                        .and_then(|mu| mu.as_object())
                        .and_then(|o| o.values().next())
                        .and_then(|m| m.get("contextWindow"))
                        .and_then(|c| c.as_u64()),
                };
                let _ = app.emit(
                    "claude-event",
                    ClaudeEvent {
                        project_id: project_id.clone(),
                        tab_id: tab_id.clone(),
                        payload,
                    },
                );
            }
            _ => {
                log::trace!("claude unknown event type '{evt_type}', tab {tab_id}");
            }
        }
    }

    // stdout EOF = 长进程退出(正常情况不该退出 → 异常,除非主动 kill)。
    let killed = take_killed_flag(&app, &project_id, &tab_id);
    if !killed {
        // 崩溃/异常退出:emit Terminated{eof} + 置 Error,transport 下次 send 重启。
        let _ = app.emit(
            "claude-event",
            ClaudeEvent {
                project_id: project_id.clone(),
                tab_id: tab_id.clone(),
                payload: ClaudeEventPayload::Terminated {
                    reason: "eof".to_string(),
                },
            },
        );
        let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Error);
    } else {
        // 主动 kill(中断/重启):置 Idle,不发 error(kill_claude 已主动 emit interrupted)。
        let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Idle);
    }
    // child + stdin 置 None(进程已退,下次 send 触发 ensureStarted 重启)。
    let _ = take_child(&app, &project_id, &tab_id);
    let _ = take_stdin(&app, &project_id, &tab_id);
    log::info!(
        "claude read loop ended, tab {tab_id} project {project_id}, killed={killed}"
    );
}

/// flush 残留 thinking_buf(若非空)并 emit Thinking,重置 last_flush 由调用方负责。
fn flush_thinking(app: &AppHandle, project_id: &str, tab_id: &str, buf: &mut String) {
    if buf.is_empty() {
        return;
    }
    let _ = app.emit(
        "claude-event",
        ClaudeEvent {
            project_id: project_id.to_string(),
            tab_id: tab_id.to_string(),
            payload: ClaudeEventPayload::Thinking {
                text: std::mem::take(buf),
            },
        },
    );
}

/// 回填 claude_session_id 到 registry(短锁)。首轮 init 后调用,后续轮 spawn 据此带 --resume。
fn update_claude_session_id(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    sid: String,
) -> Result<(), String> {
    // 1) 回填 registry(短锁)。始终更新:重启 resume 同 id 幂等;/clear 若换 id 捕获最新。
    let registry = app.state::<ClaudeRegistry>();
    if let Ok(by_project) = registry.by_project.lock() {
        if let Some(session) = by_project
            .get(project_id)
            .and_then(|sessions| sessions.get(tab_id))
        {
            if let Ok(mut g) = session.claude_session_id.lock() {
                *g = Some(sid.clone());
            }
        }
    }
    // 2) 持久化到 AppState(跨重启 --resume 用)。短锁改 + 克隆 + 释放 + save;失败仅 warn 不阻塞。
    let app_state = app.state::<AppState>();
    let snapshot = {
        let mut snap = app_state.inner.lock().map_err(|e| e.to_string())?;
        if let Some(project) = snap.projects.iter_mut().find(|p| p.id == project_id) {
            project.claude_tab_sessions.insert(tab_id.to_string(), sid);
        }
        snap.clone()
    };
    if let Err(e) = crate::state::persistence::save(app, &snapshot) {
        log::warn!("update_claude_session_id: persist failed: {e}");
    }
    Ok(())
}

/// 写当前会话 model 到 registry(init 回填 / 前端 `/model` 切换 / 真实 assistant 事件同步)。
/// 供独立窗口(detach)新建 transport 时 `get_claude_session_model` 读回填 meta.model。
fn update_claude_session_model(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    model: String,
) -> Result<(), String> {
    let registry = app.state::<ClaudeRegistry>();
    let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut g) = session.model.lock() {
            *g = Some(model);
        }
    }
    Ok(())
}

/// 取出并清空 child(短锁置 None)。读循环 EOF 时调用(进程已退,下次 send 触发 ensureStarted 重启)。
fn take_child(app: &AppHandle, project_id: &str, tab_id: &str) -> Result<(), String> {
    let registry = app.state::<ClaudeRegistry>();
    let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut g) = session.child.lock() {
            // child 可能已被 kill_claude 取走(take),这里再 take 一次幂等。
            let _ = g.take();
        }
    }
    Ok(())
}

/// 取出并清空 stdin(短锁置 None)。读循环 EOF 时调用(进程已退,stdin 失效)。
fn take_stdin(app: &AppHandle, project_id: &str, tab_id: &str) -> Result<(), String> {
    let registry = app.state::<ClaudeRegistry>();
    let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut g) = session.stdin.lock() {
            // stdin 可能已被 kill_claude/send_claude_message 取走,这里再 take 一次幂等。
            let _ = g.take();
        }
    }
    Ok(())
}

/// 读取并清空 killed 标志(短锁)。读循环 EOF 时调用,据返回值决定是否 emit error Terminated。
/// 清空是为了让下一次 start_claude_session 重启时 killed 复位为 false(start_claude_session 也会主动置 false)。
fn take_killed_flag(app: &AppHandle, project_id: &str, tab_id: &str) -> bool {
    let registry = app.state::<ClaudeRegistry>();
    let by_project = match registry.by_project.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut k) = session.killed.lock() {
            return std::mem::take(&mut *k);
        }
    }
    false
}
