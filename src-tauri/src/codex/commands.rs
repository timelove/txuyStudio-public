//! codex 会话命令层(spawn 决策 / 发轮 / 中断 / 审批响应)。
//!
//! 进程模型(0.166 起):一个 codex tab = 一个常驻 `codex app-server` 进程(JSON-RPC over
//! stdio,协议层见 `super::app_server`)。发消息 = ensure 进程 → thread/start|resume →
//! turn/start;轮中事件(流式 delta/审批/用量)由 app_server 读循环 emit `codex-event`。
//!
//! 复用 `pty::commands` 的 `command_no_window`(CREATE_NO_WINDOW)/`resolve_on_path`/
//! `validate_cwd`(项目根校验)。`kill_child_tree` 与 claude 同实现(taskkill /F /T 杀进程树,
//! .cmd shim 下 node 是孙子进程),按项目惯例内联复制(M6 统一工具层时再合并)。
//!
//! 不变量(对齐 `claude/commands.rs`):
//! 1. `std::sync::Mutex` 持锁不跨 `.await`。
//! 2. 阻塞 kill 丢 `spawn_blocking` 且锁已释放。
//! 3. 读循环 fire-and-forget(app_server 模块)。
//! 4. 前端先 `listen("codex-event")` 再 `invoke("send_codex_message")`(防丢首批事件)。

use std::process::Stdio;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use super::app_server::{ensure_app_server, kill_session_process, respond_approval, rpc_request};
use super::{CodexEvent, CodexEventPayload, CodexRegistry, CodexStatus, SessionConfig};
use crate::pty::commands::{command_no_window, validate_cwd};

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

