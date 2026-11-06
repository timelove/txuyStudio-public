//! 供应商配置镜像:桌面 WebView localStorage → Rust 侧 providers.json。
//!
//! providers 的**真源**仍在桌面 localStorage(`claudeProviders.ts` 直读写);本模块只是
//! 一份只读镜像,让手机端(relay `chat.models` / `chat.setProviderModel`)能拿到分组与
//! 完整 env 生成所需字段——WebView localStorage Rust 读不到,后端化真源是更大的重构,
//! 镜像桥让两端渐进共存。前端每次保存/启动时推一次(幂等)。
//!
//! 手机切换后桌面如何感知:settings.json 的 env 哈希检测(`claude_settings_changed` /
//! 打开模型选择器时)本就存在,cc-switch 等外部工具改写同文件走同一条路,无需新通知。

use std::collections::BTreeMap;

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// providers.json 路径:与 state.json 同目录(`<app_data>/txuyStudio[-dev]/`)。
fn mirror_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    let sub = if cfg!(debug_assertions) {
        "txuyStudio-dev"
    } else {
        "txuyStudio"
    };
    Ok(base.join(sub).join("providers.json"))
}

/// 桌面端推镜像(前端 saveClaudeProviders / 启动时调用;数组原样落盘)。
#[tauri::command]
pub async fn save_providers_snapshot(app: AppHandle, providers: Value) -> Result<bool, String> {
    let path = mirror_path(&app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "bad mirror path".to_string())?
        .to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&path, serde_json::to_vec(&providers).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// 读镜像(缺失/损坏返回空数组)。
pub fn load_providers(app: &AppHandle) -> Vec<Value> {
    let Ok(path) = mirror_path(app) else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

/// provider 镜像 → 完整 env 段(与前端 `providerEnv` 同口径:extraEnv 合并 +
/// baseUrl/token/model 三键;token 按认证字段落 AUTH_TOKEN / API_KEY 之一;键序无关,
/// BTreeMap 落盘稳定)。
pub fn provider_env(p: &Value) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    if let Some(extra) = p.get("extraEnv").and_then(|e| e.as_object()) {
        for (k, v) in extra {
            if let Some(s) = v.as_str() {
                if !s.is_empty() {
                    env.insert(k.clone(), s.to_string());
                }
            }
        }
    }
    for (key, field) in [
        ("ANTHROPIC_BASE_URL", "baseUrl"),
        ("ANTHROPIC_MODEL", "model"),
    ] {
        if let Some(s) = p.get(field).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                env.insert(key.to_string(), s.to_string());
            }
        }
    }
    if let Some(token) = p.get("token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        let key = if p.get("authStyle").and_then(|v| v.as_str()) == Some("api_key") {
            "ANTHROPIC_API_KEY"
        } else {
            "ANTHROPIC_AUTH_TOKEN"
        };
        env.insert(key.to_string(), token.to_string());
    }
    env
}

/// 该 provider **已配置**的模型(与前端 `configuredModelsOf` 同口径:默认 model 打头,
/// extraEnv 的 `*_MODEL` 追加,排除 `*_NAME` 显示名键;去重保序)。
pub fn configured_models(p: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |v: Option<&str>| {
        let t = v.unwrap_or("").trim();
        if !t.is_empty() && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    };
    push(p.get("model").and_then(|v| v.as_str()));
    if let Some(extra) = p.get("extraEnv").and_then(|e| e.as_object()) {
        for (k, v) in extra {
            if k.ends_with("_MODEL") && !k.ends_with("_NAME") {
                push(v.as_str());
            }
        }
    }
    out
}

/// 当前 `~/.claude/settings.json` 的 env 段(缺失返回空表)。
pub fn current_settings_env() -> BTreeMap<String, String> {
    crate::claude::commands::claude_settings_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        .and_then(|v| v.get("env").cloned())
        .and_then(|e| serde_json::from_value::<BTreeMap<String, String>>(e).ok())
        .unwrap_or_default()
}

/// 该 provider 是否当前生效(BASE_URL + AUTH_TOKEN/API_KEY(按认证字段实际落的那个)+
/// MODEL 逐一比对,与前端 `isProviderActive` 同口径;extraEnv 开关类键不参与判定)。
pub fn is_active(p: &Value, current: &BTreeMap<String, String>) -> bool {
    let env = provider_env(p);
    let get = |k: &str| env.get(k).map(|s| s.as_str());
    let cur = |k: &str| current.get(k).map(|s| s.as_str());
    // baseUrl/token 至少配了一个才谈得上「生效」(全空 provider 不匹配)。
    if get("ANTHROPIC_BASE_URL").is_none()
        && get("ANTHROPIC_AUTH_TOKEN").is_none()
        && get("ANTHROPIC_API_KEY").is_none()
    {
        return false;
    }
    for key in [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
    ] {
        match (get(key), cur(key)) {
            (Some(a), Some(b)) if a == b => {}
            (None, None) => {}
            _ => return false,
        }
    }
    true
}
