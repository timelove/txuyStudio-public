//! 大脑:直连 LLM API 的薄决策循环。
//!
//! 端点**独立配置**(2026-11-13 用户拍板,反转 2026-11-12 的「复用 claude 供应商」):
//! `ConductorConfig.brain_base_url` / `brain_api_key` 手填,`conductor_brain_probe` 拉模型
//! 目录后**多选按序兜底**——`brain_models` 有序链,第一个模型不支持/异常自动降级下一个,
//! 全挂才算失败。旧版引用字段(brain_provider_id/brain_model)首次调用时惰性迁移
//! (从 providers.json 镜像解析 baseUrl/token,旧模型转链首),迁移完清位。
//!
//! 协议按 `brain_api_format` 分派:anthropic → `/v1/messages`(x-api-key 与 Bearer 双头
//! 并发——独立配置没有供应商 authStyle 可读,两类中转都认);openai → `/chat/completions`
//! (兼容端点,带 response_format,不认则降级裸请求)。
//!
//! 边界(设计 §1/§6):LLM 只做**语言任务**(建议文案 / 碎片路由),决策权与硬控制全在
//! 本地——意图 JSON 校验后仍要过 guard,解析失败丢弃不重试(§5.6)。非流式 + 20s 超时
//! (建议/路由均异步消费)。
//!
//! 降级自愈:连续失败 ≥3 次 → `brain_degraded` 退避 10 分钟(期间所有调用直接短路,
//! 规则层徽标/快照不受影响),成功一次即清零 streak。兜底链成功一次即算成功(不计失败)。

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::{now_ms, ConductorState};

/// 单次调用超时(建议/路由异步消费,无需流式)。
const CHAT_TIMEOUT_SECS: u64 = 20;
/// 连续失败多少次进入退避。
const DEGRADE_AFTER_FAILS: u32 = 3;
/// 退避时长。
const DEGRADE_BACKOFF_MS: i64 = 10 * 60_000;
/// max_tokens:决策输出只要一个短 JSON,但思考模型(step-5-preview 等)的 thinking
/// 也吃同一份预算——512 会被思考吃光导致 text 块直接缺失(实测报「缺 content[0].text」,
/// 2026-11-16)。2048 不够:拆步 8 步 × 120 中文字(≈1 字 0.6-1 token)+ thinking,
/// 峰值会顶到上限把 JSON **截断成残缺**(2026-11-17 实测「拆步解析失败」,残缺 JSON
/// 解析必失败且无现场)。4096 上限不等于实际消耗(按用量计费),思考模型与拆步双留余量。
pub(crate) const MAX_TOKENS: u32 = 4096;

/// 产出意图(P2 全词汇表,设计 §4:suggest_next / dispatch_task / ask_human /
/// remember;forget 不单独出——人删条目有 UI,LLM 不该有删除权)。
#[derive(Debug, Clone)]
pub enum BrainIntent {
    /// 建议下一步:把 `text` 作为用户消息发给目标会话(仍需人在决策卡上确认)。
    SuggestNext {
        project_id: String,
        session_id: Option<String>,
        text: String,
    },
    /// 建议开 fleet worker 并行干活(P2):确认卡制,人点确认才建 worktree + 起会话。
    DispatchTask {
        project_id: String,
        task_text: String,
        /// "claude" | "codex";None = 默认 claude。
        provider: Option<String>,
    },
    /// 向人提问(P2):指挥窗弹卡,人点选项或自行处理。
    AskHuman {
        question: String,
        options: Vec<String>,
    },
    /// 记忆候选(P2):LLM 观察到值得长期记住的偏好/规则,人确认才生效。
    /// `project_id` = 项目级观察(该规则只适用于此项目);None = 用户个人偏好(全局)。
    Remember {
        kind: String,
        content: String,
        project_id: Option<String>,
    },
    /// 没有值得建议的会话。
    None,
}

/// 一次决策的完整产出:意图 + 本轮注入 prompt 的记忆条目 id(决策卡「依据」chips,
/// accept 时命中条目 hits+1)。
#[derive(Debug, Clone)]
pub struct BrainDecision {
    pub intent: BrainIntent,
    pub used_memory_ids: Vec<String>,
}

/// 从独立配置解析出的大脑端点(协议 + 认证;模型兜底链随配置带出)。
struct BrainEndpoint {
    base_url: String,
    api_key: String,
    /// 模型兜底链(有序;逐个试,第一个成功的胜出)。
    models: Vec<String>,
    /// "anthropic" = claude CLI 原生协议(`/v1/messages`);"openai" = 兼容端点。
    api_format: String,
}

