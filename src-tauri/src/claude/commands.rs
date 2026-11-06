//! claude stream-json 子进程的 spawn / kill + 后台读循环。
//!
//! 与 `pty/commands` 并列:不走 portable-pty/ConPTY,而是 `std::process::Command` 直接 spawn
//! `claude.exe -p <prompt> --output-format stream-json --verbose [--resume <id>]`。
//! stdout 逐行读 JSON(`BufReader::lines()`),分类后 emit `claude-event`。
//!
//! 复用 `pty::commands` 的 `command_no_window`(CREATE_NO_WINDOW,claude.exe 控制台程序 release 下
//! 必加)、`validate_cwd`(项目根校验)。
//!
//! 四条不变量(对齐 `pty/commands` 的约定):
//! 1. `std::sync::Mutex` 持锁不跨 `.await`——短锁作用域内只做 insert/remove/取字段。
//! 2. 阻塞的 kill+wait 丢 `spawn_blocking`,且进入前锁已释放。
//! 3. 读循环是 fire-and-forget(spawn_blocking 不 await),返回后前端靠事件流感知进度。
//! 4. 前端必须先 `listen("claude-event")` 再 `invoke("start_claude_session")`,避免丢首批事件
//!    (与 `pty-output` 同约束,前端 ClaudeTransport 内部保证)。

use std::io::{BufRead, Write};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;

use tauri::{AppHandle, Emitter, Manager, State};

use super::{
    BackgroundTaskInfo, ClaudeEvent, ClaudeEventPayload, ClaudeRegistry, ClaudeSession,
    ClaudeStatus, SessionConfig,
};
use crate::pty::commands::{command_no_window, resolve_on_path, validate_cwd};
use crate::state::AppState;

/// thinking_tokens 攒批阈值:累计到这么多 token 就 flush 一次心跳 emit,避免逐 token IPC 风暴。
const THINKING_BATCH_TOKENS: u64 = 50;
/// thinking_tokens flush 间隔:即使没到阈值,这么久也 flush 一次,让 UI 感知「在思考」。
/// thinking_tokens 事件本身**不含思考文本**(只有 estimated_tokens 计数);真实思考内容随
/// assistant 消息的 `thinking` content block 到达(见 run_read_loop assistant 分支)。
/// 故这里 emit 的 Thinking 事件只是「仍在思考」的轻量状态心跳,text 恒为空。
const THINKING_FLUSH_INTERVAL: Duration = Duration::from_millis(400);

