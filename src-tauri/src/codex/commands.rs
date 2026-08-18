//! codex exec 子进程的 spawn / kill + 后台读循环。
//!
//! 与 `claude/commands.rs` 并列但进程模型不同(见 `super` 模块注释):**每轮一个短命
//! `codex exec --json` 进程**。发消息 = spawn(带 `resume <id>` 续接历史),进程跑完即 EOF,
//! 无长进程管理/无 stdin 写入。
//!
//! 复用 `pty::commands` 的 `command_no_window`(CREATE_NO_WINDOW)/`resolve_on_path`/
//! `validate_cwd`(项目根校验)。`kill_child_tree` 与 claude 同实现(taskkill /F /T 杀进程树,
//! .cmd shim 下 node 是孙子进程),按项目惯例内联复制(M6 统一工具层时再合并)。
//!
//! 不变量(对齐 `claude/commands.rs`):
//! 1. `std::sync::Mutex` 持锁不跨 `.await`。
//! 2. 阻塞 kill 丢 `spawn_blocking` 且锁已释放。
//! 3. 读循环 fire-and-forget。
//! 4. 前端先 `listen("codex-event")` 再 `invoke("send_codex_message")`(防丢首批事件)。
//! 5. **stdin 必须 `Stdio::null()`**(实测:codex 检测 stdin 非 tty 会卡在
//!    "Reading additional input from stdin...");stderr 也 null(Rust log 混有非 JSON 行)。

use std::io::BufRead;
use std::process::Stdio;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use super::{
    CodexEvent, CodexEventPayload, CodexRegistry, CodexSession, CodexStatus, SessionConfig,
};
use crate::pty::commands::{command_no_window, resolve_on_path, validate_cwd};

/// `list_codex_models` 返回项(与前端 `CodexModelInfo` camelCase 对齐)。
///
/// 来源:`~/.codex/cc-switch-model-catalog.json` 的 `models[]`(cc-switch 等工具维护的模型
/// 目录,含 slug/显示名/上下文窗口/支持的 reasoning 档位)。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelInfo {
    pub slug: String,
    pub display_name: String,
    pub context_window: Option<u64>,
    pub reasoning_levels: Vec<String>,
}

