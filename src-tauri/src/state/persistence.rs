//! 持久化：把 [`AppSnapshot`] 序列化为 JSON 落到 Tauri app data 目录。
//!
//! 路径 `<AppData>/txuyStudio[-dev]/state.json`。解析失败时回退空快照并记日志，
//! **不阻断启动**（与设计「风险与回退」一致）。

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

/// 从磁盘读取快照。文件不存在或解析失败均回退 [`AppSnapshot::default`]，
/// 并把失败原因打到 stderr，不向上抛错（保证启动健壮）。
pub fn load(app: &AppHandle) -> AppSnapshot {
    let path = match state_file_path(app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[state] cannot resolve state path: {e}");
            return AppSnapshot::default();
        }
    };

    if !path.exists() {
        return AppSnapshot::default();
    }

    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("[state] read {} failed: {e}", path.display());
            return AppSnapshot::default();
        }
    };

    // 先解析成弱类型 Value,做旧形态 pane(单终端,无 tabs) → 新形态(单 tab 栈)的一次性迁移,
    // 再 from_value 成强类型 AppSnapshot。集中一处兼容,避免在 PaneNode 上堆 fallback。
    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(mut value) => {
            migrate_pane_nodes(&mut value);
            match serde_json::from_value::<AppSnapshot>(value) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("[state] parse state.json failed: {e}");
                    AppSnapshot::default()
                }
            }
        }
        Err(e) => {
            log::warn!("[state] parse state.json failed: {e}");
            AppSnapshot::default()
        }
    }
}

/// 把快照序列化并写盘（先 `create_dir_all` 父目录）。
///
/// 写失败时返回 Err，由调用方决定是否提示用户；启动期的 load 不经此路径。
pub fn save(app: &AppHandle, snapshot: &AppSnapshot) -> Result<(), String> {
    let path = state_file_path(app)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create state dir: {e}"))?;
    }

    let json = serde_json::to_string_pretty(snapshot).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write state.json: {e}"))
}

/// 递归迁移 pane tree 节点:把旧形态 pane(单终端,无 `tabs` 字段)补成新形态
/// (单 tab,id 复用 pane.id,activeTabId 同)。新形态(已有 `tabs`)原样保留。
///
/// 在 `load` 里 `from_slice::<Value>` 之后、`from_value::<AppSnapshot>` 之前调用,
/// 集中一处兼容旧 state.json,避免在 `PaneNode` 类型层堆 fallback。
///
/// 遍历策略:`type == "pane"` 且无 `tabs` 键 → 用 `id`/`shellKind`/`title`/`cwd` 造单 tab;
/// 其余对象(含 split / 项目记录 / 快照根)递归进各字段值(可能含嵌套 `paneTree`)。
fn migrate_pane_nodes(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(obj) => {
            let is_pane = obj
                .get("type")
                .and_then(|v| v.as_str())
                .map(|s| s == "pane")
                .unwrap_or(false);
            if is_pane && !obj.contains_key("tabs") {
                // 旧形态 → 单 tab。id/shellKind/title/cwd 从叶子字段取(缺失给默认)。
                let id = obj
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("ps-1")
                    .to_string();
                let shell_kind = obj
                    .get("shellKind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("shell")
                    .to_string();
                let title = obj
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("PowerShell")
                    .to_string();
                let cwd = obj.get("cwd").cloned();
                let tab = serde_json::json!({
                    "id": id,
                    "shellKind": shell_kind,
                    "title": title,
                    "cwd": cwd,
                });
                // 删旧叶子字段(新形态不认),装 tabs + activeTabId。
                obj.remove("shellKind");
                obj.remove("title");
                obj.remove("cwd");
                obj.insert("tabs".to_string(), serde_json::Value::Array(vec![tab]));
                obj.insert("activeTabId".to_string(), serde_json::Value::String(id));
                return; // 该子树已转好,无需再递归其字段。
            }
            // 非 pane / 已是新形态:递归各字段值(可能含嵌套 paneTree)。
            for (_k, v) in obj.iter_mut() {
                migrate_pane_nodes(v);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr.iter_mut() {
                migrate_pane_nodes(v);
            }
        }
        _ => {}
    }
}
