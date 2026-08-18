//! PTY Tauri command 边界：spawn / write / resize / kill + 后台读循环。
//!
//! 四条不变量（见 design 文档）：
//! 1. `try_read_reader()` 只能调一次 → spawn 同步段取走并 move 进 spawn_blocking。
//! 2. `drop(pair.slave)` 不能漏 → 否则子进程退出后 reader 读不到 EOF。
//! 3. `std::sync::Mutex` 持锁不跨 `.await`。
//! 4. 前端必须先 `listen("pty-output")` 再 `invoke("spawn_pty")`，避免丢首批输出。

use std::io::Read;
use std::path::PathBuf;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::{PtyOutput, PtyRegistry, PtySession};

/// 选取默认 shell：优先 PowerShell 7（`pwsh.exe`），找不到则回退 Windows PowerShell 5.1。
///
/// 用 `where`/`where.exe` 探测 PATH；两者都不可用时直接假定 `powershell.exe` 存在
/// （Windows 自带）。pwsh 默认 UTF-8 输出，体验最佳。
/// `pub(crate)`:claude/shell_run 模块 spawn 子进程时复用做 shell 探测。
pub(crate) fn pick_shell() -> String {
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
///
/// `pub(crate)`:claude 模块 spawn claude.exe 时复用(同样需要 CREATE_NO_WINDOW,
/// 见 `crate::claude::commands`)。
pub(crate) fn command_no_window(program: &str) -> std::process::Command {
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

/// PowerShell 片段:把注册表 Machine+User PATH 中当前进程没有的项**追加**到 `$env:Path`。
///
/// 背景:app 进程的 PATH 是启动快照,用户之后新装的 CLI(volta/pnpm 等)进不去,导致终端
/// pane 与 `!` 命令找不到命令。本片段实时读注册表(`[Environment]::GetEnvironmentVariable`
/// 直读注册表,非进程 PATH),把缺失项追加--不覆盖,保留 profile 动态加的项(如 fnm env)。
///
/// **括号陷阱**:`+` 优先级高于 `-join`,故 `';' + 数组 -join ';'` 会被解析为 `(';' + 数组)
/// -join ';'`(字符串+数组→数组被空格拼成单串→join 失效→PATH 污染成空格分隔串,所有命令找不到)。
/// 必须把 `(管道 -join ';')` 整体括号包住,让 -join 先于 + 求值。
///
/// `pub(crate)`:shell_run 模块 spawn `!` 命令时复用(见 `crate::shell_run::commands`)。
pub(crate) const PATH_REFRESH_PS: &str = r#"$env:Path += ';' + (( ([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')) -split ';' | Where-Object { $_ -and ($_ -notin ($env:Path -split ';')) } | Select-Object -Unique ) -join ';')"#;

/// PowerShell 片段:注入 `pnpm` wrapper function,绕过 volta Rust shim 在 PTY 下的 bug。
///
/// 背景:volta 的 `pnpm.exe`(Rust shim)执行 pnpm 入口(`volta which pnpm` 返回无扩展名路径)
/// 时,在 ConPTY 环境下 spawn 的 cmd 找不到 `pnpm` -> 报「'pnpm' 不是内部或外部命令」。外部
/// PowerShell 正常,仅 txuyStudio pane 复现 -- volta 侧 bug,PATH/PATHEXT/VOLTA_HOME 全一致也救不了。
///
/// 方案:`Get-Command volta` 检测 volta 存在才定义 function(不破坏用 npm 等其他方式装 pnpm 的用户)。
/// 首次调用 `volta which pnpm` 解析入口、加 `.cmd`、缓存到 `$script:__pnpm`,后续直跑包 wrapper
/// (`pnpm.cmd` 调 node pnpm.cjs),绕过 volta Rust shim。解析失败兜底 `pnpm.exe`(走 shim,罕见)。
/// 只影响 pane 内 `pnpm` 命令;`pnpm.exe` 仍走 volta shim(用户可显式调用原 shim)。
pub(crate) const PNPM_WRAPPER_PS: &str = r#"if (Get-Command volta -ErrorAction SilentlyContinue) { function pnpm { if (-not $script:__pnpm) { $e = (volta which pnpm 2>$null); if ($e) { $c = "$e.cmd"; if (Test-Path $c) { $script:__pnpm = $c } } }; if ($script:__pnpm) { & $script:__pnpm @args } else { pnpm.exe @args } } }"#;

/// 解析命令在 PATH 上的完整路径(Windows 走 `where.exe`,会按 PATHEXT 解析 `.cmd`/`.bat`)。
///
/// `std::process::Command::new(name)` 在 Windows 上**不解析 PATHEXT**——只搜 `name.exe`,
/// 找不到 npm/volta 装的 `name.cmd` shim(rust-lang/rust#37519 历史性遗留)。claude 经 volta
/// 安装就是 `claude.cmd` shim,直接 `Command::new("claude")` 会 `program not found`。
///
/// 本函数用 `where.exe`(自带 PATHEXT 解析)取候选行,优先返回 `.cmd`/`.bat` 结尾的可执行 shim
/// 行,回退首行;都没找到返回 None(调用方退回原名让原生报错)。
///
/// `pub(crate)`:claude 模块 spawn claude.cmd shim 时复用(见 `crate::claude::commands`)。
#[cfg(windows)]
pub(crate) fn resolve_on_path(name: &str) -> Option<std::path::PathBuf> {
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
pub(crate) fn resolve_on_path(_name: &str) -> Option<std::path::PathBuf> {
    None
}

/// PowerShell prompt hook：每次 prompt 渲染前输出不可见 OSC 标记，前端 transport 用它记录实时 cwd。
///
/// 用 `[char]27` / `[char]7` 兼容 Windows PowerShell 5.1 和 PowerShell 7；随后调用原 prompt，
/// 保持用户看到的提示符样式尽量接近默认 PowerShell。
fn powershell_prompt_cwd_hook() -> &'static str {
    r#"$global:__txuy_original_prompt = if (Test-Path Function:\prompt) { (Get-Command prompt).ScriptBlock } else { { "PS $($executionContext.SessionState.Path.CurrentLocation)> " } }; function global:prompt { $cwd = (Get-Location).ProviderPath; if (-not $cwd) { $cwd = (Get-Location).Path }; [Console]::Out.Write("$([char]27)]1337;TxuyCwd=$cwd$([char]7)"); & $global:__txuy_original_prompt }"#
}

/// AI CLI(`claude`/`codex`)与 TUI 工具(`lazygit`/`yazi`/`fresh`)的启动命令。
/// PowerShell 起来后立即调用,实现「分屏/新 tab 选 lazygit → 自动进 lazygit」。
/// shellKind 为 `shell`/`test` 等非工具类型时返回 None,只起裸 PowerShell。
///
/// 命令名直接传(无参数),退出后由 `-NoExit` 回到 PowerShell 提示符(与 AI CLI 一致)。
fn launch_command_for(shell_kind: &str) -> Option<&'static str> {
    match shell_kind {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        "lazygit" => Some("lazygit"),
        "yazi" => Some("yazi"),
        "fresh" => Some("fresh"),
        _ => None,
    }
}

/// 定位应用内置的 oh-my-posh 二进制与主题文件。
///
/// 从 Tauri resource_dir 取 `resources/oh-my-posh.exe` 与 `resources/txuy-theme.omp.json`，
/// 两者都存在则返回 `(exe, theme)`；任一缺失返回 None（调用方退回裸 prompt hook）。
/// **不探测本机 PATH**：无条件优先用内置资源，保证任意 Windows 机器体验一致。
///
/// dev 模式下 resource_dir 指向 `src-tauri/` 本身，`resources/` 子路径与 build 产物一致。
fn bundled_omp_paths(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let resource_dir = app.path().resource_dir().ok()?;
    let exe = resource_dir.join("resources").join("oh-my-posh.exe");
    let theme = resource_dir.join("resources").join("txuy-theme.omp.json");
    if !exe.is_file() || !theme.is_file() {
        return None;
    }
    // resource_dir 在 Windows 上可能返回 `\\?\` verbatim 前缀，ConPTY/PowerShell 处理
    // verbatim 路径有问题，喂给 PowerShell 前用既有 strip_verbatim_prefix 剥离。
    Some((
        strip_verbatim_prefix(&exe),
        strip_verbatim_prefix(&theme),
    ))
}

/// 把路径包装成 PowerShell 单引号字面量：内部单引号翻倍转义（PowerShell 规则）。
/// 用于把内置 omp exe/theme 路径安全嵌入 `-Command` 脚本串。
fn ps_single_quote(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    format!("'{}'", s.replace('\'', "''"))
}

/// 校验 spawn_pty 的 cwd：绝对路径、规范化后无 `..` 逃逸段、且是已存在目录。
///
/// 设计为「纵深防御」——cwd 来源是用户在 dialog 里选的项目 rootPath，正常不会逃逸；
/// 校验失败返回 Err，调用方回退默认目录 + warn，不阻断启动。
///
/// 返回值会剥离 Windows canonicalize 产生的 `\\?\` verbatim 前缀：ConPTY/portable-pty
/// 在设置子进程工作目录时对 verbatim 路径处理有问题（实测会导致 shell 启动后无输出），
/// 因此喂给 `cmd.cwd()` 的必须是普通路径。
///
/// `pub(crate)`:claude 模块 spawn claude.exe 时复用做 cwd 校验。
pub(crate) fn validate_cwd(raw: &std::path::Path) -> Result<std::path::PathBuf, String> {
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
///
/// `pub(crate)`:被 `validate_cwd` 与 claude 模块复用。
pub(crate) fn strip_verbatim_prefix(p: &std::path::Path) -> std::path::PathBuf {
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
///
/// `pub(crate)`:被 `validate_cwd` 与 claude 模块复用。
pub(crate) fn lexical_normalize(p: &std::path::Path) -> std::path::PathBuf {
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

/// 启动一个 PTY 会话，返回 sessionId。后台异步读取 shell 输出并 emit `pty-output`。
///
/// `project_id`：项目归属，会话登记到 `by_project[project_id][sessionId]`（项目隔离）。
///
/// `cwd`：可选工作目录。若提供且通过 `validate_cwd` 校验（绝对路径、无 `..` 逃逸、
/// 是已存在目录），shell 在该目录启动；校验失败或为 None 时回退到进程默认目录
/// （用户主目录）并 warn，不阻断启动。
///
/// `shell_kind`：面板 shell 类型(`shell`/`claude`/`codex`/`test`/`lazygit`/`yazi`/`fresh`)。
/// PowerShell 始终作为承载 shell,`claude`/`codex` 与 TUI 工具(`lazygit`/`yazi`/`fresh`)时
/// 额外自动启动对应 CLI(在 PowerShell 里跑),其余只起裸 shell。TUI 工具退出后回到 PowerShell(`-NoExit`)。
#[tauri::command]
pub async fn spawn_pty(
    app: AppHandle,
    state: State<'_, PtyRegistry>,
    project_id: String,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    shell_kind: Option<String>,
    launch_override: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = pick_shell();
    let mut cmd = CommandBuilder::new(&shell);

    // -Command 内容:先(可选)装内置 oh-my-posh 初始化覆盖 prompt,再装 prompt hook(cwd 追踪),
    // 最后(可选)启动 AI CLI。
    //
    // 顺序关键:oh-my-posh init 会替换 `prompt` 函数,prompt hook 必须在 init 之后注入——
    // hook 包裹的是「当前 prompt 函数」,这样能在 omp 渲染的 prompt 之外追加 OSC cwd 标记;
    // 若顺序反了,omp init 会覆盖掉 hook 的包裹。AI CLI 在最后,确保前两者已就位。
    //
    // 内置 omp 文件缺失(如开发期未下载)时退回裸 prompt hook + warn,不阻断启动。
    let kind = shell_kind.as_deref().unwrap_or("shell");
    // launch_override(前端传 "codex resume <id>" 等)优先; 无则回退静态 launch_command_for.
    let launch: Option<String> = launch_override.or_else(|| launch_command_for(kind).map(|s| s.to_string()));
    let cwd_hook = powershell_prompt_cwd_hook();
    let omp_init = match bundled_omp_paths(&app) {
        Some((exe, theme)) => {
            let exe_q = ps_single_quote(&exe);
            let theme_q = ps_single_quote(&theme);
            Some(format!(
                "$env:POSH_THEME = {theme_q} ; & {exe_q} init pwsh --config \"$env:POSH_THEME\" | Invoke-Expression"
            ))
        }
        None => {
            log::warn!(
                "spawn_pty: bundled oh-my-posh resources not found under resources/, \
                 falling back to bare PowerShell prompt (cwd hook only)"
            );
            None
        }
    };

    // 拼接 -Command 脚本:omp init? ; cwd hook ; (& launcher)?
    // 各段均为完整语句,用 ` ; ` 连接。AI CLI 用 `&` 显式调用避免解析歧义(与历史行为一致)。
    let omp_init_str = omp_init.as_deref();
    // 首段:补全最新系统 PATH(注册表 Machine+User 中当前进程没有的项追加)。
    // app PATH 是启动快照,中途装的 CLI 进不去;放首段确保后续 omp/launcher 能用到新装的命令。
    let mut segments: Vec<String> = Vec::with_capacity(5);
    segments.push(PATH_REFRESH_PS.to_string());
    // pnpm wrapper:绕过 volta Rust shim 在 PTY 下的 bug(见 PNPM_WRAPPER_PS 注释)。
    segments.push(PNPM_WRAPPER_PS.to_string());
    if let Some(omp) = omp_init_str {
        segments.push(omp.to_string());
    }
    segments.push(cwd_hook.to_string());
    if let Some(launcher) = &launch {
        segments.push(format!("& {launcher}"));
    }
    let command_script = segments.join(" ; ");
    cmd.args(["-NoLogo", "-NoExit", "-Command", &command_script]);

    // 工作目录：经 validate_cwd 校验（绝对路径、无 `..` 逃逸、是目录）。校验失败回退默认 + warn，
    // 不阻断启动（与原有 is_dir 回退一致）。cwd 来源是用户选择的项目 rootPath，校验为纵深防御。
    let cwd_display = match &cwd {
        Some(path) => match validate_cwd(std::path::Path::new(path)) {
            Ok(validated) => {
                cmd.cwd(&validated);
                validated.to_string_lossy().into_owned()
            }
            Err(reason) => {
                log::warn!("spawn_pty: cwd rejected ({reason}): {path}, using default");
                "(default)".to_string()
            }
        },
        None => "(default)".to_string(),
    };

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // 关键：丢掉 slave 句柄，子进程退出时 EOF 才能传到 reader。
    drop(pair.slave);

    // reader 在 spawn 时取走并移交给阻塞读线程（按一次性使用，避免重复克隆）。
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = pair.master;

    let session_id = uuid::Uuid::new_v4().to_string();

    // 持锁区间：仅 insert（按项目分桶），绝不跨 await。
    {
        let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        by_project
            .entry(project_id.clone())
            .or_default()
            .insert(
                session_id.clone(),
                PtySession {
                    writer,
                    child,
                    master,
                },
            );
    }

    // spawn_blocking：portable-pty 的 reader 是阻塞 Read，不能占用 async runtime。
    let app_handle = app.clone();
    let sid = session_id.clone();
    log::info!(
        "spawn_pty: session {sid} on {shell} ({cols}x{rows}) kind={kind} cwd={cwd_display}{}",
        launch.map(|l| format!(" launch={l}")).unwrap_or_default()
    );
    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF：子进程已退出
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_handle.emit(
                        "pty-output",
                        PtyOutput {
                            session_id: sid.clone(),
                            data,
                        },
                    );
                }
                Err(e) => {
                    log::warn!("pty reader error, session {sid}: {e}");
                    break;
                }
            }
        }
    });

    Ok(session_id)
}

