import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import {
  type CodexEvent,
  type CodexEventPayload,
  type CodexStreamState,
  appendUserMessage,
  applyEvent,
  initialCodexState,
} from "./codexStream";
import { summarize } from "./codexStream";
import type { CodexBlock, CodexMessage } from "./codexStream";
import { codexStatusRegistry } from "./codexStatusRegistry";
import { DEFAULT_CODEX_PERMISSION } from "./codexPermission";
import { DEFAULT_CODEX_SANDBOX } from "./codexSandbox";
import {
  fetchAiCliSessionMessages,
  fetchAiCliSessions,
  mostRecentSessionInCwd,
  type AiCliSessionMessage,
} from "./aiCliSessions";

/** 全模块共享:已被某 tab 自动认领的会话 id(同 cwd 多 tab 首启恢复时先认领的拿最近一条,
 *  后恢复的取次近,避免两个 thread/resume 挂同一会话)。与 ClaudeTransport 同构。 */
const autoResumedSessionIds = new Set<string>();

/** AiCliSessionMessage(rollout 裁剪形态)→ CodexMessage(粗粒度回显:user 文本 /
 *  assistant 文本 + 工具卡简形;thinking 历史侧本就不解析)。空行跳过。 */
function codexHistoryRowsToMessages(rows: AiCliSessionMessage[]): CodexMessage[] {
  const out: CodexMessage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.role === "user") {
      if (!r.text.trim()) continue;
      out.push({
        id: `hist-u-${i}`,
        role: "user",
        blocks: [{ type: "text", text: r.text }],
        timestamp: r.timestamp,
        streaming: false,
      });
      continue;
    }
    const blocks: CodexBlock[] = [];
    if (r.text.trim()) blocks.push({ type: "text", text: r.text });
    if (r.toolUse) {
      blocks.push({
        type: "tool_use",
        id: `hist-t-${i}`,
        name: r.toolUse.name,
        inputBrief: r.toolUse.inputBrief,
        input: { command: r.toolUse.inputBrief },
        result: r.toolResult ? { content: r.toolResult, isError: false } : null,
        status: "done",
      });
    }
    if (blocks.length === 0) continue;
    out.push({
      id: `hist-a-${i}`,
      role: "assistant",
      blocks,
      timestamp: r.timestamp,
      streaming: false,
    });
  }
  return out;
}

/**
 * codex 自渲染对话的 transport(仿 `ClaudeTransport` 但**大幅简化**)。
 *
 * 每个实例对应一个 codexpane tab:绑定 (projectId, tabId),listen 全局 `codex-event` 事件按
 * (projectId, tabId) 路由 -> `applyEvent` 归并成本地 `state` -> 经 `onEvents` 回调通知 UI。
 *
 * **进程模型(2026-11-03 起 app-server 长连接)**:一个 tab = 一个常驻 `codex app-server`
 * (JSON-RPC over stdio);`send` = invoke `send_codex_message`(后端 ensure 进程 →
 * thread/start|resume → turn/start),轮间上下文进程内常驻,流式 delta/实时审批/权威用量
 * 由后端读循环 emit。故:
 * - **model/reasoning/sandbox/permission 切换 = 下一轮 turn/start per-turn override 即生效**
 *   (0.166:「for this turn and subsequent turns」),无需重启进程、不打断当前轮、上下文保留。
 *   setXxx 仅更新标记 + 乐观回填 meta + emit。供应商切换(config.toml 变)由后端哈希检测
 *   杀进程重拉 + resume 续接。
 * - 无 `clear()`(codex 无 /clear local command);`newSession()`(前端 /new)= 清 state +
 *   下轮 send 传 newSession=true(后端 thread/start 开新会话)。
 * - 无 API error 自动重试(claude 有 retryState);API error 直接显 error,用户重发。
 * - 审批走 `respondApproval`(app-server 实时审批帧;exec 时代的 -s 拦截已废弃)。
 *
 * 保留的同构点(防坑,与 ClaudeTransport 同源):
 * - 先 listen 再 invoke(防丢首批事件)。
 * - `onEvents` 订阅时立即回放当前 state(切 tab 回来不丢)。
 * - `sendingPromise` 串行去重;`listeningPromise` 互斥(防双 listener 事件翻倍)。
 * - rAF 节流 emit(高频 item 事件合并到下一帧)。
 * - messages 存 transport 实例(跨 CodexPane unmount 存活),不存后端。
 */
