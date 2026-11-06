//! codex `app-server` 长连接协议层(JSON-RPC over stdio,codex 0.166.0 实测)。
//!
//! 取代旧「每轮短命 `codex exec --json`」模型:一个 codex tab = 一个常驻 `codex app-server`
//! 进程,与 claude 的单长进程同构。收益:①轮间上下文在进程内常驻(无需每轮 resume CLI 参数);
//! ②真实流式(`item/agentMessage/delta` 打字机,exec 模式只在轮末一次性给全文);③权威 token
//! 用量(`thread/tokenUsage/updated` 含 modelContextWindow,exec 模式的 usage 是快照);④**实时
//! 审批**:exec 模式 on-request 被强制 never,审批请求只有 app-server 会作为 JSON-RPC 服务端
//! 请求发回来,前端真正能逐条批/拒。
//!
//! 协议帧(codex 0.166.0 实测,**响应与通知都不带 `jsonrpc` 字段**):
//! - client 请求:  `{"jsonrpc":"2.0","id":N,"method":"turn/start","params":{...}}`
//! - 响应:         `{"id":N,"result":{...}}` / `{"id":N,"error":{"message":...}}`
//! - 通知:         `{"method":"item/agentMessage/delta","params":{...},"emittedAtMs":...}`
//! - server 请求:  `{"id":"...","method":"<approval method>","params":{...}}`(审批,需回写
//!   `{"id":原id,"result":{"decision":...}}`)。**decision 枚举按方法代际分派**(`codex
//!   app-server generate-json-schema` 0.166 权威 schema):新代 `item/commandExecution/
//!   requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`
//!   用 `accept`/`decline`(另可 `acceptForSession`/`cancel`);旧代 `execCommandApproval`、
//!   `applyPatchApproval` 用 `approved`/`{denied:{rejection}}`(denied 是必带 rejection 文本的
//!   对象形状,非简单枚举)。回错枚举 server 反序列化失败、审批永久挂起(turn 卡死无任何
//!   反馈)——曾因统一回旧代 `approved` 踩过。
//!
//! 方法表(实测/源码):`initialize`(成功后**必须补发 `initialized` 通知**,0.166
//! ClientNotification 仅此一种) / `thread/start`(params: cwd, model, approvalPolicy,
//! sandbox;**schema 无 effort 字段**,推理档只能 per-turn 传) / `thread/resume`(threadId,
//! cwd, **excludeTurns:true** 轻量恢复,官方提示全量 hydration 已 deprecated) /
//! `turn/start`(threadId, input:[{type:"text",text}], model/**effort** per-turn override,
//! 语义「for this turn and subsequent turns」,传显式 null 可清除 override) /
//! `turn/interrupt`(**threadId + turnId 均必填**,0.166 schema;缺 turnId 被拒) / `model/list`。
//!
//! 通知 → `CodexEventPayload` 映射(详见 `dispatch_notification`):
//! thread/started→Init;turn/started→TurnStarted;turn/completed→TurnCompleted(usage 恒 None,
//! 用量走 thread/tokenUsage/updated);item/started|completed→透传 item;item/agentMessage/delta
//! 与 item/reasoning/summaryTextDelta、item/commandOutput/delta→ItemDelta;thread/tokenUsage/
//! updated→UsageUpdated(usage=params.tokenUsage.**last**=最后一轮=当前上下文口径;total 是
//! 会话累计,拿来做 ctx% 会虚高超窗,2026-11-04 用户实测),contextWindow=params.tokenUsage.
//! modelContextWindow;thread/status/changed 只维护 Running/Idle 不发事件。
//!
//! 生命周期:进程崩溃/退出(EOF)→ `Terminated{reason:"exit"}` + initialized=false,**registry
//! 里的 live thread id 不清**——下轮 send 的 ensure 重拉进程后走 `thread/resume` 同 id 续接
//! (rollout 在磁盘,跨进程可续),杀进程不丢会话。

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::process::{ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::commands::{
    emit_spawn_failed, kill_child_tree, mark_process_dead, set_session_status, store_turn_id,
    update_codex_session_id,
};
use super::{CodexEvent, CodexEventPayload, CodexRegistry, CodexSession, CodexStatus, PendingServerRequest};
use crate::pty::commands::{command_no_window, resolve_on_path};

/// client 请求默认超时(.initialize ~1s,thread/start 2-3s,turn/start 即时;留足余量)。
const RPC_TIMEOUT: Duration = Duration::from_secs(60);
/// initialize 超时(冷启动最慢的一步,单独收紧好定位)。
const INIT_TIMEOUT: Duration = Duration::from_secs(20);

/// 全局 spawn 串行锁:防止同 tab 并发 send 双拉进程(initialize ~1s,粗粒度可接受;
/// tokio 异步锁,允许跨 await——「持锁不跨 await」纪律针对 std::sync::Mutex 的注册表锁)。
static SPAWN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 审批 server 请求的稳定 key(id 可能是字符串或数字,统一字符串化)。
fn server_request_key(id: &Value) -> String {
    id.as_str().map(str::to_string).unwrap_or_else(|| id.to_string())
}

/// registry 里 ensure 一个空白 session(不存在则建;长进程字段全默认)。返回是否新建。
/// 只做 map 结构操作,不 spawn(调用方随后走 ensure_app_server)。
fn ensure_session_entry(state: &tauri::State<'_, CodexRegistry>, project_id: &str, tab_id: &str) -> Result<bool, String> {
    let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
    let sessions = by_project.entry(project_id.to_string()).or_default();
    if sessions.contains_key(tab_id) {
        return Ok(false);
    }
    sessions.insert(
        tab_id.to_string(),
        CodexSession {
            codex_session_id: Arc::new(Mutex::new(None)),
            current_turn_id: Arc::new(Mutex::new(None)),
            child: Mutex::new(None),
            stdin: Arc::new(Mutex::new(None)),
            request_seq: Arc::new(AtomicU64::new(0)),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            pending_server_requests: Arc::new(Mutex::new(HashMap::new())),
            initialized: Arc::new(AtomicBool::new(false)),
            config: Mutex::new(super::SessionConfig::default()),
            status: Arc::new(Mutex::new(CodexStatus::Idle)),
            model: Mutex::new(None),
            config_hash: Mutex::new(None),
            killed: Arc::new(AtomicBool::new(false)),
        },
    );
    Ok(true)
}

/// 确保 (project, tab) 的 app-server 长进程就绪:已就绪直接返回 Ok(false);未启动/已死则
/// spawn → 起读循环 → initialize → 置 initialized,返回 Ok(true)(= 本次新拉起,调用方
/// 据此决定是否要 `thread/resume` 既有 live id——新进程不认识旧 thread id,必须 resume)。
pub async fn ensure_app_server(
    app: &AppHandle,
    state: &tauri::State<'_, CodexRegistry>,
    project_id: &str,
    tab_id: &str,
    cwd: Option<&std::path::Path>,
) -> Result<bool, String> {
    ensure_session_entry(state, project_id, tab_id)?;

    // 快路径:进程活着(initialized 且 killed=false)直接返回。
    {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        let session = by_project
            .get(project_id)
            .and_then(|s| s.get(tab_id))
            .ok_or("codex session missing after ensure")?;
        if session.initialized.load(Ordering::SeqCst) && !session.killed.load(Ordering::SeqCst) {
            return Ok(false);
        }
    }

    // 慢路径:串行 spawn(防双拉)。
    let _guard = SPAWN_LOCK.lock().await;
    // double-check:等锁期间可能已被并发方拉起。
    {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        if let Some(session) = by_project.get(project_id).and_then(|s| s.get(tab_id)) {
            if session.initialized.load(Ordering::SeqCst) && !session.killed.load(Ordering::SeqCst) {
                return Ok(false);
            }
        }
    }

    // 1) 构造命令(Windows codex 经 volta 装为 codex.cmd,cmd.exe /c 包装,同 exec 模式)。
    let codex_program = resolve_on_path("codex")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "codex".to_string());
    let mut cmd: Command = {
        #[cfg(windows)]
        {
            let needs_shell = codex_program.ends_with(".cmd") || codex_program.ends_with(".bat");
            if needs_shell {
                let mut c = command_no_window("cmd.exe");
                c.arg("/c").arg(&codex_program);
                c
            } else {
                command_no_window(&codex_program)
            }
        }
        #[cfg(not(windows))]
        {
            command_no_window(&codex_program)
        }
    };
    cmd.arg("app-server");
    if let Some(p) = cwd {
        cmd.current_dir(p);
    }
    // stderr 走管道进日志(此前 Stdio::null():进程崩溃原因完全不可见,EOF 只能猜)。
    // 必须持续读排空,否则管道缓冲写满会阻塞 app-server 自身的诊断输出。
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    log::info!("ensure_app_server: spawning codex app-server for tab {tab_id} project {project_id}");

    // 2) spawn + 取管道(失败置 Error 并通知前端)。
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("spawn failed: {e}");
            log::error!("ensure_app_server: {msg}");
            emit_spawn_failed(app, project_id, tab_id, &msg);
            return Err(msg);
        }
    };
    let stdin_pipe = child.stdin.take().ok_or("app-server stdin not captured")?;
    let stdout: ChildStdout = child.stdout.take().ok_or("app-server stdout not captured")?;
    let stderr: ChildStderr = child.stderr.take().ok_or("app-server stderr not captured")?;

    // 3) 短锁:child/stdin 入 registry + **换新 killed/initialized Arc**(不复位旧 Arc)。
    //    旧读循环持着旧 Arc 直到 EOF;若在此复位同一 Arc,旧循环迟到 EOF 时 swap 读到 false
    //    → 误发 Terminated{exit}(前端显「已终止」)。换新 Arc 后旧循环的 killed 仍为 kill
    //    时置的 true,EOF 静默;新进程用全新标志,互不干扰。
    let (stdin_arc, request_seq, pending_requests, pending_server_requests, killed_flag, initialized_flag) = {
        let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        let session = by_project
            .get_mut(project_id)
            .and_then(|s| s.get_mut(tab_id))
            .ok_or("codex session missing after ensure")?;
        // 残留清理:上一个进程若还挂着(killed=true 未收尸),先杀。
        if let Some(mut old) = session.child.lock().ok().and_then(|mut g| g.take()) {
            let _ = std::thread::spawn(move || kill_child_tree(&mut old));
        }
        *session.stdin.lock().map_err(|e| e.to_string())? = Some(stdin_pipe);
        if let Ok(mut g) = session.child.lock() {
            *g = Some(child);
        }
        let fresh_killed = Arc::new(AtomicBool::new(false));
        let fresh_initialized = Arc::new(AtomicBool::new(false));
        session.killed = fresh_killed.clone();
        session.initialized = fresh_initialized.clone();
        (
            session.stdin.clone(),
            session.request_seq.clone(),
            session.pending_requests.clone(),
            session.pending_server_requests.clone(),
            fresh_killed,
            fresh_initialized,
        )
    };

    // 4) 读循环(spawn_blocking,长驻直至 EOF;持 Arc 副本,不依赖 registry 存活)。
    let app_handle = app.clone();
    let pid = project_id.to_string();
    let tid = tab_id.to_string();
    let reader_pending = pending_requests.clone();
    let reader_server_req = pending_server_requests.clone();
    let reader_killed = killed_flag.clone();
    tokio::task::spawn_blocking(move || {
        run_read_loop(app_handle, pid, tid, stdout, reader_pending, reader_server_req, reader_killed);
    });

    // 4.5) stderr 排空线程:逐行进日志(spawn 失败/崩溃原因可见),EOF 自然结束。
    let err_tid = tab_id.to_string();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let t = line.trim();
            if !t.is_empty() {
                log::info!("codex app-server stderr, tab {err_tid}: {t}");
            }
        }
    });

    // 5) initialize(等响应确认协议就绪;读循环已在路由响应)。
    let client_info = json!({ "name": "txuyStudio", "title": "txuyStudio", "version": "0.2.16" });
    let result = rpc_with(
        &stdin_arc,
        &request_seq,
        &pending_requests,
        "initialize",
        json!({ "clientInfo": client_info }),
        INIT_TIMEOUT,
    )
    .await;
    match result {
        Ok(v) => {
            // initialize 响应后必须补发 `initialized` 通知(0.166 ClientNotification 仅此一种,
            // 无 params)——协议握手的最后一步,缺发部分 server 行为不启动。
            {
                let mut guard = stdin_arc.lock().map_err(|e| e.to_string())?;
                if let Some(pipe) = guard.as_mut() {
                    let note = json!({ "method": "initialized" }).to_string() + "\n";
                    if let Err(e) = pipe.write_all(note.as_bytes()).and_then(|_| pipe.flush()) {
                        log::warn!("ensure_app_server: write initialized notification failed: {e}");
                    }
                }
            }
            log::info!(
                "ensure_app_server: initialized, userAgent={}",
                v.get("userAgent").and_then(Value::as_str).unwrap_or("?")
            );
            initialized_flag.store(true, Ordering::SeqCst);
            Ok(true)
        }
        Err(e) => {
            log::error!("ensure_app_server: initialize failed: {e}");
            kill_session_process(app, state, project_id, tab_id).await;
            let _ = app.emit(
                "codex-event",
                CodexEvent {
                    project_id: project_id.to_string(),
                    tab_id: tab_id.to_string(),
                    payload: CodexEventPayload::Terminated { reason: format!("initialize failed: {e}") },
                },
            );
            Err(format!("initialize failed: {e}"))
        }
    }
}