/// [legacy 惰性迁移] 旧「复用 claude 供应商」引用 → 独立端点字段。仅当
/// brain_base_url 为空且 brain_provider_id 有值时执行一次:从 providers.json 镜像解析
/// baseUrl/token(引用被删则放弃迁移,报错让人手填),旧 brain_model 转兜底链首项;
/// 迁移完清 legacy 位并落盘,下次短路不再走这条。
fn migrate_legacy_locked(app: &AppHandle, data: &mut super::ConductorData) -> bool {
    if !data.config.brain_base_url.trim().is_empty() || data.config.brain_provider_id.is_none() {
        return false;
    }
    let providers = crate::claude::providers_mirror::load_providers(app);
    let Some(p) = providers.iter().find(|p| {
        p.get("id").and_then(|v| v.as_str()) == data.config.brain_provider_id.as_deref()
    }) else {
        return false; // 引用的供应商已删:不做迁移,read_endpoint 报错让人手填
    };
    let field = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let (url, key, model) = (field("baseUrl"), field("token"), field("model"));
    if url.is_empty() || key.is_empty() {
        return false;
    }
    data.config.brain_base_url = url;
    data.config.brain_api_key = key;
    if !model.is_empty() && data.config.brain_models.is_empty() {
        data.config.brain_models = vec![model];
    }
    data.config.brain_provider_id = None;
    data.config.brain_model = None;
    log::info!("conductor: legacy brain endpoint migrated from provider reference");
    true
}

/// 读端点配置 + degraded 短路检查(短锁;HTTP 在锁外)。
/// 错误文案直接面向用户(设置分区「测试大脑」原样展示),故用中文说清缺什么。
fn read_endpoint(app: &AppHandle) -> Result<BrainEndpoint, String> {
    let state = app
        .try_state::<ConductorState>()
        .ok_or_else(|| "conductor state missing".to_string())?;
    let persist_disk = {
        let mut data = state.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        if now_ms() < data.brain_degraded_until_ms {
            return Err("brain_degraded".to_string());
        }
        // 旧引用配置一次性迁移(填独立字段 + 清 legacy 位);迁移后落盘。
        let migrated = migrate_legacy_locked(app, &mut data);
        let base = data.config.brain_base_url.trim().to_string();
        let key = data.config.brain_api_key.trim().to_string();
        let models: Vec<String> = data
            .config
            .brain_models
            .iter()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .collect();
        if base.is_empty() || key.is_empty() {
            return Err("智核端点未配置:去涌现设置填 baseUrl 与 token".to_string());
        }
        if models.is_empty() {
            return Err("未选择智核模型:去设置「拉取模型」后按优先级勾选".to_string());
        }
        let fmt = if data.config.brain_api_format == "openai" { "openai" } else { "anthropic" };
        let disk = if migrated { Some(super::snapshot_disk(&data)) } else { None };
        (BrainEndpoint { base_url: base, api_key: key, models, api_format: fmt.to_string() }, disk)
    };
    if let Some(disk) = persist_disk.1 {
        let _ = super::save_disk(app, &disk);
    }
    Ok(persist_disk.0)
}

/// 失败/成功计数(短锁;调用方在 HTTP 结束后调用)。
fn register_fail(app: &AppHandle) {
    if let Some(state) = app.try_state::<ConductorState>() {
        if let Ok(mut data) = state.0.lock() {
            data.brain_fail_streak += 1;
            if data.brain_fail_streak >= DEGRADE_AFTER_FAILS {
                data.brain_degraded_until_ms = now_ms() + DEGRADE_BACKOFF_MS;
                data.brain_fail_streak = 0;
                log::warn!("conductor: brain degraded, backing off {}ms", DEGRADE_BACKOFF_MS);
            }
        }
    }
}

fn register_ok(app: &AppHandle) {
    if let Some(state) = app.try_state::<ConductorState>() {
        if let Ok(mut data) = state.0.lock() {
            data.brain_fail_streak = 0;
            data.brain_degraded_until_ms = 0;
            data.last_brain_error = None;
            data.last_brain_error_ms = 0;
        }
    }
}

/// 记录最近一次失败原因(运行期;决策流空态展示)。degraded 短路的「brain_degraded」
/// 不覆盖记录——真实原因已在退避前的失败里留过,覆盖反而洗掉现场。
fn record_brain_error(app: &AppHandle, err: &str) {
    if err == "brain_degraded" {
        return;
    }
    if let Some(state) = app.try_state::<ConductorState>() {
        if let Ok(mut data) = state.0.lock() {
            data.last_brain_error = Some(err.to_string());
            data.last_brain_error_ms = now_ms();
        }
    }
}

