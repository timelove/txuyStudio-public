//! 系统环境查询命令:`get_system_memory` + `get_git_branch` + `list_ai_cli_sessions`。
//!
//! 两者都是只读、无状态、不持 AppState 锁的环境信息查询,与 `state::commands` 的可变
//! 工作区状态职责不同。亚毫秒级操作,直接同步调用(与 `pty::commands::pick_shell`
//! 在 async 里直接 spawn `where.exe` 同量级先例),无需 `spawn_blocking`。
//! `list_ai_cli_sessions` 例外:涉及多文件遍历 + 逐行解析,用 `spawn_blocking` 包裹。

use std::io::BufRead;
use std::path::{Component, Path, PathBuf};

use sysinfo::System;

use super::{
    AiCliProviderInfo, AiCliSessionListItem, AiCliSessionMessage, MemoryInfo, ToolUseSummary,
};

/// 读取系统内存占用。无状态、无锁:每次 `new()` + `refresh_memory()`。
///
/// `refresh_memory()` 是亚毫秒级 Win32 查询(`GlobalMemoryStatusEx`),不枚举进程;
/// `percent` 自己算(不依赖 sysinfo 各版本语义不一的便捷方法),`total==0` 时回 `0.0`。
#[tauri::command]
pub async fn get_system_memory() -> Result<MemoryInfo, String> {
    let mut sys = System::new();
    sys.refresh_memory();
    let total = sys.total_memory();
    let used = sys.used_memory();
    let percent = if total > 0 {
        used as f64 / total as f64 * 100.0
    } else {
        0.0
    };
    Ok(MemoryInfo {
        used_bytes: used,
        total_bytes: total,
        percent,
    })
}

/// 解析 `<root_path>/.git/HEAD` 取当前分支名。
///
/// - 非 git 仓库(无 `.git`/无 `HEAD`)→ `Ok(None)`
/// - `ref: refs/heads/<branch>` → `Ok(Some(branch))`
/// - detached HEAD(40 位 hex) → `Ok(Some("(abcdef1)"))` 短 hash 包括号
/// - worktree/submodule(`.git` 是文件指针)→ 不跟随,`Ok(None)`
///
/// 路径校验:绝对路径 + 词法 `..` 拒绝(纵深防御,与 `pty::commands::validate_cwd` 同思路)。
/// **不用 canonicalize**:本场景不把路径喂给 ConPTY,verbatim 前缀无意义,且 canonicalize
/// 要求路径可访问会让暂时不可达的正常路径误判。
#[tauri::command]
pub async fn get_git_branch(root_path: String) -> Result<Option<String>, String> {
    let raw = Path::new(&root_path);
    if !raw.is_absolute() {
        return Err(format!("root_path not absolute: {root_path}"));
    }
    let normalized = lexical_normalize(raw);
    if normalized
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("root_path escapes via ..: {root_path}"));
    }

    let git_dir = normalized.join(".git");
    // `.git` 是文件(worktree/submodule 指针)→ 不跟随解析,直接当作无分支。
    if !git_dir.is_dir() {
        return Ok(None);
    }
    let content = match std::fs::read_to_string(git_dir.join("HEAD")) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    Ok(parse_head(&content))
}

/// 从 `HEAD` 文件内容解析分支名。
fn parse_head(content: &str) -> Option<String> {
    let line = content.lines().next().unwrap_or("").trim();
    if let Some(branch) = line.strip_prefix("ref: refs/heads/") {
        let branch = branch.trim();
        if !branch.is_empty() {
            return Some(branch.to_string());
        }
    }
    // detached HEAD:40 位十六进制 → 短 hash 包括号(与 `git status` 显示一致)。
    if line.len() == 40 && line.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(format!("({})", &line[..7]));
    }
    None
}

/// 词法规范化:解析 `.`/`..` 段但不要求路径存在(本场景只做逃逸检查,不喂 ConPTY)。
/// 与 `pty::commands::lexical_normalize` 同实现;此处内联以保持最小 diff,后续 M6 危险
/// 命令保护统一提取共享 `path_util` 时再合并。
fn lexical_normalize(p: &Path) -> std::path::PathBuf {
    use std::path::Component::{self, CurDir, Normal, ParentDir, Prefix, RootDir};
    let mut out = std::path::PathBuf::new();
    for comp in p.components() {
        match comp {
            Prefix(_) | RootDir => out.push(comp),
            CurDir => {}
            ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            Normal(s) => out.push(s),
        }
    }
    out
}

