//! Conductor(全局指挥)——值班副官:注意力路由 + 碎片驿站 + 监督调度。
//!
//! 定位见 `.work/design/20261112-conductor/conductor-design-v1.md`。四条边界:
//! 决策权在人 / 执行手臂 = fleet worker / 规则全本地(LLM 只补语言缝隙) / 记忆自研。
//!
//! 本模块 P0 只做**规则层**(纯读零 LLM):
//! - [`events`]:订阅 AiBus(claude/codex 事件),确定性推导每会话语义态
//!   (idle/running/waiting_approval/finished/error/offline)+ 人触达时间;
//! - `conductor-event` 事件:注意力计数变化时广播,顶栏徽标与指挥窗同源订阅;
//! - `conductor_snapshot` 命令:全量状态卡(指挥窗 hydrate 用,同时 ack 已读);
//! - `open_conductor_window`:独立指挥窗(label 固定 `conductor`),**关闭 = 隐藏**
//!   (CloseRequested → prevent_close + hide),常驻监控不随窗口开关而中断。
//!
//! P1 接 brain.rs(直连 OpenAI 兼容 API 的薄决策循环)+ guard + inbox;
//! P2 接 memory.rs(自研记忆)。config 字段此时已预留落盘,后续零迁移。

pub mod autopilot;
pub mod brain;
pub mod commands;
pub mod events;
pub mod guard;
pub mod inbox;
pub mod memory;
pub mod orchestrate;
pub mod permissions;
pub mod pipeline;
pub mod prompts;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::WindowBounds;
use inbox::{DecisionRecord, InboxItem, PendingVerdict};

/// 指挥窗 label(全局单实例;CloseRequested → hide,不销毁 webview,重开瞬时恢复)。
pub const CONDUCTOR_WINDOW_LABEL: &str = "conductor";

/// Agent 实况独立窗 label(2026-11-19,用户:「agent 实况能不能单独窗口打开,内容更
/// 丰富」)。同指挥窗口径:全局单实例、关闭 = 隐藏、bounds 落 conductor.json。
pub const STAGE_WINDOW_LABEL: &str = "agent-stage";

/// 两个「关闭 = 隐藏」的常驻窗统称(退出放行判定用)。
pub fn is_lurker_label(label: &str) -> bool {
    label == CONDUCTOR_WINDOW_LABEL || label == STAGE_WINDOW_LABEL
}

/// conductor.json 的完整路径(与 state.json 同目录,dev/prod 子目录分离同约定)。
fn data_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    let sub = if cfg!(debug_assertions) { "txuyStudio-dev" } else { "txuyStudio" };
    Ok(base.join(sub).join("conductor.json"))
}

