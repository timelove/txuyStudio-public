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
import { codexStatusRegistry } from "./codexStatusRegistry";
import { DEFAULT_CODEX_SANDBOX } from "./codexSandbox";

/**
 * codex 自渲染对话的 transport(仿 `ClaudeTransport` 但**大幅简化**)。
 *
 * 每个实例对应一个 codexpane tab:绑定 (projectId, tabId),listen 全局 `codex-event` 事件按
 * (projectId, tabId) 路由 -> `applyEvent` 归并成本地 `state` -> 经 `onEvents` 回调通知 UI。
 *
 * **与 ClaudeTransport 的根本差异**:codex 无 stream-json 长进程(实测 codex-cli 0.147.0),
 * 进程模型是「每轮一个短命 `codex exec --json` + `codex exec resume <id>` 续接」。故:
 * - `send` = invoke `send_codex_message`(后端每轮 spawn 新进程),无 ensureStarted/restart。
 * - **model/reasoning/sandbox 切换 = 下一轮 spawn 用新参数**,无需重启进程/不打断当前轮
 *   (claude 必须 kill+resume 重启)。setXxx 仅更新标记 + 乐观回填 meta + emit。
 * - 无 `clear()`(codex 无 /clear local command);`newSession()`(前端 /new)= 清 state +
 *   下轮 send 传 newSession=true(后端不带 resume、开新会话)。
 * - 无 API error 自动重试(claude 有 retryState);codex exec API error 直接显 error,用户重发。
 * - 无 approveTool/rejectTool(codex exec 非交互审批,走 -s sandbox)。
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
  /** sandbox 策略(codex -s)。初始 = 构造传入的全局默认档(设置面板可改,持久化 state.json)。 */
  private sandbox: string;
  /** 首轮 --resume 的 session_id(用户从 SessionBrowser 恢复历史会话时注入,消费后清空)。 */
  private resumeSessionId: string | null = null;
  /** newSession() 后置 true:下次 send 传 newSession=true(后端不带 resume、开新会话)。 */
  private pendingNewSession = false;
  /** 注册到 codexStatusRegistry 的 key(空串=不注册,正常由 AppShell 传入)。 */
  private readonly registryKey: string;

  constructor(projectId: string, tabId: string, cwd?: string | null, registryKey = "", defaultSandbox?: string) {
    this.projectId = projectId;
    this.tabId = tabId;
    this.cwd = cwd ?? null;
    this.registryKey = registryKey;
    this.sandbox = defaultSandbox ?? DEFAULT_CODEX_SANDBOX;
    if (registryKey) codexStatusRegistry.register(registryKey, projectId, tabId);
  }

  /** 补充 paneId 到全局状态注册表(AppShell 创建后补全)。 */
  setRegistryPaneId(paneId: string): void {
    if (this.registryKey) codexStatusRegistry.setPaneId(this.registryKey, paneId);
  }

  /** 注入首轮 resume 的 session_id(SessionBrowser 恢复历史会话)。仅首轮消费,send 后清空。 */
  setResumeSessionId(sessionId: string): void {
    this.resumeSessionId = sessionId;
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
    this.emit();
  }

  /**
   * 切换 sandbox 策略(codex -s,下轮 spawn 生效)。read-only 下写操作被拦(前端显 denied 药丸),
   * danger-full-access 全放行。乐观回填 meta.sandbox 并 emit。
   */
  setSandbox(mode: string): void {
    this.sandbox = mode;
    this.state = { ...this.state, meta: { ...this.state.meta, sandbox: mode } };
    this.emit();
  }

  /** 订阅 state 变化。立即回放当前 state(切 tab 回来不丢)。返回取消订阅函数。 */
  onEvents(callback: (state: CodexStreamState) => void): () => void {
    const firstListener = this.listeners.size === 0;
    this.listeners.add(callback);
    callback(this.state);
    // 首次订阅时 meta.model 为空 -> 从后端回填(spawn 写 registry 的 -m 值或 config.toml 默认),
    // 使状态栏打开即显示当前 model(codex 事件流不带 model 字段,与 claude init 回填不同)。
    if (firstListener && !this.state.meta.model) {
      void this.hydrateModel();
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
   * 开新会话(/new):前端清 state + 下轮 send 传 newSession=true(后端不带 resume、
   * thread.started 回填新 session id)。
   */
  newSession(): void {
    this.resumeSessionId = null;
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
   * 在当前 tab 恢复到指定历史 session:设 resumeSessionId(下次 send 带它续接该 thread)+
   * 清 terminatedReason(消「已终止」红字)+ 清 pendingNewSession(防 /new 残留导致开新会话)。
   *
   * codex 无长进程(每轮短命 exec),「恢复」即下次发消息时带上 resume id,与 claude 的「立即
   * 重启拉起」不同。↻ 弹窗在当前已终止 tab 恢复时调,不再新建 tab。state 消息暂不清空--
   * 让用户能看到「恢复到 session X」之前的上下文,下轮发消息后端会 resume 该 thread。
   */
  resumeSession(sessionId: string): void {
    this.resumeSessionId = sessionId;
    this.pendingNewSession = false;
    this.state = { ...this.state, terminatedReason: null, status: "idle" };
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
   * 中断当前轮(kill 当前 exec 进程树)。后端 emit Terminated{interrupted} -> state 复位 idle。
   */
  async interrupt(): Promise<void> {
    try {
      await invoke("kill_codex", { projectId: this.projectId, tabId: this.tabId });
    } catch (err) {
      console.warn("[CodexTransport] interrupt failed:", err);
    }
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
