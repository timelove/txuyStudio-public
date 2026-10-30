//! 密文业务帧分发:解密后的 {id, method, params} 在这里路由到现有命令逻辑。
//! 手机端与未来的总览 agent 走同一套 API(调用者无关);每类调用即协议 protocol-v1.md「业务帧」。
//!
//! **设计原则:手机不复制桌面逻辑。** 所有 chat.* 方法直接调用 `claude::commands` /
//! `codex::commands` 里那些 `#[tauri::command]` 函数本体(`State<'_, T>` 由 `&AppHandle` 派生,
//! `Copy` 且不跨 await 持有引用,故可直接 await 调用)。这样 busy 检查、`killed` 标志、
//! status 复位、事件 emit 与桌面端**完全同一条代码路径**——手机只是同一会话的第二个视图。
//!
//! 新能力清单见 `.work/design/20261026-companion-ai-chat/companion-ai-chat-design-v1.md`。

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::claude::ClaudeRegistry;
use crate::codex::CodexRegistry;
use crate::state::AppState;
use crate::system::commands::{
    get_ai_cli_session_messages, list_ai_activity, list_ai_cli_sessions, list_request_log,
    list_usage_rollups,
};

/// 处理一条业务帧(已解密的 JSON),返回响应帧(将加密回发)。
pub async fn dispatch(app: &AppHandle, frame: Value) -> Value {
    let id = frame.get("id").cloned().unwrap_or(Value::Null);
    let method = frame.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = frame.get("params").cloned().unwrap_or(json!({}));
    let result = run_method(app, method, &params).await;
    match result {
        Ok(r) => json!({ "id": id, "ok": true, "result": r }),
        Err(e) => json!({ "id": id, "ok": false, "error": e }),
    }
}

async fn run_method(app: &AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    let days = params.get("days").and_then(|d| d.as_u64());
    match method {
        // 配对握手:手机连上后首帧,回本机身份(手机侧展示「已连接到 <name>」)。
        "pair.hello" => {
            let name = whoami_host();
            Ok(json!({ "name": name, "version": app.package_info().version.to_string() }))
        }
        // 项目列表(managed AppState 快照派生,轻量,不扫盘)。含 pane 结构视图。
        "projects.list" => Ok(json!({ "projects": projects_payload(app) })),
        // 远程激活项目:手机点某个项目 → 桌面端切到它(main 窗口)。
        // 写操作走 guard_write(与 chat.* 同档)。落盘后 emit `active-project-changed`,
        // 桌面 WebView 监听并切 active(含原本未激活的项目)。
        // **emit 放在这里而不是 `set_active_project` 内**:桌面自己切项目也调那个 command,
        // 若命令内广播,App.tsx 的监听会再回调一次 → 无谓的 setState 风暴(甚至回路)。
        "projects.activate" => {
            guard_write(app)?;
            let project_id = req_str(params, "projectId")?;
            crate::state::commands::set_active_project(
                app.clone(),
                app.state::<AppState>(),
                project_id.clone(),
                Some("main".to_string()),
            )
            .await?;
            let _ = app.emit("active-project-changed", &project_id);
            Ok(json!({ "activated": true, "projectId": project_id }))
        }
        // 用量汇总/请求明细/AI 活动图:直接复用 system::commands 扫描逻辑。
        "usage.summary" => serde_json::to_value(list_usage_rollups(days).await?)
            .map_err(|e| e.to_string()),
        "usage.log" => serde_json::to_value(list_request_log(days).await?)
            .map_err(|e| e.to_string()),
        "activity.graph" => serde_json::to_value(list_ai_activity(days).await?)
            .map_err(|e| e.to_string()),
        // AI 会话列表(全局扫;root_path 仅路径校验用,取首个项目或用户 home)。
        "sessions.list" => {
            let kind = params.get("kind").and_then(|k| k.as_str()).unwrap_or("claude").to_string();
            let root = fallback_root(app);
            let sessions = list_ai_cli_sessions(root, kind).await?;
            serde_json::to_value(sessions).map_err(|e| e.to_string())
        }
        // 快照本体(连接建立即推,不走业务帧请求;这里给手机主动拉取的兜底口)。
        "snapshot.build" => Ok(build_snapshot(app).await),

        // —— AI 对话(2026-10-26) ——
        "chat.status" => chat_status(app, params),
        "chat.history" => chat_history(app, params).await,
        "chat.digest" => chat_digest(app).await,
        "chat.send" => chat_send(app, params).await,
        "chat.interrupt" => chat_interrupt(app, params).await,
        "chat.permission" => chat_permission(app, params).await,

        // —— AI pane 快捷指令(2026-10-26) ——
        // 手机上的「会话动作」(压缩/清空/新会话/切模型/重启/退出),替代桌面端 ⋯ 菜单。
        "chat.command" => chat_command(app, params).await,
        "chat.models" => chat_models(app, params),
        "chat.setProviderModel" => chat_set_provider_model(app, params),

        // —— shell 终端只读镜像(2026-10-26) ——
        // 手机端拉某 pane 的 PTY 输出快照(后端 transcript 环形缓存,上限 256KB)。
        // 只读、不入 guard_write(看不是写)。真正「手机往 shell 打字」需要另一套
        // 输入通道 + 风险确认,v1 明确不做(见设计文档「已知取舍:shell 只读」)。
        "pty.tail" => pty_tail(app, params),

        // AI pane 的快捷指令已由上方 `chat.command` 承担(会话动作语义)。协议文档里的
        // `commands.run{tabId,text}` 是「往 shell 敲命令」,v1 明确不做远程输入(见 pty.tail
        // 注释三条理由),`quickCommands.*` 的自定义指令库也留到后续 —— 继续显式回错。
        "commands.run" | "quickCommands.list" | "quickCommands.put" => {
            Err("not implemented (AI pane actions use chat.command; shell input is read-only in v1)".into())
        }
        _ => Err(format!("unknown method: {method}")),
    }
}