/// 单轮补全(非流式),按 `apiFormat` 分派协议,**按模型兜底链逐个试**:
/// 第一个模型 404/异常自动降级下一个,任一成功即返回;全挂才 Err。
/// 失败计数收口在链尾:Ok → 清零 streak;全部 Err → 累加(达阈值转退避)。
async fn chat(app: &AppHandle, system: &str, user: &str) -> Result<String, String> {
    let ep = read_endpoint(app)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(CHAT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("brain client: {e}"))?;
    let mut last_err = String::new();
    for model in &ep.models {
        let out = if ep.api_format == "openai" {
            chat_openai(&client, &ep, model, system, user).await
        } else {
            chat_anthropic(&client, &ep, model, system, user).await
        };
        match out {
            Ok(text) => {
                if ep.models.len() > 1 {
                    log::info!("conductor: brain model {model} succeeded (fallback chain)");
                }
                register_ok(app);
                return Ok(text);
            }
            Err(e) => {
                log::info!("conductor: brain model {model} failed: {e}, trying next in chain");
                last_err = e;
            }
        }
    }
    record_brain_error(app, &last_err);
    register_fail(app);
    Err(last_err)
}

/// anthropic 原生协议:`POST {base}/v1/messages`。system 是顶层字段(不占 messages),
/// max_tokens 必填。认证头双发(x-api-key + Authorization Bearer)——独立配置没有供应商
/// authStyle 字段可读,glm/claude 系两类中转各认其一,双发最稳(对方按己方协议取)。
async fn chat_anthropic(
    client: &reqwest::Client,
    ep: &BrainEndpoint,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    // base 已去尾 `/`;中转有按 `.../v1` 配的,那种只补 /messages,别拼出 /v1/v1。
    let base = if ep.base_url.ends_with("/v1") { ep.base_url.clone() } else { format!("{}/v1", ep.base_url) };
    let body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "temperature": 0.2,
        "system": system,
        "messages": [{ "role": "user", "content": user }],
    });
    let resp = client
        .post(format!("{base}/messages"))
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .header("x-api-key", &ep.api_key)
        .header("authorization", format!("Bearer {}", ep.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("brain http: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let brief: String = resp.text().await.unwrap_or_default().chars().take(200).collect();
        return Err(format!("brain HTTP {status}: {brief}"));
    }
    let parsed: Value = resp.json().await.map_err(|e| format!("brain 响应解析失败: {e}"))?;
    // 兼容层:思考模型 thinking 块 / content 字符串 / openai 形状串门(见 extract_anthropic_text)。
    extract_anthropic_text(&parsed).ok_or_else(|| no_text_err(&parsed, "anthropic"))
}

// ---------------------------------------------------------- 响应抠文本(容错层)

/// 数组块拼接 `type=="text"` 的 text 值(anthropic content 数组 / openai 多模态
/// 分块数组共用;思考模型的 thinking 块天然跳过)。
fn join_text_blocks(arr: &[Value]) -> String {
    arr.iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("")
}

/// openai 响应抠文本,三层兼容:
/// 1. `choices[0].message.content` 字符串(标准);
/// 2. content 是数组(多模态分块格式)→ 拼 text 块;
/// 3. `choices[0].text`(老 completions 格式,部分中转仍回)。
fn extract_openai_text(v: &Value) -> Option<String> {
    if let Some(content) = v.pointer("/choices/0/message/content") {
        if let Some(s) = content.as_str() {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        } else if let Some(arr) = content.as_array() {
            let s = join_text_blocks(arr);
            if !s.trim().is_empty() {
                return Some(s);
            }
        }
    }
    v.pointer("/choices/0/text")
        .and_then(|t| t.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// anthropic 响应抠文本,三层兼容(中转站怪癖):
/// 1. content 数组 → 拼全部 text 块(思考模型 content[0] 是 thinking,text 在后面);
/// 2. content 字符串(劣质中转不回数组直接回串);
/// 3. 整体是 openai 形状(有的中转 `/v1/messages` 回的却是 chat/completions 结构)。
fn extract_anthropic_text(v: &Value) -> Option<String> {
    if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
        let s = join_text_blocks(arr);
        if !s.trim().is_empty() {
            return Some(s);
        }
    }
    if let Some(s) = v.get("content").and_then(|c| c.as_str()) {
        if !s.trim().is_empty() {
            return Some(s.to_string());
        }
    }
    extract_openai_text(v)
}

/// 抠不出文本时的错误信息:协议关键字段 + 原文截断,任何新怪癖都能一眼看到形状。
fn no_text_err(v: &Value, proto: &str) -> String {
    let (kinds, stop) = match proto {
        "anthropic" => {
            let kinds: Vec<&str> = v
                .get("content")
                .and_then(|c| c.as_array())
                .map(|arr| arr.iter().filter_map(|b| b.get("type").and_then(|t| t.as_str())).collect())
                .unwrap_or_default();
            let stop = v.get("stop_reason").and_then(|s| s.as_str()).unwrap_or("?").to_string();
            (format!("content 类型: [{}]", kinds.join(",")), format!("stop_reason: {stop}"))
        }
        _ => {
            let ctype = v
                .pointer("/choices/0/message/content")
                .map(|c| match c {
                    Value::String(_) => "string",
                    Value::Array(_) => "array",
                    Value::Null => "null",
                    _ => "other",
                })
                .unwrap_or("missing")
                .to_string();
            let finish = v.pointer("/choices/0/finish_reason").and_then(|f| f.as_str()).unwrap_or("?").to_string();
            (format!("message.content: {ctype}"), format!("finish_reason: {finish}"))
        }
    };
    let brief: String = serde_json::to_string(v).unwrap_or_default().chars().take(120).collect();
    format!("brain 响应抠不出文本({kinds}, {stop}; 原文: {brief})")
}

/// OpenAI 兼容协议:`POST {base}/chat/completions`。带 `response_format: json_object`;
/// 端点不认(HTTP 4xx)时降级裸请求重试一次,解析层再做 ```json 抠块兜底。
async fn chat_openai(
    client: &reqwest::Client,
    ep: &BrainEndpoint,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", ep.base_url);

    let send = |rf: bool| {
        // messages 在闭包内重建(system/user 是借用的 &str,零成本;两次调用各建一份)。
        let messages = json!([
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ]);
        let mut body = json!({
            "model": model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": MAX_TOKENS,
        });
        if rf {
            body["response_format"] = json!({ "type": "json_object" });
        }
        client.post(&url).bearer_auth(&ep.api_key).json(&body).send()
    };

    // 首选 json_object;HTTP 4xx(端点不认该参数)→ 降级裸请求重试一次。
    let resp = match send(true).await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) if r.status().is_client_error() => {
            let status = r.status();
            let brief: String = r.text().await.unwrap_or_default().chars().take(200).collect();
            log::info!("conductor: brain json_object rejected ({status} {brief}), retrying without response_format");
            send(false).await.map_err(|e| format!("brain http: {e}"))?
        }
        Ok(r) => {
            let status = r.status();
            let brief: String = r.text().await.unwrap_or_default().chars().take(200).collect();
            return Err(format!("brain HTTP {status}: {brief}"));
        }
        Err(e) => return Err(format!("brain http: {e}")),
    };

    let parsed: Result<Value, reqwest::Error> = resp.json().await;
    let body = parsed.map_err(|e| format!("brain 响应解析失败: {e}"))?;
    // 兼容层:标准字符串 / 多模态分块数组 / 老 completions text(见 extract_openai_text)。
    extract_openai_text(&body).ok_or_else(|| no_text_err(&body, "openai"))
}

