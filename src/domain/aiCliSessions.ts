import { invoke } from "@tauri-apps/api/core";
import type { SessionKind } from "./sessions";

/** 支持会话记录的 AI CLI provider 类型(暂接 claude / codex,后期扩展在此加)。 */
export type AiCliKind = Extract<SessionKind, "claude" | "codex">;

/** provider 注册表项(供下拉框渲染,与后端 AiCliProviderInfo 对齐 + 额外 accent/glyph 供 UI)。 */
export type AiCliProviderInfo = {
  id: AiCliKind;
  label: string;
  accent: string;
  glyph: string;
};

/**
 * AI CLI provider 注册表(单一真源)。加新 CLI 时在此加一条 + 后端 list_ai_cli_providers
 * 加一条 + list/get/delete 加分支 + 写 scan/parse 实现,前端下拉框/列表/详情自动出现。
 */
export const AI_CLI_PROVIDERS: AiCliProviderInfo[] = [
  { id: "claude", label: "Claude", accent: "#7c3aed", glyph: "C" },
  { id: "codex", label: "Codex", accent: "#22d3ee", glyph: "X" },
];

/** kind → 显示名(从注册表派生,保留兼容旧引用)。 */
export const AI_CLI_LABEL: Record<AiCliKind, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * AI CLI(Claude / Codex)会话列表项(与后端 `system::AiCliSessionListItem` camelCase 对齐)。
 *
 * 两种 CLI 自身都会把会话写入本地:Claude → `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`;
 * Codex → `~/.codex/sessions/` 下按年月日分目录的 `rollout-*.jsonl`(全局平铺,按 cwd 过滤)。
 * 这里只**读取并展示**既存数据。
 * sessionId 取文件名 uuid,与本应用 PTY 的 sessionId(`spawn_pty` 生成的 UUIDv4)是两套体系——不可混用。
 */
export type AiCliSessionListItem = {
  /** 该会话所属 provider id("claude"/"codex"/...),与后端 providerId 对齐。 */
  providerId: AiCliKind;
  sessionId: string;
  /** 标题:Claude 取最后一条 ai-title;Codex 取首条 user_message(截断)。无则 null。 */
  title: string | null;
  /** 首行 timestamp(ISO8601)。 */
  startedAt: string | null;
  /** 末行 timestamp(ISO8601,最近活动)。 */
  lastAt: string | null;
  /** 对话规模:Claude 计 user/assistant 行数;Codex 计 user_message 事件数。 */
  messageCount: number;
  /** git 分支。 */
  gitBranch: string | null;
  /** 真实项目路径(从行内 cwd 反推)。 */
  cwd: string | null;
};

/** 单条会话消息(消息流详情,与后端 `system::AiCliSessionMessage` camelCase 对齐)。 */
export type AiCliSessionMessage = {
  role: "user" | "assistant";
  timestamp: string | null;
  text: string;
  toolUse?: { name: string; inputBrief: string } | null;
  toolResult?: string | null;
};

/** 按 cwd 末段分组后的会话组(参考 cc-switch SessionDirectoryGroup 简化版)。 */
export type SessionProjectGroup = {
  /** 分组 key(cwd 小写;无 cwd 用 UNKNOWN_PROJECT_KEY)。 */
  key: string;
  /** 原始 cwd(组内会话的项目路径,null 表示未知)。 */
  cwd: string | null;
  /** 显示名:cwd 末段(项目名);无 cwd → "未知项目"。 */
  label: string;
  /** 该项目下的会话(组内按 lastAt 降序)。 */
  sessions: AiCliSessionListItem[];
};

/** 未知项目分组 key(cwd 缺失的会话归此组,与 cc-switch UNKNOWN_PROJECT_DIR_KEY 同义)。 */
export const UNKNOWN_PROJECT_KEY = "__unknown_project__";

