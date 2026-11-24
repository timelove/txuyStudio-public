//! conductor Tauri 命令(P0 规则层 + P1 大脑/驿站/决策卡/配置)。

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use super::brain::{BrainIntent, MAX_TOKENS};
use super::guard::{self, DispatchGate};
use super::inbox::{
    is_dispatchable, push_decision, schedule_next, DecisionKind, DecisionRecord, DecisionSource,
    DecisionStatus, InboxItem, InboxStatus, InboxTarget, REPEAT_FAIL_STREAK_STOP,
    REPEAT_MAX_MINUTES, REPEAT_MIN_MINUTES,
};
use super::memory;
use super::orchestrate;
use super::permissions;
use super::{
    apply_saved_bounds, attention_count, emit_event, now_ms, save_disk, snapshot_disk, ConductorState,
    SessionStatus, CONDUCTOR_WINDOW_LABEL, STAGE_WINDOW_LABEL,
};
use crate::claude::ClaudeRegistry;
use crate::codex::CodexRegistry;
use crate::state::{AppState, PaneNode, WindowBounds};

/// 决策流返回上限(决策日志滚动 200,快照只给最近 100)。
const DECISIONS_SNAPSHOT: usize = 100;
/// 驿站条目上限(防御性;正常用量远达不到)。
const INBOX_CAP: usize = 500;
/// 自动建议去重窗口(同目标同来源已卡未决不重产)。
const SUGGEST_DEDUP_MS: i64 = 30 * 60_000;
/// 循环器 tick 间隔(最小循环间隔 1 分钟,15s tick 足够精细,开销可忽略)。
const REPEAT_TICK: std::time::Duration = std::time::Duration::from_secs(15);
/// 大脑决策循环兜底间隔(设计 §9 P2:事件触发之外 5min 定时兜底;auto_suggest 内部
/// 有总闸/degraded/30min 去重窗,兜底轮不会刷屏)。
const BRAIN_LOOP_TICK: std::time::Duration = std::time::Duration::from_secs(5 * 60);

// ---------------------------------------------------------------- 快照富化

/// 递归收集 pane tree 全部 tab:id → title(快照行富化用)。
fn walk_tabs(node: &PaneNode, project_id: &str, out: &mut HashMap<String, String>) {
    match node {
        PaneNode::Pane { tabs, .. } => {
            for tab in tabs {
                out.insert(super::skey(project_id, &tab.id), tab.title.clone());
            }
        }
        PaneNode::Split { children, .. } => {
            for child in children {
                walk_tabs(child, project_id, out);
            }
        }
    }
}

/// AI 会话 tab 的 shellKind 集合(claudepane/codexpane 是自渲染版,claude/codex 是存量
/// xterm TUI 版——四者都能投递,见 `send_to_session` 的启动分支)。
const AI_SHELL_KINDS: [&str; 4] = ["claudepane", "claude", "codexpane", "codex"];

/// 递归收集 pane tree 里的 **AI 会话 tab**:`{id,title,shellKind,projectId}`。
///
/// 与 `sessions`(活跃会话,来自 AiBus 事件流)的区别:这里是 pane tree 的**全量**候选——
/// 进程没起的 tab 也在(重启后 / 从没启动过)。驿站投递的下拉列它:选中未启动的 tab 时
/// `send_to_session` 先启动(带历史续接)再发,不必回主窗口手动开会话。
fn walk_ai_tabs(node: &PaneNode, project_id: &str, out: &mut Vec<Value>) {
    match node {
        PaneNode::Pane { tabs, .. } => {
            for tab in tabs {
                if AI_SHELL_KINDS.contains(&tab.shell_kind.as_str()) {
                    out.push(json!({
                        "id": tab.id,
                        "title": tab.title,
                        "shellKind": tab.shell_kind,
                        "projectId": project_id,
                    }));
                }
            }
        }
        PaneNode::Split { children, .. } => {
            for child in children {
                walk_ai_tabs(child, project_id, out);
            }
        }
    }
}

/// 项目 pane tree 里某 tab 的 (shellKind, cwd)(不在树里/已关 → None)。
/// 启动未运行会话时用:决定起 claude 还是 codex,cwd 用 tab 自己的(回退项目根)。
fn tab_shell_meta(app: &AppHandle, project_id: &str, tab_id: &str) -> Option<(String, Option<String>)> {
    let state = app.try_state::<AppState>()?;
    let snap = state.inner.lock().ok()?;
    let project = snap.projects.iter().find(|p| p.id == project_id)?;
    let tree = project.pane_tree.as_ref()?;
    let mut found: Option<(String, Option<String>)> = None;
    fn walk(node: &PaneNode, tab_id: &str, found: &mut Option<(String, Option<String>)>) {
        if found.is_some() {
            return;
        }
        match node {
            PaneNode::Pane { tabs, .. } => {
                if let Some(t) = tabs.iter().find(|t| t.id == tab_id) {
                    *found = Some((t.shell_kind.clone(), t.cwd.clone()));
                }
            }
            PaneNode::Split { children, .. } => {
                for child in children {
                    walk(child, tab_id, found);
                }
            }
        }
    }
    walk(tree, tab_id, &mut found);
    found
}

/// 项目「当前打开」判定(2026-11-18 用户:「项目都没打开过,还给建议」→ 按 owner 窗口
/// 存活过滤;2026-11-19 二次收紧:main/workspace-N 是**多项目**窗口,切走的项目
/// owner_window 仍是 main 而 main 恒在,残留 pane tree 的 AI tab 照样进候选,用户仍见
/// 「没打开的项目」出建议)。口径 = ① owner 窗口存在;② 多项目窗口须为该窗口的
/// **active** 项目(main → active_project_id,workspace-N → workspace_active),单项目
/// 窗口(project-<id>)窗口在即打开;③ 不满足 ② 但项目里还有活着的 AI 进程
/// (claude/codex 注册表桶非空,用户口径「里面有 ai pane 运行」)也视为打开。
/// 窗口查询与两把注册表短锁均不碰 AppState 写向,持 AppState 锁调用无交叉风险。
fn project_is_open(app: &AppHandle, snap: &crate::state::AppSnapshot, project: &crate::state::ProjectRecord) -> bool {
    if app.get_webview_window(&project.owner_window).is_none() {
        return false;
    }
    let active_ok = if crate::windows::is_project_window(&project.owner_window) {
        true
    } else if project.owner_window == "main" {
        snap.active_project_id.as_deref() == Some(project.id.as_str())
    } else {
        snap.workspace_active.get(&project.owner_window).map(String::as_str) == Some(project.id.as_str())
    };
    if active_ok {
        return true;
    }
    // AI 进程活着 = 打开:切走项目 pane 卸载即杀进程,此路兜后台任务等边缘形态。
    if let Some(r) = app.try_state::<ClaudeRegistry>() {
        if let Ok(m) = r.by_project.lock() {
            if m.get(&project.id).is_some_and(|b| !b.is_empty()) {
                return true;
            }
        }
    }
    if let Some(r) = app.try_state::<CodexRegistry>() {
        if let Ok(m) = r.by_project.lock() {
            if m.get(&project.id).is_some_and(|b| !b.is_empty()) {
                return true;
            }
        }
    }
    false
}

/// AppState 侧富化数据:存活 tab(title)+ 项目名表 + 打开中的项目集合。短锁只读。
/// live_tabs 键 = `projectId/tabId` 复合键(tabId 跨项目撞名)。tab 与项目集合都只收
/// **当前打开**的项目(见 [`project_is_open`]:窗口关了 tree 残留、多项目窗口切走的
/// 休眠项目同理,都不该进候选/触达);names 保持全量(富化显示用,拿不到才降级,
/// 不做窗口过滤)。
fn collect_live(app: &AppHandle) -> (HashMap<String, String>, HashMap<String, String>, HashSet<String>) {
    let mut tabs = HashMap::new();
    let mut names = HashMap::new();
    let mut open_ids = HashSet::new();
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(snap) = state.inner.lock() {
            for project in &snap.projects {
                names.insert(project.id.clone(), project.name.clone());
                if !project_is_open(app, &snap, project) {
                    continue;
                }
                open_ids.insert(project.id.clone());
                if let Some(tree) = &project.pane_tree {
                    walk_tabs(tree, &project.id, &mut tabs);
                }
            }
        }
    }
    (tabs, names, open_ids)
}

/// pane tree 全量 AI tab 的 owned 元组(tab_id, shell_kind, project_id, title)。
/// 供 auto_suggest 感知「开着但没发过消息」的 tab(sessions 只含事件流登记的有会话者,
/// 2026-11-16 用户报「有打开的只是没会话」被空检查挡住)。**必须在 ConductorState 锁外
/// 调用**(内部锁 AppState,与 collect_live 同侧,避免两把锁交叉)。只收当前打开的
/// 项目(见 [`project_is_open`]:2026-11-19 收紧——多项目窗口切走的休眠项目 tree
/// 残留,补 Idle 行会把幽灵 tab 带进候选)。
fn collect_ai_tabs(app: &AppHandle) -> Vec<(String, String, String, String)> {
    let mut out = Vec::new();
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(snap) = state.inner.lock() {
            for project in &snap.projects {
                if !project_is_open(app, &snap, project) {
                    continue;
                }
                if let Some(tree) = &project.pane_tree {
                    walk_ai_tabs_owned(tree, &project.id, &mut out);
                }
            }
        }
    }
    out
}

fn walk_ai_tabs_owned(node: &PaneNode, project_id: &str, out: &mut Vec<(String, String, String, String)>) {
    match node {
        PaneNode::Pane { tabs, .. } => {
            for tab in tabs {
                if AI_SHELL_KINDS.contains(&tab.shell_kind.as_str()) {
                    out.push((tab.id.clone(), tab.shell_kind.clone(), project_id.to_string(), tab.title.clone()));
                }
            }
        }
        PaneNode::Split { children, .. } => {
            for child in children {
                walk_ai_tabs_owned(child, project_id, out);
            }
        }
    }
}

/// 项目根路径(驿站投递到 codex 会话时作 cwd)。
fn project_root(app: &AppHandle, project_id: &str) -> Option<String> {
    let state = app.try_state::<AppState>()?;
    let snap = state.inner.lock().ok()?;
    snap.projects.iter().find(|p| p.id == project_id).map(|p| p.root_path.clone())
}

// ---------------------------------------------------------------- 快照 / 窗口

/// 全量状态卡(指挥窗 hydrate / 事件触发 refetch 共用)。返回 sessions(状态行)+
/// **projects(全量项目 id/name,驿站投递下拉用;随每次快照刷新,主窗口增删项目后
/// 指挥窗下次 refetch 即同步)** + inbox + decisions + attentionCount。副作用:
/// 1) 清理已不存在的 tab(tab 关了,状态失效)——会话表与触达表同步 prune;
/// 2) ack:`last_seen_ms` 推进到当前,此后已见事件不再计入徽标;
/// 3) 广播 ack 后计数(主窗口徽标同步清零)。
/// 返回 `attentionCount` 是 **ack 前** 口径——指挥窗首屏徽标与关窗前看到的计数一致。
#[tauri::command]
pub fn conductor_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
    conductor: State<'_, ConductorState>,
) -> Result<Value, String> {
    let now = now_ms();

    // 1) AppState 侧:存活 tab 集(title 富化)+ 项目名表 + **全量项目列表**(驿站投递
    //    下拉的数据源;全局口径,与 owner_window 无关——指挥台看得到所有项目)+
    //    **全量 AI 会话 tab**(投递的会话候选,含未启动的)。短锁只读。
    //    live_tabs 只收当前打开的项目(见 project_is_open:窗口关了 pane tree 残留,
    //    多项目窗口切走的休眠项目同理——prune 按全量 tree 口径剪不掉残留会话行,
    //    指挥窗与建议候选都会看到幽灵 tab);names/all 保持全量(下拉与富化是显示
    //    口径,不做窗口过滤)。
    let (mut live_tabs, project_names, all_projects, all_ai_tabs) = {
        let snap = state.inner.lock().map_err(|e| format!("state lock: {e}"))?;
        let mut tabs = HashMap::new();
        let mut names = HashMap::new();
        let mut all = Vec::new();
        let mut ai_tabs = Vec::new();
        for project in &snap.projects {
            names.insert(project.id.clone(), project.name.clone());
            all.push((project.id.clone(), project.name.clone()));
            if !project_is_open(&app, &snap, project) {
                continue;
            }
            if let Some(tree) = &project.pane_tree {
                walk_tabs(tree, &project.id, &mut tabs);
                walk_ai_tabs(tree, &project.id, &mut ai_tabs);
            }
        }
        (tabs, names, all, ai_tabs)
    };

    // 2) conductor 侧:prune → 计数 → ack → 快照行。短锁内完成同步操作即释放。
    let (pre_count, rows, inbox, decisions, memories, auto_approvals, brain_error, plans, pending_verdicts, tool_beats, stage_xp, disk) = {
        let mut data = conductor
            .0
            .lock()
            .map_err(|e| format!("conductor lock: {e}"))?;
        // tab 已从 pane tree 消失 → 会话/触达记录一并失效(懒 GC,不靠定时器)。
        data.sessions.retain(|tab_id, _| live_tabs.contains_key(tab_id));
        data.touches.retain(|tab_id, _| live_tabs.contains_key(tab_id));
        let pre_count = attention_count(&data);
        data.last_seen_ms = now;
        let mut rows: Vec<SessionStatus> = data.sessions.values().cloned().collect();
        for row in &mut rows {
            if let Some(title) = live_tabs.remove(&super::skey(&row.project_id, &row.tab_id)) {
                row.tab_title = title;
            }
            if let Some(name) = project_names.get(&row.project_id) {
                row.project_name = name.clone();
            }
        }
        rows.sort_by(|a, b| b.last_event_ms.cmp(&a.last_event_ms));
        let inbox = data.inbox.clone();
        let decisions: Vec<_> = data.decisions.iter().take(DECISIONS_SNAPSHOT).cloned().collect();
        let memories = data.memories.clone();
        // 代批流水(最近 20 条,新的在前):指挥窗概览显示「它自动批了什么」。
        let auto_approvals: Vec<_> = data.auto_approvals.iter().take(20).cloned().collect();
        let plans = data.plans.clone();
        // 运行中任务(2026-11-17 用户:「涌现流要展示运行中的任务」):每会话至多 1 条
        // 待验收记录 = 已投出正在跑的活,决策流顶部实时区数据源。
        let pending_verdicts = data.pending_verdicts.clone();
        // Agent 实况拍(2026-11-19,新的在前;记录化后导出扩到 80 = 前端归并 cap 同宽):
        // 实况大屏冷启动基线;之后增量走 conductor-tool-event,前端按 seq 归并。
        let tool_beats: Vec<_> = data.tool_beats.iter().rev().take(80).cloned().collect();
        // 实况 XP 总账(2026-11-19 记录化):跨重启累计的游戏进度权威值。
        let stage_xp = data.stage_xp;
        (pre_count, rows, inbox, decisions, memories, auto_approvals, data.last_brain_error.clone(), plans, pending_verdicts, tool_beats, stage_xp, snapshot_disk(&data))
    };
    // ack 水位落盘(失败不阻断快照,重启后徽标口径最多回退一次)。
    if let Err(e) = save_disk(&app, &disk) {
        log::warn!("conductor: persist last_seen failed: {e}");
    }

    // 3) ack 后重发计数(通常 0;并发新事件则带新值)——开指挥窗看一眼,主窗口徽标即清。
    let post_count = conductor.0.lock().map(|d| attention_count(&d)).unwrap_or(0);
    emit_event(&app, post_count, "attention");

    Ok(json!({
        "sessions": rows,
        "attentionCount": pre_count,
        // 全量项目(驿站投递下拉):指挥窗不再依赖 App.tsx 的 projects prop——
        // 那条路 hydrate 对 conductor 窗返回空(见 hydrate_window 注释),且是静态快照。
        "projects": all_projects
            .iter()
            .map(|(id, name)| json!({ "id": id, "name": name }))
            .collect::<Vec<_>>(),
        // 全量 AI 会话 tab(含未启动):驿站投递的会话候选,见 walk_ai_tabs。
        "tabs": all_ai_tabs,
        "inbox": inbox,
        "decisions": decisions,
        // 记忆条目(P2):记忆分区数据源(候选+已确认都在,前端分组渲染)。
        "memories": memories,
        // 代批流水(autopilot):自动批了哪些工具、哪些转人了人。
        "autoApprovals": auto_approvals,
        // 最近一次大脑失败原因(运行期;决策流空态直接显示,不再静默)。
        "lastBrainError": brain_error,
        // 编排计划(P3a;P3b 编排卡数据源)。
        "plans": plans,
        // 运行中任务(验收回环待验收记录):决策流顶部「运行中」实时区数据源。
        "pendingVerdicts": serde_json::to_value(&pending_verdicts).unwrap_or_default(),
        // Agent 实况拍(新的在前):左栏「Agent 实况」面板冷启动基线。
        "toolBeats": tool_beats,
        // 实况 XP 总账(前端 StageConsole 冷启动起步值)。
        "stageXp": stage_xp,
        "generatedMs": now,
    }))
}

