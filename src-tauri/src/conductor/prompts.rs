//! prompt 技艺文件(2026-11-18 用户:「拆步是不是可以单独变成一个 skill,后续我也能
//! 根据个人喜好去编辑」):拆步/验收的 system prompt 外置为**用户可编辑的 md 文件**,
//! 放 conductor.json 同目录的 `prompts/` 子目录。
//!
//! 生效规则 = **文件存在即覆盖**:每次拆步/验收现场读取(低频小文件,不缓存),编辑
//! 保存后下一次调用即生效,无需重启。文件缺失/读取失败/trim 后为空 → 回退内置默认
//! (常量与代码同源,升级随之更新;改过文件后的升级漂移用「重置默认」一键拉回)。
//!
//! 播种:install 时文件不存在则写出内置默认全文(带 `#` 头注释说明),用户打开即见
//! 当前真实生效的口径直接改。头部注释行会随 prompt 一起发给智核,中性元信息不影响
//! 输出契约。

use std::path::PathBuf;
use tauri::AppHandle;

/// 拆步器内置默认(头注释 + 口径正文;播种与回退同源)。
pub const PLAN_STEPS_DEFAULT: &str = r#"# 涌现·拆步器系统提示词(可编辑技艺文件)
# 改完保存即生效(下一次拆步执行);清空全部内容或删除本文件 = 回退应用内置默认。
# 输出契约(只回 JSON)与步数/字数截断在应用代码里,这里只改拆步口径。
你是「涌现」面板的任务拆步器。用户给了一句总意图(将派给一个 AI 编程会话执行),把它拆成有序的小步骤。
只输出 JSON:{"steps":["第一步指令","第二步指令",...]}
拆步口径:
- 最多 8 步,每步 ≤120 字,是一句可直接发给 AI 编程会话、可独立验收的目标级指令
- 你没有项目代码访问权:禁止编造总意图里没提到的文件名/路径/函数/接口/目录结构;怎么实现、放在哪个文件由执行会话(有完整项目上下文)自己决定,步骤只说「要达成什么、怎么算完成」
- 可观察产物按行为描述(命令跑通/功能可演示/输出什么),不规定代码结构
- 步间自含上下文:每步都是**新发给会话的独立消息**,不用「如上」「继续刚才」指代,把必要的任务背景(总意图里出现的实体)重述清楚
- 最后一步包含验证/收尾(以行为验证:跑测试/演示输出/汇报结果)
- 顺序即执行序;总意图本身就足够单步完成时输出 {"steps":[]}(调用方按单步计划执行)"#;

/// 验收员内置默认(与拆步口径成对:拆步风格改了,验收严格度往往要跟着动,故一并开放)。
pub const VERIFY_TASK_DEFAULT: &str = r#"# 涌现·验收员系统提示词(可编辑技艺文件)
# 改完保存即生效(下一次验收判定);清空全部内容或删除本文件 = 回退应用内置默认。
# 输出契约(只回 JSON)与三值判定在应用代码里,这里只改验收口径。
你是「涌现」面板的验收员。一条任务被派给了 AI 编程会话执行,现在会话已到终态。对照任务目标与会话产出,判定任务结果。
只输出 JSON:{"verdict":"success|failed|rework","reason":"一句话判定理由","rework":"verdict 为 rework 时给出一条不超过 80 字的中文返工指令(直接发给会话的下一步),其余空串"}
判定口径:
- 任务可附带**验收标准**(「做到什么才算完成」,如退出码/文件存在/输出内容):标准命中是主要尺度,任务目标意图是兜底——标准未覆盖的维度仍按意图判定;
- 字面凑齐标准但整体方向跑偏 = failed(标准是尺子,不是唯一裁判);
- success = 目标意图已达成(以会话产出为准,不苛求代码质量,也不逐字核对目标文本里的细节表述);
- failed = 意图明确未达成或方向跑偏(不自动重试,转人工审查);
- rework = 意图合理但未完成,且一条明确指令可补救(如漏了一步/需要换个思路)。
- 任务目标是目标级描述,执行会话才是项目事实来源:会话自行选择的文件/命名/实现方式与目标字面不同**不算失败**;
- 只写计划/设计文档而未落地实现 = 未达成(除非目标本身就只要方案)。
产出信息不足时倾向 failed(保守,别让自动链空转)。"#;