/// 大脑与闸门配置。P0 仅落盘预留;brain/guard 于 P1/P2 消费。
///
/// 大脑端点**独立配置**(2026-11-13 用户拍板,反转 2026-11-12 的「复用 claude 供应商」):
/// baseUrl/token 手填 + `conductor_brain_probe` 拉模型目录 + **多选按序兜底**
/// (`brain_models` 有序,第一个模型不支持/异常自动降级第二个,全挂才算失败)。
/// token 明文落 conductor.json——与 providers.json/state.json 同级面的本机配置文件。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConductorConfig {
    /// 总闸(仿 relay.json `allowRemoteChat`):false = conductor 只剩规则层
    /// (徽标 + 驿站手动投递),LLM 环节全不出。默认 false。
    pub allow_orchestrator: bool,
    /// 占用锁(分钟):人 N 分钟内碰过的会话,dispatch 自动降级为建议卡。
    pub occupied_lock_minutes: u64,
    /// 建议静默窗(分钟,2026-11-17 拆分):人 N 分钟内**手动碰过**的会话,终态不出
    /// 常规建议卡(人正在驾驶,副官插话是噪音)。与占用锁语义不同——占用锁是硬闸
    /// (管自动投递能不能**塞话**),本值是软闸(只管**出不出卡**的 UI 噪音),故独立
    /// 配置且默认更短(人跑完任务歇一下就该给建议,等 10 分钟太久)。0 = 不静默
    /// (终态一律出卡,旧行为)。conductor 投递不登记人触达(human_touch=false),
    /// 无人值守任务的终态不受此窗影响。
    pub suggest_quiet_minutes: u64,
    /// 每决策周期 token 预算(P2 消费)。
    pub per_cycle_token_budget: u32,
    /// 大脑端点 baseUrl(裸域名或带 /v1 均可,chat 层归一)。
    pub brain_base_url: String,
    /// 大脑 API token(明文本机落盘;config_get 只回脱敏摘要,不回原文)。
    pub brain_api_key: String,
    /// 模型兜底链(有序多选):逐个试,第一个成功的胜出。
    pub brain_models: Vec<String>,
    /// 协议:"anthropic"(/v1/messages)| "openai"(/chat/completions)。独立配置没有
    /// 供应商 apiFormat 字段可读,显式选;默认 anthropic(glm/claude 系中转主流)。
    pub brain_api_format: String,
    /// [legacy] 旧版「复用 claude 供应商」引用(2026-11-12 §6.1;2026-11-13 反转后
    /// 仅作一次性迁移源:read_endpoint 见 brain_base_url 空且本字段有值时解析供应商
    /// 镜像填入新字段,迁移完置 None 不再消费)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brain_provider_id: Option<String>,
    /// [legacy] 旧版单模型覆盖;迁移时转为兜底链首项。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brain_model: Option<String>,
    /// 工具调用代批开关(2026-11-12 用户拍板,**反转**设计文档 §11.4「代批禁令」):
    /// true = claude 的 `can_use_tool` 请求由本地规则判定,只读工具 / 文件编辑 / 非危险
    /// Bash 判 auto,宽限弹卡倒计时到点自动放行;危险命令判 deny 真拦转人。**覆盖所有
    /// 会话**——指挥台任务与人手动聊的 pane 同口径(2026-11-19 用户澄清:2026-11-16
    /// 反馈的是「批了没任何提示」,修法是宽限弹卡而非收窄作用域,作用域收窄系误记,
    /// 本日恢复全域)。
    /// 默认 true——投递启动的会话默认 acceptEdits,Bash 写命令不代批就必然卡住。
    /// 机器代批走 `respond_claude_permission_raw`,**不登记人触达**(不续占用锁)。
    pub auto_approve_tools: bool,
    /// auto 级代批宽限(毫秒,2026-11-17 用户要求「先弹卡再自动选」):判定 auto 后
    /// **不立即放行**,照常弹原生卡并广播倒计时;宽限内人可手动选(卡上任意按钮,
    /// 前端调 conductor_auto_approve_cancel 撤销),到期无人接管才由后端代发 allow。
    /// 0 = 立即放行(旧行为,卡不弹)。默认 5000。
    pub auto_approve_delay_ms: u64,
    /// 建议自动执行(2026-11-16 用户:「我想要副官动态能自主去执行,而不是每次手动」):
    /// true = 大脑自主周期(Brain 源)产出的建议卡**直接代发**到目标 tab(等价人点
    /// 「直接发送」),卡标 Accepted+auto 徽标留痕;发送失败或目标失效 → 卡留 proposed
    /// 转人审。防自驱死循环:同目标 30min 自动冷静窗(窗内再产建议只出卡不代发);
    /// Manual(测试)与 InboxDowngrade(占用锁降级)源不自动。
    pub auto_execute_suggestions: bool,
    /// 孵化流水线(四期 P4a):计划 finished 后自动从孵化领取该会话的下一条
    /// pending 条目投递(领取边界 = targets 显式命中该会话;占用锁让位、失败停摆、
    /// 同会话串行)。默认 false。见 pipeline.rs。
    pub pipeline: bool,
    /// 投递占用排队(2026-11-17 用户:「检测到 AI pane 执行中,不应只转建议卡,
    /// 应该等运行完成自动塞入」):true = 手动投递被占用锁全拦时条目转**排队**
    /// (Queued),该会话下一个空闲终态(Finished/Idle,验收清账后)自动补投;
    /// false = 旧行为(降级建议卡留人)。循环条目不排队(有自己的节奏)。
    /// 默认 true。见 pipeline::dispatch_queued。
    pub queue_when_occupied: bool,
    /// 项目级建议开关·白名单(2026-11-23 用户:「对涌现的建议,针对项目级别加开关,
    /// 不要动不动就给建议」):**空 = 默认全部项目安静不出常规建议**,列内项目才允许
    /// Brain 源建议(5min 兜底轮 + 终态钩子);Manual「测试大脑」豁免(人主动点就是
    /// 要看)。与 muted_projects(感知链全量黑名单)正交:静音管「听不听得到该项目
    /// 的动静」,白名单管「副官对它说不说话」。serde default 零迁移(老盘空表安静)。
    pub suggest_projects: Vec<String>,
    /// 权限分级表(自动驾驶二期 P2a):自定义 auto/confirm/deny 规则(工具名 + Bash
    /// 模式)。空表 = 一期默认行为;判定顺序见 `permissions::judge`。
    pub permission_rules: permissions::PermissionRules,
}

impl Default for ConductorConfig {
    fn default() -> Self {
        Self {
            allow_orchestrator: false,
            occupied_lock_minutes: 10,
            suggest_quiet_minutes: 3,
            per_cycle_token_budget: 4000,
            brain_base_url: String::new(),
            brain_api_key: String::new(),
            brain_models: Vec::new(),
            brain_api_format: "anthropic".to_string(),
            brain_provider_id: None,
            brain_model: None,
            auto_approve_tools: true,
            auto_approve_delay_ms: 5_000,
            auto_execute_suggestions: true,
            pipeline: false,
            queue_when_occupied: true,
            suggest_projects: Vec::new(),
            permission_rules: permissions::PermissionRules::default(),
        }
    }
}

