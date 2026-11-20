//! 感知层:AiBus 订阅 + 规则状态机(确定性推导会话语义态,零 token)。
//!
//! AiBus 帧形如 `{provider, projectId, tabId, payload}`(见 `relay/bus.rs`),
//! payload 是 claude/codex 各自 `*EventPayload` 的 serde 序列化(`kind` tag + camelCase)。
//! classify 按「显式白名单」转译:命中列表的事件才改变语义态,未知/辅助事件(用量、
//! 后台任务通知等)一律忽略——新事件类型不会污染状态,终态不会被噪音翻转。
//!
//! 事件推送节流:`conductor-event` 只在 **kind 变化**(含新会话首帧)时广播,
//! thinking token / item 增量等高频事件不触发;徽标与指挥窗据此 refetch 快照。

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use super::{
    attention_count, commands, emit_event, now_ms, next_beat_seq, skey, stage_beat_weight, truncate_chars,
    ConductorData, ConductorState, SessionKind, SessionStatus, ToolBeat, SEEN_TOOL_IDS, TOOL_BEATS,
};
use crate::relay::bus::AiBus;

/// 订阅 AiBus 并常驻处理帧。在 conductor::install 内启动(tokio runtime 已就绪)。
/// Lagged(慢消费者丢帧)仅告警继续——快照是全量拉取,丢帧只是迟到,不缺状态。
pub fn spawn_watcher(app: &AppHandle) {
    let Some(bus) = app.try_state::<AiBus>() else {
        log::warn!("conductor: AiBus not found, watcher not started (install order?)");
        return;
    };
    let mut rx = bus.0.subscribe();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(frame) => process_frame(&app, &frame),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!("conductor: AiBus lagged, {n} frame(s) dropped");
                }
                Err(_) => break, // Closed:总线发送端没了,退出
            }
        }
    });
}