/// 定位 claude 可执行文件(优先原生安装包)。
///
/// 背景:官方对 npm 安装方式随时可能下线,原生安装包(Windows `irm https://claude.ai/install.ps1 | iex`)
/// 是最可靠渠道:产物是独立 .exe,无 node/npm 依赖,也无 `.cmd` shim 在长进程 stdin 管道上的
/// 传递问题(见 `start_claude_session` 的 Windows .cmd 包装注释)。原生安装默认落
/// `%USERPROFILE%\.local\bin\claude.exe`,安装器虽会把自己加入 PATH,但 PATH 顺序可能被
/// npm/volta 等其他安装方式抢占,故**显式优先探测**原生位置。
///
/// 优先级:
/// 1. `~/.local/bin/claude[.exe]` -- 原生安装包默认位置;
/// 2. PATH 解析(`where.exe`,volta/npm 的 .cmd shim 或用户手动放置的 .exe);
/// 3. `~/.claude/local/claude[.exe|.cmd|.bat]` -- 旧版 `claude migrate-installer` 迁移位置;
/// 4. 非 Windows 兜底原名 "claude"(`Command::new` 本就搜 PATH);Windows 全找不到返回 None
///    (调用方发友好安装提示,不让 spawn 报生硬的 OS 错误)。
///
/// `pub(crate)`:`system::commands::check_commands_installed` 探测 claude 是否安装时复用,
/// 保证「探测」与「spawn」用同一解析逻辑(探测说装了 spawn 就一定能找到)。
pub(crate) fn resolve_claude_program() -> Option<String> {
    let home = dirs::home_dir();
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    // 1) 原生安装包默认位置。
    if let Some(home) = &home {
        let native = home.join(".local").join("bin").join(exe);
        if native.is_file() {
            return Some(native.to_string_lossy().into_owned());
        }
    }
    // 2) PATH(where.exe;volta/npm shim 等)。
    if let Some(p) = resolve_on_path("claude") {
        return Some(p.to_string_lossy().into_owned());
    }
    // 3) 旧版 migrate-installer 迁移位置(npm 时代可能留下 .cmd/.bat shim)。
    if let Some(home) = &home {
        for name in [exe, "claude.cmd", "claude.bat"] {
            let p = home.join(".claude").join("local").join(name);
            if p.is_file() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    // 4) 非 Windows:Command::new 本就搜 PATH,兜底原名让 spawn 自行解析(与旧行为一致)。
    if !cfg!(windows) {
        return Some("claude".to_string());
    }
    None
}

/// 启动/重启 claude 长进程(幂等「确保一个新进程在跑」)。
///
/// 一个 claude tab = 一个长生命周期进程:`--input-format stream-json --output-format stream-json`
/// 模式,stdin 持续喂消息、stdout 持续吐事件、EOF 才退出。多轮同进程、session_id 不变 →
/// `/compact` 真生效、`--resume` 不断裂。
///
/// 调用场景(transport 层 `ensureStarted`):
/// - 首启:`resume_id=None`(全新会话)。
/// - 崩溃恢复/换 mode/批准重启/中断后续接:`resume_id=Some`(带 `--resume`,session 保留)。
///
/// 幂等性:若旧 child 存活 → 置 `killed=true` + take child+stdin,放锁后 spawn_blocking
/// kill+wait 旧进程(让旧读循环退出,不发 error Terminated),再启新进程。
///
/// 持锁不跨 .await:短锁作用域内只做取/放字段 + take child;阻塞 kill+wait 在 spawn_blocking
/// 且锁已释放。
#[tauri::command]
pub async fn start_claude_session(
    app: AppHandle,
    state: State<'_, ClaudeRegistry>,
    app_state: State<'_, AppState>,
    project_id: String,
    tab_id: String,
    cwd: Option<String>,
    permission_mode: Option<String>,
    allowed_tools: Option<Vec<String>>,
    resume_session_id: Option<String>,
    effort: Option<String>,
    model: Option<String>,
    add_dirs: Option<Vec<String>>,
) -> Result<(), String> {
    // 1) 短锁:取/建 session;若旧 child 存活 → killed=true + take child+stdin(放锁后 kill 旧进程)。
    // 0) 读持久化的 claude_session_id(跨重启 --resume 用)。首启播种到新 session;session 已存在
    //    (本运行期内已启)不覆盖(保留 live id)。ClaudeRegistry 仅内存,重启即丢,故从 AppState 读。
    let persisted_sid: Option<String> = {
        let snap = app_state.inner.lock().map_err(|e| e.to_string())?;
        snap.projects
            .iter()
            .find(|p| p.id == project_id)
            .and_then(|p| p.claude_tab_sessions.get(&tab_id).cloned())
    };

    // 用户指定恢复某历史会话(前端 ↻ 输入 session id,或 SessionBrowser 恢复):
    // **显式覆盖** persisted id--前端 resumeSession 在调本命令前已 kill 旧进程(进程已死),
    // 故传 resume_session_id 即「切换到另一条历史会话」的明确意图,必须覆盖 persisted(否则
    // 旧 persisted id 仍在 -> resume_sid 被过滤 -> 恢复的还是旧的已终止会话,用户 ↻ 无效)。
    // 正常重启(mode/effort 切换)不传 resume_session_id(None),走 persisted 续接当前会话。
    let resume_sid = resume_session_id.clone();
    let initial_sid = resume_sid.clone().or(persisted_sid);

    let old_child = {
        let mut by_project = state.by_project.lock().map_err(|e| {
            log::error!("start_claude_session: state lock poisoned: {e}");
            e.to_string()
        })?;
        let sessions = by_project.entry(project_id.clone()).or_default();
        let session = sessions
            .entry(tab_id.clone())
            .or_insert_with(move || ClaudeSession {
                claude_session_id: Mutex::new(initial_sid.clone()),
                child: Mutex::new(None),
                stdin: Mutex::new(None),
                config: Mutex::new(SessionConfig::default()),
                status: Mutex::new(ClaudeStatus::Idle),
                model: Mutex::new(None),
                settings_env_hash: Mutex::new(None),
                killed: Mutex::new(false),
                background_tasks: Mutex::new(Vec::new()),
            });
        // 旧 child 存活:标记 killed(让旧读循环 EOF 不发 error)+ take child+stdin。
        let old = session.child.lock().ok().and_then(|mut g| g.take());
        if old.is_some() {
            if let Ok(mut k) = session.killed.lock() {
                *k = true;
            }
            let _ = session.stdin.lock().ok().and_then(|mut g| g.take());
        }
        // 用户显式恢复(↻ 切换到另一条历史会话):覆写 registry 的 claude_session_id,
        // 使后续 spawn 读到的 --resume id 是新会话而非旧已终止会话(与下方 update_claude_session_id
        // 持久化到 AppState 同步)。session 已存在(已终止 tab)时尤其关键:旧 id 仍在 registry。
        if let Some(sid) = &resume_sid {
            if let Ok(mut g) = session.claude_session_id.lock() {
                *g = Some(sid.clone());
            }
        }
        old
    };
    // 放锁后 kill+wait 旧进程树(让旧读循环退出;killed=true 故不发 error Terminated)。
    // 用 kill_child_tree 而非 child.kill():Windows 下 .cmd 包装使 node 成为孙子进程,
    // child.kill() 只杀 cmd.exe 不杀 node -> 旧进程树残留继续输出(见 kill_child_tree 注释)。
    // resume_sid 传入时立即持久化到 AppState(不等 init): 跨重启续接; init 后 update_claude_session_id 幂等覆盖.
    if let Some(sid) = &resume_sid {
        let _ = update_claude_session_id(&app, &project_id, &tab_id, sid.clone());
    }
    if let Some(mut c) = old_child {
        let _ = tokio::task::spawn_blocking(move || {
            kill_child_tree(&mut c);
        })
        .await;
    }

    // 2) 短锁:写 config(mode/cwd)+ cleared killed=false + 读 claude_session_id(决定 --resume)。
    // 文件 IO 在锁外:先算 spawn 时刻的 settings.json env 段哈希(锁内仅写入,见下方 block 2)。
    let spawn_env_hash = claude_settings_env_hash();
    let (resume_id, mode_str, cwd_validated, effort_str, model_str) = {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        let session = by_project
            .get(&project_id)
            .and_then(|s| s.get(&tab_id))
            .ok_or("session missing after ensure")?;
        let mode = permission_mode.as_deref().unwrap_or("acceptEdits").to_string();
        let cwd_v = match &cwd {
            Some(path) => match validate_cwd(std::path::Path::new(path)) {
                Ok(p) => Some(p),
                Err(reason) => {
                    log::warn!("start_claude_session: cwd rejected ({reason}): {path}, using default");
                    None
                }
            },
            None => None,
        };
        if let Ok(mut cfg) = session.config.lock() {
            *cfg = SessionConfig {
                permission_mode: mode.clone(),
                cwd: cwd_v.clone(),
                effort: effort.clone(),
                model: model.clone(),
            };
        }
        // 记录 spawn 时的 settings.json env 段哈希(文件 IO 已在锁外完成,锁内仅写入),
        // 供 claude_settings_changed 比对检测 cc-switch 等工具的供应商切换。
        if let Ok(mut h) = session.settings_env_hash.lock() {
            *h = Some(spawn_env_hash);
        }
        // 注意:此处**不清 killed**。killed 是给「旧读循环」EOF 时判断用的(旧进程被 kill 后,
        // 旧读循环将退出,需 take 走 killed=true 避免误发 error Terminated)。新读循环启动时,
        // killed 已被旧读循环的 take_killed_flag 取走(=false),自然正确。若在此清 false,
        // 会与旧读循环的异步 EOF 产生竞态:旧读循环读到 false → 误判崩溃 → emit Terminated{eof}。
        let rid = session
            .claude_session_id
            .lock()
            .ok()
            .and_then(|g| g.clone());
        (rid, mode, cwd_v, effort, model)
    };

    // 3) 构造命令:claude -p --input-format stream-json --output-format stream-json --verbose
    //    --permission-mode <mode> [--allowedTools ...] [--resume <id>] [--cwd]。
    //    不传 positional prompt(长进程 prompt 走 stdin)。stdin/stdout piped、stderr null。
    //
    //    **Windows .cmd 包装**:claude 经 volta/npm 装为 `claude.cmd` shim(批处理 → node claude.js)。
    //    长进程模式下 stdin 必须 piped 且正确传递到 shim 内部的 node 进程。直接 `Command::new
    //    ("claude.cmd")` spawn 时,批处理层的 stdin pipe 重定向可能丢失 → claude 收到 stdin EOF
    //    立刻退出(实测:Rust 直接 spawn .cmd 长进程立刻 EOF;node `spawn("cmd",["/c",...])` 稳定)。
    //    故 Windows 上用 `cmd.exe /c claude.cmd <args>` 包装,与诊断脚本一致,保证 stdin pipe 传递。
    let claude_program = match resolve_claude_program() {
        Some(p) => p,
        None => {
            // Windows 上原生位置/PATH/迁移位置均未找到:发友好 Terminated(带安装命令)替代
            // spawn 的生硬 OS 错误,前端 claudeMissing 卡片与 terminated 红字都能给出可操作提示。
            let reason = "claude executable not found (tried ~/.local/bin, PATH, ~/.claude/local); \
                          install the native build: irm https://claude.ai/install.ps1 | iex"
                .to_string();
            log::error!("start_claude_session: {reason}");
            let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Error);
            let _ = app.emit(
                "claude-event",
                ClaudeEvent {
                    project_id: project_id.clone(),
                    tab_id: tab_id.clone(),
                    payload: ClaudeEventPayload::Terminated {
                        reason: reason.clone(),
                    },
                },
            );
            return Err(reason);
        }
    };
    log::info!("start_claude_session: resolved claude program = {claude_program}");
    #[cfg(windows)]
    let mut cmd = {
        // .cmd/.bat 用 cmd /c 包装;裸 .exe 直接 spawn(旧版短命模型本就如此,且短命不喂 stdin 故无此问题)。
        let needs_shell = claude_program.ends_with(".cmd") || claude_program.ends_with(".bat");
        if needs_shell {
            let mut c = command_no_window("cmd.exe");
            c.arg("/c").arg(&claude_program);
            c
        } else {
            command_no_window(&claude_program)
        }
    };
    #[cfg(not(windows))]
    let mut cmd = command_no_window(&claude_program);
    cmd.arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--permission-mode")
        .arg(&mode_str);
    // 权限确认走控制通道(对齐 BaoCode claude_code_transport.dart):CLI 遇需授权工具不再
    // 自己拒绝,而是 stdout 发 control_request{can_use_tool},宿主回 control_response
    // {behavior:allow/deny} 后**由 CLI 自己执行并续跑该轮**——取代原「识别拒绝文案 →
    // 本地代执行 → 注入 tool_result」的启发式路径(那条路在批准后常断链:CLI 又吃拒绝,
    // 卡片复现且轮次不继续)。spike 实测 2026-10-19(.work/spikes/can-use-tool-spike.mjs)。
    cmd.arg("--permission-prompt-tool").arg("stdio");
    // 工具白名单(--allowedTools):合并「项目持久化 allowlist」∪「本次前端透传」,去重。
    // 短锁读 app_state(同步,不跨 .await)。
    {
        let mut tools: Vec<String> = {
            let snap = app_state.inner.lock().map_err(|e| e.to_string())?;
            snap.projects
                .iter()
                .find(|p| p.id == project_id)
                .map(|p| p.claude_allowed_tools.clone())
                .unwrap_or_default()
        };
        if let Some(extra) = &allowed_tools {
            tools.extend(extra.iter().cloned());
        }
        tools.sort();
        tools.dedup();
        for t in &tools {
            cmd.arg("--allowedTools").arg(t);
        }
        if !tools.is_empty() {
            log::info!("start_claude_session: allowedTools = {:?}", tools);
        }
    }
    if let Some(id) = &resume_id {
        cmd.arg("--resume").arg(id);
    }
    if let Some(e) = &effort_str {
        cmd.arg("--effort").arg(e);
    }
    // --model:显式指定 model(别名或 id)。前端切换 model 经此 flag 重启进程生效--运行中进程
    // 写 `/model <name>`(stdin local command)对后续轮次不可靠,须重启。别名(default/sonnet/
    // opus/…)由 claude 按 ANTHROPIC_DEFAULT_*_MODEL 解析。
    if let Some(m) = &model_str {
        cmd.arg("--model").arg(m);
    }
    // --add-dir:追加工作目录(前端 /add-dir 快捷指令与 ⋯ 菜单「添加工作目录」集成)。
    // 路径校验同 cwd(validate_cwd);失败仅 warn 跳过该条,不阻断启动。
    if let Some(dirs) = &add_dirs {
        for d in dirs.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            match validate_cwd(std::path::Path::new(d)) {
                Ok(p) => {
                    cmd.arg("--add-dir").arg(&p);
                }
                Err(reason) => {
                    log::warn!("start_claude_session: add-dir rejected ({reason}): {d}");
                }
            }
        }
    }
    if let Some(p) = &cwd_validated {
        cmd.current_dir(p);
    }
    cmd.stdin(Stdio::piped())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());

    log::info!(
        "start_claude_session: tab {tab_id} project {project_id} resume={} cwd={}",
        resume_id.is_some(),
        cwd_validated
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "(default)".to_string())
    );

    // 4) spawn。取 stdout + stdin;child+stdin 存 registry(短锁 set);killed=false。
    let mut child = cmd.spawn().map_err(|e| {
        log::error!("start_claude_session: failed to spawn claude for tab {tab_id}: {e}");
        let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Error);
        let _ = app.emit(
            "claude-event",
            ClaudeEvent {
                project_id: project_id.clone(),
                tab_id: tab_id.clone(),
                payload: ClaudeEventPayload::Terminated {
                    reason: format!("spawn failed: {e}"),
                },
            },
        );
        e.to_string()
    })?;
    let stdout = child.stdout.take().ok_or_else(|| "claude stdout not captured".to_string())?;
    let stdin = child.stdin.take().ok_or_else(|| "claude stdin not captured".to_string())?;

    {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        if let Some(session) = by_project
            .get(&project_id)
            .and_then(|sessions| sessions.get(&tab_id))
        {
            if let Ok(mut g) = session.child.lock() {
                *g = Some(child);
            }
            if let Ok(mut g) = session.stdin.lock() {
                *g = Some(stdin);
            }
            if let Ok(mut k) = session.killed.lock() {
                *k = false;
            }
            if let Ok(mut s) = session.status.lock() {
                *s = ClaudeStatus::Idle;
            }
        }
    }

    // 5) fire-and-forget 读循环。
    let app_handle = app.clone();
    let pid = project_id.clone();
    let tid = tab_id.clone();
    tokio::task::spawn_blocking(move || {
        run_read_loop(app_handle, pid, tid, stdout);
    });

    Ok(())
}

/// 写 stdin 一条 stream-json user 消息(发一轮对话 / 触发 local command 如 /compact /clear)。
///
/// 长进程模式下「发消息」与「启动进程」正交:本命令只写 stdin,不 spawn。进程未启/已死时
/// stdin=None → 返回 Err,transport 层 `ensureStarted` 据此先调 `start_claude_session`。
///
/// busy 检查:status=Running/Compacting → Err(前端应先 interrupt)。take stdin(写出期间置 None
/// 防并发,放回在 spawn_blocking 末尾)。
///
/// 持锁不跨 .await:status/stdin 锁短作用域同步取放;`write_all` 在 spawn_blocking 内,async
/// 侧只 await JoinHandle。
/// `send_claude_message` 的 tool_result 载荷(前端批准/拒绝被拒工具调用时原地回传,见
/// `approveToolRun`):作为 user 消息的 tool_result block 写 stdin,claude 像收到正常工具
/// 结果一样续跑(claude cli 交互批准的同语义),无需发一条对话消息让 claude 重调。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultPayload {
    pub tool_use_id: String,
    pub content: String,
    pub is_error: bool,
}