/// conductor.json 落盘壳(config + 窗口 bounds + 徽标已读时间戳 + 驿站 + 决策日志 +
/// 待验收记录)。sessions/touches/tails 是运行期态(进程死了状态即失效),不持久化
/// ——重启后由事件流重建;pending_verdicts 例外:验收目标丢了就得重派,重启保 pending
/// (下次终态补判,tail 空缺由判定 prompt 容错)。
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ConductorDisk {
    config: ConductorConfig,
    window_bounds: Option<WindowBounds>,
    /// Agent 实况独立窗 bounds(serde default 零迁移)。
    stage_bounds: Option<WindowBounds>,
    last_seen_ms: i64,
    inbox: Vec<InboxItem>,
    decisions: Vec<DecisionRecord>,
    /// 验收回环待验收记录(自动驾驶一期;serde default 零迁移)。
    pending_verdicts: Vec<PendingVerdict>,
    /// 项目级指挥台开关·黑名单(serde default 零迁移)。
    muted_projects: Vec<String>,
    /// 多步编排计划(自动驾驶三期;serde default 零迁移,上限 20 挤最旧终态)。
    plans: Vec<orchestrate::PlanRecord>,
    /// Agent 实况 XP 总账(2026-11-19 记录化:演进游戏进度跨重启累计,不再关窗归零;
    /// serde default 零迁移,老盘无此字段从 0 起步)。
    stage_xp: u64,
    /// Agent 实况拍落盘镜像(最近 [`TOOL_BEATS`] 条;30s 防抖批量落,运行环形同源)。
    tool_beats: Vec<ToolBeat>,
}

fn load_disk(app: &AppHandle) -> ConductorDisk {
    let Ok(path) = data_file_path(app) else {
        return ConductorDisk::default();
    };
    match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<ConductorDisk>(&bytes) {
            Ok(disk) => disk,
            Err(e) => {
                log::warn!("conductor: parse {} failed ({e}), using defaults", path.display());
                ConductorDisk::default()
            }
        },
        Err(_) => ConductorDisk::default(), // 首启无文件,正常
    }
}

pub(crate) fn save_disk(app: &AppHandle, disk: &ConductorDisk) -> Result<(), String> {
    let path = data_file_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create_dir_all: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(disk).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

/// 会话语义态(规则机输出;snake_case 序列化与前端 `ConductorSessionKind` 对齐)。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    /// 会话进程活着,无轮次在跑(init 已到 / codex 每轮 EOF)。
    Idle,
    /// 轮次进行中(assistant/thinking/item 等活动事件)。
    Running,
    /// 卡在审批(claude 权限请求 / codex approval_requested)。
    WaitingApproval,
    /// 一轮正常完成(result success / turn_completed)。
    Finished,
    /// 出错(result error / terminated eof / spawn failed)。
    Error,
    /// 进程退出(非故障)。P0 无生产者(terminated interrupted 已归 Idle)——
    /// 预留给 P1 会话管理流(kill/restart 命令显式标注「人为退出」),词汇表先行保持两端对齐。
    #[allow(dead_code)]
    Offline,
}

impl SessionKind {
    /// 是否属于「需要人注意」的终态类(徽标口径;Finished 另有触达时效条件,见 is_attention)。
    fn is_terminal_kind(&self) -> bool {
        matches!(self, SessionKind::WaitingApproval | SessionKind::Finished | SessionKind::Error)
    }

    /// snake_case 标识(与 serde 序列化一致;快照行组装用)。
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionKind::Idle => "idle",
            SessionKind::Running => "running",
            SessionKind::WaitingApproval => "waiting_approval",
            SessionKind::Finished => "finished",
            SessionKind::Error => "error",
            SessionKind::Offline => "offline",
        }
    }
}

/// 单会话状态卡(conductor_snapshot 的行;project_name/tab_title 在快照时由 AppState 富化)。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub tab_id: String,
    /// "claude" | "codex"
    pub provider: String,
    pub project_id: String,
    pub project_name: String,
    pub tab_title: String,
    pub kind: SessionKind,
    /// 终态附言(出错原因 / 等待审批的工具名),常规态为 None。
    pub detail: Option<String>,
    pub last_event_ms: i64,
}