/// 发一轮 codex 对话(app-server 长连接模型)。
///
/// 流程:busy 检查 → ensure 进程(spawn+initialize,fresh=true 表示本次新拉)→ thread 决策:
/// - `/new` → `thread/start` 新会话;
/// - 用户指定 `resume_session_id`(SessionBrowser 恢复)→ `thread/resume {excludeTurns:true}`
///   (历史消息前端已从 rollout 读过,轻量恢复不重放);
/// - registry 有 live thread id 且进程非新拉 → 直接复用(进程内常驻,免 resume);
/// - registry 有 live id 但进程新拉(崩溃重启/中断杀进程后)→ `thread/resume` 续接
///   (rollout 在磁盘,跨进程可续,**杀进程不丢会话**);
/// - 无 id → `thread/start`。
/// → `turn/start {threadId, input}`(响应即回,轮中事件由读循环 emit)。
///
/// model/effort/sandbox/permission 传入路径(2026-11-04 定稿):
/// - thread/start|resume 带全量(thread 级字段名是 `sandbox` SandboxMode 字符串);
/// - live thread 复用时经 **turn/start per-turn override** 传递(0.166 schema:「for this
///   turn and subsequent turns」)——切换模型/推理档/沙箱/审批下一轮即生效,无需重启
///   进程或会话,上下文保留;
/// - config.toml+catalog 哈希变化(cc-switch 切供应商)→ 杀 app-server 进程重拉,
///   live thread id 保留走 resume 续接(rollout 在磁盘)。
/// 参数不识别自动降级裸参数重试(start/resume/turn 三处)。
#[tauri::command]
pub async fn send_codex_message(
    app: AppHandle,
    state: State<'_, CodexRegistry>,
    project_id: String,
    tab_id: String,
    cwd: Option<String>,
    prompt: String,
    sandbox: Option<String>,
    permission: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    resume_session_id: Option<String>,
    new_session: Option<bool>,
    // 手机经中继发来的消息:`Some(id)` = 轮启动后补发一条 user 事件(带该 id),桌面端才
    // 看得见「手机问的那句话」。桌面 transport 传 None——它已在前端 `appendUserMessage`
    // 乐观插入(app-server 也会以 userMessage item 回显,前端消费层负责去重)。
    client_message_id: Option<String>,
) -> Result<(), String> {
    // 1) busy 检查(先于 ensure:busy 时别拉进程)。
    {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        if let Some(session) = by_project.get(&project_id).and_then(|s| s.get(&tab_id)) {
            let st = session.status.lock().map_err(|e| e.to_string())?;
            if *st == CodexStatus::Running {
                return Err("codex session busy: interrupt the current turn first".to_string());
            }
        }
    }

    // 2) cwd 校验(锁外)。
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

    // 3) ensure app-server 进程(fresh=true = 本次新拉起,thread 需要 start/resume 而非复用)。
    let fresh = ensure_app_server(&app, &state, &project_id, &tab_id, cwd_v.as_deref()).await?;

    // 3.5) 供应商/模型目录配置变化检测(文件 IO 在锁外):config.toml+catalog 哈希与上次
    //    spawn 基线不同 → 杀进程重拉(app-server 启动时读一次 config,cc-switch 切供应商/
    //    改认证后必须重启进程才生效;live thread id 保留,下方 thread 决策走 resume 续接,
    //    上下文不丢)。首次无基线不触发。
    let spawn_hash = codex_config_hash();
    let config_changed = {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        let session = by_project
            .get(&project_id)
            .and_then(|s| s.get(&tab_id))
            .ok_or("codex session missing after ensure")?;
        let changed = session
            .config_hash
            .lock()
            .ok()
            .and_then(|g| *g)
            .map(|h| h != spawn_hash)
            .unwrap_or(false);
        if let Ok(mut h) = session.config_hash.lock() {
            *h = Some(spawn_hash);
        }
        changed
    };
    if config_changed {
        log::info!("send_codex_message: codex config changed, restarting app-server process (thread id kept)");
        kill_session_process(&app, &state, &project_id, &tab_id).await;
        ensure_app_server(&app, &state, &project_id, &tab_id, cwd_v.as_deref()).await?;
    }

    // 4) 文件 IO 在锁外:config.toml 默认 model。
    let config_model = get_codex_current_model_impl();

    // 5) 短锁:写 config/config_hash/model + thread 决策取 live id。
    let (live_id, permission_str, sandbox_str) = {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        let session = by_project
            .get(&project_id)
            .and_then(|s| s.get(&tab_id))
            .ok_or("codex session missing after ensure")?;
        let permission_str = permission.unwrap_or_else(|| "ask-for-approval".to_string());
        let sandbox_str = match permission_str.as_str() {
            "full-access" => "danger-full-access".to_string(),
            "read-only" => "read-only".to_string(),
            _ => sandbox.unwrap_or_else(|| "workspace-write".to_string()),
        };
        if let Ok(mut cfg) = session.config.lock() {
            *cfg = SessionConfig {
                cwd: cwd_v.clone(),
                sandbox: sandbox_str.clone(),
                permission: permission_str.clone(),
                model: model.clone(),
                reasoning_effort: reasoning_effort.clone(),
            };
        }
        if let Ok(mut m) = session.model.lock() {
            *m = model.clone().or_else(|| config_model.clone());
        }
        let mut rid = session.codex_session_id.lock().ok().and_then(|g| g.clone());
        if new_session == Some(true) {
            // /new 开新会话:忽略 live id(本轮 thread/start 新建,响应回填新 id)。
            rid = None;
            if let Ok(mut g) = session.codex_session_id.lock() {
                *g = None;
            }
        } else if let Some(user_rid) = &resume_session_id {
            // 用户 ↻ 显式恢复历史 thread:覆盖 registry 旧 id(前端 resumeSession 已设)。
            rid = Some(user_rid.clone());
            if let Ok(mut g) = session.codex_session_id.lock() {
                *g = Some(user_rid.clone());
            }
        }
        (rid, permission_str, sandbox_str)
    };

    log::info!(
        "send_codex_message: tab {tab_id} project {project_id} fresh={fresh} live_id={} resume_user={} new={} cwd={}",
        live_id.as_deref().unwrap_or("-"),
        resume_session_id.is_some(),
        new_session == Some(true),
        cwd_v.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "(default)".to_string())
    );

    // 6) thread 决策:start / resume / 复用。响应 result.thread.id 回填 registry + emit Init
    //    (前端幂等;复用路径不重发)。approval/sandbox 两处共用(turn/start override 同值)。
    //    approvalPolicy 映射(2026-11-04 修正,对齐 codex 原生语义):
    //    - approve-for-me(auto)= on-request:工作区内自动执行,**沙箱越界(如写工作区外)
    //      升级为审批询问**——此前误映射 never,越界被静默拒绝(用户实测:「外部创建文件
    //      直接拒了,按理应该先问」)。
    //    - ask-for-approval = untrusted:白名单命令免问,其余每步都问(真正贴「每次询问」;
    //      此前与 auto 同参,四档实际只有三种行为)。
    //    - full-access = never + danger-full-access 全放行;read-only = on-request(只读,
    //      写操作触发审批询问)。
    let approval = match permission_str.as_str() {
        "ask-for-approval" => "untrusted",
        "full-access" => "never",
        _ => "on-request",
    };
    let thread_id = if let (false, Some(id)) = (fresh, live_id.as_deref()) {
        id.to_string() // 进程未换 + live thread:直接复用(model/sandbox 变化由下方 per-turn override 传递)
    } else {
        // v2 协议(2026-11-04 schema 实测):thread 级沙箱字段是 `sandbox`(SandboxMode 字符串
        // "read-only"|"workspace-write"|"danger-full-access"),不是 v1 的 sandboxPolicy:{mode}
        // ——旧字段名会被 deny_unknown_fields 整体拒绝 → 降级裸参数,审批/沙箱从未生效过。
        let cwd_json = cwd_v.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
        let mut start_params = json!({
            "cwd": cwd_json,
            "approvalPolicy": approval,
            "sandbox": sandbox_str,
        });
        if let Some(m) = &model {
            if !m.is_empty() {
                start_params["model"] = json!(m);
            }
        }
        // 注:schema ThreadStartParams **无 effort 字段**(0.166 generate-json-schema 实测),
        // 推理档只能在 turn/start per-turn 传;此前这里发 effort 被服务端静默忽略。
        let want_resume = live_id.is_some(); // 新拉进程 + registry 有 id(或用户指定 resume)→ resume
        let thread = if want_resume {
            // resume 同样收 model/sandbox/approvalPolicy(schema 支持;effort 无对应字段,
            // 交给下方 turn/start per-turn 覆盖)。
            let id = live_id.clone().unwrap();
            let mut params = json!({
                "threadId": id,
                "cwd": cwd_json,
                "excludeTurns": true,
                "approvalPolicy": approval,
                "sandbox": sandbox_str,
            });
            if let Some(m) = &model {
                if !m.is_empty() {
                    params["model"] = json!(m);
                }
            }
            // 同 start:schema ThreadResumeParams 无 effort 字段,不发。
            rpc_request(&app, &project_id, &tab_id, "thread/resume", params).await
        } else {
            rpc_request(&app, &project_id, &tab_id, "thread/start", start_params.clone()).await
        };
        // 参数不被识别(server 端 deny_unknown_fields 会报 unknown field)→ 降级重试(裸参数):
        // start 退 bare start;resume 退 bare resume(threadId 必填字段,任何版本都认)。
        let thread = match thread {
            Ok(v) => v,
            Err(e) if !want_resume => {
                log::warn!("send_codex_message: thread/start with params failed ({e}), retry bare");
                let bare = json!({ "cwd": cwd_json });
                rpc_request(&app, &project_id, &tab_id, "thread/start", bare).await?
            }
            Err(e) => {
                log::warn!("send_codex_message: thread/resume with params failed ({e}), retry bare");
                let id = live_id.clone().unwrap();
                let bare = json!({ "threadId": id, "excludeTurns": true });
                rpc_request(&app, &project_id, &tab_id, "thread/resume", bare).await?
            }
        };
        let id = thread
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or("thread/start response missing thread.id")?
            .to_string();
        update_codex_session_id(&app, &project_id, &tab_id, id.clone());
        let _ = app.emit(
            "codex-event",
            CodexEvent {
                project_id: project_id.clone(),
                tab_id: tab_id.clone(),
                payload: CodexEventPayload::Init { session_id: id.clone() },
            },
        );
        id
    };

    // 7) turn/start(input + per-turn override;响应即回,轮中流式事件由读循环 emit)。
    //    0.166 schema:turn/start 支持 model/effort/sandboxPolicy/approvalPolicy 覆盖且语义为
    //    「for this turn and subsequent turns」——模型/推理档/沙箱/审批的 UI 切换下一轮即生效,
    //    无需重启进程或会话(上下文保留)。每轮都带,幂等;探针 probe-turn-override.ts 实测通过。
    //    sandboxPolicy 是 tagged 对象(v2),与 thread 级 sandbox 字符串不同形。
    //
    //    **auto/default = 解析默认档显式发送(2026-11-05 修正)**:override 是 sticky 的
    //    (「subsequent turns」),不传字段 = 沿用上次。而显式 null **不可达**——core 层
    //    `ThreadSettingsOverrides.effort` 三态里 `Some(None)` 才是清除,但公开 API 一律
    //    `effort.map(Some)` 单层映射,显式 null ≡ 缺字段 =「保持不变」(turn_processor.rs
    //    :930/:275 实证)。此前发 Value::Null 清 override 的方案无效(用户实测切 auto 不
    //    生效)。改为:None/空串(auto/default)→ `resolve_codex_default_effort` / config.toml
    //    默认模型解析出自然默认档显式发送,sticky 被当轮覆盖,永远等于 UI 当前选择。
    let sandbox_policy = match sandbox_str.as_str() {
        "read-only" => json!({ "type": "readOnly" }),
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        _ => json!({ "type": "workspaceWrite" }),
    };
    let mut turn_params = json!({
        "threadId": thread_id,
        "input": [{ "type": "text", "text": prompt }],
        "sandboxPolicy": sandbox_policy,
        "approvalPolicy": approval,
    });
    // model:auto/default → config.toml 默认模型(上一轮发过的模型 override 是 sticky 的,
    // 必须显式顶掉);具体模型直传。
    let effective_model = match model.as_deref() {
        Some(m) if !m.is_empty() => {
            turn_params["model"] = json!(m);
            Some(m.to_string())
        }
        _ => config_model.clone().filter(|m| !m.is_empty()).inspect(|m| {
            turn_params["model"] = json!(m);
        }),
    };
    // effort:auto → 自然默认档(config.toml model_reasoning_effort → catalog 当前模型
    // default_reasoning_level);具体档直传。都解析不到则不发(首颗钉子,无 override 可顶)。
    match reasoning_effort.as_deref() {
        Some(e) if !e.is_empty() => turn_params["effort"] = json!(e),
        _ => {
            if let Some(effort) = resolve_codex_default_effort(effective_model.as_deref()) {
                turn_params["effort"] = json!(effort);
            }
        }
    }
    let turn = (match rpc_request(&app, &project_id, &tab_id, "turn/start", turn_params).await {
        Ok(v) => Ok(v),
        Err(e) => {
            // 旧版 server 不认 per-turn 字段 → 裸参数重试(轮必发,失败才上抛)。
            log::warn!("send_codex_message: turn/start with overrides failed ({e}), retry bare");
            rpc_request(
                &app,
                &project_id,
                &tab_id,
                "turn/start",
                json!({ "threadId": thread_id, "input": [{ "type": "text", "text": prompt }] }),
            )
            .await
        }
    })
    .map_err(|e| format!("turn/start failed: {e}"))?;
    if let Some(turn_id) = turn.pointer("/turn/id").and_then(Value::as_str) {
        store_turn_id(&app, &project_id, &tab_id, Some(turn_id.to_string()));
    }

    // 8) 手机回显(同 claude;桌面乐观插入 + userMessage item 回显由前端去重)。
    if let Some(msg_id) = client_message_id {
        let _ = app.emit(
            "codex-event",
            CodexEvent {
                project_id,
                tab_id,
                payload: CodexEventPayload::User {
                    message: json!({
                        "id": msg_id,
                        "role": "user",
                        "content": [{ "type": "text", "text": prompt }],
                    }),
                },
            },
        );
    }

    Ok(())
}

