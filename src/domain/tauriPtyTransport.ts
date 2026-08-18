import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import type { TerminalStartOpts, TerminalTransport } from "./terminalTransport";

/**
 * 基于 Tauri + Rust PTY 的真实终端 transport。
 *
 * 每个实例对应一个终端面板：start 时后端 spawn 一个真实 shell 会话，
 * 通过全局 `pty-output` 事件回推输出，由本实例按 sessionId 路由。
 *
 * 顺序约束：必须先 listen 再 invoke spawn，否则会丢掉 shell 启动首批输出
 * （PowerShell 冷启动有延迟）。
 */
export class TauriPtyTransport implements TerminalTransport {
  /** 所属项目 ID——后端按 projectId 分桶管理 PTY（项目隔离）。所有 invoke 均带此值。 */
  private readonly projectId: string;
  private ptySessionId: string | null = null;
  private unlisten: UnlistenFn | null = null;
  private listeners = new Map<string, Set<(chunk: string) => void>>();
  private transcript = "";
  private pendingOutput = "";
  private currentCwd: string | null = null;
  private readonly maxTranscriptLength = 1_000_000;
  /** 进行中的 spawn（去重用）：React StrictMode 双 mount 或并发 start 只会真正 spawn 一次。 */
  private startingPromise: Promise<void> | null = null;
  /** 首次 spawn 的启动命令覆盖(AppShell 从 pendingResumeRef 注入,如 "codex resume <id>")。
   *  优先于 launch_command_for(kind);仅首次 spawn 生效,doStart 消费后清空(已有 session 只 resize)。 */
  private launchOverride: string | null = null;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  /** 注入首次 spawn 的启动命令覆盖(AppShell 池化创建 transport 时调,从 pendingResumeRef 读)。
   *  仅首次 spawn 生效:doStart 消费后清空。 */
  setLaunchOverride(command: string): void {
    this.launchOverride = command;
  }

  start(sessionId: string, opts?: TerminalStartOpts): Promise<void> {
    // 已有会话 → 只 resize（不返回 startingPromise，避免重复 resize 风暴；resize 本身幂等）。
    if (this.ptySessionId) {
      const cols = opts?.size?.cols ?? 80;
      const rows = opts?.size?.rows ?? 24;
      return invoke("resize_pty", {
        projectId: this.projectId,
        sessionId: this.ptySessionId,
        rows,
        cols,
      })
        .then(() => undefined)
        .catch(() => {
          /* 旧会话可能已退出；忽略 */
        });
    }
    // 正在 spawn 中 → 复用同一个 Promise，避免重复 spawn（StrictMode 双 mount 修复点）。
    if (this.startingPromise) {
      return this.startingPromise;
    }
    this.startingPromise = this.doStart(sessionId, opts);
    return this.startingPromise;
  }

  private async doStart(sessionId: string, opts?: TerminalStartOpts) {
    const cols = opts?.size?.cols ?? 80;
    const rows = opts?.size?.rows ?? 24;
    const cwd = opts?.cwd;
    const shellKind = opts?.shellKind ?? "shell";

    try {
      // 1) 先订阅全局事件，避免丢首批输出。
      if (!this.unlisten) {
        this.unlisten = await listen<PtyOutputPayload>("pty-output", (event) => {
          if (event.payload.sessionId === this.ptySessionId) {
            this.handlePtyChunk(sessionId, event.payload.data);
          }
        });
      }

      // 2) 再 spawn 后端会话，拿到对应的 pty sessionId。cwd 传项目根目录 / 继承目录；
      // shellKind 让后端在 PowerShell 内自动启动 claude/codex。launchOverride(如 "codex resume <id>")
      // 优先于 shellKind 的静态启动命令,仅首次 spawn 生效,消费后清空(已有 session 只 resize)。
      const launchOverride = this.launchOverride;
      this.ptySessionId = await invoke<string>("spawn_pty", { projectId: this.projectId, rows, cols, cwd: cwd ?? null, shellKind, launchOverride: launchOverride ?? null });
      this.launchOverride = null;
    } finally {
      this.startingPromise = null;
    }
  }

  async write(_sessionId: string, data: string) {
    if (!this.ptySessionId) {
      throw new Error("TauriPtyTransport: session not started");
    }
    await invoke("write_pty", { projectId: this.projectId, sessionId: this.ptySessionId, data });
  }

  async resize(_sessionId: string, cols: number, rows: number) {
    if (!this.ptySessionId) {
      return;
    }
    await invoke("resize_pty", { projectId: this.projectId, sessionId: this.ptySessionId, rows, cols });
  }

  async stop(_sessionId: string) {
    if (this.ptySessionId) {
      await invoke("kill_pty", { projectId: this.projectId, sessionId: this.ptySessionId }).catch(() => {
        /* 会话可能已退出，忽略 kill 失败 */
      });
      this.ptySessionId = null;
    }
    this.unlisten?.();
    this.unlisten = null;
  }

  onOutput(sessionId: string, callback: (chunk: string) => void) {
    const callbacks = this.listeners.get(sessionId) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(sessionId, callbacks);

    // React 分屏会让 TerminalPane remount；新 xterm 需要回放历史输出，
    // 否则虽然 PTY 进程保住了，但可视缓冲区会像“重置”。
    if (this.transcript) {
      callback(this.transcript);
    }

    return () => {
      callbacks.delete(callback);
    };
  }

  getCurrentCwd() {
    return this.currentCwd;
  }

  private handlePtyChunk(sessionId: string, chunk: string) {
    this.pendingOutput += chunk;

    while (true) {
      const markerStart = this.pendingOutput.indexOf("\x1b]1337;TxuyCwd=");
      if (markerStart === -1) {
        this.emitVisible(sessionId, this.pendingOutput);
        this.pendingOutput = "";
        return;
      }

      if (markerStart > 0) {
        this.emitVisible(sessionId, this.pendingOutput.slice(0, markerStart));
        this.pendingOutput = this.pendingOutput.slice(markerStart);
      }

      const markerEnd = this.pendingOutput.indexOf("\x07");
      if (markerEnd === -1) {
        // OSC 标记跨 chunk：先等下一段输出，避免把控制序列写进 xterm。
        return;
      }

      const cwd = this.pendingOutput.slice("\x1b]1337;TxuyCwd=".length, markerEnd);
      this.currentCwd = cwd || this.currentCwd;
      this.pendingOutput = this.pendingOutput.slice(markerEnd + 1);
    }
  }

  private emitVisible(sessionId: string, chunk: string) {
    if (!chunk) return;
    this.transcript += chunk;
    if (this.transcript.length > this.maxTranscriptLength) {
      this.transcript = this.transcript.slice(-this.maxTranscriptLength);
    }
    this.listeners.get(sessionId)?.forEach((callback) => callback(chunk));
  }
}

type PtyOutputPayload = {
  sessionId: string;
  data: string;
};