/// 批量检测可执行文件是否安装。
///
/// 默认用 `where.exe` 探测 PATH(与 `pty::commands::pick_shell` 同范式):命令存在即
/// `status.success()`。**claude 例外**:走 `claude::commands::resolve_claude_program`
/// (优先原生安装包位置,见其注释),PATH 之外的安装位置也能探测到。
/// 无状态、无锁、亚毫秒级,直接同步调用(同 module 既有先例),无需 `spawn_blocking`。
///
/// 用于前端「新建 TUI 工具窗口」(lazygit/yazi/fresh)前探测是否安装(未安装则弹提示给
/// 安装命令,不建 tab),以及 ClaudePane 的 claude 缺失检测(claudeMissing 卡片)。
#[tauri::command]
pub async fn check_commands_installed(
    commands: Vec<String>,
) -> Result<std::collections::HashMap<String, bool>, String> {
    let mut out = std::collections::HashMap::new();
    for cmd in commands {
        // claude 走专属解析(resolve_claude_program):优先原生安装包位置(~/.local/bin),
        // PATH 之外的位置也能探测到(npm 安装方式官方随时可能下线,原生安装不一定在 PATH 上);
        // 与 start_claude_session 的 spawn 用同一解析,保证「探测说装了 spawn 就找得到」。
        // 其余命令(codex/lazygit/…)仍走 where.exe PATH 探测。
        let installed = if cmd == "claude" {
            crate::claude::commands::resolve_claude_program().is_some()
        } else {
            command_no_window("where.exe")
                .arg(&cmd)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        out.insert(cmd, installed);
    }
    Ok(out)
}

/// 在资源管理器中定位文件/目录(消息流工具卡片的文件路径、/memory 等配置入口点击)。
///
/// 文件存在 → `/select` 打开父目录并选中该文件;路径本身是目录 → 直接打开;
/// 不存在 → 打开上级目录。**不经编辑器**:由用户在资源管理器里自行决定后续操作。
///
/// - `path` 通常已是绝对路径(claude/codex 工具输入的 file_path);相对时以 `cwd` 解析,
///   再词法规范化(不要求路径存在,与 get_git_branch 同思路)。
/// - explorer 是 GUI 程序,spawn 出的句柄随即丢弃(detach),不弹控制台。
#[tauri::command]
pub async fn reveal_in_folder(path: String, cwd: Option<String>) -> Result<(), String> {
    // 解析绝对路径:相对路径 join cwd(项目根),词法规范化消化 `.`/`..` 段。
    let mut abs = PathBuf::from(&path);
    if !abs.is_absolute() {
        if let Some(cwd) = cwd {
            abs = Path::new(&cwd).join(&path);
        }
    }
    let abs = lexical_normalize(&abs);

    #[cfg(windows)]
    {
        let spawn = if abs.is_file() {
            std::process::Command::new("explorer").arg("/select,").arg(&abs).spawn()
        } else if abs.is_dir() {
            std::process::Command::new("explorer").arg(&abs).spawn()
        } else {
            let parent = abs.parent().map(Path::to_path_buf).unwrap_or_else(|| abs.clone());
            std::process::Command::new("explorer").arg(&parent).spawn()
        };
        if let Err(e) = spawn {
            log::warn!("reveal_in_folder: explorer failed for {abs:?}: {e}");
        }
    }
    // 非 Windows 无 explorer:项目面向 Windows,此分支不做额外兜底(编译通过即可)。
    log::info!("reveal_in_folder: {abs:?}");
    Ok(())
}

/// 构造一个带 `CREATE_NO_WINDOW` 的 `Command`（Windows）。
///
/// release 下主程序为 `windows` 子系统（GUI，无控制台）。此时 spawn 控制台程序（如
/// `where.exe`）会触发 Windows 为子进程新建一个控制台窗口——表现为「弹一个黑窗又关掉」。
/// 加 `CREATE_NO_WINDOW`（0x0800_0000）阻止之。dev 下主程序是 `console` 子系统、子进程
/// 继承控制台，本标志无副作用。与 `pty::commands::command_no_window` 同实现（保持最小 diff，
/// 不跨模块引依赖；M6 统一工具层时再合并）。
#[cfg(windows)]
fn command_no_window(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(program);
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
fn command_no_window(program: &str) -> std::process::Command {
    std::process::Command::new(program)
}

/// AI CLI provider 注册表(供前端下拉框渲染)。加新 CLI 时在此注册一条 +
/// 在 list/get/delete 的 match 加分支 + 写对应 scan/parse 实现。
#[tauri::command]
pub async fn list_ai_cli_providers() -> Result<Vec<AiCliProviderInfo>, String> {
    Ok(vec![
        AiCliProviderInfo {
            id: "claude".into(),
            label: "Claude".into(),
        },
        AiCliProviderInfo {
            id: "codex".into(),
            label: "Codex".into(),
        },
    ])
}

/// 列出 AI CLI(Claude / Codex)记录的所有会话(轻量列表项,不含消息正文)。
///
/// **全局扫描**(参考 cc-switch `scan_sessions`):不再按 `root_path` 过滤,而是扫该 provider
/// 下**所有项目**的会话——Claude 扫 `~/.claude/projects/*/*.jsonl`(每个子目录 = 一个项目);
/// Codex 扫 `~/.codex/sessions/**/*.jsonl` 全部 rollout。每条会话自带 `cwd` 字段(从行内反推),
/// 前端据此按项目分组。`root_path` 参数仅保留用于 delete/get 的路径校验契约(list 内部不再用)。
///
/// 与 `get_git_branch` 同构(只读环境查询、路径校验):涉及多文件遍历 + 逐行 serde_json,
/// 用 `spawn_blocking` 避免阻塞 async runtime。
#[tauri::command]
pub async fn list_ai_cli_sessions(
    root_path: String,
    kind: String,
) -> Result<Vec<AiCliSessionListItem>, String> {
    // 路径校验:复用 get_git_branch 同款(绝对路径 + 词法 .. 拒绝)。
    // root_path 现仅用于 delete/get 定位契约,list 全局扫不依赖它,但仍校验以保持命令入参一致。
    let raw = Path::new(&root_path);
    if !raw.is_absolute() {
        return Err(format!("root_path not absolute: {root_path}"));
    }
    let normalized = lexical_normalize(raw);
    if normalized
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("root_path escapes via ..: {root_path}"));
    }

    tokio::task::spawn_blocking(move || match kind.as_str() {
        "codex" => scan_codex_sessions(),
        // 默认/未知 kind 走 Claude reader(Claude 是首个接入、向后兼容)。
        _ => scan_claude_sessions(),
    })
    .await
    .map_err(|e| format!("join scan task: {e}"))?
}