/// Agent 实况拍只读拉取(2026-11-19,底部微条冷启动基线):最近 80 拍 + XP 总账,
/// 新的在前。与 `conductor_snapshot` 的区别 = **无 ack 副作用**——主窗口拉快照会
/// 推进徽标已读水位(等于替人「看了」),微条只需要拍数据,绝不碰水位/会话表。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageBeatsReadonly {
    pub beats: Vec<super::ToolBeat>,
    pub xp: u64,
}

#[tauri::command]
pub fn conductor_tool_beats(conductor: State<'_, ConductorState>) -> Result<StageBeatsReadonly, String> {
    let data = conductor
        .0
        .lock()
        .map_err(|e| format!("conductor lock: {e}"))?;
    Ok(StageBeatsReadonly {
        beats: data.tool_beats.iter().rev().take(80).cloned().collect(),
        xp: data.stage_xp,
    })
}

/// 打开(或复用)指挥窗。关闭语义是隐藏(CloseRequested → hide),常驻监控不随窗口
/// 开关中断;本命令对已存在的隐藏窗 `show + set_focus` 即回(隐藏窗只 set_focus 不显形)。
///
/// **必须 async**:Tauri 2 同步命令跑在主线程(事件循环线程),`WebviewWindowBuilder::build`
/// 需要向事件循环投递事件并等待结果 → 主线程自等死锁(整窗冻结,连 created 日志都不会出)。
/// async 命令跑在线程池,build 内部安全 dispatch 到主线程。同构先例:`open_project_window`。
#[tauri::command]
pub async fn open_conductor_window(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
) -> Result<String, String> {
    log::info!("open_conductor_window: invoked");
    if let Some(win) = app.get_webview_window(CONDUCTOR_WINDOW_LABEL) {
        let visible = win.is_visible().unwrap_or(false);
        log::info!("open_conductor_window: reuse existing window (visible={visible})");
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(CONDUCTOR_WINDOW_LABEL.to_string());
    }
    // 建窗(与项目窗口同款:decorations:false / visible:false,前端首帧 show_window 显形)。
    let saved = conductor.0.lock().ok().and_then(|data| data.window_bounds);
    let builder = WebviewWindowBuilder::new(
        &app,
        CONDUCTOR_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("txuyStudio Conductor")
    // v2 双栏工作台(2026-11-16)需要横向空间:默认 1180×780;旧版小窗(760×540 时代
    // 存的 bounds)一次性迁移到新默认——用户明确要「默认打开窗口更大」,旧小尺寸
    // 继续生效会让人觉得没改。width<900 视为旧默认存量,新调过的(>=900)照常恢复。
    .inner_size(1180.0, 780.0)
    .min_inner_size(680.0, 480.0)
    .decorations(false)
    .center()
    .visible(false);
    let win = builder.build().map_err(|e| {
        log::error!("open_conductor_window: build failed: {e}");
        e.to_string()
    })?;
    if let Some(bounds) = saved.filter(|b| b.maximized || b.width >= 900) {
        apply_saved_bounds(&win, bounds);
    }
    log::info!("open_conductor_window: created {}", win.label());
    Ok(CONDUCTOR_WINDOW_LABEL.to_string())
}

/// 指挥窗 bounds 持久化(前端防抖调用;落 conductor.json,不进 AppState)。
#[tauri::command]
pub fn save_conductor_window_bounds(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    bounds: WindowBounds,
) -> Result<(), String> {
    let disk = {
        let mut data = conductor
            .0
            .lock()
            .map_err(|e| format!("conductor lock: {e}"))?;
        // width==0 = 「仅最大化标志」条目:保留上次 normal 态 bounds,只更新标志。
        if bounds.width == 0 {
            match data.window_bounds.as_mut() {
                Some(b) => b.maximized = bounds.maximized,
                None => data.window_bounds = Some(bounds),
            }
        } else {
            data.window_bounds = Some(bounds);
        }
        snapshot_disk(&data)
    };
    save_disk(&app, &disk)
}

/// 打开(或复用)Agent 实况独立窗(2026-11-19,用户:「agent 实况单独窗口打开,内容
/// 更丰富」)。语义完全镜像 [`open_conductor_window`]:关闭 = 隐藏,复用即
/// show + set_focus;**必须 async**(同款主线程 build 死锁约束,见其注释)。
#[tauri::command]
pub async fn open_stage_window(app: AppHandle, conductor: State<'_, ConductorState>) -> Result<String, String> {
    log::info!("open_stage_window: invoked");
    if let Some(win) = app.get_webview_window(STAGE_WINDOW_LABEL) {
        let visible = win.is_visible().unwrap_or(false);
        log::info!("open_stage_window: reuse existing window (visible={visible})");
        // 复用即强制刷新 webview(2026-11-19 实证:隐藏窗在 dev 多轮前端重写后可能
        // 停在旧代码/僵死——用户「动也不动,明明走了命令行」,日志证明后端拍一直在
        // 出而窗无反应)。代价是重开闪一次 splash,换「内容永远新鲜」。
        let _ = win.eval("location.reload()");
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(STAGE_WINDOW_LABEL.to_string());
    }
    // 游戏台:默认 760×720;最小尺寸抬高(2026-11-19 用户:「设置最小宽度,内部 UI
    // 不被压缩」)——引擎舞台/4 图表横排在 900 以下会挤成一团,900×640 保布局成立。
    let saved = conductor.0.lock().ok().and_then(|data| data.stage_bounds);
    let builder = WebviewWindowBuilder::new(
        &app,
        STAGE_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("txuyStudio Agent Stage")
    .inner_size(760.0, 720.0)
    .min_inner_size(900.0, 640.0)
    .decorations(false)
    .center()
    .visible(false);
    let win = builder.build().map_err(|e| {
        log::error!("open_stage_window: build failed: {e}");
        e.to_string()
    })?;
    if let Some(bounds) = saved {
        apply_saved_bounds(&win, bounds);
    }
    log::info!("open_stage_window: created {}", win.label());
    Ok(STAGE_WINDOW_LABEL.to_string())
}

/// Agent 实况独立窗 bounds 持久化(前端防抖调用;落 conductor.json stage_bounds)。
#[tauri::command]
pub fn save_stage_window_bounds(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    bounds: WindowBounds,
) -> Result<(), String> {
    let disk = {
        let mut data = conductor
            .0
            .lock()
            .map_err(|e| format!("conductor lock: {e}"))?;
        // width==0 = 「仅最大化标志」条目:保留上次 normal 态 bounds,只更新标志。
        if bounds.width == 0 {
            match data.stage_bounds.as_mut() {
                Some(b) => b.maximized = bounds.maximized,
                None => data.stage_bounds = Some(bounds),
            }
        } else {
            data.stage_bounds = Some(bounds);
        }
        snapshot_disk(&data)
    };
    save_disk(&app, &disk)
}

// ---------------------------------------------------------------- 发送(决策卡/驿站共用)

/// 把文本作为用户消息发给目标 AI 会话。目标判定看 registry:claude 有 entry 走 claude
/// 长进程 stdin;codex 有 entry 走每轮 spawn(cwd = 项目根);都没有 → **按 pane tree 里
/// 该 tab 的 shellKind 启动后再发**(没运行中的会话也投得动,2026-11-12 用户要求):
/// - claude/claudepane → `start_claude_session`(`resume_session_id=None` 会自动读持久化的
///   `claude_tab_sessions[tabId]` 带 `--resume` 续接历史;**没有缓存就是全新会话**);
/// - codex/codexpane → `send_codex_message` 内部 `ensure_app_server` 自起进程(rid=None →
///   thread/start 新会话;进程重启后 registry 丢了 live id,同样开新 thread)。
/// shellKind 不是 AI 会话 / tab 已不在树里 → Err(调用方原样透传给前端)。
/// 失败(未启动/busy 等)原样透传给调用方,由前端提示。
pub(crate) async fn send_to_session(app: &AppHandle, project_id: &str, tab_id: &str, text: &str) -> Result<(), String> {
    let claude_state = app.state::<ClaudeRegistry>();
    let has_claude = claude_state
        .by_project
        .lock()
        .map_err(|e| format!("claude lock: {e}"))?
        .get(project_id)
        .map_or(false, |m| m.contains_key(tab_id));
    if has_claude {
        return crate::claude::commands::send_claude_message(
            app.clone(),
            claude_state.clone(),
            project_id.to_string(),
            tab_id.to_string(),
            text.to_string(),
            None,
            // 补发 user 事件(前端无乐观插入点,不补发消息流看不见)+ 不登记人触达
            // (机器投递,防占用锁/建议抑制被污染)。
            Some(uuid::Uuid::new_v4().to_string()),
            Some(false),
        )
        .await;
    }
    let codex_state = app.state::<CodexRegistry>();
    let has_codex = codex_state
        .by_project
        .lock()
        .map_err(|e| format!("codex lock: {e}"))?
        .get(project_id)
        .map_or(false, |m| m.contains_key(tab_id));
    if has_codex {
        return crate::codex::commands::send_codex_message(
            app.clone(),
            codex_state.clone(),
            project_id.to_string(),
            tab_id.to_string(),
            project_root(app, project_id),
            text.to_string(),
            None, // sandbox
            None, // permission
            None, // model
            None, // reasoning_effort
            None, // resume_session_id
            None, // new_session
            Some(uuid::Uuid::new_v4().to_string()), // 补发 user 事件(消息流可见)
            None, // provider_overrides
            Some(false), // human_touch:机器投递不登记人触达
        )
        .await;
    }

    // 都没启动:按 tab 的 shellKind 决定起哪个(查不到 = tab 已关或不是 AI 会话)。
    let Some((shell_kind, tab_cwd)) = tab_shell_meta(app, project_id, tab_id) else {
        return Err(format!("目标会话不存在或未启动:{project_id}/{tab_id}(tab 已关闭,或不是 AI 会话)"));
    };
    let cwd = tab_cwd.or_else(|| project_root(app, project_id));
    match shell_kind.as_str() {
        "claude" | "claudepane" => {
            log::info!(
                "conductor: target claude tab {tab_id} not running, starting (resume from persisted cache)"
            );
            crate::claude::commands::start_claude_session(
                app.clone(),
                claude_state.clone(),
                app.state::<AppState>(),
                project_id.to_string(),
                tab_id.to_string(),
                cwd,
                None, // permission_mode:默认 acceptEdits(权限模式不持久化,跟随默认)
                None, // allowed_tools
                None, // resume_session_id:None = 自动读 persisted 缓存续接;无缓存即全新会话
                None, // effort
                None, // model
                None, // add_dirs
                None, // settings_env:跟随全局供应商
            )
            .await?;
            crate::claude::commands::send_claude_message(
                app.clone(),
                claude_state,
                project_id.to_string(),
                tab_id.to_string(),
                text.to_string(),
                None,
                Some(uuid::Uuid::new_v4().to_string()), // 补发 user 事件
                Some(false),                            // human_touch:机器投递
            )
            .await
        }
        // codex:send 内部 ensure_app_server 会拉起进程,无需单独 start。
        "codex" | "codexpane" => {
            log::info!("conductor: target codex tab {tab_id} not running, send will ensure app-server");
            crate::codex::commands::send_codex_message(
                app.clone(),
                codex_state,
                project_id.to_string(),
                tab_id.to_string(),
                cwd,
                text.to_string(),
                None,
                None,
                None,
                None,
                None,
                None,
                Some(uuid::Uuid::new_v4().to_string()), // 补发 user 事件
                None,
                Some(false), // human_touch:机器投递
            )
            .await
        }
        other => Err(format!("目标 tab 不是 AI 会话(shellKind={other}),无法投递")),
    }
}

/// 中断目标 AI 会话当前轮(任务撤销链用,2026-11-17 用户:「涌现流关掉的卡/清空 =
/// 该任务不去执行,已执行的也中断」)。目标判定同 [`send_to_session`]:claude 走协议级
/// interrupt(stdin control_request,失败由 Err 透传,前端可回退 kill);codex 走
/// kill_codex(turn/interrupt 优先,失败杀进程,thread id 保留下轮续接)。会话没启动
/// → Ok(没有在跑的东西可断,静默成功)。
pub(crate) async fn interrupt_session(app: &AppHandle, project_id: &str, tab_id: &str) -> Result<(), String> {
    let claude_state = app.state::<ClaudeRegistry>();
    let has_claude = claude_state
        .by_project
        .lock()
        .map_err(|e| format!("claude lock: {e}"))?
        .get(project_id)
        .is_some_and(|m| m.contains_key(tab_id));
    if has_claude {
        return crate::claude::commands::interrupt_claude_turn(
            app.clone(),
            project_id.to_string(),
            tab_id.to_string(),
        )
        .await;
    }
    let codex_state = app.state::<CodexRegistry>();
    let has_codex = codex_state
        .by_project
        .lock()
        .map_err(|e| format!("codex lock: {e}"))?
        .get(project_id)
        .is_some_and(|m| m.contains_key(tab_id));
    if has_codex {
        return crate::codex::commands::kill_codex(
            app.clone(),
            codex_state,
            project_id.to_string(),
            tab_id.to_string(),
        )
        .await;
    }
    Ok(())
}

// ---------------------------------------------------------------- 驿站

/// 扔碎片进驿站(targets 可选:派活框存入时把草稿目标一并挂上,投递动作仍在驿站行进行)。
#[tauri::command]
pub fn conductor_inbox_add(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    text: String,
    project_id: Option<String>,
    targets: Option<Vec<InboxTarget>>,
    permission_ceiling: Option<permissions::Level>,
    acceptance: Option<String>,
) -> Result<InboxItem, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("内容为空".to_string());
    }
    // 验收标准可选:空白视为未填(只按目标意图验收)。
    let acceptance = acceptance.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    // 预挂目标:去重 + 滤空(与 dispatch 同口径);兼容字段同步末位目标,路由回填不冲突。
    let mut targets = targets.unwrap_or_default();
    targets.dedup_by(|a, b| a == b);
    targets.retain(|t| !t.project_id.is_empty() && !t.tab_id.is_empty());
    let compat_project = targets.last().map(|t| t.project_id.clone()).or(project_id);
    let compat_session = targets.last().map(|t| t.tab_id.clone());
    let item = InboxItem {
        id: uuid::Uuid::new_v4().to_string(),
        text,
        project_id: compat_project,
        session_id: compat_session,
        created_ms: now_ms(),
        status: InboxStatus::Pending,
        targets,
        repeat_minutes: None,
        repeat_enabled: false,
        next_run_ms: 0,
        dispatch_count: 0,
        last_dispatch_ms: 0,
        fail_streak: 0,
        permission_ceiling,
        acceptance,
    };
    let count;
    let disk = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        data.inbox.insert(0, item.clone());
        if data.inbox.len() > INBOX_CAP {
            data.inbox.truncate(INBOX_CAP);
        }
        count = attention_count(&data);
        snapshot_disk(&data)
    };
    save_disk(&app, &disk).map_err(|e| log::warn!("conductor: inbox persist failed: {e}")).ok();
    emit_event(&app, count, "inbox");
    Ok(item)
}

/// LLM 路由:判断碎片最相关的项目(总闸开才可用;失败/无法判断 = 交人手选)。
#[tauri::command]
pub async fn conductor_inbox_route(app: AppHandle, conductor: State<'_, ConductorState>, id: String) -> Result<Value, String> {
    // 总闸(路由是 LLM 环节)。
    {
        let data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        if !data.config.allow_orchestrator {
            return Err("总闸未开启:请手动选择项目后投递".to_string());
        }
    }
    // 取条目文本(短锁 clone);已路由的直接返回。
    let text;
    {
        let data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let item = data.inbox.iter().find(|i| i.id == id).ok_or_else(|| "条目不存在".to_string())?;
        if item.status != InboxStatus::Pending {
            return Err("条目已处理".to_string());
        }
        if let Some(pid) = &item.project_id {
            return Ok(json!({ "projectId": pid }));
        }
        text = item.text.clone();
    }
    // 候选 = AppState 全量项目(id|name)。
    let mut lines: Vec<String> = Vec::new();
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(snap) = state.inner.lock() {
            for p in &snap.projects {
                lines.push(format!("{}|{}", p.id, p.name));
            }
        }
    }
    if lines.is_empty() {
        return Err("无候选项目".to_string());
    }
    let candidate_lines = lines.join("\n");
    let routed = super::brain::route_fragment(&app, &text, &candidate_lines).await?;

    // 回填(仅当仍为空;并发手选优先)。
    let count;
    let disk = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        if let Some(item) = data.inbox.iter_mut().find(|i| i.id == id) {
            if item.project_id.is_none() {
                item.project_id = routed.clone();
            }
        }
        count = attention_count(&data);
        snapshot_disk(&data)
    };
    save_disk(&app, &disk).map_err(|e| log::warn!("conductor: inbox route persist failed: {e}")).ok();
    emit_event(&app, count, "inbox");
    Ok(json!({ "projectId": routed }))
}

