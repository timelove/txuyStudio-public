/**
 * claude 工具调用的显示配置(配置驱动渲染)。
 *
 * 参考 siteboon/claudecodeui 的 `tools/configs/toolConfigs.ts` 设计:每个工具的显示
 * 行为(摘要提取、分类配色、是否默认展开、是否需要专门渲染)由配置注册表决定,
 * 组件按 config 渲染,不在 JSX 里散落 switch-case。
 *
 * 与 claudecodeui 的差异(适配本项目约束):
 * - 无 diff / file-list / todo-list 专门渲染组件 → Edit/Write 展示 old/new 纯文本块,
 *   Grep/Glob/Todo 展示结果文本。不引第三方 diff 库。
 * - **工具结果默认展开**(用户偏好「默认展开结果」),`max-h` + 滚动防长输出刷屏
 *   (claudecodeui 是 `hideOnSuccess` 成功只显示一行)。
 * - 配色走深色固定主题:分类色直接用硬编码 hex(edit=amber/bash=green/search=gray/
 *   todo=violet/plan=indigo),不引 tailwind `dark:` 变体。
 * - 权限拒绝(headless 下作为 `tool_result(is_error, content="requires manual approval")`)
 *   识别成 `denied` 状态药丸,区别于普通 error。
 *
 * 纯数据 + 纯函数,零 React 依赖,与 `claudeStream.ts` 同风格(domain 层)。
 */

import type { ClaudeBlock } from "./claudeStream";

/** 工具状态药丸四态。 */
export type ToolBadgeStatus = "running" | "completed" | "error" | "denied";

/** 工具分类(决定左色条 `border-l-2` 颜色)。 */
export type ToolCategory =
  | "edit"
  | "bash"
  | "search"
  | "todo"
  | "task"
  | "plan"
  | "default";

/** 工具渲染变体。`bash` = Codex 式命令行;`task` = subagent 展开查看;`plan` = 计划确认框;`diff` = Edit/Write 红绿 diff;`todo` = TodoWrite checklist;`default` = 通用可折叠卡片。 */
export type ToolVariant = "default" | "bash" | "task" | "plan" | "diff" | "todo";

/** badge 小标签配色。Edit/Write 用,标识「编辑/新建」。 */
export type ToolBadge = { text: string; tone: "edit" | "new" };

export interface ToolDisplayConfig {
  /** header 摘要 label(工具名旁),不设则用工具 name。 */
  label?: string;
  /** 从 input 提取主显示值(文件路径 basename / 命令 / pattern 等)。 */
  getValue?: (input: unknown) => string;
  /** 次要文本(灰色斜体,如 Bash 的 description、Grep 的 `in {path}`)。 */
  getSecondary?: (input: unknown) => string | undefined;
  /** 角标小标签(Edit/Write 的 Edit/New badge)。 */
  getBadge?: (input: unknown) => ToolBadge | undefined;
  /** 渲染变体。`bash` 走专门命令行组件。 */
  variant?: ToolVariant;
  /** 折叠卡片默认展开(看结果)。默认 true(用户偏好默认展开)。 */
  defaultOpen?: boolean;
  /** 结果永不显示(纯摘要工具,如 Read 文件内容由 Claude 在别处展示)。默认 false。 */
  hideResult?: boolean;
}

// —— 输入字段安全提取 ——