/// 同步扫描 Claude:`~/.claude/projects/**/*.jsonl`(全局,所有项目)。
///
/// `projects/` 下每个子目录名是某项目 cwd 的 encoded 形式(见 `encode_cwd_to_dir`),
/// 子目录内每个 `<sessionId>.jsonl` 是一条会话。用 `walk_jsonl` 递归遍历整棵树,
/// 逐文件 `parse_claude_jsonl`(已从行内 cwd 反推项目路径,无需 rootPath 过滤)。
fn scan_claude_sessions() -> Result<Vec<AiCliSessionListItem>, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir not available".to_string())?;
    let dir = home.join(".claude").join("projects");
    if !dir.is_dir() {
        // 从未用过 Claude Code → 空列表(非错误)。
        return Ok(vec![]);
    }

    let mut out = Vec::new();
    walk_jsonl(&dir, &mut |path| {
        // 只处理 <sessionId>.jsonl(文件名去扩展即 sessionId,与 Claude 体系一致)。
        let session_id = match path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
        {
            Some(s) if !s.is_empty() => s,
            _ => return,
        };
        match parse_claude_jsonl(path) {
            Ok(item) => out.push(AiCliSessionListItem {
                provider_id: "claude".into(),
                session_id,
                ..item
            }),
            Err(e) => {
                // 单文件解析失败不阻断:记 warn,跳过该会话(版本演进/损坏文件容错)。
                log::warn!("skip claude session {}: {e}", path.display());
            }
        }
    });
    // 按 lastAt 降序(最近活动在前);无 lastAt 的排末尾。
    out.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    Ok(out)
}

/// 同步扫描 Codex:`~/.codex/sessions/**/*.jsonl`(全局平铺,所有项目)。
///
/// Codex 不按项目目录分桶,所有会话平铺在 `sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl`。
/// 全局扫描时遍历全部 rollout,读首行 `session_meta.payload.cwd` 作为项目路径(前端按此分组),
/// **不再按 cwd 过滤**(与 list 全局扫语义一致)。文件名末段 uuid 即 sessionId(免解析大文件取 id)。
fn scan_codex_sessions() -> Result<Vec<AiCliSessionListItem>, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir not available".to_string())?;
    let dir = home.join(".codex").join("sessions");
    if !dir.is_dir() {
        return Ok(vec![]);
    }

    let mut out = Vec::new();
    walk_jsonl(&dir, &mut |path| {
        // 文件名:rollout-<YYYY-MM-DDTHH-MM-SS>-<sessionId>.jsonl,sessionId 是标准 uuid
        // (8-4-4-4-12 hex)。**不能用 rsplit('-').next()**——ts 段也含 '-',会把 uuid 切成末段残片。
        // 用 extract_uuid 从文件名提取完整 uuid(与 cc-switch infer_session_id_from_filename 同思路)。
        let session_id = match path
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(extract_uuid)
            .map(|s| s.to_string())
        {
            Some(s) if !s.is_empty() => s,
            _ => return,
        };
        match parse_codex_rollout(path) {
            Ok(item) => out.push(AiCliSessionListItem {
                provider_id: "codex".into(),
                session_id,
                ..item
            }),
            Err(e) => log::warn!("skip codex session {}: {e}", path.display()),
        }
    });
    out.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    Ok(out)
}