/// 已执行条目重新入队(dispatched/done → pending):回到待处理队列,**不立即投**——
/// 同目标流水线会自动领取,也可稍后手动「立即执行」(2026-11-17 用户:「再次执行」
/// 是立即投,还缺「重新排队等流水线领」的入口,两者语义互补)。循环任务拒绝(到点
/// 自动重投);pending/queued 本来就在队列(queued 是等空闲自动补投,更近一层);
/// dismissed 是丢弃。dispatch_count/last_dispatch_ms 保留(历史留痕),fail_streak
/// 清零(人主动重启新一轮)。
#[tauri::command]
pub async fn conductor_inbox_requeue(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: String,
) -> Result<Value, String> {
    let count = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let Some(item) = data.inbox.iter_mut().find(|i| i.id == id) else {
            return Err("条目不存在".to_string());
        };
        if item.repeat_enabled {
            return Err("循环任务到点自动重投,无需重新入队".to_string());
        }
        match item.status {
            InboxStatus::Dispatched | InboxStatus::Done => {
                item.status = InboxStatus::Pending;
                item.fail_streak = 0;
            }
            InboxStatus::Pending => return Err("条目已在待处理队列".to_string()),
            InboxStatus::Queued => return Err("条目在排队补投中,等会话空闲自动投".to_string()),
            InboxStatus::Dismissed => return Err("条目已丢弃".to_string()),
        }
        let c = attention_count(&data);
        let disk = snapshot_disk(&data);
        drop(data);
        save_disk(&app, &disk).map_err(|e| log::warn!("conductor: inbox requeue persist failed: {e}")).ok();
        c
    };
    emit_event(&app, count, "inbox");
    Ok(json!({ "ok": true }))
}

/// 投递碎片到**目标列表**(多投,2026-11-13 用户要求「可以复制多投」——一条巡检指令
/// 同时发给多个项目的会话)。逐目标 guard 过闸:
/// - 占用锁内(人 N 分钟内碰过该目标)→ 该目标降级为建议卡(决策流确认),其余照投;
/// - 放行的目标逐个直调命令本体发送;至少一个成功 → 条目标 Dispatched,
///   `dispatch_count` 按成功目标数累计,循环条目重排下一轮;
/// - 全部失败 → 返回最后一个错误,条目状态不变(可重试)。
///
/// **可重复投递**(2026-11-12):Pending / Dispatched / Done 都允许再投;仅 Dismissed 拒绝。
#[tauri::command]
pub async fn conductor_inbox_dispatch(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: String,
    targets: Vec<InboxTarget>,
) -> Result<Value, String> {
    let now = now_ms();
    // 去重(同目标重复选了只投一次)。
    let mut targets = targets;
    targets.dedup_by(|a, b| a == b);
    targets.retain(|t| !t.project_id.is_empty() && !t.tab_id.is_empty());
    if targets.is_empty() {
        return Err("未选择投递目标".to_string());
    }
    let text;
    let allow: Vec<InboxTarget>;
    let mut downgraded = false;
    // P2c:条目带权限上限 → 随登记进 pending,任务终态自动收回。
    let ceiling: Option<permissions::Level>;
    // 排队补投(2026-11-17):全部目标被占用锁拦下 + `queue_when_occupied` 开 + 非循环
    // 条目 → 条目整体转 Queued(该会话空闲终态自动补投),不再降级建议卡。
    let queue_it: bool;
    {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let idx = data
            .inbox
            .iter()
            .position(|i| i.id == id)
            .ok_or_else(|| "条目不存在".to_string())?;
        if !is_dispatchable(data.inbox[idx].status) {
            return Err("条目已丢弃,不能再投递".to_string());
        }
        text = data.inbox[idx].text.clone();
        ceiling = data.inbox[idx].permission_ceiling;
        // 目标写回条目:重复投递/循环任务都按条目上存的目标走(循环器不重判)。
        // 兼容字段 project_id/session_id 同步末位目标(路由回填 / 降级卡展示用)。
        data.inbox[idx].targets = targets.clone();
        if let Some(last) = targets.last() {
            data.inbox[idx].project_id = Some(last.project_id.clone());
            data.inbox[idx].session_id = Some(last.tab_id.clone());
        }
        // 锁窗分钟数先取出来(format! 与 &mut data.decisions 同表达式借用冲突规避)。
        let lock_minutes = data.config.occupied_lock_minutes;
        // 先分拣放行/被占,再决定被占目标的去向(整体排队 or 逐个降级卡)。
        let mut occupied: Vec<&InboxTarget> = Vec::new();
        allow = targets
            .iter()
            .filter(|t| {
                match guard::check_dispatch(&data, &t.project_id, &t.tab_id, true, now) {
                    DispatchGate::Allow => true,
                    // 手动投递豁免总闸,理论上不会 GateClosed;防御性按占用处理。
                    DispatchGate::GateClosed | DispatchGate::Occupied { .. } => {
                        occupied.push(t);
                        false
                    }
                }
            })
            .cloned()
            .collect();
        // 排队只对「全部目标被占」生效:部分成功时条目已标 Dispatched,被占目标
        // 维持降级建议卡(条目级状态单值,不支持半排队半已投)。循环条目不排队。
        queue_it = !occupied.is_empty()
            && occupied.len() == targets.len()
            && data.config.queue_when_occupied
            && !data.inbox[idx].repeat_enabled;
        if !queue_it {
            for t in occupied {
                // 降级建议卡(同目标同文本已有卡则不重复建)。
                let dup = data.decisions.iter().any(|d| {
                    d.status == DecisionStatus::Proposed
                        && d.source == DecisionSource::InboxDowngrade
                        && d.target_session_id.as_deref() == Some(t.tab_id.as_str())
                        && d.text == text
                });
                if !dup {
                    push_decision(
                        &mut data.decisions,
                        DecisionRecord {
                            id: uuid::Uuid::new_v4().to_string(),
                            cycle_ms: now,
                            kind: DecisionKind::Suggestion,
                            summary: format!(
                                "孵化投递(目标被占用,锁窗 {lock_minutes} 分钟)→ 转建议卡"
                            ),
                            text: text.clone(),
                            target_project_id: Some(t.project_id.clone()),
                            target_session_id: Some(t.tab_id.clone()),
                            payload: None,
                            used_memory_ids: Vec::new(),
                            source: DecisionSource::InboxDowngrade,
                            status: DecisionStatus::Proposed,
                            created_ms: now,
                        },
                    );
                }
                downgraded = true;
            }
        }
    }
    if allow.is_empty() {
        let count = {
            let mut data = conductor
                .0
                .lock()
                .map_err(|e| format!("conductor lock: {e}"))?;
            if queue_it {
                if let Some(item) = data.inbox.iter_mut().find(|i| i.id == id) {
                    item.status = InboxStatus::Queued;
                }
            }
            let c = attention_count(&data);
            let disk = snapshot_disk(&data);
            save_disk(&app, &disk)
                .map_err(|e| log::warn!("conductor: persist failed: {e}"))
                .ok();
            c
        };
        if queue_it {
            emit_event(&app, count, "inbox");
            // 会话此刻可能已空闲(AI 早已答完,只是人触达还在锁窗内)→ 立即试补投;
            // 仍忙则静默返回,等空闲终态钩子。串行/失败口径见 dispatch_queued。
            if let Some(t) = targets.first() {
                super::pipeline::dispatch_queued(&app, &t.project_id, &t.tab_id).await;
            }
            return Ok(json!({ "dispatched": false, "queued": true, "okCount": 0, "failCount": 0 }));
        }
        emit_event(&app, count, "decision");
        return Ok(json!({ "dispatched": false, "downgraded": true, "okCount": 0, "failCount": 0 }));
    }

    // 逐目标发送(锁外 await);单个失败不阻断其余目标。
    let mut ok_count = 0u32;
    let mut fail_count = 0u32;
    let mut last_err = String::new();
    let mut ok_targets: Vec<InboxTarget> = Vec::new();
    for t in &allow {
        match send_to_session(&app, &t.project_id, &t.tab_id, &text).await {
            Ok(()) => {
                ok_count += 1;
                ok_targets.push(t.clone());
            }
            Err(e) => {
                fail_count += 1;
                last_err = e;
            }
        }
    }
    if ok_count == 0 {
        return Err(format!("投递全部失败({fail_count} 个目标):{last_err}"));
    }
    // 至少一个成功 → 条目标 Dispatched + 按成功数累计 + 循环条目重排下一轮 + 落盘。
    // 验收回环:每个**成功**目标登记待验收(goal = 条目文本 + 验收标准;失败目标没收到活,不登记)。
    let disk = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let acceptance = data.inbox.iter().find(|i| i.id == id).and_then(|i| i.acceptance.clone());
        if let Some(item) = data.inbox.iter_mut().find(|i| i.id == id) {
            item.status = InboxStatus::Dispatched;
            item.dispatch_count += ok_count;
            item.last_dispatch_ms = now;
            item.fail_streak = 0;
            schedule_next(item, now);
        }
        for t in &ok_targets {
            // 静音项目豁免登记(感知链关闭,终态钩子不跑,登记成幽灵)。
            if !super::is_muted(&data, &t.project_id) {
                super::register_verdict_locked(&mut data, &t.project_id, &t.tab_id, &text, 0, ceiling, acceptance.as_deref());
            }
        }
        snapshot_disk(&data)
    };
    save_disk(&app, &disk).map_err(|e| log::warn!("conductor: inbox persist failed: {e}")).ok();
    if fail_count > 0 {
        log::warn!("conductor: dispatch partial failure ({fail_count} target(s)): {last_err}");
    }
    Ok(json!({ "dispatched": true, "downgraded": downgraded, "okCount": ok_count, "failCount": fail_count }))
}

/// 设置/清除循环任务。`minutes = None` 或 ≤0 = 关循环;否则 clamp 到 [1, 1440] 后启用。
/// 投递目标(project_id/tab_id)沿用条目上已选的值——循环到点就按它投,不重判。
#[tauri::command]
pub fn conductor_inbox_set_repeat(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: String,
    minutes: Option<u32>,
    enabled: Option<bool>,
) -> Result<Value, String> {
    let now = now_ms();
    let disk = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let item = data
            .inbox
            .iter_mut()
            .find(|i| i.id == id)
            .ok_or_else(|| "条目不存在".to_string())?;
        let on = enabled.unwrap_or(true);
        match minutes {
            Some(m) if m > 0 => {
                item.repeat_minutes = Some(m.clamp(REPEAT_MIN_MINUTES, REPEAT_MAX_MINUTES));
                item.repeat_enabled = on;
            }
            _ => {
                // 传 null / 0 = 关循环(保留间隔值,下次开不用重填)。
                item.repeat_enabled = false;
            }
        }
        if on && item.repeat_minutes.is_some() {
            // 目标没选齐,循环开不了(到点也没法投)——让人先选。
            // 兼容:老条目没有 targets 时看 project_id/session_id。
            if item.targets.is_empty()
                && (item.project_id.is_none() || item.session_id.is_none())
            {
                item.repeat_enabled = false;
                return Err("请先选择项目与会话,再开启循环".to_string());
            }
            // 已过期的排程(暂停了很久)立刻补一轮;否则从此刻重排。
            if item.next_run_ms <= now {
                schedule_next(item, now);
            }
        } else {
            item.next_run_ms = 0;
        }
        let count = attention_count(&data);
        (snapshot_disk(&data), count)
    };
    let (disk, count) = disk;
    save_disk(&app, &disk)?;
    emit_event(&app, count, "inbox");
    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------- 循环任务

/// 到期待投的循环条目(锁内收集,锁外发送;持锁不跨 await)。
/// 多投(2026-11-13):targets 全量展开,一轮逐目标投。
#[derive(Clone)]
struct RepeatDue {
    id: String,
    text: String,
    targets: Vec<InboxTarget>,
    /// 循环间隔(分钟;随投递事件带给前端做 chip 的自动熄灭 TTL)。
    minutes: u32,
}

/// 启动循环器(常驻 tokio task,`conductor::install` 调一次)。
///
/// 语义(2026-11-12 用户要求「可以是一个定时的循环的任务」):
/// - 每条驿站条目可设间隔(1..1440 分钟),到点按**已选目标列表**自动重投,文本原样;
/// - 闸门走「手动档」`check_dispatch(manual=true)`:**豁免总闸**——循环是人明确设定的
///   定时行为,不是 LLM 自发的;否则没开总闸时循环静默不跑很反直觉。占用锁照查:
///   人正在用的会话这轮跳过(不产建议卡,避免每轮刷屏),下个周期再试;
/// - 连续失败 ≥3 轮自动停循环(目标 tab 已消失等),并广播事件让指挥窗 refetch。
pub fn spawn_repeat_loop(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(REPEAT_TICK).await;
            run_repeat_due(&app).await;
        }
    });
}

/// 条目的有效目标(targets 优先;老条目回退兼容字段 project_id/session_id)。
fn effective_targets(item: &InboxItem) -> Vec<InboxTarget> {
    if !item.targets.is_empty() {
        return item.targets.clone();
    }
    match (&item.project_id, &item.session_id) {
        (Some(p), Some(t)) if !p.is_empty() && !t.is_empty() => {
            vec![InboxTarget { project_id: p.clone(), tab_id: t.clone() }]
        }
        _ => Vec::new(),
    }
}

/// 单轮扫描:收集到期条目 → 逐条过闸发送 → 更新排程与计数。
/// 验收回环**不登记**:循环条目(巡检/催报类)按分钟级反复投递,逐轮验收会把大脑
/// 调用翻倍;验收语义留给「一次一条目标」的派活(手动 dispatch / 决策卡发送 / fleet 首条)。
async fn run_repeat_due(app: &AppHandle) {
    let now = now_ms();
    let due: Vec<RepeatDue> = {
        let Some(state) = app.try_state::<ConductorState>() else { return };
        let Ok(data) = state.0.lock() else { return };
        data.inbox
            .iter()
            .filter(|i| {
                i.repeat_minutes.is_some()
                    && i.repeat_enabled
                    && i.next_run_ms > 0
                    && now >= i.next_run_ms
            })
            .filter_map(|i| {
                let targets = effective_targets(i);
                if targets.is_empty() {
                    None
                } else {
                    Some(RepeatDue { id: i.id.clone(), text: i.text.clone(), targets, minutes: i.repeat_minutes.unwrap_or(0) })
                }
            })
            .collect()
    };
    if due.is_empty() {
        return;
    }

    for d in due {
        // 逐目标:占用锁(短锁,不跨 await)过滤 → 放行的逐个发送。
        // 豁免总闸的理由见 spawn_repeat_loop 文档;占用这轮跳过且不产卡。
        let allowed: Vec<InboxTarget> = {
            let Some(state) = app.try_state::<ConductorState>() else { continue };
            let Ok(data) = state.0.lock() else { continue };
            d.targets
                .iter()
                .filter(|t| {
                    !matches!(
                        guard::check_dispatch(&data, &t.project_id, &t.tab_id, true, now),
                        DispatchGate::Occupied { .. }
                    )
                })
                .cloned()
                .collect()
        };
        let mut ok_count = 0u32;
        let mut fail_count = 0u32;
        for t in &allowed {
            match send_to_session(app, &t.project_id, &t.tab_id, &d.text).await {
                Ok(()) => {
                    ok_count += 1;
                    // 目标 pane 标记「驿站循环中」chip(2026-11-13 用户报「pane 被循环投递
                    // 抢占 running/waiting 却无从停止」):投递成功即广播,前端 hook 按
                    // tabId 匹配亮 chip,提供一键关循环入口;minutes 供 chip 自动熄灭 TTL。
                    let _ = app.emit(
                        "conductor-repeat-fired",
                        serde_json::json!({ "tabId": t.tab_id, "itemId": d.id, "minutes": d.minutes }),
                    );
                }
                Err(e) => {
                    fail_count += 1;
                    log::warn!(
                        "conductor repeat: item {} -> {}/{} failed: {e}",
                        d.id,
                        t.project_id,
                        t.tab_id
                    );
                }
            }
        }
        log::info!(
            "conductor repeat: item {} round done (ok={ok_count}, fail={fail_count}, occupied={})",
            d.id,
            d.targets.len() - allowed.len()
        );
        // 结算:至少一个成功 → 本轮成功;全部目标都没投出(占用/失败)→ 计一轮失败。
        bump_round(app, &d.id, ok_count, fail_count > 0 || allowed.len() < d.targets.len(), now);
    }
    // 投递次数 / 下次时间变了,通知指挥窗 refetch。
    let count = app
        .try_state::<ConductorState>()
        .and_then(|s| s.0.lock().ok().map(|d| attention_count(&d)))
        .unwrap_or(0);
    emit_event(app, count, "inbox");
}

