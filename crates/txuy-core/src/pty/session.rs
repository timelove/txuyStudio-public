//! PTY 会话 spawn 核心(ConPTY + PowerShell 初始化脚本 + 幂等 attach + 合批读循环)。
//!
//! 从 src-tauri 的 pty/commands.rs 抽出(P0 core 化),框架耦合点全部注入化:
//! - 输出:`PtyOutputSink` 回调(Tauri 壳注入 app.emit;GPUI 版走自有通道);
//! - oh-my-posh 内置资源路径:`omp: Option<(exe, theme)>` 参数(resource_dir 是
//!   Tauri 概念,壳解析后传入)。
//!
//! 四条不变量(见 design 文档):
//! 1. `try_read_reader()` 只能调一次 → spawn 同步段取走并 move 进 spawn_blocking。
//! 2. `drop(pair.slave)` 不能漏 → 否则子进程退出后 reader 读不到 EOF。
//! 3. `std::sync::Mutex` 持锁不跨 `.await`。
//! 4. (Tauri 壳约定)前端必须先 `listen("pty-output")` 再 spawn,避免丢首批输出。

use std::io::Read;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use super::{PtyOutput, PtyRegistry, PtySession, PtyOutputSink, PTY_TRANSCRIPT_MAX};
use crate::proc::{pick_shell, validate_cwd};

/// spawn 会话的输入配置(框架无关)。
pub struct PtySpawnConfig {
    /// 项目归属,会话登记到 `by_project[project_id][sessionId]`(项目隔离)。
    pub project_id: String,
    /// 初始行数。
    pub rows: u16,
    /// 初始列数。
    pub cols: u16,
    /// 可选工作目录。通过 `validate_cwd` 校验(绝对路径、无 `..` 逃逸、已存在目录);
    /// 校验失败或 None 回退进程默认目录 + warn,不阻断启动。
    pub cwd: Option<String>,
    /// 面板 shell 类型(`shell`/`claude`/`codex`/`test`/`lazygit`/`yazi`/`fresh`)。
    /// PowerShell 始终作为承载 shell,`claude`/`codex` 与 TUI 工具时额外自动启动对应 CLI。
    pub shell_kind: Option<String>,
    /// 启动命令覆盖(前端传 "codex resume <id>" 等);无则按 shell_kind 静态映射。
    pub launch_override: Option<String>,
    /// 确定性会话 key(前端传 tabId,跨 WebView 重载稳定)。命中存活旧会话 → attach 回放
    /// transcript(不重 spawn,保住 cwd/滚动历史/运行中命令);进程已死 → 清旧并以 transcript
    /// 里的最后已知 cwd 重建。None → 后端生成 UUID。
    pub session_id: Option<String>,
    /// 内置 oh-my-posh (exe, theme) 资源路径;None 退回裸 prompt hook(不阻断)。
    pub omp: Option<(std::path::PathBuf, std::path::PathBuf)>,
}