// ---------- 项目结构 ----------

/// 项目列表 payload(managed AppState 快照派生;projects.list 与快照共用,勿经
/// run_method 互调避免 async 递归)。
///
/// 同时给两种视图:
/// - `tabs` 扁平数组:**保留**(离线快照/旧客户端兼容,也方便「有哪些 tab」这种粗查询);
/// - `panes` 结构化:按分屏树顺序给出 `{paneId, ratio, split?, splitRatio?, activeTabId, tabs}`——
///   手机端「选 pane 再选 tab」靠它。`split`/`splitRatio` 只挂在**每层分屏的第一个 pane**上
///   (手机端在节标题显示「左右/上下分屏」),叶子 pane 没有这两个字段。
fn projects_payload(app: &AppHandle) -> Vec<Value> {
    // 锁内只做结构收集(字段克隆),started/busy 运行态在**锁外**查 registry——
    // 避免 AppState → Registry 嵌套持锁(claude/codex 侧存在 Registry 锁内取
    // AppState 的路径,固定单向才不死于锁环)。
    struct Raw {
        id: String,
        name: String,
        root_path: String,
        is_active: bool,
        tabs: Vec<Value>,
        panes: Vec<Value>,
    }
    let raws: Vec<Raw> = {
        let state = app.state::<AppState>();
        let Ok(snap) = state.inner.lock() else { return Vec::new() };
        snap.projects
            .iter()
            .map(|p| {
                let (tabs, panes) = match p.pane_tree.as_ref() {
                    Some(t) => (collect_tabs(t), collect_panes(t, 0)),
                    None => (Vec::new(), Vec::new()),
                };
                Raw {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    root_path: p.root_path.clone(),
                    is_active: snap.active_project_id.as_deref() == Some(&p.id),
                    tabs,
                    panes,
                }
            })
            .collect()
    };
    raws.into_iter()
        .map(|r| {
            let Raw { id, name, root_path, is_active, mut tabs, mut panes } = r;
            annotate_run_state(app, &id, &mut tabs);
            for pane in panes.iter_mut() {
                if let Some(list) = pane.get_mut("tabs").and_then(|v| v.as_array_mut()) {
                    annotate_run_state(app, &id, list);
                }
            }
            json!({
                "id": id,
                "name": name,
                "rootPath": root_path,
                "isActive": is_active,
                "tabs": tabs,
                "panes": panes,
            })
        })
        .collect()
}

/// AI tab 附运行态 `{started,busy}`(查 registry,与 chat_digest/chat_status 同源):
/// 手机端「在线会话置顶 + 在线标签」用。离线快照共用本 payload,在线时才会推,
/// 带着运行态无害;非 AI tab 不加字段。
fn annotate_run_state(app: &AppHandle, pid: &str, tabs: &mut [Value]) {
    for t in tabs.iter_mut() {
        let provider = match t.get("kind").and_then(|k| k.as_str()).unwrap_or("") {
            "claudepane" | "claude" => "claude",
            "codexpane" | "codex" => "codex",
            _ => continue,
        };
        let tid = t.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let (started, busy) = tab_run_state(app, pid, &tid, provider);
        if let Some(o) = t.as_object_mut() {
            o.insert("started".into(), json!(started));
            o.insert("busy".into(), json!(busy));
        }
    }
}

/// 收集 pane 树全部叶子 tab(扁平视图)。
fn collect_tabs(node: &txuy_core::state::PaneNode) -> Vec<Value> {
    match node {
        txuy_core::state::PaneNode::Pane { tabs, .. } => tabs
            .iter()
            .map(|t| json!({ "id": t.id, "kind": t.shell_kind, "title": t.title }))
            .collect(),
        txuy_core::state::PaneNode::Split { children, .. } => {
            children.iter().flat_map(collect_tabs).collect()
        }
    }
}

/// 收集 pane 结构化视图(深度优先,保持桌面端分屏树顺序)。
///
/// `order` 由遍历序号给出(0 起)——手机端展示「pane 1 / pane 2」用它,不暴露树的内部
/// 嵌套结构(手机上把分屏树画出来没意义,分节列表更可用)。`ratio` 取**所在分屏**的
/// 比例(决定该 pane 在桌面上占多宽/多高),叶子 pane 自身的比例无意义。
fn collect_panes(node: &txuy_core::state::PaneNode, ratio_pct: u64) -> Vec<Value> {
    match node {
        txuy_core::state::PaneNode::Pane { id, tabs, active_tab_id } => vec![json!({
            "paneId": id,
            "ratio": ratio_pct,
            "activeTabId": active_tab_id,
            "tabs": tabs.iter().map(|t| json!({
                "id": t.id,
                "kind": t.shell_kind,
                "title": t.title,
            })).collect::<Vec<_>>(),
        })],
        txuy_core::state::PaneNode::Split { direction, ratio, children, .. } => {
            let dir = match direction {
                txuy_core::state::SplitDirection::Horizontal => "horizontal",
                txuy_core::state::SplitDirection::Vertical => "vertical",
            };
            let mut out = Vec::new();
            for (i, child) in children.iter().enumerate() {
                // 第一子占 ratio,第二子占 1-ratio(与桌面端分屏语义一致;非二分时均分)。
                let pct = if children.len() == 2 {
                    let r = (ratio * 100.0).round().clamp(0.0, 100.0) as u64;
                    if i == 0 { r } else { 100 - r }
                } else {
                    100 / children.len().max(1) as u64
                };
                out.extend(collect_panes(child, pct));
            }
            // 分屏方向挂在**该层第一个** pane 上,手机端显示节标题用(其余为 null 避免重复)。
            if let Some(first) = out.first_mut() {
                if let Some(o) = first.as_object_mut() {
                    o.insert("split".into(), json!(dir));
                    o.insert("splitRatio".into(), json!(ratio));
                }
            }
            out
        }
    }
}

