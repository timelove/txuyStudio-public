//! pipeline:孵化流水线(四期 P4a,设计 conductor-autopilot-phase4-plan-v1.md)
//! + 投递占用排队补投(2026-11-17 用户:「检测到 AI pane 执行中,不应只转建议卡,
//! 应该等运行完成自动塞入」)。
//!
//! 「无人指挥的最后一环」:三期拆步跑完(finished)即终点,四期补上**自动领下一件活**
//! ——计划 finished 后,从孵化里领取 targets 显式命中该会话的最早 pending 条目,
//! 复用一期验收登记投递(与 `conductor_inbox_dispatch` 同链:登记 pending + ceiling
//! 沿用条目配置)。领取边界 = 人当初选的目标,不做智能路由。
//!
//! 闸门(设计 §1):
//! - 开关 `config.pipeline`(默认关);mute 项目不领取;
//! - 同会话串行:该会话仍有进行中计划(Running/Paused)或待验收 pending → 不领;
//! - 占用锁让位:人 N 分钟内碰过该会话 → 本次不领(错过的机会不追);
//! - 失败即停:发送失败 → 回滚条目 + 决策流出卡留人,不自动跳过领下一条(错误不传播)。
//! 循环条目不参与(repeat_enabled 的条目有自己的节奏,混流会抢会话)。
//!
//! 排队补投(`dispatch_queued`):手动投递被占用锁全拦时(`config.queue_when_occupied`,
//! 默认开)条目转 Queued,该会话空闲终态(Finished/Idle,验收链走完后)自动补投——
//! 排队是**人已确认意图的延迟执行**,补投不再查占用锁(否则人在场就永远投不出);
//! 但与验收回环/P4a 领取保持同会话串行(有 pending 或进行中计划就等下个终态)。

use tauri::{AppHandle, Manager};

use super::guard::{self, DispatchGate};
use super::inbox::{
    push_decision, DecisionKind, DecisionRecord, DecisionSource, DecisionStatus, InboxStatus,
};
use super::orchestrate::PlanStatus;
use super::{attention_count, emit_event, is_muted, now_ms, register_verdict_locked, save_disk, snapshot_disk, truncate_chars, ConductorState, SessionKind};