/// 递归遍历 dir 下所有 `.jsonl` 文件,对每个调用 f。单文件读取失败不阻断。
/// `pub(crate)`:claude 模块的 `read_claude_history_events` 复用(历史回填定位会话文件)。
pub(crate) fn walk_jsonl(dir: &Path, f: &mut dyn FnMut(&Path)) {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_jsonl(&path, f);
        } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            f(&path);
        }
    }
}

/// 删除某 AI CLI 的指定会话记录文件(用户在侧栏点删除时调用)。
///
/// - Claude:删 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`(目录定位与 list 相同)。
/// - Codex:在 `~/.codex/sessions/` 下递归找文件名含 `<sessionId>` 的 rollout(jsonl 文件名格式
///   `rollout-<ts>-<sessionId>.jsonl`,按文件名 stem 末段匹配,不读文件内容,最快)。
///
/// 路径校验同 list(绝对路径 + 词法 .. 拒绝)。文件不存在 → `Ok(false)`(前端静默刷新,不报错);
/// 删除成功 → `Ok(true)`。用 `spawn_blocking` 因 codex 需递归遍历。
#[tauri::command]
pub async fn delete_ai_cli_session(
    root_path: String,
    kind: String,
    session_id: String,
) -> Result<bool, String> {
    let raw = Path::new(&root_path);
    if !raw.is_absolute() {
        return Err(format!("root_path not absolute: {root_path}"));
    }
    let normalized = lexical_normalize(raw);
    if normalized
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("root_path escapes via ..: {root_path}"));
    }
    let root_path_owned = normalized.to_string_lossy().into_owned();

    tokio::task::spawn_blocking(move || match kind.as_str() {
        "codex" => delete_codex_session(&session_id),
        _ => delete_claude_session(&root_path_owned, &session_id),
    })
    .await
    .map_err(|e| format!("join delete task: {e}"))?
}

/// 读取单个 AI CLI 会话的消息流(用于会话列表右栏详情展示)。
///
/// 定位复用:list 的编码目录(Claude)/`locate_codex_rollout`(Codex)。逐行解析取
/// user/assistant 消息(role 只发这两种,跳过 developer/sidechain/system),大字段裁剪
/// (tool_result 截 500、tool_use.input 截 200、thinking 跳过)。`spawn_blocking` 包裹。
/// 文件不存在 → `Err`(指定 session 不存在是真错误,区别于 list 的空 Vec)。
#[tauri::command]
pub async fn get_ai_cli_session_messages(
    root_path: String,
    kind: String,
    session_id: String,
) -> Result<Vec<AiCliSessionMessage>, String> {
    let raw = Path::new(&root_path);
    if !raw.is_absolute() {
        return Err(format!("root_path not absolute: {root_path}"));
    }
    let normalized = lexical_normalize(raw);
    if normalized
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("root_path escapes via ..: {root_path}"));
    }
    let root_path_owned = normalized.to_string_lossy().into_owned();

    tokio::task::spawn_blocking(move || match kind.as_str() {
        "codex" => read_codex_messages(&session_id),
        _ => read_claude_messages(&root_path_owned, &session_id),
    })
    .await
    .map_err(|e| format!("join read task: {e}"))?
}

/// 读 Claude 会话消息流:`~/.claude/projects/<encoded>/<sessionId>.jsonl` 逐行解析。
fn read_claude_messages(root_path: &str, session_id: &str) -> Result<Vec<AiCliSessionMessage>, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir not available".to_string())?;
    let file = home
        .join(".claude")
        .join("projects")
        .join(encode_cwd_to_dir(root_path))
        .join(format!("{session_id}.jsonl"));
    if !file.is_file() {
        return Err(format!("session file not found: {}", file.display()));
    }
    parse_claude_messages(&file)
}

/// 读 Codex 会话消息流:locate_codex_rollout 定位后逐行解析。
fn read_codex_messages(session_id: &str) -> Result<Vec<AiCliSessionMessage>, String> {
    let file = locate_codex_rollout(session_id)
        .ok_or_else(|| format!("codex session not found: {session_id}"))?;
    parse_codex_messages(&file)
}

/// 按字符截断,末尾加省略号(避免切坏多字节)。
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