/// 发 JSON-RPC 请求并等响应(registry 路径:短锁克隆 stdin/seq/pending,写帧,recv_timeout)。
/// 阻塞 recv 包 spawn_blocking;超时清表防泄漏。
pub async fn rpc_request(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let registry = app.state::<CodexRegistry>();
    let (stdin_arc, seq, pending) = {
        let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
        let session = by_project
            .get(project_id)
            .and_then(|s| s.get(tab_id))
            .ok_or_else(|| "codex app-server not running".to_string())?;
        (session.stdin.clone(), session.request_seq.clone(), session.pending_requests.clone())
    };
    rpc_with(&stdin_arc, &seq, &pending, method, params, RPC_TIMEOUT).await
}

/// rpc 核心(stdin/seq/pending 都是 Arc 副本,不持 registry 锁):
/// id 自增 → 注册 channel → 写帧 → 等响应(超时清表)。写 stdin 是同步 IO(帧小,可接受)。
async fn rpc_with(
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    seq: &AtomicU64,
    pending: &Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = seq.fetch_add(1, Ordering::SeqCst);
    let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let mut encoded = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
    encoded.push('\n');

    let (tx, rx) = mpsc::channel::<Result<Value, String>>();
    pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
    {
        let mut guard = stdin.lock().map_err(|e| e.to_string())?;
        let Some(pipe) = guard.as_mut() else {
            pending.lock().ok().and_then(|mut g| g.remove(&id));
            return Err("codex app-server stdin closed".to_string());
        };
        if let Err(e) = pipe.write_all(encoded.as_bytes()).and_then(|_| pipe.flush()) {
            pending.lock().ok().and_then(|mut g| g.remove(&id));
            return Err(format!("write to app-server failed: {e}"));
        }
    }

    // 等响应:超时回收。recv_timeout 是阻塞调用 → spawn_blocking。
    let pending_clone = pending.clone();
    let wait_id = id;
    let result = tokio::task::spawn_blocking(move || {
        let got = rx.recv_timeout(timeout);
        // 无论成败都清表(超时后迟到响应找不到 sender,send 失败静默丢弃)。
        pending_clone.lock().ok().and_then(|mut g| g.remove(&wait_id));
        got
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(msg)) => Err(msg),
        Err(_) => Err(format!("codex rpc '{method}' timed out")),
    }
}