/// 发一轮 codex 对话 = spawn 一个短命 `codex exec --json` 进程。
///
/// 命令形态(实测确认):
/// - 首轮:`codex exec --skip-git-repo-check --json [-C cwd] [-s sandbox] [-m model]
///   [-c model_reasoning_effort="X"] "<prompt>"`
/// - 续接:`codex exec resume <thread_id> --skip-git-repo-check --json ... "<prompt>"`
///   (thread.started 返回的 thread_id 即 resume id,同 id 续接)。
///
/// busy 检查:status=Running -> Err(前端应先 interrupt)。若上轮 child 残存(理论不该有,
/// 每轮跑完 EOF 即 None)则先 kill 进程树再启新轮。
#[tauri::command]
pub async fn send_codex_message(
    app: AppHandle,
    state: State<'_, CodexRegistry>,
    project_id: String,
    tab_id: String,
    cwd: Option<String>,
    prompt: String,
    sandbox: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    resume_session_id: Option<String>,
    new_session: Option<bool>,
) -> Result<(), String> {
    // 1) 短锁:取/建 session + busy 检查 + take 残存 child(置 killed=true 让旧读循环不发 error)。
    let old_child = {
        let mut by_project = state.by_project.lock().map_err(|e| {
            log::error!("send_codex_message: state lock poisoned: {e}");
            e.to_string()
        })?;
        let sessions = by_project.entry(project_id.clone()).or_default();
        let session = sessions.entry(tab_id.clone()).or_insert_with(|| CodexSession {
            codex_session_id: Mutex::new(None),
            child: Mutex::new(None),
            config: Mutex::new(SessionConfig::default()),
            status: Mutex::new(CodexStatus::Idle),
            model: Mutex::new(None),
            config_hash: Mutex::new(None),
            killed: Mutex::new(false),
        });
        {
            let st = session.status.lock().map_err(|e| e.to_string())?;
            if *st == CodexStatus::Running {
                return Err("codex session busy: interrupt the current turn first".to_string());
            }
        }
        let old = session.child.lock().ok().and_then(|mut g| g.take());
        if old.is_some() {
            if let Ok(mut k) = session.killed.lock() {
                *k = true;
            }
        }
        old
    };
    // 2) 放锁后 kill 残存进程树(放锁 + spawn_blocking,不跨 await 持锁)。
    if let Some(mut c) = old_child {
        let _ = tokio::task::spawn_blocking(move || {
            kill_child_tree(&mut c);
        })
        .await;
    }

    // 3) 文件 IO 在锁外:算 spawn 时刻 config 哈希 + 读 config.toml 当前默认 model。
    let spawn_hash = codex_config_hash();
    let config_model = get_codex_current_model_impl();

    // 4) 短锁:写 config + config_hash + model(供 detach 窗口 get_codex_session_model)+
    //    读 resume id(用户指定恢复历史会话时仅当无 live id 生效,并立即存 registry)。
    //    **不清 killed**:killed 是给旧读循环 EOF 判断用的(旧循环 take 走后自然 false);
    //    在此清 false 会与旧读循环的异步 EOF 竞态误发 Terminated{normal}。
    let (resume_id, cwd_v, sandbox_str, model_str, effort_str) = {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        let session = by_project
            .get(&project_id)
            .and_then(|s| s.get(&tab_id))
            .ok_or("codex session missing after ensure")?;
        let cwd_v = match &cwd {
            Some(path) => match validate_cwd(std::path::Path::new(path)) {
                Ok(p) => Some(p),
                Err(reason) => {
                    log::warn!("send_codex_message: cwd rejected ({reason}): {path}, using default");
                    None
                }
            },
            None => None,
        };
        let sb = sandbox.unwrap_or_else(|| "workspace-write".to_string());
        if let Ok(mut cfg) = session.config.lock() {
            *cfg = SessionConfig {
                cwd: cwd_v.clone(),
                sandbox: sb.clone(),
                model: model.clone(),
                reasoning_effort: reasoning_effort.clone(),
            };
        }
        if let Ok(mut h) = session.config_hash.lock() {
            *h = Some(spawn_hash);
        }
        // model:优先 -m 传的显式值;None 则记 config.toml 默认(状态栏回填用)。
        let effective_model = model.clone().or_else(|| config_model.clone());
        if let Ok(mut m) = session.model.lock() {
            *m = effective_model;
        }
        let mut rid = session
            .codex_session_id
            .lock()
            .ok()
            .and_then(|g| g.clone());
        if new_session == Some(true) {
            // /new 开新会话:忽略 live id(本轮不 resume),并清 registry(本轮 thread.started
            // 会回填新 id)。
            rid = None;
            if let Ok(mut g) = session.codex_session_id.lock() {
                *g = None;
            }
        } else if let Some(user_rid) = &resume_session_id {
            // 用户 ↻ 显式恢复某历史 thread:覆盖 registry 的旧 thread id(已终止 tab 的
            // codex_session_id 仍存上一轮 id,不覆盖则恢复的是旧 thread 而非用户选的)。
            // 前端 resumeSession 已设 resumeSessionId,CodexTransport.send 带它到这里。
            rid = Some(user_rid.clone());
            if let Ok(mut g) = session.codex_session_id.lock() {
                *g = Some(user_rid.clone());
            }
        }
        (rid, cwd_v, sb, model, reasoning_effort)
    };

    // 5) 构造命令。Windows:codex 经 volta 装为 codex.cmd shim,用 cmd.exe /c 包装(同 claude)。
    let codex_program = resolve_on_path("codex")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "codex".to_string());
    log::info!("send_codex_message: resolved codex program = {codex_program}");
    #[cfg(windows)]
    let mut cmd = {
        let needs_shell = codex_program.ends_with(".cmd") || codex_program.ends_with(".bat");
        if needs_shell {
            let mut c = command_no_window("cmd.exe");
            c.arg("/c").arg(&codex_program);
            c
        } else {
            command_no_window(&codex_program)
        }
    };
    #[cfg(not(windows))]
    let mut cmd = command_no_window(&codex_program);
    cmd.arg("exec");
    if let Some(id) = &resume_id {
        cmd.arg("resume").arg(id);
    }
    cmd.arg("--skip-git-repo-check")
        .arg("--json");
    if let Some(p) = &cwd_v {
        cmd.arg("-C").arg(p);
    }
    cmd.arg("-s").arg(&sandbox_str);
    if let Some(m) = &model_str {
        cmd.arg("-m").arg(m);
    }
    if let Some(e) = &effort_str {
        // -c 值按 TOML 解析(help 示例 -c model="o3"),字符串须带引号。
        cmd.arg("-c").arg(format!("model_reasoning_effort=\"{e}\""));
    }
    cmd.arg(&prompt);
    // stdin null(实测必须,否则 codex 等 stdin 卡死) + stderr null(Rust log 非 JSON 混入)。
    cmd.stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());
    if let Some(p) = &cwd_v {
        cmd.current_dir(p);
    }

    log::info!(
        "send_codex_message: tab {tab_id} project {project_id} resume={} cwd={}",
        resume_id.is_some(),
        cwd_v.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "(default)".to_string())
    );

    // 6) spawn。失败 emit Terminated{spawn failed} + 置 Error(前端显示错误)。
    let mut child = cmd.spawn().map_err(|e| {
        log::error!("send_codex_message: failed to spawn codex for tab {tab_id}: {e}");
        let _ = set_session_status(&app, &project_id, &tab_id, CodexStatus::Error);
        let _ = app.emit(
            "codex-event",
            CodexEvent {
                project_id: project_id.clone(),
                tab_id: tab_id.clone(),
                payload: CodexEventPayload::Terminated {
                    reason: format!("spawn failed: {e}"),
                },
            },
        );
        e.to_string()
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "codex stdout not captured".to_string())?;

    // 7) 短锁:child 存 registry + status=Running(读循环 turn.started 也会置,这里先行)。
    {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        if let Some(session) = by_project
            .get(&project_id)
            .and_then(|sessions| sessions.get(&tab_id))
        {
            if let Ok(mut g) = session.child.lock() {
                *g = Some(child);
            }
            if let Ok(mut s) = session.status.lock() {
                *s = CodexStatus::Running;
            }
        }
    }

    // 8) fire-and-forget 读循环(每轮进程跑完即 EOF 结束)。
    let app_handle = app.clone();
    let pid = project_id.clone();
    let tid = tab_id.clone();
    tokio::task::spawn_blocking(move || {
        run_read_loop(app_handle, pid, tid, stdout);
    });

    Ok(())
}

