//! 子进程/路径通用工具(跨模块复用,零 UI 框架依赖)。
//!
//! 从 src-tauri 的 pty/commands.rs 抽出(P0 core 化):pick_shell/resolve_on_path 被
//! pty spawn 与 claude/codex/shell_run 模块共用;validate_cwd/strip_verbatim_prefix/
//! lexical_normalize 是 Windows 路径规范化的统一口径。

/// 选取默认 shell：优先 PowerShell 7（`pwsh.exe`），找不到则回退 Windows PowerShell 5.1。
///
/// 用 `where`/`where.exe` 探测 PATH；两者都不可用时直接假定 `powershell.exe` 存在
/// （Windows 自带）。pwsh 默认 UTF-8 输出，体验最佳。
pub fn pick_shell() -> String {
    let candidates = ["pwsh.exe", "powershell.exe"];
    for candidate in candidates {
        if command_no_window("where.exe")
            .arg(candidate)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return candidate.to_string();
        }
    }
    // 探测失败（极少见，例如 where 不可用），退守系统自带的 powershell.exe。
    log::warn!("pick_shell: no pwsh/powershell found via where, falling back to powershell.exe");
    "powershell.exe".to_string()
}

/// 构造一个带 `CREATE_NO_WINDOW` 的 `Command`（Windows）。
///
/// release 下主程序为 `windows` 子系统（GUI，无控制台）。此时用 `std::process::Command`
/// spawn 控制台程序（如 `where.exe`）会触发 Windows 为子进程**新建一个控制台窗口**——
/// 表现为「弹一个黑窗又关掉」。加 `CREATE_NO_WINDOW`（0x0800_0000）让子进程不创建可见
/// 控制台窗口。dev 下主程序是 `console` 子系统、子进程继承控制台，本标志无副作用。
///
/// 仅 Windows 需要此标志；非 Windows 直接返回普通 `Command`（条件编译保证跨平台编译）。
pub fn command_no_window(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：阻止为子进程分配新控制台窗口。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 解析命令在 PATH 上的完整路径(Windows 走 `where.exe`,会按 PATHEXT 解析 `.cmd`/`.bat`)。
///
/// `std::process::Command::new(name)` 在 Windows 上**不解析 PATHEXT**——只搜 `name.exe`,
/// 找不到 npm/volta 装的 `name.cmd` shim(rust-lang/rust#37519 历史性遗留)。claude 经 volta
/// 安装就是 `claude.cmd` shim,直接 `Command::new("claude")` 会 `program not found`。
///
/// 本函数用 `where.exe`(自带 PATHEXT 解析)取候选行,优先返回 `.cmd`/`.bat` 结尾的可执行 shim
/// 行,回退首行;都没找到返回 None(调用方退回原名让原生报错)。
#[cfg(windows)]
pub fn resolve_on_path(name: &str) -> Option<std::path::PathBuf> {
    let out = command_no_window("where.exe").arg(name).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<&str> = stdout
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    // 优先 .cmd/.bat(volta/npm shim 都是这俩),回退首行。
    let pick = lines
        .iter()
        .find(|l| l.ends_with(".cmd") || l.ends_with(".bat"))
        .or_else(|| lines.first())?;
    Some(std::path::PathBuf::from(*pick))
}

/// 解析命令路径(非 Windows:Command::new 本就跑通 PATH,无需解析,返回 None)。
#[cfg(not(windows))]
pub fn resolve_on_path(_name: &str) -> Option<std::path::PathBuf> {
    None
}

/// 校验 spawn 的 cwd：绝对路径、规范化后无 `..` 逃逸段、且是已存在目录。
///
/// 设计为「纵深防御」——cwd 来源是用户在 dialog 里选的项目 rootPath，正常不会逃逸；
/// 校验失败返回 Err，调用方回退默认目录 + warn，不阻断启动。
///
/// 返回值会剥离 Windows canonicalize 产生的 `\\?\` verbatim 前缀：ConPTY/portable-pty
/// 在设置子进程工作目录时对 verbatim 路径处理有问题（实测会导致 shell 启动后无输出），
/// 因此喂给 `cmd.cwd()` 的必须是普通路径。
pub fn validate_cwd(raw: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if !raw.is_absolute() {
        return Err(format!("not absolute: {}", raw.display()));
    }
    // canonicalize 会解析 `..`/符号链接并要求路径可访问；失败（路径暂不存在/未挂载）
    // 时退守 lexical_normalize，避免因路径暂时不可访问而阻断正常启动。
    let normalized = match std::fs::canonicalize(raw) {
        Ok(c) => strip_verbatim_prefix(&c),
        Err(_) => lexical_normalize(raw),
    };
    if normalized
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("escapes via ..: {}", raw.display()));
    }
    if !normalized.is_dir() {
        return Err(format!("not a directory: {}", normalized.display()));
    }
    Ok(normalized)
}