/// 解析兜底(2026-11-17 强化,实测「拆步解析失败」三层叠加):剥 `<think>` 段 →
/// 直解 → 从最后一个 `}` 往前逐个 `{` 试切(最深合法对象优先)。旧版「首个 `{` 到
/// 末个 `}`」截取会被 think 段/解释文字里的 `{` 劫持起点,切出跨段脏串必失败。
pub fn parse_json_loose(content: &str) -> Option<Value> {
    let mut text = content.trim();
    // 思考模型混排:部分中转(anthropic 协议)把 thinking 直接塞进 text 块,
    // 形如 `<think>…(内含大括号)…</think>{"steps":[…]}`——先剥掉再解析(可多段)。
    let stripped;
    if text.contains("</think>") {
        let mut s = String::with_capacity(text.len());
        let mut rest = text;
        while let (Some(a), Some(b)) = (rest.find("<think>"), rest.find("</think>")) {
            if a > b {
                break;
            }
            s.push_str(&rest[..a]);
            rest = &rest[b + "</think>".len()..];
        }
        s.push_str(rest);
        stripped = s;
        text = stripped.trim();
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Some(v);
    }
    // ```json 围栏 / 前后解释文字混排:锁定末个 `}`(完整 JSON 的终点),起点从右往左
    // 逐个 `{` 试——最深的合法对象最先命中;think 残段或解释里的 `{` 不再劫持。
    if let Some(end) = text.rfind('}') {
        let mut from = end;
        while let Some(start) = text[..from].rfind('{') {
            if let Ok(v) = serde_json::from_str::<Value>(&text[start..=end]) {
                return Some(v);
            }
            from = start;
        }
    }
    None
}

