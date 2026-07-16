//! 嵌入式文件树数据源:list_dir(只读列一层)+ notify 实时监听。
//!
//! 与 pty/state/system 平级。`list_dir` 是只读命令(无工作区可变状态);
//! `FsWatcherRegistry` 仿 `PtyRegistry`:`Mutex<HashMap<projectId, WatcherHandle>>`,持锁不跨 await。
//! command 实现见 [`crate::filetree::commands`]。

use std::collections::HashMap;
use std::sync::Mutex;

use notify::RecommendedWatcher;

pub mod commands;

/// 单个目录条目(只读一层;前端 react-arborist 懒加载逐层调 list_dir)。
///
/// `id` 用绝对路径字符串:react-arborist 要求 idAccessor 返回 string 且全局唯一,
/// Windows 路径天然唯一;前端 childrenAccessor/onToggle 直接拿 id 作 list_dir 的 path,
/// 免维护 id↔path 映射。`modified` 为 unix 秒(前端按 locale 格式化,避免后端引入 chrono)。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub id: String,
    pub name: String,
    /// "dir" | "file"。
    pub kind: String,
    /// 文件字节数;目录为 None。
    pub size: Option<u64>,
    /// mtime 的 unix 秒(UTC)。
    pub modified: Option<u64>,
}

/// `fs-change` 事件载荷。emit 要求 Serialize + Clone。
///
/// `paths` 为防抖窗口内聚合的变更路径(原始路径,前端按父目录刷新对应已展开节点)。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub project_id: String,
    pub paths: Vec<String>,
}

/// `read_file` 返回:文件预览内容(只读,供前端 Monaco/img 渲染)。
///
/// - 图片类(`is_image` 由扩展名推):`content` 为 base64 编码、`mime` 填 `"image/png"` 等,
///   前端拼 `data:<mime>;base64,<content>` 喂 `<img>`;不截断(图片通常 < 几 MB)。
/// - 文本类:`content` 为 UTF-8 文本(>512KB 截断到前 512KB,`truncated=true`),`mime` 为 None。
/// - 不可预览(非文本且非图片,含 NUL/非 UTF-8):`content`/`mime` 为 None,`binary=true`。
/// `size` 恒为完整文件大小(字节),前端据此显示「二进制 / 已截断」提示。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    pub content: Option<String>,
    pub mime: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub size: u64,
}

/// 单个项目的 watcher 句柄 + 引用计数。
///
/// 多个 filetree pane(同项目)共享一个递归 watcher;最后一个 pane 卸载(count→0)才真正 stop。
/// `watcher` drop 即停止监听,事件线程随之收 channel Disconnected 退出。
pub struct WatcherHandle {
    /// 持有即生效:存在 Registry 期间持续监听;drop 时停止监听(事件线程随之收 channel Disconnected 退出)。
    /// 从不被显式读取(仅靠 drop 语义生效),故 allow(dead_code)。
    #[allow(dead_code)]
    pub watcher: RecommendedWatcher,
    pub count: u32,
}

/// 全局 watcher 注册表,按 projectId 分桶(与 `PtyRegistry` 同构)。
///
/// 使用 `std::sync::Mutex`,严格遵守「持锁不跨 await」:所有命令在极短锁作用域内完成
/// peek/count/remove 后立即放锁;notify watcher 创建(可能阻塞)与事件循环均在锁外。
#[derive(Default)]
pub struct FsWatcherRegistry {
    pub by_project: Mutex<HashMap<String, WatcherHandle>>,
}