/// 读循环:逐行读 app-server stdout,按帧形状三分(id+method=server 请求 / id=响应 /
/// method=通知)分发。长驻直到 EOF;持 Arc 副本(pending 表/审批表/killed),session 从
/// registry 移除也能正确收尾。
fn run_read_loop(
    app: AppHandle,
    project_id: String,
    tab_id: String,
    stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
    server_requests: Arc<Mutex<HashMap<String, PendingServerRequest>>>,
    killed: Arc<AtomicBool>,
) {
    let reader = std::io::BufReader::new(stdout);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                log::warn!("codex app-server read error, tab {tab_id}: {e}");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                log::trace!("codex app-server non-json line, tab {tab_id}: {}", trimmed.chars().take(120).collect::<String>());
                continue;
            }
        };
        let has_id = v.get("id").map(|i| !i.is_null()).unwrap_or(false);
        let method = v.get("method").and_then(Value::as_str);

        if has_id && method.is_some() {
            // server 请求:审批类入表 + emit(带 key,前端决策回填 respond_codex_approval);
            // 其余(若有)log 后忽略(app-server 0.166 未观测到)。
            let method = method.unwrap_or("");
            let id = v.get("id").cloned().unwrap_or(Value::Null);
            if method.to_ascii_lowercase().contains("approval") {
                let key = server_request_key(&id);
                let params = v.get("params").cloned().unwrap_or(Value::Null);
                server_requests.lock().ok().and_then(|mut g| {
                    g.insert(
                        key.clone(),
                        PendingServerRequest { id, method: method.to_string(), params: params.clone() },
                    )
                });
                // request 外壳 = {key, method, params}:key 供响应路由,params 原样透传
                // (execCommandApproval 的 command/reason 等由前端审批卡渲染)。
                let _ = app.emit(
                    "codex-event",
                    CodexEvent {
                        project_id: project_id.clone(),
                        tab_id: tab_id.clone(),
                        payload: CodexEventPayload::ApprovalRequested {
                            request: json!({ "key": key, "method": method, "params": params }),
                        },
                    },
                );
                log::info!("codex app-server approval request, tab {tab_id}: {method}");
            } else {
                log::warn!("codex app-server unhandled server request '{method}', tab {tab_id}");
            }
            continue;
        }
        if has_id {
            // client 请求的响应:路由到 pending channel。
            let id_num = v.get("id").and_then(Value::as_u64);
            let payload = if let Some(err) = v.get("error") {
                let msg = err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown rpc error")
                    .to_string();
                Err(msg)
            } else {
                Ok(v.get("result").cloned().unwrap_or(Value::Null))
            };
            if let Some(id_num) = id_num {
                if let Some(tx) = pending.lock().ok().and_then(|mut g| g.remove(&id_num)) {
                    let _ = tx.send(payload);
                }
            }
            continue;
        }
        if let Some(method) = method {
            if let Some(payload) = dispatch_notification(&app, &project_id, &tab_id, method, &v) {
                let _ = app.emit(
                    "codex-event",
                    CodexEvent { project_id: project_id.clone(), tab_id: tab_id.clone(), payload },
                );
            }
            continue;
        }
        log::trace!("codex app-server unrecognized frame, tab {tab_id}: {trimmed}");
    }

    // EOF:本进程退出(崩溃/codex 崩/被杀)。killed=true 时 kill 方已 emit interrupted;
    // 否则通知前端进程退出(reason="exit",区别于旧 exec 模型每轮正常的 "normal"——
    // 长进程的 EOF 一定不是好事)。killed 是 spawn 时换的新 Arc(不复位),旧循环迟到
    // EOF 仍读到 kill 时置的 true,不会误发。initialized 由 mark_process_dead 复位,
    // registry 的 thread id 保留(下轮 resume)。
    let was_killed = killed.load(Ordering::SeqCst);
    if !was_killed {
        let _ = app.emit(
            "codex-event",
            CodexEvent {
                project_id: project_id.clone(),
                tab_id: tab_id.clone(),
                payload: CodexEventPayload::Terminated { reason: "exit".to_string() },
            },
        );
    }
    mark_process_dead(&app, &project_id, &tab_id, &killed);
    log::info!("codex app-server read loop ended, tab {tab_id} project {project_id}, killed={was_killed}");
}

