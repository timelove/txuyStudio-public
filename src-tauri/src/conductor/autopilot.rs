//! autopilot:claude 工具调用**代批**(本地规则,零 token)。
//!
//! 背景:投递启动的 claude 会话默认 `acceptEdits`(只自动放行文件编辑),Bash 等工具
//! 仍要人批;而本机 claude 走 glm 代理 + 默认 sandbox 拦 Bash 写命令,指挥台投递出去
//! 的任务几乎必然第一个 Bash 就卡住。2026-11-12 用户拍板:**conductor 自己判断**——
//! 反转设计文档 §11.4「代批禁令」,但保留分级。
//!
//! P2a(2026-11-16,自动驾驶二期):硬编码二值白名单升级为**可配置三级分级表**
//! (auto/confirm/deny,判定与默认表见 [`super::permissions`];deny 不自动拒绝,
//! 只在流水/卡片上标高危)。本文件只留「判定 → 分派 → 记流水」的管道。
//!
//! 接法:claude 的 `PermissionRequest` 事件本就广播在 AiBus 上(带 request_id /
//! tool_name / input),`events::process_frame` 见到 WaitingApproval 就调
//! [`maybe_auto_approve`];判定 auto 时经 `respond_claude_permission_raw`
//! (不登记人触达)回 control_response,**CLI 自己执行工具并续跑该轮**——因为不产生
//! 「被拒」文案,主窗口那张确认卡根本不会挂出来,只有 confirm/deny 时才弹给人。
//!
//! 边界(与四条边界对齐):
//! - 规则全本地:只看法工具名 + 命令串,不调 LLM(LLM 判命令安全性不可靠且烧 token);
//! - 决策权在人:confirm/deny 转人弹卡(计划必须人看),且每次判定在指挥窗留可审计流水。

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{now_ms, ConductorData, ConductorState};
use super::permissions::{self, Level};

/// 代批流水条目(运行期记忆,不落盘;指挥窗概览显示最近若干条)。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoApproveLog {
    pub tab_id: String,
    pub project_id: String,
    pub tool_name: String,
    /// 人读摘要(Bash 取命令串截断;其余取 input 的 command/file_path/pattern)。
    pub summary: String,
    /// "allow" | "escalate"(兼容字段:allow ⟺ level=auto)。
    pub verdict: String,
    /// 三级:"auto" | "confirm" | "deny"(前端按级着色:绿/琥珀/红)。
    pub level: String,
    /// 命中来源:"default"(内置表) | "custom"(自定义规则)。
    pub source: String,
    /// confirm/deny 的原因(命中哪条规则/危险模式);auto 为 None。
    pub reason: Option<String>,
    pub ms: i64,
}

/// 流水保留条数(概览只取前 20,这里多留点供排查)。
const LOG_CAP: usize = 100;
/// 命令摘要截断长度(UI 单行)。
const SUMMARY_MAX: usize = 120;
/// 已处理 request_id 去重窗(broadcast 不重放,这是防御性冗余)。
const HANDLED_CAP: usize = 128;

/// 从 PermissionRequest payload 取人读摘要(Bash 用命令串,其余找常见路径字段)。
fn summarize(tool_name: &str, input: &serde_json::Value) -> String {
    let raw = if tool_name == "Bash" {
        input.get("command").and_then(|v| v.as_str()).map(str::to_string)
    } else {
        ["file_path", "path", "pattern", "notebook_path", "query", "prompt"]
            .iter()
            .find_map(|k| input.get(*k).and_then(|v| v.as_str()).map(str::to_string))
    }
    .unwrap_or_default();
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= SUMMARY_MAX {
        collapsed
    } else {
        let head: String = collapsed.chars().take(SUMMARY_MAX).collect();
        format!("{head}…")
    }
}

/// 记一条流水 + 标记 request 已处理。短锁,不跨 await。
fn record(data: &mut ConductorData, entry: AutoApproveLog, request_id: &str) {
    data.auto_approvals.push_front(entry);
    while data.auto_approvals.len() > LOG_CAP {
        data.auto_approvals.pop_back();
    }
    if !request_id.is_empty() {
        data.handled_requests.push_front(request_id.to_string());
        while data.handled_requests.len() > HANDLED_CAP {
            data.handled_requests.pop_back();
        }
    }
}

