//! 系统环境查询命令:`get_system_memory` + `get_git_branch` + `list_ai_cli_sessions`。
//!
//! 两者都是只读、无状态、不持 AppState 锁的环境信息查询,与 `state::commands` 的可变
//! 工作区状态职责不同。亚毫秒级操作,直接同步调用(与 `pty::commands::pick_shell`
//! 在 async 里直接 spawn `where.exe` 同量级先例),无需 `spawn_blocking`。
//! `list_ai_cli_sessions` 例外:涉及多文件遍历 + 逐行解析,用 `spawn_blocking` 包裹。

use std::io::BufRead;
use std::path::{Component, Path, PathBuf};

/// 开发者环境体检结果(设置 → 通用「环境体检」分区,全部只读)。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCheck {
    /// 是否为 Windows Defender 环境(非 Windows/查询失败 → false,前端只显 N/A)。
    pub defender_available: bool,
    /// Defender 实时防护是否开启。
    pub real_time_protection: Option<bool>,
    /// pnpm 全局 store 路径是否已在 Defender 排除列表(杀软拦截 pnpm install 的主缓解)。
    pub pnpm_store_excluded: Option<bool>,
    /// 探测到的 pnpm store 路径(未排除时提示用)。
    pub pnpm_store_path: Option<String>,
    /// bun(~/.bun)与 cargo(~/.cargo)缓存目录是否都已在排除列表。
    pub toolchain_dirs_excluded: Option<bool>,
    /// node.exe 是否在进程排除列表。
    pub node_excluded: Option<bool>,
    /// claude.exe/codex.exe 是否都在进程排除列表。
    pub ai_cli_excluded: Option<bool>,
    /// txuy-studio.exe 是否在进程排除列表。
    pub txuy_excluded: Option<bool>,
}

/// PowerShell 只读查询(单引号包裹命令,取 stdout trim)。失败返回 None,不抛错——
/// 体检是尽力而为,任何一项查不到都按 N/A 显示。
fn ps_query(command: &str) -> Option<String> {
    let out = crate::pty::commands::command_no_window("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", command])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// 开发者环境体检(只读):Defender 实时防护状态 + 关键排除项(pnpm store/bun/cargo/node/
/// claude/codex/本应用)。
/// 终端里 pnpm/bun install 频繁 EPERM/「unknown 权限」在本机几乎都是 Defender 实时扫描锁
/// 小文件/junction(高并发安装是其重点监控形态);把 store 与进程加排除即根治。
/// 本命令**只读不改**——写操作走 `fix_defender_exclusions`(一键 UAC)或复制命令手动执行。
#[tauri::command]
pub async fn check_dev_environment() -> Result<EnvCheck, String> {
    // 非 Windows 无 Defender 语义,直接返回不可用(前端显 N/A)。
    if !cfg!(windows) {
        return Ok(EnvCheck {
            defender_available: false,
            real_time_protection: None,
            pnpm_store_excluded: None,
            pnpm_store_path: None,
            toolchain_dirs_excluded: None,
            node_excluded: None,
            ai_cli_excluded: None,
            txuy_excluded: None,
        });
    }
    // 每项独立 catch(None),单项失败不影响其余。
    let real_time = ps_query("(Get-MpComputerStatus).RealTimeProtectionEnabled").map(|s| s.eq_ignore_ascii_case("true"));
    let exclusions = ps_query("@((Get-MpPreference).ExclusionPath + (Get-MpPreference).ExclusionProcess) -join \"|\"");
    let store_path = ps_query("(pnpm store path) 2>$null");
    // bun/cargo 缓存目录:home 下固定位置(bun install cache 在 ~/.bun/install/cache,
    // cargo registry/git 在 ~/.cargo),排除整个目录即覆盖。
    let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned());
    let (pnpm_excluded, toolchain_excluded, node_excluded, ai_cli_excluded, txuy_excluded) =
        match (&exclusions, &store_path) {
            (Some(list), store) => {
                let lower = list.to_lowercase();
                let pnpm = store
                    .as_ref()
                    .map(|sp| lower.contains(&sp.to_lowercase()))
                    .unwrap_or(false);
                let toolchain = home
                    .as_ref()
                    .map(|h| {
                        let bun = format!("{}\\.bun", h).to_lowercase();
                        let cargo = format!("{}\\.cargo", h).to_lowercase();
                        lower.contains(&bun) && lower.contains(&cargo)
                    })
                    .unwrap_or(false);
                let ai_cli = lower.contains("claude.exe") && lower.contains("codex.exe");
                (
                    Some(pnpm),
                    Some(toolchain),
                    Some(lower.contains("node.exe")),
                    Some(ai_cli),
                    Some(lower.contains("txuy-studio.exe")),
                )
            }
            _ => (None, None, None, None, None),
        };
    Ok(EnvCheck {
        defender_available: true,
        real_time_protection: real_time,
        pnpm_store_excluded: pnpm_excluded,
        pnpm_store_path: store_path,
        toolchain_dirs_excluded: toolchain_excluded,
        node_excluded: node_excluded,
        ai_cli_excluded: ai_cli_excluded,
        txuy_excluded: txuy_excluded,
    })
}