#[tauri::command]
pub async fn send_claude_message(
    app: AppHandle,
    state: State<'_, ClaudeRegistry>,
    project_id: String,
    tab_id: String,
    prompt: String,
    tool_result: Option<ToolResultPayload>,
    // 手机经中继发来的消息:`Some(id)` = 写完 stdin 后补发一条 user 事件(带该 id),
    // 桌面端才看得见「手机问的那句话」。桌面 transport 传 None——它已在前端
    // `appendUserMessage` 做过乐观插入,后端再回显会重复一条。
    client_message_id: Option<String>,
) -> Result<(), String> {
    // 1) 短锁:检查 busy + take stdin + 置 Running(即时 local command 如 /clear 除外,见下方
    //    `is_instant_local_command`:不置 Running,避免 /clear 不发 result 时 busy 死锁)。
    let stdin = {
        let by_project = state.by_project.lock().map_err(|e| {
            log::error!("send_claude_message: state lock poisoned: {e}");
            e.to_string()
        })?;
        let session = by_project
            .get(&project_id)
            .and_then(|s| s.get(&tab_id))
            .ok_or_else(|| "claude session not started: call start_claude_session first".to_string())?;
        {
            let st = session.status.lock().map_err(|e| e.to_string())?;
            if *st == ClaudeStatus::Running || *st == ClaudeStatus::Compacting {
                return Err("claude session busy: interrupt the current turn first".to_string());
            }
        }
        // 即时 local command(当前仅 /clear):不置 Running。/clear 是「清空会话」的即时命令,
        // 可能不发 result 复位 → 若置 Running 而 claude 不发 result,status 卡 Running → busy
        // 死锁(下次 send 被 busy 检查拦)。不置 Running(保持 Idle)对两种情况都安全:claude
        // 发了 result(置 Idle)幂等无害,不发 result 则避免死锁。/compact 不在此列——它是长
        // 操作,需 busy 保护,且 compact 结束会发 result 复位 Idle(实测见 research-stream-json-compact.md)。
        let is_instant_local_command = prompt.trim() == "/clear";
        if !is_instant_local_command {
            if let Ok(mut s) = session.status.lock() {
                *s = ClaudeStatus::Running;
            }
        }
        session.stdin.lock().ok().and_then(|mut g| g.take())
    };

    // 2) 构造 stream-json user 消息行(实测格式):普通 prompt -> text block;tool_result ->
    //    tool_result block(批准/拒绝被拒工具的原地回传,tool_use_id 配对)。
    let line = if let Some(tr) = &tool_result {
        serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{
                "type": "tool_result",
                "tool_use_id": &tr.tool_use_id,
                "content": &tr.content,
                "is_error": tr.is_error,
            }]}
        })
    } else {
        serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": &prompt }] }
        })
    }
    .to_string()
        + "\n";

    // 3) spawn_blocking 写入(同步 IO 不阻塞 async worker;锁完全在 blocking 线程内,不跨 .await)。
    let app2 = app.clone();
    let pid = project_id.clone();
    let tid = tab_id.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        if let Some(mut s) = stdin {
            s.write_all(line.as_bytes())?;
            s.flush()?;
            // 放回 stdin(供下次 send 用)。若 session 已被 kill/remove → 丢弃(drop 关闭)。
            // 用独立块显式 drop 锁 guard 与 State 引用,避免借用生命周期冲突。
            {
                let reg = app2.state::<ClaudeRegistry>();
                let by_project = match reg.by_project.lock() {
                    Ok(g) => g,
                    Err(_) => return Ok(()),
                };
                let sess_opt = by_project
                    .get(&pid)
                    .and_then(|sessions| sessions.get(&tid));
                if let Some(sess) = sess_opt {
                    if let Ok(mut g) = sess.stdin.lock() {
                        *g = Some(s);
                    }
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("send_claude_message join: {e}"))?
    .map_err(|e| format!("send_claude_message write: {e}"))?;

    // 4) 回显手机来源的 user 消息。stream-json 不回显用户输入(见 claudeStream.ts 注释),
    //    桌面端是靠自己 appendUserMessage 乐观插入才看得见的;手机发的话桌面端没有任何
    //    本地插入点,只能由后端补一条。id 由手机侧生成并经 chat.send 带上,两端同 id →
    //    手机侧 `_applyUser` 的 msgIndex 去重会把回显吞掉,不会重复。
    //    tool_result(reply=工具结果回传)不是用户输入,不回显。
    if tool_result.is_none() && !prompt.trim().is_empty() {
        if let Some(msg_id) = client_message_id {
            let _ = app.emit(
                "claude-event",
                ClaudeEvent {
                    project_id,
                    tab_id,
                    payload: ClaudeEventPayload::User {
                        message: serde_json::json!({
                            "id": msg_id,
                            "role": "user",
                            "content": [{ "type": "text", "text": prompt }],
                        }),
                    },
                },
            );
        }
    }

    Ok(())
}

/// 请求 CLI 的权威上下文账本(P2,#137 对齐 baocode):经 stdin 写一条 control_request
/// `get_context_usage`,CLI 的回包(control_response)由读循环以 `ContextUsage` 事件广播,
/// 前端 listen 消费(一次一个 inflight;20s 不回就降级用前端估算,不阻塞)。
///
/// spike 实测(2026-10-19,.work/spikes/):我们现有 spawn 形态(`-p --input-format
/// stream-json --output-format stream-json --verbose`)CLI 即支持该 subtype,无需对话轮;
/// 响应含 categories(kind: used/buffer/free)/totalTokens/maxTokens/autoCompactThreshold。
///
/// 查询**不受 busy 拦**(运行中查的是进行中账本,更有意义),也不动 status;stdin 与
/// send_claude_message 共用同一把 Mutex 的 take/放回,天然互斥。
#[tauri::command]
pub async fn request_claude_context_usage(
    app: AppHandle,
    state: State<'_, ClaudeRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<(), String> {
    let stdin = {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        let session = by_project
            .get(&project_id)
            .and_then(|s| s.get(&tab_id))
            .ok_or_else(|| "claude session not started: call start_claude_session first".to_string())?;
        session.stdin.lock().ok().and_then(|mut g| g.take())
    };
    let Some(stdin) = stdin else {
        return Err("claude stdin unavailable (process dead or busy writing)".to_string());
    };
    // request id 固定:前端一次只挂一个 inflight,响应广播按事件即收,无需匹配多个。
    let line = serde_json::json!({
        "type": "control_request",
        "request_id": "ctx-usage",
        "request": { "subtype": "get_context_usage", "detail": "summary" },
    })
    .to_string()
        + "\n";

    let app2 = app.clone();
    let pid = project_id.clone();
    let tid = tab_id.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut s = stdin;
        s.write_all(line.as_bytes())?;
        s.flush()?;
        // 放回 stdin(与 send_claude_message 同款:session 已被 kill/remove 则丢弃)。
        {
            let reg = app2.state::<ClaudeRegistry>();
            let by_project = match reg.by_project.lock() {
                Ok(g) => g,
                Err(_) => return Ok(()),
            };
            if let Some(sess) = by_project.get(&pid).and_then(|m| m.get(&tid)) {
                if let Ok(mut g) = sess.stdin.lock() {
                    *g = Some(s);
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("request_claude_context_usage join: {e}"))?
    .map_err(|e| format!("request_claude_context_usage write: {e}"))?;

    Ok(())
}

/// 同步写一行到 claude stdin(取→写→放回,与 send_claude_message 共用同一把 Mutex 的
/// take/放回模式,天然互斥)。读循环线程(同步上下文)与命令处理器(经 spawn_blocking)共用。
fn write_stdin_line(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    line: &str,
) -> Result<(), String> {
    let stdin = {
        let reg = app.state::<ClaudeRegistry>();
        let by_project = reg.by_project.lock().map_err(|e| e.to_string())?;
        let session = by_project
            .get(project_id)
            .and_then(|s| s.get(tab_id))
            .ok_or_else(|| "claude session not started".to_string())?;
        session.stdin.lock().ok().and_then(|mut g| g.take())
    };
    let Some(mut stdin) = stdin else {
        return Err("claude stdin unavailable (process dead or busy writing)".to_string());
    };
    use std::io::Write;
    let write_res = stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush());
    // 放回 stdin(session 已被 kill/remove 则丢弃)。
    {
        let reg = app.state::<ClaudeRegistry>();
        let by_project = reg.by_project.lock();
        if let Ok(by_project) = by_project {
            if let Some(sess) = by_project.get(project_id).and_then(|m| m.get(tab_id)) {
                if let Ok(mut g) = sess.stdin.lock() {
                    *g = Some(stdin);
                }
            }
        }
    }
    write_res.map_err(|e| e.to_string())
}

/// 软中断当前轮(stream-json 控制通道):经 stdin 写 control_request `interrupt`,
/// CLI abort 当前轮回 result,进程**不死**,下一条消息直接 stdin 续跑——免掉 kill_claude
/// 的 taskkill 收尸与下轮 --resume 重启进程(各秒级,双 ESC/停止按钮卡顿的根源)。
/// spike 实测(2026-10-21,.work/spikes/interrupt-spike.mjs,CLI 2.1.304):回
/// control_response{success,still_queued:[]} + result{subtype:"error_during_execution",
/// is_error:true}(前端 handleEvent 按在途标志拦截该 result,防重试分流误重发)。
/// 与 request_claude_context_usage 同款语义:**不受 busy 拦**(interrupt 就是打断
/// Running)、不动 status(等 result 事件自然复位 Idle)。stdin 不可用(进程未启/已死)
/// → Err,前端回退 kill_claude 硬中断。
#[tauri::command]
pub async fn interrupt_claude_turn(
    app: AppHandle,
    project_id: String,
    tab_id: String,
) -> Result<(), String> {
    let line = serde_json::json!({
        "type": "control_request",
        "request_id": format!(
            "interrupt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ),
        "request": { "subtype": "interrupt" },
    })
    .to_string()
        + "\n";
    let app2 = app.clone();
    let pid = project_id.clone();
    let tid = tab_id.clone();
    tokio::task::spawn_blocking(move || write_stdin_line(&app2, &pid, &tid, &line))
        .await
        .map_err(|e| format!("interrupt_claude_turn join: {e}"))??;
    Ok(())
}

/// 回应用户对 `can_use_tool` 的决策(--permission-prompt-tool stdio):经 stdin 写
/// control_response,CLI 收到后**自己执行工具**(allow)或把拒绝文案作为 tool_result 交给模型
/// (deny)并续跑该轮。取代原「本地代执行 + 注入 tool_result」启发式路径(批准后常断链)。
///
/// `behavior`: "allow" | "deny"。allow 需带 `updated_input`(原样回传 CLI 给的 input,
/// spike 实测 CLI 认这个形态);deny 可带 `message`(模型据此换方式)。
#[tauri::command]
pub async fn respond_claude_permission(
    app: AppHandle,
    state: State<'_, ClaudeRegistry>,
    project_id: String,
    tab_id: String,
    request_id: String,
    behavior: String,
    updated_input: Option<serde_json::Value>,
    message: Option<String>,
) -> Result<(), String> {
    // 仅校验会话存在(不 take stdin——实际写在 spawn_blocking 里由 write_stdin_line 取)。
    {
        let by_project = state.by_project.lock().map_err(|e| e.to_string())?;
        if by_project
            .get(&project_id)
            .and_then(|s| s.get(&tab_id))
            .is_none()
        {
            return Err("claude session not started".to_string());
        }
    }
    let response = if behavior == "allow" {
        serde_json::json!({
            "behavior": "allow",
            "updatedInput": updated_input.unwrap_or(serde_json::Value::Null),
        })
    } else {
        serde_json::json!({
            "behavior": "deny",
            "message": message.unwrap_or_else(|| "User declined this action.".to_string()),
        })
    };
    let line = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response,
        },
    })
    .to_string()
        + "\n";

    tokio::task::spawn_blocking(move || write_stdin_line(&app, &project_id, &tab_id, &line))
        .await
        .map_err(|e| format!("respond_claude_permission join: {e}"))?
}