/// 剥离 Windows `\\?\`（或 `\\?\UNC\`）verbatim 前缀，转回普通路径。
/// canonicalize 在 Windows 上返回 verbatim 路径，ConPTY 设 cwd 时会出问题。
pub fn strip_verbatim_prefix(p: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut comps = p.components();
    match comps.next() {
        // `\\?\D:\...` → Prefix 盘符前是 verbatim 前缀；用 to_str 判断更稳。
        Some(Component::Prefix(_)) => {
            if let Some(s) = p.to_str() {
                if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
                    return std::path::PathBuf::from(format!(r"\\{rest}"));
                }
                if let Some(rest) = s.strip_prefix(r"\\?\") {
                    return std::path::PathBuf::from(rest);
                }
            }
            p.to_path_buf()
        }
        _ => p.to_path_buf(),
    }
}

/// 词法规范化：解析 `.`/`..` 段但不要求路径存在。`validate_cwd` 在 canonicalize 失败时的退守路径。
pub fn lexical_normalize(p: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component::{self, CurDir, Normal, ParentDir, Prefix, RootDir};
    let mut out = std::path::PathBuf::new();
    for comp in p.components() {
        match comp {
            Prefix(_) | RootDir => out.push(comp),
            CurDir => {}
            ParentDir => {
                // 仅当末尾是 Normal 段时弹出，避免相对逃逸（绝对路径开头 pop 到根目录是安全的）。
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

/// kill 整个 PTY 子进程树并收尸(kill_pty / kill_project / kill_all_blocking 共用)。
///
/// `child.kill()`(TerminateProcess)只杀直子 powershell——pane 里跑着 node/dev server 等
/// **孙进程**时,它们继承 ConPTY slave 句柄继续持有 → master 读端永不 EOF → 读循环线程 +
/// transcript Arc(256KB)+ condRV 句柄永久泄漏(每次 ~1-2.5MB,数天累积数十-百 MB,且整棵
/// 孙进程残留系统)。`taskkill /F /T /PID` 杀整棵树根治;taskkill spawn 失败回退 child.kill
/// (语义不劣于现状)。portable-pty 的 trait Child 与 std::process::Child 不同型,故独立于
/// claude 模块的 kill_child_tree 实现同逻辑。
pub fn kill_pty_child_tree(child: &mut Box<dyn portable_pty::Child + Send + Sync>) {
    #[cfg(windows)]
    {
        // process_id() 返回 u32(进程已死也返回历史值);taskkill 找不到 pid 时说明已退,
        // status() 返回 Ok(非 0),不 fallback,由末尾 wait() 收尸。
        let killed = match child.process_id() {
            Some(pid) => match command_no_window("taskkill.exe")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
            {
                Ok(_) => true,
                Err(e) => {
                    log::warn!("kill_pty_child_tree: taskkill failed for pid {pid}, fallback: {e}");
                    false
                }
            },
            None => false,
        };
        if !killed {
            let _ = child.kill();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}