/** 取路径末段作项目名(Windows `\` / POSIX `/` 都兼容),与 cc-switch getBaseName 同实现。 */
function pathBasename(value?: string | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

/**
 * 按 cwd 末段(项目)分组会话(全局扫后的前端聚合)。
 *
 * - 分组 key 用 cwd 小写(Windows 路径不区分大小写,避免同项目分两组);无 cwd 归 UNKNOWN_PROJECT_KEY。
 * - label 取 cwd 末段(项目名);无 cwd → "未知项目"。
 * - 组内会话按 lastAt 降序;组间按组内最新 lastAt 降序(活跃项目在前)。
 * - `currentCwd` 传入时:匹配该 cwd 的组**强制排第一**(当前项目置顶),其余仍按 lastAt 降序。
 *
 * 参考 cc-switch `groupSessionsByProviderAndDirectory`(已读源码),这里只做单层目录分组
 * (provider 维度已由下拉框处理,不在此二次嵌套)。
 */
export function groupSessionsByProject(
  items: AiCliSessionListItem[],
  currentCwd?: string | null,
): SessionProjectGroup[] {
  const currentKey = currentCwd?.trim() ? currentCwd.trim().toLowerCase() : null;
  const groupMap = new Map<string, SessionProjectGroup>();
  const order: string[] = [];

  for (const it of items) {
    const cwd = it.cwd?.trim() || null;
    const key = cwd ? cwd.toLowerCase() : UNKNOWN_PROJECT_KEY;
    let group = groupMap.get(key);
    if (!group) {
      group = {
        key,
        cwd,
        label: cwd ? (pathBasename(cwd) || cwd) : "session.unknownProject",
        sessions: [],
      };
      groupMap.set(key, group);
      order.push(key);
    }
    group.sessions.push(it);
  }

  // 组内按 lastAt 降序;组间按组内最新 lastAt 降序。
  const groups = order.map((k) => groupMap.get(k)!);
  for (const g of groups) {
    g.sessions.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
  }
  groups.sort((a, b) => {
    // 当前项目组强制置顶。
    if (currentKey && a.key === currentKey) return -1;
    if (currentKey && b.key === currentKey) return 1;
    const aLast = a.sessions[0]?.lastAt ?? "";
    const bLast = b.sessions[0]?.lastAt ?? "";
    return bLast.localeCompare(aLast);
  });
  return groups;
}

/** 判断某分组是否是「当前项目组」(cwd 大小写不敏感匹配)。供 UI 高亮用。 */
export function isCurrentProjectGroup(group: SessionProjectGroup, currentCwd?: string | null): boolean {
  const currentKey = currentCwd?.trim() ? currentCwd.trim().toLowerCase() : null;
  return !!currentKey && group.key === currentKey;
}

/**
 * provider → 续接(restore)某历史会话的 CLI 命令(供会话列表详情展示 `claude --resume <id>` 文本,用户手动复制粘贴)。
 * - claude: `claude -r <sessionId>`(--resume 短写)。
 * - codex: `codex resume <sessionId>`。
 */
export function resumeCommandFor(providerId: AiCliKind, sessionId: string): string {
  return providerId === "codex" ? `codex resume ${sessionId}` : `claude -r ${sessionId}`;
}

/**
 * 拉取 provider 注册表(供下拉框渲染)。失败回退到本地硬编码 AI_CLI_PROVIDERS。
 */
export async function fetchAiCliProviders(): Promise<AiCliProviderInfo[]> {
  try {
    const list = await invoke<{ id: string; label: string }[]>("list_ai_cli_providers");
    // 用本地注册表补 accent/glyph(后端只返回 id/label)。
    return list
      .map((p) => {
        const meta = AI_CLI_PROVIDERS.find((m) => m.id === p.id);
        return meta ?? { id: p.id as AiCliKind, label: p.label, accent: "#94a3b8", glyph: "?" };
      });
  } catch {
    return AI_CLI_PROVIDERS;
  }
}

/**
 * 拉取指定 provider 的所有会话(轻量列表,不含消息正文)。
 *
 * 后端为**全局扫描**(扫该 provider 下所有项目,不按 rootPath 过滤),`rootPath` 现仅用于
 * 后端路径校验契约(绝对路径 + 无 `..`)——传入任意合法绝对路径即可(通常传当前项目 cwd 作占位)。
 * 每条会话自带 `cwd` 字段,前端用 `groupSessionsByProject` 按 cwd 末段分组展示。
 *
 * 失败(非 Tauri 环境 / 后端报错 / 无该 provider 历史)统一返回 `[]`,
 * 与 mock/浏览器兜底一致:空态而非崩溃。
 */
export async function fetchAiCliSessions(
  rootPath: string,
  providerId: AiCliKind,
): Promise<AiCliSessionListItem[]> {
  try {
    return await invoke<AiCliSessionListItem[]>("list_ai_cli_sessions", {
      rootPath,
      kind: providerId,
    });
  } catch {
    return [];
  }
}

/**
 * 删除某 provider 的指定会话记录文件。
 *
 * - Claude:删 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`。
 * - Codex:在 `~/.codex/sessions/` 下遍历找 `session_meta.id == sessionId` 的 rollout 文件删除
 *   (Codex 文件名含 sessionId 但格式为 `rollout-<ts>-<sessionId>.jsonl`,也按文件名匹配兜底)。
 *
 * 成功返回 true;文件不存在或失败返回 false(静默刷新,不弹错)。
 */
export async function deleteAiCliSession(
  rootPath: string,
  providerId: AiCliKind,
  sessionId: string,
): Promise<boolean> {
  try {
    return await invoke<boolean>("delete_ai_cli_session", { rootPath, kind: providerId, sessionId });
  } catch (e) {
    console.error("[deleteAiCliSession] invoke failed", { rootPath, providerId, sessionId, e });
    return false;
  }
}

/**
 * 读取单个会话的消息流(用于会话列表右栏详情展示)。
 *
 * 失败(非 Tauri / 后端报错 / session 不存在)统一返回 `[]`,详情区空态而非崩溃。
 */
export async function fetchAiCliSessionMessages(
  rootPath: string,
  providerId: AiCliKind,
  sessionId: string,
): Promise<AiCliSessionMessage[]> {
  try {
    return await invoke<AiCliSessionMessage[]>("get_ai_cli_session_messages", {
      rootPath,
      kind: providerId,
      sessionId,
    });
  } catch {
    return [];
  }
}
