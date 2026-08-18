//! claude 自渲染对话会话领域(command 边界)。
//!
//! 与 `pty` 模块并列:不走 ConPTY,而是用 `std::process::Command` 直接 spawn `claude.exe`,
//! 以 `--input-format stream-json --output-format stream-json --verbose` 模式运行(claude TUI 完全
//! 不出现),前端自渲染。不走 PTY 的原因:ConPTY 的终端仿真 + echo 会污染 stream-json 的 JSON 行
//! (回显、行回卷),而 stream-json 需要干净的 stdout 管道逐行读 JSON。
//!
//! 多轮对话机制(stream-json 长进程架构,见 `.work/design/20260720-compact-stream-json/`):
//! 一个 claude tab 对应**一个长生命周期 claude 进程**,stdin 持续喂 stream-json user 消息
//! (`--input-format stream-json`),stdout 持续吐事件。多轮在同一进程内,session_id 全程不变
//! ——这正是 `/compact` 真生效、`--resume` 不断裂的关键(实测:同进程内 `/compact` 由 claude
//! 引擎执行,产出 `compact_boundary` 事件,session_id 不变)。
//!
//! 进程生命周期由 `start_claude_session` 管理(首启 / 崩溃恢复 / 换 mode / 批准重启);发消息由
//! `send_claude_message` 写 stdin。重启时带 `--resume <session_id>`(session_id 在 registry 不丢)
//! 续接历史。`claude_session_id` 来自首轮 `system init`,由读循环回填。
//!
//! 与 `pty` 同构的部分:双层 map 按项目分桶、`kill_project`/关 tab 短锁+spawn_blocking 模式、
//! camelCase 事件载荷、`generate_handler!`/`manage()` 注册。差异:无 master/无 resize、stdin 持久
//! (长进程存活期一直 Some,EOF 才 None)、stdout 用 `BufReader::lines()` 逐行读(而非字节块)。

use std::collections::HashMap;
use std::process::{Child, ChildStdin};
use std::sync::Mutex;

pub mod commands;

/// 启动配置(供 `start_claude_session` 重启时复用 mode/cwd)。allowedTools 不存——重启时从
/// `AppState` 读最新项目持久化 allowlist(「批准且不再问」累积)。Phase 1-2 由 transport 显式
/// 传参,字段暂未被读(Phase 4 崩溃重建无参 ensureStarted 将复用),故 allow(dead_code)。
#[derive(Clone, Default)]
#[allow(dead_code)]
pub struct SessionConfig {
    pub permission_mode: String,
    pub cwd: Option<std::path::PathBuf>,
    pub effort: Option<String>,
    pub model: Option<String>,
}

/// 单个 claude 对话会话(绑定一个 tab,长进程存活期一直存在)。
///
/// - `claude_session_id`:claude 的会话 id(来自首轮 `system init`),用于**重启**时 `--resume`
///   续接(长进程内多轮不换 id;重启才需 --resume 加载历史)。用 Mutex 是因为读循环在
///   spawn_blocking 线程里写、start_claude_session 在 async 里读。
/// - `child`:长进程子进程。存活期一直 `Some`,EOF(进程退出)才 `None`。与短命模型不同:
///   空闲时 child 仍在(busy 语义改用 `status` 判断,不再用 `child.is_some()`)。
/// - `stdin`:长进程 stdin。写消息用(take 出写完放回,见 `send_claude_message`)。EOF/kill 时 None。
/// - `config`:启动配置,重启复用。
/// - `status`:会话状态(前端状态栏 + 输入框可用性 + busy 判断)。
/// - `model`:当前会话 model(init 回填 + 前端 `/model` 切换/真实 assistant 事件同步写)。
///   供独立窗口(detach)新建 transport 时 `get_claude_session_model` 回填 meta.model,使状态栏
///   打开即显示当前 model(长进程不重启则 init 不重发,新 transport 的 meta.model 恒空)。
/// - `killed`:主动 kill/重启标志。读循环 EOF 据此区分:`true` = 主动 kill(重启/中断,不发 error
///   Terminated);`false` = 崩溃(emit `Terminated{eof}` + Error)。
pub struct ClaudeSession {
    pub claude_session_id: Mutex<Option<String>>,
    pub child: Mutex<Option<Child>>,
    pub stdin: Mutex<Option<ChildStdin>>,
    pub config: Mutex<SessionConfig>,
    pub status: Mutex<ClaudeStatus>,
    pub model: Mutex<Option<String>>,
    /// 进程 spawn 时 `~/.claude/settings.json` 的 `env` 段哈希。cc-switch 等工具切供应商会改写
    /// 该文件(BASE_URL/AUTH_TOKEN/ANTHROPIC_MODEL 等),运行中的长进程不会感知--前端打开模型
    /// 选择器时调 `claude_settings_changed` 比对当前哈希,变了则重启进程拾取新配置。
    pub settings_env_hash: Mutex<Option<u64>>,
    pub killed: Mutex<bool>,
}