/// 计划 finished 钩子(orchestrate::advance_after_success 终态分支 spawn 调用,锁外跑)。
/// 不阻塞验收链;领取失败只回滚+出卡,不影响已 finished 的计划。
pub async fn on_plan_finished(app: &AppHandle, project_id: &str, tab_id: &str) {
    let Some(state) = app.try_state::<ConductorState>() else { return };
    let now = now_ms();

    // 短锁:开关 + mute + 同会话串行 + 占用锁 + 选条目 + 预登记(纯同步,一次锁完)。
    // 预先标 Dispatched / 登记 pending 是**占坑**:发送在锁外,不占坑会被同帧并发的
    // 其他钩子重复领取。发送失败再回滚。
    // P4b 协调:无候选任务时返回 Continue 原料(goal+done 摘要),由锁外续段判定接手
    // ——锁守卫绝不能跨 await,故分支结果在锁内裁决、动作在锁外执行。
    enum Pick {
        /// 已占坑待发送(条目文本)。
        Send(String),
        /// 无候选,带 finished 计划原料走 P4b 续段判定。
        Continue { goal: String, done: String },
        /// 什么都不做(开关关/让位/无原料)。
        None,
    }
    let pick = {
        let Ok(mut data) = state.0.lock() else { return };
        if !data.config.pipeline || is_muted(&data, project_id) {
            return;
        }
        // 同会话仍有进行中计划或待验收 → 不领(串行;本计划此刻已标 Finished 不自撞,
        // 并发两条计划同帧收尾靠这条互斥)。
        if data
            .plans
            .iter()
            .any(|p| {
                p.target.project_id == project_id
                    && p.target.tab_id == tab_id
                    && matches!(p.status, PlanStatus::Running | PlanStatus::Paused)
            })
        {
            return;
        }
        if data
            .pending_verdicts
            .iter()
            .any(|p| p.project_id == project_id && p.tab_id == tab_id)
        {
            return;
        }
        // P4b 原料:刚 finished 的这条计划(goal + 已完成步摘要;锁内顺手取)。
        let plan_info = data
            .plans
            .iter()
            .find(|p| p.target.project_id == project_id && p.target.tab_id == tab_id && p.status == PlanStatus::Finished)
            .map(|p| {
                (
                    p.goal.clone(),
                    p.steps
                        .iter()
                        .map(|s| format!("✔ {}", s.text))
                        .collect::<Vec<_>>()
                        .join("\n"),
                )
            });
        if !matches!(
            guard::check_dispatch(&data, project_id, tab_id, false, now),
            DispatchGate::Allow
        ) {
            // 占用锁内(人在场)或总闸关:让位不出卡(正常让位,非故障)。
            return;
        }
        // 候选:targets 显式命中该会话 + 一次性 pending 条目(循环条目不参与),
        // 创建时间最早的(inbox 新的在前,取末位命中)。
        let idx = data
            .inbox
            .iter()
            .rposition(|i| {
                i.status == InboxStatus::Pending
                    && !i.repeat_enabled
                    && i.targets
                        .iter()
                        .any(|t| t.project_id == project_id && t.tab_id == tab_id)
            });
        match idx {
            // P4a 无候选 → P4b(有 finished 原料才试,否则静默)。块尾 match 求值
            // ——不能用 return(那是函数级,会把 Pick 吐给 ())。
            None => match plan_info {
                Some((goal, done)) => Pick::Continue { goal, done },
                None => Pick::None,
            },
            Some(idx) => {
                let text = data.inbox[idx].text.clone();
                let ceiling = data.inbox[idx].permission_ceiling;
                let acceptance = data.inbox[idx].acceptance.clone();
                let item = &mut data.inbox[idx];
                item.status = InboxStatus::Dispatched;
                item.dispatch_count += 1;
                item.last_dispatch_ms = now;
                register_verdict_locked(&mut data, project_id, tab_id, &text, 0, ceiling, acceptance.as_deref());
                let disk = snapshot_disk(&data);
                drop(data);
                save_disk(app, &disk)
                    .map_err(|e| log::warn!("conductor: pipeline persist failed: {e}"))
                    .ok();
                Pick::Send(text)
            }
        }
    };

    let text = match pick {
        Pick::None => return,
        Pick::Continue { goal, done } => {
            maybe_continue_plan(app, &goal, &done, project_id, tab_id).await;
            return;
        }
        Pick::Send(text) => text,
    };

    // 锁外发送(会话按需启动/写 stdin 可能耗时)。
    match super::commands::send_to_session(app, project_id, tab_id, &text).await {
        Ok(()) => {
            log::info!("conductor pipeline: picked next task (tab {tab_id})");
            let count = state.0.lock().map(|d| attention_count(&d)).unwrap_or(0);
            emit_event(app, count, "inbox");
        }
        Err(e) => {
            // 失败即停:回滚占坑(条目回 pending 可人手重投;pending_verdict 撤销——
            // 没发出的活不该验收),出卡留人,不领下一条。
            let count = {
                let Ok(mut data) = state.0.lock() else { return };
                data.pending_verdicts.retain(|p| !(p.project_id == project_id && p.tab_id == tab_id && p.goal == text));
                if let Some(item) = data
                    .inbox
                    .iter_mut()
                    .find(|i| i.text == text && i.status == InboxStatus::Dispatched)
                {
                    item.status = InboxStatus::Pending;
                    item.dispatch_count = item.dispatch_count.saturating_sub(1);
                }
                push_decision(
                    &mut data.decisions,
                    DecisionRecord {
                        id: uuid::Uuid::new_v4().to_string(),
                        cycle_ms: now_ms(),
                        kind: DecisionKind::Suggestion,
                        summary: truncate_chars(&format!("流水线领取失败:{e}"), 120),
                        text: String::new(),
                        target_project_id: Some(project_id.to_string()),
                        target_session_id: Some(tab_id.to_string()),
                        payload: None,
                        used_memory_ids: Vec::new(),
                        source: DecisionSource::InboxDowngrade,
                        status: DecisionStatus::Proposed,
                        created_ms: now_ms(),
                    },
                );
                let c = attention_count(&data);
                let disk = snapshot_disk(&data);
                save_disk(app, &disk)
                    .map_err(|e| log::warn!("conductor: pipeline persist failed: {e}"))
                    .ok();
                c
            };
            emit_event(app, count, "decision");
        }
    }
}