function strField(input: unknown, key: string): string | undefined {
  if (input && typeof input === "object" && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function numField(input: unknown, key: string): number | undefined {
  if (input && typeof input === "object" && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "number") return v;
  }
  return undefined;
}

function arrField(input: unknown, key: string): unknown[] | undefined {
  if (input && typeof input === "object" && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  return undefined;
}

/** 路径取 basename(兼容 Windows 反斜杠)。 */
export function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 配置注册表:每个工具的显示行为。未列出的工具走 `Default` 兜底。 */
export const TOOL_CONFIGS: Record<string, ToolDisplayConfig> = {
  // —— 命令 ——
  Bash: {
    label: "Bash",
    variant: "bash",
    getValue: (input) => strField(input, "command") ?? "",
    getSecondary: (input) => strField(input, "description"),
    defaultOpen: true,
  },

  // —— 文件操作 ——
  Read: {
    label: "Read",
    getValue: (input) => {
      const fp = strField(input, "file_path");
      return fp ? basename(fp) : "";
    },
    defaultOpen: true,
    // Read 结果是整个文件内容,默认展开但 max-h 限制 + 滚动(组件层)。
  },
  Write: {
    label: "Write",
    getValue: (input) => {
      const fp = strField(input, "file_path");
      return fp ? basename(fp) : "";
    },
    getBadge: () => ({ text: "New", tone: "new" }),
    variant: "diff",
    defaultOpen: true,
  },
  Edit: {
    label: "Edit",
    getValue: (input) => {
      const fp = strField(input, "file_path");
      return fp ? basename(fp) : "";
    },
    getBadge: () => ({ text: "Edit", tone: "edit" }),
    variant: "diff",
    defaultOpen: true,
  },
  MultiEdit: {
    label: "MultiEdit",
    getValue: (input) => {
      const fp = strField(input, "file_path");
      return fp ? basename(fp) : "";
    },
    getBadge: () => ({ text: "Edit", tone: "edit" }),
    variant: "diff",
    defaultOpen: true,
  },

  // —— 搜索 ——
  Grep: {
    label: "Grep",
    getValue: (input) => strField(input, "pattern") ?? "",
    getSecondary: (input) => {
      const path = strField(input, "path");
      return path ? `in ${basename(path)}` : undefined;
    },
    defaultOpen: true,
  },
  Glob: {
    label: "Glob",
    getValue: (input) => strField(input, "pattern") ?? "",
    getSecondary: (input) => {
      const path = strField(input, "path");
      return path ? `in ${basename(path)}` : undefined;
    },
    defaultOpen: true,
  },

  // —— Todo ——
  TodoWrite: {
    label: "TodoWrite",
    getValue: (input) => {
      const todos = arrField(input, "todos");
      return todos ? `${todos.length} todos` : "todos";
    },
    variant: "todo",
    defaultOpen: true,
  },
  TodoRead: {
    label: "TodoRead",
    getValue: () => "reading list",
    defaultOpen: true,
  },

  // —— Task(subagent,单独展开查看其完整输出)——
  Task: {
    label: "Task",
    variant: "task",
    getValue: (input) => strField(input, "description") ?? "running subagent",
    defaultOpen: true,
  },
  TaskCreate: {
    label: "Task",
    variant: "task",
    getValue: (input) => strField(input, "subject") ?? "creating task",
    defaultOpen: true,
  },
  TaskUpdate: {
    label: "Task",
    variant: "task",
    getValue: (input) => {
      const id = strField(input, "taskId");
      const status = strField(input, "status");
      const subject = strField(input, "subject");
      const parts: string[] = [];
      if (id) parts.push(`#${id}`);
      if (status) parts.push(status);
      if (subject) parts.push(`"${subject}"`);
      return parts.join(" → ") || "updating";
    },
    defaultOpen: true,
  },
  TaskList: {
    label: "Tasks",
    variant: "task",
    getValue: () => "listing tasks",
    defaultOpen: true,
  },
  TaskGet: {
    label: "Task",
    variant: "task",
    getValue: (input) => {
      const id = strField(input, "taskId");
      return id ? `#${id}` : "fetching";
    },
    defaultOpen: true,
  },

  // —— 网络 ——
  WebSearch: {
    label: "WebSearch",
    getValue: (input) => strField(input, "query") ?? "",
    defaultOpen: true,
  },
  WebFetch: {
    label: "WebFetch",
    getValue: (input) => {
      const url = strField(input, "url");
      return url ? basename(url) : "";
    },
    defaultOpen: true,
  },

  // —— Plan(exit_plan_mode:右侧确认框,批准→切 auto 执行)——
  exit_plan_mode: {
    label: "Plan",
    variant: "plan",
    getValue: (input) => strField(input, "plan") ?? "implementation plan",
    defaultOpen: true,
  },
  ExitPlanMode: {
    label: "Plan",
    variant: "plan",
    getValue: (input) => strField(input, "plan") ?? "implementation plan",
    defaultOpen: true,
  },

  // —— 兜底 ——
  Default: {
    defaultOpen: true,
  },
};

const DEFAULT_CONFIG: ToolDisplayConfig = TOOL_CONFIGS.Default;

/** 取工具配置,未注册走 Default。 */
export function getToolConfig(name: string): ToolDisplayConfig {
  return TOOL_CONFIGS[name] ?? DEFAULT_CONFIG;
}

/** 工具分类(决定左色条颜色)。 */
export function getToolCategory(name: string): ToolCategory {
  if (["Edit", "Write", "MultiEdit"].includes(name)) return "edit";
  if (name === "Bash") return "bash";
  if (["Grep", "Glob"].includes(name)) return "search";
  if (["TodoWrite", "TodoRead"].includes(name)) return "todo";
  if (["Task", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(name)) return "task";
  if (name === "exit_plan_mode" || name === "ExitPlanMode") return "plan";
  return "default";
}

/** 分类 → 左色条/图标颜色(深色固定主题硬编码 hex)。 */
export function categoryColor(cat: ToolCategory): { border: string; icon: string } {
  switch (cat) {
    case "edit":
      return { border: "#f59e0b", icon: "#fbbf24" };
    case "bash":
      return { border: "#22c55e", icon: "#4ade80" };
    case "search":
      return { border: "#94a3b8", icon: "#94a3b8" };
    case "todo":
      return { border: "#a78bfa", icon: "#a78bfa" };
    case "task":
      return { border: "#a78bfa", icon: "#a78bfa" };
    case "plan":
      return { border: "#818cf8", icon: "#818cf8" };
    default:
      return { border: "#64748b", icon: "#64748b" };
  }
}

/**
 * 权限/安全拒绝关键词(headless 下被拒操作的 tool_result.content 含这些)。
 * 覆盖两类拦截:① permission 拒绝(default 模式未授权,真 claude 文案 "manual approval");
 * ② sandbox 拦截(Bash 写命令被沙盒拦,实测文案 "was blocked. For security... may only ...")。
 * 命中即视为「需用户批准」(区别于命令本身的真错误),前端弹确认框。
 */
// 强信号:任何 status(done/error)命中即视为需批准。glm sandbox 拦截 tool_result.is_error 可能
// false(命令被拦视为命令失败而非工具权限错误)->status="done",但 content "was blocked"/"for security"
// 明确表权限/安全拒绝,故不设 status 前提。
const STRONG_DENIAL_KEYWORDS = [
  "manual approval",
  "requires approval",
  "tool disallowed",
  "was blocked",
  "for security",
  "may only",
];
// 弱信号:仅 status="error" 命中(避免 git/ssh 命令输出含 "permission denied" 的真实结果误判为需批准)。
const WEAK_DENIAL_KEYWORDS = [
  "permission denied",
  "denied",
  "not allowed",
];

/**
 * 判断一个 tool_use block 是否因「需手动审批」被拒(区别于真错误)。
 * default 权限模式下未授权的敏感操作,claude 返回 tool_result(is_error, content 含关键词);
 * acceptEdits 下非只读 Bash 命令同理。前端据此把药丸换成确认框(批准/批准且不再问/拒绝/反馈)。
 */
export function isPermissionDenied(block: Extract<ClaudeBlock, { type: "tool_use" }>): boolean {
  const content = (block.result?.content ?? "").toLowerCase();
  if (!content) return false;
  if (STRONG_DENIAL_KEYWORDS.some((k) => content.includes(k))) return true;
  if (block.status === "error" && WEAK_DENIAL_KEYWORDS.some((k) => content.includes(k))) return true;
  return false;
}

/**
 * 从 ClaudeBlock(tool_use)派生状态药丸状态。
 * pending/running → running;error 且需审批被拒 → denied;error → error;done → completed。
 */
export function deriveToolStatus(block: Extract<ClaudeBlock, { type: "tool_use" }>): ToolBadgeStatus {
  if (block.status === "pending" || block.status === "running") return "running";
  if (isPermissionDenied(block)) return "denied";
  if (block.status === "error") return "error";
  return "completed";
}
