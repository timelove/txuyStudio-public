//! 出站中继客户端:主动连接中继(纯出站,零防火墙),断线指数退避重连,
//! 心跳保活,密文业务帧双向转发。生命周期由 RelayHandle.generation 控制
//! (save_relay_config 换代号,旧任务自杀,新任务顶上)。

use std::collections::HashSet;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::time::{interval, sleep};
use tokio_tungstenite::tungstenite::Message;

use super::bus::AiBus;
use super::{api, crypto, RelayConfig, RelayHandle};

/// 心跳间隔(中继读静默超时 90s,30s 一跳余量充足)。
const PING_EVERY: Duration = Duration::from_secs(30);
/// 快照推送间隔(连接建立即推一次,之后周期刷新)。
const SNAPSHOT_EVERY: Duration = Duration::from_secs(10 * 60);
/// 重连退避上限(1s 起步翻倍)。
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// 单次连接会话的结局。
enum Outcome {
    /// 换代/停用,任务正常退场。
    Exit,
    /// 连接断开:{错误, 是否曾成功上线}(曾上线 = 退避复位)。
    Dropped { err: String, was_online: bool },
}

pub async fn run(app: AppHandle, handle: std::sync::Arc<RelayHandle>) {
    let my_gen = handle.generation();
    log::info!("[relay] client 启动 (gen={my_gen})");
    let mut backoff = Duration::from_secs(1);
    loop {
        if handle.generation() != my_gen || !handle.is_enabled() {
            log::info!("[relay] 任务退场 (gen 过期或配置停用)");
            return;
        }
        let cfg = handle.config();
        handle.set_status(super::RelayStatus::Connecting, None);

        match serve_once(&app, &handle, &cfg).await {
            Outcome::Exit => {
                log::info!("[relay] 任务退场 (gen 过期或配置停用)");
                return;
            }
            Outcome::Dropped { err, was_online } => {
                handle.set_status(super::RelayStatus::Offline, Some(err.clone()));
                if was_online {
                    backoff = Duration::from_secs(1); // 曾上线 = 网络抖动,轻退避
                }
                log::warn!("[relay] 连接断开: {e}({}s 后重试)", backoff.as_secs(), e = err);
                // 退避期间每 250ms 查一次换代,保证 save_relay_config 即时生效。
                let mut waited = Duration::ZERO;
                loop {
                    if handle.generation() != my_gen || !handle.is_enabled() {
                        return;
                    }
                    if waited >= backoff {
                        break;
                    }
                    sleep(Duration::from_millis(250)).await;
                    waited += Duration::from_millis(250);
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

/// 单次连接的完整生命周期。
async fn serve_once(app: &AppHandle, handle: &std::sync::Arc<RelayHandle>, cfg: &RelayConfig) -> Outcome {
    match serve_inner(app, handle, cfg).await {
        Ok(()) => Outcome::Exit,
        Err((err, was_online)) => Outcome::Dropped { err, was_online },
    }
}

async fn serve_inner(
    app: &AppHandle,
    handle: &std::sync::Arc<RelayHandle>,
    cfg: &RelayConfig,
) -> Result<(), (String, bool)> {
    let drop = |e: String, online: bool| Err((e, online));
    let url = cfg.url.clone();
    log::info!("[relay] 连接 {url}");
    let (ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| (format!("connect: {e}"), false))?;
    let (mut tx, mut rx) = ws.split();

    // hello 握手(10s 内完成,同协议)。
    let hello = json!({
        "type": "hello",
        "userId": cfg.user_id,
        "deviceId": cfg.device_id,
        "role": "desktop",
        "token": cfg.token,
    });
    tx.send(Message::Text(hello.to_string().into()))
        .await
        .map_err(|e| (format!("send hello: {e}"), false))?;

    let ack = tokio::time::timeout(Duration::from_secs(10), rx.next())
        .await
        .map_err(|_| ("hello_ack timeout".into(), false))?
        .ok_or_else(|| ("closed before hello_ack".into(), false))?
        .map_err(|e| (format!("read hello_ack: {e}"), false))?;
    let ack_v: Value = match ack {
        Message::Text(t) => serde_json::from_str(&t).map_err(|e| (format!("parse hello_ack: {e}"), false))?,
        _ => return drop("hello_ack not text".into(), false),
    };
    if ack_v.get("type").and_then(|t| t.as_str()) != Some("hello_ack")
        || ack_v.get("ok").and_then(|o| o.as_bool()) != Some(true)
    {
        let err = ack_v.get("error").and_then(|e| e.as_str()).unwrap_or("rejected");
        // 认证被拒:交上层退避重试(用户改中继 token 后自动恢复)。
        return drop(format!("hello rejected: {err}"), false);
    }

    handle.set_online();
    log::info!("[relay] 已上线 ({})", cfg.device_id);

    // 上线即推快照 + 周期刷新;失败只记日志(快照是锦上添花,不致命)。
    if let Err(e) = push_snapshot(app, &mut tx, cfg).await {
        log::warn!("[relay] 首推快照失败: {e}");
    }

    let key = cfg.pair_key_bytes().map_err(|e| (e, true))?;
    let mut ping_tick = interval(PING_EVERY);
    let mut snap_tick = interval(SNAPSHOT_EVERY);
    // 手动推过首份快照 + 首个 ping 由 tick 即刻触发也无妨,tick 先消费掉立即到点的第一拍。
    ping_tick.tick().await;
    snap_tick.tick().await;

    // AI 事件总线:本次连接开始订阅(手机不在线期间的事件不补,靠 chat.history 回填)。
    let mut ai_events = app
        .try_state::<AiBus>()
        .map(|b| b.subscribe());
    // 本次连接内主动发过 recv 的手机 deviceId —— 只给它们推事件(中继不缓存设备表,
    // 桌面也没必要维护跨连接名单);没手机问过就不推,省得空转加密。
    let mut phones: HashSet<String> = HashSet::new();
    // thinking 心跳节流:纯 token 计数一秒一条足够(其余事件不丢)。
    let mut last_thinking_push = Instant::now() - Duration::from_secs(5);

    loop {
        tokio::select! {
            msg = rx.next() => {
                let msg = msg.ok_or(("connection closed".into(), true))?
                    .map_err(|e| (format!("read: {e}"), true))?;
                match msg {
                    Message::Text(t) => {
                        let v: Value = match serde_json::from_str(&t) { Ok(v) => v, Err(_) => continue };
                        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                            // 手机端密文请求:解密 → 分发 → 加密回。
                            "recv" => {
                                let from = v.get("from").and_then(|f| f.as_str()).unwrap_or("").to_string();
                                let enc = v.get("enc").and_then(|e| e.as_str()).unwrap_or("");
                                // 发过请求 = 这台手机在线且想收东西;记下来,AI 事件才推给它。
                                if !from.is_empty() {
                                    phones.insert(from.clone());
                                }
                                let resp = match crypto::open(&key, enc) {
                                    Ok(plain) => {
                                        let frame: Value = serde_json::from_slice(&plain)
                                            .unwrap_or_else(|_| json!({"id": null, "method": ""}));
                                        api::dispatch(app, frame).await
                                    }
                                    Err(e) => json!({"id": null, "ok": false, "error": format!("decrypt: {e}")}),
                                };
                                let body = serde_json::to_string(&resp).unwrap_or_default();
                                let enc_out = crypto::seal(&key, body.as_bytes())
                                    .map_err(|e| (format!("seal resp: {e}"), true))?;
                                let out = json!({"type": "send", "to": from, "enc": enc_out});
                                tx.send(Message::Text(out.to_string().into()))
                                    .await
                                    .map_err(|e| (format!("send resp: {e}"), true))?;
                            }
                            "pong" | "snapshot_result" | "send_result" => {}
                            "bye" => return drop("replaced by new connection".into(), true),
                            "error" => log::warn!("[relay] 服务端 error 帧: {v}"),
                            _ => {}
                        }
                    }
                    Message::Close(_) => return drop("server closed".into(), true),
                    _ => {}
                }
            }
            _ = ping_tick.tick() => {
                tx.send(Message::Text(json!({"type":"ping"}).to_string().into()))
                    .await
                    .map_err(|e| (format!("ping: {e}"), true))?;
            }
            _ = snap_tick.tick() => {
                if let Err(e) = push_snapshot(app, &mut tx, cfg).await {
                    log::warn!("[relay] 周期快照失败: {e}");
                }
            }
            // AI 流式事件 → 加密 → 逐台手机转发。
            ev = next_ai_event(&mut ai_events) => {
                let Some(frame) = ev else { continue };
                if phones.is_empty() || AiBus::is_noop_thinking_throttled(&frame, &mut last_thinking_push) {
                    continue;
                }
                let body = json!({ "ev": "chat.event", "data": frame }).to_string();
                let Ok(enc) = crypto::seal(&key, body.as_bytes()) else { continue };
                for phone in phones.iter() {
                    let out = json!({"type": "send", "to": phone, "enc": enc});
                    tx.send(Message::Text(out.to_string().into()))
                        .await
                        .map_err(|e| (format!("send chat.event: {e}"), true))?;
                }
            }
        }
    }
}

/// 从事件总线取下一帧;总线未订阅(理论上不会)或通道关闭时挂起,避免 select 空转。
/// pub 供 local.rs(本地直连服务器)复用同一节流语义。
pub(super) async fn next_ai_event(
    rx: &mut Option<tokio::sync::broadcast::Receiver<Value>>,
) -> Option<Value> {
    let Some(rx) = rx.as_mut() else {
        std::future::pending::<()>().await;
        return None;
    };
    loop {
        match rx.recv().await {
            Ok(v) => return Some(v),
            // 落后被跳过的旧事件直接丢(设计如此:重新进对话页拉 chat.history 补齐)。
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                log::debug!("[relay] AI 事件滞后 {n} 条(已跳过)");
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                std::future::pending::<()>().await;
                return None;
            }
        }
    }
}

/// 构建快照 → 加密 → snapshot_put。
async fn push_snapshot<S>(app: &AppHandle, tx: &mut S, cfg: &RelayConfig) -> Result<(), String>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    let snap = api::build_snapshot(app).await;
    let key = cfg.pair_key_bytes()?;
    let enc = crypto::seal(&key, serde_json::to_string(&snap).unwrap_or_default().as_bytes())?;
    let out = json!({"type": "snapshot_put", "enc": enc});
    tx.send(Message::Text(out.to_string().into()))
        .await
        .map_err(|e| format!("send snapshot: {e}"))?;
    Ok(())
}
