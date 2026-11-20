//! 驿站(UI 名;内部标识 / 序列化字段仍 inbox)与决策卡数据结构(P1)。存储挂在
//! conductor.json(serde default 零迁移);状态流转的副作用(发送/降级)在 commands.rs,
//! 本文件只放结构与纯流转。

use serde::{Deserialize, Serialize};

use super::permissions::Level;

/// 投递目标(多投:一条碎片可同时发给多个会话,如「检查 AI 是否运行中」巡检指令)。
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxTarget {
    pub project_id: String,
    pub tab_id: String,
}

/// 碎片条目。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub text: String,
    /// 手选或 LLM 路由回填;None = 未路由。
    pub project_id: Option<String>,
    /// 路由可建议到具体会话(P1 仅提示,dispatch 仍需人确认目标)。
    pub session_id: Option<String>,
    pub created_ms: i64,
    pub status: InboxStatus,
    /// 多投目标列表(2026-11-13):重复投递与循环器都按它逐目标投。
    /// 空 = 未选目标。`project_id`/`session_id` 保留为兼容字段(路由回填 /
    /// 决策卡降级展示),投递时同步为末位目标。
    #[serde(default)]
    pub targets: Vec<InboxTarget>,
    /// 循环间隔(分钟);None = 一次性条目。人设定,持久化。
    /// Some 且 `repeat_enabled` = 定时循环任务,到点由后端循环器自动重投。
    pub repeat_minutes: Option<u32>,
    /// 循环开关(仅 `repeat_minutes.is_some()` 有意义);人可暂停/恢复。
    #[serde(default)]
    pub repeat_enabled: bool,
    /// 下次循环执行时间戳(0 = 未排程;投递成功/改间隔时重算,持久化以免重启即补投)。
    #[serde(default)]
    pub next_run_ms: i64,
    /// 累计投递次数(手动 + 循环)。
    #[serde(default)]
    pub dispatch_count: u32,
    /// 最近一次**成功**投递时间戳(0 = 从未投出)。
    #[serde(default)]
    pub last_dispatch_ms: i64,
    /// 连续失败轮数(循环器用:≥3 自动停循环,防目标已消失时无限重试);成功清零。
    #[serde(default)]
    pub fail_streak: u32,
    /// 权限上限(自动驾驶二期 P2c):任务期内该条目派活目标的代批判定**不得超过**
    /// 此级(ceiling=confirm 时只读工具也弹卡;deny 时 confirm 也带高危标)。
    /// None = 不限制。随登记进 PendingVerdict,验收结算(终态)收回。
    #[serde(default)]
    pub permission_ceiling: Option<Level>,
    /// 验收标准(2026-11-18 用户:「验收的时候有个尺度」):可选。任务文本描述
    /// 「做什么」,标准描述「做到什么才算数」(如「命令退出码 0」「文件已创建」)。
    /// 随投递登记进 PendingVerdict,验收判定以标准命中为主要尺度、任务目标意图
    /// 兜底;返工链原样保留(同一把尺子);None = 只按目标意图判。
    #[serde(default)]
    pub acceptance: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxStatus {
    /// 待处理(可路由/投递)。
    Pending,
    /// 排队中(投递时目标全被占用锁拦下,等会话空闲由终态钩子自动补投;
    /// `config.queue_when_occupied` 开启时,人手动投递被占不再降级建议卡而是排队)。
    Queued,
    /// 已投递到会话(发送成功)。
    Dispatched,
    /// 已完成(投递后人工标记;P1 仅状态预留)。
    Done,
    /// 已丢弃。
    Dismissed,
}

/// 决策卡(建议卡 P1;dispatch/ask_human/memory_candidate P2 启用同结构)。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRecord {
    pub id: String,
    pub cycle_ms: i64,
    pub kind: DecisionKind,
    /// 卡面摘要(目标会话行,人读)。
    pub summary: String,
    /// 建议正文:accept/edit 时将以用户消息发给目标会话;ask_human 是问题文本;
    /// memory_candidate 是候选内容。
    pub text: String,
    pub target_project_id: Option<String>,
    pub target_session_id: Option<String>,
    /// P2 卡型载荷(dispatch: {taskId, provider};ask_human: {options};
    /// memory_candidate: {entryId})。suggestion 卡不用。serde default 零迁移。
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
    /// 本卡依据的记忆条目 id(prompt 注入了哪些),决策卡显示「依据」chips;
    /// accept 时这些条目 hits+1。serde default 零迁移。
    #[serde(default)]
    pub used_memory_ids: Vec<String>,
    pub source: DecisionSource,
    pub status: DecisionStatus,
    pub created_ms: i64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionKind {
    /// 下一步建议卡(P1 主体)。
    Suggestion,
    /// dispatch 确认卡(P2 fleet 联动)。
    Dispatch,
    /// 向人提问(P2)。
    AskHuman,
    /// 记忆候选(P2 纠偏提炼)。
    MemoryCandidate,
    /// 验收回环卡(自动驾驶一期):pending=挂起(大脑不可用,下次终态补判)/
    /// success=验收通过 / failed=验收失败(留人审)/ rework=未达成(已自动返工
    /// 或建议返工)。payload 结构见 commands::auto_verdict。
    Verdict,
}

