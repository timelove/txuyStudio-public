//! 供应商余额查询(参考 cc-switch `services/balance.rs` 的域名白名单做法):
//! 按 baseUrl 匹配已知供应商,各自调官方账户端点解析余额;**不认识的供应商返回
//! None(前端不渲染余额行)**——多数三方中转没有公开的余额 API,宁缺勿错。
//!
//! 支持:DeepSeek / StepFun / SiliconFlow(cn+en) / OpenRouter / Novita AI /
//! 智谱 GLM(bigmodel.cn 与 z.ai;cc-switch 把智谱放在套餐查询里,我们没有套餐页,
//! 并入自动检测)。与 `probe_endpoint` 同走 Rust:三方 API 几乎都不开 CORS。
//!
//! 端点口径(逐家对齐 cc-switch,含各自的坑):
//! - DeepSeek  GET /user/balance → balance_infos[]{currency,total_balance};
//!   多币种钱包只列有余额的(空钱包行无信息量);
//! - StepFun   GET /v1/accounts → {balance}(CNY);
//! - SiliconFlow GET /v1/user/info → data.totalBalance(cn=CNY,en=USD);
//! - OpenRouter GET /api/v1/credits → data.total_credits - total_usage(USD;
//!   /key 的 limit_remaining 是消费上限不是余额);
//! - Novita    GET /v3/user/balance → availableBalance(**单位 0.0001 USD**,除 1e4);
//! - 智谱      GET {host}/api/biz/account/query-customer-account-report →
//!   data.availableBalance ?? data.balance(bigmodel.cn=CNY,z.ai=USD;
//!   **Authorization 头原文 key,不加 Bearer**——与官方口径一致);
//!   并发再查 GET {host}/api/monitor/usage/quota/limit(编程套餐额度:5 小时滚动 +
//!   周窗口已用百分比与重置时间,cc-switch coding_plan 同口径;按量账户空回不显示)。

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceEntry {
    /// 币种/钱包名(DeepSeek 多币种时逐条列出)。
    pub label: String,
    pub remaining: f64,
    /// "CNY" / "USD"。
    pub unit: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaTier {
    /// 窗口名:"fiveHour" | "weekly"(前端映射文案;语义同 cc-switch TIER_FIVE_HOUR/WEEKLY)。
    pub name: String,
    /// 已用百分比(0-100,上游 percentage 原样)。
    pub used_pct: f64,
    /// 重置时间(Unix 毫秒;上游 0% 等状态下可能缺失)。
    pub reset_ms: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaInfo {
    pub tiers: Vec<QuotaTier>,
    /// 套餐档位(智谱 data.level,如 Lite/Pro/Max 档位名)。
    pub level: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceResult {
    pub entries: Vec<BalanceEntry>,
    pub error: Option<String>,
    /// 订阅额度(5 小时/周窗口;仅支持编程套餐类账户,按量付费为 None 不显示)。
    pub quota: Option<QuotaInfo>,
}

/// baseUrl 域名 → 供应商(不认识 = None = 前端不显示余额)。
fn detect_vendor(base_url: &str) -> Option<&'static str> {
    let u = base_url.to_lowercase();
    if u.contains("api.deepseek.com") {
        Some("deepseek")
    } else if u.contains("api.stepfun.ai") || u.contains("api.stepfun.com") {
        Some("stepfun")
    } else if u.contains("api.siliconflow.cn") {
        Some("siliconflow_cn")
    } else if u.contains("api.siliconflow.com") {
        Some("siliconflow_en")
    } else if u.contains("openrouter.ai") {
        Some("openrouter")
    } else if u.contains("api.novita.ai") {
        Some("novita")
    } else if u.contains("bigmodel.cn") {
        Some("zhipu_cn")
    } else if u.contains("api.z.ai") || u.contains(".z.ai") {
        Some("zhipu_global")
    } else {
        None
    }
}

/// 解析 JSON 数值字段,兼容数字与字符串两种形态(cc-switch parse_f64_field 同款)。
fn f64_field(obj: &Value, field: &str) -> Option<f64> {
    obj.get(field).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
}

/// GET 一个账户端点返回 JSON(2xx;网络/非 2xx/坏 JSON 统一折成 Err 文案)。
/// `raw_auth` = Authorization 头用 key 原文(智谱),否则 Bearer。
async fn fetch_json(url: &str, token: &str, raw_auth: bool) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let auth = if raw_auth { token.to_string() } else { format!("Bearer {token}") };
    let resp: reqwest::Response = client
        .get(url)
        .header("Authorization", auth)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络错误: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // 截短:错误页可能是一大坨 HTML,别把弹层撑爆。
        let brief: String = body.chars().take(120).collect();
        return Err(format!("HTTP {status}: {brief}"));
    }
    // 错误类型显式 reqwest::Error:留 `_` 会触发 never type fallback deny(edition2024)。
    let parsed: Result<Value, reqwest::Error> = resp.json().await;
    parsed.map_err(|e| format!("响应解析失败: {e}"))
}

