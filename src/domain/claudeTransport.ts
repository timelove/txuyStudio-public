import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import {
  type ClaudeEvent,
  type ClaudeEventPayload,
  type ClaudeStreamState,
  appendUserMessage,
  applyEvent,
  applyHistoryEvents,
  initialClaudeState,
  patchToolBlock,
} from "./claudeStream";
import { RETRY_DELAYS_MS, RETRY_MAX_ATTEMPTS, isRetryableApiError } from "./claudeRetry";
import { claudeStatusRegistry } from "./claudeStatusRegistry";
import { summarize } from "./claudeStream";

/**
 * claude 自渲染对话的 transport(仿 `TauriPtyTransport` 但不实现 `TerminalTransport` 接口)。
 *
 * 每个实例对应一个 claudepane tab:绑定 (projectId, tabId),listen 全局 `claude-event` 事件按
 * (projectId, tabId) 路由 → `applyEvent` 归并成本地 `state` → 经 `onEvents` 回调通知 UI。
 *
 * **stream-json 长进程架构**(见 `.work/design/20260720-compact-stream-json/`):一个 tab = 一个
 * 长生命周期 claude 进程(`--input-format stream-json --output-format stream-json`),stdin 持续
 * 喂消息、stdout 持续吐事件、EOF 才退出。多轮同进程、session_id 不变 → `/compact` 真生效、
 * `--resume` 不断裂。
 *
 * - `start`(后端 `start_claude_session`):首启 / 崩溃恢复 / 换 mode / 批准重启 / 中断后续接。
 *   重启带 `--resume`(session_id 在后端 registry 不丢)。
 * - `send`(后端 `send_claude_message`):写 stdin 一条 stream-json user 消息。不 spawn。
 * - `interrupt`(后端 `kill_claude`):kill 整进程(headless 无中断信号)+ emit interrupted。
 *
 * 与 `TauriPtyTransport` 的同构点:
 * - 先 listen 再 invoke(防丢首批事件,见 `claude/commands.rs` 不变量 4)。
 * - `onEvents` 订阅时立即回放当前 state(切 tab 回来不丢,仿 `TauriPtyTransport.onOutput` 回放 transcript)。
 * - `sendingPromise` 去重(防并发,串行保证「上一轮 result/terminated 后才发下一轮」)。
 *
 * 差异点:
 * - 不走 PTY/不实现 TerminalTransport 接口(claudepane 是非 PTY pane,不进 AppShell 的 transportsRef 池,
 *   而是单独的 `claudeTransportsRef` 池,见 `AppShell`)。
 * - `send` 写 stdin(长进程),不每轮 spawn。
 * - 崩溃/中断后 `dead=true`,下次 `send` 触发 `ensureStarted` 重启(带 --resume)。
 * - messages 存 transport 实例(跨 ClaudePane unmount 存活),不存后端。
 */
export class ClaudeTransport {
  private readonly projectId: string;
  private readonly tabId: string;
  private unlisten: UnlistenFn | null = null;
  private state: ClaudeStreamState = initialClaudeState;
  private listeners = new Set<(state: ClaudeStreamState) => void>();
  /** rAF 节流 emit 的句柄:流式高频 delta 合并到下一帧一次 emit,避免每个 token 都整组件重渲染。 */
  private emitRafId: number | null = null;
  /** 进行中的 send/approve 串行去重(防并发 + 保证「上一轮结束才发下一轮」)。 */
  private sendingPromise: Promise<void> | null = null;
  /** 当前权限模式(claude --permission-mode),per tab 跟 transport 走。默认 acceptEdits(auto)。 */
  private mode: string = "acceptEdits";
  /** 项目根路径(claude 进程的 cwd)。start_claude_session 传它,使 claude 跑在该项目目录
   *  下(而非继承应用启动目录)。system init 回填的 meta.cwd 也据此正确,`!命令` 沿用 meta.cwd。 */
  private readonly cwd: string | null;
  /** 当前长进程实际跑的 mode。mode 变更不立刻重启(会打断当前轮);send 前若 mode!==activeMode
   *  才 kill+start(--resume)换 mode——即「下轮生效,不打断当前轮」(用户期望)。 */
  private activeMode: string = "acceptEdits";
  /** 当前 effort(claude --effort),per tab 跟 transport 走。undefined=auto(不传 flag)。 */
  private effort: string | undefined = undefined;
  /** 用户最后经 setModel 选的项(预置别名或自定义 id)。assistant 事件会把 meta.model 校正成
   *  解析后的真实 model(如 "fable" -> "GLM-5.2[1M]",代理把别名全映射到 GLM),据 meta.model 判断
   *  预置项高亮会全部失配。此字段让模型选择器记得「用户选了哪个别名」保持高亮,不进 state。 */
  private selectedModelAlias: string | null = null;
  /** 当前期望 model(claude --model,per tab 跟 transport 走)。null=不传 flag(claude 用默认)。
   *  --model 是启动 flag,运行中进程写 `/model <name>`(stdin local command)对后续轮次不可靠,
   *  须重启进程生效;setModel 置此标记 + idle 时立即重启(busy/未启时下次 ensureStarted 重启)。 */
  private model: string | null = null;
  /** 长进程实际跑的 model(start_claude_session 传过的最新 --model 值)。与 this.model 不一致
   *  时 ensureStarted 检测到 -> 重启换 model。 */
  private activeModel: string | null = null;
  /** 长进程实际跑的 effort。effort 变更不立刻重启;send 前若 effort!==activeEffort 才
   *  kill+start(--resume)换 effort(同 mode 语义:下轮生效,不打断当前轮)。 */
  private activeEffort: string | undefined = undefined;
  /** 长进程是否在跑(start_claude_session 成功 + 未 terminated)。 */
  private started = false;
  /** 进程已死(terminated eof/interrupted),下次 send 需 ensureStarted 重启。 */
  private dead = false;
  /** 进行中的首启 startSession(invoke start_claude_session)互斥句柄。打开 tab 的 start() 与
   *  用户首条 send() 可能并发各调 ensureStarted -> startSession,导致后端双 spawn(旧进程被
   *  take+kill,读循环 EOF 误发 terminated{eof} + 消息写进被 kill 的 stdin 丢失 -> 「发出去了
   *  但 claude 没任何输出」,且 status 被误发的 terminated 覆盖回 idle/error)。用此 promise
   *  串行化首启:并发方等在途首启完成再检查 started,避免重复 invoke。 */
  private startPromise: Promise<void> | null = null;
  /** 进行中的 listen 挂载互斥句柄。start() 与 send() 的 doSend 都调 ensureListening,若都看到
   *  unlisten=null 会挂两个 listener -> 每个事件 handleEvent 两次(thinking 文本翻倍等)。串行化。 */
  private listeningPromise: Promise<void> | null = null;
  /** clear() 后为 true:抑制此期间事件(init/replay assistant 等)将 status 设 running。
   * 用户发下一条消息(send/approveTool)时清。避免 /clear 的副作用事件导致 busy 死锁。 */
  private clearing = false;
  /** start()(打开 tab 主动启动)后为 true:claude 进程启动发 init,但此次 init 非对话轮(没写 stdin),
   *  applyEvent 会把 status 设 running -> 误显 busy。starting 期间 handleEvent 把 init 后的 status
   *  覆写 idle(握手非轮次),直到真正 send 写 stdin 才清。防 busy 死锁 + auto-interrupt 误触发。 */
  private starting = false;
  /** 当前轮 prompt(API error 重试时重发用)。send/approveTool 记录,clear 清 null。 */
  private lastPrompt: string | null = null;
  /** API error 自动重试状态。非 null=重试中。核心不变量:「timer 已武装(等待期)」与
   *  「sendingPromise 在途(重发中)」必居其一——否则 status 被覆写 running 会 busy 死锁。 */
  private retryState: {
    /** 已安排的第几次重试(1..RETRY_MAX_ATTEMPTS)。 */
    attempt: number;
    /** 重发的 prompt 快照(防等待期 lastPrompt 被新消息覆盖)。 */
    prompt: string;
    /** 退避定时器;null=重发在途(doSend 已发出,等 result)。 */
    timer: ReturnType<typeof setTimeout> | null;
    /** 下次重试触发时刻(ms epoch,UI 倒计时预留)。 */
    nextRetryAt: number;
  } | null = null;