/// 一键修复:把开发工具链相关路径/进程批量加进 Defender 排除列表(幂等,重复添加
/// Defender 自动去重)。走 `Start-Process -Verb RunAs` 弹 UAC——提权的是**用户在 UAC
/// 确认后的独立 powershell 进程**,应用自身仍不提权(与「app never elevates itself」
/// 决策兼容:提权动作由用户点 UAC 的「是」显式授权)。
///
/// 内层脚本经 UTF-16LE + base64 以 `-EncodedCommand` 传递,彻底规避「路径含空格/
/// 特殊字符」的多层引号转义问题。返回 Ok(true) = UAC 已确认(排除命令已下发);
/// UAC 被取消/Defender 不可用 → Err(前端提示改走复制命令手动执行)。
///
/// 注意:外层 powershell 会阻塞等用户响应 UAC(可达几十秒),故用 `spawn_blocking`
/// 包裹,不占 async runtime 线程;提权进程独立运行,应用不等它结束——前端稍后重新
/// 体检即见结果(检测是唯一真相源)。
#[tauri::command]
pub async fn fix_defender_exclusions() -> Result<bool, String> {
    if !cfg!(windows) {
        return Err("not available on this platform".to_string());
    }
    tokio::task::spawn_blocking(|| {
        // 排除路径:pnpm store(实时探测,失败回退 %LOCALAPPDATA% 默认位置)+ bun/cargo
        // home 目录。路径均来自本机探测(非用户输入),无注入面;单引号内防御性转义 '。
        let store = ps_query("(pnpm store path) 2>$null")
            .or_else(|| {
                std::env::var("LOCALAPPDATA")
                    .ok()
                    .map(|l| format!("{}\\pnpm\\store", l))
            })
            .unwrap_or_else(|| "$env:LOCALAPPDATA\\pnpm\\store".to_string());
        let home = dirs::home_dir()
            .map(|h| h.to_string_lossy().into_owned())
            .ok_or_else(|| "home dir not available".to_string())?;
        let ps_quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let inner = format!(
            "$ErrorActionPreference='Stop'; \
             Add-MpPreference -ExclusionPath @({}, {}, {}); \
             Add-MpPreference -ExclusionProcess @('node.exe','bun.exe','bunx.exe','pnpm.exe','claude.exe','codex.exe','txuy-studio.exe'); \
             exit 0",
            ps_quote(&store),
            ps_quote(&format!("{}\\.bun", home)),
            ps_quote(&format!("{}\\.cargo", home)),
        );
        // -EncodedCommand 要求 UTF-16LE 的 base64。**不要补结尾 NUL**——解码后 NUL 会
        // 成为脚本里的多余 token 直接 ParserError(干跑实测);纯 UTF-16LE 即可。
        let utf16: Vec<u8> = inner.encode_utf16().flat_map(|w| w.to_le_bytes()).collect();
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&utf16);
        // 外层(不提权):请求 UAC 启动提权 powershell 跑内层脚本。base64 标准字母表
        // 含 +/=,在 PowerShell 单引号字符串里均安全。
        let outer = format!(
            "Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-EncodedCommand','{}')",
            encoded
        );
        let out = command_no_window("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &outer])
            .output()
            .map_err(|e| format!("spawn powershell: {e}"))?;
        if out.status.success() {
            Ok(true)
        } else {
            // UAC 取消时 Start-Process 抛异常 → 外层非零退出。
            Err("UAC declined or Defender unavailable".to_string())
        }
    })
    .await
    .map_err(|e| format!("join fix task: {e}"))?
}

use sysinfo::{ProcessesToUpdate, System};
use tauri::State;

use super::{
    AiCliProviderInfo, AiCliSessionListItem, AiCliSessionMessage, MemoryInfo, PerfStats,
    ToolUseSummary,
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

/// 子进程数缓存的刷新间隔(全进程表枚举对轻量级设计偏重,降频到 10s 趋势精度足够)。
const CHILDREN_COUNT_TTL: std::time::Duration = std::time::Duration::from_secs(10);

/// 应用性能诊断快照(设置 → 性能面板轮询,2s 一次)。
///
/// 轻量化(用户对内存占用的明确设计约束):
/// - 五个 registry 各注入 `State` 短锁取 len(微秒级);
/// - 自身进程内存用 `ProcessesToUpdate::Some(&[self_pid])` **只刷新本进程**(单点查询);
/// - 直接子进程数需全进程表枚举(ppid 匹配),**10s 静态缓存降频**——它是孤儿泄漏的
///   趋势指标(持续增长即泄漏),不需要 2s 精度。全表枚举毫秒级 + 数 MB 临时分配,
///   2s 一次长期跑会让分配器 RSS 爬升,降频后开销可忽略。
#[tauri::command]
pub async fn get_perf_stats(
    pty: State<'_, crate::pty::PtyRegistry>,
    claude: State<'_, crate::claude::ClaudeRegistry>,
    codex: State<'_, crate::codex::CodexRegistry>,
    shell: State<'_, crate::shell_run::ShellRunRegistry>,
    watchers: State<'_, crate::filetree::FsWatcherRegistry>,
) -> Result<PerfStats, String> {
    let count = |len: usize| len as u32;
    let pty_sessions = count(pty.by_project.lock().map(|g| g.values().map(|m| m.len()).sum()).unwrap_or(0));
    let claude_sessions = count(claude.by_project.lock().map(|g| g.values().map(|m| m.len()).sum()).unwrap_or(0));
    let codex_sessions = count(codex.by_project.lock().map(|g| g.values().map(|m| m.len()).sum()).unwrap_or(0));
    let shell_sessions = count(shell.by_project.lock().map(|g| g.values().map(|m| m.len()).sum()).unwrap_or(0));
    let fs_watchers = count(watchers.by_project.lock().map(|g| g.len()).unwrap_or(0));

    // 自身内存:只刷本进程(单点,轻)。
    let self_pid = std::process::id();
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(self_pid)]), true);
    let rust_memory_bytes = sys
        .process(sysinfo::Pid::from_u32(self_pid))
        .map(|p| p.memory() * 1024) // sysinfo memory() 单位 KB。
        .unwrap_or(0);

    // 直接子进程数:全表枚举 + 10s 静态缓存(过期才重算)。
    static CHILDREN_CACHE: std::sync::Mutex<Option<(std::time::Instant, u32)>> = std::sync::Mutex::new(None);
    let child_processes = {
        let mut cache = CHILDREN_CACHE.lock().map_err(|e| e.to_string())?;
        let fresh = match cache.as_ref() {
            Some((at, n)) if at.elapsed() < CHILDREN_COUNT_TTL => Some(*n),
            _ => None,
        };
        match fresh {
            Some(n) => n,
            None => {
                let mut sys_all = System::new();
                sys_all.refresh_processes(ProcessesToUpdate::All, true);
                let n = sys_all
                    .processes()
                    .values()
                    .filter(|p| p.parent() == Some(sysinfo::Pid::from_u32(self_pid)))
                    .count() as u32;
                *cache = Some((std::time::Instant::now(), n));
                n
            }
        }
    };

    Ok(PerfStats {
        rust_memory_bytes,
        child_processes,
        pty_sessions,
        claude_sessions,
        codex_sessions,
        shell_sessions,
        fs_watchers,
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

// —— 用量统计(参考 cc-switch usage_daily_rollups 口径) ——
//
// 数据源是 claude/codex 的**会话 jsonl**(与 cc-switch 的 session_log 采集同源,非代理拦截):
// - claude:`type=assistant` 行的 `message.usage`(同一轮多 block 行共享 message.id,按
//   (文件, message.id) 去重,否则一轮重复计入多次——实测同一 usage 在 jsonl 里逐 block 重复)。
//   glm 等代理返回的 usage 已分解:input(增量)+ cache_read(上下文重读)+ cache_creation,
//   直接累加即真实消耗,不会高估。
// - codex:`event_msg.payload.type=token_count` 行的 `info.last_token_usage`(单次请求增量;
//   `total_token_usage` 是会话累计,不可累加)。model 从 turn_context 行取(会话内可切换)。
// 聚合粒度:(本地日期, app, model) → 请求次数 + 四段 tokens。费用由前端按内置单价估算
// (三方中转价不固定,后端只出 tokens)。

/// 一天的用量聚合(某 app 某 model)。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageRollup {
    pub date: String,
    pub app: String,
    pub model: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// 桶内出现过数据的会话文件数(distinct;同文件跨天/跨模型会进多个桶,只在桶内去重)。
    pub sessions: u64,
}

/// 会话级汇总(跨桶 distinct 文件数,Hero「会话」格用)。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub rollups: Vec<UsageRollup>,
    pub claude_sessions: u64,
    pub codex_sessions: u64,
}

