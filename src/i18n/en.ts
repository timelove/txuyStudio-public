/**
 * 英文字典 —— i18n 英文资源。结构与 [[zh]] 完全对齐(同 key 树)。
 *
 * 术语约定:pane→pane、tab→tab、分屏→split、钉住→pin、独立窗口→detached window、
 * dock back→back to main、会话→session、分屏树→pane tree。
 * 品牌名(Claude/Codex/PowerShell/lazygit/yazi/fresh/txuyStudio)不译。
 */

const en = {
  app: {
    loadingWorkspace: "Loading workspace…",
  },
  common: {
    close: "Close",
    loading: "Loading…",
    cancel: "Cancel",
    confirm: "Confirm",
    refresh: "Refresh",
  },
  shell: {
    tab: {
      close: "Close tab",
      new: "New tab",
    },
    pane: {
      split: "Split (new pane)",
      close: "Close pane",
      noActiveTab: "No active tab",
    },
  },
  project: {
    select: "Select project",
    none: "No projects. Click + to add.",
    add: "Add project",
    delete: "Delete project",
    deleteConfirm: 'Delete project "{{name}}"? This will close all its shells.',
    pin: "Pin (side by side)",
    unpin: "Unpin",
    detach: "Open in new window",
    focusDetached: "Focus detached window",
    empty: "No project selected.",
    emptyHint: "No project selected. Click + at top right to add.",
  },
  session: {
    all: "All",
    current: "Current",
    empty: "No Claude/Codex session records",
    noMatch: "No matching sessions",
    loading: "Loading…",
    deleteGroup: "Delete group ({{count}})",
    deleteGroupConfirm: "Delete group of {{count}}?",
    noTitle: "(untitled) {{id}}",
    unknownProject: "Unknown project",
    unknownProjectPath: "(unknown project path)",
    copyPath: "Click to copy path: {{cwd}}",
    copySessionId: "Copy session id",
    messageCount: "{{count}} msgs",
    startedAt: "Started",
    lastAt: "Last",
    deleteConfirm: "Delete?",
    deleteRecord: "Delete this session record",
    deleteSession: "Delete session",
    tipSelect: "Select a session from the left to view details",
    loadingMessages: "Loading messages…",
    noMessages: "No messages",
    copy: "Click to copy",
    copyToolUse: "Click to copy tool call",
    copyToolResult: "Click to copy tool result",
    refresh: "Refresh",
    searchPlaceholder: "Search title / path / session id",
    filterCount: "Filtered / total",
    role: {
      user: "User",
      assistant: "Assistant",
    },
  },
  install: {
    selectAllCopy: "Click to select all, then Ctrl+C to copy",
    notDetected: "{{name}} not detected. Please install it first:",
    notDetectedGroup: "{{name}} also not detected. Recommended to install together:",
    afterInstallHint: "After installation, reopen the corresponding window.",
    pathHint: 'If already installed but still prompted, make sure its directory is in your PATH, and <strong style="font-weight:600;color:var(--mx-text)">restart this app</strong> for the new PATH to take effect.',
    fileYaziDep: {
      title: "file (yazi dependency)",
      note: "yazi uses it for file MIME type detection; missing it causes errors and inaccurate previews",
    },
    lazygitNote: "Terminal git TUI client",
    yaziNote: "Terminal file manager",
    freshNote: "Terminal text editor (zero-config, VS Code-like experience)",
  },
  preview: {
    selectFile: "Select a file from the left to preview",
    loading: "Loading…",
    binary: "Binary file cannot be previewed",
    truncated: "Truncated: showing first 512 KB (full {{size}})",
    readError: "Read failed: {{error}}",
    editorLoading: "Loading editor…",
  },
  probe: {
    edit: "Edit",
    readonly: "Read-only",
    unsaved: "Unsaved (auto-saves in 5s, saves on close)",
    tooLarge: "File too large (>512KB), preview-only",
    mdPreview: "Preview",
  },
  filetree: {
    emptyDir: "Empty directory",
    noProjectPath: "No project path",
    loading: "Loading…",
  },
  settings: {
    title: "Settings",
    shortcut: {
      title: "Shortcuts",
    },
    language: {
      title: "Language",
      zh: "中文",
      en: "English",
    },
  },
  statusbar: {
    settings: "Settings",
    focusedProject: "Focused project",
    gitBranch: "git branch: {{branch}}",
    memUsage: "Memory {{percent}}%",
    tipDone: "Done. Click to restore; a new reminder rotates at the next :00 / :30",
    tipActive: "Rotates every hour / half-hour (:00 / :30). Click to mark as done",
  },
  window: {
    minimize: "Minimize",
    maximize: "Maximize",
    restore: "Restore down",
    close: "Close",
  },
  topbar: {
    backToMain: "Back to main window",
    backToMainBtn: "← Main",
    project: "Project",
  },
  sidebar: {
    openShellsByProject: "Browse shells by project",
    closePane: "Close pane",
    newShell: "New shell",
  },
  paneSurface: {
    noSession: "No session: pane {{id}}",
  },
  shortcut: {
    split: {
      title: "Split",
      down: "Split down (new pane with single PowerShell tab)",
      right: "Split right",
      close: "Close focused pane",
    },
    focus: {
      title: "Focus",
      up: "Focus up",
      down: "Focus down",
      left: "Focus left",
      right: "Focus right",
    },
    tab: {
      title: "Tab",
      new: "New tab (copy active tab type)",
      close: "Close current tab",
      next: "Next tab",
      prev: "Previous tab",
    },
    project: {
      title: "Project",
      switchN: "Focus the Nth project (by visible order)",
    },
  },
  shellkind: {
    sessionbrowser: "Sessions",
    filetree: "Probe",
  },
  shellgroup: {
    tui: "TUI tools",
    session: "Sessions",
    browse: "Probes",
  },
  tip: {
    water: { tip: "💧 Drink some water", done: "💧 Drank water" },
    lift: { tip: "🍑 Time for glute squeezes", done: "🍑 Done" },
  },
} as const;

export default en;