  /** 注册到 claudeStatusRegistry 的 key(=transportKey(projectId,paneId,tabId))。transport 自身不
   *  持有 paneId,故由 AppShell 创建时传入完整 registryKey;emit 出口据此上报 summary 供 StatusBar
   *  跨 tab 汇总。空串=不注册(防御,正常路径 AppShell 必传)。 */
  private readonly registryKey: string;

  /** 首启 --resume 的 session_id(用户从 SessionBrowser 恢复历史会话时由 AppShell 注入)。
   *  仅首启生效:startSession 传给后端 start_claude_session 的 resume_session_id,成功后清空
   *  (重启走 registry 的 live claude_session_id,不再传)。 */
  private resumeSessionId: string | null = null;

  constructor(projectId: string, tabId: string, cwd?: string | null, registryKey = "") {
    this.projectId = projectId;
    this.tabId = tabId;
    this.cwd = cwd ?? null;
    this.registryKey = registryKey;
    if (registryKey) claudeStatusRegistry.register(registryKey, projectId, tabId);
  }

  /** 取当前权限模式(用户选择的,可能尚未生效到进程)。 */
  getMode(): string {
    return this.mode;
  }

  /** 补充 paneId 到全局状态注册表(transport 构造时不持有 paneId,AppShell 创建后补全,
   *  供 StatusBar onFocusClaudeTab 反查 pane)。 */
  setRegistryPaneId(paneId: string): void {
    if (this.registryKey) claudeStatusRegistry.setPaneId(this.registryKey, paneId);
  }

  /** 注入首启 --resume 的 session_id(AppShell 池化创建 transport 时调,从 pendingResumeRef 读)。
   *  仅首启生效:startSession 消费后清空。 */
  setResumeSessionId(sessionId: string): void {
    this.resumeSessionId = sessionId;
  }

  /**
   * 设置权限模式(下轮生效,不打断当前轮)。--permission-mode 是 claude 启动 flag,运行中改不了,
   * 只能重启进程换。这里只更新 `mode` 标记;下次 `send` 前 `ensureStarted` 检测 mode 变了
   * (mode!==activeMode)才 kill+start(--resume)换 mode。当前进行中的轮不受影响(跑完旧 mode)。
   */
  setMode(mode: string): void {
    this.mode = mode;
  }

  /** 当前 effort(供 UI 读)。undefined=auto(不传 --effort)。 */
  getEffort(): string | undefined {
    return this.effort;
  }

  /** 用户最后选的 model 项(别名或自定义 id,供选择器高亮)。null=尚未经 UI 选过(如新开 tab)。 */
  getSelectedModelAlias(): string | null {
    return this.selectedModelAlias;
  }

  /**
   * 设置 effort(下轮生效,不打断当前轮)。--effort 是 claude 启动 flag,运行中改不了,
   * 只能重启进程换。这里只更新 `effort` 标记 + 乐观回填 `meta.effort` 并 emit(状态栏即时
   * 反映期望值);下次 `send` 前 `ensureStarted` 检测 effort!==activeEffort 才 kill+start
   * (--resume)换 effort。当前进行中的轮不受影响(跑完旧 effort)。
   * 与 setMode 区别:setMode 不 emit(mode 不上抛状态栏);setEffort emit(effort 显示在状态栏)。
   */
  setEffort(level: string | undefined): void {
    this.effort = level;
    this.state = { ...this.state, meta: { ...this.state.meta, effort: level } };
    this.emit();
  }

