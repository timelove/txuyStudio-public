//! AI 事件总线:把 Tauri 本地事件(`claude-event` / `codex-event`)转成可跨中继转发的流。
//!
//! 为什么需要这一层:`claude-event` / `codex-event` 是 `app.emit` 的**本地**事件,只有桌面
//! WebView 里的监听器收得到。中继任务是 Rust 侧的另一个任务,想转发给手机就得先「听」——
//! 在 `setup` 里挂两个 `app.listen` 把 payload 塞进 [`AiBus`],中继连接侧订阅转发。
//!
//! 用 `broadcast` 而不是 `mpsc`:中继连接可能同时有多条(改配置换代时新旧瞬叠),且
//! **没有任何订阅者时写入必须成功**(桌面端单机使用是中继未启用时的常态,不能因此报错)。
//! `broadcast::send` 无订阅者返回 Err,这里忽略即可。
//!
//! 容量 256 + `Lagged` 跳过:手机侧丢几条流式增量无所谓(重新进对话页会拉
//! `chat.history` 补齐),卡住整条链路才是事故。

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Listener, Manager};

/// 事件总线(managed state)。`Value` 形如
/// `{"provider":"claude"|"codex","projectId":…,"tabId":…,"payload":{…}}`。
pub struct AiBus(pub tokio::sync::broadcast::Sender<Value>);

impl AiBus {
    pub fn new() -> Self {
        let (tx, _) = tokio::sync::broadcast::channel(256);
        Self(tx)
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Value> {
        self.0.subscribe()
    }
}

impl Default for AiBus {
    fn default() -> Self {
        Self::new()
    }
}

/// 在 `setup` 中调用:注册两个本地事件监听,把载荷转投总线。
///
/// 注意这与 lib.rs 里那个哑监听 `mx-drain` 的动机**不冲突也不重复**:哑监听只是让
/// tauri 的 Pending::Emit 队列排水条件成立;这里是真的消费每条事件。
pub fn install(app: &AppHandle) {
    app.manage(AiBus::new());
    for (event_name, provider) in [("claude-event", "claude"), ("codex-event", "codex")] {
        let handle = app.clone();
        app.listen(event_name, move |ev| {
            // 事件载荷:{"projectId","tabId","payload"}。解析失败静默丢(不让脏事件砸监听器)。
            let Ok(v) = serde_json::from_str::<Value>(ev.payload()) else {
                return;
            };
            let frame = json!({
                "provider": provider,
                "projectId": v.get("projectId").cloned().unwrap_or(Value::Null),
                "tabId": v.get("tabId").cloned().unwrap_or(Value::Null),
                "payload": v.get("payload").cloned().unwrap_or(Value::Null),
            });
            // send 失败 = 当前无订阅者(中继未启用/没连上),正常情况,忽略。
            if let Some(bus) = handle.try_state::<AiBus>() {
                let _ = bus.0.send(frame);
            }
        });
    }
}

/// 供其它模块判断某个事件值是否值得转发给手机(节流用)。
///
/// `thinking` 且 `text` 为空 = 纯 token 计数心跳(`system subtype=thinking_tokens` 的聚合产物),
/// 手机只需要「在思考」这个布尔态,不需要每 50ms 一帧。
pub fn is_noop_thinking(frame: &Value) -> bool {
    let payload = frame.get("payload").unwrap_or(&Value::Null);
    if payload.get("kind").and_then(|k| k.as_str()) != Some("thinking") {
        return false;
    }
    payload.get("text").and_then(|t| t.as_str()).map(|t| t.is_empty()).unwrap_or(true)
}

/// 中继转发时的节流判定:无文本 thinking 心跳最快 1s 一条(保留布尔态可观测),
/// 其余事件一律放行——`init` / `result` / `permission_request` / `terminated` 永不丢。
/// 返回 true = 本帧应丢弃。
impl AiBus {
    pub fn is_noop_thinking_throttled(frame: &Value, last: &mut Instant) -> bool {
        if !is_noop_thinking(frame) {
            return false;
        }
        if last.elapsed() < Duration::from_secs(1) {
            return true;
        }
        *last = Instant::now();
        false
    }
}
