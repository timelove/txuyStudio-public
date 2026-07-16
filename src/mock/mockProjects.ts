import type { AppSnapshot } from "../domain/projects";
import type { PaneNode } from "../domain/paneTree";
import { defaultPaneTree } from "../domain/paneTree";

/**
 * 多项目 mock 数据:驱动主窗口左侧项目列表与中央分屏。
 *
 * 每个项目的 `workspace.paneTree` 是 WT 式分屏树:演示默认单 PowerShell + 一个 claude
 * 的左右分屏。每个 session 带 `paneId`(稳定面板身份),供后续阶段 PTY 归属。
 */

// muxy-rust:PowerShell + Claude 左右分屏(horizontal)。每个 pane 单 tab。
const muxyRustTree: PaneNode = {
  type: "split",
  id: "muxy-rust::root",
  direction: "horizontal",
  ratio: 0.5,
  children: [
    {
      type: "pane",
      id: "muxy-ps-1",
      tabs: [{ id: "muxy-ps-1", shellKind: "shell", title: "PowerShell" }],
      activeTabId: "muxy-ps-1",
    },
    {
      type: "pane",
      id: "muxy-claude-1",
      tabs: [{ id: "muxy-claude-1", shellKind: "claude", title: "Claude" }],
      activeTabId: "muxy-claude-1",
    },
  ],
};

// muxy-web:默认单 PowerShell pane。
const muxyWebTree: PaneNode = defaultPaneTree("web-ps-1");

export const mockProjects: AppSnapshot = {
  activeProjectId: "muxy-rust",
  projects: [
    {
      id: "muxy-rust",
      name: "Muxy Rust",
      rootPath: "D:\\work\\rust\\muxy_rust",
      workspace: {
        name: "Muxy Rust",
        path: "D:\\work\\rust\\muxy_rust",
        branch: "no-git-repository",
        modifiedFiles: 8,
        riskMode: "guarded",
        paneTree: muxyRustTree,
        sessions: [
          {
            id: "muxy-ps-1",
            paneId: "muxy-ps-1",
            name: "PowerShell",
            kind: "shell",
            command: "shell",
            cwd: "D:\\work\\rust\\muxy_rust",
            status: "running",
            summary: "",
            durationLabel: "12m 04s",
            accent: "#94a3b8",
            transcript: [],
          },
          {
            id: "muxy-claude-1",
            paneId: "muxy-claude-1",
            name: "Claude",
            kind: "claude",
            command: "claude",
            cwd: "D:\\work\\rust\\muxy_rust",
            status: "waiting_approval",
            summary: "Reviewing Tauri UI scaffold",
            durationLabel: "08m 31s",
            accent: "#7c3aed",
            transcript: [],
          },
        ],
        tasks: [
          {
            id: "task-build",
            name: "Build frontend",
            command: "bun run build",
            status: "passed",
            summary: "Ready to run after UI implementation",
          },
          {
            id: "task-tauri",
            name: "Launch desktop shell",
            command: "bun run tauri dev",
            status: "waiting_input",
            summary: "Requires Rust toolchain in PATH",
          },
        ],
      },
    },
    {
      id: "muxy-web",
      name: "Muxy Web",
      rootPath: "D:\\work\\web\\muxy_web",
      workspace: {
        name: "Muxy Web",
        path: "D:\\work\\web\\muxy_web",
        branch: "feat/dashboard",
        modifiedFiles: 3,
        riskMode: "permissive",
        paneTree: muxyWebTree,
        sessions: [
          {
            id: "web-ps-1",
            paneId: "web-ps-1",
            name: "PowerShell",
            kind: "shell",
            command: "shell",
            cwd: "D:\\work\\web\\muxy_web",
            status: "running",
            summary: "",
            durationLabel: "05m 12s",
            accent: "#94a3b8",
            transcript: [],
          },
        ],
        tasks: [
          {
            id: "web-task-lint",
            name: "Lint",
            command: "bun run lint",
            status: "done",
            summary: "No issues",
          },
        ],
      },
    },
  ],
};