/// 通知分发:方法名 → CodexEventPayload(返回 None = 不发事件)。附带的 registry 副作用
/// (thread id / turn id / Running/Idle 维护)在锁内完成。
fn dispatch_notification(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    method: &str,
    v: &Value,
) -> Option<CodexEventPayload> {
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "thread/started" => {
            let sid = params
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !sid.is_empty() {
                update_codex_session_id(app, project_id, tab_id, sid.clone());
            }
            Some(CodexEventPayload::Init { session_id: sid })
        }
        "turn/started" => {
            let turn_id = params.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
            store_turn_id(app, project_id, tab_id, turn_id);
            let _ = set_session_status(app, project_id, tab_id, CodexStatus::Running);
            Some(CodexEventPayload::TurnStarted)
        }
        "turn/completed" => {
            // 注意:app-server 的 turn/completed 不带 usage(实测),权威用量在
            // thread/tokenUsage/updated;这里恒 None,前端 lastUsage 由 UsageUpdated 回填。
            let _ = set_session_status(app, project_id, tab_id, CodexStatus::Idle);
            Some(CodexEventPayload::TurnCompleted { usage: None })
        }
        "turn/failed" | "turn/aborted" => {
            // 兜底:异常轮结束(0.166 实测正常路径只有 turn/completed,防御性处理)。
            let _ = set_session_status(app, project_id, tab_id, CodexStatus::Idle);
            Some(CodexEventPayload::TurnCompleted { usage: None })
        }
        "thread/status/changed" => {
            // 权威线程状态(active/idle):只维护 Running/Idle,不发事件(turn 事件已覆盖 UI)。
            let is_active = params.pointer("/status/type").and_then(Value::as_str) == Some("active");
            let _ = set_session_status(
                app,
                project_id,
                tab_id,
                if is_active { CodexStatus::Running } else { CodexStatus::Idle },
            );
            None
        }
        "item/started" => Some(CodexEventPayload::ItemStarted {
            item: params.get("item").cloned().unwrap_or(Value::Null),
        }),
        "item/completed" => Some(CodexEventPayload::ItemCompleted {
            item: params.get("item").cloned().unwrap_or(Value::Null),
        }),
        "item/agentMessage/delta" => Some(delta_payload(&params, "agentMessage", "text")),
        "item/reasoning/summaryTextDelta" => Some(delta_payload(&params, "reasoning", "summary")),
        "item/commandOutput/delta" => Some(delta_payload(&params, "commandOutput", "output")),
        "item/reasoning/replayTextDelta" => Some(delta_payload(&params, "reasoning", "text")),
        "thread/tokenUsage/updated" => {
            // ctx% 口径取 **last**(TokenUsageBreakdown,最后一轮 inputTokens = 当前上下文,
            // 与 claude result.usage 同口径);total 是**会话累计**(所有轮加总、持续增长),
            // 拿来做 ctx% 会虚高并超过模型窗口(2026-11-04 用户实测「提示超过 272k」)。
            let usage = params
                .pointer("/tokenUsage/last")
                .cloned()
                .unwrap_or(Value::Null);
            let context = params
                .pointer("/tokenUsage/modelContextWindow")
                .and_then(Value::as_u64);
            Some(CodexEventPayload::UsageUpdated { usage, context_window: context })
        }
        "error" => {
            log::warn!(
                "codex app-server error notification, tab {tab_id}: {}",
                params.get("message").and_then(Value::as_str).unwrap_or("?")
            );
            None
        }
        // configWarning / warning / deprecationNotice / remoteControl/* / mcpServer/* /
        // thread/goal/* 等杂项:不进事件流(log 级即可)。
        _ => {
            log::trace!("codex app-server notification '{method}' ignored, tab {tab_id}");
            None
        }
    }
}