/// 查询供应商余额。`None` = baseUrl 不在白名单(前端不显示);`Some` 内 `error`
/// = 支持 but 查询/解析失败;`entries` 空 = 响应里没有可用余额字段。
#[tauri::command]
pub async fn query_provider_balance(base_url: String, token: Option<String>) -> Option<BalanceResult> {
    let vendor = detect_vendor(&base_url)?;
    let token = token.unwrap_or_default();
    if token.trim().is_empty() {
        return Some(BalanceResult { entries: Vec::new(), error: Some("未填 API Token".into()), quota: None });
    }
    let token = token.trim();
    // (余额查询, 额度查询):额度目前仅智谱编程套餐有,其它家 None。
    let (queried, quota): (Result<Vec<BalanceEntry>, String>, Option<QuotaInfo>) = match vendor {
        "deepseek" => (
            fetch_json("https://api.deepseek.com/user/balance", token, false)
                .await
                .map(|b| parse_deepseek(&b)),
            None,
        ),
        "stepfun" => (
            fetch_json("https://api.stepfun.com/v1/accounts", token, false)
                .await
                .map(|b| single(f64_field(&b, "balance").unwrap_or(0.0), "CNY")),
            None,
        ),
        "siliconflow_cn" | "siliconflow_en" => {
            let host = if vendor == "siliconflow_cn" { "api.siliconflow.cn" } else { "api.siliconflow.com" };
            let unit = if vendor == "siliconflow_cn" { "CNY" } else { "USD" };
            (
                fetch_json(&format!("https://{host}/v1/user/info"), token, false)
                    .await
                    .map(|b| single(f64_field(b.get("data").unwrap_or(&b), "totalBalance").unwrap_or(0.0), unit)),
                None,
            )
        }
        "openrouter" => (
            fetch_json("https://openrouter.ai/api/v1/credits", token, false)
                .await
                .map(|b| {
                    let data = b.get("data").unwrap_or(&b);
                    let credits = f64_field(data, "total_credits").filter(|v| v.is_finite());
                    let usage = f64_field(data, "total_usage").filter(|v| v.is_finite());
                    match (credits, usage) {
                        (Some(c), Some(u)) => single(c - u, "USD"),
                        _ => Vec::new(), // 缺字段 → 上层折成「无余额字段」
                    }
                }),
            None,
        ),
        "novita" => (
            fetch_json("https://api.novita.ai/v3/user/balance", token, false)
                .await
                .map(|b| {
                    // Novita 余额单位是 0.0001 USD(cc-switch 口径),换算成美元。
                    f64_field(&b, "availableBalance").map(|v| single(v / 10_000.0, "USD")).unwrap_or_default()
                }),
            None,
        ),
        "zhipu_cn" | "zhipu_global" => {
            let host = if vendor == "zhipu_cn" { "https://open.bigmodel.cn" } else { "https://api.z.ai" };
            let unit = if vendor == "zhipu_cn" { "CNY" } else { "USD" };
            // 余额与额度两个端点并发;额度失败不拖累余额(反之亦然)。url 先绑定
            // (join! 展开后临时 String 借不过 await)。
            let bal_url = format!("{host}/api/biz/account/query-customer-account-report");
            let quota_url = format!("{host}/api/monitor/usage/quota/limit");
            let (bal, quota) = tokio::join!(
                fetch_json(&bal_url, token, true),
                fetch_json(&quota_url, token, true),
            );
            let entries = bal.map(|b| {
                if b.get("success").and_then(|v| v.as_bool()) == Some(false) {
                    return Vec::new(); // {success:false,msg} → 上层带 msg 折错
                }
                let data = b.get("data").filter(|d| d.is_object()).unwrap_or(&b);
                f64_field(data, "availableBalance")
                    .or_else(|| f64_field(data, "balance"))
                    .filter(|v| v.is_finite())
                    .map(|v| single(v, unit))
                    .unwrap_or_default()
            });
            (entries, quota.ok().map(|b| parse_zhipu_quota(&b)))
        }
        _ => return None,
    };
    // 额度有 tiers 才值得显示(空 tiers = 按量账户/无套餐/解析不到窗口)。
    let quota = quota.filter(|q| !q.tiers.is_empty());
    Some(match queried {
        Ok(entries) if !entries.is_empty() => BalanceResult { entries, error: None, quota },
        Ok(_) if quota.is_some() => {
            // 余额字段缺失但有额度(纯套餐账户):不折错,只显示额度行。
            BalanceResult { entries: Vec::new(), error: None, quota }
        }
        Ok(_) => BalanceResult { entries: Vec::new(), error: Some("响应中没有余额字段".into()), quota: None },
        Err(_) if quota.is_some() => BalanceResult { entries: Vec::new(), error: None, quota },
        Err(e) => BalanceResult { entries: Vec::new(), error: Some(e), quota: None },
    })
}

