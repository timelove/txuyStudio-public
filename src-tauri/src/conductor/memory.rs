//! 记忆(自研第一期,设计 §7):结构化条目 + 确认门槛 + 决策引用可解释。
//!
//! 写入三路(按信号质量):**纠偏提炼**(reject/edit 建议时 LLM 提炼候选,见
//! `brain::distill_correction`)> **显式指令**(设置手填)> **批量蒸馏**(P3,未做)。
//! 种子导入:claude code 各项目 `~/.claude/projects/*/memory/MEMORY.md` 条目行 →
//! imported + 未确认候选,人审确认。
//!
//! `confirmed:false` **不注入 prompt**(确认门槛:LLM 观察到的东西没经人认可不算数);
//! 决策日志带 `used_memory_ids` → 决策卡显示「依据」chips,accept 时命中条目 hits+1
//! (被采纳的记忆才是好记忆)。不存:会话内容细节/一次性任务/密钥 token。
//! OpenViking 不依赖——「个人习惯沉淀」由本体系承接。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::now_ms;

/// prompt 注入上限(设计 §6:分层后各自封顶——个人记忆是跨项目偏好,优先保量;
/// 项目记忆按项目公平取样,单项目刷屏不挤掉别的项目)。
pub const PERSONAL_INJECT_CAP: usize = 15;
pub const PROJECT_INJECT_CAP: usize = 20;
/// 单项目最多注入条数(公平上限)。
pub const PER_PROJECT_CAP: usize = 8;

/// 记忆条目。scopes: 空 = 全局(对所有项目适用),非空 = 命中的项目 id 列表
/// (2026-11-16 用户:「记忆也能选多个项目」;camelCase 序列化对齐前端)。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    /// "rule" | "preference" | "habit"
    pub kind: String,
    /// 命中项目 id 列表(空 = 全局)。
    #[serde(default)]
    pub scopes: Vec<String>,
    /// [legacy] 旧单项目 scope;load 时迁移进 scopes,序列化不写出(一次性迁移源)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub content: String,
    /// "observed"(LLM 观察提炼) | "explicit"(人手填) | "imported"(种子导入)
    pub source: String,
    /// false = 候选,不注入 prompt;人确认后 true。
    pub confirmed: bool,
    /// 被决策采纳次数(accept 时 +1)。
    pub hits: u32,
    pub last_used_ms: Option<i64>,
    pub created_ms: i64,
}

/// memory.json 落盘壳。
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct MemoryDisk {
    entries: Vec<MemoryEntry>,
}

/// memory.json 路径(与 conductor.json 同目录,dev/prod 分离同约定)。
fn data_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    let sub = if cfg!(debug_assertions) { "txuyStudio-dev" } else { "txuyStudio" };
    Ok(base.join(sub).join("memory.json"))
}

/// 全量读(锁外调用;调用方持有 ConductorState 锁时不复用——memory 有自己的文件,
/// 但条目缓存在 ConductorData 里,见 commands 层注释)。
pub fn load(app: &AppHandle) -> Vec<MemoryEntry> {
    let Ok(path) = data_file_path(app) else {
        return Vec::new();
    };
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<MemoryDisk>(&bytes)
            .map(|d| {
                // legacy 迁移:旧单项目 scope → scopes(头部插入保序),迁移完置 None。
                let mut entries = d.entries;
                for e in entries.iter_mut() {
                    if let Some(s) = e.scope.take() {
                        if !e.scopes.contains(&s) {
                            e.scopes.insert(0, s);
                        }
                    }
                }
                entries
            })
            .unwrap_or_else(|e| {
                log::warn!("conductor: parse {} failed ({e}), memory starts empty", path.display());
                Vec::new()
            }),
        Err(_) => Vec::new(), // 首启无文件,正常
    }
}

