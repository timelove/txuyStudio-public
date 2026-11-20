//! 权限分级表(自动驾驶二期 P2a,设计见 conductor-autopilot-phase2-plan-v1 §2/§3):
//! 硬编码二值代批(Allow/Escalate)升级为**可配置三级 auto/confirm/deny**。
//!
//! 三级语义:
//! - `auto` = 自动批,CLI 自己执行,不弹卡(原 Allow);
//! - `confirm` = 弹卡留人(原 Escalate 常规档);
//! - `deny` = 弹卡留人 + 高危警示(**不自动拒绝**——机器替人拒一个可能是合法操作的
//!   请求,风险大于多等一下;deny 的价值是人手确认时知道这是高危区)。
//!
//! 判定顺序(设计 §2):Bash 命令先过 bash 规则(**自定义 → 内置危险模式**,命中即定级
//! ——bash 规则比工具名更具体,先判),再按工具名查工具规则(自定义 → 内置白名单),
//! 未命中回落保守 confirm。空表时行为与一期逐条一致(回归验收 §验证 1)。
//!
//! deny 不自动拒绝:机器只多标注、不替人拍板;高危卡强警示(前端红边/徽标)随 P2b 落地。

use serde::{Deserialize, Serialize};

use super::truncate_chars;

/// 分级。PartialOrd 取向 auto < confirm < deny(P2c 权限上限取 min 语义可直接用)。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Level {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "confirm")]
    Confirm,
    #[serde(rename = "deny")]
    Deny,
}

impl Level {
    pub fn as_str(&self) -> &'static str {
        match self {
            Level::Auto => "auto",
            Level::Confirm => "confirm",
            Level::Deny => "deny",
        }
    }
}

/// 工具名规则(精确匹配)。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRule {
    pub tool: String,
    pub level: Level,
}

/// Bash 命令规则(小写化 contains,与一期危险模式同口径;正则复杂度留给真实需要)。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BashRule {
    pub pattern: String,
    pub level: Level,
}

/// 自定义分级表(conductor.json `permissionRules`,serde default 零迁移;空表 =
/// 一期默认行为)。设置 UI(P2b)编辑;导出/导入 JSON 兜底同 P2b。
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PermissionRules {
    pub tools: Vec<ToolRule>,
    pub bash: Vec<BashRule>,
}

/// 判定结果:级 + 人读原因 + 命中来源("default"|"custom";P2c 加 "task_ceiling")。
pub struct Judgement {
    pub level: Level,
    /// confirm/deny 的人读原因(弹卡文案与代批流水共用);auto 为 None。
    pub reason: Option<String>,
    pub source: &'static str,
}

/// 只读工具:看一眼不改状态,放行无副作用(一期 READONLY_TOOLS 机械翻译)。
const READONLY_TOOLS: &[&str] = &[
    "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "Task", "NotebookRead",
];

/// 文件编辑工具:`acceptEdits` 本来就自动放行的一档,代批同口径(一期 EDIT_TOOLS)。
const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// 内置 Bash 危险子串(小写化后 contains;一期 DANGER_SUBSTRINGS 原样搬入,级=deny)。
/// 宁少勿滥——误伤会把人拽回来看,漏放才危险;`curl`/`iwr` 单独不拦(装包常见),
/// 只拦管道进 shell 执行。
const DANGER_SUBSTRINGS: &[&str] = &[
    // 不可逆删除(跨平台:bash / cmd / powershell)
    "rm -rf",
    "rm -fr",
    "rm -r -f",
    "rmdir /s",
    "rd /s",
    "del /f",
    "del /s",
    "remove-item -recurse",
    "remove-item -force",
    "git clean -fdx",
    // 磁盘/系统层
    "diskpart",
    "mkfs.",
    "dd if=",
    "> /dev/sd",
    "format c:",
    // git 历史覆写
    "git reset --hard",
    "git push --force",
    "git push -f",
    // 注册表 / 执行策略
    "reg delete",
    "reg add",
    "set-executionpolicy",
    // 下载即执行
    "invoke-expression",
    "| iex",
    "|iex",
    "| bash",
    "|bash",
    "| sh",
    "downloadstring",
    // 凭证文件
    ".ssh/",
    "id_rsa",
    ".aws/credentials",
];

/// 流水/弹卡的原因文案截断(规则 pattern 理论上可控,防御性截断)。
const REASON_MAX: usize = 80;