/// delta 类通知 → ItemDelta(params 里 itemId/delta 字段名实测一致)。
fn delta_payload(params: &Value, item_type: &str, field: &str) -> CodexEventPayload {
    CodexEventPayload::ItemDelta {
        item_id: params.get("itemId").and_then(Value::as_str).unwrap_or("").to_string(),
        item_type: item_type.to_string(),
        field: field.to_string(),
        delta: params.get("delta").and_then(Value::as_str).unwrap_or("").to_string(),
    }
}

/// 审批响应(前端决策回写):取 pending_server_requests[key] 的原始 id 构造 result 帧。
/// `approved=false` → 拒绝(codex 会把拒绝反馈给模型继续推理,轮不中断)。
/// decision 枚举**按方法代际分派**(0.166 schema 权威,见模块头):新代 accept/decline,
/// 旧代 approved/{denied:{rejection}}——回错代际 server 反序列化失败,审批永久挂起。
pub async fn respond_approval(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    request_key: &str,
    approved: bool,
    for_session: bool,
) -> Result<(), String> {
    let registry = app.state::<CodexRegistry>();
    let (stdin_arc, req) = {
        let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
        let session = by_project
            .get(project_id)
            .and_then(|s| s.get(tab_id))
            .ok_or_else(|| "codex app-server not running".to_string())?;
        let req = session
            .pending_server_requests
            .lock()
            .map_err(|e| e.to_string())?
            .remove(request_key)
            .ok_or_else(|| format!("approval request '{request_key}' not found (already resolved?)"))?;
        (session.stdin.clone(), req)
    };
    let legacy = req.method == "execCommandApproval" || req.method == "applyPatchApproval";
    let result = if legacy {
        if approved {
            // 旧代无「本会话不再问」形态(for_session 退化成普通批准)。
            json!({ "decision": "approved" })
        } else {
            // 旧代 denied 不是简单枚举:必带 rejection 文本的对象形状(ReviewDecision schema)。
            json!({ "decision": { "denied": { "rejection": "User denied this action in txuyStudio." } } })
        }
    } else if approved {
        // 新代三值:accept(允许一次)/ acceptForSession(本会话同类不再问)/ decline。
        if for_session {
            json!({ "decision": "acceptForSession" })
        } else {
            json!({ "decision": "accept" })
        }
    } else {
        json!({ "decision": "decline" })
    };
    let frame = json!({ "id": req.id, "result": result });
    let mut encoded = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
    encoded.push('\n');
    {
        let mut guard = stdin_arc.lock().map_err(|e| e.to_string())?;
        let Some(pipe) = guard.as_mut() else {
            return Err("codex app-server stdin closed".to_string());
        };
        pipe.write_all(encoded.as_bytes())
            .and_then(|_| pipe.flush())
            .map_err(|e| format!("write approval response failed: {e}"))?;
    }
    log::info!(
        "codex app-server approval {} ({}), tab {tab_id}",
        if approved { "approved" } else { "denied" },
        req.method
    );
    // 广播 resolved:同会话多视图(桌面 + 手机经中继)据此撤下审批卡,不必等 codex 的
    // 下一条事件才发现已决策。
    let _ = app.emit(
        "codex-event",
        CodexEvent {
            project_id: project_id.to_string(),
            tab_id: tab_id.to_string(),
            payload: CodexEventPayload::ApprovalResolved { request_id: request_key.to_string() },
        },
    );
    Ok(())
}