  /** 订阅 state 变化。立即回放当前 state(切 tab 回来不丢)。返回取消订阅函数。 */
  onEvents(callback: (state: ClaudeStreamState) => void): () => void {
    const firstListener = this.listeners.size === 0;
    this.listeners.add(callback);
    callback(this.state); // 回放当前状态
    // 首次有订阅者时,若 meta.model 为空(detach 独立窗口新建 transport / 长进程未发 init),
    // 从后端 registry 回填当前 model(后端由 init / setModel / 真实 assistant 事件同步写入),
    // 使状态栏打开即显示当前 model,不等发消息触发 init。
    if (firstListener && !this.state.meta.model) {
      void this.hydrateModel();
    }
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * 从后端 `get_claude_session_model` 读当前会话 model,回填 `meta.model`。
   * 仅当当前 meta.model 为空时回填(不覆盖 init/setModel 已设的值;主窗口有 init 回填,此调用空操作)。
   * 供独立窗口(detach)新建 transport 用:长进程不重启则 init 不重发,meta.model 恒空。
   */
  private async hydrateModel() {
    try {
      const model = await invoke<string | null>("get_claude_session_model", {
        projectId: this.projectId,
        tabId: this.tabId,
      });
      if (model && !this.state.meta.model) {
        this.state = { ...this.state, meta: { ...this.state.meta, model } };
        this.emit();
      }
    } catch (err) {
      console.warn("[ClaudeTransport] hydrateModel failed:", err);
    }
  }

  /**
   * 同步当前 model 到后端 registry(`update_claude_session_model`,经 `set_claude_model` 命令)。
   * 供独立窗口 detach 后 hydrateModel 读。init 事件后端已自行写(run_read_loop),无需调;
   * 仅 setModel(前端乐观切换)与真实 assistant 事件(每轮校正)后调。失败静默(不阻断主流程)。
   */
  private async syncModelToBackend(model: string) {
    if (!model) return;
    try {
      await invoke("set_claude_model", {
        projectId: this.projectId,
        tabId: this.tabId,
        model,
      });
    } catch (err) {
      console.warn("[ClaudeTransport] syncModelToBackend failed:", err);
    }
  }

  /** 发送一条消息(写 stdin stream-json user 消息;进程未启/已死则先 ensureStarted)。 */
  async send(prompt: string): Promise<void> {
    console.log("[ClaudeTransport] send", { tabId: this.tabId, prompt: prompt.slice(0, 80), started: this.started, dead: this.dead, hasStartPromise: !!this.startPromise });
    if (this.sendingPromise) {
      // 上一轮还在路上,串行等待避免并发写 stdin 致 busy 错误。
      await this.sendingPromise.catch(() => {});
    }

    // 乐观:立即插入用户消息到 state(不等后端,UI 即时反馈)。
    // 用户发新消息:取消挂起的 API 重试(新意图优先),记录 lastPrompt(重试重发用);
    // clear 状态结束,appendUserMessage 设 running 正常驱动新轮。
    this.cancelRetry();
    this.lastPrompt = prompt;
    this.clearing = false;
    this.starting = false;
    this.state = appendUserMessage(this.state, prompt);
    this.emit();

    this.sendingPromise = this.doSend(prompt);
    try {
      await this.sendingPromise;
    } finally {
      this.sendingPromise = null;
    }
  }

  private async doSend(prompt: string, allowedTools?: string[]) {
    // 1) 先确保 listen 已挂(防丢首批事件)。listen 幂等(已有则跳过)。
    await this.ensureListening();
    // 2) 确保长进程在跑(首发/崩溃/中断后重启)。allowedTools 仅在 ensureStarted 实际启动时透传
    //    (批准重放);进程已在跑则忽略(allowlist 变更走 restart 路径)。
    // 3) 写 stdin。busy 时后端返回 Err(前端应先 interrupt)。
    // ensureStarted(startSession throw)/ send_claude_message 任何失败都统一 handleEvent(terminated),
    // 不向外 reject——避免 send/onRetryTimer 的 await 拿到 unhandled rejection,且让 terminated
    // 统一驱动重试(重发在途进程死/写失败时排下一次)。
    try {
      await this.ensureStarted(allowedTools);
      await invoke("send_claude_message", {
        projectId: this.projectId,
        tabId: this.tabId,
        prompt,
      });
    } catch (err) {
      this.handleEvent({
        kind: "terminated",
        reason: typeof err === "string" ? err : String(err),
      });
    }
  }

  /** 挂 listen(幂等,已有则跳过)。防丢首批事件(init 等)。 */
  private async ensureListening() {
    if (this.unlisten) return;
    // 互斥:start() 与 send() 的 doSend 都调本方法,若都看到 unlisten=null 会挂两个 listener
    // -> 每个事件 handleEvent 两次(thinking 文本翻倍等)。用 listeningPromise 串行:并发方等挂载完成。
    if (this.listeningPromise) {
      await this.listeningPromise;
      return;
    }
    this.listeningPromise = (async () => {
      this.unlisten = await listen<ClaudeEvent>("claude-event", (event) => {
        const { projectId, tabId, payload } = event.payload;
        if (projectId !== this.projectId || tabId !== this.tabId) return;
        this.handleEvent(payload);
      });
    })();
    try {
      await this.listeningPromise;
    } finally {
      this.listeningPromise = null;
    }
  }

  /**
   * 打开 tab 时主动启动 claude 进程(拿 init 回填 model/cwd/slashCommands 等,使状态栏打开即显示)。
   * 既有 lazy 启动(发消息才 spawn)改为打开即启动:先挂 listen(防丢 init)再 ensureStarted。
   * 失败统一 handleEvent(terminated)(如 claude 未装),不 reject。幂等(进程已在跑直接 return)。
   * 不写 stdin(纯启动等 init),故不会触发一轮对话。
   */
  async start(): Promise<void> {
    console.log("[ClaudeTransport] start() begin", { tabId: this.tabId, started: this.started, dead: this.dead });
    if (this.started && !this.dead) return; // 进程已在跑:init 早已发,无需启动,starting 保持 false。
    // 标记 starting:init 是启动握手非对话轮,handleEvent 据此把 init 后的 status 覆写 idle 防误显 busy。
    this.starting = true;
    try {
      await this.ensureListening();
      await this.ensureStarted();
    } catch (err) {
      this.handleEvent({
        kind: "terminated",
        reason: typeof err === "string" ? err : String(err),
      });
    } finally {
      // ensureStarted 已触发后端 spawn,init 异步到;但若 spawn 同步失败(terminated)或 init 迟到,
      // starting 不应悬挂。init 到达时 handleEvent 会清;这里兜底:spawn 失败时立即清。
      // 注意:不在此无条件清--init 可能尚未到(异步),需保持 starting 等 init。仅在 terminated 时清。
      if (this.dead) this.starting = false;
    }
  }

  /**
   * 确保长进程在跑且 mode 一致:if `!started || dead` → start(用 this.mode);
   * if `started && !dead && mode!==activeMode` → kill+start(--resume)换 mode(下轮生效语义)。
   * 首启 resume_id=None;重启后端自动带 --resume(session_id 在 registry)。
   */
  private async ensureStarted(allowedTools?: string[]) {
    // mode 变了(用户切 mode)且进程在跑 → kill 旧进程 + start --resume 用新 mode。
    // 不在 setMode 时立刻做(会打断当前轮),而是 defer 到下次 send 前:此时若上一轮还在跑,
    // busy 检查会拦 send,等上一轮跑完(result/Idle)后下次 send 才到这里 → 换 mode 不打断任何轮。
    if (
      this.started &&
      !this.dead &&
      (this.mode !== this.activeMode || this.effort !== this.activeEffort || this.model !== this.activeModel)
    ) {
      await this.restart(allowedTools);
      return;
    }
    if (this.started && !this.dead) return;
    // 互斥:若已有首启在途(打开 tab 的 start() 与用户首条 send() 并发各调 ensureStarted),
    // 等它完成再检查 started,避免双 invoke start_claude_session -> 后端双 spawn(旧进程被
    // take+kill,读循环 EOF 误发 terminated{eof} + 消息写进被 kill 的 stdin 丢失 -> 「发出去了
    // 但 claude 没任何输出」)。时好时坏的根因即此竞态(取决于发送是否落在 start 的 invoke 往返窗口)。
    if (this.startPromise) {
      console.log("[ClaudeTransport] ensureStarted: 等待在途首启(start/send 竞态去重)", { tabId: this.tabId });
      await this.startPromise.catch(() => {});
      if (this.started && !this.dead) return;
    }
    this.startPromise = this.startSession(allowedTools);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /** 实际启动新进程(首启或重启)。无旧进程在跑时调;有旧进程在跑应先 restart。
   *  失败只 throw(不 emit)——由调用方(doSend/restart 的 catch)统一 handleEvent(terminated),
   *  避免同一失败双重置 terminated。 */
  private async startSession(allowedTools?: string[]) {
    // resumeSessionId 仅首启传入(用户恢复历史会话);后端 start_claude_session 的 resume_session_id
    // 仅当无 persisted/live id 时生效。消费即清空(重启走 registry live id,不再传);消费时先
    // 回填历史(glm 代理 --resume 不重放历史,读 jsonl 注入消息流,见 backfillHistory)——必须
    // 在 spawn 前完成,保证历史先落、init/新轮事件全部 append 在后(顺序稳定)。
    const resumeSessionId = this.resumeSessionId;
    if (resumeSessionId) {
      this.resumeSessionId = null;
      await this.backfillHistory(resumeSessionId);
    }
    await invoke("start_claude_session", {
      projectId: this.projectId,
      tabId: this.tabId,
      cwd: this.cwd,
      permissionMode: this.mode,
      allowedTools: allowedTools ?? null,
      resumeSessionId: resumeSessionId ?? null,
      effort: this.effort ?? null,
      model: this.model ?? null,
    });
    this.started = true;
    this.dead = false;
    this.activeMode = this.mode;
    this.activeEffort = this.effort;
    this.activeModel = this.model;
  }

  /**
   * 恢复会话的历史回填(glm 代理 `--resume` 不重放历史的兜底;实测 glm 2.1.235 resume 后只推
   * init+本轮新事件,消息流空=用户「恢复没反应」)。读会话 jsonl(后端 `read_claude_history_events`,
   * 事件与实时流同构)重置 state 后批量注入 + history_resumed notice。
   *
   * 重置语义:清旧会话消息(↻ 切换会话时旧消息必须清,否则两会话消息混杂);meta.claudeSessionId
   * 置目标 id(init 回来时非 firstInit,不误置 running/busy);effort/model 保留用户选择。
   * 读取失败不阻断恢复(claude 内部上下文仍续接,可正常对话),仅插失败 notice。
   */
  private async backfillHistory(sessionId: string): Promise<void> {
    this.state = {
      ...initialClaudeState,
      meta: {
        effort: this.state.meta.effort,
        model: this.state.meta.model,
        claudeSessionId: sessionId,
      },
    };
    this.emit();
    let history = { count: 0, truncated: false, failed: true };
    try {
      const res = await invoke<{ events: ClaudeEventPayload[]; total: number }>(
        "read_claude_history_events",
        { sessionId },
      );
      history = {
        count: res.events.length,
        truncated: res.total > res.events.length,
        failed: false,
      };
      this.state = applyHistoryEvents(this.state, res.events, history);
    } catch (err) {
      console.warn("[ClaudeTransport] history backfill failed:", err);
      this.state = applyHistoryEvents(this.state, [], history);
    }
    this.emit();
  }

  /**
   * 重启长进程(kill + start --resume)。用于 mode 切换(ensureStarted 检测 mode 变)/ 批准拾取新 allowlist。
   * session 保留(--resume),compact 不断裂。
   * **不**自己等 sendingPromise(调用方 doSend/approveTool 已在 sendingPromise 内串行,避免自等死锁)。
   */
  private async restart(allowedTools?: string[]) {
    // kill 旧进程(后端 emit interrupted → handleEvent 置 dead)。
    try {
      await invoke("kill_claude", { projectId: this.projectId, tabId: this.tabId });
    } catch (err) {
      console.warn("[ClaudeTransport] restart kill failed:", err);
    }
    this.started = false;
    this.dead = true;
    // start 新进程(带 --resume,session_id 在 registry 不丢)。失败统一 handleEvent(terminated)。
    this.startPromise = this.startSession(allowedTools).catch((err) => {
      this.handleEvent({
        kind: "terminated",
        reason: `start failed: ${typeof err === "string" ? err : String(err)}`,
      });
    });
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * 批准一个被拒的工具调用(确认框「批准本次」/「批准且不再问」)。
   * persist=true 时先持久化到项目 allowlist(add_claude_allowed_tool),再 `restart` 拾取新 allowlist
   * (--allowedTools 是启动 flag,重启生效,session 保留),再发批准消息。
   * approveMsg 由组件层传 i18n 文案(transport 不依赖 i18n)。
   */
  async approveTool(tool: string, persist: boolean, approveMsg: string): Promise<void> {
    if (this.sendingPromise) {
      await this.sendingPromise.catch(() => {});
    }
    // 批准也是一轮新对话:取消挂起的 API 重试 + 记录 lastPrompt(重发用)+ clear 状态结束。
    this.cancelRetry();
    this.lastPrompt = approveMsg;
    this.clearing = false;
    this.starting = false;
    if (persist) {
      try {
        await invoke("add_claude_allowed_tool", { projectId: this.projectId, tool });
      } catch (err) {
        console.warn("[ClaudeTransport] add_claude_allowed_tool failed:", err);
      }
    }
    // 乐观插入批准消息保持对话完整。
    this.state = appendUserMessage(this.state, approveMsg);
    this.emit();
    // restart 拾取新 allowlist(persist 时持久化 allowlist 已含该工具;非 persist 透传 [tool]),
    // 再写 stdin 发批准消息。串行(restart 内部用 sendingPromise)。
    const toolsToAllow = persist ? undefined : [tool];
    this.sendingPromise = (async () => {
      await this.restart(toolsToAllow);
      try {
        await invoke("send_claude_message", {
          projectId: this.projectId,
          tabId: this.tabId,
          prompt: approveMsg,
        });
      } catch (err) {
        this.handleEvent({
          kind: "terminated",
          reason: typeof err === "string" ? err : String(err),
        });
      }
    })();
    try {
      await this.sendingPromise;
    } finally {
      this.sendingPromise = null;
    }
  }

  /**
   * 把工具结果作为 stream-json tool_result user 消息写 stdin(批准/拒绝被拒工具的原地回传)。
   * claude 像收到正常工具结果一样续跑下一 turn(claude cli 交互批准的同语义),**不插对话
   * 消息、不 restart**。置 running(新 turn 开始);失败统一 handleEvent(terminated)。
   */
  async sendToolResult(toolUseId: string, content: string, isError: boolean): Promise<void> {
    if (this.sendingPromise) {
      await this.sendingPromise.catch(() => {});
    }
    this.cancelRetry();
    this.lastPrompt = null;
    this.clearing = false;
    this.starting = false;
    this.state = { ...this.state, status: "running", terminatedReason: null };
    this.emit();
    this.sendingPromise = (async () => {
      try {
        await this.ensureListening();
        await invoke("send_claude_message", {
          projectId: this.projectId,
          tabId: this.tabId,
          prompt: "",
          toolResult: { toolUseId, content, isError },
        });
      } catch (err) {
        this.handleEvent({
          kind: "terminated",
          reason: typeof err === "string" ? err : String(err),
        });
      }
    })();
    try {
      await this.sendingPromise;
    } finally {
      this.sendingPromise = null;
    }
  }

  /**
   * 批准被拒的工具调用(确认框「批准本次/批准且不再问」):**本地执行该工具 + 结果经
   * tool_result 原地回传**,claude 无缝续跑--与 claude cli 交互批准同语义,不发「已批准请
   * 继续」对话消息。persist=true 持久化工具到项目 allowlist(下轮 spawn 生效,不重启当前
   * 进程)。执行链:Bash(PowerShell)/Edit(唯一匹配替换)/Write(后端 exec_claude_tool_local);
   * 未知工具或进程已死无法直写 stdin 等场景 -> 回退旧 approveTool(interrupt+restart+发消息
   * 重试,fallbackApproveMsg 由组件 i18n 传入)。
   */
  async approveToolRun(opts: {
    toolUseId: string;
    tool: string;
    input: unknown;
    persist: boolean;
    cwd: string | null;
    fallbackApproveMsg: string;
  }): Promise<void> {
    if (this.sendingPromise) {
      await this.sendingPromise.catch(() => {});
    }
    if (opts.persist) {
      try {
        await invoke("add_claude_allowed_tool", { projectId: this.projectId, tool: opts.tool });
      } catch (err) {
        console.warn("[ClaudeTransport] add_claude_allowed_tool failed:", err);
      }
    }
    // 进程已死(被拒后单轮退出/崩溃)时先 ensureStarted(--resume 续接,claude 上下文里
    // tool_use 仍在,tool_result 可配对),否则 stdin 写不进(后端 stdin=None 静默丢)。
    if (this.dead || !this.started) {
      try {
        await this.ensureStarted();
      } catch (err) {
        this.handleEvent({
          kind: "terminated",
          reason: `start failed: ${typeof err === "string" ? err : String(err)}`,
        });
        return;
      }
    }
    // UI 反馈:block 置执行中(本地执行可能耗时)。
    this.state = patchToolBlock(this.state, opts.toolUseId, { status: "running", resultContent: null });
    this.emit();
    let result: { output: string; isError: boolean };
    try {
      result = await invoke("exec_claude_tool_local", {
        tool: opts.tool,
        input: opts.input,
        cwd: opts.cwd,
      });
    } catch (err) {
      // 工具不支持本地执行(如 WebFetch)或框架失败:回退发消息重试方案(旧路径,不 persist
      // --persist 已在上方处理过)。
      console.warn("[ClaudeTransport] local exec unavailable, fallback to message:", err);
      return this.approveTool(opts.tool, false, opts.fallbackApproveMsg);
    }
    this.state = patchToolBlock(this.state, opts.toolUseId, {
      status: result.isError ? "error" : "done",
      resultContent: result.output,
    });
    this.emit();
    await this.sendToolResult(opts.toolUseId, result.output, result.isError);
  }

  /** 中断当前轮(kill 整进程)。后端 kill 后 emit Terminated{reason:"interrupted"} → dead。
   * 下次 send 自动 start(带 --resume,session 保留)续接。 */
  async interrupt(): Promise<void> {
    // 手动中断:先取消挂起的 API 重试(清定时器),再 kill。
    this.cancelRetry();
    try {
      await invoke("kill_claude", {
        projectId: this.projectId,
        tabId: this.tabId,
      });
    } catch (err) {
      console.warn("[ClaudeTransport] interrupt failed:", err);
    }
  }

  /**
   * 重置当前会话(右上角「重置」按钮):清屏(前端 state 归零但保留 meta.claudeSessionId,
   * 防 init 误判 firstInit 置 running)+ kill 长进程 + startSession 重启(走 registry 的
   * claude_session_id 自动带 --resume,session 续接)。与 /clear 的区别:clear 是进程内
   * local command 清上下文(进程不重启);reset 是进程级 kill+restart+--resume,UI 清屏、
   * claude 重载该 session 上下文。适合「卡住/状态错乱时重启会话」的场景。
   * 不回填历史(resumeSession 才回填;reset 走 registry live id,进程内 claude 自带上下文)。
   */
  async resetSession(): Promise<void> {
    this.cancelRetry();
    this.lastPrompt = null;
    this.starting = false;
    this.clearing = true; // 抑制 restart 期间 init 把 status 置 running
    // 清屏但保留 claudeSessionId(防 firstInit)+ effort/model(用户选择不丢)。
    this.state = {
      ...initialClaudeState,
      meta: {
        effort: this.state.meta.effort,
        model: this.state.meta.model,
        claudeSessionId: this.state.meta.claudeSessionId,
      },
    };
    this.emit();
    if (this.sendingPromise) {
      await this.sendingPromise.catch(() => {});
    }
    this.sendingPromise = (async () => {
      await this.restart();
    })();
    try {
      await this.sendingPromise;
    } finally {
      this.sendingPromise = null;
    }
  }

  /**
   * 清空会话(`/clear`):前端 state 归零 + 写 stdin `/clear`(local command,不 kill 进程)。
   * 走 send 路径(写 stdin),但不乐观插 "/clear" 消息(已清空)。进程保持长生命周期。
   */
  async clear(): Promise<void> {
    // /clear 是 local command,不进重试:取消挂起重试 + 清 lastPrompt。
    this.cancelRetry();
    this.lastPrompt = null;
    this.state = initialClaudeState;
    this.clearing = true;
    this.emit();
    if (this.sendingPromise) {
      await this.sendingPromise.catch(() => {});
    }
    this.sendingPromise = (async () => {
      await this.ensureStarted();
      try {
        await invoke("send_claude_message", {
          projectId: this.projectId,
          tabId: this.tabId,
          prompt: "/clear",
        });
      } catch (err) {
        console.warn("[ClaudeTransport] clear send /clear failed:", err);
      }
    })();
    try {
      await this.sendingPromise;
    } finally {
      this.sendingPromise = null;
    }
  }

  /**
   * 在当前 tab 恢复到指定历史 session(kill 旧进程已死可跳过 + 设 resumeSessionId +
   * 重新 startSession 带该 resume id 拉起进程 + 清 terminated 状态)。
   *
   * 与 setResumeSessionId 区别:后者仅注入 id 供**首启**消费(startSession 之前 transport 未启动);
   * 本方法面向「tab 已存在、进程已终止(eof/崩溃)或用户想切换到另一条历史会话」的场景--
   * 主动 kill + 用新 resume id 重新 spawn。↻ 弹窗在当前 tab 恢复时调,不再新建 tab。
   *
   * 失败统一 handleEvent(terminated),不向外 reject(与 send/restart 同策略)。
   */
  async resumeSession(sessionId: string): Promise<void> {
    // 取消挂起的 API 重试(若有)+ 清 starting/lastPrompt(非对话轮,防残留)。
    this.cancelRetry();
    this.lastPrompt = null;
    this.starting = false;
    this.clearing = false;
    if (this.sendingPromise) {
      await this.sendingPromise.catch(() => {});
    }
    this.sendingPromise = (async () => {
      // kill 旧进程(已终止则后端无 live session,kill 静默失败无所谓);置 dead 等 startSession 拉起。
      // 关键:覆写 resumeSessionId(此前首启可能已消费清空,或已终止 tab 的 registry live id
      // 已失效) -> startSession 带新 resume id spawn,拉起该历史会话的上下文。
      try {
        await invoke("kill_claude", { projectId: this.projectId, tabId: this.tabId });
      } catch (err) {
        console.warn("[ClaudeTransport] resumeSession kill failed:", err);
      }
      this.started = false;
      this.dead = true;
      this.resumeSessionId = sessionId;
      // 清 terminatedReason(init 事件本会清,但 init 迟到前先乐观清,避免「已终止」红字闪一下)。
      this.state = { ...this.state, terminatedReason: null };
      this.emit();
      await this.startSession();
    })();
    try {
      await this.sendingPromise;
    } finally {
      this.sendingPromise = null;
    }
  }

  /**
   * 若 `~/.claude/settings.json` 的 env 段自本会话 spawn 后已变化(cc-switch 切供应商等),重启
   * 长进程拾取新配置。仅 idle 调(busy 不打断轮次);重启带 --resume 保留 session,init 回填新
   * model -> 选择器「当前」与状态栏刷新。供 ClaudePane 模型选择器打开时调,实现「点切换模型
   * 即刷新 cc-switch 后的状态」。文件未变/未 spawn 过/busy/重启失败均静默。
   */
  async refreshIfSettingsChanged(): Promise<void> {
    if (!this.started || this.dead || this.sendingPromise) return;
    let changed: boolean;
    try {
      changed = await invoke<boolean>("claude_settings_changed", {
        projectId: this.projectId,
        tabId: this.tabId,
      });
    } catch (err) {
      console.warn("[ClaudeTransport] refreshIfSettingsChanged check failed:", err);
      return;
    }
    if (!changed) return;
    // 同 setModel 的重启语义:starting 让 init 握手不误显 busy。
    this.starting = true;
    this.sendingPromise = this.restart();
    try {
      await this.sendingPromise;
    } finally {
      this.sendingPromise = null;
    }
  }

  /**
   * 切换当前会话 model(--model 启动 flag,重启进程生效)。
   * 运行中进程写 `/model <name>`(stdin local command)对后续轮次不可靠(实测须重启 pane 才
   * 生效),故改为与 mode/effort 同语义的重启方案:置 `this.model` 标记 + 乐观更新 `meta.model`
   * 并 emit(状态栏立即反映),idle 时立即 restart(带 --resume,session 保留);busy 时组件层
   * 已先 interrupt,下次 send 的 ensureStarted 以新 --model 启动。
   */
  async setModel(name: string): Promise<void> {
    this.cancelRetry();
    this.lastPrompt = null;
    this.clearing = false;
    // 记住用户选择(供选择器高亮;meta.model 会被 assistant 事件校正成解析后的真实 id)。
    this.selectedModelAlias = name;
    // 设期望 model + 乐观更新状态栏(立即反映)。--model 是启动 flag:运行中进程写 `/model <name>`
    // (stdin local command)对后续轮次不可靠,须重启进程生效。idle 时立即 restart(session 经
    // --resume 保留);busy 时组件层已先 interrupt(dead=true),跳过,下次 send 的 ensureStarted
    // 以新 --model 启动。
    // "default" 归一为 null(不传 --model,claude 走默认即 ANTHROPIC_MODEL 配置);--model
    // 传字面 "default" 不是合法值。其余别名(default/sonnet/opus/haiku/fable)或自定义 id 原样传。
    this.model = name === "default" ? null : name;
    this.state = { ...this.state, meta: { ...this.state.meta, model: name } };
    this.emit();
    // 同步新 model 到后端(供独立窗口 detach 后 hydrateModel 读)。重启后 init 路径后端自写覆盖。
    void this.syncModelToBackend(name);
    if (this.started && !this.dead) {
      // 重启发的 init 是握手非对话轮:置 starting 让 handleEvent 把 init 后的 status 覆写 idle,
      // 防误显 busy(同 start() 的语义)。
      this.starting = true;
      if (this.sendingPromise) {
        await this.sendingPromise.catch(() => {});
      }
      this.sendingPromise = this.restart();
      try {
        await this.sendingPromise;
      } finally {
        this.sendingPromise = null;
      }
    }
  }

  /** 关闭 transport:取消 listen。不 kill 后端会话(由 AppShell 关 tab/项目时统一 invoke kill_claude)。 */
  stop(): void {
    // 关 tab/项目:清重试定时器,防对已 kill 会话 invoke。
    this.cancelRetry();
    if (this.emitRafId !== null) {
      cancelAnimationFrame(this.emitRafId);
      this.emitRafId = null;
    }
    this.starting = false;
    this.unlisten?.();
    this.unlisten = null;
    this.listeners.clear();
    // 注销全局状态注册表(StatusBar 计数减一)。transport 实例此后不再上报。
    if (this.registryKey) claudeStatusRegistry.unregister(this.registryKey);
  }

  private handleEvent(payload: ClaudeEventPayload) {
    // 长进程生命周期联动:init → started;terminated → dead(下次 send 重启)。
    if (payload.kind === "init") {
      console.log("[ClaudeTransport] init event", { model: payload.model, listeners: this.listeners.size, tabId: this.tabId });
      this.started = true;
      this.dead = false;
    } else if (payload.kind === "terminated") {
      this.started = false;
      this.dead = true;
      // API 重试联动:用户中断/主动重启 → 取消重试;重发在途进程死/写失败(doSend/startSession
      // catch 也走这里)→ 记为失败尝试,排下一次;等待期(timer 武装)进程死 → 保持不动,定时器
      // 触发后 ensureStarted --resume 重启再发。
      if (payload.reason === "interrupted") {
        this.cancelRetry();
      } else if (this.retryState && this.retryState.timer === null) {
        this.scheduleRetry(this.retryState.prompt, payload.reason);
      }
    } else if (payload.kind === "result") {
      // result 驱动重试:成功 → 取消(序列干净结束);失败 → scheduleRetry(内部四道闸判可重试/次数)。
      if (payload.success) {
        this.cancelRetry();
      } else {
        this.scheduleRetry(this.lastPrompt, payload.error ?? null);
      }
    }
    const prevModel = this.state.meta.model;
    this.state = applyEvent(this.state, payload);
    // 真实 assistant 事件校正了 meta.model(每轮回填实际跑的 model)-> 同步到后端,
    // 供独立窗口 detach 后 hydrateModel 读。init 路径后端自写,prevModel===model 时跳过避免空转。
    if (payload.kind === "assistant" && this.state.meta.model && this.state.meta.model !== prevModel) {
      void this.syncModelToBackend(this.state.meta.model);
    }
    // clearing 期间:clear() 后到下次用户发消息前,抑制事件(init/replay 等)将 status
    // 改为 running(applyEvent 正常行为),强制保持 idle。避免 /clear 的副作用事件
    // (如新 init)导致前端 busy → 下一条消息触发不必要的 interrupt。
    if (this.clearing) {
      this.state = { ...this.state, status: "idle" };
    }
    // starting 期间(start() 打开启动,init 非对话轮):init 把 status 设 running,覆写回 idle
    // 防误显 busy。真正 send 写 stdin 后 starting 已清,后续 init(重启)保持 running 正常。
    if (this.starting && payload.kind === "init") {
      this.state = { ...this.state, status: "idle" };
      this.starting = false;
    }
    // 重试中(retryState 非空):覆写 status=running 维持 busy(中断按钮可用),仿 clearing 覆写。
    // result error 会把 status 置 error,但重试期间覆写回 running;5 次用尽 cancelRetry 后不再覆写,
    // status=error 自然透出终止。
    if (this.retryState) {
      this.state = { ...this.state, status: "running" };
    }
    this.scheduleEmit();
  }

  /**
   * result error / 重发在途失败后安排重试(四道闸):
   * 1) prompt 为 null(无当前轮,如 /clear 后)→ 不重试;
   * 2) isRetryableApiError false(权限/输入类)→ cancelRetry,status=error 自然透出立即终止;
   * 3) next > RETRY_MAX_ATTEMPTS(已重试 5 次仍失败)→ cancelRetry 终态,status=error 透出;
   * 4) 否则清旧 timer(防御)、attempt+1、武装退避定时器(RETRY_DELAYS_MS 指数退避)。
   * 不自己 emit——均由 handleEvent 末尾统一 emit。
   */
  private scheduleRetry(prompt: string | null, errorText: string | null) {
    if (prompt == null) return;
    if (!isRetryableApiError(errorText)) {
      this.cancelRetry();
      return;
    }
    const next = (this.retryState?.attempt ?? 0) + 1;
    if (next > RETRY_MAX_ATTEMPTS) {
      this.cancelRetry();
      return;
    }
    if (this.retryState?.timer) {
      clearTimeout(this.retryState.timer);
    }
    const delay = RETRY_DELAYS_MS[next - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    const nextRetryAt = Date.now() + delay;
    // 先建 retryState(timer null),再武装定时器——维持「timer 武装 与 sendingPromise 在途 必居其一」。
    this.retryState = { attempt: next, prompt, timer: null, nextRetryAt };
    this.retryState.timer = setTimeout(() => void this.onRetryTimer(), delay);
  }

  /**
   * 退避定时器触发:守卫后重发 prompt 快照(走 doSend,不经 send、不 appendUserMessage——
   * 消息已在 state,重试只是重发同一条)。
   * 守卫:retryState 仍在(未被 cancel)且 rs.prompt === this.lastPrompt(等待期没发新消息)。
   */
  private async onRetryTimer() {
    const rs = this.retryState;
    if (!rs || rs.prompt !== this.lastPrompt) return;
    rs.timer = null; // 进入重发在途(不变量:timer 武装 → sendingPromise 在途)。
    if (this.sendingPromise) {
      await this.sendingPromise.catch(() => {});
    }
    this.sendingPromise = this.doSend(rs.prompt);
    try {
      await this.sendingPromise;
    } catch {
      // doSend 正常不 reject(内部 catch 统一 handleEvent);极端(listen 挂载失败)reject 时
      // 记为失败尝试排下一次,不变量不破。
      this.scheduleRetry(rs.prompt, "resend failed");
    } finally {
      this.sendingPromise = null;
    }
  }

  /** 取消重试:清定时器 + 置 null。不自己 emit(所有调用路径随后必有 emit)。 */
  private cancelRetry() {
    if (this.retryState?.timer) {
      clearTimeout(this.retryState.timer);
    }
    this.retryState = null;
  }

  /**
   * rAF 节流 emit:同帧多次 scheduleEmit 只在下一帧执行一次 emit(通知 UI 最新 state)。
   * 仅用于 handleEvent 流式高频路径(delta 每 token 一个事件,不节流则每 token 触发整组件重渲染)。
   * applyEvent 仍逐事件顺序归并 this.state(无丢失),节流只推迟「通知 UI」时机 -> UI 看到帧内最新快照。
   * 低频路径(订阅回放/clear/kill/send/hydrateModel)直接 emit 保持即时。窗口隐藏 rAF 暂停,重显后补发。
   */
  private scheduleEmit(): void {
    if (this.emitRafId !== null) return;
    this.emitRafId = requestAnimationFrame(() => {
      this.emitRafId = null;
      this.emit();
    });
  }

  private emit() {
    // retry 由 transport 维护(非事件驱动,后端无对应事件),emit 出口统一合并,
    // 保证回调拿到的 state 与 transport 当前值一致(无论直接 emit 还是 handleEvent 路径)。
    const state = { ...this.state, retry: this.retrySnapshot() };
    for (const cb of this.listeners) {
      cb(state);
    }
    // 上报对外汇总语义到全局 registry(供 StatusBar 跨 tab 汇总)。StatusBar 路径不融合 shell
    // (shell 是用户主动 `!` 命令非 AI 会话)、不传 resolvedApprovals(无组件态) -> waiting 仅看
    // hasPendingPlan;tab chip 由 ClaudePane 自带订阅(含 shell/resolvedApprovals)更精确。
    if (this.registryKey) {
      claudeStatusRegistry.update(this.registryKey, summarize(state));
    }
  }

  /** retryState → state.retry 快照(UI 显示「重试 n/max」用)。 */
  private retrySnapshot() {
    const rs = this.retryState;
    return rs
      ? { attempt: rs.attempt, maxAttempts: RETRY_MAX_ATTEMPTS, nextRetryAt: rs.nextRetryAt }
      : null;
  }
}