/// P4b 续段判定(P4a 无候选任务时触发):大脑轻量判「总意图是否还需要下一段」,
/// 值得续 → 出**续段卡**(kind=suggestion,payload.planContinue=true 带 next_goal),
/// **半自动——人点接受才建新计划**,不点/拒绝不再问。与 P4a 互斥协调见上。
/// 大脑不可用/判定失败 → 静默放弃(续段是锦上添花,不配出错误卡)。
async fn maybe_continue_plan(
    app: &AppHandle,
    goal: &str,
    done_summary: &str,
    project_id: &str,
    tab_id: &str,
) {
    let Some(state) = app.try_state::<ConductorState>() else { return };
    // 总闸关 = LLM 环节全不出(与建议链同口径)。
    {
        let Ok(data) = state.0.lock() else { return };
        if !data.config.allow_orchestrator {
            return;
        }
    }
    let next_goal = match super::brain::plan_continue(app, goal, done_summary).await {
        Ok(Some(g)) => g,
        Ok(None) => return, // 大脑判已完成:不出卡不问
        Err(e) => {
            log::info!("conductor pipeline: plan_continue skipped: {e}");
            return;
        }
    };
    // 防重复:同目标已有未处理的续段卡就不叠(理论上 finished 只来一次,防御性)。
    let count = {
        let Ok(mut data) = state.0.lock() else { return };
        let dup = data.decisions.iter().any(|d| {
            d.status == DecisionStatus::Proposed
                && d.target_session_id.as_deref() == Some(tab_id)
                && d.payload
                    .as_ref()
                    .and_then(|p| p.get("planContinue"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
        });
        if dup {
            return;
        }
        push_decision(
            &mut data.decisions,
            DecisionRecord {
                id: uuid::Uuid::new_v4().to_string(),
                cycle_ms: now_ms(),
                kind: DecisionKind::Suggestion,
                summary: format!("拆步完成,智核建议续段:{}", truncate_chars(&next_goal, 60)),
                text: next_goal.clone(),
                target_project_id: Some(project_id.to_string()),
                target_session_id: Some(tab_id.to_string()),
                payload: Some(serde_json::json!({ "planContinue": true, "nextGoal": next_goal })),
                used_memory_ids: Vec::new(),
                source: DecisionSource::Brain,
                status: DecisionStatus::Proposed,
                created_ms: now_ms(),
            },
        );
        let c = attention_count(&data);
        let disk = snapshot_disk(&data);
        save_disk(app, &disk)
            .map_err(|e| log::warn!("conductor: persist failed: {e}"))
            .ok();
        c
    };
    emit_event(app, count, "decision");
}

/// 直投任务验收落定后的孵化领取(2026-11-18 用户:「验收失败后,就不走我的孵化
/// 任务了」):直投工作流没有「计划 finished」事件,流水线领取失去唯一触发点,
/// 孵化池 pending 永远没人领(拆步入口收敛后此缺口成主路径)。此处把领取触发扩到
/// 「直投任务 Finished + 验收落定后」——与 on_plan_finished 同口径(开关/mute/
/// 同会话串行/占用锁让位/领取边界 = targets 显式命中,一次性条目),无 P4b 续段
/// (无计划原料,续段是拆步链专属)。排在 dispatch_queued 之后:人点过「立即执行」
/// 的排队意图优先,排队投出登记 pv 后本函数的串行检查自然让位。
pub async fn pick_after_direct(app: &AppHandle, project_id: &str, tab_id: &str) {
    let Some(state) = app.try_state::<ConductorState>() else { return };
    let now = now_ms();
    // 短锁:开关 + mute + 同会话串行 + 占用锁 + 选条目 + 预占坑(纯同步一次锁完;
    // 发送在锁外,占坑防与终态钩子/排队补投并发双投,失败回滚)。
    let text = {
        let Ok(mut data) = state.0.lock() else { return };
        if !data.config.pipeline || is_muted(&data, project_id) {
            return;
        }
        // 同会话仍有进行中计划或待验收 → 不领(验收刚落定本应无 pv,防御性再查)。
        if data
            .pending_verdicts
            .iter()
            .any(|p| p.project_id == project_id && p.tab_id == tab_id)
            || data.plans.iter().any(|p| {
                p.target.project_id == project_id
                    && p.target.tab_id == tab_id
                    && matches!(p.status, PlanStatus::Running | PlanStatus::Paused)
            })
        {
            return;
        }
        if !matches!(
            guard::check_dispatch(&data, project_id, tab_id, false, now),
            DispatchGate::Allow
        ) {
            // 占用锁内(人在场)或总闸关:让位不出卡(正常让位,非故障)。
            return;
        }
        // 候选:targets 显式命中该会话 + 一次性 pending 条目(循环条目不参与),
        // 创建时间最早的(inbox 新的在前,取末位命中);无候选静默收工。
        let Some(idx) = data.inbox.iter().rposition(|i| {
            i.status == InboxStatus::Pending
                && !i.repeat_enabled
                && i.targets
                    .iter()
                    .any(|t| t.project_id == project_id && t.tab_id == tab_id)
        }) else {
            return;
        };
        let text = data.inbox[idx].text.clone();
        let ceiling = data.inbox[idx].permission_ceiling;
        let acceptance = data.inbox[idx].acceptance.clone();
        let item = &mut data.inbox[idx];
        item.status = InboxStatus::Dispatched;
        item.dispatch_count += 1;
        item.last_dispatch_ms = now;
        register_verdict_locked(&mut data, project_id, tab_id, &text, 0, ceiling, acceptance.as_deref());
        let disk = snapshot_disk(&data);
        drop(data);
        save_disk(app, &disk)
            .map_err(|e| log::warn!("conductor: pipeline persist failed: {e}"))
            .ok();
        text
    };

    // 锁外发送(会话按需启动/写 stdin 可能耗时)。
    if let Err(e) = super::commands::send_to_session(app, project_id, tab_id, &text).await {
        // 失败即停:回滚占坑(条目回 pending 可人手重投;pending_verdict 撤销——
        // 没发出的活不该验收),出卡留人,不领下一条(与 P4a 同口径)。
        let count = {
            let Ok(mut data) = state.0.lock() else { return };
            data.pending_verdicts.retain(|p| !(p.project_id == project_id && p.tab_id == tab_id && p.goal == text));
            if let Some(item) = data
                .inbox
                .iter_mut()
                .find(|i| i.text == text && i.status == InboxStatus::Dispatched)
            {
                item.status = InboxStatus::Pending;
                item.dispatch_count = item.dispatch_count.saturating_sub(1);
            }
            push_decision(
                &mut data.decisions,
                DecisionRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    cycle_ms: now_ms(),
                    kind: DecisionKind::Suggestion,
                    summary: truncate_chars(&format!("孵化领取失败:{e}"), 120),
                    text: String::new(),
                    target_project_id: Some(project_id.to_string()),
                    target_session_id: Some(tab_id.to_string()),
                    payload: None,
                    used_memory_ids: Vec::new(),
                    source: DecisionSource::InboxDowngrade,
                    status: DecisionStatus::Proposed,
                    created_ms: now_ms(),
                },
            );
            let c = attention_count(&data);
            let disk = snapshot_disk(&data);
            save_disk(app, &disk)
                .map_err(|e| log::warn!("conductor: pipeline persist failed: {e}"))
                .ok();
            c
        };
        emit_event(app, count, "decision");
        return;
    }
    log::info!("conductor pipeline: picked pending after direct task (tab {tab_id})");
    let count = state.0.lock().map(|d| attention_count(&d)).unwrap_or(0);
    emit_event(app, count, "inbox");
}

/// 排队补投(2026-11-17):`queue_when_occupied` 开时,手动投递被占用锁全拦的条目
/// 转 Queued,本函数在该会话**空闲终态**补投。触发点:
/// - events.rs 终态钩子(Finished,验收链 auto_verdict/auto_suggest 走完之后——
///   验收 rework 可能推回 Running,补投前再查一次当前 kind);
/// - events.rs Idle 流转(init/人中断——重启后排队条目在会话启动时补投);
/// - inbox_dispatch 排队落位后立即试一次(会话可能早已空闲,只是人触达在锁窗内)。
///
/// 与验收回环/P4a 领取同会话串行(有 pending 或进行中计划 → 静默等下个终态);
/// **不查占用锁**——排队是人已确认意图的延迟执行,再查就人在场永远投不出。
/// 多目标条目须全部目标空闲才投(条目整体语义,不半投)。失败即回滚(条目回
/// Pending 可人手重投)+ 出卡留人(与 P4a 同口径)。
pub async fn dispatch_queued(app: &AppHandle, project_id: &str, tab_id: &str) {
    let Some(state) = app.try_state::<ConductorState>() else { return };
    let now = now_ms();
    // 短锁:串行校验 + 空闲校验 + 选条目 + 占坑(纯同步一次锁完;发送在锁外,
    // 占坑防与终态钩子/P4a 并发双投,失败回滚)。
    let pick: Option<(String, Vec<super::inbox::InboxTarget>)> = {
        let Ok(mut data) = state.0.lock() else { return };
        // 同会话串行:验收没清账 / 进行中计划 → 等下个终态(与 on_plan_finished 同口径)。
        if data
            .pending_verdicts
            .iter()
            .any(|p| p.project_id == project_id && p.tab_id == tab_id)
            || data.plans.iter().any(|p| {
                p.target.project_id == project_id
                    && p.target.tab_id == tab_id
                    && matches!(p.status, PlanStatus::Running | PlanStatus::Paused)
            })
        {
            return;
        }
        // 触发 tab 此刻空闲(Finished/Idle;验收 rework / 人抢发都可能已推回 Running)。
        // sessions 按复合键查(项目内 tabId 撞名);条目各目标按各自 project 拼键。
        let idle_now = |key: &str| {
            data.sessions.get(key).is_some_and(|s| {
                matches!(s.kind, SessionKind::Finished | SessionKind::Idle)
            })
        };
        if !idle_now(&super::skey(project_id, tab_id)) {
            return;
        }
        // 最早的排队条目(inbox 新的在前,取末位 = 最早);全部目标空闲才投。
        let Some(idx) = data.inbox.iter().rposition(|i| {
            i.status == InboxStatus::Queued
                && i.targets.iter().any(|t| t.project_id == project_id && t.tab_id == tab_id)
        }) else {
            return;
        };
        if !data.inbox[idx]
            .targets
            .iter()
            .all(|t| idle_now(&super::skey(&t.project_id, &t.tab_id)))
        {
            return;
        }
        let text = data.inbox[idx].text.clone();
        let targets = data.inbox[idx].targets.clone();
        let ceiling = data.inbox[idx].permission_ceiling;
        let acceptance = data.inbox[idx].acceptance.clone();
        // 占坑:标 Dispatched + 逐目标登记 pending(没发出的活不该验收,失败回滚撤销)。
        let item = &mut data.inbox[idx];
        item.status = InboxStatus::Dispatched;
        item.dispatch_count += 1;
        item.last_dispatch_ms = now;
        for t in &targets {
            register_verdict_locked(&mut data, &t.project_id, &t.tab_id, &text, 0, ceiling, acceptance.as_deref());
        }
        let disk = snapshot_disk(&data);
        drop(data);
        save_disk(app, &disk)
            .map_err(|e| log::warn!("conductor: queue persist failed: {e}"))
            .ok();
        Some((text, targets))
    };
    let Some((text, targets)) = pick else { return };

    let mut last_err = String::new();
    for t in &targets {
        if let Err(e) = super::commands::send_to_session(app, &t.project_id, &t.tab_id, &text).await {
            last_err = e;
        }
    }
    if last_err.is_empty() {
        log::info!("conductor queue: dispatched queued item (tab {tab_id})");
        let count = state.0.lock().map(|d| attention_count(&d)).unwrap_or(0);
        emit_event(app, count, "inbox");
        return;
    }
    // 失败即停:回滚占坑(条目回 Pending 人手重投;pending 全撤销——没发出的活
    // 不该验收),出卡留人。多目标部分成功也整体回滚(与 P4a 口径一致:成功目标
    // 的消息已入会话但无验收登记,终态走常规建议,无害)。
    let count = {
        let Ok(mut data) = state.0.lock() else { return };
        data.pending_verdicts
            .retain(|p| !(p.project_id == project_id && p.tab_id == tab_id && p.goal == text));
        if let Some(item) = data
            .inbox
            .iter_mut()
            .find(|i| i.text == text && i.status == InboxStatus::Dispatched)
        {
            item.status = InboxStatus::Pending;
            item.dispatch_count = item.dispatch_count.saturating_sub(1);
        }
        push_decision(
            &mut data.decisions,
            DecisionRecord {
                id: uuid::Uuid::new_v4().to_string(),
                cycle_ms: now_ms(),
                kind: DecisionKind::Suggestion,
                summary: truncate_chars(&format!("排队补投失败:{last_err}"), 120),
                text: String::new(),
                target_project_id: targets.first().map(|t| t.project_id.clone()),
                target_session_id: Some(tab_id.to_string()),
                payload: None,
                used_memory_ids: Vec::new(),
                source: DecisionSource::InboxDowngrade,
                status: DecisionStatus::Proposed,
                created_ms: now_ms(),
            },
        );
        let c = attention_count(&data);
        let disk = snapshot_disk(&data);
        save_disk(app, &disk)
            .map_err(|e| log::warn!("conductor: queue persist failed: {e}"))
            .ok();
        c
    };
    emit_event(app, count, "decision");
}