/// 中断当前轮(kill 当前 exec 进程树)。codex exec 无中断信号,中断靠 kill 进程。
///
/// 短锁:killed=true + take child,放锁后 spawn_blocking kill+wait,emit
/// `Terminated{interrupted}`(前端当 idle 不显错误)。下次 send 不带 resume 的话开新会话;
/// 带 registry 里的 live id 则续接被中断前的历史。无在跑 child 时幂等(仍 emit 复位状态)。
#[tauri::command]
pub async fn kill_codex(
    app: AppHandle,
    state: State<'_, CodexRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<(), String> {
    let child_opt = {
        let by_project = state.by_project.lock().map_err(|e| {
            log::error!("kill_codex: state lock poisoned: {e}");
            e.to_string()
        })?;
        let session = by_project
            .get(&project_id)
            .and_then(|sessions| sessions.get(&tab_id));
        if let Some(session) = session {
            if let Ok(mut k) = session.killed.lock() {
                *k = true;
            }
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
        log::info!("kill_codex: killed tab {tid} project {pid}");
    } else {
        log::info!("kill_codex: tab {tid} project {pid} not running, idempotent ok");
    }
    let _ = set_session_status(&app_handle, &project_id, &tab_id, CodexStatus::Idle);
    // emit interrupted 让前端复位(applyEvent 把 interrupted 当 idle 非 error)。
    let _ = app_handle.emit(
        "codex-event",
        CodexEvent {
            project_id: pid,
            tab_id: tid,
            payload: CodexEventPayload::Terminated {
                reason: "interrupted".to_string(),
            },
        },
    );
    Ok(())
}

/// 列出 codex 可选模型(读 `~/.codex/cc-switch-model-catalog.json` 的 `models[]`)。
///
/// cc-switch 等供应商切换工具维护该目录(含 slug/显示名/context_window/supported_
/// reasoning_levels)。过滤 `visibility != "list"` 的隐藏项。供前端模型选择器每次打开时
/// 实时拉取--cc-switch 切换后下次打开即见新目录,无需改前端预置。文件缺失返回空数组。
#[tauri::command]
pub fn list_codex_models() -> Result<Vec<CodexModelInfo>, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|e| format!("home dir not found: {e}"))?;
    let path = std::path::Path::new(&home)
        .join(".codex")
        .join("cc-switch-model-catalog.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()), // 无 catalog(cc-switch 未用过) -> 空列表非错误
    };
    let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let arr = v
        .get("models")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for m in arr {
        let vis = m.get("visibility").and_then(|x| x.as_str()).unwrap_or("list");
        if vis != "list" {
            continue;
        }
        let slug = m.get("slug").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if slug.is_empty() {
            continue;
        }
        let display_name = m
            .get("display_name")
            .and_then(|x| x.as_str())
            .unwrap_or(&slug)
            .to_string();
        let context_window = m.get("context_window").and_then(|x| x.as_u64());
        let reasoning_levels = m
            .get("supported_reasoning_levels")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|l| l.get("effort").and_then(|e| e.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        out.push(CodexModelInfo {
            slug,
            display_name,
            context_window,
            reasoning_levels,
        });
    }
    Ok(out)
}