/// 建议生成(system 角色含意图词汇表与硬约束;§4/§5:不代批、不硬控、编造目标即废)。
const SUGGEST_SYSTEM: &str = r#"你是 txuyStudio 的「值班副官」:多会话 AI 工作台的注意力助手。状态判定已由本地规则完成,你只负责语言任务——决定本轮最值得做的一件事。
你会收到:全体会话状态快照(每行:`provider|projectId/项目名|会话标题|语义态|附言`)、触发会话、长期记忆(分两段:用户个人记忆对所有项目适用;项目记忆每行带 [项目名] 前缀,只对所属项目适用)。
只输出一个 JSON 对象,kind 之一:
{"kind":"suggest_next","projectId":"...","sessionId":"...","text":"..."} — 给某会话拟下一步指令
{"kind":"dispatch_task","projectId":"...","taskText":"...","provider":"claude"} — 建议开一个 fleet worker(worktree 隔离、不抢现有会话)并行干这个独立任务;provider 可省略(默认 claude)
{"kind":"ask_human","question":"...","options":["...","..."]} — 需要人决策的问题(2-4 个选项)
{"kind":"remember","memoryKind":"preference","content":"...","projectId":"..."} — 观察到值得长期记住的偏好/规则(慎用);项目特有的规则带上该项目的 projectId(快照第二列 `/` 前的 id),用户个人偏好不带
{"kind":"none"} — 无值得做的
硬约束:
- projectId 必须原样取自快照行第二列 `/` 前的串,不要改写或翻译;sessionId 若给也必须真实存在;编造即废
- 项目记忆只对其前缀标注的项目生效,不得跨项目套用;用户个人记忆对所有项目生效
- suggest_next 的 text 是将以用户身份发给该会话的具体指令或追问(≤80 字),不要寒暄、不要复述状态
- dispatch_task 仅用于与现有会话不冲突的独立并行任务;taskText 是给 worker 的完整任务描述(首条指令)
- 你无权审批/代批权限,无权杀进程/删文件;涉及这些只会被丢弃
- 优先处理 waiting_approval / error;finished 的会话建议自然衔接的下一步
- 与长期记忆冲突的建议会被拒绝——记忆是用户确认过的偏好"#;

/// 项目 id 规范化:模型回的 projectId 可能是精确 id / 项目显示名 / 名字 slug 化
/// (快照行虽然带 id,模型仍常抄名字——2026-11-16 实测回 `znyw-gis-udp` 被严格
/// 校验当幻觉毙掉,决策流零产出)。三层解析:精确 id → 名字精确 → slug 唯一命中;
/// 多命中或零命中才拒(slug 撞名不猜)。
fn resolve_project_id(raw: &str, projects: &[(String, String)]) -> Option<String> {
    if projects.iter().any(|(id, _)| id == raw) {
        return Some(raw.to_string());
    }
    if let Some((id, _)) = projects.iter().find(|(_, name)| name == raw) {
        return Some(id.clone());
    }
    let norm = |s: &str| -> String {
        s.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .flat_map(|c| c.to_lowercase())
            .collect()
    };
    let key = norm(raw);
    if key.is_empty() {
        return None;
    }
    let hits: Vec<&String> = projects
        .iter()
        .filter(|(id, name)| norm(id) == key || norm(name) == key)
        .map(|(id, _)| id)
        .collect();
    if hits.len() == 1 {
        return Some(hits[0].clone());
    }
    None
}