/// 纯判定:工具名 + 输入 + 分级表 → 级。不读状态、不碰 IO。
pub fn judge(tool_name: &str, input: &serde_json::Value, rules: &PermissionRules) -> Judgement {
    // Bash:命令串先过 bash 规则(自定义优先,内置危险模式兜底),命中即定级。
    if tool_name == "Bash" {
        let cmd = input.get("command").and_then(|v| v.as_str()).unwrap_or("");
        if cmd.trim().is_empty() {
            return Judgement {
                level: Level::Confirm,
                reason: Some("空命令".to_string()),
                source: "default",
            };
        }
        let lower = cmd.to_lowercase();
        for r in &rules.bash {
            let pat = r.pattern.trim().to_lowercase();
            if !pat.is_empty() && lower.contains(&pat) {
                return Judgement {
                    level: r.level,
                    reason: Some(truncate_chars(&format!("命中 Bash 规则「{}」", r.pattern), REASON_MAX)),
                    source: "custom",
                };
            }
        }
        for pat in DANGER_SUBSTRINGS {
            if lower.contains(pat) {
                return Judgement {
                    level: Level::Deny,
                    reason: Some(format!("命中危险模式「{pat}」")),
                    source: "default",
                };
            }
        }
    }

    // 工具规则:自定义优先(可覆盖内置,如把 WebFetch 降 confirm / 把自家脚本升 auto)。
    for r in &rules.tools {
        if r.tool == tool_name {
            return Judgement {
                level: r.level,
                reason: if r.level == Level::Auto {
                    None
                } else {
                    Some(truncate_chars(&format!("自定义规则:工具「{tool_name}」定为 {}", r.level.as_str()), REASON_MAX))
                },
                source: "custom",
            };
        }
    }

    // 内置默认表(一期白名单机械翻译):只读/编辑 → auto;ExitPlanMode → confirm;
    // 非 Bash 未知工具 → confirm。
    if tool_name == "ExitPlanMode" {
        return Judgement {
            level: Level::Confirm,
            reason: Some("计划须人确认".to_string()),
            source: "default",
        };
    }
    if READONLY_TOOLS.contains(&tool_name) || EDIT_TOOLS.contains(&tool_name) {
        return Judgement {
            level: Level::Auto,
            reason: None,
            source: "default",
        };
    }
    if tool_name == "Bash" {
        // 走到这说明 bash 规则全未命中:非危险 Bash 与一期同口径自动放行。
        return Judgement {
            level: Level::Auto,
            reason: None,
            source: "default",
        };
    }
    Judgement {
        level: Level::Confirm,
        reason: Some(format!("白名单外工具「{tool_name}」")),
        source: "default",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn judge_default(tool: &str, input: serde_json::Value) -> Judgement {
        judge(tool, &input, &PermissionRules::default())
    }

    /// 回归:空表判定与一期二值白名单逐条一致。
    #[test]
    fn default_table_matches_phase1() {
        let j = judge_default("Read", json!({}));
        assert_eq!(j.level, Level::Auto);
        let j = judge_default("Edit", json!({}));
        assert_eq!(j.level, Level::Auto);
        let j = judge_default("Bash", json!({ "command": "cargo check" }));
        assert_eq!(j.level, Level::Auto);
        let j = judge_default("Bash", json!({ "command": "rm -rf /" }));
        assert_eq!(j.level, Level::Deny);
        assert!(j.reason.unwrap().contains("rm -rf"));
        let j = judge_default("Bash", json!({ "command": "" }));
        assert_eq!(j.level, Level::Confirm);
        let j = judge_default("ExitPlanMode", json!({}));
        assert_eq!(j.level, Level::Confirm);
        let j = judge_default("SomeUnknownTool", json!({}));
        assert_eq!(j.level, Level::Confirm);
    }

    /// 自定义 Bash 规则覆盖内置危险模式(git push 普通分支自动批)。
    #[test]
    fn custom_bash_rule_overrides_builtin_danger() {
        let rules = PermissionRules {
            tools: vec![],
            bash: vec![BashRule { pattern: "git push".into(), level: Level::Auto }],
        };
        let j = judge("Bash", &json!({ "command": "git push origin dev" }), &rules);
        assert_eq!(j.level, Level::Auto);
        assert_eq!(j.source, "custom");
        // 强推仍被更精确的内置模式拦(git push --force 同时含两条,自定义先命中……
        // 按顺序自定义先胜——用户显式要 push 全 auto,尊重之;想拦强推就写更具体的规则)。
        let rules2 = PermissionRules {
            tools: vec![],
            bash: vec![BashRule { pattern: "git push --force".into(), level: Level::Deny }],
        };
        let j = judge("Bash", &json!({ "command": "git push --force origin dev" }), &rules2);
        assert_eq!(j.level, Level::Deny);
    }

    /// 自定义工具规则生效(WebFetch 降 confirm)。
    #[test]
    fn custom_tool_rule_applies() {
        let rules = PermissionRules {
            tools: vec![ToolRule { tool: "WebFetch".into(), level: Level::Confirm }],
            bash: vec![],
        };
        let j = judge("WebFetch", &json!({}), &rules);
        assert_eq!(j.level, Level::Confirm);
        assert_eq!(j.source, "custom");
    }
}
