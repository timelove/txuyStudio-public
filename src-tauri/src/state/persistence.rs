//! 持久化壳:Tauri AppHandle → state.json 路径解析,读写委托 `txuy-core`(纯路径版)。
//!
//! 路径 `<AppData>/txuyStudio[-dev]/state.json`。dev/prod 分目录防互相覆盖;
//! 解析失败回退空快照(log 内),不阻断启动——容错语义全在 core 侧。

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use super::AppSnapshot;

/// state.json 的完整路径：`<app_data_dir>/txuyStudio/state.json`。
fn state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    // dev(debug 构建)用独立子目录 `txuyStudio-dev`,release 用 `txuyStudio`,
    // 防 dev 与 prod 共用同一 state.json 互相覆盖(dev 测试数据不污染 prod 已存项目/会话)。
    let sub = if cfg!(debug_assertions) { "txuyStudio-dev" } else { "txuyStudio" };
    Ok(base.join(sub).join("state.json"))
}

/// 从磁盘读取快照(委托 core;路径解析失败回退空快照)。
pub fn load(app: &AppHandle) -> AppSnapshot {
    let path = match state_file_path(app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[state] cannot resolve state path: {e}");
            return AppSnapshot::default();
        }
    };
    txuy_core::state::persistence::load(&path)
}

/// 把快照序列化并写盘(委托 core)。
pub fn save(app: &AppHandle, snapshot: &AppSnapshot) -> Result<(), String> {
    let path = state_file_path(app)?;
    txuy_core::state::persistence::save(&path, snapshot)
}
