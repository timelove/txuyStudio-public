//! 应用级状态:多项目工作台的项目列表与持久化身份层。
//!
//! 这里只定义数据类型与 [`AppState`] 容器;Tauri command 实现见
//! [`crate::state::commands`],磁盘读写见 [`crate::state::persistence`]。
//!
//! 与 `pty` 模块的关系:本阶段(阶段2)`AppState` 与 `PtyRegistry` 保持为两个
//! 独立的 managed state;阶段3 做 PTY 项目隔离时再把 PTY 归属到 `projectId` 下。
//! 二者均遵守 `std::sync::Mutex`「持锁不跨 .await」约束。

use std::collections::HashMap;
use std::sync::Mutex;

pub mod commands;
pub mod persistence;

/// 分屏方向:Horizontal=左右两列,Vertical=上下两行。与前端 `SplitDirection` 对齐。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

/// 单个 tab 的持久化配置(一个 pane 内叠多个 tab)。
///
/// `id` 即 PTY sessionId,贯穿前端 transport 池 / React key。与前端 `PaneTab` 对齐(camelCase)。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneTab {
    pub id: String,
    #[serde(rename = "shellKind")]
    pub shell_kind: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Windows Terminal 式分屏树节点:叶子是 `Pane`,分支是 `Split`。
///
/// `Pane` 叶子内叠多个 `PaneTab`(tab 栈),`active_tab_id` 指向当前可见 tab。
/// tab 关到 0 个 = pane 被关(前端在树层回填)。旧数据(无 tabs 的单终端 pane)由
/// `persistence::load` 做一次性迁移,这里只认新形态。
///
/// `tag = "type"` 让序列化为 `{ "type": "pane" | "split", ... }`,与前端 `PaneNode` 对齐。
/// 注意:serde 对内部标签(internally tagged)enum 的变体**字段**不应用容器的 `rename_all`,
/// 因此每个需 camelCase 的字段都要显式 `#[serde(rename = ...)]`。
/// PTY 进程不持久化——启动时按 tab 配置重新 spawn。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PaneNode {
    Pane {
        id: String,
        tabs: Vec<PaneTab>,
        #[serde(rename = "activeTabId")]
        active_tab_id: String,
    },
    Split {
        id: String,
        direction: SplitDirection,
        ratio: f64,
        /// 固定二元;用 Vec 便于 serde,前端约束长度为 2。
        children: Vec<PaneNode>,
    },
}

/// 单个项目的持久化记录(身份层)。
///
/// 不持久化:transcript、session 运行状态、git 信息、PTY 句柄。
/// `lastOpenedMs` 用于排序与「最近打开」展示。`paneTree` 为旧数据兼容用 Option,
/// 缺失时前端 deriver 回退默认单 PowerShell pane。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub last_opened_ms: u128,
    pub pane_tree: Option<PaneNode>,
    /// ClaudePane 工具白名单(claude `--allowedTools`):用户在确认框点「批准且不再问」时累加,
    /// 后续 spawn claude 时带上,该工具免确认。空 Vec 不写盘(`skip_serializing_if`),
    /// 旧 state.json 无此字段 → `#[serde(default)]` 空数组,零迁移(同 `locale`/`terminal_font_size`)。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub claude_allowed_tools: Vec<String>,
    /// 每个 claudepane tab 的 claude 会话 id(tabId -> sessionId)。持久化以支持跨应用重启 --resume
    /// 续接同一会话:ClaudeRegistry 仅内存,重启即丢;init 事件回填时写盘,start_claude_session 首启
    /// 时读作 --resume 的 id。独立于 pane_tree(前端 save_pane_tree 重建 tab 不影响此 map),后端独占管理;
    /// 关 tab 时由 save_pane_tree 修剪(移除新 tree 中已不存在 tab 的项)。HashMap + serde default
    /// 兼容旧 state.json 缺字段,无需迁移。
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub claude_tab_sessions: HashMap<String, String>,
}

/// 原生窗口大小/位置,由 `save_window_bounds` 持久化。
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 应用快照:项目列表 + active 项目 + 主窗口 bounds + 界面语言。
///
/// 直接 `Serialize` 作为 `hydrate_window` 等命令的返回值,供前端 hydrate。
#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub projects: Vec<ProjectRecord>,
    pub active_project_id: Option<String>,
    /// 阶段2 仅持久化主窗口 bounds;独立窗口 bounds 留待阶段4/5。
    pub main_window_bounds: Option<WindowBounds>,
    /// 界面语言偏好("zh"/"en")。None = 跟随系统/默认,由前端按 navigator.language 推断。
    /// Option + serde default 天然兼容旧 state.json 缺字段(无 locale → None),无需迁移。
    pub locale: Option<String>,
    /// 终端 + Monaco 编辑器字体大小(px)。None = 用前端默认值(13)。
    /// Option + serde default 天然兼容旧 state.json 缺字段(无该字段 → None),无需迁移。
    pub terminal_font_size: Option<u32>,
    /// 界面主题 id("midnight"/"one-dark")。None = 默认(midnight)。
    /// Option + serde default 兼容旧 state.json 缺字段,无需迁移。
    pub theme_id: Option<String>,
    /// Codex 会话默认 sandbox 档位(codex exec -s:"read-only"/"workspace-write"/
    /// "danger-full-access")。None = 前端默认(workspace-write)。仅影响新建 codex 会话,
    /// 已开会话在其状态栏单独切换。Option + serde default 兼容旧 state.json,无需迁移。
    pub codex_sandbox: Option<String>,
}

/// 全局应用状态容器:`State<Mutex<AppSnapshot>>`。
///
/// 不 derive `Default`:初始值由 `persistence::load` 从磁盘读出(失败回退空),
/// 在 `lib.rs` 的 `setup` 中构造并 `manage`。所有 command 在锁作用域内完成
/// 快照克隆后立即释放锁,再返回克隆——绝不持锁跨 `.await`。
pub struct AppState {
    pub inner: Mutex<AppSnapshot>,
}

impl AppState {
    pub fn new(snapshot: AppSnapshot) -> Self {
        Self {
            inner: Mutex::new(snapshot),
        }
    }
}

/// 默认 pane tree:单根 pane + 单 PowerShell tab。新项目 / 旧数据迁移用。
pub fn default_pane_tree() -> PaneNode {
    PaneNode::Pane {
        id: "ps-1".to_string(),
        tabs: vec![PaneTab {
            id: "ps-1".to_string(),
            shell_kind: "shell".to_string(),
            title: "PowerShell".to_string(),
            cwd: None,
        }],
        active_tab_id: "ps-1".to_string(),
    }
}

/// 收集 pane tree 中所有 tab id(递归)。供 save_pane_tree 修剪 claude_tab_sessions 陈旧项
/// (关 tab 后其 session_id 不再需要,移除防 map 无界增长)。
pub fn collect_tab_ids(root: &PaneNode) -> Vec<String> {
    match root {
        PaneNode::Pane { tabs, .. } => tabs.iter().map(|t| t.id.clone()).collect(),
        PaneNode::Split { children, .. } => children.iter().flat_map(collect_tab_ids).collect(),
    }
}

/// 取当前时间的毫秒时间戳,用作 `lastOpenedMs`。
pub fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