/// 中断当前轮:优先 `turn/interrupt`(协议级,进程与 thread 保留,下轮继续用);
/// 失败(方法不存在/进程卡死)回退杀进程(live thread id 保留在 registry,下轮 ensure
/// 重拉 + thread/resume 续接,历史不丢)。emit `Terminated{interrupted}` 复位前端。
#[tauri::command]
pub async fn kill_codex(
    app: AppHandle,
    state: State<'_, CodexRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<(), String> {
    // 优雅路径:turn/interrupt(thread_id + turn_id 取 registry live 值,进程活着才可能
    // 成功)。0.166 schema TurnInterruptParams **required: [threadId, turnId]**——只发
    // threadId 会被 server 拒("missing field turnId"),导致每次中断都走杀进程回退。
    let (live_id, live_turn_id) = {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        by_project
            .get(&project_id)
            .and_then(|s| s.get(&tab_id))
            .map(|session| {
                (
                    session.codex_session_id.lock().ok().and_then(|g| g.clone()),
                    session.current_turn_id.lock().ok().and_then(|g| g.clone()),
                )
            })
            .unwrap_or((None, None))
    };
    let mut interrupted = false;
    if let (Some(id), Some(turn_id)) = (&live_id, &live_turn_id) {
        interrupted = rpc_request(
            &app,
            &project_id,
            &tab_id,
            "turn/interrupt",
            json!({ "threadId": id, "turnId": turn_id }),
        )
        .await
        .is_ok();
    }
    if interrupted {
        log::info!("kill_codex: turn/interrupt ok, tab {tab_id} project {project_id}");
    } else {
        // 回退:杀进程(killed=true 读循环静默,initialized=false 下轮重拉)。常见诱因:
        // turn id 尚未产生(轮刚启动)、或 interrupt 帧写 stdin 失败(进程已死,无需杀也幂等)。
        log::warn!("kill_codex: turn/interrupt unavailable, killing app-server process, tab {tab_id}");
        kill_session_process(&app, &state, &project_id, &tab_id).await;
    }
    let _ = set_session_status(&app, &project_id, &tab_id, CodexStatus::Idle);
    let _ = app.emit(
        "codex-event",
        CodexEvent {
            project_id,
            tab_id,
            payload: CodexEventPayload::Terminated {
                reason: "interrupted".to_string(),
            },
        },
    );
    Ok(())
}