#[derive(Default)]
struct UsageAcc {
    requests: u64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    /// 桶内贡献过数据的会话文件路径(distinct)。
    session_files: std::collections::BTreeSet<String>,
}

/// ISO-8601 UTC 时间戳(如 `2026-10-20T15:29:16.084Z`)→ 本地日期字符串(`2026-10-20`)。
/// 解析失败返回 None(该行跳过,不阻断整体扫描)。
fn local_date_from_ts(ts: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Local).date_naive().to_string())
}

/// 用量聚合扫描入口:days 天内(本地日期)的 claude + codex 会话用量,按 (date, app, model)
/// 分桶。文件级 mtime 预过滤(jsonl 只追加,mtime=最后活动;早于范围起点的文件全行都旧)。
fn scan_usage_rollups(days: u64) -> Result<UsageSummary, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir not available".to_string())?;
    let cutoff = chrono::Local::now() - chrono::Duration::days(days as i64);
    let cutoff_date = cutoff.date_naive().to_string();

    let mut map: std::collections::BTreeMap<(String, String, String), UsageAcc> = Default::default();
    // 跨桶 distinct 会话文件(Hero「会话」格):key=(app, 文件路径)。
    let mut all_sessions: std::collections::BTreeSet<(String, String)> = Default::default();

    // claude:~/.claude/projects/**/*.jsonl
    let claude_dir = home.join(".claude").join("projects");
    if claude_dir.is_dir() {
        walk_jsonl(&claude_dir, &mut |path| {
            // mtime 预过滤:最后活动早于范围起点 → 跳过(拿的是 mtime 对应的本地日期串比较)。
            if let Ok(meta) = std::fs::metadata(path) {
                if let Ok(modified) = meta.modified() {
                    let local: chrono::DateTime<chrono::Local> = modified.into();
                    if local.date_naive().to_string() < cutoff_date {
                        return;
                    }
                }
            }
            if scan_claude_usage_file(path, &cutoff_date, &mut map) {
                all_sessions.insert(("claude".into(), path.to_string_lossy().into_owned()));
            }
        });
    }

    // codex:~/.codex/sessions/**/*.jsonl
    let codex_dir = home.join(".codex").join("sessions");
    if codex_dir.is_dir() {
        walk_jsonl(&codex_dir, &mut |path| {
            if let Ok(meta) = std::fs::metadata(path) {
                if let Ok(modified) = meta.modified() {
                    let local: chrono::DateTime<chrono::Local> = modified.into();
                    if local.date_naive().to_string() < cutoff_date {
                        return;
                    }
                }
            }
            if scan_codex_usage_file(path, &cutoff_date, &mut map) {
                all_sessions.insert(("codex".into(), path.to_string_lossy().into_owned()));
            }
        });
    }

    let (claude_sessions, codex_sessions) = {
        let mut c = 0u64;
        let mut x = 0u64;
        for (app, _) in &all_sessions {
            if app == "claude" { c += 1 } else { x += 1 }
        }
        (c, x)
    };
    Ok(UsageSummary {
        rollups: map
            .into_iter()
            .map(|((date, app, model), acc)| UsageRollup {
                date,
                app,
                model,
                requests: acc.requests,
                input_tokens: acc.input,
                output_tokens: acc.output,
                cache_read_tokens: acc.cache_read,
                cache_creation_tokens: acc.cache_creation,
                sessions: acc.session_files.len() as u64,
            })
            .collect(),
        claude_sessions,
        codex_sessions,
    })
}