/// 解析 Claude jsonl 为消息流。
/// user 行:content 字符串→text / 数组含 tool_result→tool_result 摘要。
/// assistant 行:content[] text→text、tool_use→{name,input 截断}、thinking 跳过。
/// 跳过 isSidechain==true 的子链消息。
fn parse_claude_messages(path: &Path) -> Result<Vec<AiCliSessionMessage>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(file);
    let mut out = Vec::new();

    for line in reader.lines() {
        let line = match line { Ok(l) => l, Err(_) => continue };
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        let v: serde_json::Value = match serde_json::from_str(trimmed) { Ok(v) => v, Err(_) => continue };

        let is_sidechain = v.get("isSidechain").and_then(|x| x.as_bool()).unwrap_or(false);
        if is_sidechain { continue; }

        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let timestamp = v.get("timestamp").and_then(|x| x.as_str()).map(|s| s.to_string());
        let message = match v.get("message") { Some(m) => m, None => continue };
        let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("").to_string();

        if ty == "user" && role == "user" {
            // user content:字符串(人类输入)或数组(含 tool_result 回传)。
            if let Some(text) = message.get("content").and_then(|c| c.as_str()) {
                out.push(AiCliSessionMessage {
                    role: "user".into(),
                    timestamp,
                    text: text.to_string(),
                    tool_use: None,
                    tool_result: None,
                });
            } else if let Some(arr) = message.get("content").and_then(|c| c.as_array()) {
                for item in arr {
                    if item.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                        let content = item.get("content").and_then(|c| c.as_str()).unwrap_or("");
                        let is_error = item.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false);
                        let prefix = if is_error { "[error] " } else { "" };
                        let brief = truncate_chars(content.trim(), 500);
                        out.push(AiCliSessionMessage {
                            role: "user".into(),
                            timestamp: timestamp.clone(),
                            text: String::new(),
                            tool_use: None,
                            tool_result: Some(format!("{prefix}{brief}")),
                        });
                    }
                }
            }
        } else if ty == "assistant" && role == "assistant" {
            let mut text_parts: Vec<String> = Vec::new();
            let mut tool_use: Option<ToolUseSummary> = None;
            if let Some(arr) = message.get("content").and_then(|c| c.as_array()) {
                for item in arr {
                    let bt = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    match bt {
                        "text" => {
                            if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                                text_parts.push(t.to_string());
                            }
                        }
                        "tool_use" => {
                            let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                            let input_brief = item
                                .get("input")
                                .map(|i| i.to_string())
                                .unwrap_or_default();
                            tool_use = Some(ToolUseSummary {
                                name,
                                input_brief: truncate_chars(input_brief.trim(), 200),
                            });
                        }
                        // thinking 块跳过(可能很长,且非对话主文本)。
                        _ => {}
                    }
                }
            }
            out.push(AiCliSessionMessage {
                role: "assistant".into(),
                timestamp,
                text: text_parts.join("\n"),
                tool_use,
                tool_result: None,
            });
        }
    }
    Ok(out)
}

/// 解析 Codex rollout 为消息流。以 event_msg 为主干(user_message/agent_message),
/// response_item 只取 function_call(tool_use)/function_call_output(tool_result)。
/// 跳过 developer/base_instructions。避免 event_msg 与 response_item.message 重复。
fn parse_codex_messages(path: &Path) -> Result<Vec<AiCliSessionMessage>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(file);
    let mut out = Vec::new();

    for line in reader.lines() {
        let line = match line { Ok(l) => l, Err(_) => continue };
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        let v: serde_json::Value = match serde_json::from_str(trimmed) { Ok(v) => v, Err(_) => continue };

        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let timestamp = v.get("timestamp").and_then(|x| x.as_str()).map(|s| s.to_string());
        let payload = v.get("payload");

        if ty == "event_msg" {
            let sub = payload.and_then(|p| p.get("type")).and_then(|x| x.as_str()).unwrap_or("");
            match sub {
                "user_message" => {
                    if let Some(msg) = payload.and_then(|p| p.get("message")).and_then(|x| x.as_str()) {
                        out.push(AiCliSessionMessage {
                            role: "user".into(),
                            timestamp,
                            text: msg.trim().to_string(),
                            tool_use: None,
                            tool_result: None,
                        });
                    }
                }
                "agent_message" => {
                    if let Some(msg) = payload.and_then(|p| p.get("message")).and_then(|x| x.as_str()) {
                        out.push(AiCliSessionMessage {
                            role: "assistant".into(),
                            timestamp,
                            text: msg.trim().to_string(),
                            tool_use: None,
                            tool_result: None,
                        });
                    }
                }
                _ => {} // token_count/task_started/task_complete 等跳过。
            }
        } else if ty == "response_item" {
            let sub = payload.and_then(|p| p.get("type")).and_then(|x| x.as_str()).unwrap_or("");
            match sub {
                "function_call" => {
                    let name = payload.and_then(|p| p.get("name")).and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let args = payload.and_then(|p| p.get("arguments")).and_then(|x| x.as_str()).unwrap_or("");
                    out.push(AiCliSessionMessage {
                        role: "assistant".into(),
                        timestamp,
                        text: String::new(),
                        tool_use: Some(ToolUseSummary {
                            name,
                            input_brief: truncate_chars(args.trim(), 200),
                        }),
                        tool_result: None,
                    });
                }
                "function_call_output" => {
                    let output = payload.and_then(|p| p.get("output")).and_then(|x| x.as_str()).unwrap_or("");
                    out.push(AiCliSessionMessage {
                        role: "user".into(),
                        timestamp,
                        text: String::new(),
                        tool_use: None,
                        tool_result: Some(truncate_chars(output.trim(), 500)),
                    });
                }
                _ => {} // message(role=developer/user/assistant)跳过(event_msg 已覆盖,避免重复)。
            }
        }
    }
    Ok(out)
}

