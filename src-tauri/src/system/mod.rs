//! 系统环境只读查询:内存占用 + git 分支 + AI CLI(Claude/Codex)会话列表。
//!
//! 与 `pty/`/`state/` 平级,职责是「不触碰工作区可变状态的环境信息查询」,
//! 因此命令无锁、无 managed state,每次请求自取数据。

pub mod commands;

/// 系统内存占用快照。前端底部状态栏用 `percent` 显示 `MEM xx%`。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
}

/// 单个 AI CLI(Claude / Codex)会话的列表项(轻量,不含消息正文)。
///
/// 由 `list_ai_cli_sessions` 按 `kind` 分发到对应 reader 扫描得到:sessionId 取文件名;
/// 标题取最后一条 `ai-title`(Claude)或首条 `user_message`(Codex);起止时间取首/末带
/// `timestamp` 的行;消息数计对话规模。Claude 与 Codex 存储路径/格式不同,但归一为同一结构。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCliSessionListItem {
    /// 该会话所属 AI CLI provider id("claude" / "codex" / 后期扩展)。
    pub provider_id: String,
    /// 会话 id:Claude = jsonl 文件名 uuid;Codex = rollout 文件名末段 uuid。
    /// 注意:与本应用 PTY 的 sessionId(spawn_pty 生成的 UUIDv4)是两套体系,不可混用。
    pub session_id: String,
    /// 会话标题:Claude 取最后一条 ai-title(回退 summary);Codex 取首条 user_message(截断)。
    pub title: Option<String>,
    /// 首行带 timestamp 的 ISO8601 串(会话开始)。
    pub started_at: Option<String>,
    /// 末行带 timestamp 的 ISO8601 串(最近活动)。
    pub last_at: Option<String>,
    /// 对话规模:Claude 计非 sidechain 的 user/assistant 行数;Codex 计 user_message 事件数。
    pub message_count: u32,
    /// git 分支:Claude 取首行 gitBranch(非 git 为 "HEAD");Codex 取 session_meta.git.branch。
    pub git_branch: Option<String>,
    /// 真实项目路径:从行内 cwd 字段反推(两者目录名/路径都不直接等于 cwd)。
    pub cwd: Option<String>,
}

/// 单条 AI CLI 会话消息(消息流详情,用于会话列表右栏展示)。
///
/// 由 `get_ai_cli_session_messages` 逐行解析 jsonl 得到:role 只发 "user"/"assistant"
/// (跳过 developer/sidechain/system);text 为拼接纯文本;tool_use/tool_result 为摘要(大字段裁剪)。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCliSessionMessage {
    /// "user" | "assistant"。
    pub role: String,
    /// 顶层 timestamp(ISO8601)。
    pub timestamp: Option<String>,
    /// 拼接后的纯文本正文(user 输入 / assistant 回复主文本)。
    pub text: String,
    /// assistant 调用工具时填(name + input 摘要)。
    pub tool_use: Option<ToolUseSummary>,
    /// user 行承载 tool_result 时填(摘要,截断)。
    pub tool_result: Option<String>,
}

/// 工具调用摘要(assistant 的 tool_use 块 / codex function_call)。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUseSummary {
    /// 工具名(claude: Bash/Read/Edit/WebFetch...;codex: function_call.name)。
    pub name: String,
    /// input/arguments 序列化后截断的摘要(只够看出「调了啥」)。
    pub input_brief: String,
}

/// AI CLI provider 注册表项(供前端下拉框渲染)。加新 CLI 时在此注册一条。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCliProviderInfo {
    /// provider id("claude" / "codex" / ...),与 list/get/delete 命令的 kind 参数一致。
    pub id: String,
    /// 显示名(下拉框选项文本)。
    pub label: String,
}