fn single(v: f64, unit: &str) -> Vec<BalanceEntry> {
    vec![BalanceEntry { label: unit.to_string(), remaining: v, unit: unit.to_string() }]
}

/// 智谱编程套餐额度解析:`/api/monitor/usage/quota/limit` →
/// `{success, data:{level, limits:[{type,percentage,nextResetTime,unit}]}}`。
///
/// 窗口分类锚 `unit`(3=5 小时滚动,6=周;cc-switch #3036:周期末尾周窗口比 5h 窗口
/// 先重置,按 reset 时间排序必把两桶标反,不能排序代替);`unit` 缺失走兜底(无
/// reset 的条目优先归 5h,其余按 reset 升序填空槽)。老套餐只回 1 条 → 仅显示 5h。
/// 按量账户回 `success:false`(msg「当前用户不存在 coding plan」)→ 空 tiers,前端
/// 不渲染额度行(余额行照常)。
fn parse_zhipu_quota(body: &Value) -> QuotaInfo {
    let empty = QuotaInfo { tiers: Vec::new(), level: None };
    if body.get("success").and_then(|v| v.as_bool()) == Some(false) {
        return empty; // 业务失败:按量无套餐 / key 失效(401 已在上游折错),统一不显示
    }
    let Some(data) = body.get("data") else { return empty };
    type Entry = (f64, Option<i64>);
    let mut five_hour: Option<Entry> = None;
    let mut weekly: Option<Entry> = None;
    let mut rest: Vec<Entry> = Vec::new();
    if let Some(limits) = data.get("limits").and_then(|v| v.as_array()) {
        for item in limits {
            let t = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if !t.eq_ignore_ascii_case("TOKENS_LIMIT") && !t.eq_ignore_ascii_case("CREDIT_LIMIT") {
                continue;
            }
            let pct = item.get("percentage").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let reset = item.get("nextResetTime").and_then(|v| v.as_i64());
            let entry = (pct, reset);
            match item.get("unit").and_then(|v| v.as_i64()) {
                Some(3) if five_hour.is_none() => five_hour = Some(entry),
                Some(6) if weekly.is_none() => weekly = Some(entry),
                _ => rest.push(entry),
            }
        }
    }
    // 兜底:unit 缺失时,无 reset 优先 5h(0% 状态下 5h 桶可能没有 reset),其余升序填。
    rest.sort_by_key(|(_, r)| (r.is_some(), r.unwrap_or(i64::MIN)));
    for entry in rest {
        if five_hour.is_none() {
            five_hour = Some(entry);
        } else if weekly.is_none() {
            weekly = Some(entry);
        }
    }
    let mut tiers = Vec::new();
    if let Some((pct, reset)) = five_hour {
        tiers.push(QuotaTier { name: "fiveHour".into(), used_pct: pct, reset_ms: reset });
    }
    if let Some((pct, reset)) = weekly {
        tiers.push(QuotaTier { name: "weekly".into(), used_pct: pct, reset_ms: reset });
    }
    QuotaInfo { tiers, level: data.get("level").and_then(|v| v.as_str()).map(String::from) }
}

fn parse_deepseek(body: &Value) -> Vec<BalanceEntry> {
    let mut out: Vec<BalanceEntry> = body
        .get("balance_infos")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|info| {
                    let cur = info.get("currency").and_then(|v| v.as_str()).unwrap_or("CNY");
                    let total = f64_field(info, "total_balance")?;
                    Some(BalanceEntry { label: cur.to_string(), remaining: total, unit: cur.to_string() })
                })
                .collect()
        })
        .unwrap_or_default();
    // 多币种钱包(CNY/USD):只要还有任一币种余额 >0,隐藏空钱包行。
    if out.iter().any(|e| e.remaining > 0.0) {
        out.retain(|e| e.remaining > 0.0);
    }
    out
}