/// claude 会话状态(前端状态栏 + 输入框可用性 + busy 判断)。
#[derive(Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ClaudeStatus {
    /// 空闲,可发下一条(长进程仍存活,只是无进行中轮)。
    Idle,
    /// 子进程在跑(claude 正在响应某轮)。
    Running,
    /// 正在执行 compact(`system status=compacting`,busy 拒绝发新消息)。
    Compacting,
    /// 出错(进程异常退出/被 kill 且非主动重启)。
    Error,
}

/// `claude-event` 事件载荷外壳(camelCase,与 `PtyOutput` 风格一致)。
///
/// 前端按 `(projectId, tabId)` 路由到对应 ClaudeTransport。payload 是分类后的事件
/// (后端已解析原始 stream-json 行 + 节流 thinking_tokens),前端 `applyEvent` 归并。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeEvent {
    pub project_id: String,
    pub tab_id: String,
    pub payload: ClaudeEventPayload,
}

/// 分类后的 stream-json 事件。后端读循环负责解析原始 JSON 行 + thinking_tokens 攒批节流。
///
/// `tag = "kind"`:serde 内部标签,前端 `ClaudeEventPayload` union 按 `kind` 字段判别。
/// `rename_all = "snake_case"`:kind 值用 snake_case(init/assistant/user/thinking/result/terminated/
/// compact_status/compact_boundary)。
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClaudeEventPayload {
    /// `system subtype=init`:首次拿到 claude session_id(后端据此回填 registry)。
    /// `slash_commands`:claude 内置斜杠命令(如 /clear /compact /cost …),透传给前端做
    /// 输入框 `/` 触发的命令面板。旧版 claude 可能不含该字段 → 空数组降级。
    Init {
        claude_session_id: String,
        model: String,
        cwd: String,
        slash_commands: Vec<String>,
    },
    /// `assistant` message(content[] 含 text/thinking/tool_use)。透传整条 message 作为
    /// serde_json::Value,前端按 content block 遍历归并(同 message_id 覆盖最新快照)。
    Assistant { message: serde_json::Value },
    /// `user` message(含 tool_result)。透传 message,前端用 tool_use_id 配对回填工具结果。
    User { message: serde_json::Value },
    /// `system subtype=thinking_tokens` 攒批后的聚合文本(200 token 或 50ms 一批)。
    /// 原始逐 token 事件高频刷屏,后端节流避免 IPC 风暴。
    Thinking { text: String },
    /// `result subtype=success/error`:最终结果(轮次结束)。长进程模式下 result 仅标志一轮
    /// 结束,**进程不退出**(child 保持 Some)。
    Result {
        success: bool,
        duration_ms: u64,
        num_turns: u32,
        total_cost_usd: f64,
        stop_reason: Option<String>,
        error: Option<String>,
        /// 本轮 token 用量。glm-5.2 代理把真实 usage 放在 result(assistant message.usage
        /// 流式时恒为 0),透传整段,前端 applyEvent 回填到最近 assistant message,
        /// ctx / sessionTokens / 行尾 token 显示才能取到真实值。
        usage: Option<serde_json::Value>,
        /// 上下文窗口上限(从 result.modelUsage.<model>.contextWindow 取,200k 或 1m)。
        /// 前端据此显示 ctx 上限 + 算占用百分比。
        context_window: Option<u64>,
    },
    /// 进程异常退出(claude 崩溃/EOF 未发 result)。前端据此设 error 状态。
    /// reason 规范化:`"interrupted"`(用户中断/主动重启,前端当 idle 不显错误)/`"eof"`(崩溃)/
    /// `"spawn failed: ..."`(启动失败)。
    Terminated { reason: String },
    /// `system subtype=status`:compact 状态进度。
    /// - `status="compacting"`:compact 开始(前端显「正在压缩…」,busy)。
    /// - `result="success"|"failed"`:compact 结束(`success` 后紧跟 `compact_boundary` + 总结)。
    /// - `error`:失败原因(如 `"Not enough messages to compact."`)。
    CompactStatus {
        status: Option<String>,
        result: Option<String>,
        error: Option<String>,
    },
    /// `system subtype=compact_boundary`:compact 成功的边界标记。
    /// 透传完整 `compact_metadata`(`trigger`/`pre_tokens`/`post_tokens`/
    /// `cumulative_dropped_tokens`/`duration_ms`/`preserved_segment`/`preserved_messages`),
    /// 前端据此渲染「已压缩 pre→post tokens」分隔线。后端不解析内部结构(透传 Value)。
    CompactBoundary { metadata: serde_json::Value },
}