/// 处理单帧:提取路由字段 → classify → 更新会话表 → kind 变化时广播计数。
/// 锁两段各自极短(更新一次 / 重算计数),不跨 await。
fn process_frame(app: &AppHandle, frame: &Value) {
    let provider = frame.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let Some(project_id) = frame.get("projectId").and_then(|v| v.as_str()) else {
        return;
    };
    let Some(tab_id) = frame.get("tabId").and_then(|v| v.as_str()) else {
        return;
    };
    let Some(payload) = frame.get("payload") else { return };
    // 项目级指挥台开关:静音项目的帧直接丢弃——不出会话卡/不计徽标/不产建议/
    // 不验收/不代批(黑名单口径,人手动投递不受影响)。
    {
        let Some(state) = app.try_state::<ConductorState>() else { return };
        let Ok(data) = state.0.lock() else { return };
        if super::is_muted(&data, project_id) {
            return;
        }
    }
    // classify 在锁外(纯函数);None = 忽略帧。
    let Some((kind, detail)) = classify(provider, payload) else {
        return;
    };

    let state = match app.try_state::<ConductorState>() {
        Some(s) => s,
        None => return,
    };
    let (changed, new_beats) = {
        let Ok(mut data) = state.0.lock() else { return };
        // 尾部摘要积累(验收回环原料,在语义态更新同一段锁内顺手完成)。
        // claude assistant 帧是增量快照(同 message.id 逐块重发),相邻重复行跳过。
        if let Some(line) = tail_line(provider, payload) {
            let dup = data
                .session_tails
                .get(&skey(project_id, tab_id))
                .and_then(|t| t.back())
                .is_some_and(|last| last.text == line);
            if !dup {
                super::push_tail_locked(&mut data, project_id, tab_id, line);
            }
        }
        // Agent 实况拍提取(2026-11-19):同一段锁内顺手完成。工具调用帧(claude
        // assistant / codex item_started)恒过 classify 白名单,此处必然可达。
        let new_beats = collect_beats(&mut data, provider, project_id, tab_id, payload);
        let existed = data.sessions.contains_key(&super::skey(project_id, tab_id));
        let entry = data.sessions.entry(super::skey(project_id, tab_id)).or_insert_with(|| SessionStatus {
            tab_id: tab_id.to_string(),
            provider: provider.to_string(),
            project_id: project_id.to_string(),
            project_name: String::new(),
            tab_title: String::new(),
            kind,
            detail: detail.clone(),
            last_event_ms: now_ms(),
        });
        let changed = if existed { entry.kind != kind } else { true };
        entry.kind = kind;
        entry.detail = detail;
        entry.last_event_ms = now_ms();
        (changed, new_beats)
    };
    // 实况拍增量推送(锁外):指挥窗「Agent 实况」逐拍落地;无新拍零开销。
    if !new_beats.is_empty() {
        let _ = app.emit("conductor-tool-event", serde_json::json!({ "beats": new_beats }));
    }
    if changed {
        // 计数重算走第二次短锁(锁已释放,不跨 await)。
        let count = state.0.lock().map(|d| attention_count(&d)).unwrap_or(0);
        emit_event(app, count, "attention");
        // 终态流转 → 验收回环优先(自动驾驶一期):有未验收的派活记录先走大脑验收
        // (success 清账 / failed 留人审 / rework 自动返工一次),无记录才走常规建议。
        // 两者互斥:验收本身要产出「下一步」(返工或结案),再跑建议会自驱循环。
        if kind.is_terminal_kind() {
            let app = app.clone();
            let project_id = project_id.to_string();
            let tab_id = tab_id.to_string();
            // 终态时刻(归属过滤用):auto_verdict 只接「终态前派出的活」,上一轮终态的
            // 迟到验收不再吞刚投出的新任务(2026-11-18)。
            let terminal_ms = now_ms();
            tauri::async_runtime::spawn(async move {
                // 返回值忽略:终态钩子无人在等结果(手动测试走 conductor_suggest_now,有回执)。
                // 顺序(2026-11-17 用户实测修正;2026-11-18 补直投领取):验收 →
                // **排队补投** → **直投孵化领取** → 常规建议。
                // 补投必须先于建议——建议的 brain 网络调用耗时数秒到数十秒(实测 glm-flash
                // 26s),排后会把「跑完立即补投」拖成半分钟,用户以为没投;补投是纯本地
                // 判定即时执行。补投/领取必须后于验收——它们会登记新的待验收记录,先投
                // 会让 auto_verdict 拿「还没跑的任务」去误判。验收 rework 把会话推回
                // Running 时,补投/领取内部的空闲与串行检查会拦,无妨。
                let verdict_taken = matches!(
                    commands::auto_verdict(app.clone(), project_id.clone(), tab_id.clone(), terminal_ms).await,
                    Ok(true)
                );
                if matches!(kind, SessionKind::Finished) {
                    // 排队(人点过「立即执行」的延迟执行)优先,再领孵化池 pending
                    // (直投工作流的自动续接,2026-11-18 用户:「验收失败后,就不走
                    // 我的孵化任务了」);两者各自登记 pv,先投出后一个自然让位。
                    super::pipeline::dispatch_queued(&app, &project_id, &tab_id).await;
                    super::pipeline::pick_after_direct(&app, &project_id, &tab_id).await;
                }
                if !verdict_taken {
                    let _ = commands::auto_suggest(
                        app.clone(),
                        Some((Some(project_id.clone()), tab_id.clone())),
                        super::inbox::DecisionSource::Brain,
                    )
                    .await;
                }
            });
        } else if matches!(kind, SessionKind::Idle) {
            // Idle 流转(init/人中断)也查排队——重启后排队条目在会话启动时补投。
            let app = app.clone();
            let project_id = project_id.to_string();
            let tab_id = tab_id.to_string();
            tauri::async_runtime::spawn(async move {
                super::pipeline::dispatch_queued(&app, &project_id, &tab_id).await;
            });
        }
    }
    // 工具/命令审批请求 → 代批判定(本地规则,零 token)。claude PermissionRequest 与
    // codex ApprovalRequested(app-server)统一进 [`maybe_auto_approve`](2026-11-18 补
    // codex:此前只挂 claude,拆步投到 codex 会话的审批卡没有宽限代批/倒计时)。放行则
    // 由后端直接回审批响应,CLI 自己执行续跑该轮;转人时才弹卡。不依赖 changed:CLI
    // 每次请求只发一帧,重复帧由 autopilot 的 request_id 去重窗挡。
    if kind == SessionKind::WaitingApproval {
        let app = app.clone();
        let provider = provider.to_string();
        let project_id = project_id.to_string();
        let tab_id = tab_id.to_string();
        let payload = payload.clone();
        tauri::async_runtime::spawn(async move {
            super::autopilot::maybe_auto_approve(&app, &provider, &project_id, &tab_id, &payload).await;
        });
    }
}