/// conductor 运行期数据(内存态;持久化只落 [`ConductorDisk`] 部分)。
pub struct ConductorData {
    pub config: ConductorConfig,
    pub window_bounds: Option<WindowBounds>,
    /// Agent 实况独立窗 bounds(持久化镜像在 [`ConductorDisk::stage_bounds`])。
    pub stage_bounds: Option<WindowBounds>,
    /// 徽标「已读」水位:conductor_snapshot(开指挥窗看一眼)时推进。
    pub last_seen_ms: i64,
    /// 会话状态表,key = `projectId/tabId` 复合键([`skey`];tabId 仅项目内唯一,
    /// 旧版 id 各项目都有 ai-1,裸键跨项目撞名互相污染——2026-11-17 实证修正)。
    pub sessions: HashMap<String, SessionStatus>,
    /// 人触达时间,key = `projectId/tabId` 复合键(claude/codex send、pty write、
    /// shell run、权限响应)。供注意力判定(P0)与占用锁(P1 guard)共用。
    pub touches: HashMap<String, i64>,
    /// 碎片驿站(P1)。
    pub inbox: Vec<InboxItem>,
    /// 决策卡滚动日志(P1;最近 200 条)。
    pub decisions: Vec<DecisionRecord>,
    /// 记忆条目(P2;持久化在独立 memory.json,不进 conductor.json 落盘壳)。
    pub memories: Vec<memory::MemoryEntry>,
    /// 大脑连续失败计数(≥3 → 退避;成功清零)。
    pub brain_fail_streak: u32,
    /// 大脑退避截止时间戳(0 = 正常;期间所有 LLM 调用短路,规则层不受影响)。
    pub brain_degraded_until_ms: i64,
    /// 最近一次大脑调用失败原因(运行期记忆,不落盘;成功清零)。决策流空态
    /// 直接展示,免得「大脑挂了决策流静默空着」只能翻日志排查(2026-11-13 实案:
    /// 模型 id 不被供应商支持,404 循环退避,决策流从未产出过一张卡)。
    pub last_brain_error: Option<String>,
    /// 最近一次大脑失败时间戳(0 = 无)。
    pub last_brain_error_ms: i64,
    /// 代批流水(autopilot;最近 100 条,不落盘——重启后由新事件重建)。
    pub auto_approvals: VecDeque<autopilot::AutoApproveLog>,
    /// 已代批/已判定的 request_id 去重窗(最近 128 条;broadcast 不重放,防御性冗余)。
    pub handled_requests: VecDeque<String>,
    /// auto 级宽限倒计时中的 request_id(运行期态;人取消/到期代发时移除)。
    /// 存在 = 宽限窗内,后端到期会代发;人手动响应走 cancel 撤销。
    pub auto_pending: std::collections::HashSet<String>,
    /// 验收回环·待验收记录(自动驾驶一期;每 tab 至多 1 条)。持久化镜像在
    /// [`ConductorDisk::pending_verdicts`],登记/消费点负责落盘。
    pub pending_verdicts: Vec<PendingVerdict>,
    /// 会话事件尾部摘要(验收判定的「会话产出」原料;每会话最近 N 行,旧→新,行带
    /// 时间戳——验收按任务期 [`PendingVerdict::dispatched_ms`] 过滤取**本轮派活以来**
    /// 的产出)。key = `projectId/tabId` 复合键([`skey`])。运行期态不落盘——重启后
    /// pending 仍在但 tail 空,判定 prompt 按空产出容错。
    pub session_tails: HashMap<String, VecDeque<TailLine>>,
    /// 项目级指挥台开关·黑名单(2026-11-16 用户:「不是每个决策都会走指挥台,
    /// 可以根据项目去配置」):名单内项目的会话事件**不进感知链**(不出会话卡/
    /// 不计徽标/不产建议/不验收/不代批);人手动投递与采纳不受影响(用户主动
    /// 行为照走,但不再登记验收——终态钩子不跑,登记了也成幽灵)。缺省 = 参与。
    pub muted_projects: Vec<String>,
    /// 多步编排计划(自动驾驶三期 P3a):大脑拆步逐步派发,success 推进 / failed
    /// 即停 / rework 原地重试。持久化镜像在 [`ConductorDisk::plans`]。
    pub plans: Vec<orchestrate::PlanRecord>,
    /// Agent 实况环形缓冲(最近 [`TOOL_BEATS`] 条,新的在后;快照导出新的在前)。
    /// 2026-11-19 起记录化:镜像随 XP 一起 30s 防抖落 conductor.json,重启回看。
    pub tool_beats: VecDeque<ToolBeat>,
    /// 实况 XP 总账(持久化镜像在 [`ConductorDisk::stage_xp`];入拍时累加,
    /// 权重 [`stage_beat_weight`])。
    pub stage_xp: u64,
    /// 实况落盘脏标记(入拍置位,30s persist loop 消费;退出时 shutdown_all 兜底 flush)。
    pub stage_dirty: bool,
    /// claude tool_use 去重窗(assistant 帧是增量快照,同 tool_use 块逐帧重发;
    /// 按 id 去重,每会话环形 [`SEEN_TOOL_IDS`] 条)。codex item.started 恰发一次,
    /// 不需要。key = `projectId/tabId` 复合键([`skey`])。
    pub seen_tool_ids: HashMap<String, VecDeque<String>>,
}