/// 杀掉 session 的 app-server 进程(不 emit 事件;调用方负责通知语义)。stdin 先置 None
/// 让 RPC 立即失败,killed=true 让读循环 EOF 静默。阻塞 kill+wait 丢 spawn_blocking,锁已释放。
pub(super) async fn kill_session_process(
    app: &AppHandle,
    state: &tauri::State<'_, CodexRegistry>,
    project_id: &str,
    tab_id: &str,
) {
    let (child_opt, killed) = {
        let by_project = match state.by_project.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(session) = by_project.get(project_id).and_then(|s| s.get(tab_id)) else {
            return;
        };
        session.killed.store(true, Ordering::SeqCst);
        session.initialized.store(false, Ordering::SeqCst);
        if let Ok(mut g) = session.stdin.lock() {
            *g = None; // drop stdin 句柄
        }
        // 本代 killed Arc 此刻克隆(kill 期间可能 respawn 换代,事后取会拿到新 Arc 使
        // ptr_eq 门控失效)。
        let killed = session.killed.clone();
        (session.child.lock().ok().and_then(|mut g| g.take()), killed)
    };
    if let Some(mut child) = child_opt {
        let _ = tokio::task::spawn_blocking(move || {
            kill_child_tree(&mut child);
        })
        .await;
    }
    mark_process_dead(app, project_id, tab_id, &killed);
}
