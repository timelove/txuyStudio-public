//! 多步编排(自动驾驶三期 P3a,设计见 conductor-autopilot-phase3-plan-v1):
//! 大脑把总意图拆成有序步骤,**按序逐步派发并复用一期验收回环**——
//! success 才发下一步,failed 即停(halted,后步 skipped),rework 原地重试
//! (rework_count 闸照常生效)。用户只下一句总意图,后面是多步自动接力。
//!
//! 状态机(设计 §2):
//! ```text
//! 建计划(拆步)→ 步0 派发+登记待验收
//!   ├─ verdict=success → 步置 done → 全 done 则 finished,否则发下一步
//!   ├─ verdict=rework  → 原地重发当前步(一期 rework_count 闸生效,超闸留人)
//!   ├─ verdict=failed  → 步置 failed → 后步全 skipped → halted(失败即停,不自动跳步)
//!   └─ 挂起(大脑不可用)→ pending 保留,下次终态补判;暂停时 success 只记步不推进
//! ```
//!
//! 防失控闸门(§5,硬编码保守值):同时 running ≤2 / 单计划 ≤8 步 / 仅用户显式
//! 「拆步执行」入口触发 / 派活目标被 mute → 建计划拒绝。暂停/终止/改指令重发是
//! 人的控制面(命令见 commands.rs conductor_plan_control / conductor_plan_retry)。
//!
//! 与一期/二期的关系:每步登记走 `register_verdict_locked`(ceiling 随计划统一带上,
//! P2c 的 judge 收紧链直接生效);终态钩子在 commands::auto_verdict 内结算验收并调
//! [`advance_after_success`] / [`halt_after_failure`] 推进编排。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::inbox::InboxTarget;
use super::permissions::Level;
use super::{now_ms, save_disk, snapshot_disk, ConductorState};

/// 同时 running 的编排上限(防失控闸门)。
pub const MAX_ACTIVE_PLANS: usize = 2;
/// 单计划步数上限。
pub const MAX_STEPS: usize = 8;
/// plans 持久化条数上限(终态保留供回看,超限挤最旧)。
pub const PLANS_CAP: usize = 20;

/// 步状态。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    /// 待发(前一步 success 后推进到它)。
    Queued,
    /// 已派发,等终态验收。
    Running,
    /// 验收通过。
    Done,
    /// 验收失败(计划在此步 halted)。
    Failed,
    /// 失败步之后的步(计划停了,不再发)。
    Skipped,
}

/// 计划状态。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    /// 自动推进中(逐步派发 + 验收)。
    Running,
    /// 人暂停(success 只记步,不发下一步);resume 后从断点续跑。
    Paused,
    /// 失败即停 / 人工终止。后步 skipped,可 retry 从失败步续跑。
    Halted,
    /// 全步 done,自然完成。
    Finished,
}

/// 单步。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: String,
    /// 本步指令原文(发给目标会话)。
    pub text: String,
    pub status: StepStatus,
    pub dispatched_ms: i64,
    /// 终态判定回填("success"/"failed"/"rework");None = 未到终态。
    #[serde(default)]
    pub verdict: Option<String>,
}

/// 编排计划(持久化在 conductor.json `plans`,serde default 零迁移)。
/// 整计划同一目标会话(编排拆的是单会话内的拆步任务;跨目标 DAG 明确不做)。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRecord {
    pub id: String,
    /// 用户总意图原文。
    pub goal: String,
    /// 派活目标。
    pub target: InboxTarget,
    /// 权限上限(整计划统一;None = 不限):随每步登记进 pending,judge 收紧链
    /// (P2c)自动生效;验收结算收回。
    pub permission_ceiling: Option<Level>,
    pub steps: Vec<PlanStep>,
    pub status: PlanStatus,
    /// halted 时的原因(第 N 步 failed: ... / 人工终止)。
    pub halt_reason: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

impl PlanRecord {
    /// 当前步下标:第一个 Running,否则第一个 Queued;None = 无(全终态)。
    /// 由步状态推导(不存游标字段,防状态漂移)。
    pub fn current_idx(&self) -> Option<usize> {
        self.steps
            .iter()
            .position(|s| s.status == StepStatus::Running)
            .or_else(|| self.steps.iter().position(|s| s.status == StepStatus::Queued))
    }

    /// 是否全部步 done(自然完成)。
    pub fn all_done(&self) -> bool {
        self.steps.iter().all(|s| s.status == StepStatus::Done)
    }
}