/// 单条循环条目的轮次结算(短锁)。`ok_count`>0 → 计数按它累加、清失败;否则若本轮
/// 有跳过/失败 → fail_streak++,连续 ≥3 轮自动停循环;循环仍开着就续排下一周期。
fn bump_round(app: &AppHandle, id: &str, ok_count: u32, had_trouble: bool, now: i64) {
    let Some(state) = app.try_state::<ConductorState>() else { return };
    let Ok(mut data) = state.0.lock() else { return };
    let Some(item) = data.inbox.iter_mut().find(|i| i.id == id) else { return };
    if ok_count > 0 {
        item.status = InboxStatus::Dispatched;
        item.dispatch_count += ok_count;
        item.last_dispatch_ms = now;
        item.fail_streak = 0;
    } else if had_trouble {
        item.fail_streak += 1;
        if item.fail_streak >= REPEAT_FAIL_STREAK_STOP {
            item.repeat_enabled = false;
            item.next_run_ms = 0;
            log::warn!(
                "conductor repeat: item {id} stopped after {} consecutive failed rounds",
                item.fail_streak
            );
        }
    }
    if item.repeat_enabled {
        schedule_next(item, now);
    }
    if let Err(e) = save_disk(app, &snapshot_disk(&data)) {
        log::warn!("conductor: repeat persist failed: {e}");
    }
}

/// 移除驿站条目。
#[tauri::command]
pub fn conductor_inbox_remove(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: String,
) -> Result<(), String> {
    let disk = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        data.inbox.retain(|i| i.id != id);
        snapshot_disk(&data)
    };
    save_disk(&app, &disk)
}

// ---------------------------------------------------------------- 决策卡

/// 决策卡动作(P2 扩)。suggestion 卡:accept/edit(发送)与 reject(触发纠偏提炼);
/// dispatch 卡:accept 走 [`conductor_dispatch_accept`](前端分派,本命令不建 worker);
/// ask_human 卡:ack(editedText=人所选答案,纯记录);memory_candidate 卡:ack=确认
/// (前端先调 conductor_memory_confirm,再 ack 关卡)/reject=丢弃条目(前端调 delete)。
#[tauri::command]
pub async fn conductor_decision_respond(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: String,
    action: String,
    edited_text: Option<String>,
    permission_ceiling: Option<permissions::Level>,
) -> Result<Value, String> {
    let (send_text, target_project, target_tab, sending) = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let idx = data
            .decisions
            .iter()
            .position(|d| d.id == id)
            .ok_or_else(|| "决策卡不存在".to_string())?;
        if data.decisions[idx].status != DecisionStatus::Proposed {
            return Err("决策卡已处理".to_string());
        }
        match action.as_str() {
            "accept" | "edit" => {
                let text = if action == "edit" {
                    edited_text
                        .map(|t| t.trim().to_string())
                        .filter(|t| !t.is_empty())
                        .ok_or_else(|| "edit 需要非空 editedText".to_string())?
                } else {
                    data.decisions[idx].text.clone()
                };
                let project = data.decisions[idx]
                    .target_project_id
                    .clone()
                    .ok_or_else(|| "决策卡缺目标项目".to_string())?;
                let tab = data.decisions[idx]
                    .target_session_id
                    .clone()
                    .ok_or_else(|| "决策卡缺目标会话".to_string())?;
                (text, project, tab, true)
            }
            // P2:纯标记动作(不发送)。ask_human 的 answer 与 memory_candidate 的确认/丢弃
            // 由前端组合本动作与 memory 命令完成;editedText 有值则追加(人所选答案,保留原问题)。
            "ack" => {
                data.decisions[idx].status = DecisionStatus::Accepted;
                if let Some(t) = edited_text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                    let base = data.decisions[idx].text.clone();
                    data.decisions[idx].text = format!("{base} → [{t}]");
                }
                (String::new(), String::new(), String::new(), false)
            }
            "reject" => {
                // 纠偏提炼只对建议卡(§7:reject/edit 是「副官建议被否」信号);
                // memory_candidate 的 reject 是丢弃候选,语义不同,不提炼。
                if data.decisions[idx].kind == DecisionKind::Suggestion {
                    let original = data.decisions[idx].text.clone();
                    let edited = edited_text.clone();
                    let target_project = data.decisions[idx].target_project_id.clone();
                    let app2 = app.clone();
                    tauri::async_runtime::spawn(async move {
                        spawn_distill(&app2, &original, "reject", edited.as_deref(), target_project.as_deref()).await;
                    });
                }
                data.decisions[idx].status = DecisionStatus::Rejected;
                (String::new(), String::new(), String::new(), false)
            }
            other => return Err(format!("未知 action: {other}")),
        }
    };

    if sending {
        send_to_session(&app, &target_project, &target_tab, &send_text).await?;
        // 发送成功才标 Accepted(edit 记录实际发送文本,可审计)+ 记忆记账
        // (被采纳的建议所依据的记忆 hits+1——「被采纳的记忆才是好记忆」)。
        // edit(人改写后才采纳)→ 纠偏提炼:从「原建议 vs 改后」差异中提炼记忆候选。
        let mut distill_ctx: Option<(String, String, Option<String>)> = None;
        let mut verdict_reg: Option<(String, String, String, Option<permissions::Level>)> = None;
        let disk = {
            let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
            let used_ids: Vec<String> = data
                .decisions
                .iter()
                .find(|d| d.id == id)
                .map(|d| d.used_memory_ids.clone())
                .unwrap_or_default();
            if let Some(d) = data.decisions.iter_mut().find(|d| d.id == id) {
                if d.status == DecisionStatus::Proposed {
                    if action == "edit" && d.kind == DecisionKind::Suggestion {
                        distill_ctx = Some((d.text.clone(), send_text.clone(), d.target_project_id.clone()));
                    }
                    d.status = DecisionStatus::Accepted;
                    d.text = send_text.clone();
                    // 验收回环登记(goal = 实际发送文本):手动采纳/自动执行/降级卡
                    // 「直接发送」共用此路径,统一验收口径——conductor 经手的派活都验收。
                    // 静音项目豁免:感知链关闭后终态钩子不跑,登记了也成幽灵 pending。
                    if let (Some(project), Some(tab)) = (d.target_project_id.clone(), d.target_session_id.clone()) {
                        if !super::is_muted(&data, &project) {
                            verdict_reg = Some((project, tab, send_text.clone(), permission_ceiling));
                        }
                    }
                    let now = now_ms();
                    for entry in data.memories.iter_mut() {
                        if used_ids.contains(&entry.id) {
                            entry.hits += 1;
                            entry.last_used_ms = Some(now);
                        }
                    }
                }
            }
            if let Some((project, tab, goal, ceiling)) = verdict_reg {
                // 建议卡无验收标准来源(建议文本即目标),acceptance = None。
                super::register_verdict_locked(&mut data, &project, &tab, &goal, 0, ceiling, None);
            }
            let entries = data.memories.clone();
            drop(data);
            if !used_ids.is_empty() {
                if let Err(e) = memory::save(&app, &entries) {
                    log::warn!("conductor: memory hits persist failed: {e}");
                }
            }
            if let Some((original, edited, target_project)) = distill_ctx {
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    spawn_distill(&app2, &original, "edit", Some(&edited), target_project.as_deref()).await;
                });
            }
            conductor
                .0
                .lock()
                .map_err(|e| format!("conductor lock: {e}"))
                .map(|d| snapshot_disk(&d))?
        };
        save_disk(&app, &disk).map_err(|e| log::warn!("conductor: decision persist failed: {e}")).ok();
    } else {
        let disk = {
            let data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
            snapshot_disk(&data)
        };
        save_disk(&app, &disk).map_err(|e| log::warn!("conductor: decision persist failed: {e}")).ok();
    }
    let count = conductor.0.lock().map(|d| attention_count(&d)).unwrap_or(0);
    emit_event(&app, count, "decision");
    Ok(json!({ "ok": true }))
}

/// 删除决策卡(2026-11-16 用户:「副官动态可以手动删除」)。
/// `id = Some` 删单卡(任意状态);`id = None` 清空全部**已处理**卡
/// (proposed 未决卡不动——一键清不能把待办也清了);`all = true` 清空**全部**卡
/// (2026-11-16 用户:「决策流加个清空所有」,含 proposed——清空后大脑下次照常产新卡,
/// 只丢历史与未决待办,无业务副作用)。纯记录清理,无业务副作用
/// (不像 reject 会触发纠偏提炼);auto 已执行卡删了也不影响冷静窗(窗按 created_ms 判,
/// 删卡即放弃冷静约束,由大脑去重与 30min proposed 窗兜底)。
/// 删卡/清空(2026-11-17 语义升级:删卡 = **撤销**——该卡对应的任务不再执行,
/// 已投出在跑的一并中断):单删 `id` 撤该卡目标会话的任务;`all`=true 清空全部卡
/// 并撤销所有仍关联待验收的任务;id=None 清已处理卡(未决保留,2026-11-17 修正
/// 旧行为反删 Proposed 的文案颠倒)。
/// 撤销 = 清待验收记录(后续终态不再验收/自动返工/流水线推进)+ 关挂起验收卡 +
/// 关联编排计划 abort(未跑的步不再派)+ 中断目标会话当前轮。无任务关联(未投出/
/// 已结算)时行为与旧版纯清理一致。两段锁:abort 要在验收记录撤销**前**跑
/// (orchestrate::control 的 abort 从 live 待验收记录定位正在跑的会话并中断)。
#[tauri::command]
pub async fn conductor_decision_remove(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: Option<String>,
    all: Option<bool>,
) -> Result<Value, String> {
    // 锁一(只读 + 删卡):收集被删卡的目标会话,按「有无编排链接」分组。
    let (removed, plan_ids, direct_targets) = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let hit = |d: &DecisionRecord| match (&id, all.unwrap_or(false)) {
            (_, true) => true,
            (Some(i), _) => &d.id == i,
            // 2026-11-17 修正:文案一直说「清空已处理(未决保留)」,旧实现却删 Proposed
            // ——行为与文案颠倒,现对齐文案删已处理(Proposed 未决卡保留)。
            (None, _) => d.status != DecisionStatus::Proposed,
        };
        let mut plan_ids: Vec<String> = Vec::new();
        let mut direct: Vec<(String, String)> = Vec::new();
        for d in data.decisions.iter().filter(|d| hit(d)) {
            // 撤销只针对「该卡自己派出的任务还在执行链上」(2026-11-17 用户语义:
            // 关闭的卡 = 该任务不去执行/已执行的也中断)。两个同源条件:
            // ①卡已 Accepted(发送过;Proposed 未发送,删除 = 纯清理);
            // ②卡文本 = 该会话当前待验收任务原文(pv.goal 即派活发送文本)。
            // 此前只按目标会话匹配,同会话任何卡被删都会误 abort 进行中的拆步计划
            // (用户实测:关涌现流里别的卡,拆步被停)。
            if d.status != DecisionStatus::Accepted {
                continue;
            }
            if let (Some(pid), Some(tid)) = (&d.target_project_id, &d.target_session_id) {
                // 目标会话仍有同源待验收记录 = 该卡的任务在执行链上 → 撤销;其余(未投出/已结算)纯删。
                if let Some(pv) = data
                    .pending_verdicts
                    .iter()
                    .find(|p| &p.project_id == pid && &p.tab_id == tid && p.goal == d.text)
                {
                    match pv.plan_id.clone() {
                        Some(pl) if !plan_ids.contains(&pl) => plan_ids.push(pl),
                        Some(_) => {}
                        None => direct.push((pid.clone(), tid.clone())),
                    }
                }
            }
        }
        let before = data.decisions.len();
        if all.unwrap_or(false) {
            data.decisions.clear();
        } else {
            match id.as_deref() {
                Some(id) => data.decisions.retain(|d| d.id != id),
                // 与上方 hit 条件一致:删已处理、保留 Proposed(未决)。
                None => data.decisions.retain(|d| d.status == DecisionStatus::Proposed),
            }
        }
        (before - data.decisions.len(), plan_ids, direct)
    };
    // 锁外一:编排计划 abort(此时待验收记录还在,control 能定位并中断正在跑的步)。
    for pid in &plan_ids {
        if let Err(e) = orchestrate::control(&app, pid, "abort").await {
            log::warn!("conductor: decision remove abort plan {pid} failed: {e}");
        }
    }
    // 锁二(写):撤销所有被删卡目标的待验收记录 + 关挂起验收卡 + 落盘。
    let (disk, count) = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        // 有编排链接的目标:control abort 已把步置 Skipped,这里只需清验收记录;
        // 无链接的目标同样清(挂起验收卡一并过期)。
        let mut tabs: Vec<(String, String)> = direct_targets.clone();
        for pid in &plan_ids {
            for pv in data.pending_verdicts.iter().filter(|p| p.plan_id.as_deref() == Some(pid)) {
                tabs.push((pv.project_id.clone(), pv.tab_id.clone()));
            }
        }
        for (pid, tid) in &tabs {
            if data
                .pending_verdicts
                .iter()
                .any(|p| &p.project_id == pid && &p.tab_id == tid)
            {
                settle_verdict_locked(&mut data, pid, tid, None, None);
            }
        }
        (snapshot_disk(&data), attention_count(&data))
    };
    save_disk(&app, &disk).map_err(|e| log::warn!("conductor: decision persist failed: {e}")).ok();
    // 锁外二:无编排链接的目标直接中断会话当前轮(有链接的已在 control abort 内断)。
    for (pid, tid) in &direct_targets {
        if let Err(e) = interrupt_session(&app, pid, tid).await {
            log::warn!("conductor: decision remove interrupt {pid}/{tid} failed: {e}");
        }
    }
    emit_event(&app, count, "decision");
    Ok(json!({ "ok": true, "removed": removed, "cancelled": plan_ids.len() + direct_targets.len() }))
}

/// 撤销一个正在执行的任务(2026-11-17 用户:「涌现流关闭的卡/清空 = 该任务不去执行,
/// 已执行的也中断」;运行中实时区的 ✕ 走这里):撤该会话的待验收记录(后续终态不再
/// 验收/自动返工/流水线推进)、挂起验收卡过期;关联编排计划 abort(未跑的步不再派,
/// 正在跑的步由 abort 内部中断);无编排链接则直接中断会话当前轮。会话没在跑 →
/// 中断段静默跳过,其余照撤。幂等:无待验收记录时只返回 ok。
#[tauri::command]
pub async fn conductor_task_cancel(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    project_id: String,
    tab_id: String,
) -> Result<Value, String> {
    // 锁一(只读):待验收不存在 → 幂等直接回;有则取编排链接。
    let plan_id = {
        let data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        match data
            .pending_verdicts
            .iter()
            .find(|p| p.project_id == project_id && p.tab_id == tab_id)
        {
            None => return Ok(json!({ "ok": true, "cancelled": false })),
            Some(pv) => pv.plan_id.clone(),
        }
    };
    // 锁外一:有编排链接 → abort(control 从 live 待验收记录定位并中断正在跑的步)。
    if let Some(pid) = plan_id.as_deref() {
        if let Err(e) = orchestrate::control(&app, pid, "abort").await {
            log::warn!("conductor: task cancel abort plan {pid} failed: {e}");
        }
    }
    // 锁二(写):清验收记录 + 关挂起验收卡 + 落盘。
    let (disk, count) = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let disk = settle_verdict_locked(&mut data, &project_id, &tab_id, None, None);
        let count = attention_count(&data);
        (disk, count)
    };
    save_disk(&app, &disk).map_err(|e| log::warn!("conductor: task cancel persist failed: {e}")).ok();
    // 锁外二:无编排链接 → 直接中断会话当前轮。
    if plan_id.is_none() {
        if let Err(e) = interrupt_session(&app, &project_id, &tab_id).await {
            log::warn!("conductor: task cancel interrupt {project_id}/{tab_id} failed: {e}");
        }
    }
    emit_event(&app, count, "decision");
    Ok(json!({ "ok": true, "cancelled": true }))
}

