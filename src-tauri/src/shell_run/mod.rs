//! `!` 命令内联执行 PowerShell 的会话领域(command 边界)。
//!
//! 与 `pty`/`claude` 模块并列:不走 ConPTY,也不用 `std::process::Command::output()`
//! (后者 wait-with-output,无法流式 + 无法中断)。而是 spawn 一次性 powershell 子进程,
//! `BufReader::lines()` 逐行读 stdout/stderr,增量 emit `shell-event`,EOF 后据 `killed`
//! 标志区分「用户中断」与「正常结束」。
//!
//! **与 claude 模块的关键差异**(它是长进程,本模块是一次性命令):
//! - 无 stdin(命令经 `-Command` 一次性传入,不需要后续喂输入)。
//! - 无 `claude_session_id`/`status`/`config`/`--resume`/`Compacting`——这些是 claude 进程语义。
//! - session 只需 `child` + `killed` 两字段;进程跑完即 EOF,无空闲存活态。
//!
//! 多轮不复用进程:每条 `!` 命令 spawn 一个新 powershell 进程。一个 (projectId, tabId)
//! 同时只允许一个在跑(前端 `canSend` 锁定 + 后端 busy 检查);但 registry 仍按双层 map
//! 组织,便于 `kill_project` 批量清理关项目时的残留进程。
//!
//! 与 `pty`/`claude` 同构:双层 map 按项目分桶、`kill_project` 短锁+spawn_blocking 模式、
//! camelCase 事件载荷、`generate_handler!`/`manage()` 注册。差异:stdout/stderr 都 piped
//! (claude 只 piped stdout)、逐行当字符串 emit(claude 逐行解析 JSON)。

use std::collections::HashMap;
use std::process::Child;
use std::sync::Mutex;

pub mod commands;

/// 单条 `!` 命令的执行会话(绑定一个 tab,进程存活期一直存在,EOF 即结束)。
///
/// - `child`:powershell 子进程。存活期 `Some`,EOF/kill 后 `None`。
/// - `killed`:主动 kill 标志。读循环 EOF 据此区分:`true` = 用户中断(由 `kill_shell_command`
///   主动 emit `interrupted`,读循环静默);`false` = 正常结束(读循环 `child.wait()` 拿 exit
///   code,emit `done`)。
/// - `id`:当前执行的唯一 id(`run_shell_command` 生成,emit `start` 时透传给前端)。
///   `kill_shell_command` 据此 emit 精确 `interrupted{id}`(前端按 id 配对复位消息)。
pub struct ShellRunSession {
    pub child: Mutex<Option<Child>>,
    pub killed: Mutex<bool>,
    pub id: Mutex<Option<String>>,
}

/// `shell-event` 事件载荷外壳(camelCase,与 `ClaudeEvent`/`PtyOutput` 风格一致)。
///
/// 前端按 `(projectId, tabId)` 路由到对应 ShellRunTransport。payload 是分类后的事件,
/// 前端 `applyShellEvent` 纯函数归并。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellEvent {
    pub project_id: String,
    pub tab_id: String,
    pub payload: ShellEventPayload,
}

/// `!` 命令执行的事件流。
///
/// `tag = "kind"`:serde 内部标签,前端 union 按 `kind` 判别。
/// - `start`:命令开始(前端据此 push 一条 running 消息,用后端生成的 `id` 配对后续 output/done)。
/// - `output`:stdout/stderr 一行输出(`stream` 区分)。
/// - `done`:进程正常结束(带 exit code)。
/// - `interrupted`:用户中断(killed)。
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShellEventPayload {
    Start {
        /// 本次执行的唯一 id(前端 push 消息 + 配对 output/done 用)。
        id: String,
        command: String,
    },
    Output {
        id: String,
        chunk: String,
        stream: String,
    },
    Done {
        id: String,
        // rename 成 camelCase:serde enum 级 `rename_all="snake_case"` 只重命名变体名(kind 值),
        // 不重命名字段名,故 exit_code 默认序列化为 snake_case,前端读 exitCode 会拿到 undefined
        // → `undefined === 0` 误判 error。显式 rename 对齐前端 camelCase。
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
    },
    Interrupted {
        id: String,
    },
}

/// 全局 `!` 命令执行注册表,按项目分桶:`projectId → (tabId → ShellRunSession)`。
///
/// 与 `ClaudeRegistry`/`PtyRegistry` 同构。`std::sync::Mutex`,严格「持锁不跨 .await」——
/// 短锁作用域内只做同步操作(insert/remove/take child),阻塞的 kill+wait 丢进 `spawn_blocking`
/// 且锁已释放。
#[derive(Default)]
pub struct ShellRunRegistry {
    pub by_project: Mutex<HashMap<String, HashMap<String, ShellRunSession>>>,
}

impl ShellRunRegistry {
    /// 关闭某项目的全部 `!` 命令进程(close_project 用)。仿 `ClaudeRegistry::kill_project`。
    ///
    /// 持锁不跨 await:极短锁作用域内 `remove` 整个项目桶并放锁,再把阻塞的 kill+wait 丢进
    /// `spawn_blocking`。桶不存在视为幂等成功(空 HashMap → Ok)。
    pub async fn kill_project(&self, project_id: &str) -> Result<(), String> {
        let sessions = {
            let mut by_project = self.by_project.lock().map_err(|e| {
                log::error!("shell_run kill_project: state lock poisoned: {e}");
                e.to_string()
            })?;
            by_project.remove(project_id).unwrap_or_default()
        }; // 锁在此释放,绝不跨 await。

        if sessions.is_empty() {
            log::info!("shell_run kill_project: no sessions for {project_id}");
            return Ok(());
        }

        let count = sessions.len();
        let pid = project_id.to_string();
        tokio::task::spawn_blocking(move || {
            for (tab_id, session) in sessions {
                if let Ok(mut k) = session.killed.lock() {
                    *k = true;
                }
                if let Some(mut child) = session.child.lock().ok().and_then(|mut g| g.take()) {
                    if let Err(e) = child.kill() {
                        log::warn!("shell_run kill_project: kill session {tab_id}: {e}");
                    }
                    if let Err(e) = child.wait() {
                        log::warn!("shell_run kill_project: wait session {tab_id}: {e}");
                    }
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?;

        log::info!("shell_run kill_project: closed {count} session(s) for {pid}");
        Ok(())
    }
}