/// Agent 实况单拍(2026-11-19,指挥台「Agent 实况」面板,参考 CrommaCode Game View
/// 「每一次工具调用是一拍」):一次工具调用 = 一拍。感知链顺手抽 tool_use 进环形
/// 缓冲(最近 [`TOOL_BEATS`] 条),随 `conductor_snapshot` 冷启动导出 +
/// `conductor-tool-event` 增量推送;seq 全局自增,前端按 seq 归并防快照/事件竞态丢拍。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolBeat {
    pub seq: u64,
    /// "claude" | "codex"
    pub provider: String,
    pub project_id: String,
    pub tab_id: String,
    /// 工具名(claude tool_use.name / codex "shell"·"mcp:server.tool")。
    pub tool: String,
    /// 目标一句话摘要(文件路径/命令/pattern,复用 claude 手机端 brief 取法)。
    pub summary: String,
    pub ms: i64,
}

/// 实况环形缓冲容量(2026-11-19 记录化扩容 60→240:落盘镜像同源,重启可回看更长
/// 历史;快照导出取前 80,事件推送逐帧)。
pub const TOOL_BEATS: usize = 240;
/// claude tool_use 去重窗容量(每会话,已见 tool_use id 环形)。
pub const SEEN_TOOL_IDS: usize = 128;