/// 读 `~/.codex/config.toml` 顶层 `model = "..."` 当前默认模型。
///
/// 供前端 CodexPane 打开 tab 时回填 meta.model(codex exec --json 事件流不带 model 字段,
/// 与 claude init 回填 model 不同)。行扫描:顶层 key 在首个 `[section]` 前。
#[tauri::command]
pub fn get_codex_current_model() -> Result<Option<String>, String> {
    Ok(get_codex_current_model_impl())
}

fn get_codex_current_model_impl() -> Option<String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let content =
        std::fs::read_to_string(std::path::Path::new(&home).join(".codex").join("config.toml"))
            .ok()?;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with('#') || t.is_empty() {
            continue;
        }
        if t.starts_with('[') {
            break; // 进入 section,顶层段结束
        }
        if let Some(rest) = t.strip_prefix("model") {
            let rest = rest.trim_start();
            if let Some(val) = rest.strip_prefix('=') {
                let v = val.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// 读 config.toml + catalog 两文件内容算哈希(cc-switch 切供应商会改写它们)。
/// 任一文件缺失按空串(稳定值,仍可检测「从无到有」)。
fn codex_config_hash() -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    let mut combined = String::new();
    if let Some(home) = &home {
        combined.push_str(
            &std::fs::read_to_string(
                std::path::Path::new(home).join(".codex").join("config.toml"),
            )
            .unwrap_or_default(),
        );
        combined.push('\n');
        combined.push_str(
            &std::fs::read_to_string(
                std::path::Path::new(home)
                    .join(".codex")
                    .join("cc-switch-model-catalog.json"),
            )
            .unwrap_or_default(),
        );
    }
    let mut hasher = DefaultHasher::new();
    combined.hash(&mut hasher);
    hasher.finish()
}

/// 检测 codex 配置(config.toml + catalog)相对本会话上次 spawn 是否已变化。
///
/// cc-switch 等工具切供应商会改写这两个文件。与 claude 不同:**codex 每轮新进程自动读
/// 最新 config,无需重启进程**--前端拿到 true 仅刷新模型目录/当前 model 显示即可。
/// 会话未 spawn 过(无基线)返回 false。
#[tauri::command]
pub fn codex_config_changed(
    state: State<'_, CodexRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<bool, String> {
    let stored = {
        let by_project = state.by_project.lock().map_err(|e| {
            log::error!("codex_config_changed: state lock poisoned: {e}");
            e.to_string()
        })?;
        by_project
            .get(&project_id)
            .and_then(|sessions| sessions.get(&tab_id))
            .and_then(|session| session.config_hash.lock().ok())
            .and_then(|g| *g)
    };
    Ok(stored.map(|h| codex_config_hash() != h).unwrap_or(false))
}

/// 取某 codex 会话当前 model(短锁读 registry)。
///
/// 供独立窗口(detach)新建 CodexTransport 时回填 `meta.model`(spawn 时已写:-m 显式值或
/// config.toml 默认)。session 不存在或未记录返回 None。
#[tauri::command]
pub fn get_codex_session_model(
    state: State<'_, CodexRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<Option<String>, String> {
    let by_project = state.by_project.lock().map_err(|e| {
        log::error!("get_codex_session_model: state lock poisoned: {e}");
        e.to_string()
    })?;
    let model = by_project
        .get(&project_id)
        .and_then(|sessions| sessions.get(&tab_id))
        .and_then(|session| session.model.lock().ok())
        .and_then(|g| g.clone());
    Ok(model)
}

/// 写某 codex 会话当前 model 到 registry(短锁)。前端 setModel 乐观切换后调,供 detach
/// 窗口 get_codex_session_model 读回填。spawn 路径后端已自写,通常无需前端再调。
#[tauri::command]
pub fn set_codex_session_model(
    app: AppHandle,
    project_id: String,
    tab_id: String,
    model: String,
) -> Result<(), String> {
    let registry = app.state::<CodexRegistry>();
    let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
    if let Some(session) = by_project
        .get(&project_id)
        .and_then(|sessions| sessions.get(&tab_id))
    {
        if let Ok(mut g) = session.model.lock() {
            *g = Some(model);
        }
    }
    Ok(())
}

// -- 读循环与辅助(均短锁,失败静默不阻断主流程) --

/// 读循环:逐行读 codex exec stdout(JSONL),按顶层 type 分类 emit `codex-event`。
///
/// 顶层事件仅 6 种(实测):thread.started / item.started / item.completed / turn.started /
/// turn.completed + 未知。item 内容透传 Value,前端 codexStream 按 item.type 归并。
/// 非 JSON 行(启动提示 "Reading additional input from stdin..." 等)warn 跳过。
///
/// EOF 语义(与 claude 长进程相反):codex 每轮 exec 跑完即 EOF,**正常结束**。仅 killed=true
/// (主动 kill/中断)时不发 Terminated(kill_codex 已 emit interrupted);否则 emit
/// `Terminated{normal}`(前端当 idle 不显错误)。
fn run_read_loop(app: AppHandle, project_id: String, tab_id: String, stdout: std::process::ChildStdout) {
    let reader = std::io::BufReader::new(stdout);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                log::warn!("codex read error, tab {tab_id}: {e}");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                // 非 JSON 行(如启动提示文本):跳过不阻断。
                log::trace!("codex non-json line, tab {tab_id}: {}", trimmed.chars().take(120).collect::<String>());
                continue;
            }
        };

        let evt_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let payload = match evt_type {
            "thread.started" => {
                let sid = v
                    .get("thread_id")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                if !sid.is_empty() {
                    update_codex_session_id(&app, &project_id, &tab_id, sid.clone());
                }
                CodexEventPayload::Init { session_id: sid }
            }
            "item.started" => CodexEventPayload::ItemStarted {
                item: v.get("item").cloned().unwrap_or(serde_json::Value::Null),
            },
            "item.completed" => CodexEventPayload::ItemCompleted {
                item: v.get("item").cloned().unwrap_or(serde_json::Value::Null),
            },
            "turn.started" => {
                let _ = set_session_status(&app, &project_id, &tab_id, CodexStatus::Running);
                CodexEventPayload::TurnStarted
            }
            "turn.completed" => {
                let _ = set_session_status(&app, &project_id, &tab_id, CodexStatus::Idle);
                CodexEventPayload::TurnCompleted {
                    usage: v.get("usage").cloned(),
                }
            }
            _ => {
                log::trace!("codex unknown event type '{evt_type}', tab {tab_id}");
                continue;
            }
        };
        let _ = app.emit(
            "codex-event",
            CodexEvent {
                project_id: project_id.clone(),
                tab_id: tab_id.clone(),
                payload,
            },
        );
    }

    // EOF:每轮 exec 正常结束(区别于 claude 长进程 EOF=异常)。
    let killed = take_killed_flag(&app, &project_id, &tab_id);
    if !killed {
        let _ = app.emit(
            "codex-event",
            CodexEvent {
                project_id: project_id.clone(),
                tab_id: tab_id.clone(),
                payload: CodexEventPayload::Terminated {
                    reason: "normal".to_string(),
                },
            },
        );
    }
    let _ = set_session_status(&app, &project_id, &tab_id, CodexStatus::Idle);
    let _ = take_child(&app, &project_id, &tab_id);
    log::info!(
        "codex read loop ended, tab {tab_id} project {project_id}, killed={killed}"
    );
}