export class CodexTransport {
  private readonly projectId: string;
  private readonly tabId: string;
  private unlisten: UnlistenFn | null = null;
  private state: CodexStreamState = initialCodexState;
  private listeners = new Set<(state: CodexStreamState) => void>();
  /** rAF 节流 emit 的句柄。 */
  private emitRafId: number | null = null;
  /** 进行中的 send 串行去重(防并发 invoke)。 */
  private sendingPromise: Promise<void> | null = null;
  /** 进行中的 listen 挂载互斥句柄(防双 listener)。 */
  private listeningPromise: Promise<void> | null = null;
  /** 项目根路径(codex exec 的 -C 参数)。 */
  private readonly cwd: string | null;
  /** 期望 model(codex -m,catalog slug)。null=不传(config.toml 默认)。下轮 spawn 生效。 */
  private model: string | null = null;
  /** 用户最后选的 model 项(供选择器高亮;meta.model 会被 config 回填覆盖)。 */
  private selectedModelAlias: string | null = null;
  /** 期望 reasoning effort(codex -c model_reasoning_effort)。undefined=不传(模型默认档)。 */
  private reasoningEffort: string | undefined = undefined;
  /** sandbox 策略(codex -s)。初始 = DEFAULT_CODEX_SANDBOX(每 tab 状态栏可切,全局默认档设置已移除)。 */
  private sandbox: string = DEFAULT_CODEX_SANDBOX;
  /** Codex `/permissions` 四档 profile,下一轮 exec 映射为 CLI 参数。 */
  private permission: string = DEFAULT_CODEX_PERMISSION;
  /** 首轮 --resume 的 session_id(用户从 SessionBrowser 恢复历史会话时注入,消费后清空)。 */
  private resumeSessionId: string | null = null;
  /** 首启默认恢复「本 cwd 最近一条历史会话」(AppShell 对 hydrate 恢复的 tab 启用;用户本会话
   *  手动新建的 tab 不启用,保持全新会话)。onEvents 首订阅/首轮 send 消费一次即清;失败/
   *  无历史则全新 thread。 */
  private autoResumeLatest = false;
  /** 进行中的 auto-resume(首订阅与首轮 send 并发触发时共用同一 promise,防双拉/漏等)。 */
  private autoResumePromise: Promise<void> | null = null;
  /** 回填令牌:连续恢复(快速连点 ↻)时旧回填的 await 后写入作废,后到的赢。 */
  private backfillToken = 0;
  /** 首轮 send 标记(auto-resume 只在首轮生效)。 */
  private firstSendDone = false;
  /** newSession() 后置 true:下次 send 传 newSession=true(后端不带 resume、开新会话)。 */
  private pendingNewSession = false;
  /** 注册到 codexStatusRegistry 的 key(空串=不注册,正常由 AppShell 传入)。 */
  private readonly registryKey: string;

  constructor(projectId: string, tabId: string, cwd?: string | null, registryKey = "") {
    this.projectId = projectId;
    this.tabId = tabId;
    this.cwd = cwd ?? null;
    this.registryKey = registryKey;
    if (registryKey) codexStatusRegistry.register(registryKey, projectId, tabId);
    this.loadPrefs();
  }

  // —— per-tab 参数持久化(localStorage)——
  // transport 是内存态,重开 tab / 重启应用即回默认,用户选过的权限/沙箱/模型/推理档
  // 丢失(2026-11-04 用户报「重开就还是 ask」)。tabId 在 pane tree 里稳定(state.json
  // 落盘),按 (projectId, tabId) 存 localStorage 跨重启恢复。坏数据静默忽略。

  private prefsKey(): string {
    return `mx.codexPrefs.v1.${this.projectId}.${this.tabId}`;
  }

