import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";

import {
  type ShellEvent,
  type ShellEventPayload,
  type ShellRunState,
  applyShellEvent,
  initialShellRunState,
} from "./shellRun";

/**
 * `!` 命令内联执行的 transport(仿 `ClaudeTransport` 但极简,不实现 TerminalTransport 接口)。
 *
 * 每个实例对应一个 claudepane tab:绑定 (projectId, tabId),listen 全局 `shell-event` 事件按
 * (projectId, tabId) 路由 → `applyShellEvent` 归并成本地 `state` → 经 `onEvents` 回调通知 UI。
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
    console.log("[ShellRunTransport] run", { tabId: this.tabId, command, hasUnlisten: !!this.unlisten });
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

  /** 关闭 transport:取消 listen。不 kill 后端会话(由 AppShell 关 tab/项目时统一 invoke kill)。 */
  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.listeners.clear();
  }

  private handleEvent(payload: ShellEventPayload) {
    const runningBefore = this.state.running;
    this.state = applyShellEvent(this.state, payload);
    console.log("[ShellRunTransport] event", {
      tabId: this.tabId,
      kind: payload.kind,
      id: "id" in payload ? payload.id : "?",
      runningBefore,
      runningAfter: this.state.running,
    });
    this.emit();
  }

  private emit() {
    for (const cb of this.listeners) {
      cb(this.state);
    }
  }
}
