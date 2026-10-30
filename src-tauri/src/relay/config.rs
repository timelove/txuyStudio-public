//! relay 配置 + 本机身份持久化(relay.json,与 state.json 同目录)。
//!
//! url 为空 = 未启用。deviceId/pairKey 首次生成本机身份后持久化,不再变更
//! (pairKey 变更 = 所有已配对手机失效,只能用户显式重置——v1 不提供该入口)。

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::crypto;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RelayConfig {
    /// 中继 WebSocket 地址(ws:// 本地联调 / wss:// 生产),空 = 未启用。
    pub url: String,
    pub user_id: String,
    /// 用户级 token(连中继凭证;泄露处置 = 中继侧换 token 重启)。
    pub token: String,
    /// 本机设备 ID(首次生成持久化)。
    pub device_id: String,
    /// E2E 共享密钥 base64(首次生成持久化;经 vault 加密分发给同账号手机端)。
    pub pair_key: String,
    /// 是否允许手机经中继远程对话(chat.send / chat.interrupt / chat.permission)。
    /// 缺省 **true**(`#[serde(default = "default_allow_remote_chat")]`)——配对密钥已是信任锚,
    /// 扫码即授权;但「远程执行代码」权限级别值得留一个纯文件级硬开关,出事不用改代码改 UI
    /// 就能关掉。只读方法(projects/usage/sessions/chat.history/chat.status)不受此开关影响,
    /// 关掉后手机仍能看,只是发不出去。
    #[serde(default = "default_allow_remote_chat")]
    pub allow_remote_chat: bool,
    /// 账号登录会话过期时间(Unix 秒,仅展示用;token 过期由中继判定)。
    #[serde(default)]
    pub session_expires_at: Option<i64>,
    /// 账号登录用户名(账号卡展示/改密预填)。
    #[serde(default)]
    pub username: String,
    /// 登录账号是否管理员(展示用;实际权限由中继判定)。
    #[serde(default)]
    pub is_admin: bool,
}

/// 缺省开启远程对话(旧 relay.json 无此字段时也按开启处理,零迁移)。
fn default_allow_remote_chat() -> bool {
    true
}


/// 内置中继默认自启(prod 下 setup 即拉起;旧 relay.json 无此字段时也按自启处理)。

/// 手写 `Default` 而非 derive:`allow_remote_chat` 的缺省必须是 **true**,而 `bool::default()`
/// 是 false。derive + `#[serde(default)]` 只影响反序列化,不影响 `RelayConfig::default()`
/// ——`load_or_init` 在文件缺失时用 `unwrap_or_default()` 拿到全 false 的 cfg,会让远程对话
/// 在「首次配置」场景被静默禁用。`local_enabled` 缺省 **false**(不默认监听端口)。
impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            user_id: String::new(),
            token: String::new(),
            device_id: String::new(),
            pair_key: String::new(),
            allow_remote_chat: true,
            session_expires_at: None,
            username: String::new(),
            is_admin: false,
        }
    }
}

impl RelayConfig {
    pub fn enabled(&self) -> bool {
        !self.url.is_empty() && !self.user_id.is_empty() && !self.token.is_empty()
    }

    pub fn pair_key_bytes(&self) -> Result<[u8; 32], String> {
        let raw = B64
            .decode(&self.pair_key)
            .map_err(|e| format!("pair_key base64: {e}"))?;
        let len = raw.len();
        raw.try_into().map_err(|_| format!("pair_key len {len} != 32"))
    }
}

fn relay_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    // 与 state.json 同目录(dev/prod 分离,同款容错语义)。
    let sub = if cfg!(debug_assertions) { "txuyStudio-dev" } else { "txuyStudio" };
    Ok(base.join(sub).join("relay.json"))
}

/// 读取配置;不存在或半配置时补齐本机身份(deviceId/pairKey)并落盘。
pub fn load_or_init(app: &AppHandle) -> Result<RelayConfig, String> {
    let path = relay_file_path(app)?;
    let mut cfg: RelayConfig = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut dirty = false;
    if cfg.device_id.is_empty() {
        cfg.device_id = format!("dev-desktop-{}", &Uuid::new_v4().simple().to_string()[..8]);
        dirty = true;
    }
    if cfg.pair_key.is_empty() {
        let key = crypto::generate_pair_key();
        cfg.pair_key = B64.encode(key);
        dirty = true;
    }
    if dirty {
        save(app, &cfg)?;
    }
    Ok(cfg)
}

pub fn save(app: &AppHandle, cfg: &RelayConfig) -> Result<(), String> {
    let path = relay_file_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    let body = serde_json::to_string_pretty(cfg).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
}