/// 意图解析 + 目标校验(`projects` 非空时 projectId 必须可解析到快照内项目,防幻觉;
/// 校验通过即把 projectId 规范化为内部真 id——后续投递按 id 寻址)。
pub fn parse_suggest(content: &str, projects: &[(String, String)]) -> Result<BrainIntent, String> {
    let v = parse_json_loose(content).ok_or_else(|| format!("意图解析失败: {}", content.chars().take(120).collect::<String>()))?;
    // 校验 + 规范化共用;空候选表(理论不达,sessions/tree 至少一者非空才进 brain)跳过。
    let resolve = |raw: String, kind: &str| -> Result<String, String> {
        if projects.is_empty() {
            return Ok(raw);
        }
        resolve_project_id(&raw, projects)
            .ok_or_else(|| format!("{kind} projectId 无法对应快照内项目: {raw}(候选 id: {})",
                projects.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>().join(", ")))
    };
    match v.get("kind").and_then(|k| k.as_str()) {
        Some("none") | None => Ok(BrainIntent::None),
        Some("suggest_next") => {
            let project_id = v
                .get("projectId")
                .and_then(|p| p.as_str())
                .map(str::to_string)
                .ok_or_else(|| "suggest_next 缺 projectId".to_string())?;
            let project_id = resolve(project_id, "suggest_next")?;
            let text = v
                .get("text")
                .and_then(|t| t.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .ok_or_else(|| "suggest_next 缺 text".to_string())?;
            Ok(BrainIntent::SuggestNext {
                project_id,
                session_id: v.get("sessionId").and_then(|s| s.as_str()).map(str::to_string),
                text,
            })
        }
        Some("dispatch_task") => {
            let project_id = v
                .get("projectId")
                .and_then(|p| p.as_str())
                .map(str::to_string)
                .ok_or_else(|| "dispatch_task 缺 projectId".to_string())?;
            let project_id = resolve(project_id, "dispatch_task")?;
            let task_text = v
                .get("taskText")
                .and_then(|t| t.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .ok_or_else(|| "dispatch_task 缺 taskText".to_string())?;
            let provider = v
                .get("provider")
                .and_then(|p| p.as_str())
                .map(str::to_string)
                .filter(|p| p == "claude" || p == "codex");
            Ok(BrainIntent::DispatchTask { project_id, task_text, provider })
        }
        Some("ask_human") => {
            let question = v
                .get("question")
                .and_then(|q| q.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .ok_or_else(|| "ask_human 缺 question".to_string())?;
            let options = v
                .get("options")
                .and_then(|o| o.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|o| o.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Ok(BrainIntent::AskHuman { question, options })
        }
        Some("remember") => {
            let content = v
                .get("content")
                .and_then(|c| c.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .ok_or_else(|| "remember 缺 content".to_string())?;
            let kind = v
                .get("memoryKind")
                .and_then(|k| k.as_str())
                .map(str::to_string)
                .filter(|k| k == "rule" || k == "preference" || k == "habit")
                .unwrap_or_else(|| "preference".to_string());
            // 项目级观察:projectId 宽松解析——解析不到(编造/不在快照)降级为个人
            // 记忆而不是毙卡(候选还要人确认,scope 人看得见;毙卡丢线索更亏)。
            let project_id = v
                .get("projectId")
                .and_then(|p| p.as_str())
                .and_then(|raw| resolve_project_id(raw, projects));
            Ok(BrainIntent::Remember { kind, content, project_id })
        }
        Some(other) => Err(format!("未知意图 kind: {other}")),
    }
}

/// 生成建议(快照行由调用方组装;`projects` 为快照内 (projectId, 项目名) 候选表,
/// `memory` 为分层注入的已确认记忆,返回意图 + used_memory_ids)。
/// 记忆与快照一起进 prompt,产出引用可解释;项目记忆行带 [项目名] 前缀且
/// system 明示「只对所属项目生效」——个人偏好与项目约束不再混一段互相污染。
pub async fn decide(
    app: &AppHandle,
    snapshot_lines: &str,
    trigger_line: &str,
    projects: &[(String, String)],
    memory: &super::memory::GroupedMemory,
) -> Result<BrainDecision, String> {
    let name_of = |pid: &str| -> String {
        projects
            .iter()
            .find(|(id, _)| id == pid)
            .map(|(_, name)| name.clone())
            .unwrap_or_else(|| pid.to_string())
    };
    let mut memory_block = String::new();
    if !memory.personal.is_empty() {
        memory_block.push_str(&format!(
            "\n\n用户个人记忆(已确认,对所有项目适用):\n{}\n",
            memory
                .personal
                .iter()
                .map(|(_, c)| format!("- {c}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !memory.per_project.is_empty() {
        memory_block.push_str(&format!(
            "\n\n项目记忆(已确认,仅对 [项目名] 标注的项目适用):\n{}\n",
            memory
                .per_project
                .iter()
                .map(|(_, pid, c)| format!("- [{}] {c}", name_of(pid)))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let user = format!(
        "会话快照:\n{snapshot_lines}\n\n触发会话:{trigger_line}{memory_block}\n\n给出建议。"
    );
    let content = chat(app, SUGGEST_SYSTEM, &user).await?;
    let intent = parse_suggest(&content, projects)?;
    Ok(BrainDecision {
        intent,
        used_memory_ids: memory.all_ids(),
    })
}

/// 纠偏提炼(P2,设计 §7 写入第一路):建议被 reject/edit 时,从差异中提炼一条
/// 记忆候选(observed,confirmed:false 起步)。解析失败/无值得记 → None,不重试。
/// 返回 (kind, content, project_scoped):project_scoped=true 表示该规则只适用于
/// 被拒建议的目标项目(「这个项目别用 npm」),调用方落项目 scope;false = 用户
/// 个人偏好(全局)。scope 由 LLM 判,人确认是最终闸门。
pub async fn distill_correction(
    app: &AppHandle,
    original: &str,
    action: &str,
    edited: Option<&str>,
    project_name: Option<&str>,
) -> Result<Option<(String, String, bool)>, String> {
    const SYSTEM: &str = r#"你是纠偏提炼器。AI 副官的一条建议被用户拒绝了(或修改后才采纳)。从「原建议 vs 用户的处理」差异中提炼一条值得长期记住的规则或偏好。
只输出 JSON:{"kind":"rule|preference|habit","content":"<一句话,描述用户希望副官今后怎么做>","scope":"global|project"}
scope 判据:该规则只与被拒建议所在项目的技术栈/流程相关 → "project";反映用户跨项目的通用偏好 → "global"。会话记录里会给项目名。
信息不足或纯属个案(与偏好无关)时输出 {"kind":"none"}。"#;
    let human_action = match action {
        "reject" => "用户直接拒绝了该建议".to_string(),
        _ => format!("用户改写后才采纳,改后文本:{})", edited.unwrap_or("")),
    };
    let project_line = project_name
        .map(|n| format!("被拒建议所在项目:{n}\n"))
        .unwrap_or_default();
    let user = format!("原建议:{original}\n{project_line}{human_action}\n\n提炼记忆候选。");
    let content = chat(app, SYSTEM, &user).await?;
    let v = parse_json_loose(&content).ok_or_else(|| "提炼解析失败".to_string())?;
    let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    if kind == "none" || kind.is_empty() {
        return Ok(None);
    }
    let text = v
        .get("content")
        .and_then(|c| c.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "提炼缺 content".to_string())?;
    let kind = if kind == "rule" || kind == "preference" || kind == "habit" {
        kind.to_string()
    } else {
        "preference".to_string()
    };
    // scope 解析宽松:LLM 没给或给错值 → global(个人偏好是默认面,项目面宁缺勿滥)。
    let project_scoped = v.get("scope").and_then(|s| s.as_str()) == Some("project");
    Ok(Some((kind, text, project_scoped)))
}

/// 验收回环·判定产出(自动驾驶一期):三值 verdict + 理由;rework 时附返工指令。
#[derive(Debug, Clone)]
pub struct VerifyOutcome {
    /// "success" | "failed" | "rework"
    pub verdict: String,
    pub reason: String,
    /// verdict=rework 时的返工指令(≤80 字,发给目标会话的下一棒);其余为空。
    pub rework: String,
}

/// 验收判定(自动驾驶一期):把「派活时的任务目标」与「会话最后产出」对照,判定
/// 任务是否达成。产出为空(重启丢 tail / 会话无文本输出)时按产出内容判定,信息不足
/// 偏 failed(保守——验收宁严勿松,自动链少动)。解析失败 → Err(调用方挂起待补判)。
/// `acceptance`(2026-11-18 用户:「验收的时候有个尺度」):投递时随条目登记的验收
/// 标准,Some 时进 user prompt——标准命中为尺度、目标意图兜底;None 只按目标意图判。
pub async fn verify_task(
    app: &AppHandle,
    goal: &str,
    session_line: &str,
    tail: &str,
    acceptance: Option<&str>,
) -> Result<Option<VerifyOutcome>, String> {
    // system 走技艺文件(`prompts/verify-task.md`,2026-11-18 用户可编辑):存在即
    // 覆盖内置默认,改完保存下一次验收即生效;三值契约与解析仍由本函数代码把守。
    let system = super::prompts::effective(app, super::prompts::PromptKind::VerifyTask);
    let tail_block = if tail.trim().is_empty() {
        "(无产出记录——会话可能刚重启,按已知信息判定)".to_string()
    } else {
        tail.to_string()
    };
    let standard = acceptance
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("验收标准(命中为尺度,目标意图兜底):\n{s}\n\n"))
        .unwrap_or_default();
    let user = format!(
        "任务目标:{goal}\n\n{standard}会话状态:{session_line}\n\n会话产出记录(旧→新):\n{tail_block}\n\n判定验收结果。"
    );
    let content = chat(app, &system, &user).await?;
    let v = parse_json_loose(&content).ok_or_else(|| "验收判定解析失败".to_string())?;
    let verdict = v.get("verdict").and_then(|s| s.as_str()).unwrap_or("").to_string();
    if !matches!(verdict.as_str(), "success" | "failed" | "rework") {
        return Err(format!("验收判定 verdict 非法: {verdict}"));
    }
    let reason = v
        .get("reason")
        .and_then(|s| s.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("(未给理由)")
        .to_string();
    let rework = v.get("rework").and_then(|s| s.as_str()).map(str::trim).unwrap_or("").to_string();
    Ok(Some(VerifyOutcome { verdict, reason, rework }))
}

/// 碎片路由(驿站):判断碎片文本最相关的项目。返回 None = 无法判断(交人手选)。
pub async fn route_fragment(app: &AppHandle, text: &str, candidate_lines: &str) -> Result<Option<String>, String> {
    const SYSTEM: &str = r#"你是碎片路由器。给定用户的一条碎片笔记与候选项目列表(每行:`projectId|项目名`),判断该碎片最相关的**一个**项目。
只输出 JSON:{"projectId":"<候选列表中的 id>"},确实无关或信息不足时输出 {"projectId":null}。
不得输出列表之外的 id。"#
    ;
    let user = format!("碎片笔记:{text}\n\n候选项目:\n{candidate_lines}");
    let content = chat(app, SYSTEM, &user).await?;
    let v = parse_json_loose(&content).ok_or_else(|| "路由解析失败".to_string())?;
    let id = v.get("projectId").and_then(|p| p.as_str()).map(str::to_string);
    // 校验在候选内(防幻觉;不在 = 视为无法判断)。
    if let Some(id) = &id {
        let known = candidate_lines.lines().any(|line| line.split('|').next() == Some(id.as_str()));
        if !known {
            return Ok(None);
        }
    }
    Ok(id)
}

/// 拆步(自动驾驶三期 P3a,设计 §3):总意图 → 有序步骤文本列表(目标会话由人选,
/// 拆步只产文本)。每步是**一句目标级指令**(说清要达成什么/怎么算完成)——智核没有
/// 项目代码访问权,禁止编造文件路径/接口名等项目细节(2026-11-18 用户实测:拆步器
/// 凭空捏造 src/timer.js 等核对项,worker 按项目实际走反被验收判死;定调=指挥台只做
/// 意图级编排,项目适配交给有项目上下文的执行会话)。解析失败 / 缺 steps 字段 →
/// Err(调用方报错留人,不静默);**空 steps = 智核判定单步可完成**(2026-11-17 起不
/// 报错——旧版抛「直接派发即可」让人再点一次发送纯属多余),调用方
/// conductor_plan_create 据此建 1 步计划(留在计划机制内,finished 触发流水线领取/续段)。
pub async fn plan_steps(app: &AppHandle, goal: &str, project_line: &str) -> Result<Vec<String>, String> {
    // system 走技艺文件(`prompts/plan-steps.md`,2026-11-18 用户:「拆步单独变成一个
    // skill,能按个人喜好编辑」):存在即覆盖内置默认,改完保存下一次拆步即生效;
    // JSON 契约、步数/字数截断仍由本函数代码把守,文件只改口径。
    let system = super::prompts::effective(app, super::prompts::PromptKind::PlanSteps);
    let user = format!("总意图:{goal}\n目标项目:{project_line}");
    let content = chat(app, &system, &user).await?;
    // 解析失败带模型原文前 200 字(2026-11-17 实测「拆步解析失败」无现场无法诊断),
    // 且计入 brain 失败记录——chat 层 register_ok 已清零,这里补记:输出不合规
    // 同样是端点问题,设置页空态/退避计数要看得见。
    let v = parse_json_loose(&content).ok_or_else(|| {
        let brief: String = content.chars().take(200).collect::<String>();
        let err = format!("拆步解析失败(模型输出前 200 字: {brief})");
        record_brain_error(app, &err);
        register_fail(app);
        err
    })?;
    let arr = v
        .get("steps")
        .and_then(|s| s.as_array())
        .ok_or_else(|| "拆步缺 steps".to_string())?;
    let mut texts: Vec<String> = arr
        .iter()
        .filter_map(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    if texts.len() > super::orchestrate::MAX_STEPS {
        texts.truncate(super::orchestrate::MAX_STEPS);
    }
    Ok(texts)
}

/// 计划链续段判定(四期 P4b):计划 finished 后轻量判一次「总意图是否还需要下一段」。
/// 返回 Some(next_goal) = 值得出续段卡(半自动,人确认才续);None = 已完成,不问。
/// **每次 finished 只判一次、问一次**——人不点/拒绝就不再问(防纠缠)。
pub async fn plan_continue(
    app: &AppHandle,
    goal: &str,
    done_summary: &str,
) -> Result<Option<String>, String> {
    const SYSTEM: &str = r#"你是「涌现」面板的拆步续段判定器。一段多步拆步计划刚全部完成(每步都验收通过)。对照总意图与已完成内容,判断总意图是否还需要**下一段续跑**。
只输出 JSON:{"continue":true|false,"next_goal":"continue 为 true 时给下一段的总意图(≤80 字,自含上下文,不依赖已完成的表述)",其余空串}
判定口径:
- continue=true 仅当总意图明显还有未覆盖的实质部分(如「重构整个模块」只完成了 3 个文件中的 1 个);
- 每步都验收通过且目标已完整覆盖 → continue=false(别为边缘完善再拉一段);
- 拿不准时 continue=false(续段烧 token,保守优先)。"#
    ;
    let user = format!("总意图:{goal}\n\n已完成步骤(旧→新,全部验收通过):\n{done_summary}");
    let content = chat(app, SYSTEM, &user).await?;
    let v = parse_json_loose(&content).ok_or_else(|| "续段判定解析失败".to_string())?;
    let go = v.get("continue").and_then(|c| c.as_bool()).unwrap_or(false);
    if !go {
        return Ok(None);
    }
    let next = v
        .get("next_goal")
        .and_then(|s| s.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    Ok(next)
}
