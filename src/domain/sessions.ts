export type SessionKind = "claude" | "claudepane" | "codex" | "codexpane" | "shell" | "test" | "lazygit" | "fresh" | "yazi" | "sessionbrowser" | "filetree" | "htmlpreview" | "notes";

export type SessionStatus =
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "passed"
  | "failed"
  | "done";

/**
 * 终端面板：一个项目 Surface 内的一个终端格子。
 *
 * `paneId` 是面板的稳定身份（多项目/多窗口迁移时保持），`sessionId` 是
 * 运行期 PTY 会话身份（重启后变化，由后端生成）。
 */
export type WorkspaceSession = {
  id: string;
  paneId: string;
  name: string;
  kind: SessionKind;
  command: string;
  cwd: string;
  status: SessionStatus;
  summary: string;
  durationLabel: string;
  accent: string;
  transcript: string[];
};

export type WorkspaceTask = {
  id: string;
  name: string;
  command: string;
  status: SessionStatus;
  summary: string;
};