/// 建计划(拆步结果 → PlanRecord;锁外纯函数)。status 起步 Running,首步 Queued。
pub fn build_plan(goal: &str, target: InboxTarget, ceiling: Option<Level>, step_texts: Vec<String>) -> PlanRecord {
    let now = now_ms();
    PlanRecord {
        id: uuid::Uuid::new_v4().to_string(),
        goal: goal.to_string(),
        target,
        permission_ceiling: ceiling,
        steps: step_texts
            .into_iter()
            .map(|text| PlanStep {
                id: uuid::Uuid::new_v4().to_string(),
                text,
                status: StepStatus::Queued,
                dispatched_ms: 0,
                verdict: None,
            })
            .collect(),
        status: PlanStatus::Running,
        halt_reason: None,
        created_ms: now,
        updated_ms: now,
    }
}

/// 锁内收尾:保存 plans + 挤掉最旧终态计划。调用方持有锁,返回是否需要锁外落盘。
fn prune_and_snapshot(data: &mut super::ConductorData) -> super::ConductorDisk {
    while data.plans.len() > PLANS_CAP {
        // 终态优先挤;全 running 时挤 created_ms 最旧(防御性,正常到不了)。
        let victim = data
            .plans
            .iter()
            .position(|p| matches!(p.status, PlanStatus::Finished | PlanStatus::Halted))
            .unwrap_or_else(|| {
                data.plans
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, p)| p.created_ms)
                    .map(|(i, _)| i)
                    .unwrap_or(0)
            });
        data.plans.remove(victim);
    }
    snapshot_disk(data)
}

/// 锁外落盘(与 commands 各保存点同口径:失败只 warn 不阻断)。
fn persist(app: &AppHandle, disk: super::ConductorDisk) {
    save_disk(app, &disk)
        .map_err(|e| log::warn!("conductor: plan persist failed: {e}"))
        .ok();
}

/// 派发指定步:锁内取步文本并标 Running → 锁外 send → 锁内登记 pending(带计划
/// 链接与 ceiling)→ 落盘。发送失败:步 Failed + 计划 Halted(与验收 failed 同径)。
/// 计划不存在/状态非 Running/目标被 mute → 不动,Ok 返回(调用方不重试)。
pub async fn dispatch_step(app: &AppHandle, plan_id: &str, step_idx: usize) -> Result<(), String> {
    let Some(state) = app.try_state::<ConductorState>() else {
        return Err("conductor state missing".to_string());
    };

    // 1) 锁内:校验 + 标 Running + 落盘。
    let (text, target, ceiling) = {
        let Ok(mut data) = state.0.lock() else { return Ok(()) };
        // 先只读取出目标项目判断 mute(避免与 plans 可变借用冲突)。
        let plan_project = data.plans.iter().find(|p| p.id == plan_id).map(|p| p.target.project_id.clone());
        if plan_project.as_deref().map(|pid| super::is_muted(&data, pid)).unwrap_or(false) {
            if let Some(plan) = data.plans.iter_mut().find(|p| p.id == plan_id) {
                plan.status = PlanStatus::Paused;
                plan.halt_reason = Some("目标项目已静音,编排暂停".to_string());
                plan.updated_ms = now_ms();
            }
            let disk = prune_and_snapshot(&mut data);
            drop(data);
            persist(app, disk);
            super::emit_event(app, 0, "decision");
            return Ok(());
        }
        let Some(plan) = data.plans.iter_mut().find(|p| p.id == plan_id) else {
            return Ok(());
        };
        if plan.status != PlanStatus::Running {
            return Ok(());
        }
        let Some(step) = plan.steps.get_mut(step_idx) else {
            return Ok(());
        };
        if step.status != StepStatus::Queued {
            return Ok(());
        }
        step.status = StepStatus::Running;
        step.dispatched_ms = now_ms();
        plan.updated_ms = now_ms();
        let text = step.text.clone();
        let target = plan.target.clone();
        let ceiling = plan.permission_ceiling;
        let disk = prune_and_snapshot(&mut data);
        drop(data);
        persist(app, disk);
        (text, target, ceiling)
    };

    // 2) 锁外发送(目标未启动时 send_to_session 自动拉起)。
    let sent = super::commands::send_to_session(app, &target.project_id, &target.tab_id, &text).await;

    // 3) 锁内:登记待验收(带计划链接;ceiling 收紧链随 pending 生效)或失败停。
    let Ok(mut data) = state.0.lock() else { return Ok(()) };
    match sent {
        Ok(()) => {
            // 计划步无验收标准来源(步文即目标;计划入口已收敛,续段低频),acceptance = None。
            super::register_verdict_locked(
                &mut data,
                &target.project_id,
                &target.tab_id,
                &text,
                0,
                ceiling,
                None,
            );
            // 本步刚标 Running,current_idx 即它;先只读取 step id 再回填 pv(避免借用冲突)。
            let sid = data
                .plans
                .iter()
                .find(|p| p.id == plan_id)
                .and_then(|p| p.current_idx().and_then(|idx| p.steps.get(idx)))
                .map(|s| s.id.clone());
            if let Some(pv) = data
                .pending_verdicts
                .iter_mut()
                .find(|p| p.project_id == target.project_id && p.tab_id == target.tab_id)
            {
                pv.plan_id = Some(plan_id.to_string());
                pv.step_id = sid;
            }
            log::info!("conductor: plan {plan_id} step {step_idx} dispatched ({} chars)", text.chars().count());
        }
        Err(e) => {
            if let Some(plan) = data.plans.iter_mut().find(|p| p.id == plan_id) {
                if let Some(step) = plan.steps.get_mut(step_idx) {
                    step.status = StepStatus::Failed;
                    step.verdict = Some("failed".to_string());
                }
                for s in plan.steps.iter_mut().skip(step_idx + 1) {
                    if s.status == StepStatus::Queued {
                        s.status = StepStatus::Skipped;
                    }
                }
                plan.status = PlanStatus::Halted;
                plan.halt_reason = Some(super::truncate_chars(&format!("第 {} 步发送失败:{e}", step_idx + 1), 120));
                plan.updated_ms = now_ms();
            }
            log::warn!("conductor: plan {plan_id} step {step_idx} send failed, halted: {e}");
        }
    }
    let disk = prune_and_snapshot(&mut data);
    drop(data);
    persist(app, disk);
    super::emit_event(app, 0, "decision");
    Ok(())
}