/// 回填 codex_session_id 到 registry(短锁)。thread.started 后调用,后续轮 resume 用。
///
/// 始终更新(同 id 幂等;/new 开新会话换 id 时捕获最新)。不持久化到 AppState(claude 有
/// claude_tab_sessions 跨重启 resume;codex MVP 不持久化,重启 app 后 tab 开新会话,
/// 历史会话仍可经 SessionBrowser 手动 resume)。
fn update_codex_session_id(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    sid: String,
) {
    let registry = app.state::<CodexRegistry>();
    // 显式 match 绑定 guard(避免 if let 临时值存活到块尾的 E0597,与 claude 同场景不同写法)。
    let by_project = match registry.by_project.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut g) = session.codex_session_id.lock() {
            *g = Some(sid);
        }
    }
}

/// 设某 session 的状态(短锁)。失败静默(锁中毒不阻断主流程)。
fn set_session_status(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    status: CodexStatus,
) -> Result<(), String> {
    let registry = app.state::<CodexRegistry>();
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

/// kill 整个 codex 进程树并收尸。与 `claude/commands.rs::kill_child_tree` 同实现:
/// Windows 上 codex 经 `cmd.exe /c codex.cmd` 包装,`child.kill()` 只杀 cmd.exe 不杀 shim
/// 内部的 node 孙子进程,用 `taskkill /F /T /PID` 杀整棵树;taskkill 不可用回退 child.kill;
/// 非 Windows 直接 kill。末尾 wait() 收尸防僵尸。
pub(super) fn kill_child_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        let killed = match command_no_window("taskkill.exe")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
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

/// 取出并清空 child(短锁置 None)。读循环 EOF 时调用(进程已退,下次 send 前 busy 检查放行)。
fn take_child(app: &AppHandle, project_id: &str, tab_id: &str) -> Result<(), String> {
    let registry = app.state::<CodexRegistry>();
    let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut g) = session.child.lock() {
            let _ = g.take();
        }
    }
    Ok(())
}

/// 读取并清空 killed 标志(短锁)。读循环 EOF 时调用,据返回值决定是否 emit Terminated。
fn take_killed_flag(app: &AppHandle, project_id: &str, tab_id: &str) -> bool {
    let registry = app.state::<CodexRegistry>();
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
