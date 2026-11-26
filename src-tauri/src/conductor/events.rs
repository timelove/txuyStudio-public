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
        // 文本提问启发式原料(2026-11-25):claude assistant 帧的 text block 合并存尾部
        // 500 字符(增量顺序输出,最新 text 帧即末段;纯工具帧不更新)。result 判定用。
        if provider == "claude"
            && payload.get("kind").and_then(|v| v.as_str()) == Some("assistant")
        {
            let text = payload
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .unwrap_or_default();
            if !text.trim().is_empty() {
                let chars: Vec<char> = text.chars().collect();
                let start = chars.len().saturating_sub(500);
                let tail: String = chars[start..].iter().collect();
                data.last_text_tail.insert(super::skey(project_id, tab_id), tail);
            }
        }
        // 文本提问启发式(轮终门控):success result 时预取末段问句判定(≥2 分高置信)——
        // **在 entry 借用前完成**(MutexGuard Deref 不支持字段级拆分,与 sessions 的
        // &mut 并存会 E0502)。
        let heuristic_q: Option<String> = if provider == "claude"
            && payload.get("kind").and_then(|v| v.as_str()) == Some("result")
            && payload.get("success").and_then(|v| v.as_bool()) == Some(true)
        {
            data.last_text_tail
                .get(&super::skey(project_id, tab_id))
                .and_then(|t| detect_text_question(t))
                .map(|(q, _score)| q)
        } else {
            None
        };
        let existed = data.sessions.contains_key(&super::skey(project_id, tab_id));
        let entry = data.sessions.entry(super::skey(project_id, tab_id)).or_insert_with(|| SessionStatus {
            tab_id: tab_id.to_string(),
            provider: provider.to_string(),
            project_id: project_id.to_string(),
            project_name: String::new(),
            tab_title: String::new(),
            kind,
            detail: detail.clone(),
            waiting_choice: None,
            last_event_ms: now_ms(),
        });
        let changed = if existed { entry.kind != kind } else { true };
        // AI 提问待选择(AskUserQuestion,2026-11-25):assistant 帧带该工具 → 置位(问题摘要);
        // kind 流转且非 Finished(用户回复开新轮 Running/中断 Idle/出错 Error/新审批)→ 清除;
        // Finished 保持——轮次结束恰是「等你选」的时刻。本帧带新问时先清后设(覆盖)。
        let asked = ask_user_question_summary(provider, payload);
        if existed && changed && kind != SessionKind::Finished && asked.is_none() {
            entry.waiting_choice = None;
        }
        if let Some(q) = asked {
            entry.waiting_choice = Some(q);
        }
        // 文本提问启发式(轮终门控,2026-11-25):success result(→ Finished)且无结构化等待
        // 时,末段问句判定 → waiting_choice。清除走既有 kind 流转(下一轮首帧 Finished→Running)。
        if kind == SessionKind::Finished && entry.waiting_choice.is_none() {
            if let Some(q) = heuristic_q {
                entry.waiting_choice = Some(q);
            }
        }
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

/// AskUserQuestion 等「非审批的用户判断」信号提取(2026-11-25):assistant 帧带该工具的
/// tool_use → Some(问题摘要,input.questions[].question 宽松提取);其余帧 None。
/// claude 专属(codex 无此工具)。增量帧只有含该 block 的那帧命中。
fn ask_user_question_summary(provider: &str, payload: &Value) -> Option<String> {
    if provider != "claude" {
        return None;
    }
    if payload.get("kind").and_then(|v| v.as_str()) != Some("assistant") {
        return None;
    }
    let blocks = payload.get("message")?.get("content")?.as_array()?;
    for b in blocks {
        if b.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
            continue;
        }
        if b.get("name").and_then(|n| n.as_str()) != Some("AskUserQuestion") {
            continue;
        }
        let q = b
            .get("input")
            .and_then(|i| i.get("questions"))
            .and_then(|q| q.as_array())
            .and_then(|arr| arr.first())
            .and_then(|q| q.get("question"))
            .and_then(|q| q.as_str())
            .unwrap_or("AI 提问");
        return Some(truncate_chars(q.trim(), 120).to_string());
    }
    None
}