/// 全局 claude 会话注册表,按项目分桶:`projectId → (tabId → ClaudeSession)`。
///
/// 与 `PtyRegistry` 同构:外层 key = 项目隔离,内层 key = tab(一个 tab 一个 claude 会话)。
/// `std::sync::Mutex`,严格「持锁不跨 .await」——短锁作用域内只做同步操作(insert/remove/取
/// claude_session_id/取 child),阻塞的 kill+wait 丢进 `spawn_blocking` 且锁已释放。
#[derive(Default)]
pub struct ClaudeRegistry {
    pub by_project: Mutex<HashMap<String, HashMap<String, ClaudeSession>>>,
}

impl ClaudeRegistry {
    /// 关闭某项目的全部 claude 会话(close_project 用)。仿 `PtyRegistry::kill_project`。
    ///
    /// 持锁不跨 await:极短锁作用域内 `remove` 整个项目桶并放锁,再把阻塞的 kill+wait 丢进
    /// `spawn_blocking`。桶不存在视为幂等成功(空 HashMap → Ok)。
    pub async fn kill_project(&self, project_id: &str) -> Result<(), String> {
        let sessions = {
            let mut by_project = self.by_project.lock().map_err(|e| {
                log::error!("claude kill_project: state lock poisoned: {e}");
                e.to_string()
            })?;
            by_project.remove(project_id).unwrap_or_default()
        }; // 锁在此释放,绝不跨 await。

        if sessions.is_empty() {
            log::info!("claude kill_project: no sessions for {project_id}");
            return Ok(());
        }

        let count = sessions.len();
        let pid = project_id.to_string();
        tokio::task::spawn_blocking(move || {
            for (_tab_id, session) in sessions {
                // 先置 killed=true(读循环 EOF 时不发 error Terminated,前端 transport 已 stop)。
                if let Ok(mut k) = session.killed.lock() {
                    *k = true;
                }
                // 取出 child(None)再 kill;child 为 None 说明长进程已退出,跳过。
                // 用 kill_child_tree 杀整棵进程树(Windows .cmd 包装下 node 是孙子进程,
                // child.kill() 杀不干净,见 commands::kill_child_tree 注释)。
                if let Some(mut child) = session.child.lock().ok().and_then(|mut g| g.take()) {
                    commands::kill_child_tree(&mut child);
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?;

        log::info!("claude kill_project: closed {count} session(s) for {pid}");
        Ok(())
    }
}
