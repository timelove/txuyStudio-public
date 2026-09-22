//! PTY 会话领域模型与全局状态容器。
//!
//! 这里只定义数据类型与状态，不写 Tauri command 逻辑、不写 tokio 异步循环。
//! command 实现见 [`crate::pty::commands`]。

use std::collections::HashMap;
use std::sync::Mutex;

use portable_pty::{Child, MasterPty};

pub mod commands;

/// 单个 PTY 会话持有的句柄。
///
/// - `writer`：向 shell 写入用户输入（master.take_writer）。
/// - `child`：子进程句柄，用于 kill。
/// - `master`：PTY master 端，resize 在它上面调用。
/// - `transcript`：输出字节环形缓存（上限 `PTY_TRANSCRIPT_MAX`）。WebView 被系统
///   回收/休眠唤醒后前端整页重载，前端内存态 transcript 全丢——后端缓存用于重载后
///   重新 attach 时回放，保住滚动历史、TUI 屏幕状态与最后已知 cwd。Arc 与读循环共享。
///
/// 注意：reader（master.try_clone_reader）是一次性使用，已在 spawn 时取走并
/// 移交给 spawn_blocking 线程，因此不在这里持有。
pub struct PtySession {
    pub writer: Box<dyn std::io::Write + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    pub master: Box<dyn MasterPty + Send>,
    pub transcript: std::sync::Arc<Mutex<Vec<u8>>>,
}

/// 单会话输出缓存上限（字节）。约等于几千行滚动历史，多会话内存占用可控。
pub const PTY_TRANSCRIPT_MAX: usize = 256 * 1024;

/// `pty-output` 事件的载荷。emit 要求 `Serialize + Clone`。
///
/// `rename_all = "camelCase"` 让前端拿到 `{ projectId, sessionId, data }`。
/// **必须带 `project_id`**:事件是全局广播,前端按 (projectId, sessionId) 双键路由。
/// 各项目默认 pane 的 sessionId 恒为 `ps-1`(default_pane_tree 固定),若只按 sessionId
/// 过滤,项目 A/B 的 `ps-1` transport 会同时命中彼此的 shell 输出——跨项目输出互串
/// (另一个项目的提示符/OSC cwd 标记渲染进本面板)。projectId 让隔离真正成立。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutput {
    pub project_id: String,
    pub session_id: String,
    /// PTY 原始字节经 `String::from_utf8_lossy` 解码后的字符串（MVP 保真够用）。
    pub data: String,
}

/// 全局 PTY 会话注册表，按项目分桶：`projectId → (sessionId → PtySession)`。
///
/// 外层 key 即 PTY 归属（项目隔离），无需在 `PtySession` 内冗余存 projectId。
/// 使用 `std::sync::Mutex`，严格遵守「持锁不跨 .await」——所有 command 都在
/// 锁作用域内完成同步操作并立即释放锁；阻塞的 kill/wait 丢进 `spawn_blocking`，
/// 且锁在进入前已释放。
#[derive(Default)]
pub struct PtyRegistry {
    pub by_project: Mutex<HashMap<String, HashMap<String, PtySession>>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// pty-output 载荷契约:必须带 projectId(前端按 projectId+sessionId 双键路由)。
    /// 锁定 camelCase 映射——若字段名/序列化漏配,前端拿不到 projectId,跨项目 ps-1
    /// 互串会复现(默认 pane 的 sessionId 全项目恒为 "ps-1",单靠 sessionId 无法隔离)。
    #[test]
    fn pty_output_payload_has_project_id() {
        let out = PtyOutput {
            project_id: "p-a".into(),
            session_id: "ps-1".into(),
            data: "hello".into(),
        };
        let json = serde_json::to_string(&out).expect("serialize");
        assert!(json.contains("\"projectId\":\"p-a\""), "payload missing projectId: {json}");
        assert!(json.contains("\"sessionId\":\"ps-1\""));
    }
}

impl PtyRegistry {
    /// 关闭某项目的全部 PTY 会话（用于 `close_project`）。
    ///
    /// 持锁不跨 await：在极短锁作用域内 `remove` 整个项目桶并放锁，再把阻塞的
    /// kill/wait 丢进 `spawn_blocking`。桶不存在视为幂等成功（空 HashMap → Ok）。
    /// session drop 时 master 一并释放，reader 线程随之收 EOF 退出。
    pub async fn kill_project(&self, project_id: &str) -> Result<(), String> {
        let sessions = {
            let mut by_project = self.by_project.lock().map_err(|e| e.to_string())?;
            by_project.remove(project_id).unwrap_or_default()
        }; // 锁在此释放，绝不跨 await。

        if sessions.is_empty() {
            log::info!("kill_project: no sessions for {project_id}");
            return Ok(());
        }

        let count = sessions.len();
        let pid = project_id.to_string();
        tokio::task::spawn_blocking(move || {
            for (sid, mut session) in sessions {
                // 杀整棵树(taskkill /F /T):孙进程不死会持有 ConPTY 句柄,
                // 读循环线程 + transcript 永久泄漏(见 kill_pty_child_tree 注释)。
                commands::kill_pty_child_tree(&mut session.child);
                let _ = sid;
            }
        })
        .await
        .map_err(|e| e.to_string())?;

        log::info!("kill_project: closed {count} session(s) for {pid}");
        Ok(())
    }

    /// 应用退出时同步杀掉全部 PTY 会话(不跨 await;ExitRequested 回调中 runtime 即将关闭,
    /// 不能再 spawn_blocking)。锁内 drain、锁外杀树收尸。
    pub fn kill_all_blocking(&self) {
        let drained: HashMap<String, HashMap<String, PtySession>> =
            self.by_project.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default();
        let mut count = 0usize;
        for (_, sessions) in drained {
            for (_sid, mut session) in sessions {
                count += 1;
                commands::kill_pty_child_tree(&mut session.child);
            }
        }
        if count > 0 {
            log::info!("kill_all_blocking(pty): closed {count} session(s)");
        }
    }
}