/// 可外置的 prompt 技艺。后续要开放更多智核 prompt(建议/路由/续段),加枚举项 +
/// 默认常量 + `from_param` 分支即可,机制不动。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PromptKind {
    /// 拆步器(总意图 → 有序步骤)。
    PlanSteps,
    /// 验收员(任务目标 vs 会话产出判定)。
    VerifyTask,
}

impl PromptKind {
    /// 前端命令参数解析(camelCase 为主,snake 兜底)。
    pub fn from_param(raw: &str) -> Option<Self> {
        match raw {
            "planSteps" | "plan_steps" => Some(PromptKind::PlanSteps),
            "verifyTask" | "verify_task" => Some(PromptKind::VerifyTask),
            _ => None,
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            PromptKind::PlanSteps => "plan-steps.md",
            PromptKind::VerifyTask => "verify-task.md",
        }
    }

    /// 内置默认全文(含头注释)。播种即写此内容;回退路径同样发头注释,与文件行为一致。
    pub fn default_body(self) -> &'static str {
        match self {
            PromptKind::PlanSteps => PLAN_STEPS_DEFAULT,
            PromptKind::VerifyTask => VERIFY_TASK_DEFAULT,
        }
    }
}

/// prompts 目录(conductor.json 同目录下 `prompts/`,dev/prod 随之分离)。
fn prompts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let file = super::data_file_path(app)?;
    let dir = file.parent().ok_or_else(|| "conductor.json 无父目录".to_string())?;
    Ok(dir.join("prompts"))
}

/// 覆盖文件内容:存在且 trim 后非空才 Some(空文件视为「未定制」,回退内置默认)。
fn load_override(app: &AppHandle, kind: PromptKind) -> Option<String> {
    let path = prompts_dir(app).ok()?.join(kind.file_name());
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        Err(_) => None,
    }
}

/// 现场生效的 system prompt:技艺文件(存在且非空)优先,否则内置默认。
pub fn effective(app: &AppHandle, kind: PromptKind) -> String {
    load_override(app, kind).unwrap_or_else(|| kind.default_body().to_string())
}

/// 确保技艺文件存在(不存在则写内置默认),返回路径。install 播种与「打开」共用;
/// 已存在不动——用户编辑过的内容永远优先。
fn seed_file(app: &AppHandle, kind: PromptKind) -> Result<PathBuf, String> {
    let dir = prompts_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 prompts 目录失败: {e}"))?;
    let path = dir.join(kind.file_name());
    if !path.exists() {
        std::fs::write(&path, kind.default_body())
            .map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
        log::info!("conductor: seeded prompt file {}", path.display());
    }
    Ok(path)
}

/// install 播种:各技艺文件确保一份(失败只告警不阻塞——回退路径本就有内置默认)。
pub fn seed_defaults(app: &AppHandle) {
    for kind in [PromptKind::PlanSteps, PromptKind::VerifyTask] {
        if let Err(e) = seed_file(app, kind) {
            log::warn!("conductor: seed prompt failed: {e}");
        }
    }
}

/// 用系统默认编辑器打开技艺文件(不存在先播种),返回文件路径(前端悬浮展示)。
pub fn open_in_editor(app: &AppHandle, kind: PromptKind) -> Result<String, String> {
    let path = seed_file(app, kind)?;
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| format!("打开 {} 失败: {e}", path.display()))?;
    Ok(path.display().to_string())
}

/// 重置为内置默认(覆盖写回),返回路径。
pub fn reset_default(app: &AppHandle, kind: PromptKind) -> Result<String, String> {
    let path = seed_file(app, kind)?;
    std::fs::write(&path, kind.default_body())
        .map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    Ok(path.display().to_string())
}