/// 项目级指挥台开关(2026-11-16 用户:「不是每个决策都会走指挥台,可以根据项目去配置」)。
/// muted = true 加入黑名单(该项目的会话事件不进感知链:不出会话卡/不计徽标/不产建议/
/// 不验收/不代批),同时清掉该项目已积累的会话条目/尾部摘要/待验收记录(防幽灵 pending);
/// muted = false 恢复参与(会话态由后续事件流重建)。人手动投递/采纳/直发不受影响——
/// 用户主动行为照走,只是该项目不再登记验收。
#[tauri::command]
pub fn conductor_project_mute(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    project_id: String,
    muted: bool,
) -> Result<Value, String> {
    let (disk, count) = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        if muted {
            if !super::is_muted(&data, &project_id) {
                data.muted_projects.push(project_id.clone());
            }
            data.sessions.retain(|_, s| s.project_id != project_id);
            data.pending_verdicts.retain(|p| p.project_id != project_id);
            // tails 键是复合键:本项目会话已从 sessions 清出,其 tail 成孤儿,
            // 按「sessions 存活集」反查过滤(其余项目的 tail 键仍在 sessions)。
            let alive_tabs: std::collections::HashSet<String> =
                data.sessions.keys().cloned().collect();
            data.session_tails.retain(|tab, _| alive_tabs.contains(tab));
        } else {
            data.muted_projects.retain(|p| *p != project_id);
        }
        (snapshot_disk(&data), attention_count(&data))
    };
    save_disk(&app, &disk).map_err(|e| log::warn!("conductor: mute persist failed: {e}")).ok();
    emit_event(&app, count, "attention");
    Ok(json!({ "ok": true, "mutedProjects": disk.muted_projects }))
}

/// 纠偏提炼(spawn 内跑):总闸/degraded 检查 → LLM 提炼 → 建候选条目 + 候选卡。
/// 失败静默(提炼是增强,不阻断 reject 主流程);解析失败不重试(§5.6)。
/// `target_project` = 被拒建议的目标项目 id:LLM 判 scope=project 时落项目记忆,
/// 只注入该项目快照(项目级的纠偏不该污染别的项目)。
async fn spawn_distill(app: &AppHandle, original: &str, action: &str, edited: Option<&str>, target_project: Option<&str>) {
    {
        let Some(state) = app.try_state::<ConductorState>() else { return };
        let Ok(data) = state.0.lock() else { return };
        if !data.config.allow_orchestrator || now_ms() < data.brain_degraded_until_ms {
            return;
        }
    }
    // 项目名仅作 prompt 上下文(id 对 LLM 无意义);拿不到也无妨(global 判据不依赖)。
    let project_name = target_project.and_then(|pid| {
        let (_, names, _) = collect_live(app);
        names.get(pid).cloned()
    });
    let Ok(Some((kind, content, project_scoped))) =
        super::brain::distill_correction(app, original, action, edited, project_name.as_deref()).await
    else {
        return; // none(个案)或失败:均静默
    };
    let scopes = if project_scoped {
        target_project.map(|p| vec![p.to_string()]).unwrap_or_default()
    } else {
        Vec::new()
    };
    let entry = memory::new_entry(&kind, scopes, &content, "observed");
    let scope_note = match entry.scopes.first() {
        Some(pid) => format!(" · {}", project_name.clone().unwrap_or_else(|| pid.clone())),
        None => " · 个人".to_string(),
    };
    let record = DecisionRecord {
        id: uuid::Uuid::new_v4().to_string(),
        cycle_ms: now_ms(),
        kind: DecisionKind::MemoryCandidate,
        summary: format!("记忆候选({kind}{scope_note})· 纠偏提炼"),
        text: entry.content.clone(),
        target_project_id: None,
        target_session_id: None,
        payload: Some(json!({ "entryId": entry.id, "kind": entry.kind })),
        used_memory_ids: Vec::new(),
        source: DecisionSource::Brain,
        status: DecisionStatus::Proposed,
        created_ms: now_ms(),
    };
    let state = app.state::<ConductorState>();
    let Ok(mut data) = state.0.lock() else { return };
    data.memories.push(entry);
    let entries = data.memories.clone();
    drop(data);
    if let Err(e) = memory::save(app, &entries) {
        log::warn!("conductor: memory persist failed: {e}");
    }
    commit_decision(app, record);
}

// ---------------------------------------------------------------- 大脑触发

/// 快照行组装(`provider|projectId/项目名|会话|语义态|附言`)。第二列带真 id:
/// 模型只看显示名时只能猜 slug,严格校验当幻觉毙掉(2026-11-16 实测 projectId 回
/// `znyw-gis-udp` 与内部 id 对不上,决策流零产出)。
fn snapshot_line(s: &SessionStatus, project_names: &HashMap<String, String>, live_tabs: &HashMap<String, String>) -> String {
    let name = project_names.get(&s.project_id).cloned().unwrap_or_default();
    let project = if name.is_empty() { s.project_id.clone() } else { format!("{}/{}", s.project_id, name) };
    let tab = live_tabs
        .get(&super::skey(&s.project_id, &s.tab_id))
        .cloned()
        .unwrap_or_else(|| if s.tab_title.is_empty() { s.tab_id.clone() } else { s.tab_title.clone() });
    format!(
        "{}|{}|{}|{}|{}",
        s.provider,
        project,
        tab,
        s.kind.as_str(),
        s.detail.clone().unwrap_or_default()
    )
}

/// 大脑建议(自动触发[终态事件]与手动触发共用;总闸/degraded/去重在此统一检查)。
/// 产卡仅入决策流,**永不自动投递**——发送一律经人在决策卡上 accept/edit。
///
/// 返回值(2026-11-16 修「测试按钮假成功」):Ok = 结果描述(含「无值得建议/去重跳过」
/// 这类正常不出卡的原因),Err = 为什么没跑成(总闸/degraded/无会话/端点未配…)。
/// 自动触发方(events 终态钩子 / brain_loop)忽略返回值,手动触发方原样透给用户。
/// `target` = `(项目, tab)`;项目 None = 只按 tab 匹配(手动测试入口无项目上下文)。
pub async fn auto_suggest(
    app: AppHandle,
    target_tab: Option<(Option<String>, String)>,
    source: DecisionSource,
) -> Result<String, String> {
    let now = now_ms();
    let (live_tabs, project_names, open_projects) = collect_live(&app);
    // pane tree 全量 AI tab(含未启动/没发过消息的):快照补 Idle 行 + sessionId 校验放宽用。
    let tree_tabs = collect_ai_tabs(&app);

    // 锁内:总闸/degraded/快照行/target/去重/记忆注入;所有需要跨 await 的数据在此克隆。
    let trigger_line;
    let snapshot_lines;
    let projects: Vec<(String, String)>;
    let memory: memory::GroupedMemory;
    let (target_project, target_session);
    {
        let state = match app.try_state::<ConductorState>() {
            Some(s) => s,
            None => return Err("conductor state missing".to_string()),
        };
        let data = match state.0.lock() {
            Ok(d) => d,
            Err(_) => return Err("conductor lock".to_string()),
        };
        // 总闸(手动测试同查——总闸语义是「LLM 环节全不出」)。
        if !data.config.allow_orchestrator {
            return Err("总闸未开启:先在设置分区打开 allowOrchestrator".to_string());
        }
        if now < data.brain_degraded_until_ms {
            let secs = ((data.brain_degraded_until_ms - now) / 1000).max(1);
            return Err(format!("智核退避中(连续失败自护),约 {secs}s 后自动恢复;可改配置立即重试"));
        }
        if data.sessions.is_empty() && tree_tabs.is_empty() {
            return Err("没有任何打开中的 AI 会话 tab:在打开的项目里开一个 claude/codex pane 后即可出建议(不必先发消息)".to_string());
        }
        // 快照行 = 事件流会话 + pane tree 里开着但没发过消息的 AI tab(补 Idle 行,
        // last_event_ms=0 排序垫底;投递对未启动 tab 会先启动再发,链路是通的)。
        // 项目级静音过滤(2026-11-18 用户:「没允许的 ai 项目,就别给建议了」):events
        // 帧层已拦 mute 项目(不出会话卡),但 pane tree 补 Idle 行会把静音项目开着的
        // AI tab 带进候选——5min 大脑兜底轮 auto_suggest(None) 全局挑目标曾因此对
        // 静音项目莫名出建议。sessions 行一并过滤(状态恢复/mute 后设置残留防御)。
        // 项目打开过滤(2026-11-18 用户:「项目都没打开过,还给建议」;2026-11-19 收紧
        // 到 active 项目或仍有 AI 进程,见 project_is_open):窗口关了/多项目窗口切走了,
        // pane tree 与 sessions 行都残留(进程已 kill,事件不再来,懒 GC 用的也是 tree
        // 口径剪不掉)——候选统一只认当前打开的项目。
        // 项目建议白名单(2026-11-23 用户:「对涌现的建议,针对项目级别加开关,不要
        // 动不动就给建议」):Brain 源常规轮(5min 兜底 + 终态钩子)只对白名单内项目
        // 出建议,空表 = 默认全安静;Manual「测试大脑」豁免——人主动点就是要看。
        let gate_suggest = source == DecisionSource::Brain;
        let suggest_on = |pid: &str| data.config.suggest_projects.iter().any(|p| p == pid);
        let mut rows: Vec<SessionStatus> = data
            .sessions
            .values()
            .filter(|s| {
                open_projects.contains(&s.project_id)
                    && !super::is_muted(&data, &s.project_id)
                    && (!gate_suggest || suggest_on(&s.project_id))
            })
            .cloned()
            .collect();
        for (tab_id, shell_kind, project_id, _title) in &tree_tabs {
            if super::is_muted(&data, project_id) {
                continue;
            }
            if gate_suggest && !suggest_on(project_id) {
                continue;
            }
            if !data.sessions.contains_key(&super::skey(project_id, tab_id)) {
                rows.push(SessionStatus {
                    tab_id: tab_id.clone(),
                    provider: if shell_kind.starts_with("codex") { "codex" } else { "claude" }.to_string(),
                    project_id: project_id.clone(),
                    project_name: String::new(),
                    tab_title: String::new(),
                    kind: super::SessionKind::Idle,
                    detail: Some("tab 已打开,尚无会话".to_string()),
                    last_event_ms: 0,
                });
            }
        }
        rows.sort_by(|a, b| b.last_event_ms.cmp(&a.last_event_ms));
        rows.truncate(40);
        snapshot_lines = rows
            .iter()
            .map(|s| snapshot_line(s, &project_names, &live_tabs))
            .collect::<Vec<_>>()
            .join("\n");
        // target:显式指定 → 优先;否则 waiting_approval/error 优先,再退最新一行。
        // 指定但不在候选(窗口关了/被静音)→ 直接报错,不落全局兜底(2026-11-18:
        // 终态钩子指定 tab 时窗口刚被关,全局兜底会挑个不相干的会话瞎建议)。
        let target = target_tab.as_ref().and_then(|(tp, t)| {
            rows.iter()
                .find(|s| s.tab_id == *t && tp.as_deref().map_or(true, |p| s.project_id == p))
                .map(|s| (t.to_string(), s.clone()))
        });
        if target.is_none() && target_tab.is_some() {
            return Err("目标会话不在候选(项目窗口未开/被静音/项目建议未开),不出建议".to_string());
        }
        let target = target
            .or_else(|| {
                rows.iter()
                    .find(|s| s.kind == super::SessionKind::WaitingApproval || s.kind == super::SessionKind::Error)
                    .map(|s| (s.tab_id.clone(), s.clone()))
            })
            .or_else(|| rows.first().map(|s| (s.tab_id.clone(), s.clone())));
        let Some((target_id, target_row)) = target else {
            return Err("找不到建议目标会话".to_string());
        };
        // 同会话串行(2026-11-17 用户:拆步执行中常规建议又跑出来):目标会话仍在任务
        // 执行链上(有待验收记录 = 派活/拆步步在跑;或有进行中计划)→ 常规建议让位。
        // 终态钩子路径本有 verdict_taken 互斥,这里兜住两个洞:5min 大脑兜底轮
        // (auto_suggest(None) 全局挑目标),以及 waiting_approval 优先规则把卡审批的
        // 拆步会话挑中(静默窗拦不住——拆步是机器投递不登记人触达)。验收链自身会
        // 产出「下一步」(返工/推进/续段卡),再叠常规建议 = 机器塞话打断拆步轮次。
        if data.pending_verdicts.iter().any(|p| {
            p.project_id == target_row.project_id && p.tab_id == *target_id
        }) || data.plans.iter().any(|p| {
            p.target.project_id == target_row.project_id
                && p.target.tab_id == *target_id
                && matches!(
                    p.status,
                    orchestrate::PlanStatus::Running | orchestrate::PlanStatus::Paused
                )
        }) {
            return Ok("目标在任务执行链上(拆步/派活执行中),跳过常规建议".to_string());
        }
        // 去重:同目标同来源已有未决卡(30min 窗口)→ 不重产。
        if data.decisions.iter().any(|d| {
            d.status == DecisionStatus::Proposed
                && d.source == source
                && d.created_ms > now - SUGGEST_DEDUP_MS
                && d.target_session_id.as_deref() == Some(target_id.as_str())
        }) {
            return Ok("该目标 30min 内已有未决建议卡(去重),未重复产卡".to_string());
        }
        // 人正在用的会话不出常规建议(2026-11-17 用户:「不是每个任务都需要建议卡」):
        // 目标触达在占用锁窗内 = 人正手动驱动这个 pane,终态不需要副官插话——与人手
        // 发任务每次跑完都出一张卡的噪音直接相关。conductor 投递不登记触达
        // (human_touch=false),无人值守任务的终态照常建议。Manual 源(设置里的
        // 「测试大脑」)不受此拦——人主动点就是要看它出什么。
        if source == DecisionSource::Brain {
            if let Some(t) = data
                .touches
                .get(&super::skey(&target_row.project_id, &target_id))
                .copied()
            {
                if t > 0 {
                    // 建议静默窗(软闸,独立于占用锁):管出卡噪音,默认远短于占用锁。
                    let quiet_ms = (data.config.suggest_quiet_minutes * 60_000) as i64;
                    let ago = now - t;
                    if ago >= 0 && ago < quiet_ms {
                        return Ok("人正在使用该会话(触达新鲜),跳过常规建议".to_string());
                    }
                }
            }
        }
        trigger_line = snapshot_line(&target_row, &project_names, &live_tabs);
        target_project = target_row.project_id.clone();
        target_session = target_id;
        // 目标候选表(id, name):sessions + 未启动 tab 的项目,去重保序;
        // parse_suggest 用它校验 projectId 并规范化为真 id(名字/slug 反查)。
        let mut seen = HashSet::new();
        projects = data
            .sessions
            .values()
            .map(|s| s.project_id.clone())
            .chain(tree_tabs.iter().map(|(_, _, p, _)| p.clone()))
            .filter(|p| seen.insert(p.clone()))
            .map(|id| {
                let name = project_names.get(&id).cloned().unwrap_or_default();
                (id, name)
            })
            .collect();
        // 记忆注入(§6:confirmed 且 scope 匹配快照项目;分层——个人 cap 15 +
        // 项目 cap 20 单项目 ≤8,见 pick_injectable)。
        let project_ids: Vec<String> = projects.iter().map(|(id, _)| id.clone()).collect();
        memory = memory::pick_injectable(&data.memories, &project_ids);
    } // 锁释放,以下 await 不持锁

    let decision = super::brain::decide(&app, &snapshot_lines, &trigger_line, &projects, &memory).await;
    // 产卡种类(回给手动触发方做结果文案;None = 大脑判断无事可做)。
    let mut produced: Option<&'static str> = None;
    match decision {
        Ok(brain_decision) => {
            let used_memory_ids = brain_decision.used_memory_ids.clone();
            match brain_decision.intent {
        BrainIntent::SuggestNext { project_id, session_id, text } => {
            // sessionId 必须真实存在:编造 → 项目与会话一起落回触发会话
            // (避免项目是 A、回退会话是 B 的跨项目错配)。
            let (project, session, auto_exec) = {
                let state = app.state::<ConductorState>();
                let data = match state.0.lock() {
                    Ok(d) => d,
                    Err(_) => return Err("conductor lock".to_string()),
                };
                let (p, s) = match session_id {
                    // 未启动 tab 也是合法目标(快照里有它的 Idle 行,投递会先启动再发)。
                    Some(ref sid)
                        if data.sessions.contains_key(&super::skey(&project_id, sid))
                            || tree_tabs
                                .iter()
                                .any(|(t, _, p, _)| p == &project_id && t == sid) =>
                    {
                        (project_id, sid.clone())
                    }
                    _ => (target_project.clone(), target_session.clone()),
                };
                // 自动执行判定(2026-11-16 用户:「副官动态能自主去执行,而不是每次手动」):
                // 配置开 + Brain 源 + 占用锁放行(人正用的会话不自动插话,卡转人审)+
                // 同目标 30min 无自动执行记录(冷静窗防自驱死循环——自动派活→会话跑完
                // 终态→再触发建议→再派活的连环套,每目标每窗至多一发)。
                let auto_exec = data.config.auto_execute_suggestions
                    && source == DecisionSource::Brain
                    && matches!(
                            guard::check_dispatch(&data, &p, &s, false, now),
                            DispatchGate::Allow
                        )
                    && !data.decisions.iter().any(|d| {
                        d.created_ms > now - SUGGEST_DEDUP_MS
                            && d.status == DecisionStatus::Accepted
                            && d.target_session_id.as_deref() == Some(s.as_str())
                            && d.payload
                                .as_ref()
                                .and_then(|p| p.get("auto"))
                                .and_then(|v| v.as_bool())
                                == Some(true)
                    });
                (p, s, auto_exec)
            };
            let record_id = uuid::Uuid::new_v4().to_string();
            let record = DecisionRecord {
                id: record_id.clone(),
                cycle_ms: now,
                kind: DecisionKind::Suggestion,
                summary: format!(
                    "建议 → {} / {}",
                    project_names.get(&project).cloned().unwrap_or_else(|| project.clone()),
                    live_tabs
                        .get(&super::skey(&project, &session))
                        .cloned()
                        .unwrap_or_else(|| session.clone())
                ),
                text,
                target_project_id: Some(project),
                target_session_id: Some(session),
                // auto 标记:前端徽标 + 冷静窗判据(payload 对 suggestion 本无载荷,借位)。
                payload: if auto_exec { Some(json!({ "auto": true })) } else { None },
                used_memory_ids,
                source,
                status: DecisionStatus::Proposed,
                created_ms: now,
            };
            commit_decision(&app, record);
            if auto_exec {
                // 直接代发:与人点「直接发送」同一条 accept 路径(send_to_session 未启动
                // tab 会先拉起);失败卡留 proposed 转人审,不丢线索。
                let state = app.state::<ConductorState>();
                let outcome = conductor_decision_respond(
                    app.clone(),
                    state,
                    record_id,
                    "accept".to_string(),
                    None,
                    None, // 自动执行无人选上限:不限制(P2c 上限是人派活时的选择)。
                )
                .await;
                produced = Some(match outcome {
                    Ok(_) => "建议(已自动执行)",
                    Err(_) => "建议(自动执行失败,卡留待人工处理)",
                });
            } else {
                produced = Some("建议");
            }
        }
        BrainIntent::DispatchTask { project_id, task_text, provider } => {
            // fleet 联动确认卡(§4):taskId 自动生成(人可在卡上改),provider 缺省 claude。
            // accept 才真正 create_fleet_worker;丢弃无副作用。
            let task_id = format!("c-{}", &uuid::Uuid::new_v4().to_string()[..6]);
            let provider = provider.unwrap_or_else(|| "claude".to_string());
            let record = DecisionRecord {
                id: uuid::Uuid::new_v4().to_string(),
                cycle_ms: now,
                kind: DecisionKind::Dispatch,
                summary: format!(
                    "派活 → {} / fleet worker",
                    project_names.get(&project_id).cloned().unwrap_or_else(|| project_id.clone())
                ),
                text: task_text,
                target_project_id: Some(project_id),
                target_session_id: None,
                payload: Some(json!({ "taskId": task_id, "provider": provider })),
                used_memory_ids,
                source,
                status: DecisionStatus::Proposed,
                created_ms: now,
            };
            commit_decision(&app, record);
            produced = Some("派活确认");
        }
        BrainIntent::AskHuman { question, options } => {
            let record = DecisionRecord {
                id: uuid::Uuid::new_v4().to_string(),
                cycle_ms: now,
                kind: DecisionKind::AskHuman,
                summary: "提问 → 需要人决策".to_string(),
                text: question,
                target_project_id: None,
                target_session_id: None,
                payload: Some(json!({ "options": options })),
                used_memory_ids,
                source,
                status: DecisionStatus::Proposed,
                created_ms: now,
            };
            commit_decision(&app, record);
            produced = Some("提问");
        }
        BrainIntent::Remember { kind, content, project_id } => {
            // remember 意图:直接建候选条目(confirmed:false)+ 候选卡;人确认才注入 prompt。
            // project_id 有值 = 项目级观察(只注入该项目快照);None = 用户个人偏好(全局)。
            let entry = memory::new_entry(&kind, project_id.clone().map(|p| vec![p]).unwrap_or_default(), &content, "observed");
            let entry_id = entry.id.clone();
            let entry_content = entry.content.clone();
            let entry_kind = entry.kind.clone();
            let scope_note = match &project_id {
                Some(pid) => format!(
                    " · {}",
                    project_names.get(pid).cloned().unwrap_or_else(|| pid.clone())
                ),
                None => " · 个人".to_string(),
            };
            let record = DecisionRecord {
                id: uuid::Uuid::new_v4().to_string(),
                cycle_ms: now,
                kind: DecisionKind::MemoryCandidate,
                summary: format!("记忆候选({entry_kind}{scope_note})"),
                text: entry_content,
                target_project_id: None,
                target_session_id: None,
                payload: Some(json!({ "entryId": entry_id, "kind": entry_kind })),
                used_memory_ids,
                source,
                status: DecisionStatus::Proposed,
                created_ms: now,
            };
            let state = app.state::<ConductorState>();
            if let Ok(mut data) = state.0.lock() {
                data.memories.push(entry);
                let entries = data.memories.clone();
                drop(data);
                if let Err(e) = memory::save(&app, &entries) {
                    log::warn!("conductor: memory persist failed: {e}");
                }
            }
            commit_decision(&app, record);
            produced = Some("记忆候选");
        }
        BrainIntent::None => log::debug!("conductor: brain judged no suggestion needed"),
            }
        }
        Err(e) => {
            log::warn!("conductor: auto_suggest failed: {e}");
            return Err(e);
        }
    }
    match produced {
        Some(kind) => Ok(format!("已生成{kind}卡,去涌现流分区查看")),
        None => Ok("智核判断当前无值得建议的事项".to_string()),
    }
}