/// 删 Claude 会话文件:`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`。
fn delete_claude_session(root_path: &str, session_id: &str) -> Result<bool, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir not available".to_string())?;
    let dir = home
        .join(".claude")
        .join("projects")
        .join(encode_cwd_to_dir(root_path));
    let file = dir.join(format!("{session_id}.jsonl"));
    log::info!(
        "delete claude session: root={root_path} encoded={} sid={session_id} file={}",
        dir.display(),
        file.display()
    );
    match std::fs::remove_file(&file) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log::warn!("delete claude session not found: {}", file.display());
            Ok(false)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// 删 Codex 会话文件:在 `~/.codex/sessions/` 递归找 stem 末段 == session_id 的 jsonl。
/// Codex 文件名 `rollout-<ts>-<sessionId>.jsonl`,按文件名匹配免读内容。删第一个命中即可。
/// 定位 Codex 会话文件:在 `~/.codex/sessions/` 递归找文件名 uuid == session_id 的 rollout。
/// 文件名 `rollout-<ts>-<sessionId>.jsonl`,用 `extract_uuid` 取文件名里的完整 uuid 比对
/// (不能用 stem 末段——ts 段含 '-' 会把 uuid 切成残片)。delete 和 get 共用。
fn locate_codex_rollout(session_id: &str) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    let dir = home.join(".codex").join("sessions");
    if !dir.is_dir() {
        return None;
    }
    let mut target: Option<std::path::PathBuf> = None;
    walk_jsonl(&dir, &mut |path| {
        if target.is_some() {
            return;
        }
        let id_match = path
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(extract_uuid)
            .map(|id| id == session_id)
            .unwrap_or(false);
        if id_match {
            target = Some(path.to_path_buf());
        }
    });
    target
}

fn delete_codex_session(session_id: &str) -> Result<bool, String> {
    match locate_codex_rollout(session_id) {
        Some(file) => {
            log::info!("delete codex session: sid={session_id} file={}", file.display());
            match std::fs::remove_file(&file) {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(e.to_string()),
            }
        }
        None => {
            log::warn!("delete codex session not located: sid={session_id}");
            Ok(false)
        }
    }
}

/// Claude Code 的目录名编码:把 cwd 的 `: \ / _` 替换为 `-`,其余原样。
/// 与实证样本一致(`D:\work\rust\muxy_rust` → `D--work-rust-muxy-rust`)。
fn encode_cwd_to_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| match c {
            ':' | '\\' | '/' | '_' => '-',
            other => other,
        })
        .collect()
}