/// 全量写(锁外调用)。
pub fn save(app: &AppHandle, entries: &[MemoryEntry]) -> Result<(), String> {
    let path = data_file_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create_dir_all: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(&MemoryDisk { entries: entries.to_vec() })
        .map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

/// 分层注入结果(2026-11-16 用户:「判断会有个人的自己记忆以及针对项目的记忆」):
/// personal = 用户个人记忆(scope=None,对所有项目适用);per_project = 项目记忆
/// (id, projectId, content,只对所属项目适用)。id 随行带出(决策卡「依据」chips 引用)。
pub struct GroupedMemory {
    pub personal: Vec<(String, String)>,
    pub per_project: Vec<(String, String, String)>,
}

impl GroupedMemory {
    /// used_memory_ids(两段合集)。
    pub fn all_ids(&self) -> Vec<String> {
        self.personal
            .iter()
            .map(|(id, _)| id.clone())
            .chain(self.per_project.iter().map(|(id, _, _)| id.clone()))
            .collect()
    }
}

/// 注入选择(锁内纯函数,分层版):confirmed 且 scopes 匹配(`relevant_projects` 为本轮
/// 快照的项目集合),按 hits 优先 + 近期使用优先排序。个人段 cap 15;项目段 cap 20 且
/// **单项目 ≤8**(轮转取样:排序后按项目轮流派发,一个高频项目不会把其他项目挤光)。
/// 多项目记忆(2026-11-16)只挂**首个命中项目**——同内容多项目重复注入只会烧 token。
pub fn pick_injectable(entries: &[MemoryEntry], relevant_projects: &[String]) -> GroupedMemory {
    let key = |e: &MemoryEntry| (e.hits, e.last_used_ms.unwrap_or(e.created_ms).max(e.created_ms));
    let mut personal: Vec<&MemoryEntry> = entries
        .iter()
        .filter(|e| e.confirmed && e.scopes.is_empty())
        .collect();
    personal.sort_by(|a, b| key(b).cmp(&key(a)));
    personal.truncate(PERSONAL_INJECT_CAP);

    // 项目段:全局排序后按项目轮转取样(每项目先取走一条,循环到 cap 满)。
    let mut scoped: Vec<(&MemoryEntry, String)> = entries
        .iter()
        .filter_map(|e| {
            if !e.confirmed {
                return None;
            }
            let pid = e.scopes.iter().find(|p| relevant_projects.contains(p))?.clone();
            Some((e, pid))
        })
        .collect();
    scoped.sort_by(|a, b| key(b.0).cmp(&key(a.0)));
    let mut per_project: Vec<(String, String, String)> = Vec::new();
    let mut taken_per_project: HashMap<String, usize> = HashMap::new();
    for (e, pid) in scoped {
        if per_project.len() >= PROJECT_INJECT_CAP {
            break;
        }
        let taken = taken_per_project.entry(pid.clone()).or_insert(0);
        if *taken >= PER_PROJECT_CAP {
            continue;
        }
        *taken += 1;
        per_project.push((e.id.clone(), pid, e.content.clone()));
    }

    GroupedMemory {
        personal: personal.iter().map(|e| (e.id.clone(), e.content.clone())).collect(),
        per_project,
    }
}

/// 建条目(纠偏提炼 / remember 意图 / 手填共用;均 confirmed:false 起步,人确认才注入)。
/// `scopes`:空 = 全局;多项目手填传完整列表。
pub fn new_entry(kind: &str, scopes: Vec<String>, content: &str, source: &str) -> MemoryEntry {
    MemoryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        scopes,
        scope: None,
        content: content.trim().to_string(),
        source: source.to_string(),
        confirmed: false,
        hits: 0,
        last_used_ms: None,
        created_ms: now_ms(),
    }
}