/// 中断当前轮(kill 整个长进程)。headless stream-json 无中断信号,中断靠 kill 进程。
///
/// 短锁:killed=true(读循环 EOF 不发 error)+ take child+stdin(置 None),放锁后 spawn_blocking
/// kill+wait,emit `Terminated{reason:"interrupted"}`(前端当 idle 不显错误)。下次 send 自动
/// `start_claude_session`(带 --resume,session 保留)续接 —— 与短命模型 kill+下轮 --resume 语义一致。
///
/// 若当前无在跑 child(进程已退)→ 幂等返回 Ok(仍 emit interrupted 让前端复位状态)。
#[tauri::command]
pub async fn kill_claude(
    app: AppHandle,
    state: State<'_, ClaudeRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<(), String> {
    let child_opt = {
        let by_project = state.by_project.lock().map_err(|e| {
            log::error!("kill_claude: state lock poisoned: {e}");
            e.to_string()
        })?;
        let session = by_project
            .get(&project_id)
            .and_then(|sessions| sessions.get(&tab_id));
        if let Some(session) = session {
            if let Ok(mut k) = session.killed.lock() {
                *k = true;
            }
            let _ = session.stdin.lock().ok().and_then(|mut g| g.take());
            session.child.lock().ok().and_then(|mut g| g.take())
        } else {
            None
        }
    };

    let app_handle = app.clone();
    let pid = project_id.clone();
    let tid = tab_id.clone();
    if let Some(mut child) = child_opt {
        tokio::task::spawn_blocking(move || {
            kill_child_tree(&mut child);
        })
        .await
        .map_err(|e| e.to_string())?;
        log::info!("kill_claude: killed tab {tid} project {pid}");
    } else {
        log::info!("kill_claude: tab {tid} project {pid} not running, idempotent ok");
    }
    // emit interrupted 让前端复位(applyEvent 把 interrupted 当 idle 非 error)。
    let _ = app_handle.emit(
        "claude-event",
        ClaudeEvent {
            project_id: pid,
            tab_id: tid,
            payload: ClaudeEventPayload::Terminated {
                reason: "interrupted".to_string(),
            },
        },
    );
    Ok(())
}

/// 取 claude 配置路径(target: "agents"/"skills" → `~/.claude/<target>` 目录;
/// "mcp" → `~/.claude.json` 文件)。前端 /agents /skills /mcp 选中后 openPath 打开管理。
#[tauri::command]
pub fn get_claude_config_path(target: String) -> Result<String, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|e| format!("home dir not found: {e}"))?;
    let p = if target == "mcp" {
        std::path::Path::new(&home).join(".claude.json")
    } else {
        std::path::Path::new(&home).join(".claude").join(&target)
    };
    Ok(p.to_string_lossy().into_owned())
}

/// 取某 claude 会话当前 model(短锁读 registry)。
///
/// 供独立窗口(detach)新建 ClaudeTransport 时回填 `meta.model`:detach 后新窗口 transport 是全新
/// 实例(state 空、meta.model 空),而长进程不重启则 init 不重发 -> 状态栏 model 恒空。前端 transport
/// 初始化时调本命令,把后端记录的当前 model(init 回填 + `/model` 切换 + 真实 assistant 事件同步)
/// 回填 meta.model,使独立窗口打开即显示当前 model。session 不存在或 model 未记录返回 None。
#[tauri::command]
pub fn get_claude_session_model(
    state: State<'_, ClaudeRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<Option<String>, String> {
    let by_project = state.by_project.lock().map_err(|e| {
        log::error!("get_claude_session_model: state lock poisoned: {e}");
        e.to_string()
    })?;
    let model = by_project
        .get(&project_id)
        .and_then(|sessions| sessions.get(&tab_id))
        .and_then(|session| session.model.lock().ok())
        .and_then(|g| g.clone());
    Ok(model)
}

/// 写某 claude 会话当前 model 到 registry(短锁)。
///
/// 前端 `setModel`(`/model` 切换,乐观更新)与真实 assistant 事件(每轮 model 校正)后调,
/// 把当前 model 同步到后端,供独立窗口 detach 后 `get_claude_session_model` 读回填。
/// init 事件后端已自行写(run_read_loop 调 update_claude_session_model),无需前端再调。
#[tauri::command]
pub fn set_claude_model(
    app: AppHandle,
    project_id: String,
    tab_id: String,
    model: String,
) -> Result<(), String> {
    update_claude_session_model(&app, &project_id, &tab_id, model)
}

// —— 辅助函数(均短锁,失败静默不阻断主流程) ——

/// 列出 claude 配置(`~/.claude/settings.json` 的 `env` 段)里所有可用 model id。
///
/// 收集 key 以 `_MODEL` 结尾(**不含** `_MODEL_NAME` 这类显示名)的 env 条目值--即
/// `ANTHROPIC_MODEL` 与各 `ANTHROPIC_DEFAULT_*_MODEL` 的实际解析值(如 "GLM-5.2[1M]")。
/// 去重、保持稳定顺序(`ANTHROPIC_MODEL` 优先置顶)。供前端模型选择器每次打开时实时拉取--
/// cc-switch 切供应商改写这些 env 后,下次打开即见新 provider 的可选模型,无需改前端预置表。
/// 文件缺失/无 env/无匹配项返回空数组(前端据此时只展示「当前」行)。
#[tauri::command]
pub fn list_claude_models() -> Result<Vec<String>, String> {
    let env = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .and_then(|home| {
            std::fs::read_to_string(std::path::Path::new(&home).join(".claude").join("settings.json")).ok()
        })
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|v| v.get("env").and_then(|e| e.as_object().cloned()));
    let env = match env {
        Some(e) => e,
        None => return Ok(Vec::new()),
    };
    let mut models: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let push = |models: &mut Vec<String>, seen: &mut std::collections::HashSet<String>, val: &str| {
        let v = val.trim();
        if !v.is_empty() && seen.insert(v.to_string()) {
            models.push(v.to_string());
        }
    };
    // ANTHROPIC_MODEL 优先置顶(当前默认 model)。
    if let Some(val) = env.get("ANTHROPIC_MODEL").and_then(|v| v.as_str()) {
        push(&mut models, &mut seen, val);
    }
    // 其余 *_MODEL(不含 _MODEL_NAME),按 key 字典序稳定遍历。
    let mut keys: Vec<&String> = env.keys().filter(|k| k.ends_with("_MODEL") && !k.ends_with("_NAME")).collect();
    keys.sort();
    for k in keys {
        if k == "ANTHROPIC_MODEL" {
            continue;
        }
        if let Some(val) = env.get(k).and_then(|v| v.as_str()) {
            push(&mut models, &mut seen, val);
        }
    }
    Ok(models)
}

/// 探测「当前生效供应商」的模型目录(`GET {baseUrl}/v1/models`),返回完整可用模型 id 列表。
///
/// 与 `list_claude_models` 互补:后者只读 settings.json env 里**已配置**的别名/模型
/// (`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_*_MODEL`),而供应商实际上支持更多模型——那些只有
/// 问端点才知道。前端模型选择器打开时并行拉两条:env 列表先瞬时上屏,本命令的结果回来后
/// 追加(去重),于是「明明有更多模型却没展示」被补齐。
///
/// 失败/超时(4s)/未配 baseUrl 一律返回空数组——选择器降级为只显示 env 项,不弹错。
/// 走 Rust 侧请求的原因同 `probe_provider_endpoint`:三方端点几乎不开 CORS。
#[tauri::command]
pub async fn list_claude_catalog_models() -> Result<Vec<String>, String> {
    let env = claude_settings_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|v| v.get("env").and_then(|e| e.as_object().cloned()))
        .unwrap_or_default();
    let base_url = env
        .get("ANTHROPIC_BASE_URL")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if base_url.is_empty() {
        return Ok(Vec::new());
    }
    let token = env
        .get("ANTHROPIC_AUTH_TOKEN")
        .or_else(|| env.get("ANTHROPIC_API_KEY"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let probe = crate::providers::commands::probe_endpoint(&base_url, Some(token.as_str()), 4).await;
    Ok(probe.models)
}

/// 读 `~/.claude/settings.json` 的 `env` 段并算哈希(仅 env 段:theme 等无关字段由 claude CLI
/// 自己改写,不应触发刷新)。文件缺失/解析失败返回空串的哈希(稳定值,仍可检测「从无到有」)。
fn claude_settings_env_hash() -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let env_json = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .and_then(|home| {
            std::fs::read_to_string(std::path::Path::new(&home).join(".claude").join("settings.json")).ok()
        })
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|v| v.get("env").map(|e| e.to_string()))
        .unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    env_json.hash(&mut hasher);
    hasher.finish()
}

/// 检测 `~/.claude/settings.json` 的 `env` 段相对本会话 spawn 时刻是否已变化。
///
/// cc-switch 等供应商切换工具改写 settings.json 的 BASE_URL/AUTH_TOKEN/ANTHROPIC_MODEL 等,
/// 但 env 是 claude 进程**启动时**自读的,运行中的长进程不会感知。前端打开模型选择器时调本
/// 命令,返回 true 则重启进程(--resume 保留 session)拾取新配置,init 回填新 model 后选择器
/// 「当前」即刷新。会话未 spawn 过(无基线)返回 false。
#[tauri::command]
pub fn claude_settings_changed(
    state: State<'_, ClaudeRegistry>,
    project_id: String,
    tab_id: String,
) -> Result<bool, String> {
    let stored = {
        let by_project = state.by_project.lock().map_err(|e| {
            log::error!("claude_settings_changed: state lock poisoned: {e}");
            e.to_string()
        })?;
        by_project
            .get(&project_id)
            .and_then(|sessions| sessions.get(&tab_id))
            .and_then(|session| session.settings_env_hash.lock().ok())
            .and_then(|g| *g)
    };
    Ok(stored.map(|h| claude_settings_env_hash() != h).unwrap_or(false))
}