/// 事件白名单 → 语义态转译。返回 None = 该帧不改变状态。
/// 从事件帧提取一行「会话产出摘要」(验收判定 `verify_task` 的「会话最后产出」原料;
/// None = 不记)。只记有信息量的帧:assistant 文本/工具调用、轮末 result、codex item
/// 产出;thinking/user/init 等噪音不进缓冲(TAIL_LINES 窗口留给真产出)。
fn tail_line(provider: &str, payload: &Value) -> Option<String> {
    let kind = payload.get("kind").and_then(|v| v.as_str())?;
    let truncate = |s: &str, max: usize| super::truncate_chars(s, max);
    match provider {
        "claude" => match kind {
            "assistant" => {
                let content = payload.get("message")?.get("content")?;
                let blocks = content.as_array()?;
                let mut parts: Vec<String> = Vec::new();
                for b in blocks {
                    match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                        "text" => {
                            let t = b.get("text").and_then(|v| v.as_str()).map(str::trim);
                            if let Some(t) = t.filter(|s| !s.is_empty()) {
                                parts.push(truncate(t, super::TAIL_LINE_MAX_CHARS));
                            }
                        }
                        "tool_use" => {
                            let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                            parts.push(format!("调用工具 {name}"));
                        }
                        _ => {}
                    }
                }
                if parts.is_empty() {
                    return None; // 纯 thinking 帧:无产出文本,不占窗口
                }
                Some(format!("助手: {}", parts.join(" | ")))
            }
            "result" => {
                let success = payload.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                if success {
                    Some("轮次结束: 成功".to_string())
                } else {
                    let err = payload.get("error").and_then(|v| v.as_str()).unwrap_or("未知错误");
                    Some(format!("轮次结束: 失败 {}", truncate(err, 200)))
                }
            }
            // 工具结果回包(2026-11-18 补验收证据链):tool_result 的 content 是执行
            // 产出——此前不记,验收员只看得到「调用工具 Bash」看不到结果,判「未执行
            // 目标命令」失真(用户实测)。手输文本的 user 帧无 tool_result 块,自然跳过。
            "user" => {
                let content = payload.get("message")?.get("content")?;
                let blocks = content.as_array()?;
                let mut parts: Vec<String> = Vec::new();
                for b in blocks {
                    if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                        continue;
                    }
                    let c = b.get("content");
                    let text = c
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                        .or_else(|| {
                            c.and_then(|v| v.as_array()).map(|arr| {
                                arr.iter()
                                    .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
                                    .collect::<Vec<_>>()
                                    .join(" ")
                            })
                        });
                    if let Some(t) = text.filter(|s| !s.trim().is_empty()) {
                        parts.push(truncate(t.trim(), 200));
                    }
                }
                if parts.is_empty() {
                    None // 纯手输消息:无工具结果,不占窗口
                } else {
                    Some(format!("工具结果: {}", parts.join(" | ")))
                }
            }
            _ => None,
        },
        "codex" => match kind {
            "item_completed" => {
                let item = payload.get("item")?;
                // 宽松提取:item.completed 自带输入+输出;文本类(item.text)优先,
                // 命令类(command + aggregated_output)次之,结构随 codex 版本漂移可容忍。
                if let Some(text) = item.get("text") {
                    let joined = text.as_str().map(str::to_string).or_else(|| {
                        text.as_array().map(|arr| {
                            arr.iter()
                                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                    });
                    if let Some(s) = joined.filter(|s| !s.trim().is_empty()) {
                        return Some(format!("产出: {}", truncate(s.trim(), super::TAIL_LINE_MAX_CHARS)));
                    }
                }
                let cmd = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let out = item.get("aggregated_output").and_then(|v| v.as_str()).unwrap_or("");
                if !cmd.is_empty() {
                    return Some(format!("执行: {} → {}", truncate(cmd, 200), truncate(out, 200)));
                }
                None
            }
            "turn_completed" => Some("轮次结束: 完成".to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// Agent 实况拍提取(锁内调用,events watcher 主锁段):本帧新产生的工具调用拍。
/// - claude `assistant`:content[] 的 tool_use 块。帧是增量快照(同 message.id 逐块
///   重发),按 tool_use.id 查 `seen_tool_ids` 去重——不挡会把同一调用记成多拍;
/// - codex `item_started`:item 自带输入(command/arguments),started 每 item 恰发
///   一次,无需去重。只取 command_execution / mcp_tool_call 两类(agent_message 等
///   不是工具调用)。
/// 摘要复用 claude 手机端 brief 取法(首个路径/命令类字段,200 字截断)。
fn collect_beats(
    data: &mut ConductorData,
    provider: &str,
    project_id: &str,
    tab_id: &str,
    payload: &Value,
) -> Vec<ToolBeat> {
    let kind = payload.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let mut out: Vec<ToolBeat> = Vec::new();
    let push = |tool: &str, summary: String, out: &mut Vec<ToolBeat>| {
        out.push(ToolBeat {
            seq: next_beat_seq(),
            provider: provider.to_string(),
            project_id: project_id.to_string(),
            tab_id: tab_id.to_string(),
            tool: tool.to_string(),
            summary: truncate_chars(summary.trim(), 120),
            ms: now_ms(),
        });
    };
    match (provider, kind) {
        ("claude", "assistant") => {
            let Some(blocks) = payload
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            else {
                return out;
            };
            let key = skey(project_id, tab_id);
            for b in blocks {
                if b.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                    continue;
                }
                let Some(id) = b.get("id").and_then(|v| v.as_str()) else { continue };
                let seen = data.seen_tool_ids.entry(key.clone()).or_default();
                if seen.iter().any(|x| x == id) {
                    continue; // 增量快照重发:已记过这拍
                }
                seen.push_back(id.to_string());
                while seen.len() > SEEN_TOOL_IDS {
                    seen.pop_front();
                }
                let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                let summary = crate::claude::commands::brief_input_for_mobile(b.get("input"));
                push(name, summary, &mut out);
            }
        }
        ("codex", "item_started") => {
            let Some(item) = payload.get("item") else { return out };
            match item.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "command_execution" => {
                    if let Some(cmd) = item.get("command").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        push("shell", cmd.to_string(), &mut out);
                    }
                }
                "mcp_tool_call" => {
                    let server = item.get("server").and_then(|v| v.as_str()).unwrap_or("mcp");
                    let tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("call");
                    let brief = crate::claude::commands::brief_input_for_mobile(item.get("arguments"));
                    if !brief.is_empty() {
                        push(&format!("mcp:{server}.{tool}"), brief, &mut out);
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
    // 入环形缓冲(新的在后,挤最旧)+ XP 总账累加(2026-11-19 记录化:后端权威,
    // 权重表与前端同口径;脏标记交 30s persist loop 批量落盘)。
    for beat in &out {
        data.tool_beats.push_back(beat.clone());
        data.stage_xp += stage_beat_weight(&beat.tool);
    }
    while data.tool_beats.len() > TOOL_BEATS {
        data.tool_beats.pop_front();
    }
    if !out.is_empty() {
        data.stage_dirty = true;
    }
    // 自证日志(低频:每次工具调用一条):面板无拍时先看这里——有日志=后端已产出,
    // 问题在前端;无日志=帧没到 collect_beats(旧二进制/静音项目/帧形态不符)。
    if !out.is_empty() {
        log::info!(
            "conductor: stage beat [{}] {} x{} (beats total {})",
            provider,
            out.iter().map(|b| b.tool.as_str()).collect::<Vec<_>>().join(","),
            out.len(),
            data.tool_beats.len()
        );
    }
    out
}

fn classify(provider: &str, payload: &Value) -> Option<(SessionKind, Option<String>)> {
    let kind = payload.get("kind").and_then(|v| v.as_str())?;
    match provider {
        "claude" => match kind {
            // 会话启动(含 /restart):进程活着、无轮次在跑。
            "init" => Some((SessionKind::Idle, None)),
            // 卡审批:detail 带工具名(权限卡标题)。
            "permission_request" => {
                let tool = payload
                    .get("toolName")
                    .and_then(|v| v.as_str())
                    .or_else(|| payload.get("displayName").and_then(|v| v.as_str()));
                Some((SessionKind::WaitingApproval, tool.map(str::to_string)))
            }
            // 一轮收尾:result 自带 success 标志。
            "result" => {
                let success = payload.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                if success {
                    Some((SessionKind::Finished, None))
                } else {
                    let detail = payload.get("error").and_then(|v| v.as_str()).map(str::to_string);
                    Some((SessionKind::Error, detail))
                }
            }
            // 进程退出:interrupted = 人为中断(非错误);eof/spawn failed = 故障。
            "terminated" => {
                let reason = payload.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                match reason {
                    "interrupted" => Some((SessionKind::Idle, None)),
                    other => Some((SessionKind::Error, Some(other.to_string()))),
                }
            }
            // 轮次活动事件(人刚发消息的 user 回显 / 模型输出 / 思考)。
            "user" | "assistant" | "thinking" => Some((SessionKind::Running, None)),
            // compact 状态、后台任务、用量等辅助事件:不改变语义态。
            _ => None,
        },
        "codex" => match kind {
            "init" => Some((SessionKind::Idle, None)),
            "approval_requested" => Some((SessionKind::WaitingApproval, None)),
            "approval_resolved" => Some((SessionKind::Running, None)),
            "turn_started" => Some((SessionKind::Running, None)),
            // 一轮完成(app-server 每轮后随 terminated{normal},后者被忽略,见下)。
            "turn_completed" => Some((SessionKind::Finished, None)),
            "user" | "item_started" | "item_completed" | "item_delta" | "usage_updated" => {
                Some((SessionKind::Running, None))
            }
            // 进程退出:normal = 每轮正常 EOF(状态已由 turn_completed 落 Finished,忽略,
            // 否则徽标 Finished→Idle 闪一下);interrupted = 人为中断;其余 = 故障。
            "terminated" => {
                let reason = payload.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                match reason {
                    "normal" => None,
                    "interrupted" => Some((SessionKind::Idle, None)),
                    other => Some((SessionKind::Error, Some(other.to_string()))),
                }
            }
            _ => None,
        },
        _ => None,
    }
}