/// 单个 claude jsonl 的用量提取:逐行找 `type=assistant` 行,按 (message.id) 去重后把
/// `message.usage` 四段累进桶。坏行/坏文件静默跳过(版本演进容错,与 scan_claude_sessions 同策略)。
fn scan_claude_usage_file(
    path: &Path,
    cutoff_date: &str,
    map: &mut std::collections::BTreeMap<(String, String, String), UsageAcc>,
) -> bool {
    use std::io::BufRead;
    let mut has_data = false;
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let path_key = path.to_string_lossy().into_owned();
    // 同文件内 message.id 去重(一轮多 block 行共享 id;跨文件 id 亦全局唯一,但按文件分桶
    // 语义已够——同一会话只在一个文件)。
    let mut seen: std::collections::HashSet<String> = Default::default();
    for line in std::io::BufReader::new(file).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => return has_data,
        };
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let msg = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        let usage = match msg.get("usage") {
            Some(u) if u.is_object() => u,
            _ => continue,
        };
        // 去重:同一 message.id 的后续 block 行丢弃。
        let mid = msg.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
        if !mid.is_empty() && !seen.insert(mid) {
            continue;
        }
        let date = match v.get("timestamp").and_then(|t| t.as_str()).and_then(local_date_from_ts) {
            Some(d) => d,
            None => continue,
        };
        if date < cutoff_date.to_string() {
            continue;
        }
        let model = msg
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown")
            .to_string();
        let get = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        // 过滤 synthetic 行(system 冒充 assistant 的合成消息,model 以 `<` 开头且四段全 0)。
        let (i, o, cr, cc) = (
            get("input_tokens"),
            get("output_tokens"),
            get("cache_read_input_tokens"),
            get("cache_creation_input_tokens"),
        );
        if model.starts_with('<') && i + o + cr + cc == 0 {
            continue;
        }
        let acc = map.entry((date, "claude".into(), model)).or_default();
        acc.requests += 1;
        acc.input += i;
        acc.output += o;
        acc.cache_read += cr;
        acc.cache_creation += cc;
        acc.session_files.insert(path_key.clone());
        has_data = true;
    }
    has_data
}

/// 单个 codex rollout 的用量提取:`token_count` 行的 `info.last_token_usage`(单次请求增量;
/// total_ 是累计不可加)。model 取最近的 `turn_context.payload.model`(会话内可换模型)。
fn scan_codex_usage_file(
    path: &Path,
    cutoff_date: &str,
    map: &mut std::collections::BTreeMap<(String, String, String), UsageAcc>,
) -> bool {
    use std::io::BufRead;
    let mut has_data = false;
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let path_key = path.to_string_lossy().into_owned();
    let mut model = String::new();
    for line in std::io::BufReader::new(file).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => return has_data,
        };
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let payload = match v.get("payload").and_then(|p| p.as_object()) {
            Some(p) => p,
            None => continue,
        };
        // turn_context:刷新当前 model(token_count 事件本身不带 model)。
        if v.get("type").and_then(|t| t.as_str()) == Some("turn_context") {
            if let Some(m) = payload.get("model").and_then(|m| m.as_str()) {
                model = m.to_string();
            }
            continue;
        }
        if payload.get("type").and_then(|t| t.as_str()) != Some("token_count") {
            continue;
        }
        let last = match payload.get("info").and_then(|i| i.get("last_token_usage")).and_then(|l| l.as_object()) {
            Some(l) => l,
            None => continue,
        };
        let date = match v.get("timestamp").and_then(|t| t.as_str()).and_then(local_date_from_ts) {
            Some(d) => d,
            None => continue,
        };
        if date < cutoff_date.to_string() {
            continue;
        }
        let model = if model.is_empty() { "unknown".to_string() } else { model.clone() };
        let get = |k: &str| last.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let acc = map.entry((date, "codex".into(), model)).or_default();
        acc.requests += 1;
        // codex 口径:input_tokens **含**缓存(OpenAI 语义,cached_input_tokens 是其子集
        // ——实测 rollout:input=143277, cached=143104),须减掉得 fresh input,否则四段
        // 纯和把缓存重复计一遍(Hero 总量虚高,对齐 cc-switch fresh_input_sql 的减法)。
        // output 含 reasoning(reasoning_output_tokens 是其子集,不另计)。
        let cached = get("cached_input_tokens") + get("cache_write_input_tokens");
        let fresh_input = get("input_tokens").saturating_sub(cached);
        acc.input += fresh_input;
        acc.output += get("output_tokens");
        acc.cache_read += get("cached_input_tokens");
        acc.cache_creation += get("cache_write_input_tokens");
        acc.session_files.insert(path_key.clone());
        has_data = true;
    }
    has_data
}

/// 用量统计(设置 → 用量 tab):聚合近 `days` 天(缺省 30)claude + codex 会话 jsonl 的
/// token 用量,按 (日期, app, model) 分桶,日期升序。重 IO,spawn_blocking。
#[tauri::command]
pub async fn list_usage_rollups(days: Option<u64>) -> Result<UsageSummary, String> {
    tokio::task::spawn_blocking(move || scan_usage_rollups(days.unwrap_or(30)))
        .await
        .map_err(|e| format!("join usage scan task: {e}"))?
}

/// 请求日志单条(用量「请求日志」页:一次 API 请求 = claude 一条去重后的 assistant 行 /
/// codex 一个 token_count 事件)。倒序(最新在前),总量截断 LIMIT。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogEntry {
    /// ISO 时间戳原文(claude 行 timestamp / codex 行 timestamp)。
    pub ts: String,
    pub app: String,
    pub model: String,
    pub session_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

const REQUEST_LOG_LIMIT: usize = 3000;

/// 逐请求扫描(与 scan_usage_rollups 同源同过滤,不聚合逐条输出)。重 IO,spawn_blocking。
fn scan_request_log(days: u64) -> Result<Vec<RequestLogEntry>, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir not available".to_string())?;
    let cutoff = chrono::Local::now() - chrono::Duration::days(days as i64);
    let cutoff_date = cutoff.date_naive().to_string();
    let mut out: Vec<RequestLogEntry> = Vec::new();

    let claude_dir = home.join(".claude").join("projects");
    if claude_dir.is_dir() {
        walk_jsonl(&claude_dir, &mut |path| {
            if let Ok(meta) = std::fs::metadata(path) {
                if let Ok(modified) = meta.modified() {
                    let local: chrono::DateTime<chrono::Local> = modified.into();
                    if local.date_naive().to_string() < cutoff_date {
                        return;
                    }
                }
            }
            scan_claude_request_log(path, &cutoff_date, &mut out);
        });
    }
    let codex_dir = home.join(".codex").join("sessions");
    if codex_dir.is_dir() {
        walk_jsonl(&codex_dir, &mut |path| {
            if let Ok(meta) = std::fs::metadata(path) {
                if let Ok(modified) = meta.modified() {
                    let local: chrono::DateTime<chrono::Local> = modified.into();
                    if local.date_naive().to_string() < cutoff_date {
                        return;
                    }
                }
            }
            scan_codex_request_log(path, &cutoff_date, &mut out);
        });
    }
    // 时间倒序(最新在前;ts 格式两种都 ISO 可排序),再截断。
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out.truncate(REQUEST_LOG_LIMIT);
    Ok(out)
}