/// `~/.claude/settings.json` 路径(home 下 .claude/settings.json;USERPROFILE 优先,回退 HOME)。
pub(crate) fn claude_settings_path() -> Option<std::path::PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(|home| std::path::Path::new(&home).join(".claude").join("settings.json"))
}

/// 读 `~/.claude/settings.json` 的 `env` 段(txuyStudio 内置供应商管理用:识别「当前生效」
/// + 「从当前配置导入」)。文件缺失/无 env 段返回空 map(非错误,前端按空态处理)。
#[tauri::command]
pub fn read_claude_settings_env() -> Result<std::collections::BTreeMap<String, String>, String> {
    let env = claude_settings_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|v| v.get("env").and_then(|e| e.as_object().cloned()))
        .unwrap_or_default();
    Ok(env
        .into_iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
        .collect())
}

/// 整体替换 `~/.claude/settings.json` 的 `env` 段(其余字段 statusLine/theme/enabledPlugins 等
/// 原样保留)。txuyStudio 内置供应商切换 = 前端传该 provider 的完整 env 段;写完后活跃会话
/// 由前端触发 `refreshIfSettingsChanged`(kill + --resume 拾取新 BASE_URL/TOKEN/MODEL)。
/// 文件不存在时以 `{ "env": … }` 骨架新建。
#[tauri::command]
pub fn write_claude_settings_env(env: std::collections::BTreeMap<String, String>) -> Result<(), String> {
    let path = claude_settings_path().ok_or_else(|| "cannot resolve home directory".to_string())?;
    // 先读原文件保住非 env 字段;读失败(不存在/损坏)从空对象起步。
    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let obj = root.as_object_mut().ok_or_else(|| "settings.json root is not an object".to_string())?;
    let env_json: serde_json::Map<String, serde_json::Value> = env
        .into_iter()
        .map(|(k, v)| (k, serde_json::Value::String(v)))
        .collect();
    obj.insert("env".to_string(), serde_json::Value::Object(env_json));
    let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize settings.json: {e}"))?;
    std::fs::write(&path, serialized).map_err(|e| format!("write settings.json: {e}"))
}

/// 设某 session 的状态(短锁)。失败静默(锁中毒不阻断主流程)。
fn set_session_status(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    status: ClaudeStatus,
) -> Result<(), String> {
    let registry = app.state::<ClaudeRegistry>();
    let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut g) = session.status.lock() {
            *g = status;
        }
    }
    Ok(())
}

