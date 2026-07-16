import type { ShellKind } from "./paneTree";

export interface TerminalTransport {
  start(sessionId: string, opts?: TerminalStartOpts): Promise<void>;
  write(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  stop(sessionId: string): Promise<void>;
  onOutput(sessionId: string, callback: (chunk: string) => void): () => void;
  /** 当前 shell 实时 cwd（若 transport 支持）。用于 WT 式分屏继承目录。 */
  getCurrentCwd?(): string | null;
}

export type TerminalSize = { cols: number; rows: number };

/**
 * 启动会话的可选项。
 * - `size`：终端行列数，用于初始化 PTY 尺寸。
 * - `cwd`：工作目录。真实 PTY 在该目录启动 shell（如项目根目录）；
 *   Mock 实现忽略。为 undefined 时后端回退到默认目录。
 * - `shellKind`：面板类型。真实 PTY 始终以 PowerShell 承载,但 `claude`/`codex`
 *   会在 PowerShell 里自动执行对应 CLI。
 */
export type TerminalStartOpts = {
  size?: TerminalSize;
  cwd?: string;
  shellKind?: ShellKind;
};

export class MockTerminalTransport implements TerminalTransport {
  private listeners = new Map<string, Set<(chunk: string) => void>>();
  private transcripts: Record<string, string[]>;

  constructor(transcripts: Record<string, string[]>) {
    this.transcripts = transcripts;
  }

  async start(sessionId: string, _opts?: TerminalStartOpts) {
    const transcript = this.transcripts[sessionId] ?? [];
    for (const line of transcript) {
      this.emit(sessionId, `${line}\r\n`);
    }
  }

  async write(sessionId: string, data: string) {
    this.emit(sessionId, data);
  }

  async resize() {}

  async stop(sessionId: string) {
    this.emit(sessionId, "\r\n[session stopped]\r\n");
  }

  onOutput(sessionId: string, callback: (chunk: string) => void) {
    const callbacks = this.listeners.get(sessionId) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(sessionId, callbacks);

    return () => {
      callbacks.delete(callback);
    };
  }

  private emit(sessionId: string, chunk: string) {
    this.listeners.get(sessionId)?.forEach((callback) => callback(chunk));
  }
}
