import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";

/** pending 队列超限阈值:后台 rAF 暂停时防无界积压,超了同步 flush。 */
const PENDING_FLUSH_THRESHOLD = 4000;

import {
  type ShellEvent,
  type ShellEventPayload,
  type ShellRunState,
  applyShellEvents,
  initialShellRunState,
} from "./shellRun";

/**
 * `!` 命令内联执行的 transport(仿 `ClaudeTransport` 但极简,不实现 TerminalTransport 接口)。
 *
 * 每个实例对应一个 claudepane tab:绑定 (projectId, tabId),listen 全局 `shell-event` 事件按
 * (projectId, tabId) 路由 → `applyShellEvents` 归并成本地 `state` → 经 `onEvents` 回调通知 UI。
 *
 * 与 ClaudeTransport 的同构点:
 * - 先 listen 再 invoke(防丢首批事件,见后端 `run_shell_command` emit start 在 spawn 前)。
 * - `onEvents` 订阅时立即回放当前 state(切 tab 回来不丢)。
 *
 * 差异点:
 * - 无 sendingPromise 串行(单次命令,前端 canSend 已锁定防并发)。
 * - 无 mode/started/dead/clearing(cllaude 进程语义,shell 不需要)。
 * - 消息存 transport 实例(跨 ClaudePane unmount 存活),切 tab 回放。
 */
export class ShellRunTransport {
  private readonly projectId: string;
  private readonly tabId: string;
  private unlisten: UnlistenFn | null = null;
  private state: ShellRunState = initialShellRunState;
  private listeners = new Set<(state: ShellRunState) => void>();
  /** 进行中的 listen 挂载互斥句柄。run() 与 onEvents 路径的 ensureListening 并发调时,
   *  若都看到 unlisten=null 会挂两个 listener -> 每个事件 handleEvent 两次(start 重复 push
   *  -> 幽灵消息永久 running;output 翻倍)。串行化(同 ClaudeTransport 的 listeningPromise)。 */
  private listeningPromise: Promise<void> | null = null;
  /** output 行事件 rAF 合流:后端逐行 emit(大输出每秒数百行),逐行 apply+emit 会
   *  O(k²) 拷贝 + 每行一次全树渲染。output 攒帧批量 apply;状态翻转事件(start/done/
   *  interrupted)立即同步处理(先 flush 队列),保证 isRunning()/UI 状态不延迟一帧。 */
  private pending: ShellEventPayload[] = [];
  private emitRafId: number | null = null;

  constructor(projectId: string, tabId: string) {
    this.projectId = projectId;
    this.tabId = tabId;
  }

  /** 订阅 state 变化。立即回放当前状态(切 tab 回来不丢)。返回取消订阅函数。 */
  onEvents(callback: (state: ShellRunState) => void): () => void {
    this.listeners.add(callback);
    callback(this.state); // 回放当前状态
    return () => {
      this.listeners.delete(callback);
    };
  }

  /** 当前是否有命令在执行(供组件层判断 canSend 锁定)。 */
  isRunning(): boolean {
    return this.state.running;
  }

  /**
   * 执行一条 `!` 命令。先确保 listen 已挂(防丢首批),再 invoke run_shell_command。
   * 后端 emit start{ id } 回来才 push 消息(避免前端造 id 与后端 id 不一致)。
   * 失败(如 busy 拒绝)静默 console.warn,不污染对话流。
   */
  async run(command: string, cwd?: string): Promise<void> {
    await this.ensureListening();
    try {
      await invoke("run_shell_command", {
        projectId: this.projectId,
        tabId: this.tabId,
        command,
        cwd: cwd ?? null,
      });
    } catch (err) {
      console.warn("[ShellRunTransport] run_shell_command failed:", err);
    }
  }

  /** 挂 listen(幂等,已有则跳过;并发互斥)。防双 listener 致事件处理两次。 */
  private async ensureListening() {
    if (this.unlisten) return;
    if (this.listeningPromise) {
      await this.listeningPromise;
      return;
    }
    this.listeningPromise = (async () => {
      this.unlisten = await listen<ShellEvent>("shell-event", (event) => {
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

  /** 中断当前命令(kill 进程)。后端 emit interrupted → handleEvent 复位 running。 */
  async interrupt(): Promise<void> {
    try {
      await invoke("kill_shell_command", {
        projectId: this.projectId,
        tabId: this.tabId,
      });
    } catch (err) {
      console.warn("[ShellRunTransport] kill_shell_command failed:", err);
    }
  }

  /** 关闭 transport:取消 listen/合流帧。不 kill 后端会话(由 AppShell 关 tab 时统一 invoke kill)。 */
  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
    if (this.emitRafId !== null) {
      cancelAnimationFrame(this.emitRafId);
      this.emitRafId = null;
    }
    this.pending = [];
    this.listeners.clear();
  }

  private handleEvent(payload: ShellEventPayload) {
    if (payload.kind === "output") {
      // 纯输出行进合流队列,下一帧统一批量 apply + emit。
      this.pending.push(payload);
      // 后台标签页 rAF 暂停时队列会无限积压(超大输出内存膨胀),超阈值直接同步 flush
      // 兜底(不可见时多几次 setState 无妨,数据不丢)。
      if (this.pending.length >= PENDING_FLUSH_THRESHOLD) {
        if (this.emitRafId !== null) {
          cancelAnimationFrame(this.emitRafId);
          this.emitRafId = null;
        }
        this.flush();
        return;
      }
      if (this.emitRafId === null) {
        this.emitRafId = requestAnimationFrame(() => {
          this.emitRafId = null;
          this.flush();
        });
      }
      return;
    }
    // 状态翻转:先把积压 output 落账(保持 done 看到完整输出),再同步处理并立即通知。
    this.flush();
    this.state = applyShellEvents(this.state, [payload]);
    this.emit();
  }

  /** 把一帧内积压的 output 事件批量归并并通知一次。 */
  private flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.state = applyShellEvents(this.state, batch);
    this.emit();
  }

  private emit() {
    for (const cb of this.listeners) {
      cb(this.state);
    }
  }
}