/// kill 整个 claude 进程树并收尸。
///
/// Windows 上 claude 经 `cmd.exe /c claude.cmd` 包装 spawn(见 `start_claude_session`),直接
/// `child.kill()` 只 `TerminateProcess` 外层 `cmd.exe`,**不杀** shim 内部 spawn 的真正
/// `node claude.js` 孙子进程。后者存活后继续往 stdout pipe 写 -> 读循环不退出 -> 前端表现为
/// 「双 esc 中断后会话仍在继续」。用 `taskkill /F /T /PID` 终止整棵进程树(cmd.exe + node)根治;
/// taskkill 不可用(spawn 失败)时回退 `child.kill()`(至少杀 cmd.exe,语义不劣于现状)。非
/// Windows 无 `.cmd` 包装,`child.kill()` 即可。末尾 `wait()` 收尸防僵尸。
pub(super) fn kill_child_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        // child.id() 返回 u32 pid(进程已死也返回历史值)。taskkill 找不到 pid 时进程多半已退,
        // status() 返回 Ok(非 0),不 fallback,由末尾 wait() 收尸;仅 taskkill spawn 失败才 fallback。
        let pid = child.id();
        let killed = match command_no_window("taskkill.exe")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status() {
            Ok(_) => true,
            Err(e) => {
                log::warn!("kill_child_tree: taskkill failed for pid {pid}, fallback to child.kill: {e}");
                false
            }
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

/// 读循环:逐行读 claude 长进程 stdout,解析 stream-json,分类 emit `claude-event`。
///
/// 长进程模式下进程**不退出**(多轮同进程)。`result` 仅标志一轮结束(置 Idle,child 保持 Some);
/// 真正的进程退出 = stdout EOF。EOF 语义按 `killed` 标志分裂:
/// - `killed=true`(主动 kill/重启/中断):置 Idle,不发 error Terminated(中断由 kill_claude 主动 emit)。
/// - `killed=false`(崩溃/异常退出):emit `Terminated{eof}` + 置 Error,transport 下次 send 重启。
///
/// 分类:
/// - `system init` → 回填 registry.claude_session_id + emit Init
/// - `system thinking_tokens` → 攒批 emit Thinking
/// - `system status` → compact 状态(status=compacting 开始 / compact_result=success|failed 结束)+ emit CompactStatus
/// - `system compact_boundary` → emit CompactBoundary{metadata}
/// - `assistant` → flush thinking + emit Assistant
/// - `user` → 跳过 `isReplay && local-command-stdout`(Compacted Tip 噪音);否则 flush + emit User
/// - `result` → flush thinking + 置 Idle(进程不退)+ emit Result
fn run_read_loop(app: AppHandle, project_id: String, tab_id: String, stdout: std::process::ChildStdout) {
    let reader = std::io::BufReader::new(stdout);
    // thinking_tokens 是纯计数心跳(无文本),真实思考内容在 assistant 的 thinking block 里。
    let mut thinking_tokens: u64 = 0;
    let mut last_thinking_flush = Instant::now();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                log::warn!("claude read error, tab {tab_id}: {e}");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // 解析 JSON。非 JSON 行(极少,claude 偶发输出)warn 跳过,不阻断。
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("claude non-json line, tab {tab_id}: {e}: {}", trimmed.chars().take(200).collect::<String>());
                continue;
            }
        };

        let evt_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        // sidechain 子链(Task 子 agent)的事件不进主对话流:其 assistant usage 快照会被
        // 前端 computeContextInfo(取最近一条有 usage 的 assistant)误当主对话上下文,
        // Task 跑完 ctx% 瞬间跳成子 agent 的值。与 resume 回放路径的同款过滤对齐
        // (baocode _countRequest 亦排除 parent_tool_use_id / isSidechain)。
        let is_sidechain = v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false)
            || matches!(
                v.get("parent_tool_use_id"),
                Some(serde_json::Value::String(_))
            );
        match evt_type {
            "system" => {
                let subtype = v.get("subtype").and_then(|t| t.as_str()).unwrap_or("");
                if subtype == "init" {
                    // 回填 claude_session_id(仅首次,长进程内多轮不换 id)。
                    if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                        let _ = update_claude_session_id(&app, &project_id, &tab_id, sid.to_string());
                    }
                    let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
                    // 同步当前 model 到 registry(供独立窗口 detach 后 get_claude_session_model 回填)。
                    // init 是 claude 启动首事件,model 权威;非空才写。
                    if !model.is_empty() {
                        let _ = update_claude_session_model(&app, &project_id, &tab_id, model.clone());
                    }
                    let cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("").to_string();
                    let slash_commands = v
                        .get("slash_commands")
                        .and_then(|s| s.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let _ = app.emit(
                        "claude-event",
                        ClaudeEvent {
                            project_id: project_id.clone(),
                            tab_id: tab_id.clone(),
                            payload: ClaudeEventPayload::Init {
                                claude_session_id: v
                                    .get("session_id")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                model,
                                cwd,
                                slash_commands,
                            },
                        },
                    );
                } else if subtype == "thinking_tokens" {
                    // 纯计数心跳(无文本):累计 token 到阈值或定时 flush 一次空 Thinking,
                    // 驱动前端 status=thinking 状态指示。真实思考文本随 assistant thinking block 到达。
                    thinking_tokens += v
                        .get("estimated_tokens_delta")
                        .and_then(|d| d.as_u64())
                        .unwrap_or(1);
                    if thinking_tokens >= THINKING_BATCH_TOKENS
                        || last_thinking_flush.elapsed() >= THINKING_FLUSH_INTERVAL
                    {
                        let _ = app.emit(
                            "claude-event",
                            ClaudeEvent {
                                project_id: project_id.clone(),
                                tab_id: tab_id.clone(),
                                payload: ClaudeEventPayload::Thinking {
                                    text: String::new(),
                                },
                            },
                        );
                        thinking_tokens = 0;
                        last_thinking_flush = Instant::now();
                    }
                } else if subtype == "status" {
                    // compact 状态:status="compacting" 开始;compact_result=success|failed 结束。
                    let status = v.get("status").and_then(|s| s.as_str()).map(|s| s.to_string());
                    let result = v
                        .get("compact_result")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                    let error = v
                        .get("compact_error")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                    // 后端 status 联动:compacting → Compacting;result 到达 → 复位 Idle(compact 仍是进行中轮的一部分,
                    // 但 compact 引擎已结束,下一轮 result 才真正结束本 compact 轮)。
                    if status.as_deref() == Some("compacting") {
                        let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Compacting);
                    } else if result.is_some() {
                        let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Running);
                    }
                    let _ = app.emit(
                        "claude-event",
                        ClaudeEvent {
                            project_id: project_id.clone(),
                            tab_id: tab_id.clone(),
                            payload: ClaudeEventPayload::CompactStatus { status, result, error },
                        },
                    );
                } else if subtype == "compact_boundary" {
                    // compact 成功边界:透传完整 compact_metadata。
                    let metadata = v.get("compact_metadata").cloned().unwrap_or(serde_json::Value::Null);
                    let _ = app.emit(
                        "claude-event",
                        ClaudeEvent {
                            project_id: project_id.clone(),
                            tab_id: tab_id.clone(),
                            payload: ClaudeEventPayload::CompactBoundary { metadata },
                        },
                    );
                } else if subtype == "background_tasks_changed" {
                    // 后台任务列表权威快照(任务启动/完成/变化时推,含 result 之后的空闲期)。
                    // 前端据此显示「后台任务 ×N」,快照清空即回 idle。字段缺失容错:无 task_id 的项跳过。
                    let tasks: Vec<BackgroundTaskInfo> = v
                        .get("tasks")
                        .and_then(|t| t.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|t| {
                                    let task_id = t.get("task_id").and_then(|s| s.as_str())?.to_string();
                                    Some(BackgroundTaskInfo {
                                        task_id,
                                        task_type: t
                                            .get("task_type")
                                            .and_then(|s| s.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                        description: t
                                            .get("description")
                                            .and_then(|s| s.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    // 快照同步进 session(手机 chat_status 断线重连补齐;见 ClaudeSession 字段注释)。
                    if let Some(reg) = app.try_state::<ClaudeRegistry>() {
                        if let Ok(by_project) = reg.by_project.lock() {
                            if let Some(session) = by_project
                                .get(project_id.as_str())
                                .and_then(|m| m.get(tab_id.as_str()))
                            {
                                if let Ok(mut g) = session.background_tasks.lock() {
                                    *g = tasks.clone();
                                }
                            }
                        }
                    }
                    let _ = app.emit(
                        "claude-event",
                        ClaudeEvent {
                            project_id: project_id.clone(),
                            tab_id: tab_id.clone(),
                            payload: ClaudeEventPayload::BackgroundTasksChanged { tasks },
                        },
                    );
                } else if subtype == "task_notification" {
                    // 后台任务完成/失败通知(带人读 summary),前端在消息流插入轻量完成提示。
                    let _ = app.emit(
                        "claude-event",
                        ClaudeEvent {
                            project_id: project_id.clone(),
                            tab_id: tab_id.clone(),
                            payload: ClaudeEventPayload::TaskNotification {
                                task_id: v
                                    .get("task_id")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                tool_use_id: v
                                    .get("tool_use_id")
                                    .and_then(|s| s.as_str())
                                    .map(|s| s.to_string()),
                                status: v
                                    .get("status")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                summary: v
                                    .get("summary")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                            },
                        },
                    );
                }
            }
            "assistant" => {
                if is_sidechain {
                    continue;
                }
                // 进入 assistant/user/result:思考阶段结束,复位计数心跳(真实思考内容已随
                // assistant 的 thinking block 到达,无需残留 flush)。
                thinking_tokens = 0;
                last_thinking_flush = Instant::now();
                let message = v.get("message").cloned().unwrap_or(serde_json::Value::Null);
                let _ = app.emit(
                    "claude-event",
                    ClaudeEvent {
                        project_id: project_id.clone(),
                        tab_id: tab_id.clone(),
                        payload: ClaudeEventPayload::Assistant { message },
                    },
                );
            }
            "user" => {
                if is_sidechain {
                    continue;
                }
                // 跳过 isReplay && local-command-stdout(Compacted Tip 回放噪音,非真实用户消息)。
                let is_replay = v.get("isReplay").and_then(|b| b.as_bool()).unwrap_or(false);
                let content_str = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("");
                if is_replay && content_str.contains("<local-command-stdout>") {
                    continue;
                }
                // 进入 assistant/user/result:思考阶段结束,复位计数心跳(真实思考内容已随
                // assistant 的 thinking block 到达,无需残留 flush)。
                thinking_tokens = 0;
                last_thinking_flush = Instant::now();
                let message = v.get("message").cloned().unwrap_or(serde_json::Value::Null);
                let _ = app.emit(
                    "claude-event",
                    ClaudeEvent {
                        project_id: project_id.clone(),
                        tab_id: tab_id.clone(),
                        payload: ClaudeEventPayload::User { message },
                    },
                );
            }
            "control_response" => {
                // P2(#137):`get_context_usage` 的 CLI 权威账本回包(请求由
                // request_claude_context_usage 经 stdin 发出)。success 时透传 response.response
                // 全量(categories(kind: used/buffer/free)/totalTokens/maxTokens/
                // autoCompactThreshold/messageBreakdown/…);error 仅记日志(旧 CLI 不认该 subtype,
                // baocode 同款容错:context 是锦上添花,拿不到就继续用前端估算)。
                let resp = v.get("response");
                let subtype = resp
                    .and_then(|r| r.get("subtype"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                if subtype != "success" {
                    log::info!(
                        "claude control_response error, tab {tab_id}: {}",
                        resp.and_then(|r| r.get("error"))
                            .map(|e| e.to_string())
                            .unwrap_or_else(|| "unknown".to_string())
                    );
                    continue;
                }
                let data = resp
                    .and_then(|r| r.get("response"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let _ = app.emit(
                    "claude-event",
                    ClaudeEvent {
                        project_id: project_id.clone(),
                        tab_id: tab_id.clone(),
                        payload: ClaudeEventPayload::ContextUsage { data },
                    },
                );
            }
            "control_request" => {
                // --permission-prompt-tool stdio:CLI 在执行需授权工具前问宿主。
                // can_use_tool → 交前端弹确认卡(respond_claude_permission 回包);
                // ExitPlanMode → 就地 deny(计划卡沿用现有 hasPendingPlan 流程:轮次就此结束,
                // 等用户批准/反馈),对齐 BaoCode _permission 的 planPresented 处理。
                let req = v.get("request");
                let subtype = req
                    .and_then(|r| r.get("subtype"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                let request_id = v.get("request_id").and_then(|s| s.as_str()).unwrap_or("");
                if subtype == "can_use_tool" && !request_id.is_empty() {
                    let tool_name = req
                        .and_then(|r| r.get("tool_name"))
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    if tool_name == "ExitPlanMode" {
                        let line = serde_json::json!({
                            "type": "control_response",
                            "response": {
                                "subtype": "success",
                                "request_id": request_id,
                                "response": {
                                    "behavior": "deny",
                                    "message": "Plan presented to the user; the turn ends here and waits for their reply.",
                                },
                            },
                        })
                        .to_string()
                            + "\n";
                        if let Err(e) = write_stdin_line(&app, &project_id, &tab_id, &line) {
                            log::warn!("claude plan-deny write failed, tab {tab_id}: {e}");
                        }
                    } else {
                        let input = req
                            .and_then(|r| r.get("input"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        let _ = app.emit(
                            "claude-event",
                            ClaudeEvent {
                                project_id: project_id.clone(),
                                tab_id: tab_id.clone(),
                                payload: ClaudeEventPayload::PermissionRequest {
                                    request_id: request_id.to_string(),
                                    tool_use_id: req
                                        .and_then(|r| r.get("tool_use_id"))
                                        .and_then(|s| s.as_str())
                                        .map(|s| s.to_string()),
                                    tool_name,
                                    display_name: req
                                        .and_then(|r| r.get("display_name"))
                                        .and_then(|s| s.as_str())
                                        .map(|s| s.to_string()),
                                    input,
                                    description: req
                                        .and_then(|r| r.get("description"))
                                        .and_then(|s| s.as_str())
                                        .map(|s| s.to_string()),
                                    reason_type: req
                                        .and_then(|r| r.get("decision_reason_type"))
                                        .and_then(|s| s.as_str())
                                        .map(|s| s.to_string()),
                                },
                            },
                        );
                    }
                } else if !request_id.is_empty() {
                    // 未支持的 subtype:明确拒绝,CLI 不至于干等。
                    let line = serde_json::json!({
                        "type": "control_response",
                        "response": {
                            "subtype": "success",
                            "request_id": request_id,
                            "response": { "behavior": "deny", "message": "Unsupported by this client" },
                        },
                    })
                    .to_string()
                        + "\n";
                    let _ = write_stdin_line(&app, &project_id, &tab_id, &line);
                }
            }
            "result" => {
                // 进入 assistant/user/result:思考阶段结束,复位计数心跳(真实思考内容已随
                // assistant 的 thinking block 到达,无需残留 flush)。
                thinking_tokens = 0;
                last_thinking_flush = Instant::now();
                // 长进程:result 仅标志一轮结束,置 Idle(child 保持 Some,进程不退)。
                let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Idle);
                let success = v.get("subtype").and_then(|s| s.as_str()) == Some("success");
                let is_error = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(!success);
                let payload = ClaudeEventPayload::Result {
                    success: success && !is_error,
                    duration_ms: v.get("duration_ms").and_then(|d| d.as_u64()).unwrap_or(0),
                    num_turns: v.get("num_turns").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
                    total_cost_usd: v
                        .get("total_cost_usd")
                        .and_then(|c| c.as_f64())
                        .unwrap_or(0.0),
                    stop_reason: v
                        .get("stop_reason")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string()),
                    error: if is_error {
                        v.get("result").and_then(|r| r.as_str()).map(|s| s.to_string())
                    } else {
                        None
                    },
                    usage: v.get("usage").cloned(),
                    context_window: v
                        .get("modelUsage")
                        .and_then(|mu| mu.as_object())
                        .and_then(|o| o.values().next())
                        .and_then(|m| m.get("contextWindow"))
                        .and_then(|c| c.as_u64()),
                };
                let _ = app.emit(
                    "claude-event",
                    ClaudeEvent {
                        project_id: project_id.clone(),
                        tab_id: tab_id.clone(),
                        payload,
                    },
                );
            }
            _ => {
                log::trace!("claude unknown event type '{evt_type}', tab {tab_id}");
            }
        }
    }

    // stdout EOF = 长进程退出(正常情况不该退出 → 异常,除非主动 kill)。
    let killed = take_killed_flag(&app, &project_id, &tab_id);
    if !killed {
        // 崩溃/异常退出:emit Terminated{eof} + 置 Error,transport 下次 send 重启。
        let _ = app.emit(
            "claude-event",
            ClaudeEvent {
                project_id: project_id.clone(),
                tab_id: tab_id.clone(),
                payload: ClaudeEventPayload::Terminated {
                    reason: "eof".to_string(),
                },
            },
        );
        let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Error);
    } else {
        // 主动 kill(中断/重启):置 Idle,不发 error(kill_claude 已主动 emit interrupted)。
        let _ = set_session_status(&app, &project_id, &tab_id, ClaudeStatus::Idle);
    }
    // child + stdin 置 None(进程已退,下次 send 触发 ensureStarted 重启)。
    let _ = take_child(&app, &project_id, &tab_id);
    let _ = take_stdin(&app, &project_id, &tab_id);
    log::info!(
        "claude read loop ended, tab {tab_id} project {project_id}, killed={killed}"
    );
}

/// 回填 claude_session_id 到 registry(短锁)。首轮 init 后调用,后续轮 spawn 据此带 --resume。
fn update_claude_session_id(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    sid: String,
) -> Result<(), String> {
    // 1) 回填 registry(短锁)。始终更新:重启 resume 同 id 幂等;/clear 若换 id 捕获最新。
    let registry = app.state::<ClaudeRegistry>();
    if let Ok(by_project) = registry.by_project.lock() {
        if let Some(session) = by_project
            .get(project_id)
            .and_then(|sessions| sessions.get(tab_id))
        {
            if let Ok(mut g) = session.claude_session_id.lock() {
                *g = Some(sid.clone());
            }
        }
    }
    // 2) 持久化到 AppState(跨重启 --resume 用)。短锁改 + 克隆 + 释放 + save;失败仅 warn 不阻塞。
    let app_state = app.state::<AppState>();
    let snapshot = {
        let mut snap = app_state.inner.lock().map_err(|e| e.to_string())?;
        if let Some(project) = snap.projects.iter_mut().find(|p| p.id == project_id) {
            project.claude_tab_sessions.insert(tab_id.to_string(), sid);
        }
        snap.clone()
    };
    if let Err(e) = crate::state::persistence::save(app, &snapshot) {
        log::warn!("update_claude_session_id: persist failed: {e}");
    }
    Ok(())
}

/// 写当前会话 model 到 registry(init 回填 / 前端 `/model` 切换 / 真实 assistant 事件同步)。
/// 供独立窗口(detach)新建 transport 时 `get_claude_session_model` 读回填 meta.model。
fn update_claude_session_model(
    app: &AppHandle,
    project_id: &str,
    tab_id: &str,
    model: String,
) -> Result<(), String> {
    let registry = app.state::<ClaudeRegistry>();
    let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut g) = session.model.lock() {
            *g = Some(model);
        }
    }
    Ok(())
}

/// 取出并清空 child(短锁置 None)。读循环 EOF 时调用(进程已退,下次 send 触发 ensureStarted 重启)。
fn take_child(app: &AppHandle, project_id: &str, tab_id: &str) -> Result<(), String> {
    let registry = app.state::<ClaudeRegistry>();
    let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut g) = session.child.lock() {
            // child 可能已被 kill_claude 取走(take),这里再 take 一次幂等。
            let _ = g.take();
        }
    }
    Ok(())
}

/// 取出并清空 stdin(短锁置 None)。读循环 EOF 时调用(进程已退,stdin 失效)。
fn take_stdin(app: &AppHandle, project_id: &str, tab_id: &str) -> Result<(), String> {
    let registry = app.state::<ClaudeRegistry>();
    let by_project = registry.by_project.lock().map_err(|e| e.to_string())?;
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut g) = session.stdin.lock() {
            // stdin 可能已被 kill_claude/send_claude_message 取走,这里再 take 一次幂等。
            let _ = g.take();
        }
    }
    Ok(())
}

/// 读取并清空 killed 标志(短锁)。读循环 EOF 时调用,据返回值决定是否 emit error Terminated。
/// 清空是为了让下一次 start_claude_session 重启时 killed 复位为 false(start_claude_session 也会主动置 false)。
fn take_killed_flag(app: &AppHandle, project_id: &str, tab_id: &str) -> bool {
    let registry = app.state::<ClaudeRegistry>();
    let by_project = match registry.by_project.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if let Some(session) = by_project
        .get(project_id)
        .and_then(|sessions| sessions.get(tab_id))
    {
        if let Ok(mut k) = session.killed.lock() {
            return std::mem::take(&mut *k);
        }
    }
    false
}

/// 历史回填事件上限:大会话(数千行)只回填最近部分,防一次性注入巨量消息卡 UI。
const HISTORY_MAX_EVENTS: usize = 400;

/// 手机端裁剪上限(仅 `slim_event_for_mobile` 消费):
/// text/thinking 是正文与思考,给足余量截 16K 字符;tool_result 全文截 2K;
/// tool_use.input 只产一句话摘要(200 字)。
const HISTORY_SLIM_TEXT_MAX: usize = 16_000;
const HISTORY_SLIM_RESULT_MAX: usize = 2_048;
const HISTORY_SLIM_INPUT_MAX: usize = 200;

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// 手机端 tool_use.input 摘要:与 companion `stream.dart _briefInput` 同款取法
/// (取首个路径/命令类字段),产 String 让手机端 `_briefInput` 直通截断展示。
fn brief_input_for_mobile(input: Option<&serde_json::Value>) -> String {
    let Some(v) = input else {
        return String::new();
    };
    match v {
        serde_json::Value::String(s) => truncate_chars(s, HISTORY_SLIM_INPUT_MAX),
        serde_json::Value::Object(m) => {
            for k in ["command", "file_path", "path", "pattern", "url", "query", "prompt", "description"] {
                if let Some(serde_json::Value::String(s)) = m.get(k) {
                    if !s.is_empty() {
                        return truncate_chars(s, HISTORY_SLIM_INPUT_MAX);
                    }
                }
            }
            let joined = m
                .iter()
                .map(|(k, x)| format!("{k}={x}"))
                .collect::<Vec<_>>()
                .join(", ");
            truncate_chars(&joined, HISTORY_SLIM_INPUT_MAX)
        }
        other => truncate_chars(&other.to_string(), HISTORY_SLIM_INPUT_MAX),
    }
}

/// 手机端 chat.history 载荷裁剪(2026-11-05 方案 1):历史回填的 message 是**完整** JSON
/// (tool_use 完整 input、tool_result 全文,单条可达数百 KB),400 条序列化 + E2E 加密 +
/// 公网转发轻松数 MB,手机首开秒等。手机渲染(`stream.dart applyClaude`)只消费
/// text/thinking 全文、tool_use 的 name + input 一句话摘要、tool_result content 回填,
/// 据此投影:text/thinking 截 16K、tool_use.input 摘要 200 字、tool_result.content 截 2K、
/// 其余 block(redacted_thinking 等)与顶层大字段(usage 等)丢弃。
/// 仅 relay `chat_history`(手机)走此路径;桌面 tauri command 回溯回填保持全量。
pub fn slim_event_for_mobile(v: &ClaudeEventPayload) -> ClaudeEventPayload {
    let message = match v {
        ClaudeEventPayload::User { message } | ClaudeEventPayload::Assistant { message } => message,
        other => return other.clone(),
    };
    let mut slim = serde_json::Map::new();
    // 前端归并只用 id(同 id 覆盖)+ role;content 见下。
    for k in ["id", "role"] {
        if let Some(x) = message.get(k) {
            slim.insert(k.to_string(), x.clone());
        }
    }
    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Some(serde_json::Value::Array(blocks)) = message.get("content") {
        for b in blocks {
            match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "text" => {
                    let t = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    out.push(json!({ "type": "text", "text": truncate_chars(t, HISTORY_SLIM_TEXT_MAX) }));
                }
                "thinking" => {
                    // thinking block 另有 signature(base64,可达数 KB)一并丢弃。
                    let t = b.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                    out.push(json!({ "type": "thinking", "thinking": truncate_chars(t, HISTORY_SLIM_TEXT_MAX) }));
                }
                "tool_use" => out.push(json!({
                    "type": "tool_use",
                    "id": b.get("id"),
                    "name": b.get("name"),
                    "input": brief_input_for_mobile(b.get("input")),
                })),
                "tool_result" => {
                    // content 是 str 或 block 数组(取 text 拼接),统一拍平成截断字符串,
                    // 手机端 `_flattenResult` 对 String 直通。
                    let flat = match b.get("content") {
                        Some(serde_json::Value::String(s)) => s.clone(),
                        Some(serde_json::Value::Array(items)) => items
                            .iter()
                            .map(|c| c.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string())
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => String::new(),
                    };
                    out.push(json!({
                        "type": "tool_result",
                        "tool_use_id": b.get("tool_use_id"),
                        "is_error": b.get("is_error"),
                        "content": truncate_chars(&flat, HISTORY_SLIM_RESULT_MAX),
                    }));
                }
                // redacted_thinking / image / document 等手机不渲染,直接丢。
                _ => {}
            }
        }
    }
    slim.insert("content".to_string(), json!(out));
    let message = serde_json::Value::Object(slim);
    match v {
        ClaudeEventPayload::User { .. } => ClaudeEventPayload::User { message },
        ClaudeEventPayload::Assistant { .. } => ClaudeEventPayload::Assistant { message },
        _ => unreachable!(),
    }
}

