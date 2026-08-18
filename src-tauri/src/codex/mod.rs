//! codex 自渲染对话会话领域(command 边界)。
//!
//! 与 `claude` 模块并列,但进程模型根本不同:claude 是「单长进程 stream-json + stdin 喂消息」,
//! codex 无对等能力(实测 codex-cli 0.147.0),非交互只有 `codex exec`(一次性执行 + `--json`
//! 输出 JSONL 事件流)。多轮靠 **每轮一个短命 `codex exec` 进程 + `codex exec resume <id>` 续接**:
//!
//! - 发消息 = spawn `codex exec --json [-C cwd] [-s sandbox] [-m model] [-c model_reasoning_effort=X]
//!   [resume <id>] "<prompt>"`,进程跑完即退出(task/turn completed 后 EOF)。
//! - 首轮 `thread.started{thread_id}` 拿 session id 存 registry,后续轮 `resume <id>` 续接
//!   (实测同 thread_id 返回,上下文保留)。
//! - model/reasoning/sandbox 切换 = **下一轮 spawn 用新参数**(无 kill+restart,比 claude 简单)。
//! - 中断 = kill 当前 exec 进程树(同 claude 的 taskkill /F /T,.cmd shim 下 node 是孙子进程)。
//!
//! 实测 codex exec --json 顶层事件仅 6 种(thread.started/item.started/item.completed/
//! turn.started/turn.completed + 非法行),item 内容(item.type=agent_message/command_execution/
//! mcp_tool_call/custom_tool_call/reasoning/error)由前端 codexStream 解析,后端透传 Value。
//!
//! 与 claude 同构的部分:双层 map 按项目分桶、持锁不跨 await、kill_project、CREATE_NO_WINDOW、
//! Windows .cmd 用 cmd.exe /c 包装、kill_child_tree 杀进程树。差异:**无 stdin**(codex exec 不喂
//! stdin 且必须 Stdio::null(),实测 stdin 非 null 时 codex 卡在 "Reading additional input from
//! stdin...")、无 Compacting 状态、每轮 EOF 是正常结束(emit Terminated{normal} 而非 {eof})。

use std::collections::HashMap;
use std::process::Child;
use std::sync::Mutex;

pub mod commands;

/// 启动配置(供 send_codex_message 复用 cwd/sandbox/model/reasoning_effort)。
/// 字段当前仅写入未读取(每轮参数由前端显式传,config 留作诊断/未来崩溃重建复用,
/// 同 claude::SessionConfig 的处理),allow(dead_code)。
#[derive(Clone, Default)]
#[allow(dead_code)]
pub struct SessionConfig {
    pub cwd: Option<std::path::PathBuf>,
    /// sandbox 策略(codex -s):read-only | workspace-write | danger-full-access。
    pub sandbox: String,
    /// 模型(codex -m,catalog slug 如 "GLM-5.2")。None=不传(config.toml 默认)。
    pub model: Option<String>,
    /// reasoning 强度(codex -c model_reasoning_effort)。None=不传(模型默认档)。
    pub reasoning_effort: Option<String>,
}

/// 单个 codex 对话会话(绑定一个 tab)。**每轮短命进程**:child 仅在当前轮 exec 存活期 Some,
/// 跑完/kill 即 None(busy 判断用 status,不用 child.is_some())。无 stdin(codex exec 不喂)。
///
/// - `codex_session_id`:thread.started 回填的 thread_id,后续轮 `resume <id>` 续接。
/// - `config`:最近一次 spawn 用的参数(诊断日志用;每轮参数由前端显式传)。
/// - `model`:当前会话 model(-m 传的值或 config.toml 默认),供 detach 窗口回填 meta.model。
/// - `config_hash`:spawn 时 ~/.codex/config.toml + cc-switch-model-catalog.json 的内容哈希,
///   `codex_config_changed` 比对检测 cc-switch 切供应商(cc 切换改写这两个文件)。
/// - `killed`:主动 kill 标志。读循环 EOF 据此区分:true=interrupted(kill_codex 已 emit,不发
///   error);false=每轮正常结束(emit Terminated{normal})。
pub struct CodexSession {
    pub codex_session_id: Mutex<Option<String>>,
    pub child: Mutex<Option<Child>>,
    pub config: Mutex<SessionConfig>,
    pub status: Mutex<CodexStatus>,
    pub model: Mutex<Option<String>>,
    pub config_hash: Mutex<Option<u64>>,
    pub killed: Mutex<bool>,
}