/// 验收 success 后推进(终态钩子调用):步置 Done → 全 done 则 Finished;
/// 否则计划仍 Running 时派发下一 Queued 步(暂停中只记步,不推进——resume 续跑)。
pub async fn advance_after_success(app: &AppHandle, plan_id: &str, step_id: &str) {
    let Some(state) = app.try_state::<ConductorState>() else { return };
    let next_idx = {
        let Ok(mut data) = state.0.lock() else { return };
        let Some(plan) = data.plans.iter_mut().find(|p| p.id == plan_id) else { return };
        if let Some(step) = plan.steps.iter_mut().find(|s| s.id == step_id) {
            step.status = StepStatus::Done;
            step.verdict = Some("success".to_string());
        }
        plan.updated_ms = now_ms();
        if plan.all_done() {
            plan.status = PlanStatus::Finished;
            plan.halt_reason = None;
            log::info!("conductor: plan {plan_id} finished");
            let target = plan.target.clone();
            let disk = prune_and_snapshot(&mut data);
            drop(data);
            persist(app, disk);
            super::emit_event(app, 0, "decision");
            // 四期 P4a 孵化流水线:拆步跑完自动领下一条(开关默认关,锁外 spawn 不阻塞)。
            {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    super::pipeline::on_plan_finished(&app, &target.project_id, &target.tab_id).await;
                });
            }
            return;
        }
        let next = if plan.status == PlanStatus::Running { plan.current_idx() } else { None };
        let disk = prune_and_snapshot(&mut data);
        drop(data);
        persist(app, disk);
        next
    };
    if let Some(idx) = next_idx {
        if let Err(e) = dispatch_step(app, plan_id, idx).await {
            log::warn!("conductor: plan {plan_id} advance dispatch failed: {e}");
        }
    }
}

/// 验收 failed 后停链(终态钩子调用):步 Failed、后步 Queued 全 Skipped、计划 Halted。
pub async fn halt_after_failure(app: &AppHandle, plan_id: &str, step_id: &str, reason: &str) {
    let Some(state) = app.try_state::<ConductorState>() else { return };
    let Ok(mut data) = state.0.lock() else { return };
    let Some(plan) = data.plans.iter_mut().find(|p| p.id == plan_id) else { return };
    let step_idx = plan.steps.iter().position(|s| s.id == step_id);
    if let Some(idx) = step_idx {
        if let Some(step) = plan.steps.get_mut(idx) {
            step.status = StepStatus::Failed;
            step.verdict = Some("failed".to_string());
        }
        for s in plan.steps.iter_mut().skip(idx + 1) {
            if s.status == StepStatus::Queued {
                s.status = StepStatus::Skipped;
            }
        }
    }
    plan.status = PlanStatus::Halted;
    plan.halt_reason = Some(super::truncate_chars(
        &format!("第 {} 步验收失败:{}", step_idx.map(|i| i + 1).unwrap_or(0), reason),
        120,
    ));
    plan.updated_ms = now_ms();
    let disk = prune_and_snapshot(&mut data);
    drop(data);
    persist(app, disk);
    super::emit_event(app, 0, "decision");
}