// ---------- 对话 ----------

/// 从参数里取必填字符串。
fn req_str(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing param: {key}"))
}

/// 写操作闸门:relay.json 的 `allowRemoteChat=false` 时一律拒。
fn guard_write(app: &AppHandle) -> Result<(), String> {
    let h = app.state::<std::sync::Arc<crate::relay::RelayHandle>>();
    if h.config().allow_remote_chat {
        Ok(())
    } else {
        Err("remote chat disabled (relay.json allowRemoteChat=false)".into())
    }
}

/// tab kind → provider("claude" | "codex"),非 AI tab 返回 None。
///
/// 从 AppState 的 pane 树里查(手机给的是 tabId,不是 kind)。查不到也返回 None——
/// 手机端只应针对 AI tab 发消息,非 AI tab 直接拒。
fn provider_of(app: &AppHandle, project_id: &str, tab_id: &str) -> Option<&'static str> {
    let state = app.state::<AppState>();
    let snap = state.inner.lock().ok()?;
    let project = snap.projects.iter().find(|p| p.id == project_id)?;
    let tree = project.pane_tree.as_ref()?;
    let mut kind: Option<String> = None;
    collect_kind_into(tree, tab_id, &mut kind);
    match kind.as_deref() {
        Some("claudepane") | Some("claude") => Some("claude"),
        Some("codexpane") | Some("codex") => Some("codex"),
        _ => None,
    }
}

fn collect_kind_into(node: &txuy_core::state::PaneNode, tab_id: &str, out: &mut Option<String>) {
    if out.is_some() {
        return;
    }
    match node {
        txuy_core::state::PaneNode::Pane { tabs, .. } => {
            if let Some(t) = tabs.iter().find(|t| t.id == tab_id) {
                *out = Some(t.shell_kind.clone());
            }
        }
        txuy_core::state::PaneNode::Split { children, .. } => {
            for c in children {
                collect_kind_into(c, tab_id, out);
                if out.is_some() {
                    return;
                }
            }
        }
    }
}

/// `chat.status`:会话在不在跑、忙不忙、当前 model、claude session id。
///
/// 只读,不受 `allowRemoteChat` 限制(手机进对话页就该知道现状)。
fn chat_status(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let project_id = req_str(params, "projectId")?;
    let tab_id = req_str(params, "tabId")?;
    let provider = provider_of(app, &project_id, &tab_id)
        .ok_or_else(|| format!("tab {tab_id} is not an AI tab"))?;

    match provider {
        "claude" => {
            let reg = app.state::<ClaudeRegistry>();
            let by_project = reg.by_project.lock().map_err(|e| e.to_string())?;
            let session = by_project
                .get(&project_id)
                .and_then(|s| s.get(&tab_id));
            let (started, busy, status, model, sid, effort) = match session {
                Some(s) => {
                    let st = s.status.lock().ok().map(|g| g.clone()).unwrap_or(crate::claude::ClaudeStatus::Idle);
                    let busy = matches!(
                        st,
                        crate::claude::ClaudeStatus::Running | crate::claude::ClaudeStatus::Compacting
                    );
                    let started = s.child.lock().map(|g| g.is_some()).unwrap_or(false);
                    let model = s.model.lock().ok().and_then(|g| g.clone());
                    let sid = s.claude_session_id.lock().ok().and_then(|g| g.clone());
                    // 启动 flag(不是运行时状态):手机快捷指令的「当前档」显示用。
                    let effort = s
                        .config
                        .lock()
                        .ok()
                        .and_then(|g| g.effort.clone());
                    (started, busy, status_label(&st), model, sid, effort)
                }
                None => (false, false, "idle", None, None, None),
            };
            // 后台任务快照(断线重连/进页补齐;实时由 backgroundTasksChanged 事件推)。
            let bg_tasks = session
                .and_then(|s| s.background_tasks.lock().ok().map(|g| g.clone()))
                .unwrap_or_default();
            Ok(json!({
                "provider": "claude",
                "started": started,
                "busy": busy,
                "status": status,
                "model": model,
                "effort": effort,
                "sessionId": sid,
                "backgroundTasks": bg_tasks,
            }))
        }
        _ => {
            let reg = app.state::<CodexRegistry>();
            let by_project = reg.by_project.lock().map_err(|e| e.to_string())?;
            let session = by_project.get(&project_id).and_then(|s| s.get(&tab_id));
            let (started, busy, status, model, sid, reasoning) = match session {
                Some(s) => {
                    let st = s.status.lock().ok().map(|g| g.clone()).unwrap_or(crate::codex::CodexStatus::Idle);
                    let busy = matches!(st, crate::codex::CodexStatus::Running);
                    let started = s.child.lock().map(|g| g.is_some()).unwrap_or(false);
                    let model = s.model.lock().ok().and_then(|g| g.clone());
                    let sid = s.codex_session_id.lock().ok().and_then(|g| g.clone());
                    let reasoning = s
                        .config
                        .lock()
                        .ok()
                        .and_then(|g| g.reasoning_effort.clone());
                    (started, busy, codex_status_label(&st), model, sid, reasoning)
                }
                None => (false, false, "idle", None, None, None),
            };
            Ok(json!({
                "provider": "codex",
                "started": started,
                "busy": busy,
                "status": status,
                "model": model,
                "reasoningEffort": reasoning,
                "sessionId": sid,
            }))
        }
    }
}

fn status_label(s: &crate::claude::ClaudeStatus) -> &'static str {
    use crate::claude::ClaudeStatus::*;
    match s {
        Idle => "idle",
        Running => "running",
        Compacting => "compacting",
        Error => "error",
    }
}

fn codex_status_label(s: &crate::codex::CodexStatus) -> &'static str {
    use crate::codex::CodexStatus::*;
    match s {
        Idle => "idle",
        Running => "running",
        Error => "error",
    }
}