/// 审批响应:前端对 `ApprovalRequested` 事件(key 在 request.key)做出决策后回写。
/// `approved=true` → {"decision":"approved"},false → denied(codex 会把拒绝反馈给模型)。
/// 请求已被解决(超时/重复响应)返回 Err。
#[tauri::command]
pub async fn respond_codex_approval(
    app: AppHandle,
    project_id: String,
    tab_id: String,
    request_key: String,
    approved: bool,
    // for_session:「本会话允许」(新代 acceptForSession);旧代审批无此形态,退化成普通批准。
    for_session: Option<bool>,
) -> Result<(), String> {
    respond_approval(
        &app,
        &project_id,
        &tab_id,
        &request_key,
        approved,
        for_session.unwrap_or(false),
    )
    .await
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

/// 解析「自然默认推理档」(UI auto 档位语义,2026-11-05 定稿)。
///
/// 背景:app-server 公开 API **无法清除 sticky effort override**——core
/// `ThreadSettingsOverrides.effort` 虽是三态 `Option<Option<ReasoningEffort>>`
/// (`Some(None)`=清除),但公开层(turn/start、thread/settings/update 等)一律
/// `effort.map(Some)` 单层映射:显式 null 反序列化为 None ≡ 缺字段 =「保持不变」,
/// 清除语义不可达(codex-rs turn_processor.rs:930/:275 实证);且 override 持久化进
/// state DB(resume 时灌回)。故 auto = **解析自然默认档并每轮显式发送**,sticky 被当轮
/// 覆盖,永远等于 UI 当前选择,无需重启进程(用户实测「切 auto 不生效」根因即此)。
///
/// 解析顺序:config.toml 顶层 `model_reasoning_effort`(codex 自身语义:全局默认档,
/// 不随模型变)→ catalog 当前模型的 `default_reasoning_level` → None(调用方不发字段)。
/// 行扫描风格与 `get_codex_current_model_impl` 一致。
fn resolve_codex_default_effort(effective_model: Option<&str>) -> Option<String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let base = std::path::Path::new(&home).join(".codex");

    // 1) config.toml 顶层 model_reasoning_effort(首个 [section] 前,跳注释/空行)。
    if let Ok(content) = std::fs::read_to_string(base.join("config.toml")) {
        for line in content.lines() {
            let t = line.trim();
            if t.starts_with('#') || t.is_empty() {
                continue;
            }
            if t.starts_with('[') {
                break; // 进入 section,顶层段结束
            }
            if let Some(rest) = t.strip_prefix("model_reasoning_effort") {
                let rest = rest.trim_start();
                if let Some(val) = rest.strip_prefix('=') {
                    let v = val.trim().trim_matches('"').trim_matches('\'');
                    if !v.is_empty() {
                        return Some(v.to_string());
                    }
                }
            }
        }
    }

    // 2) catalog 里本轮生效模型的 default_reasoning_level(按模型而异,如 gpt-5.6-sol=low)。
    if let Some(slug) = effective_model {
        if let Ok(content) = std::fs::read_to_string(base.join("cc-switch-model-catalog.json")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(level) = v
                    .get("models")
                    .and_then(|m| m.as_array())
                    .and_then(|arr| {
                        arr.iter().find(|m| m.get("slug").and_then(|s| s.as_str()) == Some(slug))
                    })
                    .and_then(|m| m.get("default_reasoning_level"))
                    .and_then(|x| x.as_str())
                {
                    if !level.is_empty() {
                        return Some(level.to_string());
                    }
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

/// `~/.codex/config.toml` 路径(home 下 .codex/config.toml;dirs::home_dir 兜底 USERPROFILE)。
fn codex_config_path() -> Option<std::path::PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir())
        .map(|home| home.join(".codex").join("config.toml"))
}

/// 读 config.toml + auth.json 当前 provider 信息(txuyStudio 内置 codex 供应商管理用:
/// 「生效中」判定 + 「从当前导入」)。段名取顶级 `model_provider` 实际值(缺省 "custom",
/// 与 cc-switch 惯例一致),从 `[model_providers.<段名>]` 取 base_url / wire_api /
/// experimental_bearer_token / requires_openai_auth,顶级取 model / model_reasoning_effort;
/// requires_openai_auth=true 时 token 实值改读 auth.json 的 OPENAI_API_KEY(cc-switch 形态),
/// 并把形态报给前端 authStyle = "auth_json",否则 "bearer"。文件缺失/解析失败返回各字段
/// 空串(非错误,前端按未知显示)。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderInfo {
    pub base_url: String,
    pub token: String,
    pub model: String,
    pub reasoning_effort: String,
    pub wire_api: String,
    pub auth_style: String,
}

#[tauri::command]
pub fn read_codex_provider_info() -> Result<CodexProviderInfo, String> {
    use toml_edit::DocumentMut;
    let doc: DocumentMut = codex_config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|content| content.parse::<DocumentMut>().ok())
        .unwrap_or_default();
    let key = doc
        .get("model_provider")
        .and_then(|v| v.as_str())
        .unwrap_or("custom")
        .to_string();
    let empty = String::new();
    let (base_url, bearer_token, wire_api, requires_openai_auth) = doc
        .get("model_providers")
        .and_then(|mp| mp.get(&key))
        .map(|t| {
            (
                t.get("base_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                t.get("experimental_bearer_token").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                t.get("wire_api").and_then(|v| v.as_str()).unwrap_or("responses").to_string(),
                t.get("requires_openai_auth").and_then(|v| v.as_bool()).unwrap_or(false),
            )
        })
        .unwrap_or((empty.clone(), empty.clone(), "responses".to_string(), false));
    let auth_json = read_codex_auth_json();
    let (auth_style, token) = if requires_openai_auth {
        (
            "auth_json".to_string(),
            auth_json.as_ref().and_then(|v| v.get("OPENAI_API_KEY")).and_then(|x| x.as_str()).unwrap_or("").to_string(),
        )
    } else {
        ("bearer".to_string(), bearer_token)
    };
    Ok(CodexProviderInfo {
        base_url,
        token,
        model: doc.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        reasoning_effort: doc
            .get("model_reasoning_effort")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        wire_api,
        auth_style,
    })
}

/// 读 ~/.codex/auth.json(codex 登录态/OpenAI API key;不存在或解析失败返回 None——
/// 非错误,认证形态判定按「无 key」处理)。只读,不缓存。
fn read_codex_auth_json() -> Option<serde_json::Value> {
    let path = std::env::var("USERPROFILE")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(dirs::home_dir)?
        .join(".codex")
        .join("auth.json");
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 应用 codex provider:toml_edit **保格式**改写 config.toml 的 provider 相关部分——
/// 顶级 `model_provider` / `model`(reasoning_effort 非空才写,空保留现状)与
/// `[model_providers.custom]` 段重建(name/base_url/wire_api + 认证字段)。**mcp_servers /
/// plugins / marketplaces 等其余段与注释原样保留**(与 cc-switch 整份替换不同:用户本地
/// MCP/插件配置不进 provider 副本,不丢)。
///
/// 认证字段 auth_style(cc-switch 两形态,2026-11-04):
/// - "bearer"(默认):段内 experimental_bearer_token = token,requires_openai_auth=false;
/// - "auth_json":段内 requires_openai_auth=true、不写 bearer 键(显式清干净防双键并存
///   语义不明),token 写 ~/.codex/auth.json 的 OPENAI_API_KEY(**保 auth.json 其余键**,
///   官方 OAuth 登录态的 tokens/last_refresh 不动)。
#[tauri::command]
pub fn apply_codex_provider(
    name: String,
    base_url: String,
    token: String,
    model: String,
    wire_api: Option<String>,
    auth_style: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    use toml_edit::{value, DocumentMut, Item, Table};
    let path = codex_config_path().ok_or_else(|| "cannot resolve home directory".to_string())?;
    let mut doc = std::fs::read_to_string(&path)
        .ok()
        .and_then(|content| content.parse::<DocumentMut>().ok())
        .unwrap_or_default();

    // 顶级键:覆盖 model_provider/model;reasoning_effort 仅非空时写(空 = 保留现状,不删用户配置)。
    doc["model_provider"] = value("custom");
    if !model.is_empty() {
        doc["model"] = value(model.as_str());
    }
    if let Some(effort) = reasoning_effort.as_deref().filter(|e| !e.is_empty()) {
        doc["model_reasoning_effort"] = value(effort);
    }

    // 认证形态:bearer(默认)之外仅认 "auth_json",其余值按 bearer 兜底。
    let auth_json_style = auth_style.as_deref() == Some("auth_json");

    // [model_providers.custom] 重建(整段替换,旧段遗留键清干净)。
    let mut t = Table::new();
    t["name"] = value(name);
    t["base_url"] = value(base_url);
    t["wire_api"] = value(wire_api.as_deref().unwrap_or("responses"));
    t["requires_openai_auth"] = value(auth_json_style);
    if !auth_json_style {
        t["experimental_bearer_token"] = value(token.clone());
    }
    let mp = doc["model_providers"].or_insert(Item::Table({
        let mut tbl = Table::new();
        tbl.set_implicit(true);
        tbl
    }));
    if let Some(mp) = mp.as_table_mut() {
        mp["custom"] = Item::Table(t);
    } else {
        return Err("config.toml [model_providers] is not a table".to_string());
    }

    std::fs::write(&path, doc.to_string()).map_err(|e| format!("write config.toml: {e}"))?;

    if auth_json_style {
        write_codex_auth_json(&token)?;
    }
    Ok(())
}

/// 写 ~/.codex/auth.json 的 OPENAI_API_KEY(**保留其余键**——官方 OAuth 登录态的
/// tokens/last_refresh 等不能被 API key 切换冲掉;文件不存在则只建该键)。写前先落
/// 同目录 .bak(写失败可手捞,不回滚 config.toml——两个文件的写序 config 先行,失败
/// 时前端报错即可)。
fn write_codex_auth_json(token: &str) -> Result<(), String> {
    let dir = std::env::var("USERPROFILE")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or_else(|| "cannot resolve home directory".to_string())?
        .join(".codex");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create ~/.codex: {e}"))?;
    let path = dir.join("auth.json");
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "auth.json is not an object".to_string())?;
    obj.insert("OPENAI_API_KEY".to_string(), serde_json::Value::String(token.to_string()));
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize auth.json: {e}"))?;
    let _ = std::fs::copy(&path, dir.join("auth.json.bak"));
    std::fs::write(&path, pretty + "\n").map_err(|e| format!("write auth.json: {e}"))
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

// -- registry 辅助(均短锁,失败静默不阻断主流程;app_server 读循环与命令层共用) --

/// spawn 失败统一出口:置 Error + emit `Terminated{spawn failed}`(前端显示错误并复位输入框)。
pub(super) fn emit_spawn_failed(app: &AppHandle, project_id: &str, tab_id: &str, msg: &str) {
    let _ = set_session_status(app, project_id, tab_id, CodexStatus::Error);
    let _ = app.emit(
        "codex-event",
        CodexEvent {
            project_id: project_id.to_string(),
            tab_id: tab_id.to_string(),
            payload: CodexEventPayload::Terminated { reason: msg.to_string() },
        },
    );
}

/// 进程退出收尾(读循环 EOF / 主动杀进程后):child 清空、initialized=false、status=Idle。
/// **不清 codex_session_id**——rollout 在磁盘,下轮 ensure 重拉进程后 thread/resume 同 id
/// 续接,杀进程/崩溃不丢会话。
/// 进程死亡收尾:拍灭 initialized + 清 child 句柄 + status=Idle(下轮 send 自动重拉)。
///
/// `killed` 参数是**调用方所代表那一代进程**的 killed Arc(spawn 时下发)。registry 若已
/// 换代(`Arc::ptr_eq` 不匹配 = 期间 respawn 过),本次是旧读循环迟到的 EOF,严禁清掉
/// 新一代的 child/initialized/status——否则新进程句柄丢失(kill 时杀不到,进程泄漏)+
/// initialized 拍灭(下轮 send 误判进程死了再重拉)。2026-11-05 用户日志实锤:
/// 01:25:48 kill→respawn 后,01:26:02 旧循环 EOF 无门控收尸清了新进程句柄。
pub(super) fn mark_process_dead(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    killed: &Arc<std::sync::atomic::AtomicBool>,
) {
    let registry = app.state::<CodexRegistry>();
    let by_project = match registry.by_project.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(session) = by_project.get(project_id).and_then(|s| s.get(tab_id)) {
        if !Arc::ptr_eq(&session.killed, killed) {
            return; // 换代了:旧循环迟到收尾,不动新代状态
        }
        session.initialized.store(false, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut g) = session.child.lock() {
            let _ = g.take();
        }
        if let Ok(mut s) = session.status.lock() {
            *s = CodexStatus::Idle;
        }
    }
}

/// 回填当前 turn id(turn/started 与 turn/start 响应;turn/interrupt 用)。
pub(super) fn store_turn_id(app: &AppHandle, project_id: &str, tab_id: &str, turn_id: Option<String>) {
    let registry = app.state::<CodexRegistry>();
    let by_project = match registry.by_project.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(session) = by_project.get(project_id).and_then(|s| s.get(tab_id)) {
        if let Ok(mut g) = session.current_turn_id.lock() {
            *g = turn_id;
        }
    }
}

/// 回填 codex_session_id 到 registry(短锁)。thread started/resume 响应后调用,后续轮
/// thread/resume 用。始终更新(同 id 幂等;/new 开新会话换 id 时捕获最新)。不持久化到
/// AppState(claude 有 claude_tab_sessions 跨重启 resume;codex MVP 不持久化,重启 app 后
/// tab 开新会话,历史会话仍可经 SessionBrowser 手动 resume)。
pub(super) fn update_codex_session_id(
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
pub(super) fn set_session_status(
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