/// `read_claude_history_events` 返回:events(最多上限条,取**末尾**段=最近上下文)+ total(全会话
/// 命中事件数,total > events.len 时前端提示「仅回填最近部分」)。camelCase 对齐前端。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHistoryEvents {
    pub events: Vec<ClaudeEventPayload>,
    pub total: usize,
}

/// 读某 claude 历史会话 jsonl,解析成与实时 `claude-event` **同构**的事件序列(恢复会话历史回填)。
///
/// 背景:glm 代理的 `claude --resume` 不重放历史(官方版会推 isReplay 重放事件,实测 glm 2.1.235
/// 只推 init+本轮新事件),前端恢复后消息流空、零视觉反馈。本命令读
/// `~/.claude/projects/**/<sessionId>.jsonl`(session id 全局唯一,递归定位不依赖 cwd),
/// 逐行取 `type=="user"/"assistant"` 且 `isSidechain!=true` 的行包成 `ClaudeEventPayload::User/Assistant`
/// (message 透传,前端 applyEvent 直接归并渲染,thinking/工具卡片结构完整);其余行
/// (queue-operation/attachment/last-prompt/mode/system 等)跳过。spawn_blocking 包裹(逐行 IO)。
///
/// 文件不存在 -> `Err`(前端 notice 提示「历史回填失败」但不阻断恢复--claude 内部上下文仍续接)。
#[tauri::command]
pub async fn read_claude_history_events(session_id: String) -> Result<ClaudeHistoryEvents, String> {
    tokio::task::spawn_blocking(move || {
        let file = find_claude_session_file(&session_id)?;
        let f = std::fs::File::open(&file).map_err(|e| format!("open {}: {e}", file.display()))?;
        let mut all: Vec<ClaudeEventPayload> = Vec::new();
        for line in std::io::BufReader::new(f).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                continue;
            };
            // sidechain 子链(subagent)不混入主对话历史。
            if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) {
                continue;
            }
            let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let message = match v.get("message") {
                Some(m) if !m.is_null() => m.clone(),
                _ => continue,
            };
            let payload = match ty {
                "user" => ClaudeEventPayload::User { message },
                "assistant" => ClaudeEventPayload::Assistant { message },
                _ => continue,
            };
            all.push(payload);
        }
        let total = all.len();
        if total > HISTORY_MAX_EVENTS {
            all = all.split_off(total - HISTORY_MAX_EVENTS);
        }
        Ok(ClaudeHistoryEvents { events: all, total })
    })
    .await
    .map_err(|e| format!("join history read task: {e}"))?
}

/// 在 `~/.claude/projects` 下递归定位 stem 恰等 session_id 的 jsonl(全等比对,防 uuid 前缀
/// 误命中)。`read_claude_history_events` 与 `fork_claude_session` 共用。
fn find_claude_session_file(session_id: &str) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir not available".to_string())?;
    let root = home.join(".claude").join("projects");
    let want = format!("{session_id}.jsonl");
    let mut found: Option<std::path::PathBuf> = None;
    crate::system::commands::walk_jsonl(&root, &mut |p| {
        if found.is_none() && p.file_name().map(|s| s.to_str() == Some(want.as_str())).unwrap_or(false) {
            found = Some(p.to_path_buf());
        }
    });
    found.ok_or_else(|| format!("claude session file not found: {session_id}"))
}