/// claude 单文件请求日志:与 scan_claude_usage_file 同提取规则(assistant 行 + message.id
/// 去重 + synthetic 过滤),但不聚合,逐条带 ts/sessionId。
fn scan_claude_request_log(path: &Path, cutoff_date: &str, out: &mut Vec<RequestLogEntry>) {
    use std::io::BufRead;
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let mut seen: std::collections::HashSet<String> = Default::default();
    for line in std::io::BufReader::new(file).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => return,
        };
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let msg = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        let usage = match msg.get("usage") {
            Some(u) if u.is_object() => u,
            _ => continue,
        };
        let mid = msg.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
        if !mid.is_empty() && !seen.insert(mid) {
            continue;
        }
        let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("").to_string();
        let date = match ts.as_str().split_once('T').map(|(d, _)| d.to_string()) {
            Some(d) => d,
            None => continue,
        };
        if date < cutoff_date.to_string() {
            continue;
        }
        let model = msg.get("model").and_then(|m| m.as_str()).unwrap_or("unknown").to_string();
        let get = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let (i, o, cr, cc) = (
            get("input_tokens"),
            get("output_tokens"),
            get("cache_read_input_tokens"),
            get("cache_creation_input_tokens"),
        );
        if model.starts_with('<') && i + o + cr + cc == 0 {
            continue;
        }
        out.push(RequestLogEntry {
            ts,
            app: "claude".into(),
            model,
            session_id: v.get("sessionId").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            input_tokens: i,
            output_tokens: o,
            cache_read_tokens: cr,
            cache_creation_tokens: cc,
        });
    }
}

/// codex 单文件请求日志:token_count 事件的 last_token_usage 逐条;sessionId 取文件名尾段
/// (rollout-<ts>-<uuid>.jsonl),同 usage 扫描。
fn scan_codex_request_log(path: &Path, cutoff_date: &str, out: &mut Vec<RequestLogEntry>) {
    use std::io::BufRead;
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .and_then(|s| s.rsplit('-').next())
        .unwrap_or("")
        .to_string();
    let mut model = String::new();
    for line in std::io::BufReader::new(file).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => return,
        };
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let payload = match v.get("payload").and_then(|p| p.as_object()) {
            Some(p) => p,
            None => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("turn_context") {
            if let Some(m) = payload.get("model").and_then(|m| m.as_str()) {
                model = m.to_string();
            }
            continue;
        }
        if payload.get("type").and_then(|t| t.as_str()) != Some("token_count") {
            continue;
        }
        let last = match payload.get("info").and_then(|i| i.get("last_token_usage")).and_then(|l| l.as_object()) {
            Some(l) => l,
            None => continue,
        };
        let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("").to_string();
        let date = match ts.as_str().split_once('T').map(|(d, _)| d.to_string()) {
            Some(d) => d,
            None => continue,
        };
        if date < cutoff_date.to_string() {
            continue;
        }
        let get = |k: &str| last.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        // codex input 含缓存(OpenAI 语义),投影为 fresh input,与 scan_codex_usage_file
        // 同口径;否则明细行 estimateCost 把缓存按全价重复计费。
        let fresh_input = get("input_tokens").saturating_sub(get("cached_input_tokens") + get("cache_write_input_tokens"));
        out.push(RequestLogEntry {
            ts,
            app: "codex".into(),
            model: if model.is_empty() { "unknown".into() } else { model.clone() },
            session_id: session_id.clone(),
            input_tokens: fresh_input,
            output_tokens: get("output_tokens"),
            cache_read_tokens: get("cached_input_tokens"),
            cache_creation_tokens: get("cache_write_input_tokens"),
        });
    }
}

/// 请求日志(用量「请求日志」页):近 `days` 天逐请求明细,倒序,最多 3000 条。
#[tauri::command]
pub async fn list_request_log(days: Option<u64>) -> Result<Vec<RequestLogEntry>, String> {
    tokio::task::spawn_blocking(move || scan_request_log(days.unwrap_or(30)))
        .await
        .map_err(|e| format!("join request log task: {e}"))?
}