/// cwd → claude projects 目录名的正向编码(非字母数字 → `-`,大小写保留;实测
/// `D:\work\rust\muxy_rust` → `D--work-rust-muxy-rust`)。拿工作台项目 root_path
/// **正向**编码去匹配目录名——反解不可靠(连字符/下划线都变 `-` 不一一对应),
/// 正向比对两侧编码即可精确落 scope。
fn encode_cwd_key(root: &str) -> String {
    root.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// 种子导入(设计 §7):三路来源 → imported + 未确认候选,幂等(同 content 跳过)。
/// 1. claude code 各项目 `~/.claude/projects/<cwdKey>/memory/MEMORY.md` 条目行
///    (`- [Title](file.md) — hook`)——cwdKey 与工作台项目 root_path 正向编码匹配
///    时落**项目 scope**(项目记忆只注入该项目的决策快照,不污染全局);
/// 2. codex 全局指令 `~/.codex/AGENTS.md` 列表条目(codex 的记忆库 sqlite 在本机为空,
///    AGENTS.md 才是 codex 侧真实的用户偏好载体);
/// 3. claude 全局指令 `~/.claude/CLAUDE.md` 列表条目(对称)。
/// 全局指令条目带小节上下文(`小节: 条目`),kind=preference。
pub fn import_seed(app: &AppHandle, entries: &mut Vec<MemoryEntry>, projects: &[(String, String)]) -> usize {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    if home.is_empty() {
        return 0;
    }
    let mut added = 0;
    let push = |entries: &mut Vec<MemoryEntry>, content: String, scopes: Vec<String>| {
        if content.is_empty() || entries.iter().any(|e| e.content == content) {
            return; // 幂等
        }
        entries.push(new_entry("preference", scopes, &content, "imported"));
    };

    // 1) claude 项目记忆(带项目 scope 匹配)。
    let dir = PathBuf::from(&home).join(".claude").join("projects");
    if let Ok(read_dir) = std::fs::read_dir(&dir) {
        for proj in read_dir.flatten() {
            let md = proj.path().join("memory").join("MEMORY.md");
            let Ok(content) = std::fs::read_to_string(&md) else {
                continue;
            };
            let dir_name = proj.file_name().to_string_lossy().into_owned();
            let scope = projects
                .iter()
                .find(|(_, root)| encode_cwd_key(root) == dir_name)
                .map(|(id, _)| id.clone());
            for line in content.lines() {
                if let Some(parsed) = parse_memory_md_line(line) {
                    let before = entries.len();
                    push(entries, parsed, scope.clone().map(|s| vec![s]).unwrap_or_default());
                    if entries.len() > before {
                        added += 1;
                    }
                }
            }
        }
    }

    // 2/3) 全局指令列表条目(codex AGENTS.md + claude CLAUDE.md),全局 scope。
    for rel in [".codex/AGENTS.md", ".claude/CLAUDE.md"] {
        let path = PathBuf::from(&home).join(rel);
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        for item in parse_list_doc(&content) {
            let before = entries.len();
            push(entries, item, Vec::new());
            if entries.len() > before {
                added += 1;
            }
        }
    }

    if added > 0 {
        if let Err(e) = save(app, entries) {
            log::warn!("conductor: memory seed persist failed: {e}");
        }
    }
    added
}

/// 解析全局指令文档的列表条目:`## 小节` 下的 `- 条目` → `小节: 条目`。
/// 跳过代码块;剥 markdown 链接(`[text](url)` → text);超过 300 字截断。
fn parse_list_doc(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut section = String::new();
    let mut in_code = false;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        if let Some(h) = t.strip_prefix("## ") {
            section = h.trim().trim_end_matches('#').trim().to_string();
            continue;
        }
        let Some(item) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) else {
            continue;
        };
        let item = item.trim();
        // 剥 markdown 链接保留文本(全局指令里常见「[CONVENTIONS](path)」)。
        let mut text = String::new();
        let mut rest = item;
        while let Some(start) = rest.find('[') {
            text.push_str(&rest[..start]);
            let after = &rest[start + 1..];
            if let Some(mid) = after.find("](") {
                text.push_str(&after[..mid]);
                let tail = &after[mid + 2..];
                match tail.find(')') {
                    Some(end) => rest = &tail[end + 1..],
                    None => {
                        rest = tail;
                    }
                }
            } else {
                text.push('[');
                rest = after;
            }
        }
        text.push_str(rest);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let content = if section.is_empty() {
            text.to_string()
        } else {
            format!("{section}: {text}")
        };
        if content.chars().count() > 300 {
            out.push(content.chars().take(300).collect());
        } else {
            out.push(content);
        }
    }
    out
}

/// 解析 MEMORY.md 条目行:`- [Title](file.md) — hook` → "Title: hook"。
/// 只认 `- [` 开头的标准条目行,标题兜底整个链接文本。
fn parse_memory_md_line(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("- [") {
        return None;
    }
    let title_end = trimmed.find("](")?;
    let title = trimmed[3..title_end].trim();
    let hook = trimmed
        .split_once("—")
        .or_else(|| trimmed.split_once("--"))
        .map(|(_, h)| h.trim())
        .unwrap_or("");
    if title.is_empty() {
        return None;
    }
    let content = if hook.is_empty() {
        title.to_string()
    } else {
        format!("{title}: {hook}")
    };
    if content.chars().count() > 300 {
        Some(content.chars().take(300).collect())
    } else {
        Some(content)
    }
}