/// 启动一个 PTY 会话,返回 sessionId。后台线程读取 shell 输出并调 `sink`。
///
/// `sink` 在读循环线程被长期持有(Arc),每批输出一次(合批规则见读循环注释);
/// attach 回放的 transcript 也经 sink 送出(时序:回放先于新读循环)。
pub async fn spawn_pty_session(
    registry: &PtyRegistry,
    cfg: PtySpawnConfig,
    sink: PtyOutputSink,
) -> Result<String, String> {
    let mut cwd = cfg.cwd;
    // —— 幂等 attach(WebView 重载/休眠唤醒后前端重挂,以同 key 重连旧 PTY)——
    if let Some(sid) = &cfg.session_id {
        // 短锁:探测活性 + resize + transcript Arc 拷贝(全部微秒级,持锁可接受,同 write_pty 先例)。
        let probe: Option<(bool, std::sync::Arc<std::sync::Mutex<Vec<u8>>>)> = {
            let mut by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
            by_project
                .get_mut(cfg.project_id.as_str())
                .and_then(|m| m.get_mut(sid.as_str()))
                .map(|session| {
                    // try_wait 非阻塞:Ok(None)=活,Ok(Some)/Err=已退出。
                    let alive = session.child.try_wait().map(|s| s.is_none()).unwrap_or(false);
                    if alive {
                        let _ = session.master.resize(PtySize {
                            rows: cfg.rows,
                            cols: cfg.cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                    (alive, session.transcript.clone())
                })
        };
        if let Some((alive, transcript)) = probe {
            let snapshot: Vec<u8> = transcript
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            if alive {
                let data = String::from_utf8_lossy(&snapshot).into_owned();
                log::info!(
                    "spawn_pty: attach live session {sid} ({} bytes replay)",
                    data.len()
                );
                if !data.is_empty() {
                    sink(PtyOutput {
                        project_id: cfg.project_id.clone(),
                        session_id: sid.clone(),
                        data,
                    });
                }
                return Ok(sid.clone());
            }
            // 死会话:移除旧条目;transcript 尾部提取最后已知 cwd 作为新 shell 起始目录
            // (恢复用户 cd 位置,而非 pane 初始 cwd);先回放死前输出再走正常 spawn
            // (新 shell 横幅接在历史之后,时序由 sink 先于新读循环保证)。
            {
                let mut by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
                if let Some(m) = by_project.get_mut(cfg.project_id.as_str()) {
                    m.remove(sid.as_str());
                }
            }
            if let Some(last) = extract_last_osc_cwd(&snapshot) {
                log::info!("spawn_pty: dead session {sid}, restoring last cwd {last}");
                cwd = Some(last);
            } else {
                log::info!("spawn_pty: dead session {sid}, rebuilding (no cwd marker)");
            }
            let data = String::from_utf8_lossy(&snapshot).into_owned();
            if !data.is_empty() {
                // 末尾软复位:死前若在 TUI(alternate screen),回放会把终端留◧在 alt 画面,
                // 新 shell(normal screen)输出会叠在死前 TUI 上——退 alt + 显光标 + 换行,让
                // 新 shell 横幅正确衔接在历史之后。
                let data = format!("{data}\x1b[?1049l\x1b[?25h\r\n");
                sink(PtyOutput {
                    project_id: cfg.project_id.clone(),
                    session_id: sid.clone(),
                    data,
                });
            }
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: cfg.rows,
            cols: cfg.cols,
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
    let kind = cfg.shell_kind.as_deref().unwrap_or("shell");
    // launch_override 优先; 无则回退静态 launch_command_for.
    let launch: Option<String> = cfg
        .launch_override
        .or_else(|| launch_command_for(kind).map(|s| s.to_string()));
    let cwd_hook = powershell_prompt_cwd_hook();
    let omp_init = match &cfg.omp {
        Some((exe, theme)) => {
            let exe_q = ps_single_quote(exe);
            let theme_q = ps_single_quote(theme);
            Some(format!(
                "$env:POSH_THEME = {theme_q} ; & {exe_q} init pwsh --config \"$env:POSH_THEME\" | Invoke-Expression"
            ))
        }
        None => {
            log::warn!(
                "spawn_pty: bundled oh-my-posh resources not provided, \
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

    // 会话 key:优先调用方传入的确定性 id(tabId,attach 语义);缺省沿用 UUID(旧调用方)。
    let session_id = cfg.session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let transcript: std::sync::Arc<std::sync::Mutex<Vec<u8>>> = std::sync::Arc::default();

    // 持锁区间：仅 insert（按项目分桶），绝不跨 await。
    {
        let mut by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
        by_project
            .entry(cfg.project_id.clone())
            .or_default()
            .insert(
                session_id.clone(),
                PtySession {
                    writer,
                    child,
                    master,
                    transcript: transcript.clone(),
                },
            );
    }

    // spawn_blocking：portable-pty 的 reader 是阻塞 Read，不能占用 async runtime。
    let sid = session_id.clone();
    // 读循环 sink 需带 project_id(前端按 projectId+sessionId 双键路由,见 PtyOutput 注释)。
    let pid = cfg.project_id.clone();
    log::info!(
        "spawn_pty: session {sid} on {shell} ({}x{}) kind={kind} cwd={cwd_display}{}",
        cfg.cols, cfg.rows,
        launch.map(|l| format!(" launch={l}")).unwrap_or_default()
    );
    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 8192];
        // 输出合批(H1 内存治理):事件管道走无界队列时每条消息带 JSON 转义 + 包装
        // ~10-25KB 驻留——多 PTY 洪峰(构建输出)遇主线程忙(拖拽窗口/同步写盘/休眠唤醒
        // 窗口期)时积压可达 GB 级。合批规则:阻塞 read 返回不满块(n < buf.len())= 管道
        // 暂空,立即 flush(空闲不卡显示);连续满块(洪峰)攒到 64KB 一条 sink,消息数降
        // ~8 倍,总驻留同比例下降。transcript 写入语义不变。
        let mut acc: Vec<u8> = Vec::with_capacity(64 * 1024);
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF：子进程已退出
                Ok(n) => {
                    if let Ok(mut t) = transcript.lock() {
                        t.extend_from_slice(&buf[..n]);
                        if t.len() > PTY_TRANSCRIPT_MAX {
                            let excess = t.len() - PTY_TRANSCRIPT_MAX;
                            t.drain(0..excess);
                        }
                    }
                    acc.extend_from_slice(&buf[..n]);
                    if acc.len() >= 64 * 1024 || n < buf.len() {
                        let data = String::from_utf8_lossy(&acc).into_owned();
                        sink(PtyOutput {
                            project_id: pid.clone(),
                            session_id: sid.clone(),
                            data,
                        });
                        acc.clear();
                    }
                }
                Err(e) => {
                    log::warn!("pty reader error, session {sid}: {e}");
                    break;
                }
            }
        }
        // EOF/错误退出前把尾巴发掉(会话最后一段输出不丢)。
        if !acc.is_empty() {
            let data = String::from_utf8_lossy(&acc).into_owned();
            sink(PtyOutput {
                project_id: pid.clone(),
                session_id: sid.clone(),
                data,
            });
        }
    });

    Ok(session_id)
}

/// 从死会话 transcript 提取最后一次 OSC cwd 标记(prompt hook 注入的
/// `\x1b]1337;TxuyCwd=<path>\x07`),作重建 shell 的起始 cwd。截断边界天然容错:
/// 序列被环形截头截断时取到的前一个完整标记或 None。
pub fn extract_last_osc_cwd(bytes: &[u8]) -> Option<String> {
    const MARKER: &[u8] = b"\x1b]1337;TxuyCwd=";
    let mut last: Option<String> = None;
    let mut pos = 0;
    while pos + MARKER.len() <= bytes.len() {
        let rel = match bytes[pos..].windows(MARKER.len()).position(|w| w == MARKER) {
            Some(r) => r,
            None => break,
        };
        let start = pos + rel + MARKER.len();
        match bytes[start..].iter().position(|&b| b == 0x07) {
            Some(end_off) => {
                let end = start + end_off;
                if let Ok(s) = std::str::from_utf8(&bytes[start..end]) {
                    if !s.is_empty() {
                        last = Some(s.to_string());
                    }
                }
                pos = end + 1;
            }
            None => break, // 无结束符(被截断)——保留上一个完整标记。
        }
    }
    last
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
pub const PATH_REFRESH_PS: &str = r#"$env:Path += ';' + (( ([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')) -split ';' | Where-Object { $_ -and ($_ -notin ($env:Path -split ';')) } | Select-Object -Unique ) -join ';')"#;

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
pub const PNPM_WRAPPER_PS: &str = r#"if (Get-Command volta -ErrorAction SilentlyContinue) { function pnpm { if (-not $script:__pnpm) { $e = (volta which pnpm 2>$null); if ($e) { $c = "$e.cmd"; if (Test-Path $c) { $script:__pnpm = $c } } }; if ($script:__pnpm) { & $script:__pnpm @args } else { pnpm.exe @args } } }"#;

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

/// 把路径包装成 PowerShell 单引号字面量：内部单引号翻倍转义（PowerShell 规则）。
/// 用于把内置 omp exe/theme 路径安全嵌入 `-Command` 脚本串。
fn ps_single_quote(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    format!("'{}'", s.replace('\'', "''"))
}
