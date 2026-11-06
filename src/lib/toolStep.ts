// BaoCode 借鉴 — 工具调用「一行步骤」的文本派生
//
// 借鉴 baocode `tool_call_row.dart` 的 `toolVerb(kind, status)` + `StepHeader.text(verb, object, detail)`:
// 一次工具调用读作一行「动词 目标 细节」,如「读了 main.dart L1-562」「运行了 bun test」。
// 动词随状态变化(进行中 / 已完成),目标取最可辨识的那个值(文件名而非全路径、命令、pattern),
// 细节是最末的淡色词(行号区间、in 路径、命令描述)。
//
// 纯函数、零 React 依赖(domain 风格),单测覆盖。

import { basename } from "../domain/claudeToolConfigs";

/** 步骤状态(与 ToolBadgeStatus 同形,此处不 import 以免 lib → domain 反向依赖语义混乱)。 */
export type StepStatus = "running" | "completed" | "error" | "denied";

/** 工具的一行步骤归类(决定动词)。 */
export type ToolStepKind =
  | "read"
  | "search"
  | "list"
  | "edit"
  | "command"
  | "web"
  | "agent"
  | "mcp"
  | "todo"
  | "plan"
  | "other";

/** 工具名 → 归类。未列出的走 `other`。 */
export function toolStepKind(name: string): ToolStepKind {
  switch (name) {
    case "Read":
    case "NotebookRead":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
    case "LS":
      return "list";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "PowerShell": // Windows 端 CLI 的命令工具名就是 PowerShell(与 Bash 同构 input.command)
    case "BashOutput":
    case "KillShell":
      return "command";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Task":
      return "agent";
    case "TodoWrite":
      return "todo";
    case "ExitPlanMode":
      return "plan";
    default:
      return name.startsWith("mcp__") ? "mcp" : "other";
  }
}

/** 归类 → [进行中 key, 已完成 key](显式映射,避免 `kind + "ing"` 拼出 webing 这类词)。 */
const VERB_KEYS: Record<ToolStepKind, readonly [string, string]> = {
  read: ["toolStep.reading", "toolStep.read"],
  search: ["toolStep.searching", "toolStep.searched"],
  list: ["toolStep.listing", "toolStep.listed"],
  edit: ["toolStep.editing", "toolStep.edited"],
  command: ["toolStep.running", "toolStep.ran"],
  web: ["toolStep.fetching", "toolStep.fetched"],
  agent: ["toolStep.agent", "toolStep.agent"],
  mcp: ["toolStep.mcp", "toolStep.mcp"],
  todo: ["toolStep.updatingTodos", "toolStep.updatedTodos"],
  plan: ["toolStep.plan", "toolStep.plan"],
  other: ["toolStep.using", "toolStep.used"],
};

/** 动词的 i18n key:`running` 用进行时,其余用完成时(baocode `toolVerb` 同策略)。 */
export function toolStepVerbKey(name: string, status: StepStatus): string {
  const [running, done] = VERB_KEYS[toolStepKind(name)];
  return status === "running" ? running : done;
}

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

/** 单行化 + 截断:步骤行恒一行(baocode StepHeader 是 maxLines:1 + ellipsis)。 */
export function oneLine(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 目标:一行里最可辨识的那个值。
 * 文件类取 basename(全路径放 title 悬浮),命令取原文,搜索取 pattern。
 */
export function toolStepObject(name: string, input: unknown): string {
  switch (toolStepKind(name)) {
    case "read":
    case "edit": {
      const fp = strField(input, "file_path") ?? strField(input, "notebook_path");
      return fp ? basename(fp) : "";
    }
    case "search": {
      const pattern = strField(input, "pattern") ?? strField(input, "query") ?? "";
      const path = strField(input, "path");
      // Glob 的 pattern 就是路径 glob;Grep 的 pattern 是正则。
      return oneLine(pattern) + (path && name === "Grep" ? ` in ${basename(path)}` : "");
    }
    case "list":
      return strField(input, "path") ?? "";
    case "command":
      return oneLine(strField(input, "command") ?? "");
    case "web":
      return oneLine(strField(input, "url") ?? strField(input, "query") ?? "");
    case "agent":
      return oneLine(strField(input, "description") ?? strField(input, "prompt") ?? "");
    case "mcp":
      return oneLine(name.replace(/^mcp__/, "").replace(/__/g, " · "));
    case "todo": {
      const todos = (input as Record<string, unknown> | null)?.todos;
      return Array.isArray(todos) ? `${todos.length}` : "";
    }
    case "plan":
      return "";
    default: {
      // 兜底:input 里第一个字符串字段。
      if (input && typeof input === "object") {
        for (const v of Object.values(input as Record<string, unknown>)) {
          if (typeof v === "string" && v) return oneLine(v);
        }
      }
      return "";
    }
  }
}

/**
 * 细节:行末的淡色小字(baocode `detail`)。
 * Read 的 `L10-50`、Bash 的 description、Task 的 subagent_type、Grep 的 in 路径。
 */
export function toolStepDetail(name: string, input: unknown): string | null {
  switch (toolStepKind(name)) {
    case "read": {
      const offset = numField(input, "offset");
      const limit = numField(input, "limit");
      if (offset == null && limit == null) return null;
      const from = offset ?? 1;
      if (limit == null) return `L${from}-`;
      return `L${from}-${from + limit - 1}`;
    }
    case "search": {
      const glob = strField(input, "glob");
      const type = strField(input, "type");
      return glob ?? (type ? `*.${type}` : null);
    }
    case "command":
      return strField(input, "description") ?? null;
    case "agent":
      return strField(input, "subagent_type") ?? null;
    case "todo": {
      const todos = (input as Record<string, unknown> | null)?.todos;
      if (!Array.isArray(todos)) return null;
      const done = todos.filter(
        (x) => x && typeof x === "object" && (x as Record<string, unknown>).status === "completed",
      ).length;
      return `${done}/${todos.length}`;
    }
    default:
      return null;
  }
}

/**
 * 悬浮 title:文件的完整路径(Read/Edit 类)。
 * 非文件类返回 null(调用方不设 title)。
 */
export function toolStepTitle(name: string, input: unknown): string | null {
  const kind = toolStepKind(name);
  if (kind !== "read" && kind !== "edit") return null;
  return strField(input, "file_path") ?? strField(input, "notebook_path") ?? null;
}