/// 从字符串中提取首个标准 UUID(8-4-4-4-12 hex)。
///
/// Codex rollout 文件名 `rollout-<ts>-<sessionId>.jsonl` 里 ts 段也含 `-`(如
/// `2026-04-07T15-13-46`),用 `rsplit('-')` 会把 uuid 切成末段残片。这里手写状态机
/// 找完整的 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` 模式(与 cc-switch `infer_session_id_from_filename`
/// 的 UUID 正则同语义,但不引入 regex 依赖)。找不到返回 None。
fn extract_uuid(s: &str) -> Option<&str> {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let bytes = s.as_bytes();
    let total: usize = GROUPS.iter().sum::<usize>() + GROUPS.len() - 1; // hex + 4 连字符
    let mut i = 0;
    while i + total <= bytes.len() {
        // 窗口 [i, i+total):期望 5 段 hex 由 4 个 '-' 分隔。
        let mut pos = i;
        let mut ok = true;
        for (gi, &len) in GROUPS.iter().enumerate() {
            if gi > 0 {
                // 段间必须是 '-'。
                if pos >= bytes.len() || bytes[pos] != b'-' {
                    ok = false;
                    break;
                }
                pos += 1;
            }
            // 段内必须 len 个 hex。
            for _ in 0..len {
                if pos >= bytes.len() || !bytes[pos].is_ascii_hexdigit() {
                    ok = false;
                    break;
                }
                pos += 1;
            }
            if !ok {
                break;
            }
        }
        if ok {
            // 前边界:窗口前(若非串首)须非 hex,避免更长 hex 串的子串命中。
            // 允许是 '-'(uuid 段间分隔)或其他非 hex 字符。
            if i > 0 && bytes[i - 1].is_ascii_hexdigit() {
                i += 1;
                continue;
            }
            // 后边界:窗口后(若非串尾)须非 hex。
            if pos < bytes.len() && bytes[pos].is_ascii_hexdigit() {
                i += 1;
                continue;
            }
            return Some(&s[i..i + total]);
        }
        i += 1;
    }
    None
}

/// 逐行流式解析 Claude 单个 jsonl,归并出列表项字段(标题/起止时间/消息数/git/cwd)。
/// 不全量读入内存:`BufReader` 按行读;每行只取字段白名单,丢弃 content/usage/patch 等大字段。
fn parse_claude_jsonl(path: &Path) -> Result<AiCliSessionListItem, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(file);

    let mut title: Option<String> = None; // 最后一条 ai-title / summary
    let mut started_at: Option<String> = None; // 首个 timestamp
    let mut last_at: Option<String> = None; // 末个 timestamp
    let mut message_count: u32 = 0;
    let mut git_branch: Option<String> = None; // 首个 gitBranch
    let mut cwd: Option<String> = None; // 首个 cwd

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue, // 损坏行跳过,不阻断。
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // 未知/损坏行不报错:serde_json Value 宽松解析,取不到字段就走默认。
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // 顶层 type 决定如何取字段。
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "ai-title" => {
                if let Some(t) = v.get("aiTitle").and_then(|x| x.as_str()) {
                    title = Some(t.to_string());
                }
            }
            // 旧版本回退:summary 行(本版本未出现,兼容用)。
            "summary" => {
                if let Some(s) = v.get("summary").and_then(|x| x.as_str()) {
                    if title.is_none() {
                        title = Some(s.to_string());
                    }
                }
            }
            _ => {}
        }

        // timestamp:首/末记录(只有 user/assistant/system/snapshot 等行带;ai-title/mode 无)。
        if let Some(ts) = v.get("timestamp").and_then(|x| x.as_str()) {
            if started_at.is_none() {
                started_at = Some(ts.to_string());
            }
            last_at = Some(ts.to_string());
        }

        // 消息数:非 sidechain 的 user/assistant 行。
        let is_sidechain = v
            .get("isSidechain")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        if !is_sidechain && (ty == "user" || ty == "assistant") {
            message_count = message_count.saturating_add(1);
        }

        // 元信息取首个出现(通常在首行 user 行)。
        if git_branch.is_none() {
            if let Some(g) = v.get("gitBranch").and_then(|x| x.as_str()) {
                git_branch = Some(g.to_string());
            }
        }
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                cwd = Some(c.to_string());
            }
        }
    }

    Ok(AiCliSessionListItem {
        provider_id: String::new(), // 由调用方(scan_*)填。
        session_id: String::new(), // 由调用方填(文件名)。
        title,
        started_at,
        last_at,
        message_count,
        git_branch,
        cwd,
    })
}