// ---------------------------------------------------------------- 验收回环(自动驾驶一期)

/// 验收结算(锁内):清该 tab 的 pending + 关闭同 tab 的挂起卡(已被补判结果取代)+
/// 按需登记新 pending(返工链,rework_count 递增)。各 verdict 分支共用,保证
/// 「清账 / 关挂起卡 / 新登记」一次锁内原子完成。返回落盘壳(调用方锁外 save)。
fn settle_verdict_locked(
    data: &mut super::ConductorData,
    project_id: &str,
    tab_id: &str,
    new_pending: Option<(&str, &str, u32, Option<permissions::Level>, Option<&str>)>,
    plan_link: Option<(String, String)>,
) -> super::ConductorDisk {
    // pending 的判定权已在 auto_verdict 锁内原子取走(2026-11-18,防 brain 窗口内
    // 并发终态双判双卡)——验收落定路径调到这里时 pv 已删,retain 是空操作;撤销
    // 路径(decision_remove/task_cancel)pv 还在,靠这段 retain 清残留。rework
    // 续登记的 plan_link 从取走克隆传入(验收对象仍是同一步)+ 挂起卡清账。
    data.pending_verdicts
        .retain(|p| !(p.project_id == project_id && p.tab_id == tab_id));
    if let Some((reg_project, goal, rework_count, ceiling, acceptance)) = new_pending {
        super::register_verdict_locked(data, reg_project, tab_id, goal, rework_count, ceiling, acceptance);
        if let (Some(pv), Some((pid, sid))) = (
            data.pending_verdicts
                .iter_mut()
                .find(|p| p.project_id == project_id && p.tab_id == tab_id),
            plan_link,
        ) {
            pv.plan_id = Some(pid);
            pv.step_id = Some(sid);
        }
    }
    for d in data.decisions.iter_mut() {
        if d.kind == DecisionKind::Verdict && d.status == DecisionStatus::Proposed {
            let is_pending_card = d.kind == DecisionKind::Verdict
                && d.status == DecisionStatus::Proposed
                && d.payload
                    .as_ref()
                    .and_then(|p| p.get("verdict"))
                    .and_then(|v| v.as_str())
                    == Some("pending")
                && d.target_project_id.as_deref() == Some(project_id)
                && d.target_session_id.as_deref() == Some(tab_id);
            if is_pending_card {
                d.status = DecisionStatus::Expired;
            }
        }
    }
    snapshot_disk(data)
}

/// 验收不消费时回填判定登记(2026-11-18 原子取走的另一半):总闸关/大脑挂起/防御
/// 分支把 pending 原样放回,**保留原 dispatched_ms**——tail 任务期过滤起点不能被
/// 回填时刻污染(用 register_verdict_locked 会重置为 now,派活早期产出会被截掉)。
fn restore_verdict_locked(data: &mut super::ConductorData, pv: super::PendingVerdict) -> super::ConductorDisk {
    match data
        .pending_verdicts
        .iter_mut()
        .find(|p| p.project_id == pv.project_id && p.tab_id == pv.tab_id)
    {
        Some(p) => *p = pv,
        None => data.pending_verdicts.push(pv),
    }
    snapshot_disk(data)
}

/// 同 tab 是否已有未处理的挂起卡(大脑失败时防重复刷屏;人 dismiss 后再失败会再产)。
fn verdict_pending_card_exists(data: &super::ConductorData, project_id: &str, tab_id: &str) -> bool {
    data.decisions.iter().any(|d| {
        d.kind == DecisionKind::Verdict
            && d.status == DecisionStatus::Proposed
            && d.payload
                .as_ref()
                .and_then(|p| p.get("verdict"))
                .and_then(|v| v.as_str())
                == Some("pending")
            && d.target_project_id.as_deref() == Some(project_id)
            && d.target_session_id.as_deref() == Some(tab_id)
    })
}

/// 验收卡构造(succinct:各分支 summary/payload 不同,text 统一「目标+判定」)。
fn verdict_record(
    status: DecisionStatus,
    summary: String,
    text: String,
    payload: Value,
    project_id: &str,
    tab_id: &str,
) -> DecisionRecord {
    DecisionRecord {
        id: uuid::Uuid::new_v4().to_string(),
        cycle_ms: now_ms(),
        kind: DecisionKind::Verdict,
        summary,
        text,
        target_project_id: Some(project_id.to_string()),
        target_session_id: Some(tab_id.to_string()),
        payload: Some(payload),
        used_memory_ids: Vec::new(),
        source: DecisionSource::Brain,
        status,
        created_ms: now_ms(),
    }
}