/// `chat.history`:进入对话页时回填。
///
/// claude 分支返回**与实时事件同构**的 `ClaudeEventPayload` 序列——手机端用同一个
/// applyEvent 归并历史与流式,只有一套渲染路径。session id 从 registry 取(当前运行中的
/// 会话),没有则退回 AppState 持久化的(claude_tab_sessions,跨重启还在)。
/// `chat.digest`:全部项目 AI tab 摘要(手机端「消息」tab 数据源,一次请求免逐 tab history)。
/// 每 tab:{projectId, projectName, tabId, tabTitle, kind, started, busy, lastText, lastTs}。
/// lastText = 历史最后一条 assistant 主文本(全工具调用无正文时退最后一条 user 输入),
/// 截 120 字;无会话 = 空串(手机端显示「尚未对话」)。串行逐 tab 读历史文件,tab 数量
/// 通常 <10 可接受,后续需要再做 tail 优化。只读,无 guard_write。
async fn chat_digest(app: &AppHandle) -> Result<Value, String> {
    let projects = projects_payload(app);
    let mut digest = Vec::new();
    for p in &projects {
        let pid = p["id"].as_str().unwrap_or("").to_string();
        let pname = p["name"].as_str().unwrap_or("").to_string();
        let Some(tabs) = p["tabs"].as_array() else { continue };
        for tab in tabs {
            let tid = tab["id"].as_str().unwrap_or("").to_string();
            let Some(provider) = provider_of(app, &pid, &tid) else { continue };
            // started/busy 已由 projects_payload 的 annotate_run_state 附上,直接读。
            let (started, busy) = (
                tab["started"].as_bool().unwrap_or(false),
                tab["busy"].as_bool().unwrap_or(false),
            );
            let sid = if provider == "claude" {
                claude_session_id(app, &pid, &tid)
            } else {
                codex_session_id(app, &pid, &tid)
            };
            let mut last_text = String::new();
            let mut last_ts = String::new();
            if let Some(sid) = sid {
                if provider == "claude" {
                    if let Ok(h) = crate::claude::commands::read_claude_history_events(sid).await {
                        // 先找最后一条有正文的 assistant;整轮全是工具调用则退 user 输入。
                        for want in ["assistant", "user"] {
                            for ev in h.events.iter().rev() {
                                let Ok(v) = serde_json::to_value(ev) else { continue };
                                if v.get("kind").and_then(|k| k.as_str()) != Some(want) { continue; }
                                if let Some(text) = claude_message_text(v.get("message")) {
                                    if !text.is_empty() {
                                        last_text = truncate_chars(&text, 120);
                                        break;
                                    }
                                }
                            }
                            if !last_text.is_empty() { break; }
                        }
                    }
                } else {
                    let root = project_root(app, &pid).unwrap_or_else(|| fallback_root(app));
                    if let Ok(msgs) = get_ai_cli_session_messages(root, "codex".to_string(), sid).await {
                        for m in msgs.iter().rev() {
                            if m.role == "assistant" && !m.text.is_empty() {
                                last_text = truncate_chars(&m.text, 120);
                                last_ts = m.timestamp.clone().unwrap_or_default();
                                break;
                            }
                        }
                    }
                }
            }
            let title = tab["title"].as_str().unwrap_or("");
            digest.push(json!({
                "projectId": pid,
                "projectName": pname,
                "tabId": tid,
                "tabTitle": if title.is_empty() { provider } else { title },
                "kind": provider,
                "started": started,
                "busy": busy,
                "lastText": last_text,
                "lastTs": last_ts,
            }));
        }
    }
    Ok(json!({ "digest": digest }))
}

/// registry 运行态摘要 (started, busy):与 chat_status 同源逻辑(锁同步短临界区)。
fn tab_run_state(app: &AppHandle, pid: &str, tid: &str, provider: &str) -> (bool, bool) {
    if provider == "claude" {
        let reg = app.state::<ClaudeRegistry>();
        let Ok(bp) = reg.by_project.lock() else { return (false, false) };
        match bp.get(pid).and_then(|s| s.get(tid)) {
            Some(s) => {
                let st = s.status.lock().ok().map(|g| g.clone()).unwrap_or(crate::claude::ClaudeStatus::Idle);
                let busy = matches!(st, crate::claude::ClaudeStatus::Running | crate::claude::ClaudeStatus::Compacting);
                let started = s.child.lock().map(|g| g.is_some()).unwrap_or(false);
                (started, busy)
            }
            None => (false, false),
        }
    } else {
        let reg = app.state::<CodexRegistry>();
        let Ok(bp) = reg.by_project.lock() else { return (false, false) };
        match bp.get(pid).and_then(|s| s.get(tid)) {
            Some(s) => {
                let st = s.status.lock().ok().map(|g| g.clone()).unwrap_or(crate::codex::CodexStatus::Idle);
                let busy = matches!(st, crate::codex::CodexStatus::Running);
                let started = s.child.lock().map(|g| g.is_some()).unwrap_or(false);
                (started, busy)
            }
            None => (false, false),
        }
    }
}

/// claude message.content[] 里 type=="text" 的文本拼接(content 兼容纯字符串形态)。
fn claude_message_text(message: Option<&Value>) -> Option<String> {
    let m = message?;
    match m.get("content")? {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let mut out = String::new();
            for it in items {
                if it.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = it.get("text").and_then(|x| x.as_str()) {
                        if !out.is_empty() { out.push(' '); }
                        out.push_str(t);
                    }
                }
            }
            Some(out)
        }
        _ => None,
    }
}

/// 按字符截断(中文安全),超出加省略号。
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