/// 解析 Codex 单个 rollout jsonl(全局扫,不过滤)。
///
/// Codex rollout 行结构:顶层 `{timestamp, type, payload}`,type 有 `session_meta`/`event_msg`/
/// `response_item`/`turn_context`。
/// - `session_meta.payload.{cwd, git.branch}` → 项目路径与 git 分支(首行)。
/// - `event_msg.payload.type=="user_message"` 的 `message` → 首条作标题(截断)。
/// - 顶层 `timestamp` → 首/末作起止时间;`event_msg.payload.type=="user_message"` 计数。
/// 字段白名单:不取 content 正文/base_instructions(单文件可达数 MB)。
fn parse_codex_rollout(path: &Path) -> Result<AiCliSessionListItem, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(file);

    let mut title: Option<String> = None; // 首条 user_message(截断)
    let mut started_at: Option<String> = None;
    let mut last_at: Option<String> = None;
    let mut message_count: u32 = 0;
    let mut git_branch: Option<String> = None;
    let mut cwd: Option<String> = None; // session_meta.payload.cwd

    // 标题截断长度(与 Codex UI thread_name 量级一致)。
    const TITLE_MAX: usize = 60;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // 顶层 timestamp:首/末记录。
        if let Some(ts) = v.get("timestamp").and_then(|x| x.as_str()) {
            if started_at.is_none() {
                started_at = Some(ts.to_string());
            }
            last_at = Some(ts.to_string());
        }

        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let payload = v.get("payload");

        if ty == "session_meta" {
            if let Some(p) = payload {
                if cwd.is_none() {
                    if let Some(c) = p.get("cwd").and_then(|x| x.as_str()) {
                        cwd = Some(c.to_string());
                    }
                }
                if git_branch.is_none() {
                    if let Some(g) = p
                        .get("git")
                        .and_then(|x| x.get("branch"))
                        .and_then(|x| x.as_str())
                    {
                        git_branch = Some(g.to_string());
                    }
                }
            }
        } else if ty == "event_msg" {
            // user_message 事件:首条作标题(截断),同时计数对话轮数。
            let sub = payload
                .and_then(|p| p.get("type"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if sub == "user_message" {
                message_count = message_count.saturating_add(1);
                if title.is_none() {
                    if let Some(msg) = payload
                        .and_then(|p| p.get("message"))
                        .and_then(|x| x.as_str())
                    {
                        let t = msg.trim();
                        let t = if t.chars().count() > TITLE_MAX {
                            // 按字符截断,避免切坏多字节;末尾省略号。
                            let cut: String = t.chars().take(TITLE_MAX).collect();
                            format!("{cut}…")
                        } else {
                            t.to_string()
                        };
                        if !t.is_empty() {
                            title = Some(t);
                        }
                    }
                }
            }
        }
    }

    // 全局扫:不再按 cwd 过滤,所有会话都返回(前端按 cwd 分组)。
    Ok(AiCliSessionListItem {
        provider_id: String::new(), // 由调用方(scan_*)填。
        session_id: String::new(), // 由调用方填(文件名)。
        title,
        started_at,
        last_at,
        message_count,
        git_branch,
        cwd,
    })
}

#[cfg(test)]
mod tests {
    use super::{encode_cwd_to_dir, extract_uuid, parse_head};

    #[test]
    fn parses_branch_ref() {
        assert_eq!(parse_head("ref: refs/heads/main\n"), Some("main".into()));
        assert_eq!(
            parse_head("ref: refs/heads/feature/slash\n"),
            Some("feature/slash".into())
        );
    }

    #[test]
    fn parses_detached_short_hash() {
        assert_eq!(
            parse_head("9abcdef0123456789abcdef0123456789abcdef0\n"),
            Some("(9abcdef)".into())
        );
    }

    #[test]
    fn unknown_returns_none() {
        assert_eq!(parse_head(""), None);
        assert_eq!(parse_head("garbage"), None);
        assert_eq!(parse_head("ref: refs/heads/\n"), None);
    }

    #[test]
    fn encodes_cwd_to_dir_name() {
        // 实证样本:`:` `\` `/` `_` → `-`,其余原样(含驼峰)。
        assert_eq!(
            encode_cwd_to_dir(r"D:\work\rust\muxy_rust"),
            "D--work-rust-muxy-rust"
        );
        assert_eq!(
            encode_cwd_to_dir(r"D:\work\goProject\ai-project"),
            "D--work-goProject-ai-project"
        );
        assert_eq!(encode_cwd_to_dir(r"C:\Windows\System32"), "C--Windows-System32");
    }

    #[test]
    fn extracts_full_uuid_from_codex_filename() {
        // codex rollout 文件名:ts 段也含 '-',rsplit('-') 会切出末段残片 `d2aff79f7b07`;
        // extract_uuid 必须取完整 uuid `019d66ca-4ba2-7710-8f4b-d2aff79f7b07`。
        assert_eq!(
            extract_uuid("rollout-2026-04-07T15-13-46-019d66ca-4ba2-7710-8f4b-d2aff79f7b07.jsonl"),
            Some("019d66ca-4ba2-7710-8f4b-d2aff79f7b07")
        );
        assert_eq!(
            extract_uuid("rollout-2026-04-08T14-17-26-019d6bbd-1205-7790-bf17-b2765ff57a3f.jsonl"),
            Some("019d6bbd-1205-7790-bf17-b2765ff57a3f")
        );
    }

    #[test]
    fn extract_uuid_rejects_non_uuid() {
        // 无完整 uuid 模式 → None。
        assert_eq!(extract_uuid("no-uuid-here-123"), None);
        assert_eq!(extract_uuid("short"), None);
        // 残片段单独出现(非完整 8-4-4-4-12)→ None。
        assert_eq!(extract_uuid("d2aff79f7b07"), None);
    }
}
