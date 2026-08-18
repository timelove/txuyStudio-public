/**
 * codex 工具调用的显示配置(配置驱动渲染,仿 `claudeToolConfigs.ts`)。
 *
 * codex 工具名归一化规则(见 codexStream.ts toolNameOf):
 * - command_execution -> "shell"(input={command})
 * - mcp_tool_call -> "mcp:<server>.<tool>"(input=arguments 对象)
 * - custom_tool_call -> item.name(exec/apply_patch/read_file/...;input 可能是字符串脚本)
 *
 * 与 claudeToolConfigs 的关键差异:**无 isPermissionDenied 交互批准**(codex exec 非交互,
 * 走 -s sandbox)。被 sandbox 拦截的操作以 `isSandboxDenied` 识别成 denied 药丸(只显示
 * 状态,不弹确认框;用户切 sandbox 策略下轮生效)。
 *
 * 纯数据 + 纯函数,零 React 依赖,与 `codexStream.ts` 同风格(domain 层)。
 */

import type { CodexBlock } from "./codexStream";

/** 工具状态药丸四态。 */
export type ToolBadgeStatus = "running" | "completed" | "error" | "denied";

/** 工具分类(决定左色条颜色)。codex 无 todo/task/plan 概念,精简为四类。 */
export type ToolCategory = "edit" | "bash" | "search" | "default";

/** badge 小标签配色(apply_patch 用,标识「补丁」)。 */
export type ToolBadge = { text: string; tone: "edit" | "new" };

export interface ToolDisplayConfig {
  /** header 摘要 label(工具名旁),不设则用工具 name。 */
  label?: string;
  /** 从 input 提取主显示值(命令/路径等)。 */
  getValue?: (input: unknown) => string;
  /** 次要文本(灰色斜体)。 */
  getSecondary?: (input: unknown) => string | undefined;
  /** 角标小标签。 */
  getBadge?: (input: unknown) => ToolBadge | undefined;
  /** 渲染变体。`bash` = Codex 式命令行;`default` = 通用可折叠卡片。 */
  variant?: "default" | "bash";
  /** 折叠卡片默认展开。默认 true(用户偏好默认展开)。 */
  defaultOpen?: boolean;
}

// -- 输入字段安全提取 --

function strField(input: unknown, key: string): string | undefined {
  if (input && typeof input === "object" && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** 配置注册表:每个工具的显示行为。未列出的工具(含 mcp:* 动态名)走 `Default` 兜底。 */
export const TOOL_CONFIGS: Record<string, ToolDisplayConfig> = {
  // command_execution(codexStream 归一化名)。
  shell: {
    label: "Shell",
    variant: "bash",
    getValue: (input) => strField(input, "command") ?? "",
    defaultOpen: true,
  },
  // custom_tool_call 的 exec 工具(input 是脚本字符串)。
  exec: {
    label: "Shell",
    variant: "bash",
    getValue: (input) => (typeof input === "string" ? input : strField(input, "command") ?? ""),
    defaultOpen: true,
  },
  // custom_tool_call 常见文件工具(兼容保留;用户环境当前走 mcp_tool_call)。
  read_file: {
    label: "Read",
    getValue: (input) => strField(input, "path") ?? "",
    defaultOpen: true,
  },
  write_file: {
    label: "Write",
    getValue: (input) => strField(input, "path") ?? "",
    getBadge: () => ({ text: "New", tone: "new" }),
    defaultOpen: true,
  },
  apply_patch: {
    label: "Patch",
    getValue: () => "apply patch",
    getBadge: () => ({ text: "Edit", tone: "edit" }),
    defaultOpen: true,
  },
  grep: {
    label: "Grep",
    getValue: (input) => strField(input, "pattern") ?? "",
    defaultOpen: true,
  },
  list_files: {
    label: "List",
    getValue: (input) => strField(input, "path") ?? "",
    defaultOpen: true,
  },

  // -- 兜底(mcp:* 动态名与未知工具) --
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
  if (name === "apply_patch" || name === "write_file") return "edit";
  if (name === "shell" || name === "exec") return "bash";
  if (name === "grep" || name === "read_file" || name === "list_files") return "search";
  return "default";
}

/** 分类 -> 左色条/图标颜色(深色固定主题硬编码 hex,与 claudeToolConfigs 同值)。 */
export function categoryColor(cat: ToolCategory): { border: string; icon: string } {
  switch (cat) {
    case "edit":
      return { border: "#f59e0b", icon: "#fbbf24" };
    case "bash":
      return { border: "#22c55e", icon: "#4ade80" };
    case "search":
      return { border: "#94a3b8", icon: "#94a3b8" };
    default:
      return { border: "#64748b", icon: "#64748b" };
  }
}

/**
 * sandbox 拦截关键词(codex read-only/workspace-write 下被拒操作的输出文案,实测样本:
 * "writing is blocked by read-only sandbox; rejected by user approval settings" /
 * "windows sandbox: CreateProcessAsUserW failed")。命中且 isError 即视为 sandbox 拦截
 * -> denied 药丸(区别于命令本身真错误)。**不弹确认框**(codex exec 非交互审批,
 * 用户切 sandbox 策略下轮生效)。
 */
const SANDBOX_DENIAL_KEYWORDS = [
  "blocked by read-only sandbox",
  "blocked by sandbox",
  "rejected by user approval",
  "sandbox:",
  "write is not allowed",
  "not allowed by sandbox",
];

/**
 * 判断一个 tool_use block 是否因 sandbox 策略被拒(区别于真错误)。
 */
export function isSandboxDenied(block: Extract<CodexBlock, { type: "tool_use" }>): boolean {
  if (!block.result?.isError) return false;
  const content = block.result.content.toLowerCase();
  return SANDBOX_DENIAL_KEYWORDS.some((k) => content.includes(k));
}

/**
 * 从 CodexBlock(tool_use)派生状态药丸状态。
 * pending/running -> running;sandbox 拦截 -> denied;error -> error;done -> completed。
 */
export function deriveToolStatus(block: Extract<CodexBlock, { type: "tool_use" }>): ToolBadgeStatus {
  if (block.status === "pending" || block.status === "running") return "running";
  if (isSandboxDenied(block)) return "denied";
  if (block.status === "error") return "error";
  return "completed";
}