async fn chat_history(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let project_id = req_str(params, "projectId")?;
    let tab_id = req_str(params, "tabId")?;
    let provider = provider_of(app, &project_id, &tab_id)
        .ok_or_else(|| format!("tab {tab_id} is not an AI tab"))?;

    if provider == "claude" {
        let sid = claude_session_id(app, &project_id, &tab_id);
        let Some(sid) = sid else {
            return Ok(json!({ "provider": "claude", "events": [], "total": 0 }));
        };
        let h = crate::claude::commands::read_claude_history_events(sid).await?;
        return Ok(json!({
            "provider": "claude",
            "events": h.events,
            "total": h.total,
        }));
    }

    // codex:没有与事件同构的历史解析,退回「role + 文本 + 工具摘要」的扁平消息。
    // 取舍见设计文档「已知取舍 1」。
    let sid = codex_session_id(app, &project_id, &tab_id);
    let Some(sid) = sid else {
        return Ok(json!({ "provider": "codex", "messages": [], "total": 0 }));
    };
    let root = project_root(app, &project_id).unwrap_or_else(|| fallback_root(app));
    let messages = get_ai_cli_session_messages(root, "codex".to_string(), sid).await?;
    let total = messages.len();
    Ok(json!({ "provider": "codex", "messages": messages, "total": total }))
}

fn claude_session_id(app: &AppHandle, project_id: &str, tab_id: &str) -> Option<String> {
    let reg = app.state::<ClaudeRegistry>();
    if let Ok(by_project) = reg.by_project.lock() {
        if let Some(sid) = by_project
            .get(project_id)
            .and_then(|s| s.get(tab_id))
            .and_then(|s| s.claude_session_id.lock().ok().and_then(|g| g.clone()))
        {
            return Some(sid);
        }
    }
    let state = app.state::<AppState>();
    let snap = state.inner.lock().ok()?;
    snap.projects
        .iter()
        .find(|p| p.id == project_id)
        .and_then(|p| p.claude_tab_sessions.get(tab_id).cloned())
}

fn codex_session_id(app: &AppHandle, project_id: &str, tab_id: &str) -> Option<String> {
    let reg = app.state::<CodexRegistry>();
    let by_project = reg.by_project.lock().ok()?;
    by_project
        .get(project_id)
        .and_then(|s| s.get(tab_id))
        .and_then(|s| s.codex_session_id.lock().ok().and_then(|g| g.clone()))
}

fn project_root(app: &AppHandle, project_id: &str) -> Option<String> {
    let state = app.state::<AppState>();
    let snap = state.inner.lock().ok()?;
    snap.projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.root_path.clone())
}

