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

/// 项目归属窗口的默认值(旧 state.json 无 `ownerWindow` 字段时的回填)。
fn default_owner_window() -> String {
    "main".to_string()
}

/// 单个项目的持久化记录(身份层)。
///
/// 不持久化:transcript、session 运行状态、git 信息、PTY 句柄。
/// `lastOpenedMs` 用于排序与「最近打开」展示。`paneTree` 为旧数据兼容用 Option,
/// 缺失时前端 deriver 回退默认单 PowerShell pane。
/// `ownerWindow` = 承载该项目的窗口 label("main" / "workspace-N"):多主窗口时代
/// 项目按窗口隔离,hydrate 只回本窗口的项目。旧数据 serde default 回填 "main"。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub root_path: String,
    #[serde(default = "default_owner_window")]
    pub owner_window: String,
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
    /// 最近项目历史(关闭/工作台窗口关窗时归档的项目记录,rootPath 去重、最新在前)。
    /// + 菜单「历史项目」数据源:点击重开(整份记录原样移回 projects,布局/claude 会话
    /// 映射保留),✕ 删除。空 Vec 不写盘,旧 state.json 缺字段 -> default 空,零迁移。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent_projects: Vec<ProjectRecord>,
    /// 各工作台窗口(workspace-N)的 active 项目 id(label -> projectId)。
    /// main 窗口的 active 沿用 `active_project_id` 旧字段(语义不变,零迁移)。
    /// 空 HashMap 不写盘,旧 state.json 缺字段 -> default 空。
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub workspace_active: HashMap<String, String>,
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

/// 历史项目上限:超长截尾(最旧淘汰),防 state.json 无界增长。
pub const RECENT_PROJECTS_LIMIT: usize = 10;

/// 按窗口设置 active 项目:main 写 `active_project_id`(旧字段,语义不变),
/// workspace-N 写 `workspace_active[label]`。供 open/set_active/open_recent 共用。
pub fn set_active_for_window(snap: &mut AppSnapshot, window_label: &str, project_id: &str) {
    if window_label == "main" {
        snap.active_project_id = Some(project_id.to_string());
    } else {
        snap.workspace_active.insert(window_label.to_string(), project_id.to_string());
    }
}

/// 把项目记录归档进最近项目历史:同 rootPath 旧条目先移除,新条目插头部,超长截尾。
/// 供 close_project 与工作台窗口关窗归档共用。
pub fn archive_recent(snap: &mut AppSnapshot, records: Vec<ProjectRecord>) {
    for rec in records {
        snap.recent_projects.retain(|p| p.root_path != rec.root_path);
        snap.recent_projects.insert(0, rec);
    }
    snap.recent_projects.truncate(RECENT_PROJECTS_LIMIT);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 旧 state.json(无 ownerWindow/recentProjects/workspaceActive 字段)反序列化兼容:
    /// 项目 owner 回填 "main",历史/窗口 active 为空。锁定「多窗口字段零迁移」承诺。
    #[test]
    fn legacy_state_json_defaults() {
        let legacy = r#"{
            "projects": [{
                "id": "p1",
                "name": "demo",
                "rootPath": "D:\\demo",
                "lastOpenedMs": 123
            }],
            "activeProjectId": "p1"
        }"#;
        let snap: AppSnapshot = serde_json::from_str(legacy).expect("legacy state.json must parse");
        assert_eq!(snap.projects.len(), 1);
        assert_eq!(snap.projects[0].owner_window, "main");
        assert!(snap.recent_projects.is_empty());
        assert!(snap.workspace_active.is_empty());
    }

    /// 新字段 camelCase 序列化往返:ownerWindow/recentProjects/workspaceActive 原样保留
    /// (防 rename_all 漏配导致前端读空,同 claude 序列化回归测试动机)。
    #[test]
    fn snapshot_roundtrip_multivindow_fields() {
        let mut snap = AppSnapshot::default();
        snap.projects.push(ProjectRecord {
            id: "p2".into(),
            name: "ws".into(),
            root_path: "D:\\ws".into(),
            owner_window: "workspace-2".into(),
            last_opened_ms: 456,
            pane_tree: None,
            claude_allowed_tools: vec![],
            claude_tab_sessions: Default::default(),
        });
        snap.workspace_active.insert("workspace-2".into(), "p2".into());
        snap.recent_projects.push(ProjectRecord {
            id: "p3".into(),
            name: "old".into(),
            root_path: "D:\\old".into(),
            owner_window: "main".into(),
            last_opened_ms: 1,
            pane_tree: None,
            claude_allowed_tools: vec![],
            claude_tab_sessions: Default::default(),
        });

        let json = serde_json::to_string(&snap).expect("serialize");
        assert!(json.contains("\"ownerWindow\":\"workspace-2\""));
        assert!(json.contains("\"recentProjects\""));
        assert!(json.contains("\"workspaceActive\""));
        let back: AppSnapshot = serde_json::from_str(&json).expect("roundtrip parse");
        assert_eq!(back.projects[0].owner_window, "workspace-2");
        assert_eq!(back.workspace_active.get("workspace-2").map(String::as_str), Some("p2"));
        assert_eq!(back.recent_projects[0].root_path, "D:\\old");
    }

    /// 归档语义:rootPath 去重(旧的被新的顶掉)、最新在前、超限截尾。
    #[test]
    fn archive_recent_dedup_and_limit() {
        let mut snap = AppSnapshot::default();
        let rec = |id: &str, root: &str| ProjectRecord {
            id: id.into(),
            name: id.into(),
            root_path: root.into(),
            owner_window: "main".into(),
            last_opened_ms: 0,
            pane_tree: None,
            claude_allowed_tools: vec![],
            claude_tab_sessions: Default::default(),
        };
        archive_recent(&mut snap, vec![rec("a", "D:\\a"), rec("b", "D:\\b")]);
        archive_recent(&mut snap, vec![rec("a2", "D:\\a")]);
        // 同 rootPath 去重:旧的 a 被新的 a2 顶掉,只剩一份且在头部(最新在前)。
        let a_entries: Vec<&ProjectRecord> =
            snap.recent_projects.iter().filter(|p| p.root_path == "D:\\a").collect();
        assert_eq!(a_entries.len(), 1);
        assert_eq!(a_entries[0].id, "a2");
        for i in 0..12 {
            archive_recent(&mut snap, vec![rec(&format!("n{i}"), &format!("D:\\n{i}"))]);
        }
        assert_eq!(snap.recent_projects.len(), RECENT_PROJECTS_LIMIT);
        assert_eq!(snap.recent_projects[0].id, "n11");
    }
}