/// 实况拍全局自增序号(前端归并键)。拍历史落盘后(2026-11-20 校准):重启恢复的
/// 旧拍 seq 已到大数,计数器若仍从 1 起步,新拍 seq 全小于旧拍——前端按 seq 排序,
/// 新拍全部沉底,引擎最新拍冻结在旧拍(实证:活动强度按 ms 分桶照常更新,其余
/// 全按 seq 排序全冻)。安装时以磁盘最大 seq 校准,见 [`calibrate_beat_seq`]。
pub fn next_beat_seq() -> u64 {
    BEAT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// seq 计数器本体(模块级,供安装校准)。
static BEAT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 安装时以磁盘历史最大 seq 校准计数器(fetch_max 单调安全,只升不降;空历史/旧盘
/// 无拍传 0 即维持从 1 起步)。校准后下一拍 seq = max+1,不与恢复的旧拍撞号。
pub fn calibrate_beat_seq(max_seq: u64) {
    BEAT_SEQ.fetch_max(max_seq.saturating_add(1), std::sync::atomic::Ordering::Relaxed);
}

/// 实况拍 XP 权重(后端权威口径,与前端 StagePanel.toolCat/beatWeight 同表):
/// 读=1 / 写=2 / 执行=2(mcp 归执行) / 派生=3 / 其他=1。
/// XP 总账在后端按入拍累加落盘(2026-11-19 记录化),前端冷启动只读起步值。
pub fn stage_beat_weight(tool: &str) -> u64 {
    let t = tool.to_ascii_lowercase();
    let is = |names: &[&str]| {
        names.iter().any(|n| t == *n || t.starts_with(&format!("{n}(")) || t.starts_with(&format!("{n}:")))
    };
    if is(&["read", "grep", "glob", "ls", "view", "search", "todowrite", "todoread", "websearch", "webfetch"]) {
        return 1;
    }
    if is(&["edit", "write", "multiedit", "notebookedit", "apply_patch", "patch", "save", "create"]) {
        return 2;
    }
    if is(&["bash", "shell", "powershell", "cmd", "exec"]) || t.starts_with("mcp:") {
        return 2;
    }
    if is(&["task", "agent", "dispatch", "fork"]) {
        return 3;
    }
    1
}

/// 项目是否被静音(黑名单口径:显式列出才静音,新项目默认参与)。
pub fn is_muted(data: &ConductorData, project_id: &str) -> bool {
    data.muted_projects.iter().any(|p| p == project_id)
}

/// 会话复合键(`projectId/tabId`):tabId 仅项目内唯一(旧版生成器各项目都有 ai-1,
/// 实证 4 项目撞名),sessions/touches/session_tails 一律复合键,跨项目不互污。
pub fn skey(project_id: &str, tab_id: &str) -> String {
    format!("{project_id}/{tab_id}")
}

/// 尾部摘要单行结构:时间戳 + 文本。验收按 `dispatched_ms` 过滤取本轮任务期产出
/// (2026-11-18 拆步入口收敛后直投大任务为主路径——AI pane 自拆多轮跑很久,旧「任意
/// 尾部 30 行」会把派活早期的关键产出滚掉,验收员信息不足偏保守误判)。
pub struct TailLine {
    pub ms: i64,
    pub text: String,
}

/// 尾部摘要行数上限(每会话)与单行字符截断(超长截尾保头)。窗口 30→200(2026-11-18):
/// 验收按任务期过滤后,窗口须盖住大任务全程;200 行 × 400 字 ≈ 80KB/会话,内存可忽略。
pub const TAIL_LINES: usize = 200;
pub const TAIL_LINE_MAX_CHARS: usize = 400;

/// 截断到 N 字符(按 char 边界,防 panic;验收摘要展示与尾部缓冲共用)。
pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// 登记/覆盖待验收记录(派活发送成功后调用;锁由调用方持有)。每会话至多 1 条:
/// 新派活覆盖旧记录(旧目标已被新消息取代,再验收旧目标只会误判)。
/// `rework_count`:首次派活传 0;自动返工传「旧记录 + 1」(同目标链最多自动返工一次)。
/// `permission_ceiling`(P2c):随派活带上限,验收结算收回;返工续登记原样保留。
/// `acceptance`:验收标准(条目带上时传入;建议卡/编排步等无标准来源传 None)。
pub fn register_verdict_locked(
    data: &mut ConductorData,
    project_id: &str,
    tab_id: &str,
    goal: &str,
    rework_count: u32,
    permission_ceiling: Option<permissions::Level>,
    acceptance: Option<&str>,
) {
    let now = now_ms();
    // 查重按 (project, tab) 复合键(2026-11-18):旧实现只按 tab_id,跨项目 tabId
    // 撞名(如各项目都有 ai-1)会覆盖别项目的登记。
    let entry = data
        .pending_verdicts
        .iter_mut()
        .find(|p| p.project_id == project_id && p.tab_id == tab_id);
    match entry {
        Some(p) => {
            p.project_id = project_id.to_string();
            p.goal = goal.to_string();
            p.dispatched_ms = now;
            p.rework_count = rework_count;
            p.permission_ceiling = permission_ceiling;
            p.acceptance = acceptance.map(str::to_string);
        }
        None => data.pending_verdicts.push(PendingVerdict {
            project_id: project_id.to_string(),
            tab_id: tab_id.to_string(),
            goal: goal.to_string(),
            dispatched_ms: now,
            rework_count,
            permission_ceiling,
            acceptance: acceptance.map(str::to_string),
            // 编排链接不在这里设:单步派活为 None;编排步由 dispatch_step 派发后回填,
            // 返工链的续登记由 settle_verdict_locked 原样带过。
            plan_id: None,
            step_id: None,
        }),
    }
}

/// 追加一行会话尾部摘要(events watcher 调用;锁由调用方持有,时间戳在此打)。
/// key = 复合键([`skey`])。
pub fn push_tail_locked(data: &mut ConductorData, project_id: &str, tab_id: &str, line: String) {
    let tail = data
        .session_tails
        .entry(skey(project_id, tab_id))
        .or_insert_with(VecDeque::new);
    tail.push_back(TailLine { ms: now_ms(), text: line });
    while tail.len() > TAIL_LINES {
        tail.pop_front();
    }
}

/// 全局指挥状态(managed state)。`std::sync::Mutex`,持锁不跨 await(锁内只做同步读写)。
pub struct ConductorState(pub Mutex<ConductorData>);

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 人触达登记:claude/codex send、pty write、shell run、权限响应各命令调用。
/// key = 复合键([`skey`])。无会话条目也登记(先 send 后事件的顺序);失败静默
/// (触达只是启发式信号)。
pub fn note_human_touch(app: &AppHandle, project_id: &str, tab_id: &str) {
    if let Some(state) = app.try_state::<ConductorState>() {
        if let Ok(mut data) = state.0.lock() {
            data.touches.insert(skey(project_id, tab_id), now_ms());
        }
    }
}

/// 注意力判定(徽标口径):
/// - WaitingApproval / Error:硬信号,恒注意(人已在 pane 里处理时会自然流转到
///   Running 而自清,不依赖 ack);
/// - Finished:仅当人的最近触达已「陈旧」(超过占用锁窗,人大概率已切走)才算——
///   人刚发出去的轮次自己盯着,完成不必打扰。
fn is_attention(data: &ConductorData, session: &SessionStatus) -> bool {
    if !session.kind.is_terminal_kind() {
        return false;
    }
    if session.last_event_ms <= data.last_seen_ms {
        return false; // 已在指挥窗看过(ack 水位之后)
    }
    match session.kind {
        SessionKind::WaitingApproval | SessionKind::Error => true,
        SessionKind::Finished => {
            let touch = data
                .touches
                .get(&skey(&session.project_id, &session.tab_id))
                .copied()
                .unwrap_or(0);
            if touch == 0 {
                return true;
            }
            let lock_ms = (data.config.occupied_lock_minutes * 60_000) as i64;
            session.last_event_ms - touch > lock_ms
        }
        _ => false,
    }
}

/// 注意力计数(锁内快照用,不产生副作用)。
pub fn attention_count(data: &ConductorData) -> u32 {
    data.sessions
        .values()
        .filter(|s| is_attention(data, s))
        .count() as u32
}

/// 广播 `conductor-event`。锁外调用(payload = {attentionCount, kind};kind:
/// "attention" 状态机变化 / "inbox" 驿站变化 / "decision" 新决策卡。全量状态走
/// conductor_snapshot——项目名/tab 标题富化要读 AppState,事件里不携带)。
pub fn emit_event(app: &AppHandle, count: u32, kind: &str) {
    let _ = app.emit("conductor-event", serde_json::json!({ "attentionCount": count, "kind": kind }));
}

/// 从内存态截取落盘壳(锁内调用;三处保存点共用,避免字段漂移)。
pub(crate) fn snapshot_disk(data: &ConductorData) -> ConductorDisk {
    ConductorDisk {
        config: data.config.clone(),
        window_bounds: data.window_bounds,
        stage_bounds: data.stage_bounds,
        last_seen_ms: data.last_seen_ms,
        inbox: data.inbox.clone(),
        decisions: data.decisions.clone(),
        pending_verdicts: data.pending_verdicts.clone(),
        muted_projects: data.muted_projects.clone(),
        plans: data.plans.clone(),
        stage_xp: data.stage_xp,
        tool_beats: data.tool_beats.iter().cloned().collect(),
    }
}

/// setup 装配:落盘壳加载 → manage 状态 → 启动 AiBus 订阅 watcher。
/// 必须晚于 `relay::bus::install`(watcher 订阅 AiBus managed state)。
pub fn install(app: &AppHandle) {
    let disk = load_disk(app);
    // seq 计数器校准(2026-11-20):磁盘历史最大 seq 之上续号,新拍不与恢复旧拍撞号
    // (撞号实证:引擎最新拍冻结在旧拍,仅活动强度按 ms 分桶照常更新)。
    let max_seq = disk.tool_beats.iter().map(|b| b.seq).max().unwrap_or(0);
    calibrate_beat_seq(max_seq);
    let data = ConductorData {
        config: disk.config,
        window_bounds: disk.window_bounds,
        stage_bounds: disk.stage_bounds,
        last_seen_ms: disk.last_seen_ms,
        sessions: HashMap::new(),
        touches: HashMap::new(),
        inbox: disk.inbox,
        decisions: disk.decisions,
        memories: memory::load(app),
        brain_fail_streak: 0,
        brain_degraded_until_ms: 0,
        last_brain_error: None,
        last_brain_error_ms: 0,
        auto_approvals: VecDeque::new(),
        handled_requests: VecDeque::new(),
        auto_pending: std::collections::HashSet::new(),
        pending_verdicts: disk.pending_verdicts,
        session_tails: HashMap::new(),
        muted_projects: disk.muted_projects,
        plans: disk.plans,
        tool_beats: disk.tool_beats.into(),
        stage_xp: disk.stage_xp,
        stage_dirty: false,
        seen_tool_ids: HashMap::new(),
    };
    app.manage(ConductorState(Mutex::new(data)));
    // prompt 技艺文件播种(2026-11-18):拆步/验收 system prompt 外置为可编辑 md,
    // 不存在则写内置默认全文——用户打开即见当前真实口径(存在不动,编辑优先)。
    prompts::seed_defaults(app);
    events::spawn_watcher(app);
    commands::spawn_repeat_loop(app);
    commands::spawn_brain_loop(app);
    spawn_stage_persist_loop(app);
    log::info!("conductor: installed (rule layer P0 + brain/inbox P1 + repeat loop + brain loop P2)");
}

/// 实况记录防抖落盘(2026-11-19):拍/XP 高频变化(多会话并行时每分钟十几拍),
/// 逐拍写盘太密——入拍只置脏,本循环 30s 检查一次,脏才同步落 conductor.json。
/// 退出兜底在 `shutdown_all`(ExitRequested 同步 flush,最多丢最后 30s 内的拍)。
fn spawn_stage_persist_loop(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let disk = {
            let Some(state) = handle.try_state::<ConductorState>() else { return };
            let Ok(mut data) = state.0.lock() else { continue };
            if !data.stage_dirty {
                continue;
            }
            data.stage_dirty = false;
            snapshot_disk(&data)
        };
        if let Err(e) = save_disk(&handle, &disk) {
            log::warn!("conductor: stage persist failed: {e}");
        }
    });
}