/// `chat.send`:发一轮对话。**会话不存在才启动**,存在就直接发(见设计文档「会话生命周期」)。
///
/// claude:先查 registry;没有 → `start_claude_session`(cwd = 项目根,默认 acceptEdits,
/// 不传 resume —— 命令自己会从 AppState 读持久化 session id 续接),然后 `send_claude_message`。
/// codex:每轮自 spawn,直接 `send_codex_message`(sandbox 默认 workspace-write,与桌面端新 tab 同档)。
async fn chat_send(app: &AppHandle, params: &Value) -> Result<Value, String> {
    guard_write(app)?;
    let project_id = req_str(params, "projectId")?;
    let tab_id = req_str(params, "tabId")?;
    let text = req_str(params, "text")?;
    // 回显 id:手机端带了就用它的(手机侧 `_applyUser` 靠同 id 去重,吞掉自己那条回显);
    // 没带就现生成一个(桌面端只要有个稳定 id 就能渲染 + 去重)。
    let message_id = params
        .get("messageId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("user-{}", uuid::Uuid::new_v4()));
    let provider = provider_of(app, &project_id, &tab_id)
        .ok_or_else(|| format!("tab {tab_id} is not an AI tab"))?;

    if provider == "claude" {
        if !claude_started(app, &project_id, &tab_id) {
            let cwd = project_root(app, &project_id);
            crate::claude::commands::start_claude_session(
                app.clone(),
                app.state::<ClaudeRegistry>(),
                app.state::<AppState>(),
                project_id.clone(),
                tab_id.clone(),
                cwd,
                None,   // permission_mode:默认 acceptEdits
                None,   // allowed_tools:用项目持久化 allowlist
                None,   // resume_session_id:靠持久化 session id 续接
                None,   // effort
                None,   // model
                None,   // add_dirs
            )
            .await?;
        }
        crate::claude::commands::send_claude_message(
            app.clone(),
            app.state::<ClaudeRegistry>(),
            project_id,
            tab_id,
            text,
            None,                    // tool_result
            Some(message_id.clone()), // 回显给桌面端
        )
        .await?;
        return Ok(json!({ "accepted": true, "messageId": message_id }));
    }

    let cwd = project_root(app, &project_id);
    // codex 每轮短命进程:model / reasoning / 新会话都是**本轮参数**,不是启动 flag
    // (与 claude 相反,见 chat_command 注释)。手机端把在快捷指令里选的这几项随每次
    // chat.send 带上,后端原样透传;不传 = 用 config.toml 默认 + 续接 live thread。
    let model = params.get("model").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let reasoning = params
        .get("reasoningEffort")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let new_session = params.get("newSession").and_then(|v| v.as_bool());
    crate::codex::commands::send_codex_message(
        app.clone(),
        app.state::<CodexRegistry>(),
        project_id,
        tab_id,
        cwd,
        text,
        None, // sandbox:默认 workspace-write
        model,
        reasoning,
        None, // resume_session_id
        new_session,
        Some(message_id.clone()), // 回显给桌面端
    )
    .await?;
    Ok(json!({ "accepted": true, "messageId": message_id }))
}

/// `chat.command`:AI pane 快捷指令(手机上的「会话动作」,替代桌面端输入框旁的 ⋯ 菜单)。
///
/// 只收**会话级动作**——「打开本地文件/面板/弹窗」那类桌面专属命令(`/folder` `/memory`
/// `/agents` `/skills` `/mcp` `/plugins` `/config` `/export` `/doctor` `/rewind`
/// `/add-dir` `/help`)在手机上无消费者,v1 直接不下发(见设计文档「命令子集」)。
///
/// | command   | claude | codex |
/// |-----------|--------|-------|
/// | `compact` | `send_claude_message("/compact")` | 不支持 |
/// | `clear`   | `send_claude_message("/clear")`(即时 local command,不置 Running) | 不支持 |
/// | `model`   | 重启进程换 `--model`(带上原 effort/mode) | — |
/// | `effort`  | 重启进程换 `--effort`(带上原 model/mode) | — |
/// | `restart` | kill + start(`--resume` 续接) | — |
/// | `stop`    | 同 `chat.interrupt`(软中断) | 同 `chat.interrupt` |
/// | `exit`    | `kill_claude` | `kill_codex` |
///
/// **codex 的模型/推理档不走这里**:它每轮短命 `codex exec`,model/reasoning 是每轮的
/// 命令行参数(见「已知取舍」),所以由手机端自己记着、下次 `chat.send` 带上
/// (`model` / `reasoningEffort` / `newSession` 三个可选参数)。claude 相反:`--model`
/// `--effort` 是启动 flag,只能重启进程换,故必须走后端。
///
/// 重启前一律要求 idle:busy 直接拒——手机上点「切模型」时若正在跑,让用户先停止,
/// 而不是静默掐断一轮回答。
async fn chat_command(app: &AppHandle, params: &Value) -> Result<Value, String> {
    guard_write(app)?;
    let project_id = req_str(params, "projectId")?;
    let tab_id = req_str(params, "tabId")?;
    let command = req_str(params, "command")?;
    let provider = provider_of(app, &project_id, &tab_id)
        .ok_or_else(|| format!("tab {tab_id} is not an AI tab"))?;

    if provider != "claude" {
        return match command.as_str() {
            // codex 的 stop/exit 是同一件事(kill 当前 exec 进程树)。
            "stop" | "exit" => {
                crate::codex::commands::kill_codex(
                    app.clone(),
                    app.state::<CodexRegistry>(),
                    project_id,
                    tab_id,
                )
                .await?;
                Ok(json!({ "ok": true, "command": command }))
            }
            _ => Err(format!(
                "command `{command}` is not supported for codex (model/reasoning are per-send params, \
                 pass them with chat.send; new session uses newSession=true)"
            )),
        };
    }

    match command.as_str() {
        "compact" | "clear" => {
            // 与桌面 transport.clear() 同路:写 stdin,claude 自己处理 local command。
            crate::claude::commands::send_claude_message(
                app.clone(),
                app.state::<ClaudeRegistry>(),
                project_id,
                tab_id,
                format!("/{command}"),
                None,
                None,
            )
            .await?;
            Ok(json!({ "ok": true, "command": command }))
        }
        "model" | "effort" => {
            // `auto` = 恢复默认(不传该启动 flag)。手机端的档位列表里它有这一项,
            // 后端翻译成 None —— `--model auto` / `--effort auto` 都不是 claude 认的值。
            let raw = req_str(params, "value")?;
            let value = if raw.eq_ignore_ascii_case("auto") { None } else { Some(raw) };
            restart_claude_with(app, &project_id, &tab_id, |mode, effort, model| {
                if command == "model" {
                    (mode, effort, value.clone())
                } else {
                    (mode, value.clone(), model)
                }
            })
            .await
        }
        "restart" => {
            restart_claude_with(app, &project_id, &tab_id, |mode, effort, model| {
                (mode, effort, model)
            })
            .await
        }
        "stop" => {
            chat_interrupt(app, params).await?;
            Ok(json!({ "ok": true, "command": command }))
        }
        "exit" => {
            crate::claude::commands::kill_claude(
                app.clone(),
                app.state::<ClaudeRegistry>(),
                project_id,
                tab_id,
            )
            .await?;
            Ok(json!({ "ok": true, "command": command }))
        }
        _ => Err(format!("unknown chat command: {command}")),
    }
}

/// 重启 claude 长进程换启动 flag(`--model` / `--effort` / 纯 restart)。
///
/// 必须带上 registry 里的**其余**启动参数:start_claude_session 落 config 是整体替换,
/// 只传一项会把 mode/effort/model 其余两项清空(下次重启才发现,行为漂移)。
/// `resume_session_id` 传 None → 命令内部走 AppState 持久化的 session id 自动 `--resume`,
/// 会话历史不断裂。
///
/// **会话还没起也允许**(手机是懒启动:进对话页只 `chat.status`,发第一条消息才
/// `start_claude_session`)。此时没有可保留的启动参数,只把用户刚选的那一项带上,
/// 其余走 `start_claude_session` 的默认值——否则用户在手机上第一次切模型会撞
/// 「session not started」。
async fn restart_claude_with(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    pick: impl Fn(Option<String>, Option<String>, Option<String>) -> (Option<String>, Option<String>, Option<String>),
) -> Result<Value, String> {
    // 1) busy 检查 + 取当前启动参数(短锁,克隆即释放)。
    let (mode, effort, model, cwd) = {
        let reg = app.state::<ClaudeRegistry>();
        let by_project = reg.by_project.lock().map_err(|e| e.to_string())?;
        match by_project.get(project_id).and_then(|s| s.get(tab_id)) {
            Some(session) => {
                {
                    let st = session.status.lock().map_err(|e| e.to_string())?;
                    if matches!(
                        *st,
                        crate::claude::ClaudeStatus::Running | crate::claude::ClaudeStatus::Compacting
                    ) {
                        return Err(
                            "claude is busy: stop the current turn before changing model/effort".into()
                        );
                    }
                }
                let cfg = session.config.lock().map_err(|e| e.to_string())?.clone();
                let cwd = cfg.cwd.as_ref().map(|p| p.display().to_string());
                (
                    Some(cfg.permission_mode).filter(|s| !s.is_empty()),
                    cfg.effort,
                    cfg.model,
                    cwd,
                )
            }
            // 会话不存在:从零启动,由 `pick` 决定要设哪一项。
            None => (None, None, None, None),
        }
    };
    let (mode, effort, model) = pick(mode, effort, model);
    let cwd = cwd.or_else(|| project_root(app, project_id));

    // 2) 重启(内部 kill 旧 child + spawn 新进程 + --resume)。
    crate::claude::commands::start_claude_session(
        app.clone(),
        app.state::<ClaudeRegistry>(),
        app.state::<AppState>(),
        project_id.to_string(),
        tab_id.to_string(),
        cwd,
        mode,
        None, // allowed_tools:用项目持久化 allowlist
        None, // resume_session_id:走 AppState 持久化 sid 自动续接
        effort.clone(),
        model.clone(),
        None, // add_dirs
    )
    .await?;
    Ok(json!({ "ok": true, "provider": "claude", "effort": effort, "model": model }))
}

/// `chat.models`:手机快捷指令里的模型/推理档候选(只读)。
///
/// claude → `list_claude_models()`(`~/.claude/settings.json` 的 `env` 段 `*_MODEL` 值);
/// codex → `list_codex_models()`(cc-switch catalog,带 reasoning 档位)。
/// 统一成 `{provider, models:[{id,label,reasoningLevels}]}`,手机端一套渲染。
fn chat_models(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let project_id = req_str(params, "projectId")?;
    let tab_id = req_str(params, "tabId")?;
    let provider = provider_of(app, &project_id, &tab_id)
        .ok_or_else(|| format!("tab {tab_id} is not an AI tab"))?;

    if provider == "claude" {
        let models: Vec<Value> = crate::claude::commands::list_claude_models()?
            .into_iter()
            .map(|id| json!({ "id": id, "label": id, "reasoningLevels": [] }))
            .collect();
        // 供应商分组(2026-10-30:手机端模型切换加供应商维度):桌面 localStorage 的
        // 镜像(providers.json);没推过镜像(老桌面)groups 为空,手机退回扁平列表 +
        // /model 单键切换。activeModel = 当前 env 的 ANTHROPIC_MODEL。
        let providers = crate::claude::providers_mirror::load_providers(app);
        let current = crate::claude::providers_mirror::current_settings_env();
        let groups: Vec<Value> = providers
            .iter()
            .map(|p| {
                json!({
                    "id": p.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    "name": p.get("name").and_then(|v| v.as_str()).unwrap_or("未命名"),
                    "active": crate::claude::providers_mirror::is_active(p, &current),
                    "models": crate::claude::providers_mirror::configured_models(p),
                })
            })
            .filter(|g| g["models"].as_array().map(|a| !a.is_empty()).unwrap_or(false))
            .collect();
        let active_model = current.get("ANTHROPIC_MODEL").cloned().unwrap_or_default();
        return Ok(json!({ "provider": "claude", "models": models, "groups": groups, "activeModel": active_model }));
    }
    let models: Vec<Value> = crate::codex::commands::list_codex_models()?
        .into_iter()
        .map(|m| {
            json!({
                "id": m.slug,
                "label": m.display_name,
                "reasoningLevels": m.reasoning_levels,
            })
        })
        .collect();
    Ok(json!({ "provider": "codex", "models": models }))
}

/// `chat.setProviderModel`:手机端按供应商切模型(providers.json 镜像 + 整体替换
/// settings.json env 段,与桌面 `applyProvider` 同一条写入路径)。
///
/// busy 会话直接拒(与 chat.command 切模型同口径:让用户先停止,不静默掐断一轮回答)。
/// 桌面端感知:env 哈希检测已有(cc-switch 等外部改写同路径),无需额外通知。
fn chat_set_provider_model(app: &AppHandle, params: &Value) -> Result<Value, String> {
    guard_write(app)?;
    let project_id = req_str(params, "projectId")?;
    let tab_id = req_str(params, "tabId")?;
    let provider_id = req_str(params, "providerId")?;
    let model = req_str(params, "model")?;
    let provider = provider_of(app, &project_id, &tab_id)
        .ok_or_else(|| format!("tab {tab_id} is not an AI tab"))?;
    if provider != "claude" {
        return Err("setProviderModel only supports claude".into());
    }
    // busy 拒:与 chat.command 切模型同口径。
    {
        let reg = app.state::<ClaudeRegistry>();
        let by_project = reg.by_project.lock().map_err(|e| e.to_string())?;
        if let Some(s) = by_project.get(&project_id).and_then(|m| m.get(&tab_id)) {
            let busy = s
                .status
                .lock()
                .map(|g| matches!(*g, crate::claude::ClaudeStatus::Running | crate::claude::ClaudeStatus::Compacting))
                .unwrap_or(false);
            if busy {
                return Err("会话运行中,请先停止再切换模型".into());
            }
        }
    }
    // 镜像找 provider → env + ANTHROPIC_MODEL 覆盖 → 写 settings.json。
    let p = crate::claude::providers_mirror::load_providers(app)
        .into_iter()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(provider_id.as_str()))
        .ok_or_else(|| format!("provider {provider_id} not found (桌面端未推送供应商镜像)"))?;
    let mut env = crate::claude::providers_mirror::provider_env(&p);
    if model.is_empty() {
        return Err("model is empty".into());
    }
    env.insert("ANTHROPIC_MODEL".to_string(), model.clone());
    crate::claude::commands::write_claude_settings_env(env)?;
    log::info!(
        "[relay] chat.setProviderModel: {provider_id} -> {model} (tab {tab_id} of {project_id})"
    );
    Ok(json!({ "applied": true, "model": model }))
}

