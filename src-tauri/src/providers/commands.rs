//! 供应商端点探测命令(参考 cc-switch EndpointSpeedTest/FetchedModelPicker 的「拉模型+测速」,
//! 合并为一次请求):GET {base}/v1/models,Bearer token,计时即延迟、data[].id 即模型列表。
//! 走 Rust 后端而非前端 fetch:三方 API 几乎都不开 CORS(WebView fetch 直连必挂)。
//!
//! 探测逻辑抽成 `probe_endpoint`,crate 内可复用:设置页「拉取模型」走 8s 超时(用户主动点,
//! 愿意等);会话里打开模型选择器(`claude::commands::list_claude_models`)走 4s 上限——
//! 端点不通时不能把选择器卡住,拿不到目录就只显示 env 里配过的别名。

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbeResult {
    pub latency_ms: u128,
    pub status: u16,
    /// 排序后的模型 id 列表(请求失败为空)。
    pub models: Vec<String>,
    pub error: Option<String>,
}

/// 探测结果内部结构(命令层转 `ProviderProbeResult`;crate 内其它模块直接取 `models`)。
pub(crate) struct EndpointProbe {
    pub latency_ms: u128,
    pub status: u16,
    pub models: Vec<String>,
    pub error: Option<String>,
}

/// base_url 归一拼 models 端点:已带版本段(/v1、/v4)的只补 /models,裸域名补 /v1/models。
fn models_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    // 路径段补回前导斜杠再判后缀(split_once 切出的 "v1" 不带 "/",直接 ends_with("/v1") 永假,
    // 会把 https://host/v1 拼成 /v1/v1/models → 404;codex 侧 baseUrl 惯例带 /v1,已踩中)。
    let path = base
        .split("://")
        .nth(1)
        .map(|rest| match rest.split_once('/') {
            Some((_, p)) => format!("/{p}"),
            None => String::new(),
        })
        .unwrap_or_default();
    if path.ends_with("/v1") || path.ends_with("/v2") || path.ends_with("/v3") || path.ends_with("/v4") {
        format!("{}/models", base)
    } else {
        format!("{}/v1/models", base)
    }
}

/// 探测端点并解析模型目录(不抛错,失败经 `error` 返回;`timeout_secs` 由调用方按场景定)。
pub(crate) async fn probe_endpoint(base_url: &str, token: Option<&str>, timeout_secs: u64) -> EndpointProbe {
    let url = models_endpoint(base_url);
    let started = std::time::Instant::now();
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .danger_accept_invalid_certs(false)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return EndpointProbe { latency_ms: 0, status: 0, models: Vec::new(), error: Some(e.to_string()) }
        }
    };
    let mut req = client.get(&url);
    if let Some(t) = token.filter(|t| !t.trim().is_empty()) {
        req = req.bearer_auth(t);
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let latency_ms = started.elapsed().as_millis();
            if !resp.status().is_success() {
                return EndpointProbe { latency_ms, status, models: Vec::new(), error: Some(format!("HTTP {status}")) };
            }
            // OpenAI 风格 {data:[{id}]};兼容顶层数组 [{id}] 与 {models:[{id}]}。
            // 错误类型显式 reqwest::Error:留 `_` 会触发 never type fallback deny(edition2024)。
            let parsed: Result<serde_json::Value, reqwest::Error> = resp.json().await;
            match parsed {
                Ok(v) => {
                    let arr = v
                        .as_array()
                        .cloned()
                        .or_else(|| v.get("data").and_then(|d| d.as_array().cloned()))
                        .or_else(|| v.get("models").and_then(|d| d.as_array().cloned()))
                        .unwrap_or_default();
                    let mut models: Vec<String> = arr
                        .iter()
                        .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(String::from))
                        .collect();
                    models.sort();
                    models.dedup();
                    EndpointProbe { latency_ms, status, models, error: None }
                }
                Err(e) => EndpointProbe { latency_ms, status, models: Vec::new(), error: Some(e.to_string()) },
            }
        }
        Err(e) => EndpointProbe {
            latency_ms: started.elapsed().as_millis(),
            status: 0,
            models: Vec::new(),
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn probe_provider_endpoint(base_url: String, token: Option<String>) -> ProviderProbeResult {
    let p = probe_endpoint(&base_url, token.as_deref(), 8).await;
    ProviderProbeResult { latency_ms: p.latency_ms, status: p.status, models: p.models, error: p.error }
}