/// 退出前同步 flush 实况记录(shutdown_all 调用;30s 窗口内的拍在此兜底落盘)。
pub fn flush_stage_on_exit(app: &AppHandle) {
    let disk = {
        let Some(state) = app.try_state::<ConductorState>() else { return };
        let Ok(mut data) = state.0.lock() else { return };
        if !std::mem::replace(&mut data.stage_dirty, false) {
            return;
        }
        snapshot_disk(&data)
    };
    if let Err(e) = save_disk(app, &disk) {
        log::warn!("conductor: stage flush on exit failed: {e}");
    }
}

/// 指挥窗关闭(hide)前同步补存 bounds:防抖保存主路径之外,拖完即关的最后一段在此落盘。
/// 镜像 `persist_main_bounds_on_close` 语义,但落 conductor.json(AppState 不掺指挥窗数据)。
pub fn persist_bounds_on_close(app: &AppHandle, win: &tauri::Window) {
    persist_window_bounds(app, win, false);
}

/// Agent 实况独立窗关闭(hide)前补存 bounds(落 [`ConductorData::stage_bounds`])。
pub fn persist_stage_bounds_on_close(app: &AppHandle, win: &tauri::Window) {
    persist_window_bounds(app, win, true);
}

/// bounds 关窗补存公共体(`stage` 选择落点字段:指挥窗 window_bounds / 实况窗 stage_bounds)。
fn persist_window_bounds(app: &AppHandle, win: &tauri::Window, stage: bool) {
    if win.is_minimized().unwrap_or(false) {
        return;
    }
    let bounds = if win.is_maximized().unwrap_or(false) {
        WindowBounds { x: 0, y: 0, width: 0, height: 0, maximized: true }
    } else {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            return;
        };
        let scale = win.scale_factor().unwrap_or(1.0);
        WindowBounds {
            x: (pos.x as f64 / scale).round() as i32,
            y: (pos.y as f64 / scale).round() as i32,
            width: (size.width as f64 / scale).round() as u32,
            height: (size.height as f64 / scale).round() as u32,
            maximized: false,
        }
    };
    let disk = {
        let Some(state) = app.try_state::<ConductorState>() else { return };
        let Ok(mut data) = state.0.lock() else { return };
        let slot = if stage { &mut data.stage_bounds } else { &mut data.window_bounds };
        // width==0 = 「仅最大化标志」条目:保留上次 normal 态 bounds,只更新标志。
        if bounds.width == 0 {
            match slot.as_mut() {
                Some(b) => b.maximized = bounds.maximized,
                None => *slot = Some(bounds),
            }
        } else {
            *slot = Some(bounds);
        }
        snapshot_disk(&data)
    };
    if let Err(e) = save_disk(app, &disk) {
        log::warn!("conductor: persist bounds on close failed: {e}");
    }
}