/// 会话是否已启(claude 长进程)。
fn claude_started(app: &AppHandle, project_id: &str, tab_id: &str) -> bool {
    let reg = app.state::<ClaudeRegistry>();
    let Ok(by_project) = reg.by_project.lock() else { return false };
    by_project
        .get(project_id)
        .and_then(|s| s.get(tab_id))
        .and_then(|s| s.child.lock().ok().map(|g| g.is_some()))
        .unwrap_or(false)
}

/// `chat.interrupt`:打断当前轮。
///
/// claude 用 `interrupt_claude_turn`(走 control_request,CLI 自己收尾并保全上下文),
/// 不直接 `kill_claude`——kill 会重启进程,手机上「停止」不该导致 5s 空转。
/// stdin 不可用(进程死了)时退回 kill(幂等)。
async fn chat_interrupt(app: &AppHandle, params: &Value) -> Result<Value, String> {
    guard_write(app)?;
    let project_id = req_str(params, "projectId")?;
    let tab_id = req_str(params, "tabId")?;
    let provider = provider_of(app, &project_id, &tab_id)
        .ok_or_else(|| format!("tab {tab_id} is not an AI tab"))?;

    if provider == "claude" {
        match crate::claude::commands::interrupt_claude_turn(
            app.clone(),
            project_id.clone(),
            tab_id.clone(),
        )
        .await
        {
            Ok(()) => Ok(json!({ "interrupted": true })),
            Err(e) => {
                log::warn!("[relay] soft interrupt failed ({e}), falling back to kill_claude");
                crate::claude::commands::kill_claude(
                    app.clone(),
                    app.state::<ClaudeRegistry>(),
                    project_id,
                    tab_id,
                )
                .await?;
                Ok(json!({ "interrupted": true, "hard": true }))
            }
        }
    } else {
        crate::codex::commands::kill_codex(
            app.clone(),
            app.state::<CodexRegistry>(),
            project_id,
            tab_id,
        )
        .await?;
        Ok(json!({ "interrupted": true }))
    }
}