/// 人的控制面:pause / resume / abort。resume 后计划仍有 Queued 步 → 立即从断点续跑。
/// 返回 Ok(false) = 动作不适用(状态不符);Ok(true) = 已执行。
pub async fn control(app: &AppHandle, plan_id: &str, action: &str) -> Result<bool, String> {
    let Some(state) = app.try_state::<ConductorState>() else {
        return Err("conductor state missing".to_string());
    };
    let (resume_next, interrupt_targets) = {
        let Ok(mut data) = state.0.lock() else { return Ok(false) };
        // abort 要一并中断的会话(当前步正在跑的目标;锁外执行)。在 find plan 前
        // 取——plan 的可变借用存活期间不能再借 data。2026-11-17:abort 不只停推进,
        // 当前步正在会话里跑的要一并中断(用户:涌现流关掉的任务「已经执行的也去
        // 中断」)。从 live 待验收记录定位目标;调用方(conductor_task_cancel/
        // decision_remove)若随后撤销验收记录,须在 abort **之后**进行,否则定位不到。
        let interrupt_targets: Vec<(String, String)> = data
            .pending_verdicts
            .iter()
            .filter(|p| p.plan_id.as_deref() == Some(plan_id))
            .map(|p| (p.project_id.clone(), p.tab_id.clone()))
            .collect();
        let Some(plan) = data.plans.iter_mut().find(|p| p.id == plan_id) else {
            return Err("计划不存在".to_string());
        };
        let mut resume_next = false;
        match action {
            "pause" if plan.status == PlanStatus::Running => {
                plan.status = PlanStatus::Paused;
            }
            "resume" if plan.status == PlanStatus::Paused => {
                plan.status = PlanStatus::Running;
                plan.halt_reason = None;
                resume_next = plan.current_idx().is_some();
            }
            "abort" if matches!(plan.status, PlanStatus::Running | PlanStatus::Paused) => {
                for s in plan.steps.iter_mut() {
                    if matches!(s.status, StepStatus::Queued | StepStatus::Running) {
                        s.status = StepStatus::Skipped;
                    }
                }
                plan.status = PlanStatus::Halted;
                plan.halt_reason = Some("人工终止".to_string());
            }
            _ => return Ok(false),
        }
        plan.updated_ms = now_ms();
        let disk = prune_and_snapshot(&mut data);
        drop(data);
        persist(app, disk);
        (resume_next, interrupt_targets)
    };
    for (pid, tid) in &interrupt_targets {
        if let Err(e) = crate::conductor::commands::interrupt_session(app, pid, tid).await {
            log::warn!("orchestrate: abort interrupt {pid}/{tid} failed: {e}");
        }
    }
    super::emit_event(app, 0, "decision");
    if resume_next {
        // resume 续跑:重读当前步下标后派发(dispatch_step 内部会再校验状态)。
        let idx = {
            let data = state.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
            data.plans
                .iter()
                .find(|p| p.id == plan_id)
                .and_then(|p| p.current_idx())
        };
        if let Some(idx) = idx {
            dispatch_step(app, plan_id, idx).await?;
        }
    }
    Ok(true)
}

/// 改指令重发(P3b 卡动作的后端):halted/paused 计划的失败步(或当前步)改文本后
/// 置 Queued、计划回 Running 并派发。text 为空 = 原文本重试。
pub async fn retry(app: &AppHandle, plan_id: &str, text: Option<String>) -> Result<(), String> {
    let Some(state) = app.try_state::<ConductorState>() else {
        return Err("conductor state missing".to_string());
    };
    let idx = {
        let Ok(mut data) = state.0.lock() else { return Ok(()) };
        let Some(plan) = data.plans.iter_mut().find(|p| p.id == plan_id) else {
            return Err("计划不存在".to_string());
        };
        if !matches!(plan.status, PlanStatus::Halted | PlanStatus::Paused) {
            return Err("仅 halted/paused 计划可续跑".to_string());
        }
        // 目标步:第一个 Failed,否则当前步。
        let step_idx = plan
            .steps
            .iter()
            .position(|s| s.status == StepStatus::Failed)
            .or_else(|| plan.current_idx())
            .ok_or_else(|| "无可续跑的步".to_string())?;
        let step = &mut plan.steps[step_idx];
        if let Some(t) = text.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            step.text = t;
        }
        step.status = StepStatus::Queued;
        step.verdict = None;
        plan.status = PlanStatus::Running;
        plan.halt_reason = None;
        plan.updated_ms = now_ms();
        let disk = prune_and_snapshot(&mut data);
        drop(data);
        persist(app, disk);
        step_idx
    };
    super::emit_event(app, 0, "decision");
    dispatch_step(app, plan_id, idx).await
}