/// 指挥窗建窗后应用已存 bounds(可见前设置,首帧即上次大小;窗口仍 visible:false)。
/// 屏外防护与主窗口同策略:中心点不在任一显示器内 → 只恢复大小、跳过位置。
pub fn apply_saved_bounds(win: &tauri::WebviewWindow, bounds: WindowBounds) {
    if bounds.width > 0 && bounds.height > 0 {
        let w = (bounds.width as f64).max(560.0);
        let h = (bounds.height as f64).max(400.0);
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
        let scale = win.scale_factor().unwrap_or(1.0);
        let cx = (bounds.x as f64 + w / 2.0) * scale;
        let cy = (bounds.y as f64 + h / 2.0) * scale;
        let on_screen = win
            .available_monitors()
            .map(|mons| {
                mons.iter().any(|m| {
                    let p = m.position();
                    let s = m.size();
                    let (px, py) = (p.x as f64, p.y as f64);
                    (px..px + s.width as f64).contains(&cx) && (py..py + s.height as f64).contains(&cy)
                })
            })
            .unwrap_or(false);
        if on_screen {
            let _ = win.set_position(tauri::LogicalPosition::new(bounds.x as f64, bounds.y as f64));
        } else {
            log::info!("conductor: saved bounds center off-screen, position skipped");
        }
    }
    if bounds.maximized {
        let _ = win.maximize();
    }
}

/// 非常驻窗(指挥窗/实况窗)关闭时调用:若关闭后剩下的窗口只有隐藏常驻窗 → 一并销毁,
/// 放行应用退出。否则隐藏窗会一直占着窗口数,主窗口关了应用也不退(ExitRequested
/// 只在「全部窗口关闭」时触发)。`closing_label` 是正在关闭的窗口(CloseRequested
/// 阶段它还活着,须排除);常驻窗自身关闭走 hide 分支,不会进这里。
pub fn destroy_if_last(app: &AppHandle, closing_label: &str) {
    if is_lurker_label(closing_label) {
        return;
    }
    let has_other = app
        .webview_windows()
        .keys()
        .any(|label| !is_lurker_label(label) && label != closing_label);
    if has_other {
        return;
    }
    for (label, win) in app.webview_windows() {
        if is_lurker_label(&label) {
            log::info!("conductor: last real window closing, destroying hidden window '{label}'");
            let _ = win.destroy();
        }
    }
}