/// codex 会话状态(前端状态栏 + 输入框可用性 + busy 判断)。
#[derive(Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CodexStatus {
    /// 空闲(无进行中轮;codex exec 每轮跑完即回 Idle)。
    Idle,
    /// 当前轮 exec 进程在跑。
    Running,
    /// 出错(spawn 失败等)。
    Error,
}

/// `codex-event` 事件载荷外壳(camelCase,与 `ClaudeEvent` 风格一致)。
///
/// 前端按 (projectId, tabId) 路由到对应 CodexTransport。payload 是分类后的顶层事件
/// (后端只解析顶层 type,item 内容透传 serde_json::Value 由前端按 item.type 归并)。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexEvent {
    pub project_id: String,
    pub tab_id: String,
    pub payload: CodexEventPayload,
}

/// 分类后的 codex exec --json 顶层事件(实测格式,见模块注释)。
///
/// `tag = "kind"`:serde 内部标签,前端 `CodexEventPayload` union 按 `kind` 字段判别。
/// `rename_all = "snake_case"`:kind 值用 snake_case(init/item_started/item_completed/
/// turn_started/turn_completed/terminated)。
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CodexEventPayload {
    /// `thread.started{thread_id}`:会话开始。thread_id 即 resume id(codex exec resume <id>,
    /// 实测同 id 续接成功)。
    Init { session_id: String },
    /// `item.started{item}`:item 开始(command_execution/mcp_tool_call 等,status=in_progress)。
    /// 前端 push pending 工具卡(spinner),item.completed 同 item.id 回填。
    ItemStarted { item: serde_json::Value },
    /// `item.completed{item}`:item 完成,**自带输入+输出**(command_execution: command+
    /// aggregated_output+exit_code; mcp_tool_call: server+tool+arguments+result; agent_message:
    /// text; error: message)。无需 tool_use/tool_result 配对(claude 需要,codex 一个 item
    /// 自带两端),前端按 item.id 归并。
    ItemCompleted { item: serde_json::Value },
    /// `turn.started`:轮次开始。
    TurnStarted,
    /// `turn.completed{usage}`:轮次完成。usage 含 input_tokens/cached_input_tokens/
    /// output_tokens/reasoning_output_tokens(透传 Value,前端回填 usage)。
    TurnCompleted { usage: Option<serde_json::Value> },
    /// 进程退出。reason 规范化:`"normal"`(每轮 exec 跑完的正常 EOF,前端当 idle 不显错误)/
    /// `"interrupted"`(用户中断)/`"spawn failed: ..."`(启动失败)。
    Terminated { reason: String },
}

/// 全局 codex 会话注册表,按项目分桶:`projectId -> (tabId -> CodexSession)`。
///
/// 与 `ClaudeRegistry` 同构:外层 key = 项目隔离,内层 key = tab(一个 tab 一个 codex 会话)。
/// `std::sync::Mutex`,严格「持锁不跨 .await」--短锁作用域内只做同步操作,阻塞的 kill+wait
/// 丢进 `spawn_blocking` 且锁已释放。
#[derive(Default)]
pub struct CodexRegistry {
    pub by_project: Mutex<HashMap<String, HashMap<String, CodexSession>>>,
}

impl CodexRegistry {
    /// 关闭某项目的全部 codex 会话(close_project 用)。仿 `ClaudeRegistry::kill_project`。
    ///
    /// 持锁不跨 await:极短锁作用域内 `remove` 整个项目桶并放锁,再把阻塞的 kill+wait 丢进
    /// `spawn_blocking`。桶不存在视为幂等成功。
    pub async fn kill_project(&self, project_id: &str) -> Result<(), String> {
        let sessions = {
            let mut by_project = self.by_project.lock().map_err(|e| {
                log::error!("codex kill_project: state lock poisoned: {e}");
                e.to_string()
            })?;
            by_project.remove(project_id).unwrap_or_default()
        }; // 锁在此释放,绝不跨 await。

        if sessions.is_empty() {
            log::info!("codex kill_project: no sessions for {project_id}");
            return Ok(());
        }

        let count = sessions.len();
        let pid = project_id.to_string();
        tokio::task::spawn_blocking(move || {
            for (_tab_id, session) in sessions {
                // 先置 killed=true(读循环 EOF 时不发 error,前端 transport 已 stop)。
                if let Ok(mut k) = session.killed.lock() {
                    *k = true;
                }
                // 取出 child(None)再杀整棵进程树;.cmd 包装下 node 是孙子进程。
                if let Some(mut child) = session.child.lock().ok().and_then(|mut g| g.take()) {
                    commands::kill_child_tree(&mut child);
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?;

        log::info!("codex kill_project: closed {count} session(s) for {pid}");
        Ok(())
    }
}