/// `chat.permission`:回 claude 的 `can_use_tool` 决策(手机上的审批卡)。
///
/// 与桌面端 `respond_claude_permission` 同一条路径:`allow` 必须带 `updatedInput`
/// (CLI 认这个形态,spike 实测),`deny` 可带 message 让模型换方式。
async fn chat_permission(app: &AppHandle, params: &Value) -> Result<Value, String> {
    guard_write(app)?;
    let project_id = req_str(params, "projectId")?;
    let tab_id = req_str(params, "tabId")?;
    let request_id = req_str(params, "requestId")?;
    let behavior = params
        .get("behavior")
        .and_then(|b| b.as_str())
        .unwrap_or("deny")
        .to_string();
    let updated_input = params.get("updatedInput").cloned().filter(|v| !v.is_null());
    let message = params
        .get("message")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    crate::claude::commands::respond_claude_permission(
        app.clone(),
        app.state::<ClaudeRegistry>(),
        project_id,
        tab_id,
        request_id,
        behavior,
        updated_input,
        message,
    )
    .await?;
    Ok(json!({ "responded": true }))
}

// ---------- 快照 ----------

/// 离线快照 payload:项目列表 + 近 7 天用量(直调原始函数,不经 run_method)。
pub async fn build_snapshot(app: &AppHandle) -> Value {
    let usage = list_usage_rollups(Some(7))
        .await
        .ok()
        .and_then(|u| serde_json::to_value(u).ok())
        .unwrap_or(json!(null));
    json!({
        "v": 1,
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "projects": projects_payload(app),
        "usage": usage,
    })
}

/// sessions.list 的 root_path 入参:命令签名仅做绝对路径校验,取首个项目路径或 home。
fn fallback_root(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    if let Ok(snap) = state.inner.lock() {
        if let Some(p) = snap.projects.first() {
            return p.root_path.clone();
        }
    }
    dirs::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|| "C:\\".to_string())
}

fn whoami_host() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "txuyStudio-PC".into())
}

/// `pty.tail`:返回某 PTY 会话的输出快照(shell 只读镜像)。
///
/// 数据源是后端 `PtySession.transcript`(读循环维护的 256KB 环形缓存),语义与
/// 「WebView 重载后 re-attach 回放」完全一致——手机看到的就是终端此刻的屏上内容。
/// 纯读、不加锁跨 await:锁内 clone 出字节即释放。
///
/// 参数:`projectId` + `sessionId`(即桌面端 tabId;默认 pane 的 PTY key 恒为 `ps-1`,
/// 见 `default_pane_tree`,所以手机拿 pane 的 `tabs[].id` 直接当 sessionId 即可)。
/// 返回:`{data, bytes, alive}`。`data` 是原始字节 lossy 解码串(含 ANSI 转义),
/// **由手机侧决定如何渲染**——v1 手机剥掉控制序列显示纯文本(见 companion
/// `terminal_mirror_page.dart`),保留原始串是为了将来接真终端(xterm)不用改协议。
fn pty_tail(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let project_id = req_str(params, "projectId")?;
    let session_id = req_str(params, "sessionId")?;
    let reg = app.state::<crate::pty::PtyRegistry>();
    let mut by_project = reg.by_project.lock().map_err(|e| e.to_string())?;
    let session = by_project
        .get_mut(&project_id)
        .and_then(|m| m.get_mut(&session_id))
        .ok_or_else(|| format!("pty session not found: {project_id}/{session_id}"))?;
    // try_wait 非阻塞(与 spawn_pty 的 attach 探测同款):进程已退出 → alive=false。
    let alive = session.child.try_wait().map(|s| s.is_none()).unwrap_or(false);
    let bytes = session
        .transcript
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let bytes_len = bytes.len();
    Ok(json!({
        "data": String::from_utf8_lossy(&bytes).into_owned(),
        "bytes": bytes_len,
        "alive": alive,
    }))
}
