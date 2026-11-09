//! Fleet Worker 领域:worktree 隔离的多 AI 并行会话(command 边界)。
//!
//! worker = 自带 git worktree 的 claude/codex 会话。与 orca 的 coordinator/worker 借鉴点
//! 一致:一个 worker 一个独立 worktree(磁盘收拢在项目外兄弟目录 `<项目根>-fleet/<taskId>`),
//! AI 在里面改代码互不干扰,主仓工作区始终干净;完成后合并回流。
//!
//! 关键架构决策:**worker tab 就是一个普通 tab**。`shellKind` 仍是 "claudepane"/"codexpane",
//! 只是 `tab.cwd` 指向 worktree、title 带分支名——渲染/审批/快捷键/手机伴侣全套现有设施零改动
//! 复用。本模块只管 worktree/分支/合并生命周期,不碰会话进程(那是 claude/codex 领域的事)。
//!
//! 持久化:`ProjectRecord.fleet_workers`(txuy-core),serde default + skip_serializing_if
//! 零迁移(同 `claude_allowed_tools` 先例)。运行期 busy 状态不持久化——hydrate 后由各引擎
//! registry 与 tab 重挂载恢复。
//!
//! 约定(与 state/claude 模块一致):`std::sync::Mutex` 持锁不跨 `.await`——短锁内完成
//! Vec/记录变更并克隆,放锁后再 `persistence::save`;git 是阻塞 IO,一律 `spawn_blocking`。

pub mod commands;
pub mod git;

/// worker worktree 子目录里要拷贝的主仓 untracked 本地文件(固定清单)。
/// worktree add 只带 tracked 文件,`.env` 等本地配置(gitignore 覆盖)需要手动拷,
/// 否则 AI 在 worker 里跑不起构建。**签名材料(companion keystore/key.properties)
/// 绝不拷**(见记忆 signing-materials-in-private-repo:绝不进公开仓/外发目录)。
pub const UNTRACKED_COPY_LIST: &[&str] = &[".env", ".env.local"];

/// 分支名前缀:worker 分支固定 `fleet/<taskId>`。
pub fn fleet_branch(task_id: &str) -> String {
    format!("fleet/{task_id}")
}