/// 等待关键字(2026-11-25 用户实测反馈:祈使等待「要不要恢复你拍板」「等你看完…再告诉我:
/// 是…还是…还是…」常**不带问号**)。**三组互斥计分**(组内多词不重复计,防「你来定」+
/// 「你定」子串虚高),与前端 `claudeStream.ts` 同口径。分组共证 ≥2 分才进 waiting_choice
/// (指挥台徽标高置信门槛);1 分仅前端 pane 内提示行,不进全局触达。
const WAITING_KEYWORDS_DECIDE: &[&str] = &[
    "你拍板", "你来定", "你定", "你决定", "你定夺", "你来选", "你选", "你挑", "任选", "听你的", "看你的", "由你决定", "你选择",
];
const WAITING_KEYWORDS_REPLY: &[&str] = &["告诉我", "回复我", "跟我说", "说一声", "回个话"];
const WAITING_KEYWORDS_CONFIRM: &[&str] = &[
    "要不要", "需不需要", "是否需要", "请确认", "请选择", "请指示", "等你确认", "等你决定", "等你指示",
];
const WAITING_KEYWORDS_EN: &[&str] = &[
    "let me know", "your call", "you decide", "should i", "do you want", "which one",
];

/// 文本提问启发式(与前端 `claudeStream.ts detectTextQuestion` 同口径,2026-11-25):剥 ```
/// 围栏代码块后,末段(最后非空段落,尾部 400 字符)**分组共证计分**:①问号组(以 ？/?
/// 收尾或末句含问号);②拍板组;③回复组;④确认组+英文(小写);⑤枚举组(「还是」≥2 次)。
/// 每组 1 分(互斥,防子串虚高)。返回 (末段摘要, 分数):**≥2 分才判等待**(主观内容阈值
/// 控制,2026-11-25 用户:「非常主观性的内容,判断的阈值得控制」——指挥台全局触达要高
/// 置信;1 分的低置信仅前端 pane 内提示行可见)。**轮终门控由调用方保证**。
fn detect_text_question(full: &str) -> Option<(String, u32)> {
    // 剥 ``` 围栏(行状态机;行内 `code` 不剥——行内问号后通常还有正文,末段锚定下无影响)。
    let mut stripped = String::with_capacity(full.len());
    let mut in_fence = false;
    for line in full.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            stripped.push_str(line);
            stripped.push('\n');
        }
    }
    // 末段 = 最后一个非空段落(空行分段,段内连续非空行合并)。
    let mut paras: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in stripped.lines() {
        if line.trim().is_empty() {
            if !cur.trim().is_empty() {
                paras.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        } else {
            cur.push_str(line);
            cur.push('\n');
        }
    }
    if !cur.trim().is_empty() {
        paras.push(cur);
    }
    let tail_para = paras.last()?;
    // 尾部 400 字符(问句在尾;chars 切防劈开 UTF-8)。
    let chars: Vec<char> = tail_para.chars().collect();
    let start = chars.len().saturating_sub(400);
    let trimmed: String = chars[start..].iter().collect();
    let trimmed = trimmed.trim();
    if trimmed.chars().count() < 2 {
        return None;
    }
    let summary = || truncate_chars(trimmed, 120).to_string();
    let mut score: u32 = 0;
    // ①问号组:收尾或末句(「……可以吗?谢谢」类按句读切分取最后一句)。
    if trimmed.ends_with('？') || trimmed.ends_with('?') {
        score += 1;
    } else {
        let last_sentence = trimmed
            .split(|c: char| "。！.!?？;;\n".contains(c))
            .filter(|s| !s.trim().is_empty())
            .last();
        if last_sentence.is_some_and(|s| s.contains('?') || s.contains('？')) {
            score += 1;
        }
    }
    // ②拍板组 / ③回复组 / ④确认组+英文(小写):组内任一命中即 1 分(互斥分组)。
    if WAITING_KEYWORDS_DECIDE.iter().any(|k| trimmed.contains(k)) {
        score += 1;
    }
    if WAITING_KEYWORDS_REPLY.iter().any(|k| trimmed.contains(k)) {
        score += 1;
    }
    let lower = trimmed.to_lowercase();
    if WAITING_KEYWORDS_CONFIRM.iter().any(|k| trimmed.contains(k))
        || WAITING_KEYWORDS_EN.iter().any(|k| lower.contains(k))
    {
        score += 1;
    }
    if score == 0 {
        return None; // 零分组命中:不是等待。
    }
    // ⑤枚举组:「还是」≥2 次(「是 A 还是 B,还是 C」,句号收尾也在等)。
    if trimmed.split("还是").count() - 1 >= 2 {
        score += 1;
    }
    // 主观内容阈值:≥2 分才进 waiting_choice(指挥台徽标);1 分留给前端 pane 内提示。
    if score < 2 {
        return None;
    }
    Some((summary(), score))
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
