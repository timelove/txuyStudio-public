//! 应用级状态(Tauri 壳层):类型与纯路径持久化已抽至 `txuy-core`(P0),此处
//! re-export 保持 `crate::state::*` 引用路径稳定;Tauri command 实现见 [`commands`],
//! AppHandle 路径解析的持久化壳见 [`persistence`]。

pub mod commands;
pub mod persistence;

pub use txuy_core::state::{
    AppSnapshot, AppState, PaneNode, ProjectRecord, WindowBounds, archive_recent,
    collect_tab_ids, default_pane_tree, now_ms, set_active_for_window,
};