/// 向指定会话写入用户输入（键盘按键）。
#[tauri::command]
pub async fn write_pty(
    state: State<'_, PtyRegistry>,
    project_id: String,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
    let sessions = by_project
        .get_mut(&project_id)
        .ok_or_else(|| format!("project not found: {project_id}"))?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// 调整会话尺寸（窗口/面板缩放时）。
#[tauri::command]
pub async fn resize_pty(
    state: State<'_, PtyRegistry>,
    project_id: String,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
    let sessions = by_project
        .get_mut(&project_id)
        .ok_or_else(|| format!("project not found: {project_id}"))?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 关闭并清理会话：先从注册表移除（释放全局锁），再 spawn_blocking 执行 kill/wait。
///
/// 关键：`child.kill()/wait()` 是阻塞操作，若在持锁时执行会卡住其它 pane 的
/// write/resize/kill；因此只在一个极短锁作用域内 `remove`，拿到 session 后立即放锁，
/// 再把阻塞的 kill/wait 丢到 spawn_blocking 线程。session drop 时 master 一并释放，
/// reader 线程随之收到 EOF 退出。
#[tauri::command]
pub async fn kill_pty(
    state: State<'_, PtyRegistry>,
    project_id: String,
    session_id: String,
) -> Result<(), String> {
    // 短锁作用域：仅 remove，绝不持锁做阻塞工作。
    let mut session = {
        let mut by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        let sessions = by_project
            .get_mut(&project_id)
            .ok_or_else(|| format!("project not found: {project_id}"))?;
        sessions
            .remove(&session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };

    // portable-pty 的 Child Drop 不保证 kill，必须显式调用；放到 spawn_blocking
    // 避免阻塞 async runtime 与全局 PTY 锁。
    tokio::task::spawn_blocking(move || {
        if let Err(e) = session.child.kill() {
            log::warn!("kill_pty: child kill failed for {session_id}: {e}");
        }
        if let Err(e) = session.child.wait() {
            log::warn!("kill_pty: child wait failed for {session_id}: {e}");
        }
        log::info!("kill_pty: session {session_id} closed");
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}