/// 验收回环主链(自动驾驶一期):终态钩子先于常规建议调用。会话存在未验收的派活
/// 记录 → 大脑对照 goal 与会话产出三值判定:
/// - success → 清账,验收通过卡(已处理);
/// - failed → 清账留人审(失败往往是方向问题,不自动重试烧 token);
/// - rework → 占用锁放行且该目标链未自动返工过 → 返工指令自动代发 + 登记新 pending
///   (rework_count+1,同目标最多自动返工一次);否则降级为「建议返工」卡留人审。
/// 大脑不可用/解析失败 → 挂起卡 + pending 保留,下一次终态自动补判。
///
/// 返回 Ok(true) = 已走验收链(含挂起),调用方不再跑常规建议(验收本身产出下一步,
/// 再跑建议会自驱循环);Ok(false) = 无待验收记录,走常规 auto_suggest。
///
/// 返工**不走**常规建议的 30min 冷静窗:任务刚派发必在窗内,冷静窗是防「建议自驱」
/// 的;返工的一次性闸由 rework_count 承担(设计意图:防连环返工烧 token)。
pub async fn auto_verdict(
    app: AppHandle,
    project_id: String,
    tab_id: String,
    terminal_ms: i64,
) -> Result<bool, String> {
    // 锁内:**原子取走** pending + 克隆判定原料(跨 await 的都在这段拿;无 pending 立即让位)。
    // 取走而非只克隆(2026-11-18):brain 判定窗数十秒,期间另一终态(如 API 重试轮的
    // 双 result)再触发 auto_verdict 会拿到同一条 pending 双判双卡(用户实测 2 次投递
    // 出 3 张失败卡,后两张背靠背 4s);取走后不消费分支(总闸关/挂起/防御)回填。
    // terminal_ms = 触发终态时刻:只验收「终态前派出的活」——上一轮终态的迟到验收
    // 不再吞刚投出的新任务(其 dispatched_ms 晚于终态,留给它自己的终态钩子)。
    let (pv_taken, tail, session) = {
        let Some(state) = app.try_state::<ConductorState>() else {
            return Err("conductor state missing".to_string());
        };
        let Ok(mut data) = state.0.lock() else {
            return Err("conductor lock".to_string());
        };
        let Some(idx) = data.pending_verdicts.iter().position(|p| {
            p.project_id == project_id && p.tab_id == tab_id && p.dispatched_ms <= terminal_ms
        }) else {
            return Ok(false);
        };
        let pv = data.pending_verdicts.remove(idx);
        (
            pv.clone(),
            // 本轮任务期产出(2026-11-18):行带时间戳,按派活登记时刻(dispatched_ms)
            // 起取——直投大任务 AI 自拆多轮跑很久,只看任意尾部会把派活早期的关键产出
            // 滚掉,验收员信息不足偏保守误判;挂起补判/重启后 tail 空,照旧按空产出容错。
            data.session_tails
                .get(&super::skey(&project_id, &tab_id))
                .map(|t| {
                    t.iter()
                        .skip_while(|l| l.ms < pv.dispatched_ms)
                        .map(|l| l.text.as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default(),
            data.sessions.get(&super::skey(&project_id, &tab_id)).cloned(),
        )
    };
    let (goal, rework_count, ceiling, plan_id, step_id, acceptance) = (
        pv_taken.goal.clone(),
        pv_taken.rework_count,
        pv_taken.permission_ceiling,
        pv_taken.plan_id.clone(),
        pv_taken.step_id.clone(),
        pv_taken.acceptance.clone(),
    );
    let plan_link = plan_id.clone().zip(step_id.clone());
    // 验收卡的目标行(带验收标准时展示尺子——failed/rework 留人审时人先看约定口径)。
    let goal_view = match acceptance.as_deref() {
        Some(a) if !a.trim().is_empty() => format!("目标:{goal}\n标准:{a}"),
        _ => format!("目标:{goal}"),
    };
    // 总闸关 = LLM 环节全不出:回填 pending(下次终态再试),阻断常规建议。
    {
        let state = app.state::<ConductorState>();
        let mut data = state.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        if !data.config.allow_orchestrator {
            let disk = restore_verdict_locked(&mut data, pv_taken);
            save_disk(&app, &disk).map_err(|e| log::warn!("conductor: verdict persist failed: {e}")).ok();
            return Ok(true);
        }
    }
    // 会话状态行(富化项目名/tab 名)+ 产出尾部(旧→新)。
    let (live_tabs, project_names, _) = collect_live(&app);
    let session_line = session
        .as_ref()
        .map(|s| snapshot_line(s, &project_names, &live_tabs))
        .unwrap_or_else(|| format!("(会话 {tab_id} 状态未知)"));

    let verdict = match super::brain::verify_task(&app, &goal, &session_line, &tail, acceptance.as_deref()).await {
        Ok(v) => v,
        Err(e) => {
            // 挂起:大脑失败(degraded/端点挂/解析败)。回填 pending(判定权已取走),
            // 去重产挂起卡,下次终态补判。
            log::warn!("conductor: verdict suspended: {e}");
            let state = app.state::<ConductorState>();
            let should_card = state
                .0
                .lock()
                .map(|d| !verdict_pending_card_exists(&d, &project_id, &tab_id))
                .unwrap_or(false);
            if should_card {
                let record = verdict_record(
                    DecisionStatus::Proposed,
                    "验收挂起(智核不可用,下次终态补判)".to_string(),
                    format!("{goal_view}\n智核失败:{e}"),
                    json!({ "verdict": "pending", "goal": goal, "acceptance": acceptance, "reason": e, "tabId": tab_id }),
                    &project_id,
                    &tab_id,
                );
                commit_decision(&app, record);
            }
            let disk = {
                let mut data = state.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
                restore_verdict_locked(&mut data, pv_taken)
            };
            save_disk(&app, &disk).map_err(|e| log::warn!("conductor: verdict persist failed: {e}")).ok();
            return Ok(true);
        }
    };
    let Some(v) = verdict else {
        // verify_task 只回 Some 或 Err;防御性兜底——判定权取走了,回填防悬挂。
        let state = app.state::<ConductorState>();
        let mut data = state.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let disk = restore_verdict_locked(&mut data, pv_taken);
        save_disk(&app, &disk).map_err(|e| log::warn!("conductor: verdict persist failed: {e}")).ok();
        return Ok(true);
    };
    let now = now_ms();
    match v.verdict.as_str() {
        "success" => {
            let disk = {
                let state = app.state::<ConductorState>();
                let mut data = state.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
                settle_verdict_locked(&mut data, &project_id, &tab_id, None, plan_link.clone())
            };
            save_disk(&app, &disk).map_err(|e| log::warn!("conductor: verdict persist failed: {e}")).ok();
            let record = verdict_record(
                DecisionStatus::Accepted,
                "验收通过".to_string(),
                format!("{goal_view}\n判定:{}", v.reason),
                json!({ "verdict": "success", "goal": goal, "acceptance": acceptance, "reason": v.reason }),
                &project_id,
                &tab_id,
            );
            commit_decision(&app, record);
            // 编排推进(P3a):本步 done,发下一步 / 全 done 收官。
            if let (Some(pid), Some(sid)) = (&plan_id, &step_id) {
                super::orchestrate::advance_after_success(&app, pid, sid).await;
            }
        }
        "rework" if !v.rework.is_empty() => {
            // 可发判定(锁内):自动执行配置 + 该链未自动返工过 + 占用锁放行。
            let auto_rework = {
                let state = app.state::<ConductorState>();
                let x = match state.0.lock() {
                    Ok(data) => {
                        data.config.auto_execute_suggestions
                            && rework_count == 0
                            && matches!(
                            guard::check_dispatch(&data, &project_id, &tab_id, false, now),
                            DispatchGate::Allow
                        )
                    }
                    Err(_) => false,
                };
                x
            };
            if auto_rework {
                match send_to_session(&app, &project_id, &tab_id, &v.rework).await {
                    Ok(()) => {
                        // 新 pending 登记同目标(rework_count+1):验收对象仍是原目标,
                        // 验收标准原样保留(同一把尺子)。
                        let disk = {
                            let state = app.state::<ConductorState>();
                            let mut data = state.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
                            settle_verdict_locked(&mut data, &project_id, &tab_id, Some((&project_id, &goal, 1, ceiling, acceptance.as_deref())), plan_link.clone())
                        };
                        save_disk(&app, &disk).map_err(|e| log::warn!("conductor: verdict persist failed: {e}")).ok();
                        let record = verdict_record(
                            DecisionStatus::Accepted,
                            "验收:未完全达成,已自动返工".to_string(),
                            format!("{goal_view}\n判定:{}\n返工指令:{}", v.reason, v.rework),
                            json!({ "verdict": "rework", "goal": goal, "acceptance": acceptance, "reason": v.reason, "rework": v.rework, "auto": true }),
                            &project_id,
                            &tab_id,
                        );
                        commit_decision(&app, record);
                    }
                    Err(e) => {
                        // 发送失败:判定已消费(不再自动重发),卡留人审带返工指令。
                        let disk = {
                            let state = app.state::<ConductorState>();
                            let mut data = state.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
                            settle_verdict_locked(&mut data, &project_id, &tab_id, None, plan_link.clone())
                        };
                        save_disk(&app, &disk).map_err(|e| log::warn!("conductor: verdict persist failed: {e}")).ok();
                        let record = verdict_record(
                            DecisionStatus::Proposed,
                            "验收:返工发送失败,请人工处理".to_string(),
                            format!("{goal_view}\n判定:{}\n返工指令:{}\n发送失败:{e}", v.reason, v.rework),
                            json!({ "verdict": "rework", "goal": goal, "acceptance": acceptance, "reason": v.reason, "rework": v.rework, "sendFailed": true }),
                            &project_id,
                            &tab_id,
                        );
                        commit_decision(&app, record);
                        // 编排:返工发不出去 = 本步卡死,停链留人 retry。
                        if let (Some(pid), Some(sid)) = (&plan_id, &step_id) {
                            super::orchestrate::halt_after_failure(&app, pid, sid, &v.reason).await;
                        }
                    }
                }
            } else {
                // 不自动返工(占用锁/配置关/已返工过一次):清账 + 建议返工卡留人审。
                let disk = {
                    let state = app.state::<ConductorState>();
                    let mut data = state.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
                    settle_verdict_locked(&mut data, &project_id, &tab_id, None, plan_link.clone())
                };
                save_disk(&app, &disk).map_err(|e| log::warn!("conductor: verdict persist failed: {e}")).ok();
                let reason_note = if rework_count > 0 { "(该目标已自动返工过一次)" } else { "" };
                let record = verdict_record(
                    DecisionStatus::Proposed,
                    format!("验收:未完全达成,建议返工{reason_note}"),
                    format!("{goal_view}\n判定:{}\n建议返工指令:{}", v.reason, v.rework),
                    json!({ "verdict": "rework", "goal": goal, "acceptance": acceptance, "reason": v.reason, "rework": v.rework }),
                    &project_id,
                    &tab_id,
                );
                commit_decision(&app, record);
                // 编排:重试闸已尽/锁不放行,步无 pending 会悬挂 → 停链留人 retry。
                if let (Some(pid), Some(sid)) = (&plan_id, &step_id) {
                    super::orchestrate::halt_after_failure(&app, pid, sid, &v.reason).await;
                }
            }
        }
        // failed / rework 缺返工指令(降级按 failed):清账留人审,不自动重试。
        _ => {
            let verdict_tag = if v.verdict == "failed" { "failed" } else { "rework" };
            let disk = {
                let state = app.state::<ConductorState>();
                let mut data = state.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
                settle_verdict_locked(&mut data, &project_id, &tab_id, None, plan_link.clone())
            };
            save_disk(&app, &disk).map_err(|e| log::warn!("conductor: verdict persist failed: {e}")).ok();
            let record = verdict_record(
                DecisionStatus::Proposed,
                format!("验收失败:{}", super::truncate_chars(&v.reason, 60)),
                format!("{goal_view}\n判定:{}", v.reason),
                json!({ "verdict": verdict_tag, "goal": goal, "acceptance": acceptance, "reason": v.reason }),
                &project_id,
                &tab_id,
            );
            commit_decision(&app, record);
            // 编排停链(P3a):失败即停,后步 skipped,留人 retry;降级 rework 同径。
            if let (Some(pid), Some(sid)) = (&plan_id, &step_id) {
                super::orchestrate::halt_after_failure(&app, pid, sid, &v.reason).await;
            }
        }
    }
    Ok(true)
}

/// 产卡落盘 + 广播(意图分派四路共用;锁内 push,锁外 save/emit)。
fn commit_decision(app: &AppHandle, record: DecisionRecord) {
    let outcome = {
        let state = app.state::<ConductorState>();
        let Ok(mut data) = state.0.lock() else { return };
        push_decision(&mut data.decisions, record);
        let count = attention_count(&data);
        let disk = snapshot_disk(&data);
        drop(data);
        (disk, count)
    };
    if let Err(e) = save_disk(app, &outcome.0) {
        log::warn!("conductor: decision persist failed: {e}");
    }
    emit_event(app, outcome.1, "decision");
}

/// 手动触发建议(设置分区「测试大脑」/概览卡按钮)。
/// 2026-11-16 修「按钮永远显示已触发、实际啥都没干」:改为**同步等待 auto_suggest 的结果**
/// 并把真实 outcome 回给前端——总闸未开/退避中/无会话/去重跳过/大脑返回 none 各有文案,
/// 用户点一下就知道为什么决策流是空的。
#[tauri::command]
pub async fn conductor_suggest_now(
    app: AppHandle,
    _conductor: State<'_, ConductorState>,
    tab_id: Option<String>,
) -> Result<Value, String> {
    auto_suggest(app, tab_id.map(|t| (None, t)), DecisionSource::Manual)
        .await
        .map(|message| json!({ "triggered": true, "message": message }))
}

// ---------------------------------------------------------------- 配置

/// 读配置 + 大脑健康状态。大脑端点独立配置(2026-11-13 反转「复用 claude 供应商」):
/// baseUrl 原样回(用户自己填的),token **只回脱敏摘要**(不回原文,防快照外泄),
/// 模型兜底链有序下发;legacy 引用字段若尚在迁移前,一并回给前端做兼容显示。
#[tauri::command]
pub fn conductor_config_get(conductor: State<'_, ConductorState>) -> Result<Value, String> {
    let data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
    let cfg = &data.config;
    let now = now_ms();
    let masked_key = if cfg.brain_api_key.trim().is_empty() {
        String::new()
    } else {
        let k = cfg.brain_api_key.trim();
        let tail: String = k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        format!("****{}", tail)
    };
    Ok(json!({
        "config": {
            "allowOrchestrator": cfg.allow_orchestrator,
            "brainBaseUrl": cfg.brain_base_url,
            "brainApiKeyMasked": masked_key,
            "brainApiKeySet": !cfg.brain_api_key.trim().is_empty(),
            "brainModels": cfg.brain_models,
            "brainApiFormat": cfg.brain_api_format,
            "occupiedLockMinutes": cfg.occupied_lock_minutes,
            // 建议静默窗(分钟,0 = 不静默):设置 UI 消费,独立于占用锁。
            "suggestQuietMinutes": cfg.suggest_quiet_minutes,
            "perCycleTokenBudget": cfg.per_cycle_token_budget,
            "autoApproveTools": cfg.auto_approve_tools,
            // auto 级代批宽限毫秒(0 = 立即放行不弹卡;设置 UI 消费)。
            "autoApproveDelayMs": cfg.auto_approve_delay_ms,
            "autoExecuteSuggestions": cfg.auto_execute_suggestions,
            // 孵化流水线(P4a:计划 finished 自动领取孵化下一条)。
            "pipeline": cfg.pipeline,
            // 投递占用排队(被占全拦 → Queued 等空闲终态自动补投;false = 降级建议卡)。
            "queueWhenOccupied": cfg.queue_when_occupied,
            // 项目级建议开关·白名单(空 = 全部项目安静不出常规建议;列内才出)。
            "suggestProjects": cfg.suggest_projects,
            // 权限分级表(P2a;P2b 设置编辑器消费,空表 = 默认行为)。
            "permissionRules": serde_json::to_value(&cfg.permission_rules).unwrap_or_default(),
        },
        "brainDegraded": now < data.brain_degraded_until_ms,
        "brainDegradedUntilMs": data.brain_degraded_until_ms,
        "brainFailStreak": data.brain_fail_streak,
        "lastBrainError": data.last_brain_error,
        "maxTokens": MAX_TOKENS,
        // 项目级指挥台开关·黑名单(黑名单口径:不在名单 = 参与)。
        "mutedProjects": data.muted_projects,
    }))
}

/// 写配置(patch 语义:出现的字段才覆盖;`brainProviderId`/`brainModel` 传 null/"" 回退
/// 写配置(patch 语义:出现的字段才覆盖;独立端点四件套 baseUrl/token/模型链/协议;
/// `brainApiKey` 只在非空时覆盖——脱敏摘要回显不能当值写回)。
#[tauri::command]
pub fn conductor_config_set(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    patch: Value,
) -> Result<(), String> {
    let disk = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        {
            let cfg = &mut data.config;
            if let Some(v) = patch.get("allowOrchestrator") {
                if let Some(b) = v.as_bool() {
                    cfg.allow_orchestrator = b;
                }
            }
            let opt_str = |v: &Value| -> Option<Option<String>> {
                if v.is_null() {
                    Some(None)
                } else if let Some(s) = v.as_str() {
                    let s = s.trim().to_string();
                    Some(if s.is_empty() { None } else { Some(s) })
                } else {
                    None
                }
            };
            if let Some(v) = patch.get("brainBaseUrl") {
                if let Some(next) = opt_str(v) {
                    cfg.brain_base_url = next.unwrap_or_default();
                }
            }
            // token 特殊:前端回显的是脱敏摘要(****abcd),非空且不以 **** 开头才算真 key。
            if let Some(v) = patch.get("brainApiKey") {
                if let Some(s) = v.as_str() {
                    let s = s.trim();
                    if !s.is_empty() && !s.starts_with("****") {
                        cfg.brain_api_key = s.to_string();
                    }
                }
            }
            // 模型兜底链(有序多选):数组逐个 trim 去空去重;空数组 = 清空选择。
            if let Some(v) = patch.get("brainModels") {
                if let Some(arr) = v.as_array() {
                    let mut seen = std::collections::HashSet::new();
                    cfg.brain_models = arr
                        .iter()
                        .filter_map(|m| m.as_str())
                        .map(|m| m.trim().to_string())
                        .filter(|m| !m.is_empty() && seen.insert(m.clone()))
                        .collect();
                }
            }
            if let Some(v) = patch.get("brainApiFormat") {
                if let Some(s) = v.as_str() {
                    let s = s.trim();
                    if s == "openai" || s == "anthropic" {
                        cfg.brain_api_format = s.to_string();
                    }
                }
            }
            if let Some(v) = patch.get("occupiedLockMinutes") {
                if let Some(n) = v.as_u64() {
                    cfg.occupied_lock_minutes = n.clamp(1, 240);
                }
            }
            // 0 合法 = 不静默(终态一律出卡);上限与占用锁同口径 4 小时。
            if let Some(v) = patch.get("suggestQuietMinutes") {
                if let Some(n) = v.as_u64() {
                    cfg.suggest_quiet_minutes = n.clamp(0, 240);
                }
            }
            if let Some(v) = patch.get("perCycleTokenBudget") {
                if let Some(n) = v.as_u64() {
                    cfg.per_cycle_token_budget = n.clamp(100, 100_000) as u32;
                }
            }
            if let Some(v) = patch.get("autoApproveTools") {
                if let Some(b) = v.as_bool() {
                    cfg.auto_approve_tools = b;
                }
            }
            // auto 级代批宽限(2026-11-17「先弹卡再自动选」):0 = 立即放行(不弹卡);
            // 上限 2 分钟防误填把任务挂死在等待里。
            if let Some(v) = patch.get("autoApproveDelayMs") {
                if let Some(n) = v.as_u64() {
                    cfg.auto_approve_delay_ms = n.clamp(0, 120_000);
                }
            }
            if let Some(v) = patch.get("autoExecuteSuggestions") {
                if let Some(b) = v.as_bool() {
                    cfg.auto_execute_suggestions = b;
                }
            }
            // 孵化流水线(P4a):纯布尔开关。
            if let Some(v) = patch.get("pipeline") {
                if let Some(b) = v.as_bool() {
                    cfg.pipeline = b;
                }
            }
            // 投递占用排队:纯布尔开关。
            if let Some(v) = patch.get("queueWhenOccupied") {
                if let Some(b) = v.as_bool() {
                    cfg.queue_when_occupied = b;
                }
            }
            // 项目建议白名单(2026-11-23):数组整体替换,逐个 trim 去空去重。
            if let Some(v) = patch.get("suggestProjects") {
                if let Some(arr) = v.as_array() {
                    let mut seen = std::collections::HashSet::new();
                    cfg.suggest_projects = arr
                        .iter()
                        .filter_map(|x| x.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && seen.insert(s.to_string()))
                        .map(str::to_string)
                        .collect();
                }
            }
            // 权限分级表(P2b):整表替换(编辑器整体序列化下发,不做字段级 merge——
            // 规则行增删/改级都是整表操作,merge 反而说不清)。非法级名/空工具名丢弃。
            if let Some(v) = patch.get("permissionRules") {
                if let Ok(mut rules) =
                    serde_json::from_value::<permissions::PermissionRules>(v.clone())
                {
                    rules.tools.retain(|r| !r.tool.trim().is_empty());
                    rules.tools.iter_mut().for_each(|r| r.tool = r.tool.trim().to_string());
                    rules.bash.iter_mut().for_each(|r| r.pattern = r.pattern.trim().to_string());
                    rules.bash.retain(|r| !r.pattern.is_empty());
                    cfg.permission_rules = rules;
                }
            }
        }
        // 配置变更(尤其换了 baseUrl/模型链)后清退避重试。
        data.brain_fail_streak = 0;
        data.brain_degraded_until_ms = 0;
        log::info!(
            "conductor: config updated (gate={}, baseUrl={:?}, models={:?}, format={}, autoApprove={})",
            data.config.allow_orchestrator,
            data.config.brain_base_url,
            data.config.brain_models,
            data.config.brain_api_format,
            data.config.auto_approve_tools
        );
        snapshot_disk(&data)
    };
    save_disk(&app, &disk)
}

/// 人接管 auto 宽限(2026-11-17「先弹卡再自动选」):人在审批卡上点了任意按钮时,
/// 前端调此命令撤销该 request 的到期代发——后端 delayed_auto_allow 唤醒后见不在
/// auto_pending 即退出,不写 stdin、不记流水(人批的不算机器批)。
#[tauri::command]
pub fn conductor_auto_approve_cancel(
    app: AppHandle,
    request_id: String,
) -> Result<bool, String> {
    let state = app.state::<ConductorState>();
    let mut data = state.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
    Ok(data.auto_pending.remove(&request_id))
}

/// 探测大脑端点:拉模型目录(复用 providers 的 probe_endpoint,8s 超时——用户主动点,
/// 愿意等)。url/token 取**表单当前值**(未保存也能试),回 models 列表 + 延迟 + 错误。
#[tauri::command]
pub async fn conductor_brain_probe(base_url: String, token: Option<String>) -> Result<Value, String> {
    let url = base_url.trim();
    if url.is_empty() {
        return Err("先填 baseUrl".to_string());
    }
    let p = crate::providers::commands::probe_endpoint(url, token.as_deref(), 8).await;
    Ok(json!({
        "latencyMs": p.latency_ms,
        "status": p.status,
        "models": p.models,
        "error": p.error,
    }))
}

// --------------------------------------------------------------- prompt 技艺文件

/// 用系统默认编辑器打开 prompt 技艺文件(拆步/验收的 system prompt;不存在先播种
/// 内置默认)。返回文件路径供前端悬浮展示。同步命令(纯文件 IO + opener)。
#[tauri::command]
pub fn conductor_prompt_open(app: AppHandle, kind: String) -> Result<String, String> {
    let k = super::prompts::PromptKind::from_param(&kind)
        .ok_or_else(|| format!("未知 prompt kind: {kind}"))?;
    super::prompts::open_in_editor(&app, k)
}

/// 重置 prompt 技艺文件为内置默认(覆盖写回)。返回文件路径。
#[tauri::command]
pub fn conductor_prompt_reset(app: AppHandle, kind: String) -> Result<String, String> {
    let k = super::prompts::PromptKind::from_param(&kind)
        .ok_or_else(|| format!("未知 prompt kind: {kind}"))?;
    super::prompts::reset_default(&app, k)
}

// ---------------------------------------------------------------- dispatch 卡 → fleet 联动(P2)

/// dispatch 卡确认(设计 §4:确认卡制)。人点「创建 worker 并派活」→ 真正建 worktree
/// (直调 fleet 命令本体)→ 广播 `fleet-dispatch` 让主窗口自动挂 worker tab + 注入首条
/// 指令 → 卡标 Accepted。create 失败(taskId 重名/非法字符等)Err 透传,卡保持
/// Proposed 可改后重试;丢弃(dispatch 卡 reject)走 decision_respond,无副作用。
#[tauri::command]
pub async fn conductor_dispatch_accept(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: String,
    task_id: Option<String>,
    provider: Option<String>,
    edited_text: Option<String>,
) -> Result<Value, String> {
    // 1) 锁内取卡数据(不改状态——create 失败要保留卡供重试)。
    let (project_id, first_message) = {
        let data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let d = data
            .decisions
            .iter()
            .find(|d| d.id == id)
            .ok_or_else(|| "决策卡不存在".to_string())?;
        if d.status != DecisionStatus::Proposed {
            return Err("决策卡已处理".to_string());
        }
        if d.kind != DecisionKind::Dispatch {
            return Err("不是 dispatch 卡".to_string());
        }
        let project = d
            .target_project_id
            .clone()
            .ok_or_else(|| "dispatch 卡缺目标项目".to_string())?;
        // 首条指令:editedText(人在卡上改过)优先,否则卡文本(意图的 taskText)。
        let message = edited_text
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| d.text.clone());
        (project, message)
    };
    // taskId / provider:参数(人在卡上改过)优先,否则卡 payload 里的预填值。
    let (prefill_task, prefill_provider) = {
        let data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let d = data
            .decisions
            .iter()
            .find(|d| d.id == id)
            .ok_or_else(|| "决策卡不存在".to_string())?;
        let payload = d.payload.as_ref();
        (
            payload
                .and_then(|p| p.get("taskId"))
                .and_then(|v| v.as_str())
                .map(str::to_string),
            payload
                .and_then(|p| p.get("provider"))
                .and_then(|v| v.as_str())
                .map(str::to_string),
        )
    };
    let task_id = task_id
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or(prefill_task)
        .ok_or_else(|| "缺 taskId".to_string())?;
    let provider = provider
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .or(prefill_provider)
        .unwrap_or_else(|| "claude".to_string());

    // 2) 建 worktree(直调 fleet 命令本体;失败 Err 透传,卡保持 Proposed)。
    let record = crate::fleet::commands::create_fleet_worker(
        app.clone(),
        app.state::<AppState>(),
        project_id.clone(),
        task_id,
        provider,
    )
    .await?;

    // 3) 标 Accepted + 广播挂载事件(主窗口 AppShell 监听 → spawnFleetTab + 首条指令)。
    {
        let disk = {
            let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
            if let Some(d) = data.decisions.iter_mut().find(|d| d.id == id) {
                if d.status == DecisionStatus::Proposed {
                    d.status = DecisionStatus::Accepted;
                    d.text = first_message.clone();
                    if let Some(p) = d.payload.as_mut() {
                        p["taskId"] = json!(record.id);
                        p["provider"] = json!(record.provider);
                    }
                }
            }
            snapshot_disk(&data)
        };
        save_disk(&app, &disk).map_err(|e| log::warn!("conductor: dispatch persist failed: {e}")).ok();
    }
    let _ = app.emit(
        "fleet-dispatch",
        json!({
            "projectId": record.project_id,
            "worker": {
                "id": record.id,
                "provider": record.provider,
                "branch": record.branch,
                "worktreePath": record.worktree_path,
            },
            "firstMessage": first_message,
        }),
    );
    log::info!(
        "conductor: dispatch accepted, worker {} on {} (first message {} chars)",
        record.id,
        record.project_id,
        first_message.chars().count()
    );
    Ok(json!({ "ok": true, "taskId": record.id }))
}

/// dispatch 卡挂载后的首条指令注入(AppShell 建完 worker tab 调用;等 transport 起
/// 进程的间隔由前端控制,本命令只管发——目标未启动时 send_to_session 自动拉起)。
#[tauri::command]
pub async fn conductor_dispatch_send(
    app: AppHandle,
    project_id: String,
    tab_id: String,
    text: String,
    permission_ceiling: Option<permissions::Level>,
) -> Result<Value, String> {
    send_to_session(&app, &project_id, &tab_id, &text).await?;
    // 验收回环:fleet worker 首条指令也是 conductor 派的活,登记待验收
    // (worker tab 的会话事件同样进 AiBus,终态后走同一条验收链)。
    if let Some(state) = app.try_state::<ConductorState>() {
        let disk = {
            if let Ok(mut data) = state.0.lock() {
                // 静音项目豁免登记(同 decision_respond/inbox_dispatch 口径);fleet
                // 首条指令无验收标准来源,acceptance = None。
                if !super::is_muted(&data, &project_id) {
                    super::register_verdict_locked(&mut data, &project_id, &tab_id, &text, 0, permission_ceiling, None);
                }
                snapshot_disk(&data)
            } else {
                return Ok(json!({ "ok": true }));
            }
        };
        save_disk(&app, &disk).map_err(|e| log::warn!("conductor: verdict persist failed: {e}")).ok();
    }
    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------- 编排(P3a)

/// 拆步执行(自动驾驶三期 P3a):总意图 → 大脑拆步(≤8 步)→ 建计划并派发首步。
/// 后续推进全自动:每步验收 success 发下一步 / failed 停链 / rework 原地重试
/// (orchestrate 状态机)。闸门:总闸开才可用(拆步是 LLM 环节)、并发 ≤2、目标
/// 静音拒绝。**单步可完成 → 建 1 步计划(返回 singleStep=true,不降级为普通直投
/// ——计划 finished 是流水线领取的唯一触发点,绕过计划机制领取就断,2026-11-17)**;
/// 拆步失败 → Err(前端报错,不静默)。
#[tauri::command]
pub async fn conductor_plan_create(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    goal: String,
    project_id: String,
    tab_id: String,
    permission_ceiling: Option<permissions::Level>,
) -> Result<Value, String> {
    let goal = goal.trim().to_string();
    if goal.is_empty() {
        return Err("总意图为空".to_string());
    }
    if project_id.is_empty() || tab_id.is_empty() {
        return Err("未选择目标会话".to_string());
    }
    // 总闸(拆步是 LLM 环节)+ 静音/并发闸。
    {
        let data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        if !data.config.allow_orchestrator {
            return Err("总闸未开启:拆步执行需要智核参与".to_string());
        }
        if super::is_muted(&data, &project_id) {
            return Err("目标项目已静音,涌现不参与该项目".to_string());
        }
        let running = data
            .plans
            .iter()
            .filter(|p| p.status == orchestrate::PlanStatus::Running)
            .count();
        if running >= orchestrate::MAX_ACTIVE_PLANS {
            return Err(format!("已有 {running} 个拆步进行中(上限 {}),先暂停/终止一个", orchestrate::MAX_ACTIVE_PLANS));
        }
    }
    // 项目名(拆步 prompt 上下文)。
    let project_line = app
        .try_state::<AppState>()
        .and_then(|s| {
            s.inner
                .lock()
                .ok()
                .and_then(|snap| snap.projects.iter().find(|p| p.id == project_id).map(|p| p.name.clone()))
        })
        .unwrap_or_else(|| project_id.clone());

    let texts = super::brain::plan_steps(&app, &goal, &project_line).await?;

    // 智核判定单步可完成 → 建 **1 步计划**(步文 = 总意图原文),不降级为普通直投
    // (2026-11-17 两轮修正:第一轮改「自动转直投」实测翻车——用户跑幕 2,单步直投
    // 没有「计划 finished」事件,流水线领取的触发点不存在,同会话 pending 永远不被
    // 领;点「拆步执行」的意图是发起计划链(含 finished 后的流水线领取/续段判定),
    // 单步只是退化形态,必须留在计划机制内)。旧版行为(抛错「直接派发即可」让人
    // 再点一次发送)是纯摩擦,同样不要)。
    let texts = if texts.is_empty() { vec![goal.clone()] } else { texts };
    let single_step = texts.len() == 1;

    let plan_id;
    {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let plan = orchestrate::build_plan(
            &goal,
            InboxTarget { project_id: project_id.clone(), tab_id: tab_id.clone() },
            permission_ceiling,
            texts,
        );
        plan_id = plan.id.clone();
        let n = plan.steps.len();
        data.plans.insert(0, plan);
        log::info!("conductor: plan created ({} steps) for {}/{}", n, project_id, tab_id);
        let disk = snapshot_disk(&data);
        drop(data);
        save_disk(&app, &disk).map_err(|e| log::warn!("conductor: plan persist failed: {e}")).ok();
    }

    // 派发首步(发送失败时 orchestrate 内部已 halt)。
    orchestrate::dispatch_step(&app, &plan_id, 0).await?;
    let status = conductor
        .0
        .lock()
        .ok()
        .and_then(|d| d.plans.iter().find(|p| p.id == plan_id).map(|p| p.status))
        .map(|s| format!("{s:?}").to_lowercase())
        .unwrap_or_default();
    emit_event(&app, 0, "decision");
    Ok(json!({ "planId": plan_id, "status": status, "singleStep": single_step }))
}

/// 删除终态计划记录(finished/halted;2026-11-17 用户:「拆步执行的孵化列表没删除
/// 按钮」——完结计划沉底留痕,需要清理入口)。running/paused 拒绝:先终止再删,
/// 防误删进行中链(撤销链在 control abort 里,删记录绕不过中断)。纯记录清理,
/// 无业务副作用(与 conductor_decision_remove 的撤销语义不同)。
#[tauri::command]
pub async fn conductor_plan_remove(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: String,
) -> Result<Value, String> {
    let count = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        if data
            .plans
            .iter()
            .any(|p| p.id == id && matches!(p.status, orchestrate::PlanStatus::Running | orchestrate::PlanStatus::Paused))
        {
            return Err("计划进行中(含已暂停),请先终止再删除".to_string());
        }
        let before = data.plans.len();
        data.plans.retain(|p| p.id != id);
        if data.plans.len() == before {
            return Err("计划不存在".to_string());
        }
        let c = attention_count(&data);
        let disk = snapshot_disk(&data);
        drop(data);
        save_disk(&app, &disk)
            .map_err(|e| log::warn!("conductor: plan remove persist failed: {e}"))
            .ok();
        c
    };
    emit_event(&app, count, "decision");
    Ok(json!({ "ok": true }))
}

/// 编排控制:pause(暂停,success 只记步)/ resume(断点续跑)/ abort(终止,后步
/// 全 skipped)。P3b 编排卡动作的后端。
#[tauri::command]
pub async fn conductor_plan_control(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: String,
    action: String,
) -> Result<Value, String> {
    let applied = orchestrate::control(&app, &id, &action).await?;
    let _ = conductor;
    Ok(json!({ "ok": true, "applied": applied }))
}

/// 改指令续跑:halted/paused 计划从失败步(或当前步)重发;`text` 给新指令,空 = 原文重试。
#[tauri::command]
pub async fn conductor_plan_retry(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: String,
    text: Option<String>,
) -> Result<Value, String> {
    orchestrate::retry(&app, &id, text).await?;
    let _ = conductor;
    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------- 记忆(P2)

/// 手填记忆(写入三路之「显式指令」):人的明确输入,直接 confirmed=true 进注入池。
/// `projects`:命中项目 id 列表(空/缺省 = 全局;2026-11-16 支持多项目)。
#[tauri::command]
pub fn conductor_memory_add(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    kind: String,
    projects: Option<Vec<String>>,
    content: String,
) -> Result<Value, String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("内容为空".to_string());
    }
    let entry = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let mut entry = memory::new_entry(&kind, projects.unwrap_or_default(), &content, "explicit");
        entry.confirmed = true; // 人手填即真源,免确认门槛
        data.memories.push(entry.clone());
        let entries = data.memories.clone();
        drop(data);
        if let Err(e) = memory::save(&app, &entries) {
            return Err(e);
        }
        entry
    };
    let count = conductor.0.lock().map(|d| attention_count(&d)).unwrap_or(0);
    emit_event(&app, count, "memory");
    Ok(json!({ "id": entry.id }))
}