/// 验收回环·待验收记录(自动驾驶一期):conductor 经手的派活(驿站投递/建议卡发送
/// /fleet 首条指令/自动返工)发送成功时登记,该会话下一个终态由大脑对照 goal 判定
/// success | failed | rework。每会话至多 1 条(新派活覆盖旧记录),持久化随
/// conductor.json——重启不丢,补判靠下一次终态。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingVerdict {
    pub project_id: String,
    pub tab_id: String,
    /// 任务目标(= 派活发送的文本原文)。
    pub goal: String,
    pub dispatched_ms: i64,
    /// 该目标链上已自动返工次数。≥1 后不再自动返工(防「失败→返工→再失败→再返工」
    /// 烧 token 死循环),后续一律留人审。
    #[serde(default)]
    pub rework_count: u32,
    /// 权限上限(自动驾驶二期 P2c;None = 不限制)。生效窗口 = 登记起 → 验收结算止
    /// (任务终态即收回,不留悬空授权);自动返工续登记时原样保留。
    #[serde(default)]
    pub permission_ceiling: Option<Level>,
    /// 所属编排计划(自动驾驶三期 P3a;None = 单步派活)。终态验收结算后由
    /// orchestrate 推进(success 发下一步 / failed 停链 / rework 原地重试)。
    #[serde(default)]
    pub plan_id: Option<String>,
    /// 所属计划内的步 id(与 plan_id 成对)。
    #[serde(default)]
    pub step_id: Option<String>,
    /// 验收标准(投递时随条目带上,见 [`InboxItem::acceptance`]);返工续登记
    /// 原样保留——同一目标链始终用同一把尺子。
    #[serde(default)]
    pub acceptance: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionSource {
    /// 大脑自动产出(终态事件触发)。
    Brain,
    /// 驿站投递被占用锁降级。
    InboxDowngrade,
    /// 人手动触发(设置分区「测试大脑」)。
    Manual,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionStatus {
    /// 待人处理。
    Proposed,
    /// 已接受(已发送/已执行)。
    Accepted,
    /// 已拒绝(P2:reject 触发纠偏提炼)。
    Rejected,
    /// 过期(目标会话已消失等;P1 预留,懒 GC 时标记)。
    Expired,
}

/// 决策日志滚动窗口上限(设计 §3.1:最近 200 条)。
pub const DECISIONS_CAP: usize = 200;

/// 循环间隔下限(分钟):防手滑填 0 变成紧密重试炸会话。
pub const REPEAT_MIN_MINUTES: u32 = 1;
/// 循环间隔上限(分钟)= 24h。
pub const REPEAT_MAX_MINUTES: u32 = 1440;
/// 连续失败多少轮自动停循环(目标 tab 已消失等,防无限重试)。
pub const REPEAT_FAIL_STREAK_STOP: u32 = 3;

/// 重排下一轮(投递成功 / 改间隔后调用)。循环关着的不排。
pub fn schedule_next(item: &mut InboxItem, now_ms: i64) {
    match item.repeat_minutes {
        Some(m) if item.repeat_enabled => {
            item.next_run_ms = now_ms + (m.clamp(REPEAT_MIN_MINUTES, REPEAT_MAX_MINUTES) as i64) * 60_000;
        }
        _ => item.next_run_ms = 0,
    }
}

/// 是否允许再次投递(Pending 首投;Dispatched/Done 已投过但可重投——2026-11-12 用户要求;
/// Queued 排队中可手动重投 = 放弃排队立即走人工链)。Dismissed 是丢弃,不再投。
pub fn is_dispatchable(status: InboxStatus) -> bool {
    matches!(
        status,
        InboxStatus::Pending
            | InboxStatus::Queued
            | InboxStatus::Dispatched
            | InboxStatus::Done
    )
}

/// 推入决策卡并截断到滚动窗口(新卡在头部)。
pub fn push_decision(decisions: &mut Vec<DecisionRecord>, record: DecisionRecord) {
    decisions.insert(0, record);
    if decisions.len() > DECISIONS_CAP {
        decisions.truncate(DECISIONS_CAP);
    }
}
