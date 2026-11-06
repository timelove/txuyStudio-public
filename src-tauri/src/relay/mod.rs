//! 移动伴侣连接层(桌面端侧):公网中继出站客户端(纯账密,v4 收敛)。
//!
//! tauri 启动时若已配置 relay.json 则 spawn 后台任务;任务长驻,断线重连,
//! generation 换代号实现「改配置即时生效」。纯出站连接零防火墙交互。
//! 传输层唯一身份 = 账号 session(login client="desktop");pairKey 仅用于 E2E 加密,
//! 经 vault 分发(扫码/静态 token/本地直连/内置中继已在 v4 移除)。
//! 协议:.work/design/20261023-mobile-relay/protocol-v1.md +
//! .work/design/20261027-local-pairing-relay-auth/(账密/vault/组织)。

pub mod api;
pub mod bus;
pub mod client;
pub mod config;
pub mod crypto;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use config::RelayConfig;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RelayStatus {
    /// 配置存在,正在建立连接。
    Connecting,
    /// 已通过 hello 握手。
    Online,
    /// 断开(重试退避中)。
    Offline,
}

/// 后台任务与前端设置页共享的运行时状态。
pub struct RelayHandle {
    inner: Mutex<RelayInner>,
}

struct RelayInner {
    cfg: RelayConfig,
    status: RelayStatus,
    last_error: Option<String>,
    connected_since: Option<i64>,
    /// 代号:save_relay_config 每次 +1,旧任务发现不一致即自杀。
    generation: u64,
    /// 后台任务句柄(stop 场景放弃等待,任务靠 generation 自杀,不强杀)。
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl RelayHandle {
    pub fn new(cfg: RelayConfig) -> Self {
        let status = if cfg.enabled() { RelayStatus::Offline } else { RelayStatus::Offline };
        Self {
            inner: Mutex::new(RelayInner {
                cfg,
                status,
                last_error: None,
                connected_since: None,
                generation: 0,
                task: None,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RelayInner> {
        self.inner.lock().expect("relay handle poisoned")
    }

    pub fn generation(&self) -> u64 {
        self.lock().generation
    }

    pub fn is_enabled(&self) -> bool {
        self.lock().cfg.enabled()
    }

    pub fn config(&self) -> RelayConfig {
        self.lock().cfg.clone()
    }

    pub fn set_status(&self, status: RelayStatus, err: Option<String>) {
        let mut g = self.lock();
        if status == RelayStatus::Online {
            g.connected_since = Some(chrono::Utc::now().timestamp());
        }
        if status != RelayStatus::Online {
            g.connected_since = None;
        }
        g.status = status;
        g.last_error = err;
    }

    pub fn set_online(&self) {
        self.set_status(RelayStatus::Online, None);
    }

    /// 换配置:代号 +1 并落盘,旧任务自杀;返回新代号。
    pub fn apply_config(&self, cfg: RelayConfig) -> u64 {
        let mut g = self.lock();
        g.cfg = cfg;
        g.status = RelayStatus::Offline;
        g.last_error = None;
        g.connected_since = None;
        g.generation += 1;
        g.generation
    }

}

/// 启动/重启 relay 后台任务(配置停用时不启动)。
pub fn spawn_task(app: &AppHandle) {
    let handle = app.state::<Arc<RelayHandle>>();
    let cfg = handle.config();
    if !cfg.enabled() {
        log::info!("[relay] 未配置,任务不启动");
        return;
    }
    let app2 = app.clone();
    let h = handle.inner().clone();
    let task = tauri::async_runtime::spawn(client::run(app2, h));
    handle.lock().task = Some(task);
}

// ---------- Tauri commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatusInfo {
    pub enabled: bool,
    pub status: RelayStatus,
    pub url: String,
    pub user_id: String,
    pub device_id: String,
    pub last_error: Option<String>,
    pub connected_since: Option<i64>,
    /// 账号登录态(session 由 relay_login 签发)。
    pub username: String,
    pub is_admin: bool,
    pub session_expires_at: Option<i64>,
}

#[tauri::command]
pub fn get_relay_status(handle: tauri::State<'_, Arc<RelayHandle>>) -> RelayStatusInfo {
    let g = handle.lock();
    RelayStatusInfo {
        enabled: g.cfg.enabled(),
        status: g.status,
        url: g.cfg.url.clone(),
        user_id: g.cfg.user_id.clone(),
        device_id: g.cfg.device_id.clone(),
        last_error: g.last_error.clone(),
        connected_since: g.connected_since,
        username: g.cfg.username.clone(),
        is_admin: g.cfg.is_admin,
        session_expires_at: g.cfg.session_expires_at,
    }
}

/// 保存 relay 配置(url 置空 = 停用)并重启任务;返回最新状态。
/// account(账号模式)带 username/expiresAt;手动 token 模式传 None。
#[tauri::command]
pub fn save_relay_config(
    app: AppHandle,
    handle: tauri::State<'_, Arc<RelayHandle>>,
    url: String,
    user_id: String,
    token: String,
    username: Option<String>,
    expires_at: Option<i64>,
) -> Result<RelayStatusInfo, String> {
    let mut cfg = handle.config();
    cfg.url = url.trim().to_string();
    cfg.user_id = user_id.trim().to_string();
    cfg.token = token.trim().to_string();
    cfg.username = username.unwrap_or_default().trim().to_string();
    cfg.session_expires_at = expires_at; // 手动 token 模式无会话过期概念
    config::save(&app, &cfg)?;
    handle.apply_config(cfg);
    // 重新拉起任务(旧任务靠 generation 自杀;新任务按最新配置连接)。
    spawn_task(&app);
    Ok(get_relay_status(handle))
}

// ---------- 中继账号登录(协议 v2 账密 + v3 vault 保险箱) ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayLoginInfo {
    pub user_id: String,
    pub token: String,
    pub expires_at: i64,
    pub is_admin: bool,
    /// pairKey 密文包是否已发布到中继 vault(手机端登录同账号即可免扫码配对)。
    /// 发布失败不影响登录本身(如旧版中继无 /vault),提示即可。
    pub vault_published: bool,
    pub vault_error: Option<String>,
}

/// 账密登录中继:POST <base>/login → {userId, token, expiresAt, isAdmin};
/// 成功后顺手把 pairKey 密文包(PBKDF2(密码) 派生密钥 + ChaCha20Poly1305)PUT /vault/{deviceId}。
/// 密码只在内存过一道,不落盘;中继只见密文(E2E 对中继保持)。
/// 成功后由前端再 save_relay_config 落盘(此处不写盘,登录失败场景零副作用)。
#[tauri::command]
pub async fn relay_login(
    app: AppHandle,
    url: String,
    username: String,
    password: String,
) -> Result<RelayLoginInfo, String> {
    let base = relay_ws_to_http(&url).ok_or("无效的中继地址")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .post(format!("{base}/login"))
        .json(&serde_json::json!({ "username": username, "password": password, "client": "desktop" }))
        .send()
        .await
        .map_err(|e| format!("login request: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("login response: {e}"))?;
    if !status.is_success() {
        let err = body.get("error").and_then(|e| e.as_str()).unwrap_or(status.as_str());
        return Err(err.to_string());
    }
    let user_id = body.get("userId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let token = body.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let expires_at = body.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0);
    let is_admin = body.get("isAdmin").and_then(|v| v.as_bool()).unwrap_or(false);
    if user_id.is_empty() || token.is_empty() {
        return Err("login response missing fields".into());
    }
    // vault 发布:手机端同账号登录后拉密文 → 同密码解密 → 免扫码配对。
    let (vault_published, vault_error) = match publish_vault(&app, &client, &base, &token, &password).await {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e)),
    };
    Ok(RelayLoginInfo { user_id, token, expires_at, is_admin, vault_published, vault_error })
}

/// PBKDF2-HMAC-SHA256 迭代数(与手机端 Pbkdf2 同参;blob 自描述 iter 字段,
/// 升档后旧 blob 仍按旧轮数解,零迁移)。
const VAULT_KDF_ITER: u32 = 200_000;

/// 把 {pairKey, deviceId} 加密成 blob PUT /vault/{deviceId}(覆盖式,多桌面各占一桶)。
async fn publish_vault(
    app: &AppHandle,
    client: &reqwest::Client,
    base: &str,
    token: &str,
    password: &str,
) -> Result<(), String> {
    use base64::Engine;
    let cfg = app
        .state::<std::sync::Arc<RelayHandle>>()
        .config();
    let payload = serde_json::json!({ "pairKey": cfg.pair_key, "deviceId": cfg.device_id });
    // salt 每次发布随机(改密后旧 blob 自然解不开,由下次登录覆盖)。
    let salt = crypto::generate_pair_key(); // 32B 随机,复用作 salt 生成器
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), &salt, VAULT_KDF_ITER, &mut key);
    let data = crypto::seal(&key, payload.to_string().as_bytes())?;
    let blob = serde_json::json!({
        "kdf": "pbkdf2-sha256",
        "iter": VAULT_KDF_ITER,
        "salt": base64::engine::general_purpose::STANDARD.encode(salt),
        "data": data,
    });
    let resp = client
        .put(format!("{base}/vault/{}", cfg.device_id))
        .bearer_auth(token)
        .json(&serde_json::json!({ "blob": blob.to_string() }))
        .send()
        .await
        .map_err(|e| format!("vault put: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("vault put: HTTP {}", resp.status()));
    }
    log::info!("[relay] vault 已发布(deviceId={})", cfg.device_id);
    Ok(())
}

/// ws(s)://host[/prefix]/ws → http(s)://host[/prefix](只去尾部 /ws,**路径前缀保留**)。
/// 反代前缀场景(nginx 挂 /txuy)登录/注册/vault 等 HTTP API 在同一前缀下
/// (wss://h/txuy/ws → https://h/txuy/login);不带前缀的 ws(s)://host/ws → 根路径。
/// 尾部多余斜杠一并去掉(避免 //login 双斜杠)。
fn relay_ws_to_http(url: &str) -> Option<String> {
    let (scheme, rest) = if let Some(r) = url.strip_prefix("wss://") {
        ("https", r)
    } else if let Some(r) = url.strip_prefix("ws://") {
        ("http", r)
    } else {
        return None;
    };
    let base = rest
        .strip_suffix("/ws")
        .unwrap_or(rest)
        .trim_end_matches('/');
    let host = base.split('/').next()?;
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{base}"))
}

// ---------- 注册 / 自助改密 / 登出(v3 追加) ----------

/// 自助注册:POST /register(registerMode:off=403 / invite=须邀请码 / open=无门槛;
/// 恒非管理员)。**不自动登录**——注册与登录分离,成功后由前端把用户名带回登录表单。
#[tauri::command]
pub async fn relay_register(
    url: String,
    username: String,
    password: String,
    invite_code: Option<String>,
) -> Result<(), String> {
    let base = relay_ws_to_http(&url).ok_or("无效的中继地址")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .post(format!("{base}/register"))
        .json(&serde_json::json!({
            "username": username,
            "password": password,
            "inviteCode": invite_code.unwrap_or_default(),
        }))
        .send()
        .await
        .map_err(|e| format!("register request: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("register response: {e}"))?;
    if status.is_success() {
        return Ok(());
    }
    // 错误码翻译成可读提示(前端直接显示)。
    let err = body.get("error").and_then(|e| e.as_str()).unwrap_or_default();
    Err(match (status.as_u16(), err) {
        (400, "invite code required") => "该中继要求邀请码注册,请填写邀请码".into(),
        (403, "invalid invite code") => "邀请码无效(不存在/已用完/已过期/已作废)".into(),
        (403, _) => "该中继未开放注册(请让管理员用 -adduser、邀请码或手机管理页创建)".into(),
        (409, _) => "用户名已存在".into(),
        (429, _) => "尝试过于频繁,请一分钟后再试".into(),
        (400, _) => "用户名须 1-32 位字母数字_.- 且密码至少 8 位".into(),
        _ => format!("注册失败: {status} {err}"),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordResult {
    /// 改密成功后是否用新密码重发布了 vault(失败不影响改密本身,提示用户手机端旧密码解不开)。
    pub vault_republished: bool,
    pub vault_error: Option<String>,
}

/// 自助改密:POST /account/password(Bearer 当前会话,验旧密码)。
/// 成功后**用新密码重发布 vault**——手机端仍可用新密码自动配对(旧 blob 自然作废)。
#[tauri::command]
pub async fn relay_change_password(
    app: AppHandle,
    old_password: String,
    new_password: String,
) -> Result<ChangePasswordResult, String> {
    let cfg = app
        .state::<std::sync::Arc<RelayHandle>>()
        .config();
    if cfg.username.is_empty() {
        return Err("当前是手动令牌模式,没有账号会话".into());
    }
    let base = relay_ws_to_http(&cfg.url).ok_or("无效的中继地址")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .post(format!("{base}/account/password"))
        .bearer_auth(&cfg.token)
        .json(&serde_json::json!({ "oldPassword": old_password, "newPassword": new_password }))
        .send()
        .await
        .map_err(|e| format!("change password: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 => "当前密码错误".into(),
            400 => "新密码至少 8 位".into(),
            _ => format!("修改失败: HTTP {status}"),
        });
    }
    // 新密码重发布 vault(手机端用新密码仍能自动配对)。
    let (vault_republished, vault_error) =
        match publish_vault(&app, &client, &base, &cfg.token, &new_password).await {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e)),
        };
    log::info!("[relay] 密码已修改(user={}),vault 重发布={}", cfg.username, vault_republished);
    Ok(ChangePasswordResult { vault_republished, vault_error })
}

/// 登出:吊销当前会话(尽力而为,网络失败不阻断)+ 清空连接配置 + 停中继任务。
/// 本机 deviceId/pairKey/localToken 等身份字段不动。
#[tauri::command]
pub async fn relay_logout(
    app: AppHandle,
    handle: tauri::State<'_, Arc<RelayHandle>>,
) -> Result<RelayStatusInfo, String> {
    let cfg = handle.config();
    if !cfg.token.is_empty() && !cfg.url.is_empty() {
        let base = relay_ws_to_http(&cfg.url);
        if let Some(base) = base {
            if let Ok(client) = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
            {
                // 尽力吊销;失败(离线/旧版中继)也继续本地登出。
                let _ = client
                    .post(format!("{base}/logout"))
                    .json(&serde_json::json!({ "token": cfg.token }))
                    .send()
                    .await;
            }
        }
    }
    let mut next = cfg;
    next.url = String::new();
    next.user_id = String::new();
    next.token = String::new();
    next.session_expires_at = None;
    next.username = String::new();
    next.is_admin = false;
    config::save(&app, &next)?;
    handle.apply_config(next); // 换代号:旧任务自杀,不再 spawn
    Ok(get_relay_status(handle))
}