// —— AI 工作轨迹图谱(graph pane;plan: .work/design/20261021-graph-pane) ——
//
// 数据源与会话 jsonl 同源(usage 扫描),但提取维度是「会话 × 文件 × 模型」:
// claude 逐行扫 tool_use(Read/Edit/Write/MultiEdit/NotebookEdit 的 file_path/
// notebook_path)建会话→文件边;codex 只做会话级节点(rollout 的 apply_patch 路径
// 解析脏,下期)。模型节点由前端从 sessions 分组派生。节点上限防爆(力导向 O(n²)
// 在前端跑):会话按 tokens 取 top 40、文件按 touch 总量取 top 80。

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySession {
    /// 会话 id(jsonl 文件名去扩展名;uuid,前端显示截短 8 位)。
    pub id: String,
    pub app: String,
    /// 会话内频次最高的 model。
    pub model: String,
    pub requests: u64,
    /// 四段 tokens 和(节点大小映射)。
    pub tokens: u64,
    pub first_ts: String,
    pub last_ts: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActivityFile {
    /// 绝对路径(前端显示 basename + tooltip 全路径)。
    pub path: String,
    pub reads: u64,
    pub writes: u64,
    /// 关联(distinct)会话数。
    pub sessions: u64,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEdge {
    /// sessions 下标。
    pub session: u32,
    /// files 下标。
    pub file: u32,
    pub reads: u64,
    pub writes: u64,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiActivityGraph {
    pub sessions: Vec<ActivitySession>,
    pub files: Vec<ActivityFile>,
    pub edges: Vec<ActivityEdge>,
}

const ACTIVITY_MAX_SESSIONS: usize = 40;
const ACTIVITY_MAX_FILES: usize = 80;

#[derive(Default)]
struct ActivitySessionAcc {
    app: String,
    /// model -> 出现行频次(取 max 做会话主模型)。
    models: std::collections::HashMap<String, u64>,
    requests: u64,
    tokens: u64,
    first_ts: String,
    last_ts: String,
    /// 文件路径 -> (reads, writes)。
    files: std::collections::HashMap<String, (u64, u64)>,
}

/// 单个 claude jsonl 的活动提取。两个口径同行不同权:
/// - usage/model/requests:按 message.id 去重(同一轮逐 block 行重复 usage,同 usage 扫描);
/// - tool_use:**每行都扫**——tool_use 块只出现在自己所在行,message.id 去重会把后续行
///   整行丢弃而误伤(首轮 text 行之后的 tool_use 行)。
fn scan_claude_activity_file(path: &Path, cutoff_date: &str, acc: &mut ActivitySessionAcc) {
    use std::io::BufRead;
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let mut seen: std::collections::HashSet<String> = Default::default();
    for line in std::io::BufReader::new(file).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => return,
        };
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let msg = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("").to_string();
        if ts.is_empty() {
            continue;
        }
        if local_date_from_ts(&ts).map(|d| d < cutoff_date.to_string()).unwrap_or(true) {
            continue;
        }
        let mid = msg.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
        let first_block = mid.is_empty() || seen.insert(mid);
        let model = msg.get("model").and_then(|m| m.as_str()).unwrap_or("unknown").to_string();
        if first_block {
            // synthetic 行(model `<` 开头)无 usage/tool_use,只不累计 tokens。
            let usage = msg.get("usage").and_then(|u| u.as_object());
            let total = usage
                .map(|u| {
                    let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                    g("input_tokens") + g("output_tokens") + g("cache_read_input_tokens") + g("cache_creation_input_tokens")
                })
                .unwrap_or(0);
            if !(model.starts_with('<') && total == 0) {
                *acc.models.entry(model.clone()).or_insert(0) += 1;
                acc.tokens += total;
                acc.requests += 1;
            }
        }
        if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
            for block in content {
                let bo = match block.as_object() {
                    Some(o) => o,
                    None => continue,
                };
                if bo.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                    continue;
                }
                let name = bo.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let input = match bo.get("input").and_then(|i| i.as_object()) {
                    Some(i) => i,
                    None => continue,
                };
                let fp = input
                    .get("file_path")
                    .or_else(|| input.get("notebook_path"))
                    .and_then(|p| p.as_str())
                    .unwrap_or("");
                if fp.is_empty() {
                    continue;
                }
                let entry = acc.files.entry(fp.to_string()).or_insert((0, 0));
                match name {
                    "Read" => entry.0 += 1,
                    "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => entry.1 += 1,
                    _ => {}
                }
            }
        }
        if acc.first_ts.is_empty() || ts < acc.first_ts {
            acc.first_ts = ts.clone();
        }
        if ts > acc.last_ts {
            acc.last_ts = ts.clone();
        }
    }
}

/// 单个 codex rollout 的活动提取(会话级:token_count 累计 + 最近 turn_context 的 model;
/// 文件边不做)。
fn scan_codex_activity_file(path: &Path, cutoff_date: &str, acc: &mut ActivitySessionAcc) {
    use std::io::BufRead;
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let mut model = String::new();
    for line in std::io::BufReader::new(file).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => return,
        };
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let payload = match v.get("payload").and_then(|p| p.as_object()) {
            Some(p) => p,
            None => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("turn_context") {
            if let Some(m) = payload.get("model").and_then(|m| m.as_str()) {
                model = m.to_string();
            }
            continue;
        }
        if payload.get("type").and_then(|t| t.as_str()) != Some("token_count") {
            continue;
        }
        let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("").to_string();
        if local_date_from_ts(&ts).map(|d| d < cutoff_date.to_string()).unwrap_or(true) {
            continue;
        }
        let last = match payload.get("info").and_then(|i| i.get("last_token_usage")).and_then(|l| l.as_object()) {
            Some(l) => l,
            None => continue,
        };
        let get = |k: &str| last.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        // codex input 含缓存(OpenAI 语义),fresh = input - cached - cache_write;
        // 四段和才是真实消耗,直接原始四段相加会把缓存重复计一遍(同 scan_codex_usage_file)。
        let fresh_input = get("input_tokens").saturating_sub(get("cached_input_tokens") + get("cache_write_input_tokens"));
        acc.tokens += fresh_input + get("output_tokens") + get("cached_input_tokens") + get("cache_write_input_tokens");
        acc.requests += 1;
        let m = if model.is_empty() { "unknown".to_string() } else { model.clone() };
        *acc.models.entry(m).or_insert(0) += 1;
        if acc.first_ts.is_empty() || ts < acc.first_ts {
            acc.first_ts = ts.clone();
        }
        if ts > acc.last_ts {
            acc.last_ts = ts.clone();
        }
    }
}