/// AiBus 收到审批请求帧时调用(claude `PermissionRequest` / codex `ApprovalRequested`,
/// 2026-11-18 补 codex 通路):总闸关闭 / 已处理过 → 直接返回不插手;判定 auto → 回审批
/// 响应(CLI 自己执行工具续跑该轮);confirm/deny → 只记流水不插手,前端照旧弹卡、
/// 指挥窗照旧提醒「等待审批」(deny 的红卡强警示随 P2b)。作用域 = 总闸全域(指挥台
/// 任务与手动会话同口径,2026-11-19 恢复,见函数内注释)。
pub async fn maybe_auto_approve(
    app: &AppHandle,
    provider: &str,
    project_id: &str,
    tab_id: &str,
    payload: &serde_json::Value,
) {
    let Some(state) = app.try_state::<ConductorState>() else { return };
    // 请求三要素按 provider 取形:claude 平铺(requestId/toolName/input);codex 包一层
    // `request{key,method,params}`——key 即响应路由(等价 requestId),方法映射工具名:
    // exec 命令 → Bash 过危险模式全套;patch 写文件 → Edit 对齐 claude acceptEdits 档;
    // 其余用方法原名走「白名单外 confirm」(managed 会话升宽限 auto 弹卡倒计时)。
    // params 作判定输入(execCommandApproval 的 command 字段与 Bash 同形,summarize 兼容)。
    let (request_id, tool_name, input) = if provider == "codex" {
        let req = payload.get("request").cloned().unwrap_or(serde_json::Value::Null);
        let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let lower = method.to_ascii_lowercase();
        let tool = if lower.contains("exec") {
            "Bash".to_string()
        } else if lower.contains("patch") {
            "Edit".to_string()
        } else {
            method.clone()
        };
        (
            req.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            tool,
            req.get("params").cloned().unwrap_or(serde_json::Value::Null),
        )
    } else {
        (
            payload
                .get("requestId")
                .or_else(|| payload.get("request_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            payload.get("toolName").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            payload.get("input").cloned().unwrap_or(serde_json::Value::Null),
        )
    };

    // 开关 + 去重 + 取分级表/权限上限:一次短锁(rules 后续判定要读 config,克隆出锁)。
    // 作用域 = 总闸全开(2026-11-19 用户澄清:2026-11-16 反馈的是「自动批了没任何
    // 提示」,修法是宽限弹卡(见 auto_approve_delay_ms),**不是**收窄作用域——曾经
    // 误记成「人自己的 pane 不代批」并收窄过,本日恢复:指挥台任务与人手动聊的
    // pane 同一判定,人在宽限内随时可接管)。
    let rules;
    let ceiling;
    let delay_ms;
    {
        let Ok(data) = state.0.lock() else { return };
        if !data.config.auto_approve_tools {
            return;
        }
        if !request_id.is_empty() && data.handled_requests.iter().any(|r| r == &request_id) {
            return;
        }
        rules = data.config.permission_rules.clone();
        delay_ms = data.config.auto_approve_delay_ms;
        // P2c 权限上限:该 tab 有待验收任务且派活带 ceiling → 收紧判定。上限语义 =
        // 限制放行强度(deny 最严),取「更严」一档:Level 序 Auto<Confirm<Deny,
        // max 即收紧(ceiling=confirm 时只读工具也弹卡;deny 时 confirm 带高危标)。
        // 生效窗口 = 登记起 → 验收结算止(终态清账后 pending 不在,自动收回)。
        ceiling = data
            .pending_verdicts
            .iter()
            .find(|p| p.project_id == project_id && p.tab_id == tab_id)
            .and_then(|p| p.permission_ceiling);
    }

    let mut j = permissions::judge(&tool_name, &input, &rules);
    let mut ceiling_tightened = false;
    if let Some(c) = ceiling {
        if c > j.level {
            j.level = c;
            j.reason = Some(j.reason.unwrap_or_else(|| {
                format!("任务权限上限({} 级)收紧", c.as_str())
            }));
            j.source = "task_ceiling";
            ceiling_tightened = true;
        }
    }
    // 任务期 confirm 升宽限 auto(2026-11-17 幕3反馈「机器投递的拆步任务还要我手动批,
    // 批晚了任务就停」;2026-11-19 作用域恢复全域后手动会话同口径):confirm 级
    // (白名单外工具/ExitPlanMode/空命令)不转人硬停——照宽限模式弹卡等接管,到点自动
    // 放行;deny 仍真拦(危险模式),ceiling 显式收紧(人限制了放行强度)仍真拦,机器
    // 不越权。流水 reason 保留原始 confirm 原因,UI 显示「已自动批」+ 宽限倒计时
    // (conductor-verdict level=auto 自带)。
    if j.level == Level::Confirm && !ceiling_tightened {
        j.level = Level::Auto;
    }
    let summary = summarize(&tool_name, &input);
    let verdict_str = if j.level == Level::Auto { "allow" } else { "escalate" }.to_string();
    // reason 提前克隆:record 会 move 进流水,后面 emit 事件还要用(P2b pane 警示)。
    let reason_out = j.reason.clone();

    // 判定即占去重窗(重复帧不再触发);auto+宽限模式先登记 pending(卡照常弹)。
    {
        let Ok(mut data) = state.0.lock() else { return };
        if !request_id.is_empty() {
            data.handled_requests.push_front(request_id.to_string());
            while data.handled_requests.len() > HANDLED_CAP {
                data.handled_requests.pop_back();
            }
        }
        if j.level == Level::Auto && delay_ms > 0 {
            data.auto_pending.insert(request_id.clone());
        }
    }

    if j.level == Level::Auto && delay_ms > 0 {
        // 宽限模式(2026-11-17 用户要求「先弹卡再自动选」):不立即放行,原生卡照常
        // 挂出,广播 auto 倒计时(pane 卡上显示「N 秒后自动批准,可直接选择」);
        // 宽限内人手动选 → 前端 conductor_auto_approve_cancel 撤销;到期无人接管
        // 才由 [`delayed_auto_allow`] 代发 allow 并记流水。人先批的不进代批流水
        // (那是人的选择,不是机器批的)。
        {
            use tauri::Emitter;
            let _ = app.emit(
                "conductor-verdict",
                serde_json::json!({
                    "tabId": tab_id,
                    "requestId": request_id,
                    "level": "auto",
                    "reason": reason_out,
                    "delayMs": delay_ms,
                }),
            );
        }
        let task_app = app.clone();
        let task_provider = provider.to_string();
        let task_project = project_id.to_string();
        let task_tab = tab_id.to_string();
        let task_request = request_id.clone();
        let task_tool = tool_name.clone();
        let task_input = input.clone();
        let task_reason = j.reason.clone();
        let task_source = j.source.to_string();
        tauri::async_runtime::spawn(async move {
            delayed_auto_allow(
                task_app,
                task_provider,
                task_project,
                task_tab,
                task_request,
                task_tool,
                summary,
                task_input,
                task_reason,
                task_source,
                delay_ms,
            )
            .await;
        });
        return;
    }

    let mut acted = false;
    if j.level == Level::Auto {
        // delay=0 的旧行为:立即放行(raw 入口,不登记人触达)。
        match approve_request(app, provider, project_id, tab_id, &request_id, &input).await {
            Ok(()) => acted = true,
            Err(e) => log::warn!(
                "conductor autopilot: auto-approve write failed (tab {tab_id}, req {request_id}): {e}"
            ),
        }
    }

    {
        let Ok(mut data) = state.0.lock() else { return };
        record(
            &mut data,
            AutoApproveLog {
                tab_id: tab_id.to_string(),
                project_id: project_id.to_string(),
                tool_name: tool_name.clone(),
                summary,
                verdict: verdict_str,
                level: j.level.as_str().to_string(),
                source: j.source.to_string(),
                reason: j.reason,
                ms: now_ms(),
            },
            &request_id,
        );
    }

    if j.level == Level::Auto && acted {
        log::info!(
            "conductor autopilot: auto-approved {} (tab {tab_id}, project {project_id})",
            tool_name
        );
    }

    // deny / ceiling 收紧转人(P2b):广播判定级给目标 pane,审批卡按级强警示
    // (deny 红边高危标);pane 侧 TTL 兜底,人处理完卡即消失,无需回收消息。
    // 2026-11-17 幕3反馈「审批卡弹出代批零记录无从诊断」:补日志留现场
    // (confirm 已升宽限 auto,这里只剩真危险/人显式收紧,每条都值得看)。
    if j.level != Level::Auto {
        log::info!(
            "conductor autopilot: escalated {} to human (tab {tab_id}, project {project_id}, level {}, reason {:?})",
            tool_name,
            j.level.as_str(),
            reason_out
        );
        use tauri::Emitter;
        let _ = app.emit(
            "conductor-verdict",
            serde_json::json!({
                "tabId": tab_id,
                "requestId": request_id,
                "level": j.level.as_str(),
                "reason": reason_out,
            }),
        );
    }
}

/// 代发 allow(raw 入口,不登记人触达——机器批的不算人碰过,否则占用锁被无限续期):
/// claude 回 control_response;codex 回 app-server 审批 result(accept 一次,for_session
/// 不用——机器代批只放本条,会话级放权是人的决定)。
async fn approve_request(
    app: &AppHandle,
    provider: &str,
    project_id: &str,
    tab_id: &str,
    request_id: &str,
    input: &serde_json::Value,
) -> Result<(), String> {
    if provider == "codex" {
        crate::codex::app_server::respond_approval(app, project_id, tab_id, request_id, true, false).await
    } else {
        let claude_state = app.state::<crate::claude::ClaudeRegistry>();
        crate::claude::commands::respond_claude_permission_raw(
            app.clone(),
            claude_state,
            project_id.to_string(),
            tab_id.to_string(),
            request_id.to_string(),
            "allow".to_string(),
            Some(input.clone()),
            None,
        )
        .await
    }
}

/// auto 宽限倒计时到期:人未接管(仍在 auto_pending)→ 代发 allow + 记流水;
/// 人已响应(cancel 移除)→ 直接退出,不写 stdin、不记流水。
async fn delayed_auto_allow(
    app: AppHandle,
    provider: String,
    project_id: String,
    tab_id: String,
    request_id: String,
    tool_name: String,
    summary: String,
    input: serde_json::Value,
    // 原始判据(confirm 升级场景保留原 reason,如「白名单外工具」),流水可审计。
    reason: Option<String>,
    // 原始来源(confirm 升级保留 "default"/"custom",真 auto 传 "default")。
    source: String,
    delay_ms: u64,
) {
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    let Some(state) = app.try_state::<ConductorState>() else { return };
    {
        let Ok(mut data) = state.0.lock() else { return };
        // remove 返回 false = 人已手动响应(cancel 撤销),跳过。
        if !data.auto_pending.remove(&request_id) {
            return;
        }
    }
    // tab_id 既要进流水(struct move)又要写日志,提前留一份。
    let tab_id_log = tab_id.clone();
    match approve_request(&app, &provider, &project_id, &tab_id, &request_id, &input).await {
        Ok(()) => {
            // 落定留痕广播(2026-11-18 用户:「自动批准后消息流中的批准卡消失」):
            // 审批卡随 CLI 续跑被冲走,-pane 侧靠这条事件在坞下挂淡绿幽灵行,
            // 批了什么工具/命令仍可查(60s 淡出)。字段先克隆,record 要 move。
            {
                use tauri::Emitter;
                let _ = app.emit(
                    "conductor-auto-approved",
                    serde_json::json!({
                        "tabId": tab_id_log,
                        "requestId": request_id,
                        "toolName": tool_name,
                        "summary": summary,
                    }),
                );
            }
            if let Ok(mut data) = state.0.lock() {
                record(
                    &mut data,
                    AutoApproveLog {
                        tab_id,
                        project_id,
                        tool_name,
                        summary,
                        verdict: "allow".to_string(),
                        level: "auto".to_string(),
                        source,
                        reason,
                        ms: now_ms(),
                    },
                    &request_id,
                );
            }
            log::info!(
                "conductor autopilot: auto-approved after {delay_ms}ms grace (tab {tab_id_log})"
            );
        }
        Err(e) => log::warn!(
            "conductor autopilot: delayed auto-approve write failed (tab {tab_id_log}, req {request_id}): {e}"
        ),
    }
}