  private loadPrefs(): void {
    try {
      const raw = localStorage.getItem(this.prefsKey());
      if (!raw) return;
      const p = JSON.parse(raw) as {
        model?: string | null;
        reasoningEffort?: string;
        permission?: string;
        sandbox?: string;
      };
      if (p.model !== undefined) this.model = p.model;
      if (p.reasoningEffort) this.reasoningEffort = p.reasoningEffort;
      if (p.permission) this.permission = p.permission;
      if (p.sandbox) this.sandbox = p.sandbox;
    } catch {
      // 坏 JSON / 隐私模式写不进:忽略,走默认档。
    }
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(
        this.prefsKey(),
        JSON.stringify({
          model: this.model,
          reasoningEffort: this.reasoningEffort,
          permission: this.permission,
          sandbox: this.sandbox,
        }),
      );
    } catch {
      // 写失败(配额/隐私模式)不致命:只影响下次打开的记忆。
    }
  }

  /** 补充 paneId 到全局状态注册表(AppShell 创建后补全)。 */
  setRegistryPaneId(paneId: string): void {
    if (this.registryKey) codexStatusRegistry.setPaneId(this.registryKey, paneId);
  }

  /** 注入首轮 resume 的 session_id(SessionBrowser / handleResumeSession 新建 tab 恢复历史
   *  会话)。仅首轮消费,send 后清空;同时立即回填该会话历史——打开 tab 即见消息流,不用等
   *  首轮 send(2026-11-04 用户报「恢复后页面默认空白」)。 */
  setResumeSessionId(sessionId: string): void {
    this.resumeSessionId = sessionId;
    void this.backfillHistory(sessionId);
  }

  /** 启用「默认恢复最近会话」:打开 tab(onEvents 首订阅)/首轮 send 时若未注入显式 resume
   *  id,自动拉本 cwd 最近一条历史会话接续(AppShell 对 hydrate 恢复的 tab 调;与
   *  setResumeSessionId 互斥,显式优先)。 */
  enableAutoResumeLatest(): void {
    this.autoResumeLatest = true;
  }

  /**
   * 默认恢复:拉本 cwd 最近一条 codex 会话 → 注入 resume id + 回填历史。幂等并发安全
   * (共用同一 promise);首订阅触发后 send 再调直接等同一 promise,首轮发消息时 resume id
   * 已就位(不会「页面回了历史但下轮 thread/start 开了新会话」)。
   */
  private resolveAutoResume(): Promise<void> {
    if (this.autoResumePromise) return this.autoResumePromise;
    if (!this.autoResumeLatest || this.resumeSessionId || this.pendingNewSession) return Promise.resolve();
    this.autoResumeLatest = false;
    this.autoResumePromise = (async () => {
      try {
        const list = await fetchAiCliSessions(this.cwd ?? "", "codex");
        const top = mostRecentSessionInCwd(list, this.cwd, autoResumedSessionIds);
        if (top?.sessionId && !this.pendingNewSession) {
          autoResumedSessionIds.add(top.sessionId);
          this.resumeSessionId = top.sessionId;
          await this.backfillHistory(top.sessionId);
          console.log("[CodexTransport] auto-resume latest session", {
            tabId: this.tabId,
            sessionId: top.sessionId,
          });
        }
      } catch (err) {
        console.warn("[CodexTransport] auto-resume latest failed, start fresh:", err);
      }
    })().finally(() => {
      this.autoResumePromise = null;
    });
    return this.autoResumePromise;
  }

  /** 当前期望 model(null=config.toml 默认)。 */
  getModel(): string | null {
    return this.model;
  }

  /** 用户最后选的 model 项(供选择器高亮)。 */
  getSelectedModelAlias(): string | null {
    return this.selectedModelAlias;
  }

  /** 当前 reasoning effort(undefined=模型默认)。 */
  getReasoning(): string | undefined {
    return this.reasoningEffort;
  }

  /** 当前 sandbox 策略。 */
  getSandbox(): string {
    return this.sandbox;
  }

  getPermission(): string {
    return this.permission;
  }

  setPermission(mode: string): void {
    this.permission = mode;
    this.state = { ...this.state, meta: { ...this.state.meta, permission: mode } };
    this.savePrefs();
    this.emit();
  }

  setContextWindow(window?: number): void {
    this.state = { ...this.state, meta: { ...this.state.meta, contextWindow: window } };
    this.emit();
  }

  /**
   * 切换 model(codex -m,**下轮 spawn 生效,不打断当前轮**)。
   * 与 claude 的重启方案不同:codex 每轮新进程,下轮 spawn 自然用新 -m,无需 kill+resume。
   * 这里只更新标记 + 乐观回填 meta.model 并 emit(状态栏即时反映),并同步后端 registry
   * (供 detach 窗口 get_codex_session_model 回填)。
   */
  setModel(slug: string): void {
    this.selectedModelAlias = slug;
    this.model = slug === "default" ? null : slug;
    this.state = { ...this.state, meta: { ...this.state.meta, model: slug } };
    this.savePrefs();
    this.emit();
    void this.syncModelToBackend(slug);
  }

  /**
   * 切换 reasoning effort(codex -c model_reasoning_effort,下轮 spawn 生效)。
   * 只更新标记 + 乐观回填 meta.reasoningEffort 并 emit。
   */
  setReasoning(level: string | undefined): void {
    this.reasoningEffort = level;
    this.state = { ...this.state, meta: { ...this.state.meta, reasoningEffort: level } };
    this.savePrefs();
    this.emit();
  }

  /**
   * 切换 sandbox 策略(codex -s,下轮 spawn 生效)。read-only 下写操作被拦(前端显 denied 药丸),
   * danger-full-access 全放行。乐观回填 meta.sandbox 并 emit。
   */
  setSandbox(mode: string): void {
    this.sandbox = mode;
    this.state = { ...this.state, meta: { ...this.state.meta, sandbox: mode } };
    this.savePrefs();
    this.emit();
  }

  /** 订阅 state 变化。立即回放当前 state(切 tab 回来不丢)。返回取消订阅函数。 */
  onEvents(callback: (state: CodexStreamState) => void): () => void {
    const firstListener = this.listeners.size === 0;
    this.listeners.add(callback);
    callback(this.state);
    // 首次订阅时 meta.model 为空 -> 从后端回填(spawn 写 registry 的 -m 值或 config.toml 默认),
    // 使状态栏打开即显示当前 model(codex 事件流不带 model 字段,与 claude init 回填不同)。
    if (firstListener) {
      if (!this.state.meta.model) void this.hydrateModel();
      // 打开 tab 即默认恢复(hydrate 恢复的 tab):不等首轮 send,历史消息流立刻回显。
      void this.resolveAutoResume();
    }
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * 从后端回填当前 model:get_codex_session_model(已 spawn 过) -> 兜底 get_codex_current_model
   * (config.toml 顶层 model,tab 打开未发过消息时)。仅当 meta.model 为空时回填。
   */
  private async hydrateModel() {
    try {
      let model = await invoke<string | null>("get_codex_session_model", {
        projectId: this.projectId,
        tabId: this.tabId,
      });
      if (!model) {
        model = await invoke<string | null>("get_codex_current_model");
      }
      if (model && !this.state.meta.model) {
        this.state = { ...this.state, meta: { ...this.state.meta, model } };
        this.emit();
      }
    } catch (err) {
      console.warn("[CodexTransport] hydrateModel failed:", err);
    }
  }

  /** 同步当前 model 到后端 registry(detach 窗口 hydrateModel 读)。失败静默。 */
  private async syncModelToBackend(model: string) {
    if (!model) return;
    try {
      await invoke("set_codex_session_model", {
        projectId: this.projectId,
        tabId: this.tabId,
        model,
      });
    } catch (err) {
      console.warn("[CodexTransport] syncModelToBackend failed:", err);
    }
  }

  /** 发送一条消息(spawn 一轮 codex exec;busy 时组件层先 interrupt)。 */
  async send(prompt: string): Promise<void> {
    if (this.sendingPromise) {
      await this.sendingPromise.catch(() => {});
    }
    // 首轮:等默认恢复完成(拉取/回填在乐观插入用户消息**之前**——backfill 会重置 state,
    // 顺序反了会把刚插入的消息清掉;onEvents 首订阅多半已触发,这里 await 同一 promise
    // 兜底「打开后立刻发消息,列表还没拉回来」的场景)。失败/无历史降级全新 thread。
    if (!this.firstSendDone) {
      this.firstSendDone = true;
      await this.resolveAutoResume();
    }
    // 乐观:立即插入用户消息(不等后端,UI 即时反馈)。
    this.state = appendUserMessage(this.state, prompt);
    this.emit();
    const isNewSession = this.pendingNewSession;
    this.pendingNewSession = false;
    this.sendingPromise = this.doSend(prompt, isNewSession);
    try {
      await this.sendingPromise;
    } finally {
      this.sendingPromise = null;
    }
  }

  /**
   * 历史回填:后端 `get_ai_cli_session_messages`(codex rollout 裁剪形态)转粗粒度
   * CodexMessage 注入。与 claude 的 backfillHistory 同目的——thread/resume(excludeTurns)
   * 不重放历史,消息流空 = 用户「恢复没反应」。重置 state(meta 保留 sessionId + 用户偏好,
   * 保留 sessionId 让 ↻ 重置/状态栏正确);读取失败不阻断恢复(上下文仍续接,可正常对话)。
   * backfillToken 防陈旧写入:连续恢复(快速连点 ↻)时先到的回填作废,后到的赢。
   */
  private async backfillHistory(sessionId: string): Promise<void> {
    const token = ++this.backfillToken;
    this.state = { ...initialCodexState, meta: { ...this.state.meta, sessionId }, status: "idle" };
    this.emit();
    try {
      const rows = await fetchAiCliSessionMessages(this.cwd ?? "", "codex", sessionId);
      if (token !== this.backfillToken) return; // 已被更新的恢复操作取代
      if (rows.length > 0) {
        this.state = { ...this.state, messages: codexHistoryRowsToMessages(rows) };
        this.emit();
      }
    } catch (err) {
      console.warn("[CodexTransport] history backfill failed:", err);
    }
  }

  /**
   * 开新会话(/new):前端清 state + 下轮 send 传 newSession=true(后端不带 resume、
   * thread.started 回填新 session id)。
   */
  newSession(): void {
    this.resumeSessionId = null;
    this.autoResumeLatest = false; // 用户明确开新:防 auto-resume 残留
    this.pendingNewSession = true;
    this.state = initialCodexState;
    this.emit();
  }

  /**
   * 重置当前会话(右上角「重置」按钮):中断当前轮 + 清屏 + 用当前 thread 的 session id
   * 重新 resume。codex 每轮是短命 exec,但后端仍会把运行中的 child 标记为 busy,所以
   * 必须先 interrupt,否则清屏后下一条消息会被后端以「session busy」拒绝。
   * 与 newSession 的区别:new 开全新 thread(上下文丢弃);reset 清屏但续接同 thread。
   */
  async resetSession(): Promise<void> {
    const sid = this.state.meta.sessionId;
    if (!sid) {
      // 无会话 id(从未发过消息):等同 newSession(下轮开新 thread)。
      this.newSession();
      return;
    }

    // 先杀掉后端仍在运行的 exec。即使前端状态已经是 idle,后端也可能尚未处理完
    // 上一轮 EOF,因此这里不依赖本地 busy 判定。
    const inFlightSend = this.sendingPromise;
    await this.interrupt();
    if (inFlightSend) await inFlightSend.catch(() => {});

    this.state = {
      ...initialCodexState,
      meta: {
        ...this.state.meta,
        // 保留 sessionId/model/reasoning 等;清消息与轮次状态。
      },
    };
    this.resumeSessionId = sid;
    this.pendingNewSession = false;
    this.emit();
  }

  /**
   * 在当前 tab 恢复到指定历史 session(↻ 弹窗):设 resumeSessionId(下次 send 带它续接该
   * thread)+ 清 pendingNewSession(防 /new 残留导致开新会话)+ **立即回填该会话历史**——
   * 此前只记 id 不回显,恢复后页面空白(2026-11-04 用户报)。切换会话语义:旧消息清空
   * (与 claude backfillHistory 的「↻ 切换会话时旧消息必须清」同口径),回填失败静默
   * (上下文仍续接,可正常对话)。auto-resume 未消费时作废(显式恢复优先)。
   */
  resumeSession(sessionId: string): void {
    this.resumeSessionId = sessionId;
    this.pendingNewSession = false;
    this.autoResumeLatest = false;
    void this.backfillHistory(sessionId);
    this.emit();
  }

  private async doSend(prompt: string, isNewSession: boolean) {
    await this.ensureListening();
    const resumeSessionId = isNewSession ? null : this.resumeSessionId;
    try {
      await invoke("send_codex_message", {
        projectId: this.projectId,
        tabId: this.tabId,
        cwd: this.cwd,
        prompt,
        sandbox: this.sandbox,
        permission: this.permission,
        model: this.model,
        reasoningEffort: this.reasoningEffort ?? null,
        resumeSessionId,
        newSession: isNewSession,
      });
      // 消费掉一次性 resume 注入(SessionBrowser 恢复);后续轮走后端 registry live id。
      if (!isNewSession) this.resumeSessionId = null;
    } catch (err) {
      this.handleEvent({
        kind: "terminated",
        reason: typeof err === "string" ? err : String(err),
      });
    }
  }

  /** 挂 listen(幂等,互斥)。防丢首批事件。 */
  private async ensureListening() {
    if (this.unlisten) return;
    if (this.listeningPromise) {
      await this.listeningPromise;
      return;
    }
    this.listeningPromise = (async () => {
      this.unlisten = await listen<CodexEvent>("codex-event", (event) => {
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
   * 中断当前轮(app-server:turn/interrupt,失败回退杀进程)。后端 emit
   * Terminated{interrupted} -> state 复位 idle(pendingApproval 一并撤)。
   */
  async interrupt(): Promise<void> {
    try {
      await invoke("kill_codex", { projectId: this.projectId, tabId: this.tabId });
    } catch (err) {
      console.warn("[CodexTransport] interrupt failed:", err);
    }
  }

  /**
   * 审批响应(approval_requested 卡的允许/拒绝):invoke respond_codex_approval,后端按
   * pending_server_requests[key] 的原始 id 回写 decision(app-server 0.166:新代
   * item/commandExecution、item/fileChange、item/permissions 的 requestApproval 用
   * accept/decline,旧代 execCommandApproval/applyPatchApproval 用
   * approved/{denied:{rejection}}),并广播 approval_resolved(前端撤卡)。
   * 请求已失效(超时/他端已答)时后端 Err → 本地兜底清 pendingApproval 撤卡(等不到
   * approval_resolved,不清会永远悬空挡视线),返回 false 不重试。
   */
  /** 回审批决策。`forSession`=「本会话允许」(新代 acceptForSession;旧代退化成普通批准)。
   *  响应后本地乐观清卡(与 claude respondPermission 同语义;approval_resolved 广播是
   *  多视图同步兜底,幂等)。失败路径同样清——等不到广播不清会永远悬空挡视线。 */
  async respondApproval(requestKey: string, approved: boolean, forSession = false): Promise<boolean> {
    try {
      await invoke("respond_codex_approval", {
        projectId: this.projectId,
        tabId: this.tabId,
        requestKey,
        approved,
        forSession,
      });
    } catch (err) {
      console.warn("[CodexTransport] respondApproval failed:", err);
    }
    this.state = { ...this.state, pendingApproval: undefined };
    this.scheduleEmit();
    return true;
  }

  /**
   * 若 codex 配置(config.toml + cc-switch catalog)自上次 spawn 后已变化(cc-switch 切供应商),
   * 刷新 meta.model 显示。**与 claude 不同:codex 每轮新进程自动读最新 config,无需重启**--
   * 仅当用户未显式选过 model(selectedModelAlias 为空)时才用 config 默认值覆盖 meta.model。
   * 供 CodexPane 模型选择器打开时调(同时组件重拉 list_codex_models 刷新目录)。
   */
  async refreshIfConfigChanged(): Promise<void> {
    let changed: boolean;
    try {
      changed = await invoke<boolean>("codex_config_changed", {
        projectId: this.projectId,
        tabId: this.tabId,
      });
    } catch (err) {
      console.warn("[CodexTransport] refreshIfConfigChanged check failed:", err);
      return;
    }
    if (!changed) return;
    if (this.selectedModelAlias) return; // 用户显式选过:尊重选择,不覆盖。
    try {
      const model = await invoke<string | null>("get_codex_current_model");
      if (model) {
        this.state = { ...this.state, meta: { ...this.state.meta, model } };
        void this.syncModelToBackend(model);
        this.emit();
      }
    } catch (err) {
      console.warn("[CodexTransport] refreshIfConfigChanged refresh failed:", err);
    }
  }

  /** 关闭 transport:取消 listen。不 kill 后端会话(由 AppShell 关 tab/项目时统一 invoke kill_codex)。 */
  stop(): void {
    if (this.emitRafId !== null) {
      cancelAnimationFrame(this.emitRafId);
      this.emitRafId = null;
    }
    this.unlisten?.();
    this.unlisten = null;
    this.listeners.clear();
    if (this.registryKey) codexStatusRegistry.unregister(this.registryKey);
  }

  private handleEvent(payload: CodexEventPayload) {
    this.state = applyEvent(this.state, payload);
    this.scheduleEmit();
  }

  /** rAF 节流 emit:同帧多次事件只在下一帧执行一次 emit。 */
  private scheduleEmit(): void {
    if (this.emitRafId !== null) return;
    this.emitRafId = requestAnimationFrame(() => {
      this.emitRafId = null;
      this.emit();
    });
  }

  private emit() {
    for (const cb of this.listeners) {
      cb(this.state);
    }
    if (this.registryKey) {
      codexStatusRegistry.update(this.registryKey, summarize(this.state));
    }
  }
}