/// 图谱扫描入口:mtime 预过滤同 usage;会话按 tokens top 40、文件按 touch top 80 裁剪。
fn scan_ai_activity(days: u64) -> Result<AiActivityGraph, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir not available".to_string())?;
    let cutoff_date = (chrono::Local::now() - chrono::Duration::days(days as i64)).date_naive().to_string();
    let mtime_pass = |path: &Path| -> bool {
        match std::fs::metadata(path).and_then(|m| m.modified()) {
            Ok(modified) => {
                let local: chrono::DateTime<chrono::Local> = modified.into();
                local.date_naive().to_string() >= cutoff_date
            }
            Err(_) => true, // 拿不到 mtime 不拦,行级时间戳兜底。
        }
    };

    let mut accs: Vec<ActivitySessionAcc> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    let push = |id: String, acc: ActivitySessionAcc, accs: &mut Vec<ActivitySessionAcc>, ids: &mut Vec<String>| {
        if acc.requests > 0 || !acc.files.is_empty() {
            accs.push(acc);
            ids.push(id);
        }
    };

    let claude_dir = home.join(".claude").join("projects");
    if claude_dir.is_dir() {
        walk_jsonl(&claude_dir, &mut |path| {
            if !mtime_pass(path) {
                return;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if stem.is_empty() {
                return;
            }
            let mut acc = ActivitySessionAcc::default();
            acc.app = "claude".into();
            scan_claude_activity_file(path, &cutoff_date, &mut acc);
            push(stem, acc, &mut accs, &mut ids);
        });
    }
    let codex_dir = home.join(".codex").join("sessions");
    if codex_dir.is_dir() {
        walk_jsonl(&codex_dir, &mut |path| {
            if !mtime_pass(path) {
                return;
            }
            // rollout 文件名 rollout-<ts>-<uuid>.jsonl:会话 id 取 stem 末段。
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let id = stem.rsplit('-').next().unwrap_or(stem).to_string();
            if id.is_empty() {
                return;
            }
            let mut acc = ActivitySessionAcc::default();
            acc.app = "codex".into();
            scan_codex_activity_file(path, &cutoff_date, &mut acc);
            push(id, acc, &mut accs, &mut ids);
        });
    }

    // 会话裁剪:tokens 降序 top N(tokens=0 但有文件边的会话给 1 兜底排序)。
    let mut order: Vec<usize> = (0..accs.len()).collect();
    order.sort_by(|&a, &b| accs[b].tokens.max(1).cmp(&accs[a].tokens.max(1)));
    order.truncate(ACTIVITY_MAX_SESSIONS);
    let sessions: Vec<ActivitySession> = order
        .iter()
        .map(|&i| {
            let a = &accs[i];
            let model = a
                .models
                .iter()
                .max_by_key(|(_, c)| **c)
                .map(|(m, _)| m.clone())
                .unwrap_or_else(|| "unknown".into());
            ActivitySession {
                id: ids[i].clone(),
                app: a.app.clone(),
                model,
                requests: a.requests,
                tokens: a.tokens,
                first_ts: a.first_ts.clone(),
                last_ts: a.last_ts.clone(),
            }
        })
        .collect();

    // 文件聚合(仅入选会话的边):path -> (reads, writes, distinct 会话)。
    let mut file_acc: std::collections::HashMap<String, (u64, u64, std::collections::HashSet<usize>)> = Default::default();
    for &i in &order {
        for (fp, (r, w)) in &accs[i].files {
            let e = file_acc.entry(fp.clone()).or_default();
            e.0 += r;
            e.1 += w;
            e.2.insert(i);
        }
    }
    let mut files_sorted: Vec<(String, (u64, u64, std::collections::HashSet<usize>))> = file_acc.into_iter().collect();
    files_sorted.sort_by(|a, b| (b.1 .0 + b.1 .1).cmp(&(a.1 .0 + a.1 .1)));
    files_sorted.truncate(ACTIVITY_MAX_FILES);
    // index 用拥有 String(不借 files_sorted,后续 edges 构建时它还在,生命周期不打架)。
    let file_index: std::collections::HashMap<String, u32> = files_sorted
        .iter()
        .enumerate()
        .map(|(i, (p, _))| (p.clone(), i as u32))
        .collect();
    let files: Vec<ActivityFile> = files_sorted
        .drain(..)
        .map(|(path, (reads, writes, sessions))| ActivityFile {
            path,
            reads,
            writes,
            sessions: sessions.len() as u64,
        })
        .collect();

    // 边:入选会话 × 入选文件(session 下标 = sessions 输出序)。
    let mut edges = Vec::new();
    for (so, &i) in order.iter().enumerate() {
        for (fp, (r, w)) in &accs[i].files {
            if let Some(&fo) = file_index.get(fp.as_str()) {
                edges.push(ActivityEdge {
                    session: so as u32,
                    file: fo,
                    reads: *r,
                    writes: *w,
                });
            }
        }
    }

    Ok(AiActivityGraph { sessions, files, edges })
}