/// user 行的「对话全文」(与前端 ClaudePane 回溯弹窗同构的取法):content 为 block 数组时拼
/// text block(用 "" 连接,多行消息单 block 内含换行不受影响);str/无 text block 返回 None
/// (tool_result-only 行、compact 总结 str 行、command 标记行均非「用户输入」)。
fn user_line_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    match content {
        serde_json::Value::Array(blocks) => {
            let texts: Vec<&str> = blocks
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        b.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            if texts.is_empty() { None } else { Some(texts.join("")) }
        }
        _ => None,
    }
}

/// `fork_claude_session` 的返回:camelCase 对齐前端。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkClaudeSessionResult {
    /// 分叉出的新会话 id。`None` = 截断点之前无对话内容(fork 是空壳,resume 无意义),
    /// 前端走 `/clear` 等价路径(语义相同:空上下文重开)。
    pub new_session_id: Option<String>,
}

/// 回溯到某条历史消息:把当前会话 jsonl **截断复制**成新会话文件(分叉),返回新 session id,
/// 前端 `resumeSession(new_id)` kill 旧进程 + `--resume` 拉起分叉 -> 上下文与消息流真正回到
/// 该消息之前(实测 glm 2.1.235 `--resume` 按文件加载上下文且 session id 不变,2026-10-21
/// fork 验证通过;对齐 claude code 自带 rewind 的「分叉 transcript」语义,替换旧「/clear 全清
/// + 回填输入框」——上下文全丢、消息流清空,用户实测「清空了也没回溯成功」)。
///
/// 定位截断点:与前端弹窗同构——找第 `occurrence`(0-based,同文本第几次出现)条「用户输入」
/// user 行(非 sidechain/meta、block 数组含 text block、拼接全文 == `text` 完全相等),该行
/// **之前**(不含)全部复制。stream-json 不回显用户消息、UI user 消息是乐观插入的自生成 id,
/// 无法走 uuid,同文本 occurrence 是唯一稳定映射(UI 顺序 == jsonl 行顺序)。
///
/// 复制时逐行覆写 `sessionId` 为新 id(自洽;实测改写后 resume 正常);解析失败的行原样保留。
#[tauri::command]
pub async fn fork_claude_session(
    session_id: String,
    text: String,
    occurrence: usize,
) -> Result<ForkClaudeSessionResult, String> {
    tokio::task::spawn_blocking(move || {
        let file = find_claude_session_file(&session_id)?;
        let content = std::fs::read_to_string(&file).map_err(|e| format!("read {}: {e}", file.display()))?;
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();

        // 找第 occurrence 条全文 == text 的用户输入行。
        let mut cut: Option<usize> = None;
        let mut seen = 0usize;
        for (i, line) in lines.iter().enumerate() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if v.get("type").and_then(|t| t.as_str()) != Some("user")
                || v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false)
                || v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false)
            {
                continue;
            }
            if user_line_text(&v).as_deref() == Some(text.as_str()) {
                if seen == occurrence {
                    cut = Some(i);
                    break;
                }
                seen += 1;
            }
        }
        let cut = cut.ok_or_else(|| {
            format!("rewind target not found in session {session_id} (occurrence {occurrence})")
        })?;

        // 截断点前无对话行(assistant / 用户输入 / tool_result)→ fork 是空壳,交给调用方走 /clear。
        let has_conversation = lines[..cut].iter().any(|line| {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return false };
            if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false)
                || v.get("isMeta").and_then(|b| b.as_bool()).unwrap_or(false)
            {
                return false;
            }
            match v.get("type").and_then(|t| t.as_str()) {
                Some("assistant") => true,
                Some("user") => {
                    let content = v.get("message").and_then(|m| m.get("content"));
                    matches!(content, Some(serde_json::Value::Array(_)))
                }
                _ => false,
            }
        });
        if !has_conversation {
            return Ok(ForkClaudeSessionResult { new_session_id: None });
        }

        // 复制 [0, cut) 行到同目录新文件,逐行覆写 sessionId。
        let new_id = uuid::Uuid::new_v4().to_string();
        let mut out = String::with_capacity(content.len());
        for line in &lines[..cut] {
            let rewritten = match serde_json::from_str::<serde_json::Value>(line) {
                Ok(mut v) => {
                    if let Some(sid) = v.get_mut("sessionId") {
                        *sid = serde_json::Value::String(new_id.clone());
                    }
                    serde_json::to_string(&v).map_err(|e| format!("reserialize line: {e}"))?
                }
                Err(_) => (*line).to_string(),
            };
            out.push_str(&rewritten);
            out.push('\n');
        }
        let dest = file.with_file_name(format!("{new_id}.jsonl"));
        std::fs::write(&dest, out).map_err(|e| format!("write {}: {e}", dest.display()))?;
        log::info!(
            "fork_claude_session: {session_id} -> {new_id} (cut at line {cut}/{})",
            lines.len()
        );
        Ok(ForkClaudeSessionResult { new_session_id: Some(new_id) })
    })
    .await
    .map_err(|e| format!("join fork task: {e}"))?
}

/// 本地工具执行输出上限(字符):超长截尾保头(claude Bash 工具同思路,防巨输出打爆 IPC/UI)。
const LOCAL_TOOL_OUTPUT_MAX: usize = 100 * 1024;

/// `exec_claude_tool_local` 的返回:output(拼好的工具输出文本)+ is_error(执行框架层面失败,
/// 如 old_string 不匹配/文件不可写;Bash exit 非 0 不算 error,exit code 拼在 output 尾,claude
/// 看到失败输出自行调整)。camelCase 对齐前端。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolResult {
    pub output: String,
    pub is_error: bool,
}

/// 本地执行一次被拒(需批准)的 claude 工具调用(用户点「批准」后由前端调,结果经
/// `send_claude_message` 的 tool_result 原地回传给 claude 续跑--claude cli 交互批准的同语义,
/// 不发对话消息)。支持 Bash(PowerShell 执行)/Edit(唯一匹配替换)/Write;未知工具 `Err`
/// (前端回退旧「发消息重试」方案)。同步 IO 用 `spawn_blocking` 不占 async worker;
/// 无硬超时(与 `!` 命令同策略:用户批准的命令,久跑久等)。
#[tauri::command]
pub async fn exec_claude_tool_local(
    tool: String,
    input: serde_json::Value,
    cwd: Option<String>,
) -> Result<LocalToolResult, String> {
    tokio::task::spawn_blocking(move || match tool.as_str() {
        "Bash" | "PowerShell" | "Shell" => exec_local_bash(&input, cwd.as_deref()),
        "Edit" | "Replace" => exec_local_edit(&input, cwd.as_deref()),
        "Write" => exec_local_write(&input, cwd.as_deref()),
        _ => Err(format!("tool not locally executable: {tool}")),
    })
    .await
    .map_err(|e| format!("join local tool exec: {e}"))?
}

/// Bash 工具本地执行:claude 的 Bash 是 POSIX 语义,Windows 下用 PowerShell 跑(绝大多数常用
/// 命令兼容;不兼容命令 exit 非 0,输出原样回传,claude 看到错误自行调整)。复用 `command_no_window`
/// (CREATE_NO_WINDOW 防弹窗);stdout+stderr 合并,尾拼 exit code(claude Bash 工具惯例),超长截断。
fn exec_local_bash(input: &serde_json::Value, cwd: Option<&str>) -> Result<LocalToolResult, String> {
    let command = input
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Bash input missing `command`".to_string())?;
    let mut cmd = command_no_window("powershell");
    // UTF-8 输出编码前置:防中文输出按 GBK 解码成乱码。
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &format!("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; {command}"),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let out = cmd.output().map_err(|e| format!("spawn powershell: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !stderr.trim().is_empty() {
        text.push_str("\n[stderr]\n");
        text.push_str(&stderr);
    }
    text.push_str(&format!("\n[exit code: {}]", out.status.code().unwrap_or(-1)));
    if text.chars().count() > LOCAL_TOOL_OUTPUT_MAX {
        let truncated: String = text.chars().take(LOCAL_TOOL_OUTPUT_MAX).collect();
        text = truncated + "\n[output truncated by txuyStudio]";
    }
    Ok(LocalToolResult { output: text, is_error: false })
}

/// Edit 工具本地执行:old_string 唯一匹配替换(replace_all=true 全替换,Edit 工具语义);
/// 不匹配/多匹配 -> is_error(claude 收到错误自行调整,与官方 Edit 工具报错语义一致)。
fn exec_local_edit(input: &serde_json::Value, cwd: Option<&str>) -> Result<LocalToolResult, String> {
    let path = resolve_tool_path(input, cwd)?;
    let old = input
        .get("old_string")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Edit input missing `old_string`".to_string())?;
    let new = input
        .get("new_string")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Edit input missing `new_string`".to_string())?;
    let replace_all = input
        .get("replace_all")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let count = content.matches(old).count();
    if count == 0 {
        return Ok(LocalToolResult {
            output: format!("old_string not found in {}", path.display()),
            is_error: true,
        });
    }
    if count > 1 && !replace_all {
        return Ok(LocalToolResult {
            output: format!("old_string not unique ({count} matches) in {}", path.display()),
            is_error: true,
        });
    }
    let replaced = if replace_all {
        content.replace(old, new)
    } else {
        content.replacen(old, new, 1)
    };
    std::fs::write(&path, replaced).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(LocalToolResult {
        output: format!("edited {}", path.display()),
        is_error: false,
    })
}

/// Write 工具本地执行:整文件写入。
fn exec_local_write(input: &serde_json::Value, cwd: Option<&str>) -> Result<LocalToolResult, String> {
    let path = resolve_tool_path(input, cwd)?;
    let content = input
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Write input missing `content`".to_string())?;
    std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(LocalToolResult {
        output: format!("wrote {}", path.display()),
        is_error: false,
    })
}

/// 解析工具 input 的 file_path(绝对;相对则 join cwd)。校验:词法 `..` 拒绝(纵深防御,
/// 与 filetree/list_ai_cli_sessions 同思路)。用户已点批准,不做白名单限制。
fn resolve_tool_path(
    input: &serde_json::Value,
    cwd: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let raw = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tool input missing `file_path`".to_string())?;
    let path = if std::path::Path::new(raw).is_absolute() {
        std::path::PathBuf::from(raw)
    } else {
        let base = cwd.ok_or_else(|| "relative file_path but no cwd".to_string())?;
        std::path::Path::new(base).join(raw)
    };
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("path escapes via ..: {raw}"));
    }
    Ok(path)
}