/// 确认候选(纠偏提炼/remember 意图/种子导入产出的 confirmed:false → true)。
#[tauri::command]
pub fn conductor_memory_confirm(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: String,
) -> Result<Value, String> {
    {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let entry = data
            .memories
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| "记忆条目不存在".to_string())?;
        entry.confirmed = true;
        let entries = data.memories.clone();
        drop(data);
        memory::save(&app, &entries)?;
    }
    let count = conductor.0.lock().map(|d| attention_count(&d)).unwrap_or(0);
    emit_event(&app, count, "memory");
    Ok(json!({ "ok": true }))
}

/// 删除条目(候选与已确认都可删;forget 不进意图词汇表,删除权只属于人)。
#[tauri::command]
pub fn conductor_memory_delete(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
    id: String,
) -> Result<Value, String> {
    {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        let before = data.memories.len();
        data.memories.retain(|e| e.id != id);
        if data.memories.len() == before {
            return Err("记忆条目不存在".to_string());
        }
        let entries = data.memories.clone();
        drop(data);
        memory::save(&app, &entries)?;
    }
    let count = conductor.0.lock().map(|d| attention_count(&d)).unwrap_or(0);
    emit_event(&app, count, "memory");
    Ok(json!({ "ok": true }))
}

/// 种子导入:claude 各项目 MEMORY.md(带项目 scope 匹配)+ codex AGENTS.md /
/// claude CLAUDE.md 全局指令条目 → imported 候选(未确认)。幂等(同 content 跳过),
/// 返回新增条数。
#[tauri::command]
pub fn conductor_memory_import_seed(
    app: AppHandle,
    conductor: State<'_, ConductorState>,
) -> Result<Value, String> {
    // 项目表(id, root_path)供 scope 正向匹配(持 conductor 锁时读 AppState 短锁,顺序
    // 单向无环,无死锁面)。
    let projects: Vec<(String, String)> = {
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(snap) = state.inner.lock() {
                snap.projects
                    .iter()
                    .map(|p| (p.id.clone(), p.root_path.clone()))
                    .collect()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        }
    };
    let added = {
        let mut data = conductor.0.lock().map_err(|e| format!("conductor lock: {e}"))?;
        memory::import_seed(&app, &mut data.memories, &projects)
    };
    if added > 0 {
        let count = conductor.0.lock().map(|d| attention_count(&d)).unwrap_or(0);
        emit_event(&app, count, "memory");
    }
    log::info!("conductor: memory seed import, {added} new candidate(s)");
    Ok(json!({ "added": added }))
}

// ---------------------------------------------------------------- 大脑兜底循环(P2)

/// 启动大脑决策循环兜底(设计 §9 P2:事件触发之外 5min 定时兜底——会话长时间无终态
/// 事件时,建议链路不至于完全沉默)。auto_suggest 内部有总闸/degraded/空会话/
/// 30min 去重窗检查,兜底轮天然限频;LLM 挂了规则层照常(§1 分层降级)。
pub fn spawn_brain_loop(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(BRAIN_LOOP_TICK).await;
            // 返回值忽略:兜底轮无人在等结果,auto_suggest 内部已各自打日志。
            let _ = auto_suggest(app.clone(), None, DecisionSource::Brain).await;
        }
    });
}