/// AI 工作轨迹图谱(graph pane):近 N 天(缺省 7)会话/文件/边。重 IO,spawn_blocking。
#[tauri::command]
pub async fn list_ai_activity(days: Option<u64>) -> Result<AiActivityGraph, String> {
    tokio::task::spawn_blocking(move || scan_ai_activity(days.unwrap_or(7)))
        .await
        .map_err(|e| format!("join ai activity task: {e}"))?
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

/// 解析 Codex rollout 为消息流。**主干 = response_item**(两种 rollout 时代都稳定):
/// message(role=user/assistant,文本在 content[].text)→ 对话文本;
/// function_call / custom_tool_call → 工具卡;function_call_output / custom_tool_call_output
/// → 按 call_id 回填上一张同名工具卡的结果。旧解析找 `event_msg/user_message`/
/// `agent_message`,但 rollout 格式已迁移(0.166 时代 event_msg 只剩 item_completed,没有
/// user_message/agent_message 事件)→ 文本全丢,只剩工具行(2026-11-04 用户报「恢复就一个
/// 内容还是 wait」)。developer/system 角色跳过;event_msg 整类跳过(item_completed 与
/// response_item 同内容)。
fn parse_codex_messages(path: &Path) -> Result<Vec<AiCliSessionMessage>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(file);
    let mut out: Vec<AiCliSessionMessage> = Vec::new();
    // call_id → out 下标(最近一张待配结果工具卡;同 id 重复调用覆盖,rollout 顺序即时间序)。
    let mut pending_tools: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    // message.content[] 的文本拼接(content[].text;空 content 容错)。
    let content_text = |payload: &serde_json::Value| -> String {
        payload
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|seg| seg.get("text").and_then(|x| x.as_str()))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default()
    };

    for line in reader.lines() {
        let line = match line { Ok(l) => l, Err(_) => continue };
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        let v: serde_json::Value = match serde_json::from_str(trimmed) { Ok(v) => v, Err(_) => continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
            continue;
        }
        let timestamp = v.get("timestamp").and_then(|x| x.as_str()).map(|s| s.to_string());
        let payload = match v.get("payload") { Some(p) => p, None => continue };
        let sub = payload.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match sub {
            "message" => {
                let role = payload.get("role").and_then(|x| x.as_str()).unwrap_or("");
                match role {
                    // user 文本 = 人类输入(developer/system 的 AGENTS.md 注入跳过;
                    // 旧格式首条注入是 "# AGENTS.md instructions" 开头,一并跳过)。
                    "user" => {
                        let text = content_text(payload);
                        let t = text.trim();
                        if t.is_empty()
                            || t.starts_with("<user_instructions>")
                            || t.starts_with("<environment_context>")
                            || t.starts_with("# AGENTS.md instructions")
                        {
                            continue;
                        }
                        out.push(AiCliSessionMessage {
                            role: "user".into(),
                            timestamp,
                            text: t.to_string(),
                            tool_use: None,
                            tool_result: None,
                        });
                    }
                    "assistant" => {
                        let text = content_text(payload);
                        if !text.trim().is_empty() {
                            out.push(AiCliSessionMessage {
                                role: "assistant".into(),
                                timestamp,
                                text,
                                tool_use: None,
                                tool_result: None,
                            });
                        }
                    }
                    _ => {} // developer/system 跳过
                }
            }
            "function_call" | "custom_tool_call" => {
                let name = payload.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let args = payload
                    .get("arguments")
                    .or_else(|| payload.get("input"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let call_id = payload.get("call_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
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
                if !call_id.is_empty() {
                    pending_tools.insert(call_id, out.len() - 1);
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                // output 两形态:str 或 [{type,text}] 数组(新格式 function_call_output 实测)。
                let output_text = match payload.get("output") {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Array(arr)) => arr
                        .iter()
                        .filter_map(|seg| seg.get("text").and_then(|x| x.as_str()))
                        .collect::<Vec<_>>()
                        .join(""),
                    _ => String::new(),
                };
                let call_id = payload.get("call_id").and_then(|x| x.as_str()).unwrap_or("");
                if let Some(&idx) = pending_tools.get(call_id) {
                    if let Some(slot) = out.get_mut(idx) {
                        slot.tool_result = Some(truncate_chars(output_text.trim(), 500));
                    }
                    pending_tools.remove(call_id);
                }
            }
            _ => {} // reasoning/message 之外(event_msg/token_usage_record 等)跳过
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

/// 从 Claude jsonl 的 user 行提取「真实人类输入」文本(标题回退用)。
///
/// 排除噪音后取首个非空文本,任一条件不满足返回 None:
/// - `isMeta:true` 行(caveat 提示、本地命令展开等元消息);
/// - content 数组里无 text 块(tool_result 回传行,role 虽 user 但非人类输入);
/// - 文本以 `<command-name>`/`<local-command`/`<system-reminder`/`Caveat:` 开头
///   (slash 命令与系统注入包装,非用户原话)。
fn extract_claude_user_text(v: &serde_json::Value) -> Option<String> {
    if v.get("isMeta")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    let msg = v.get("message")?;
    let content = msg.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(items) => {
            let mut buf = String::new();
            for item in items {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = item.get("text").and_then(|x| x.as_str()) {
                        if !buf.is_empty() {
                            buf.push(' ');
                        }
                        buf.push_str(t);
                    }
                }
            }
            if buf.is_empty() {
                None
            } else {
                Some(buf)
            }
        }
        _ => None,
    }?;
    let t = text.trim();
    if t.is_empty()
        || t.starts_with("<command-name>")
        || t.starts_with("<local-command")
        || t.starts_with("<system-reminder")
        || t.starts_with("Caveat:")
    {
        return None;
    }
    Some(t.to_string())
}

/// 标题截断(按字符,防切坏多字节;末尾省略号)。Claude/Codex 标题回退共用。
fn truncate_title(raw: &str) -> Option<String> {
    const TITLE_MAX: usize = 60;
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    Some(if t.chars().count() > TITLE_MAX {
        let cut: String = t.chars().take(TITLE_MAX).collect();
        format!("{cut}…")
    } else {
        t.to_string()
    })
}

/// 逐行流式解析 Claude 单个 jsonl,归并出列表项字段(标题/起止时间/消息数/git/cwd)。
/// 不全量读入内存:`BufReader` 按行读;每行只取字段白名单,丢弃 content/usage/patch 等大字段。
fn parse_claude_jsonl(path: &Path) -> Result<AiCliSessionListItem, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(file);

    let mut title: Option<String> = None; // 最后一条 ai-title / summary
    let mut first_user_msg: Option<String> = None; // 首条真实用户输入(无 ai-title 时作标题回退)
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

        // 首条真实人类输入(无 ai-title/summary 时作标题回退,见文档头)。
        if first_user_msg.is_none() && !is_sidechain && ty == "user" {
            first_user_msg = extract_claude_user_text(&v);
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
        // 标题回退链:ai-title(最后一条)> summary > 首条真实用户消息(截 60 字符)。
        title: title.or_else(|| first_user_msg.as_deref().and_then(truncate_title)),
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
    let mut first_user_msg: Option<String> = None; // 旧格式 response_item 用户消息(回退)
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
        } else if ty == "response_item" {
            // 旧格式 rollout 无 user_message 事件,用户输入在 response_item.message
            // (role=user,content[].input_text)。仅作标题回退,不计消息数(与消息流解析口径一致)。
            if first_user_msg.is_none() {
                if let Some(p) = payload {
                    let is_user = p.get("role").and_then(|r| r.as_str()) == Some("user")
                        && p.get("type").and_then(|t| t.as_str()) == Some("message");
                    if is_user {
                        if let Some(content) = p.get("content").and_then(|c| c.as_array()) {
                            let mut buf = String::new();
                            for item in content {
                                if item.get("type").and_then(|t| t.as_str()) == Some("input_text") {
                                    if let Some(txt) = item.get("text").and_then(|x| x.as_str()) {
                                        if !buf.is_empty() {
                                            buf.push(' ');
                                        }
                                        buf.push_str(txt);
                                    }
                                }
                            }
                            let t = buf.trim();
                            if !t.is_empty() {
                                first_user_msg = Some(t.to_string());
                            }
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
        // 标题回退链:user_message 事件 > 旧格式 response_item 用户消息(截 60 字符)。
        title: title.or_else(|| first_user_msg.as_deref().and_then(truncate_title)),
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
