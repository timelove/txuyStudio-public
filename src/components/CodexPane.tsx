import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { useTranslation } from "react-i18next";
import type { ShellKind, SplitDirection } from "../domain/paneTree";
import type { WorkspaceSession } from "../domain/sessions";
import type { CodexTransport } from "../domain/codexTransport";
import type { ShellRunTransport } from "../domain/shellRunTransport";
import type { ShellMessage, ShellRunState } from "../domain/shellRun";
import type { CodexBlock, CodexMessage, CodexSessionKind, CodexStreamState, CodexUsage } from "../domain/codexStream";
import { summarize } from "../domain/codexStream";
import {
  getToolConfig,
  getToolCategory,
  categoryColor,
  deriveToolStatus,
  type ToolDisplayConfig,
  type ToolBadgeStatus,
} from "../domain/codexToolConfigs";
import { SANDBOX_MODES } from "../domain/codexSandbox";
import { fetchAiCliSessions, mostRecentSessionInCwd, type AiCliSessionListItem } from "../domain/aiCliSessions";
import { useSettings } from "../settings/SettingsProvider";
import { statusFontSize } from "../settings";
import { ShellMenu } from "./ShellMenu";
import { SplitPaneButtons } from "./SplitPaneButtons";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./ui/Popover";
import { Button } from "./ui/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import { Tabs, TabsList, TabsTrigger } from "./ui/Tabs";

/** MdPreview 懒加载(避免 codexpane 首屏就拉 marked/dompurify,与探针共用 md-render 分包)。 */
const MdPreviewLazy = lazy(() =>
  import("./MdPreview").then((m) => ({ default: m.MdPreview })),
);

/** 统一 slash 命令形状(前端 FALLBACK 集,codex exec 模式后端无 slash_commands 透传)。 */
type SlashCmd = { name: string; description?: string };

/** 相对时间格式化(↻ 弹窗「恢复上一次」用),与 ClaudePane.relativeTime 同实现。 */
function relativeTime(iso: string | null, locale: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const sec = Math.round((then - Date.now()) / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const intlLocale = locale === "en" ? "en" : "zh";
  const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(intlLocale, { numeric: "auto" }) : null;
  if (!rtf) return "";
  if (Math.abs(sec) < 60) return rtf.format(sec, "second");
  if (Math.abs(min) < 60) return rtf.format(min, "minute");
  if (Math.abs(hr) < 24) return rtf.format(hr, "hour");
  return rtf.format(day, "day");
}

/**
 * codex 原生 slash 命令集(从 codex.exe 二进制精确验证 + 真实 history.jsonl 佐证)。
 *
 * codex exec 非交互模式**不支持** slash 命令(TUI 专属),故本面板把命令映射为前端动作
 * (触发选择器/清会话/开文件/跑 git diff),其余提示「在终端使用 codex CLI」。
 * 与 claude 的命令集完全不同(codex 无 /effort 而是 /reasoning;开新会话是 /new 非 /clear)。
 */
const FALLBACK_SLASH_CMDS: SlashCmd[] = [
  { name: "agent", description: "查看与管理 Agent 配置" },
  { name: "auth", description: "管理 codex 登录凭据" },
  { name: "diff", description: "查看工作区改动(git diff)" },
  { name: "exit", description: "退出当前会话并关闭 tab" },
  { name: "help", description: "查看可用命令与帮助" },
  { name: "init", description: "打开项目 AGENTS.md 指令文件" },
  { name: "mcp", description: "查看 MCP 服务器配置" },
  { name: "model", description: "查看或切换模型" },
  { name: "new", description: "开启新会话(不续接历史)" },
  { name: "reasoning", description: "切换推理强度" },
  { name: "resume", description: "恢复历史会话" },
  { name: "status", description: "查看会话状态与用量" },
  { name: "usage", description: "查看用量统计" },
];

/**
 * codex sandbox 策略(codex exec -s),状态栏可切换 + Shift+Tab 循环。
 * 档位表收敛到 domain/codexSandbox.ts(与设置面板的全局默认档共用,单一真源)。
 */

/** 兜底 reasoning 档位(catalog 无当前 model 的 supported_reasoning_levels 时用)。 */
const FALLBACK_REASONING_LEVELS = ["low", "medium", "high", "xhigh"];

/** 模型目录项(与后端 `CodexModelInfo` camelCase 对齐,来源 cc-switch-model-catalog.json)。 */
type CodexModelInfo = {
  slug: string;
  displayName: string;
  contextWindow?: number;
  reasoningLevels: string[];
};

type CodexPaneProps = {
  paneId: string;
  sessions: WorkspaceSession[];
  activeTabId: string;
  /** 取该 pane 内某 tab 的 CodexTransport(池化,tab 生命周期内稳定)。 */
  getCodexTransport: (tabId: string) => CodexTransport;
  /** 取该 pane 内某 tab 的 ShellRunTransport(`!` 命令内联执行,池化)。 */
  getShellRunTransport: (tabId: string) => ShellRunTransport;
  focused?: boolean;
  onFocusPane?: (paneId: string) => void;
  onSplitPane?: (paneId: string, kind: ShellKind, direction: SplitDirection) => void;
  onClosePane?: (paneId: string) => void;
  onAddTab?: (paneId: string, kind: ShellKind) => void;
  onResumeSession?: (sessionId: string) => void;
  onCloseTab?: (paneId: string, tabId: string) => void;
  onSetActiveTab?: (paneId: string, tabId: string) => void;
  className?: string;
};

/**
 * 订阅某 codex tab 的 transport,派生对外汇总语义态(供 tab chip 状态点)。含 shellRunning
 * (同 tab 的 `!` 命令在跑算 running)。复用 `summarize` 纯函数。
 */
function useTabSummary(
  transport: CodexTransport | undefined,
  shellRunning: boolean,
): CodexSessionKind | null {
  const [kind, setKind] = useState<CodexSessionKind | null>(null);
  useEffect(() => {
    if (!transport) {
      setKind(null);
      return;
    }
    const unsub = transport.onEvents((state) => {
      setKind(summarize(state, shellRunning).kind);
    });
    return unsub;
  }, [transport, shellRunning]);
  return kind;
}

/** tab chip 旁的状态点。颜色:running cyan(呼吸)/error 红/idle 灰。 */
function TabStatusDot({ kind }: { kind: CodexSessionKind | null }) {
  if (!kind) return null;
  const color =
    kind === "error"
      ? "#f87171"
      : kind === "running"
        ? "#22d3ee"
        : "#475569";
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${kind === "running" ? "animate-pulse" : ""}`}
      style={{ background: color }}
    />
  );
}

/** codexpane tab chip(glyph + 名称 + 状态点 + 关闭×)。订阅该 tab 的 transport 派生状态点。 */
const CodexTabChip = memo(function CodexTabChip({
  session,
  isActive,
  showClose,
  paneId,
  getCodexTransport,
  shellRunning,
  onCloseTab,
}: {
  session: WorkspaceSession;
  isActive: boolean;
  showClose: boolean;
  paneId: string;
  getCodexTransport: (tabId: string) => CodexTransport;
  shellRunning: boolean;
  onCloseTab?: (paneId: string, tabId: string) => void;
}) {
  const { t } = useTranslation();
  const transport = session.kind === "codexpane" ? getCodexTransport(session.id) : undefined;
  const kind = useTabSummary(transport, shellRunning);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TabsTrigger asChild value={session.id}>
          <div
            className={`mx-tab-item group/tab flex h-[length:var(--mx-tab-h)] min-w-0 shrink cursor-pointer items-center gap-1 px-2 transition-colors ${
              isActive
                ? "text-[var(--mx-text-bright)]"
                : "text-[var(--mx-text-dim)] hover:text-[var(--mx-text)]"
            }`}
          >
            <span className="min-w-0 max-w-[180px] truncate text-[length:var(--mx-ui-fs-sm)] font-[600]">{t(session.name)}</span>
            <TabStatusDot kind={kind} />
            {showClose && onCloseTab && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-3.5 w-3.5 text-[10px] text-[var(--mx-text-dim)] opacity-0 transition-opacity hover:bg-transparent hover:text-[var(--mx-danger-bright)] group-hover/tab:opacity-100"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onCloseTab(paneId, session.id);
                }}
                onClick={(e) => e.stopPropagation()}
              >
                ×
              </Button>
            )}
          </div>
        </TabsTrigger>
      </TooltipTrigger>
      <TooltipContent>{t(session.name)}</TooltipContent>
    </Tooltip>
  );
});

/** ↻ 弹窗顶部「恢复上一次」快捷行(最近一条 codex 历史会话,点击直接 resume)。 */
function QuickResumeLast({
  loading,
  item,
  locale,
  onPick,
}: {
  loading: boolean;
  item: AiCliSessionListItem | null;
  locale: string;
  onPick: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return <div className="px-1 py-0.5 text-[11px] text-[var(--mx-faint)]">{t("common.loading")}</div>;
  }
  if (!item) {
    return <div className="px-1 py-0.5 text-[11px] text-[var(--mx-faint)]">{t("session.resumeLastEmpty")}</div>;
  }
  const title = item.title ?? t("session.noTitle", { id: item.sessionId.slice(0, 8) });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="mx-chip flex items-center gap-1.5 rounded border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2 py-1 text-left hover:bg-[var(--mx-hover-bg)] cursor-pointer"
          onClick={() => onPick(item.sessionId)}
        >
          <span className="shrink-0 text-[var(--mx-accent)]">↶</span>
          <span className="min-w-0 flex-1 truncate text-[length:var(--mx-ui-fs-sm)] text-[var(--mx-text)]">{title}</span>
          <span className="shrink-0 text-[10px] text-[var(--mx-faint)]">{relativeTime(item.lastAt, locale)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{t("session.resumeLast")}</TooltipContent>
    </Tooltip>
  );
}

/**
 * codex 自渲染对话面板(每轮短命 codex exec --json + resume 续接),Cursor 式行内流 UI。
 * 整体结构仿 ClaudePane(消息流 + 工具卡 + 底部输入区 + 状态栏),差异见各注释。
 */
export function CodexPane(props: CodexPaneProps) {
  const {
    paneId,
    sessions,
    activeTabId,
    getCodexTransport,
    getShellRunTransport,
    focused,
    onFocusPane,
    onSplitPane,
    onClosePane,
    onAddTab,
    onResumeSession,
    onCloseTab,
    onSetActiveTab,
    className,
  } = props;
  const { t, i18n } = useTranslation();
  const { fontSize } = useSettings();
  /** 输入框底部状态栏字号:随全局 fontSize 缩放(14→10,与原 text-[10px] 一致)。 */
  const statusFontPx = statusFontSize(fontSize);
  const [state, setState] = useState<CodexStreamState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** `!` 命令内联执行的输出流(独立于 codex 流)。 */
  const [shellState, setShellState] = useState<ShellRunState | null>(null);
  const [input, setInput] = useState("");
  // ↑/↓ 输入历史(类 shell):localStorage 按项目 cwd 隔离,key 前缀 codex-history。
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const draftRef = useRef("");
  const historyKey = sessions.find((s) => s.id === activeTabId)?.cwd;
  const historyStorageKey = historyKey ? `codex-history:${historyKey}` : null;
  const historyStorageKeyRef = useRef(historyStorageKey);
  historyStorageKeyRef.current = historyStorageKey;
  useEffect(() => {
    if (!historyStorageKey) return;
    try {
      const raw = localStorage.getItem(historyStorageKey);
      const arr = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(arr)) {
        setHistory(arr.filter((x) => typeof x === "string").slice(-100));
      } else {
        setHistory([]);
      }
    } catch {
      /* localStorage 不可用,降级为仅内存 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyStorageKey]);
  const [menuMode, setMenuMode] = useState<"tab" | "sandbox" | "model" | "reasoning" | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeInput, setResumeInput] = useState("");
  /** ↻ 弹窗「恢复上一次」:当前项目最近一条 codex 历史会话(弹窗打开时懒拉)。 */
  const [lastSession, setLastSession] = useState<AiCliSessionListItem | null>(null);
  const [lastLoading, setLastLoading] = useState(false);
  const resumeRootPath = sessions.find((s) => s.id === activeTabId)?.cwd ?? "";
  useEffect(() => {
    // 取最近一条按 cwd 过滤--只显示同工作空间的会话(跨项目不混,与 ClaudePane 同原则)。
    if (!resumeOpen || !resumeRootPath) return;
    let alive = true;
    setLastLoading(true);
    void fetchAiCliSessions(resumeRootPath, "codex").then((list) => {
      if (!alive) return;
      setLastSession(mostRecentSessionInCwd(list, resumeRootPath));
      setLastLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [resumeOpen, resumeRootPath]);
  const [codexMissing, setCodexMissing] = useState(false);
  const [probeDone, setProbeDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const lastScrollTopRef = useRef(0);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) {
      stickRef.current = true;
      setShowScrollBottom(false);
    } else if (el.scrollTop < lastScrollTopRef.current - 2) {
      stickRef.current = false;
      setShowScrollBottom(true);
    }
    lastScrollTopRef.current = el.scrollTop;
  }, []);
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setShowScrollBottom(false);
  }, []);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);

  // -- slash 命令面板状态(codex exec 无后端 slash_commands,只用前端 FALLBACK 集) --
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [commandQuery, setCommandQuery] = useState("");
  const slashPositionRef = useRef(-1);
  const queryTimerRef = useRef<number | null>(null);
  // -- @ 文件引用面板(与 ClaudePane 同,通用能力) --
  const [atOpen, setAtOpen] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [atQuery, setAtQuery] = useState("");
  const [atFiles, setAtFiles] = useState<{ path: string; name: string }[]>([]);
  const atPositionRef = useRef(-1);
  const atLoadedCwdRef = useRef<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  const [unsupportedMsg, setUnsupportedMsg] = useState<string | null>(null);
  /** 模型目录(list_codex_models 实时拉取 cc-switch catalog;打开选择器时刷新)。 */
  const [availableModels, setAvailableModels] = useState<CodexModelInfo[]>([]);
  /** 上下文窗口上限(当前选中 model 的 catalog contextWindow;codex 事件流不带该值)。 */
  const [contextWindow, setContextWindow] = useState<number | undefined>(undefined);

  const getCodexTransportRef = useRef(getCodexTransport);
  getCodexTransportRef.current = getCodexTransport;
  const getShellRunTransportRef = useRef(getShellRunTransport);
  getShellRunTransportRef.current = getShellRunTransport;
  const onCloseTabRef = useRef(onCloseTab);
  onCloseTabRef.current = onCloseTab;
  const getCodexTransportStable = useCallback(
    (tabId: string) => getCodexTransportRef.current(tabId),
    [],
  );
  const onCloseTabStable = useCallback(
    (paneId: string, tabId: string) => onCloseTabRef.current?.(paneId, tabId),
    [],
  );

  // 挂载时探测 codex CLI 是否安装(非 Tauri 环境静默放行)。
  useEffect(() => {
    let alive = true;
    invoke<Record<string, boolean>>("check_commands_installed", { commands: ["codex"] })
      .then((result) => {
        if (!alive) return;
        setCodexMissing(!result["codex"]);
        setProbeDone(true);
      })
      .catch(() => {
        if (!alive) return;
        setProbeDone(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (queryTimerRef.current !== null) window.clearTimeout(queryTimerRef.current);
    };
  }, []);

  // 订阅活动 tab 的 transport:切 tab 时换 transport + 重新订阅(onEvents 立即回放)。
  useEffect(() => {
    if (!activeTabId) return;
    const transport = getCodexTransportRef.current(activeTabId);
    const off = transport.onEvents((s) => setState(s));
    if (focused) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, focused]);

  // 订阅活动 tab 的 `!` 命令 transport(独立于 codex 流)。
  useEffect(() => {
    if (!activeTabId) return;
    const transport = getShellRunTransportRef.current(activeTabId);
    const off = transport.onEvents((s) => setShellState(s));
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // 自动贴底(流式/新消息/内容异步撑高)。与 ClaudePane 同实现。
  const lastMsg = state && state.messages.length > 0 ? state.messages[state.messages.length - 1] : undefined;
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastMsg, state?.status]);
  useLayoutEffect(() => {
    stickRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeTabId]);
  const hasMessages = !!(state && (state.messages.length > 0 || (shellState?.messages.length ?? 0) > 0));
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (!stickRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [activeTabId, hasMessages]);

  // -- slash 面板:基于防抖后的 commandQuery 过滤 FALLBACK 集 --
  const slashMatches = useMemo<SlashCmd[]>(() => {
    if (!slashOpen) return [];
    const all = [...FALLBACK_SLASH_CMDS].sort((a, b) => a.name.localeCompare(b.name));
    const q = commandQuery.trim().toLowerCase();
    if (!q) return all;
    const namePrefix = all.filter((c) => c.name.toLowerCase().startsWith(q));
    if (namePrefix.length > 0) return namePrefix;
    return all.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.description?.toLowerCase().includes(q) ?? false),
    );
  }, [slashOpen, commandQuery]);

  /** 已知 slash 命令名集合(输入高亮用)。 */
  const knownCmdNames = useMemo(() => {
    const set = new Set<string>();
    for (const fb of FALLBACK_SLASH_CMDS) set.add(fb.name);
    return set;
  }, []);

  /** 渲染输入框高亮层(命令 token 套 chip 背景色)。与 ClaudePane 同实现。 */
  const renderHighlighted = useCallback(
    (text: string): ReactNode => {
      const nodes: ReactNode[] = [];
      const regex = /(^|\s)(\/(\S+))/g;
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      let key = 0;
      while ((m = regex.exec(text)) !== null) {
        const prefix = m[1];
        const fullToken = m[2];
        const name = m[3];
        const tokenStart = m.index + prefix.length;
        if (tokenStart > lastIndex) nodes.push(text.slice(lastIndex, tokenStart));
        if (knownCmdNames.has(name)) {
          nodes.push(
            <span key={key++} className="rounded-[3px] bg-[var(--mx-selected-bg)] text-transparent">
              {fullToken}
            </span>,
          );
        } else {
          nodes.push(fullToken);
        }
        lastIndex = tokenStart + fullToken.length;
      }
      if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
      return nodes;
    },
    [knownCmdNames],
  );

  // @ 文件引用:fuzzy 过滤(路径含 query),限 50 条。
  const atMatches = useMemo(() => {
    if (!atOpen) return [];
    const q = atQuery.trim().toLowerCase();
    const filtered = q ? atFiles.filter((f) => f.path.toLowerCase().includes(q)) : atFiles;
    return filtered.slice(0, 50);
  }, [atOpen, atQuery, atFiles]);
  useEffect(() => {
    setAtIndex(0);
  }, [atMatches.length]);
  useEffect(() => {
    setSlashIndex(0);
  }, [slashMatches.length]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      const cursorPos = e.target.selectionStart ?? v.length;
      setInput(v);

      const backticksBefore = (v.slice(0, cursorPos).match(/```/g) || []).length;
      if (backticksBefore % 2 === 1) {
        setSlashOpen(false);
        setAtOpen(false);
        slashPositionRef.current = -1;
        atPositionRef.current = -1;
        return;
      }

      const textBeforeCursor = v.slice(0, cursorPos);

      const atMatch = textBeforeCursor.match(/(?:^|\s)@(\S*)$/);
      if (atMatch) {
        atPositionRef.current = (atMatch.index ?? 0) + (atMatch[0].length - atMatch[1].length - 1);
        setAtOpen(true);
        setAtIndex(0);
        setAtQuery(atMatch[1]);
        setSlashOpen(false);
        slashPositionRef.current = -1;
        const cwd = sessions.find((s) => s.id === activeTabId)?.cwd;
        if (cwd && atLoadedCwdRef.current !== cwd) {
          atLoadedCwdRef.current = cwd;
          invoke<{ id: string; name: string }[]>("list_files", { path: cwd })
            .then((files) => setAtFiles(files.map((f) => ({ path: f.id.replace(/\\/g, "/"), name: f.name }))))
            .catch(() => setAtFiles([]));
        }
        return;
      }
      setAtOpen(false);
      atPositionRef.current = -1;

      const match = textBeforeCursor.match(/(?:^|\s)(\/\S*)$/);
      if (!match) {
        setSlashOpen(false);
        slashPositionRef.current = -1;
        return;
      }
      const slashPos = (match.index ?? 0) + (match[0].length - match[1].length);
      const query = match[1].slice(1);
      slashPositionRef.current = slashPos;
      setSlashOpen(true);
      setSlashIndex(-1);
      if (queryTimerRef.current !== null) window.clearTimeout(queryTimerRef.current);
      window.setTimeout(() => setCommandQuery(query), 150);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, activeTabId],
  );

  /** 资源管理器定位 ~/.codex 下指定文件(auth.json/config.toml/AGENTS.md),用户自行决定怎么打开。 */
  const openCodexHomeFile = useCallback(
    (file: string) => {
      void homeDir()
        .then((home) => void invoke("reveal_in_folder", { path: `${home}/.codex/${file}` }).catch(() => {}))
        .catch(() => setUnsupportedMsg(t("codexpane.unsupportedNoCwd")));
    },
    [t],
  );

  const applySlashCommand = useCallback(
    (cmd: SlashCmd) => {
      const ta = inputRef.current;
      // 触发式:/ 指令选中即执行(清掉触发的 /token,关面板,按命令分发)。
      const slashPos = slashPositionRef.current >= 0 ? slashPositionRef.current : (ta?.selectionStart ?? input.length);
      const before = input.slice(0, slashPos);
      const afterSlash = input.slice(slashPos);
      const spaceIdx = afterSlash.indexOf(" ");
      const after = spaceIdx !== -1 ? afterSlash.slice(spaceIdx).trimStart() : "";
      const rest = `${before} ${after}`.replace(/\s+/g, " ").trim();
      setInput(rest);
      setSlashOpen(false);
      slashPositionRef.current = -1;
      requestAnimationFrame(() => ta?.focus());

      const transport = getCodexTransportRef.current(activeTabId);
      switch (cmd.name) {
        case "new":
          // 开新会话:清前端 state + 下轮 send 不带 resume(后端清 live id)。
          transport.newSession();
          break;
        case "exit":
          onCloseTab?.(paneId, activeTabId);
          break;
        case "model":
          setMenuMode("model");
          break;
        case "reasoning":
          setMenuMode("reasoning");
          break;
        case "status":
        case "usage":
          setCostOpen(true);
          break;
        case "help":
          setHelpOpen(true);
          break;
        case "resume":
          setResumeOpen(true);
          break;
        case "diff": {
          // 查看工作区改动:走 `!` 命令内联跑 git diff。
          const shellTransport = getShellRunTransportRef.current(activeTabId);
          const cwd = sessions.find((s) => s.id === activeTabId)?.cwd;
          void shellTransport.run("git diff", cwd);
          break;
        }
        case "init": {
          // 资源管理器定位项目 AGENTS.md(codex 的项目指令文件,非 CLAUDE.md)。
          const cwd = sessions.find((s) => s.id === activeTabId)?.cwd;
          if (cwd) void invoke("reveal_in_folder", { path: `${cwd}/AGENTS.md`, cwd }).catch(() => {});
          else setUnsupportedMsg(t("codexpane.unsupportedNoCwd"));
          break;
        }
        case "auth":
          openCodexHomeFile("auth.json");
          break;
        case "mcp":
          openCodexHomeFile("config.toml");
          break;
        case "agent":
          openCodexHomeFile("AGENTS.md");
          break;
        default:
          setUnsupportedMsg(t("codexpane.unsupported", { cmd: `/${cmd.name}` }));
      }
    },
    [input, activeTabId, paneId, onCloseTab, sessions, t, openCodexHomeFile],
  );

  /** Tab 补全:把触发的 /token 替换为 `/<name> `(带尾空格),不执行。与 ClaudePane 同。 */
  const completeSlashCommand = useCallback(
    (cmd: SlashCmd) => {
      const ta = inputRef.current;
      const slashPos = slashPositionRef.current >= 0 ? slashPositionRef.current : (ta?.selectionStart ?? input.length);
      const cursorPos = ta?.selectionStart ?? input.length;
      const before = input.slice(0, slashPos);
      const afterToken = input.slice(cursorPos);
      const replacement = `/${cmd.name} `;
      const next = `${before}${replacement}${afterToken}`;
      setInput(next);
      setSlashOpen(false);
      slashPositionRef.current = -1;
      if (queryTimerRef.current !== null) {
        window.clearTimeout(queryTimerRef.current);
        queryTimerRef.current = null;
      }
      setCommandQuery("");
      requestAnimationFrame(() => {
        ta?.focus();
        const pos = (before + replacement).length;
        ta?.setSelectionRange(pos, pos);
      });
    },
    [input],
  );

  /** @ 文件引用:选中文件 -> 替换 @token 为 `@<path> `。 */
  const applyAtFile = useCallback(
    (file: { path: string; name: string }) => {
      const ta = inputRef.current;
      const atPos = atPositionRef.current >= 0 ? atPositionRef.current : (ta?.selectionStart ?? input.length);
      const before = input.slice(0, atPos);
      const after = input.slice(ta?.selectionEnd ?? atPos);
      const sep = before && !/\s$/.test(before) ? " " : "";
      const next = `${before}${sep}@${file.path} ${after}`;
      setInput(next);
      setAtOpen(false);
      atPositionRef.current = -1;
      requestAnimationFrame(() => {
        ta?.focus();
        const pos = `${before}${sep}@${file.path} `.length;
        ta?.setSelectionRange(pos, pos);
      });
    },
    [input],
  );

  const busy = state?.status === "running";

  // 「思考中」判定:busy 且最近 assistant 消息尚无可见文本/工具内容(codex item 粒度,
  // turn_started 后到首个 item.completed 前为纯思考期)。
  const thinkingNow = useMemo(() => {
    if (!busy || !state) return false;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role === "assistant") {
        if (m.blocks.some((b) => (b.type === "text" && b.text.length > 0) || b.type === "tool_use")) {
          return false;
        }
        return true;
      }
    }
    return true;
  }, [busy, state]);

  // 「执行中」上下文:busy 且思考结束后,取最近 assistant 消息里最后一个仍
  // pending/running 的 tool_use,驱动输入框上方指示行「正在执行 X…」(与 ClaudePane 对等;
  // 此前该阶段无任何指示,长命令运行中用户无从察觉)。无则兜底通用「运行中」。
  const runningTool = useMemo(() => {
    if (!busy || thinkingNow || !state) return null;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role !== "assistant") continue;
      for (let j = m.blocks.length - 1; j >= 0; j--) {
        const b = m.blocks[j];
        if (b.type === "tool_use" && (b.status === "pending" || b.status === "running")) {
          return `${b.name}${b.inputBrief ? ` ${b.inputBrief}` : ""}`.slice(0, 60);
        }
      }
      return null;
    }
    return null;
  }, [busy, thinkingNow, state]);

  // ↑/↓ 浏览输入历史。与 ClaudePane 同实现。
  const navigateHistory = useCallback(
    (dir: 1 | -1) => {
      if (history.length === 0) return;
      setHistoryIndex((idx) => {
        let next = idx;
        if (dir === -1) {
          if (next === -1) {
            draftRef.current = inputRef.current?.value ?? input;
            next = history.length - 1;
          } else {
            next = Math.max(0, next - 1);
          }
        } else {
          if (next === -1) return -1;
          next += 1;
          if (next >= history.length) next = -1;
        }
        setInput(next === -1 ? draftRef.current : history[next]);
        requestAnimationFrame(() => {
          const ta = inputRef.current;
          if (!ta) return;
          const len = ta.value.length;
          ta.setSelectionRange(len, len);
        });
        return next;
      });
    },
    [history, input],
  );

  // `!` 命令执行中(提前派生防 TDZ)。
  const shellRunning = shellState?.running ?? false;

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setHistory((h) => {
      const filtered = h.filter((x) => x !== text);
      const next = [...filtered, text];
      const trimmed = next.length > 100 ? next.slice(next.length - 100) : next;
      const sk = historyStorageKeyRef.current;
      if (sk) {
        try { localStorage.setItem(sk, JSON.stringify(trimmed)); } catch { /* ignore */ }
      }
      return trimmed;
    });
    setHistoryIndex(-1);
    const transport = getCodexTransportRef.current(activeTabId);
    // `!` 命令:内联执行 PowerShell(不走 codex 进程)。同 ClaudePane。
    if (text.startsWith("!")) {
      if (shellRunning) return;
      const cmd = text.slice(1).trim();
      setInput("");
      setSlashOpen(false);
      if (cmd) {
        const shellTransport = getShellRunTransportRef.current(activeTabId);
        const cwd = sessions.find((s) => s.id === activeTabId)?.cwd;
        void shellTransport.run(cmd, cwd);
      }
      return;
    }
    // /new:开新会话(清 state + 下轮不带 resume)。
    if (text === "/new" || text === "/clear") {
      setInput("");
      setSlashOpen(false);
      transport.newSession();
      return;
    }
    // /exit:关闭 tab。
    if (text === "/exit") {
      setInput("");
      setSlashOpen(false);
      onCloseTab?.(paneId, activeTabId);
      return;
    }
    // busy 时先中断当前轮(后端 busy 会拒),下轮带 registry live id 续接(codex 记得上下文)。
    if (busy) {
      await transport.interrupt();
    }
    setInput("");
    setSlashOpen(false);
    void transport.send(text);
  }, [activeTabId, input, busy, shellRunning, sessions, paneId, onCloseTab]);

  const handleInterrupt = useCallback(() => {
    const transport = getCodexTransportRef.current(activeTabId);
    void transport.interrupt();
  }, [activeTabId]);

  const handleShellInterrupt = useCallback(() => {
    const transport = getShellRunTransportRef.current(activeTabId);
    void transport.interrupt();
  }, [activeTabId]);

  // 应用选中的 model:调 transport.setModel(--m 下轮 spawn 生效,无需重启/不打断当前轮)。
  // 同时更新组件层 contextWindow(catalog 项),ctx 显示跟随所选模型。
  const applyModel = useCallback(
    (slug: string) => {
      const transport = getCodexTransportRef.current(activeTabId);
      setMenuMode(null);
      transport.setModel(slug);
      if (slug === "default") {
        setContextWindow(undefined);
      } else {
        const m = availableModels.find((x) => x.slug === slug);
        setContextWindow(m?.contextWindow);
      }
    },
    [activeTabId, availableModels],
  );

  // 应用选中的 reasoning effort(下轮 spawn 生效)。
  const applyReasoning = useCallback(
    (level: string) => {
      const transport = getCodexTransportRef.current(activeTabId);
      transport.setReasoning(level === "auto" ? undefined : level);
      setMenuMode(null);
    },
    [activeTabId],
  );

  const canSend = !!input.trim() && !codexMissing && !shellRunning;

  // -- sandbox 策略:状态栏显示 + 切换 + Shift+Tab 循环(替代 claude 的 permission mode) --
  const [sandbox, setSandboxState] = useState<string>(() => getCodexTransport(activeTabId).getSandbox());
  useEffect(() => {
    setSandboxState(getCodexTransport(activeTabId).getSandbox());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);
  const setSandboxMode = useCallback(
    (mode: string) => {
      getCodexTransportRef.current(activeTabId).setSandbox(mode);
      setSandboxState(mode);
      setMenuMode(null);
    },
    [activeTabId],
  );
  const cycleSandbox = useCallback(() => {
    const transport = getCodexTransportRef.current(activeTabId);
    const cur = transport.getSandbox();
    const idx = SANDBOX_MODES.findIndex((m) => m.id === cur);
    const next = SANDBOX_MODES[(idx + 1) % SANDBOX_MODES.length];
    transport.setSandbox(next.id);
    setSandboxState(next.id);
  }, [activeTabId]);
  const currentSandboxMeta = SANDBOX_MODES.find((m) => m.id === sandbox) ?? SANDBOX_MODES[1];

  // -- 双击 Esc 中断(对齐 claude code/codex 交互) --
  const lastEscRef = useRef(0);
  const slashOpenRef = useRef(slashOpen);
  slashOpenRef.current = slashOpen;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const handleInterruptRef = useRef(handleInterrupt);
  handleInterruptRef.current = handleInterrupt;
  useEffect(() => {
    if (!focused) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (slashOpenRef.current) return;
      const now = Date.now();
      if (now - lastEscRef.current < 400) {
        lastEscRef.current = 0;
        if (busyRef.current) {
          e.preventDefault();
          handleInterruptRef.current();
        }
      } else {
        lastEscRef.current = now;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focused]);

  // -- 会话时长计时(首次出现消息开始) --
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (sessionStart === null && state && state.messages.length > 0) {
      setSessionStart(Date.now());
    }
  }, [state, sessionStart]);
  useEffect(() => {
    if (sessionStart === null) return;
    const update = () => setElapsed(Date.now() - sessionStart);
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [sessionStart]);

  // 本轮耗时:busy false->true 记 turnStart。
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const [turnElapsed, setTurnElapsed] = useState(0);
  const prevBusyRef = useRef(false);
  useEffect(() => {
    if (busy && !prevBusyRef.current) setTurnStart(Date.now());
    else if (!busy) setTurnStart(null);
    prevBusyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    if (turnStart === null) {
      setTurnElapsed(0);
      return;
    }
    const update = () => setTurnElapsed(Date.now() - (turnStart ?? 0));
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [turnStart]);

  // 会话累计 token(遍历 assistant usage 求和;turn_completed 回填,整轮近似)。
  const sessionTokens = useMemo(() => {
    if (!state) return { input: 0, output: 0 };
    let input = 0;
    let output = 0;
    for (const m of state.messages) {
      if (m.role === "assistant" && m.usage) {
        input += (m.usage.input_tokens ?? 0) + (m.usage.cached_input_tokens ?? 0) + (m.usage.cache_write_input_tokens ?? 0);
        output += m.usage.output_tokens ?? 0;
      }
    }
    return { input, output };
  }, [state]);

  // 状态栏 model:meta.model(spawn -m 乐观 + hydrate 回填的 config 默认)。
  const model = state?.meta?.model;

  // 当前上下文用量:lastUsage(input+cached)/contextWindow(catalog 回填,无则不显 %)。
  const contextInfo = useMemo(() => {
    const u = state?.lastUsage;
    const window = contextWindow;
    const ctx = u ? (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0) + (u.cache_write_input_tokens ?? 0) : 0;
    const pct = ctx > 0 && window ? Math.min(100, (ctx / window) * 100) : 0;
    return { window, ctx, pct };
  }, [state, contextWindow]);

  // 当前可选 reasoning 档位:catalog 中当前 model 项的 supported_reasoning_levels,兜底预置。
  const reasoningLevels = useMemo(() => {
    const alias = getCodexTransportRef.current(activeTabId)?.getSelectedModelAlias();
    const m = availableModels.find((x) => x.slug === (alias ?? model));
    return m && m.reasoningLevels.length > 0 ? m.reasoningLevels : FALLBACK_REASONING_LEVELS;
  }, [availableModels, model, activeTabId]);

  // 完成通知:busy true->false 且窗口未聚焦时桌面通知。
  const prevNotifBusyRef = useRef(false);
  useEffect(() => {
    const justFinished = prevNotifBusyRef.current && !busy;
    prevNotifBusyRef.current = busy;
    if (!justFinished) return;
    if (typeof Notification === "undefined" || document.hasFocus()) return;
    try {
      if (Notification.permission === "granted") {
        new Notification(t("codexpane.notifTitle"), { body: t("codexpane.notifBody") });
      } else if (Notification.permission !== "denied") {
        void Notification.requestPermission();
      }
    } catch {
      /* 通知不可用,忽略 */
    }
  }, [busy, t]);

  // 不支持的 slash 命令提示,3s 自动消失。
  useEffect(() => {
    if (!unsupportedMsg) return;
    const id = window.setTimeout(() => setUnsupportedMsg(null), 3000);
    return () => window.clearTimeout(id);
  }, [unsupportedMsg]);

  return (
    <article
      className={`grid h-full min-h-0 min-w-0 grid-rows-[length:var(--mx-paneheader-h)_1fr] overflow-hidden bg-[var(--mx-editor-bg)] ${className ?? ""}`}
      onMouseDown={() => onFocusPane?.(paneId)}
    >
      {/* header:tab 条 + 右侧按钮组。 */}
      <header className="flex min-w-0 shrink-0 items-center justify-between gap-2 px-2 text-xs transition-colors bg-[var(--mx-tabbar-bg)]">
        <Tabs value={activeTabId} onValueChange={(id) => onSetActiveTab?.(paneId, id)}>
          <TabsList className="mx-tabs-list flex min-w-0 items-center gap-0 overflow-x-auto [&::-webkit-scrollbar]:hidden">
            {sessions.map((s) => {
              const isActive = s.id === activeTabId;
              return (
                <CodexTabChip
                  key={s.id}
                  session={s}
                  isActive={isActive}
                  showClose={sessions.length > 1 && !!onCloseTab}
                  paneId={paneId}
                  getCodexTransport={getCodexTransportStable}
                  shellRunning={isActive && shellRunning}
                  onCloseTab={onCloseTabStable}
                />
              );
            })}
          </TabsList>
        </Tabs>
        <div className="flex shrink-0 items-center gap-1 text-[var(--mx-muted)]">
          {/* 重置当前会话:清屏 + resume 当前 thread id(下次 send 续接同 thread)。 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-[14px] text-[var(--mx-muted)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  getCodexTransportRef.current(activeTabId)?.resetSession();
                }}
              >
                ↺
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("session.resetSession")}</TooltipContent>
          </Tooltip>
          {onResumeSession && (
            <Popover open={resumeOpen} onOpenChange={setResumeOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-[14px] text-[var(--mx-muted)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      ↻
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{t("session.resumeById")}</TooltipContent>
              </Tooltip>
              <PopoverContent className="w-72 p-2" align="end">
                <div className="flex flex-col gap-2">
                  <QuickResumeLast
                    loading={lastLoading}
                    item={lastSession}
                    locale={i18n.language}
                    onPick={(sid) => {
                      onResumeSession?.(sid);
                      setResumeOpen(false);
                    }}
                  />
                  <div className="border-t border-[var(--mx-border)]" />
                  <input
                    autoFocus
                    value={resumeInput}
                    onChange={(e) => setResumeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && resumeInput.trim()) {
                        onResumeSession(resumeInput.trim());
                        setResumeOpen(false);
                        setResumeInput("");
                      }
                    }}
                    placeholder={t("session.resumeSessionIdPlaceholder")}
                    className="rounded border border-[var(--mx-border-strong)] bg-[var(--mx-editor-bg)] px-2 py-1 text-xs text-[var(--mx-text)] outline-none focus:border-[var(--mx-accent)]"
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      if (resumeInput.trim()) {
                        onResumeSession(resumeInput.trim());
                        setResumeOpen(false);
                        setResumeInput("");
                      }
                    }}
                  >
                    {t("session.resumeById")}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
          {onAddTab && (
            <Popover open={menuMode === "tab"} onOpenChange={(o) => setMenuMode(o ? "tab" : null)}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-[14px] text-[var(--mx-muted)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      +
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{t("shell.tab.new")}</TooltipContent>
              </Tooltip>
              {menuMode === "tab" && (
                <ShellMenu
                  onSelect={(kind) => {
                    setMenuMode(null);
                    onAddTab(paneId, kind);
                  }}
                />
              )}
            </Popover>
          )}
          {onSplitPane && (
            <SplitPaneButtons onSplit={(kind, direction) => onSplitPane(paneId, kind, direction)} />
          )}
          {onClosePane && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-[13px] text-[var(--mx-muted)] hover:bg-[var(--mx-danger-bg)] hover:text-[var(--mx-danger-bright)]"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    onClosePane(paneId);
                  }}
                >
                  ×
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("shell.pane.close")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      {/* 主体:消息流 + 底部浮动输入区。 */}
      <div className="grid min-h-0 min-w-0 grid-rows-[1fr_auto]">
        <div ref={scrollRef} onScroll={handleScroll} className="mx-scroll-pretty relative min-h-0 overflow-y-auto px-4 py-4" style={{ fontSize }}>
          {state && (state.messages.length > 0 || (shellState?.messages.length ?? 0) > 0) ? (
            <div ref={contentRef} className="mx-auto w-full max-w-[54.25rem] space-y-1">
              {mergeCodexAndShellMessages(state.messages, shellState?.messages ?? []).map((item) =>
                item.kind === "shell" ? (
                  <ShellRow key={`shell-${item.msg.id}`} message={item.msg} t={t} onInterrupt={handleShellInterrupt} />
                ) : (
                  <MessageRow key={item.msg.id} message={item.msg} t={t} />
                ),
              )}
            </div>
          ) : (
            <div className="grid h-full place-items-center text-xs text-[var(--mx-faint)]">
              {state ? t("codexpane.empty") : probeDone ? t("codexpane.loading") : "…"}
            </div>
          )}
          {showScrollBottom && (
            <button
              type="button"
              aria-label={t("codexpane.scrollToBottom")}
              onClick={scrollToBottom}
              onMouseDown={(e) => e.stopPropagation()}
              className="sticky bottom-2 left-full z-10 -ml-9 grid h-8 w-8 -translate-x-2 place-items-center rounded-full border border-[var(--mx-border-strong)] bg-[var(--mx-card-bg)]/95 text-[var(--mx-muted)] shadow-lg transition-colors hover:bg-[var(--mx-accent-soft)] hover:text-[var(--mx-accent)]"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14M19 12l-7 7-7-7" />
              </svg>
            </button>
          )}
        </div>

        {/* 底部浮动输入区:状态行 + textarea + 发送/中断按钮。 */}
        <div className="shrink-0 px-4 pb-3 pt-1">
          <div className="mx-auto max-w-[54.25rem]">
            {/* 会话状态指示行:思考中(紫)> 执行中(蓝,带当前 running 工具名)。
                busy 全程可见 -- 与 ClaudePane 对等,长命令运行中用户也能察觉会话仍在进行。 */}
            {busy && (
              <div
                className={`mb-1.5 flex items-center gap-2 px-1 text-[11px] ${
                  thinkingNow ? "text-[var(--mx-violet)]" : "text-[var(--mx-accent)]"
                }`}
              >
                <ThinkingDots />
                <span>
                  {thinkingNow
                    ? t("codexpane.thinking")
                    : runningTool
                      ? t("codexpane.runningTool", { tool: runningTool })
                      : t("codexpane.toolRunning")}
                </span>
                <span className="tabular-nums text-[var(--mx-faint)]">
                  ⏱ {formatElapsed(turnElapsed)}
                </span>
              </div>
            )}
            {codexMissing ? (
              /* 未安装提示卡片。 */
              <div className="mx-chip flex flex-col gap-2 border border-[var(--mx-danger-border)] bg-[var(--mx-danger-bg)] px-3 py-3 text-[11px] text-[var(--mx-text)]">
                <div className="flex items-center gap-2 font-[600] text-[var(--mx-danger-bright)]">
                  <IconWarn />
                  {t("codexpane.notInstalled")}
                </div>
                <code className="mx-scroll-pretty rounded bg-[var(--mx-bg)] px-2 py-1 font-mono text-[10px] text-[var(--mx-muted)]">
                  {t("codexpane.installCmd")}
                </code>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="self-start text-[10px] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
                  onClick={() => {
                    setCodexMissing(false);
                    setProbeDone(false);
                    invoke<Record<string, boolean>>("check_commands_installed", { commands: ["codex"] })
                      .then((r) => {
                        setCodexMissing(!r["codex"]);
                        setProbeDone(true);
                      })
                      .catch(() => setProbeDone(true));
                  }}
                >
                  {t("codexpane.retry")}
                </Button>
              </div>
            ) : (
              <Popover open={(slashOpen && slashMatches.length > 0) || (atOpen && atMatches.length > 0)}>
                <PopoverAnchor asChild>
                  <div className="mx-chip flex flex-col border border-[var(--mx-border)] bg-[var(--mx-card-bg)] px-3 py-2 shadow-lg focus-within:border-[var(--mx-accent)]">
                    <div className="flex items-end gap-2">
                    <div className="relative min-w-0 flex-1">
                      <div
                        ref={highlightRef}
                        aria-hidden
                        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap p-0 font-mono text-transparent"
                        style={{ fontSize, lineHeight: "1.5" }}
                      >
                        {input ? renderHighlighted(input) : null}
                      </div>
                      <textarea
                        ref={inputRef}
                        value={input}
                        onChange={handleInputChange}
                        onScroll={(e) => {
                          if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop;
                        }}
                        onKeyDown={(e) => {
                          // Alt+Enter 恒为换行(优先于 @/slash 面板选中与发送;
                          // Windows Chromium textarea 对带 Alt 的 Enter 默认不插换行,故手动补)。
                          if (e.key === "Enter" && e.altKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            const ta = e.currentTarget;
                            const start = ta.selectionStart;
                            const end = ta.selectionEnd;
                            setInput(input.slice(0, start) + "\n" + input.slice(end));
                            // 受控 value 更新后光标会被重置,rAF(渲染后)恢复到换行符之后。
                            requestAnimationFrame(() => {
                              ta.selectionStart = ta.selectionEnd = start + 1;
                            });
                            return;
                          }
                          // ↑/↓ 浏览输入历史。
                          if (!slashOpen && !atOpen && !e.nativeEvent.isComposing && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                            const ta = inputRef.current;
                            const pos = ta?.selectionStart ?? input.length;
                            const before = input.slice(0, pos);
                            const after = input.slice(pos);
                            if (e.key === "ArrowUp" && history.length > 0 && !before.includes("\n")) {
                              e.preventDefault();
                              navigateHistory(-1);
                              return;
                            }
                            if (e.key === "ArrowDown" && historyIndex !== -1 && !after.includes("\n")) {
                              e.preventDefault();
                              navigateHistory(1);
                              return;
                            }
                          }
                          // @ 文件引用面板键位。
                          if (atOpen) {
                            if (e.key === "ArrowDown" && atMatches.length > 0) {
                              e.preventDefault();
                              setAtIndex((i) => (i < atMatches.length - 1 ? i + 1 : 0));
                              return;
                            }
                            if (e.key === "ArrowUp" && atMatches.length > 0) {
                              e.preventDefault();
                              setAtIndex((i) => (i > 0 ? i - 1 : atMatches.length - 1));
                              return;
                            }
                            if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing && atMatches.length > 0) {
                              e.preventDefault();
                              applyAtFile(atMatches[atIndex >= 0 ? atIndex : 0] ?? atMatches[0]);
                              return;
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setAtOpen(false);
                              return;
                            }
                          }
                          // slash 面板键位。
                          if (slashOpen) {
                            if (e.key === "ArrowDown" && slashMatches.length > 0) {
                              e.preventDefault();
                              setSlashIndex((i) => (i < slashMatches.length - 1 ? i + 1 : 0));
                              return;
                            }
                            if (e.key === "ArrowUp" && slashMatches.length > 0) {
                              e.preventDefault();
                              setSlashIndex((i) => (i > 0 ? i - 1 : slashMatches.length - 1));
                              return;
                            }
                            if (e.key === "Tab" && !e.shiftKey && !e.nativeEvent.isComposing && slashMatches.length > 0) {
                              e.preventDefault();
                              completeSlashCommand(slashMatches[slashIndex >= 0 ? slashIndex : 0] ?? slashMatches[0]);
                              return;
                            }
                            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && slashMatches.length > 0) {
                              e.preventDefault();
                              applySlashCommand(slashMatches[slashIndex >= 0 ? slashIndex : 0] ?? slashMatches[0]);
                              return;
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setSlashOpen(false);
                              return;
                            }
                          }
                          // Shift+Tab 循环切换 sandbox 策略。
                          if (e.key === "Tab" && e.shiftKey) {
                            e.preventDefault();
                            cycleSandbox();
                            return;
                          }
                          // 回车发送(IME 组合输入中不触发;Shift/Alt+Enter 换行已在前置分支)。shellRunning 时拦(! 命令与 codex 串行)。
                          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !codexMissing && !shellRunning) {
                            e.preventDefault();
                            handleSend();
                          }
                        }}
                        rows={2}
                        placeholder={t("codexpane.slashHint")}
                        /* field-sizing-content:随内容在 min-h~max-h 间自动长高,超高才内部滚动(滚轮仍可滚);
                           滚动条隐藏而非美化:占宽会让 textarea 换行窄于覆盖层,造成视觉错位。 */
                        className="relative max-h-[160px] min-h-[36px] w-full field-sizing-content resize-none bg-transparent p-0 font-mono caret-[var(--mx-text)] text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                        style={{ fontSize, lineHeight: "1.5" }}
                      />
                    </div>
                    {busy && !input.trim() ? (
                      <button
                        type="button"
                        aria-label={t("codexpane.interrupt")}
                        onClick={handleInterrupt}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--mx-danger-bright)] transition-colors hover:bg-[var(--mx-danger-bg)] hover:text-[var(--mx-danger)]"
                      >
                        <IconStop />
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={t("codexpane.send")}
                        onClick={handleSend}
                        disabled={!canSend}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-accent-soft)] hover:text-[var(--mx-accent)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--mx-muted)]"
                      >
                        <IconSend />
                      </button>
                    )}
                    </div>
                    {/* 卡片内底部状态栏:sandbox + model + reasoning + ctx + tokens + 时长。
                        字号随全局 fontSize 缩放(statusFontSize,14→10 与原 text-[10px] 一致)。 */}
                    <div
                      className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-[var(--mx-border)] pt-1.5 tabular-nums text-[var(--mx-muted)]"
                      style={{ fontSize: statusFontPx }}
                    >
                      {state?.terminatedReason ? (
                        <span className="shrink-0 text-[var(--mx-danger)]">{t("codexpane.terminated")}</span>
                      ) : null}
                      {/* sandbox 策略:点击切换,Shift+Tab 循环。 */}
                      <Popover open={menuMode === "sandbox"} onOpenChange={(o) => setMenuMode(o ? "sandbox" : null)}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            onMouseDown={(e) => e.stopPropagation()}
                            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[var(--mx-text)] transition-colors hover:bg-[var(--mx-border)]"
                            title={t(currentSandboxMeta.desc)}
                          >
                            <span
                              className={
                                sandbox === "danger-full-access"
                                  ? "text-[var(--mx-danger-bright)]"
                                  : sandbox === "read-only"
                                    ? "text-[var(--mx-violet)]"
                                    : "text-[var(--mx-success)]"
                              }
                            >
                              {currentSandboxMeta.label}
                            </span>
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </button>
                        </PopoverTrigger>
                        {menuMode === "sandbox" && (
                          <PopoverContent
                            side="top"
                            align="start"
                            sideOffset={4}
                            onOpenAutoFocus={(e) => e.preventDefault()}
                            className="mx-menu w-[230px] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
                          >
                            {SANDBOX_MODES.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={() => setSandboxMode(m.id)}
                                className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                                  m.id === sandbox
                                    ? "bg-[var(--mx-selected-bg)] text-[var(--mx-text)]"
                                    : "text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                                }`}
                              >
                                <span className="w-14 shrink-0 font-mono text-[11px] font-semibold">{m.label}</span>
                                <span className="text-[10px] leading-tight">{t(m.desc)}</span>
                              </button>
                            ))}
                          </PopoverContent>
                        )}
                      </Popover>
                      {/* model:点击上拉选择器(读 cc-switch catalog;选中 -m 下轮生效)。 */}
                      <Popover open={menuMode === "model"} onOpenChange={(o) => {
                        setMenuMode(o ? "model" : null);
                        if (!o) return;
                        // 每次打开:实时拉 catalog 模型 + 检测 codex 配置变化(cc-switch 切供应商)。
                        void invoke<CodexModelInfo[]>("list_codex_models").then((list) => {
                          setAvailableModels(list);
                          // 顺带回填当前 model 的 contextWindow(ctx 显示)。
                          const alias = getCodexTransportRef.current(activeTabId)?.getSelectedModelAlias();
                          const m = list.find((x) => x.slug === (alias ?? stateRef.current?.meta?.model));
                          setContextWindow(m?.contextWindow);
                        }).catch(() => {});
                        void getCodexTransportRef.current(activeTabId)?.refreshIfConfigChanged();
                      }}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            onMouseDown={(e) => e.stopPropagation()}
                            className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
                            title={model ?? ""}
                          >
                            {shortModel(model)}
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </button>
                        </PopoverTrigger>
                        {menuMode === "model" && (
                          <PopoverContent
                            side="top"
                            align="start"
                            sideOffset={4}
                            onOpenAutoFocus={(e) => e.preventDefault()}
                            className="mx-menu w-[260px] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
                          >
                            {/* 当前模型行(仿 claude /model)。 */}
                            <div className="flex items-center gap-2 rounded px-2 py-1.5 text-[var(--mx-text)]">
                              <span className="w-14 shrink-0 font-mono text-[10px] font-semibold text-[var(--mx-accent)]">{t("codexpane.modelCurrent")}</span>
                              <span className="flex-1 truncate font-mono text-[11px]" title={model ?? ""}>{model ?? "-"}</span>
                            </div>
                            <div className="mx-1 mb-1 border-t border-[var(--mx-border)]" />
                            {/* 恢复默认(不传 -m,用 config.toml 默认)。 */}
                            <button
                              type="button"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={() => applyModel("default")}
                              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                                getCodexTransportRef.current(activeTabId)?.getSelectedModelAlias() === "default"
                                  ? "bg-[var(--mx-selected-bg)] text-[var(--mx-text)]"
                                  : "text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                              }`}
                            >
                              <span className="flex-1 truncate font-mono text-[11px] font-semibold">default</span>
                            </button>
                            {availableModels.length === 0 ? (
                              <div className="px-2 py-1.5 text-[10px] text-[var(--mx-faint)]">
                                {t("codexpane.modelEmpty")}
                              </div>
                            ) : (
                              availableModels.map((m) => {
                                const alias = getCodexTransportRef.current(activeTabId)?.getSelectedModelAlias();
                                const active = alias === m.slug || (!alias && model === m.slug);
                                return (
                                  <button
                                    key={m.slug}
                                    type="button"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={() => applyModel(m.slug)}
                                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                                      active
                                        ? "bg-[var(--mx-selected-bg)] text-[var(--mx-text)]"
                                        : "text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                                    }`}
                                  >
                                    <span className="flex-1 truncate font-mono text-[11px] font-semibold" title={m.displayName}>{m.displayName}</span>
                                    {active && (
                                      <svg className="h-3 w-3 shrink-0 text-[var(--mx-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                                        <path d="M5 13l4 4L19 7" />
                                      </svg>
                                    )}
                                  </button>
                                );
                              })
                            )}
                          </PopoverContent>
                        )}
                      </Popover>
                      {/* reasoning(推理强度,codex /reasoning 的 UI 化)。 */}
                      <Popover open={menuMode === "reasoning"} onOpenChange={(o) => setMenuMode(o ? "reasoning" : null)}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            onMouseDown={(e) => e.stopPropagation()}
                            className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
                            title={t("codexpane.reasoningTitle")}
                          >
                            <span aria-hidden>⚡</span>
                            <span>{state?.meta?.reasoningEffort ?? "auto"}</span>
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </button>
                        </PopoverTrigger>
                        {menuMode === "reasoning" && (
                          <PopoverContent
                            side="top"
                            align="start"
                            sideOffset={4}
                            onOpenAutoFocus={(e) => e.preventDefault()}
                            className="mx-menu w-[150px] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
                          >
                            {[{ level: "auto" }, ...reasoningLevels.map((l) => ({ level: l }))].map(({ level }) => {
                              const cur = state?.meta?.reasoningEffort ?? "auto";
                              const active = level === cur;
                              return (
                                <button
                                  key={level}
                                  type="button"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={() => applyReasoning(level)}
                                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors ${
                                    active
                                      ? "bg-[var(--mx-selected-bg)] text-[var(--mx-text)]"
                                      : "text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                                  }`}
                                >
                                  <span className="w-12 shrink-0 font-mono font-semibold">{level}</span>
                                  {active && (
                                    <svg className="ml-auto h-3 w-3 shrink-0 text-[var(--mx-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                                      <path d="M5 13l4 4L19 7" />
                                    </svg>
                                  )}
                                </button>
                              );
                            })}
                          </PopoverContent>
                        )}
                      </Popover>
                      {/* ctx:上下文窗口 + 占用%(lastUsage/contextWindow,catalog 提供)。 */}
                      {contextInfo.window && (
                        <span
                          className="shrink-0"
                          title={contextInfo.ctx > 0 ? `已用 ${contextInfo.ctx.toLocaleString()} / ${contextInfo.window.toLocaleString()} tokens(${contextInfo.pct.toFixed(1)}%)` : `窗口上限 ${contextInfo.window.toLocaleString()} tokens`}
                        >
                          ctx {formatTokens(contextInfo.window)}{contextInfo.ctx > 0 ? ` · ${contextInfo.pct.toFixed(1)}%` : ""}
                        </span>
                      )}
                      <span className="shrink-0">
                        ↑{formatTokens(sessionTokens.input)} ↓{formatTokens(sessionTokens.output)}
                      </span>
                      <span className="shrink-0 whitespace-nowrap">⏱ {formatElapsed(elapsed)}</span>
                    </div>
                  </div>
                </PopoverAnchor>
                <PopoverContent
                  side="top"
                  align="start"
                  sideOffset={6}
                  onOpenAutoFocus={(e) => e.preventDefault()}
                  onCloseAutoFocus={(e) => e.preventDefault()}
                  className="mx-menu w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1.5 shadow-xl"
                >
                  <div className="mx-scroll-pretty max-h-[min(50vh,420px)] overflow-y-auto p-0.5">
                  {atOpen
                    ? atMatches.map((f, i) => (
                        <button
                          key={f.path}
                          type="button"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => applyAtFile(f)}
                          onMouseEnter={() => setAtIndex(i)}
                          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors ${i === atIndex ? "bg-[var(--mx-selected-bg)]" : "hover:bg-[var(--mx-hover-bg)]"}`}
                        >
                          <span className="shrink-0 text-[10px] text-[var(--mx-faint)]">@</span>
                          <span className="truncate font-mono text-[11px] text-[var(--mx-text)]" title={f.path}>{f.path}</span>
                        </button>
                      ))
                    : slashMatches.map((cmd, i) => (
                        <CommandItem
                          key={cmd.name}
                          cmd={cmd}
                          index={i}
                          selected={i === slashIndex}
                          onSelect={applySlashCommand}
                          onHover={setSlashIndex}
                        />
                      ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </div>
            {/* slash 命令触发的弹窗 + 不支持命令的底部 toast。 */}
            <DialogLike open={helpOpen} onClose={() => setHelpOpen(false)} title={t("codexpane.helpTitle")}>
              <div className="mt-3 space-y-1.5 text-[11px] text-[var(--mx-muted)]">
                <div><kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Enter</kbd> 发送 · <kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Shift+Enter</kbd> 换行</div>
                <div><kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">↑/↓</kbd> 输入历史</div>
                <div><kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">/</kbd> 命令面板(<kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Tab</kbd> 补全 · <kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Enter</kbd> 执行) · <kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">@</kbd> 文件引用 · <kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">!</kbd> 内联命令</div>
                <div><kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Shift+Tab</kbd> 切 sandbox 策略</div>
                <div><kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Esc Esc</kbd> 中断当前轮</div>
              </div>
            </DialogLike>
            <DialogLike open={costOpen} onClose={() => setCostOpen(false)} title={t("codexpane.costTitle")}>
              <div className="mt-3 space-y-1.5 text-[11px] tabular-nums text-[var(--mx-muted)]">
                <div>↑ 输入<span className="ml-2 text-[var(--mx-text)]">{formatTokens(sessionTokens.input)}</span></div>
                <div>↓ 输出<span className="ml-2 text-[var(--mx-text)]">{formatTokens(sessionTokens.output)}</span></div>
                {contextInfo.window && (
                  <div>ctx 窗口<span className="ml-2 text-[var(--mx-text)]">{formatTokens(contextInfo.window)}</span></div>
                )}
                <div>耗时<span className="ml-2 text-[var(--mx-text)]">{formatElapsed(elapsed)}</span></div>
              </div>
            </DialogLike>
            {unsupportedMsg && (
              <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-[var(--mx-orange-border)] bg-[var(--mx-surface)] px-3 py-1.5 text-[11px] text-[var(--mx-warning-bright)] shadow-lg">
                {unsupportedMsg}
              </div>
            )}
    </article>
  );
}

/**
 * 轻量对话框(标题 + 内容):复用 Dialog 样式但避免拉入 ClaudePane 的 Dialog 依赖差异,
 * help/cost 两个小弹窗用。与 ui/Dialog 同外观。
 */
function DialogLike({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={onClose}>
      <div
        className="w-[420px] max-w-[90vw] rounded-lg border border-[var(--mx-border)] bg-[var(--mx-surface)] px-5 py-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-[var(--mx-text)]">{title}</div>
          <button
            type="button"
            className="text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)]"
            onClick={onClose}
            aria-label="close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * 单条消息渲染--Cursor 式行内流(user › cyan / assistant violet 圆点)。
 * 与 ClaudePane 的 MessageRow 同风格,去掉 plan/approve 相关回调(codex 无)。
 */
const MessageRow = memo(function MessageRow({
  message,
  t,
}: {
  message: CodexMessage;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const time = formatTime(message.timestamp);

  if (message.role === "user") {
    const text = message.blocks
      .filter((b): b is Extract<CodexBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text.trim().length === 0) return null;
    return (
      <div className="flex gap-2">
        {/* 行首圆点:与 assistant violet 圆点同构,改青色(mx-accent,即 codex 品牌色)区分 user/assistant。 */}
        <span aria-hidden className="flex h-[1.625em] shrink-0 items-center">
          <span className="h-2 w-2 rounded-full bg-[var(--mx-accent)]" />
        </span>
        <div className="group min-w-0 flex-1">
          <div dir="auto" className="whitespace-pre-wrap break-words leading-relaxed text-[var(--mx-text)]">
            {text}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] tabular-nums text-[var(--mx-faint)]">
            {time && <span>{time}</span>}
            <CopyButton text={text} t={t} className="ml-auto opacity-0 group-hover:opacity-100" />
          </div>
        </div>
      </div>
    );
  }

  // assistant:行首 violet 圆点 + 正文块流 + 末行时间/tokens。
  const fullText = message.blocks
    .filter((b): b is Extract<CodexBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return (
    <div className="flex gap-2">
      <span aria-hidden className="flex h-[1.625em] shrink-0 items-center">
        <span className="h-2 w-2 rounded-full bg-[var(--mx-violet)]" />
      </span>
      <div className="group min-w-0 flex-1">
        <div className="flex flex-col gap-2">
          {message.blocks.map((b, i) => (
            <BlockView key={i} block={b} t={t} />
          ))}
          {message.blocks.length === 0 && message.streaming && (
            <div className="flex items-center gap-2 text-xs text-[var(--mx-muted)]">
              <ThinkingDots />
              {t("codexpane.thinking")}
            </div>
          )}
        </div>
        {(time || message.usage || fullText) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-[var(--mx-faint)]">
            {time && <span>{time}</span>}
            {message.usage &&
              ((message.usage.input_tokens ?? 0) > 0 ||
                (message.usage.output_tokens ?? 0) > 0) && (
                <span>
                  ↑{formatTokens((message.usage.input_tokens ?? 0) + (message.usage.cached_input_tokens ?? 0))} ↓
                  {formatTokens(message.usage.output_tokens ?? 0)}
                </span>
              )}
            {fullText && <CopyButton text={fullText} t={t} className="ml-auto opacity-0 group-hover:opacity-100" />}
          </div>
        )}
      </div>
    </div>
  );
});

/** 单个 block 渲染:text / thinking / tool_use。 */
function BlockView({
  block,
  t,
}: {
  block: CodexBlock;
  t: (k: string) => string;
}) {
  if (block.type === "text") {
    const trimmed = block.text.trim();
    if (!trimmed) return null;
    // 纯 JSON 检测:整体是 {}/[] 时用 pre 代码块渲染。
    if (
      (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
      (trimmed.endsWith("}") || trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return (
          <div className="my-2">
            <div className="mb-2 flex items-center gap-2 text-sm text-[var(--mx-muted)]">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              <span className="font-medium">{t("codexpane.jsonResponse")}</span>
            </div>
            <div className="overflow-hidden rounded-lg border border-[var(--mx-border)] bg-[var(--mx-surface-2)]">
              <pre className="mx-scroll-pretty overflow-x-auto p-4">
                <code className="block whitespace-pre font-mono text-[var(--mx-text)]">
                  {JSON.stringify(parsed, null, 2)}
                </code>
              </pre>
            </div>
          </div>
        );
      } catch {
        // 非 JSON,落到 markdown 渲染。
      }
    }
    return (
      <div dir="auto" className="leading-relaxed text-[var(--mx-text)]">
        <Suspense fallback={null}>
          <MdPreviewLazy content={block.text} inline />
        </Suspense>
      </div>
    );
  }
  if (block.type === "thinking") {
    // reasoning 手风琴折叠(默认折叠,展开看完整推理)。
    return (
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-xs text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)]">
          <svg
            className="h-3 w-3 flex-shrink-0 transition-transform duration-150 group-open:rotate-90"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="italic">{t("codexpane.thinking")}</span>
          {block.text && <span className="text-[var(--mx-faint)]">· {block.text.length} chars</span>}
        </summary>
        <div className="mt-1.5 pl-[18px]">
          <div className="whitespace-pre-wrap break-words text-xs italic leading-relaxed text-[var(--mx-muted)]">
            {block.text || "…"}
          </div>
        </div>
      </details>
    );
  }
  // tool_use
  return <ToolCard block={block} t={t} />;
}

/**
 * 合并 codex 消息流与 `!` 命令消息流,按发起顺序交错渲染。与 ClaudePane 同实现。
 */
function mergeCodexAndShellMessages(
  codexMsgs: CodexMessage[],
  shellMsgs: ShellMessage[],
): Array<{ kind: "codex"; msg: CodexMessage } | { kind: "shell"; msg: ShellMessage }> {
  if (shellMsgs.length === 0) {
    return codexMsgs.map((msg) => ({ kind: "codex" as const, msg }));
  }
  type Tagged = { ts: number; kind: "codex"; msg: CodexMessage } | { ts: number; kind: "shell"; msg: ShellMessage };
  const now = Date.now();
  const items: Tagged[] = codexMsgs.map((msg, i) => {
    let ts = now;
    if (msg.timestamp) {
      const parsed = Date.parse(msg.timestamp);
      if (!Number.isNaN(parsed)) ts = parsed;
    } else {
      ts = i;
    }
    return { ts, kind: "codex" as const, msg };
  });
  for (const msg of shellMsgs) {
    items.push({ ts: msg.timestamp, kind: "shell" as const, msg });
  }
  items.sort((a, b) => a.ts - b.ts);
  return items;
}

/**
 * `!` 命令执行消息行。与 ClaudePane 的 ShellRow 同实现(文案 key 共用 claudepane 的
 * shell* 条目,通用文案)。
 */
function ShellRow({
  message,
  t,
  onInterrupt,
}: {
  message: ShellMessage;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onInterrupt: () => void;
}) {
  const statusMeta = (() => {
    switch (message.status) {
      case "running":
        return { label: t("claudepane.shellRunning"), bg: "rgba(59,130,246,0.16)", fg: "#93c5fd" };
      case "done":
        return { label: t("claudepane.shellDone"), bg: "var(--mx-success-soft)", fg: "#86efac" };
      case "error":
        return {
          label:
            message.exitCode != null
              ? t("claudepane.shellError", { code: message.exitCode })
              : t("claudepane.shellError", { code: 1 }),
          bg: "var(--mx-danger-bg)",
          fg: "#fca5a5",
        };
      case "interrupted":
        return { label: t("claudepane.shellInterrupted"), bg: "var(--mx-border)", fg: "#cbd5e1" };
    }
  })();
  return (
    <div className="flex gap-2">
      <span
        aria-hidden
        className="flex h-[1.625em] shrink-0 items-center justify-center font-mono text-[var(--mx-success)]"
      >
        $
      </span>
      <div className="group min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code
            dir="auto"
            className="min-w-0 flex-1 truncate font-mono text-[var(--mx-text)]"
            title={message.command}
          >
            {message.command}
          </code>
          <span
            className="inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10px] font-medium leading-[1.4] tabular-nums"
            style={{ background: statusMeta.bg, color: statusMeta.fg }}
          >
            {statusMeta.label}
          </span>
          {message.status === "running" && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onInterrupt}
              className="shrink-0 rounded px-1.5 py-px text-[10px] text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-danger-bg)] hover:text-[var(--mx-danger-bright)]"
              title={t("codexpane.interrupt")}
            >
              ✕
            </button>
          )}
        </div>
        {message.output.length > 0 ? (
          <pre className="mx-scroll mt-0.5 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--mx-surface-2)] px-2 py-1 font-mono leading-relaxed">
            {message.output.map((line, i) => (
              <div key={i} className={line.stream === "stderr" ? "text-[var(--mx-danger-bright)]" : "text-[var(--mx-muted)]"}>
                {line.text}
              </div>
            ))}
          </pre>
        ) : message.status === "running" ? (
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--mx-faint)]">
            <ThinkingDots />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 工具调用卡片--配置驱动渲染(codexToolConfigs)。
 * variant: bash -> BashToolView(Codex 式命令行);default -> 通用可折叠卡片。
 * sandbox 拦截的操作显示 denied 药丸(无确认框,codex exec 非交互审批)。
 */
function ToolCard({
  block,
  t,
}: {
  block: Extract<CodexBlock, { type: "tool_use" }>;
  t: (k: string) => string;
}) {
  const config = getToolConfig(block.name);
  if (config.variant === "bash") {
    return <BashToolView block={block} config={config} t={t} />;
  }
  return <DefaultToolView block={block} config={config} t={t} />;
}

/** 状态药丸:小药丸 text-[10px] 四态。 */
function ToolStatusBadge({ status, t }: { status: ToolBadgeStatus; t: (k: string) => string }) {
  const map: Record<ToolBadgeStatus, { label: string; bg: string; fg: string }> = {
    running: { label: t("codexpane.toolRunning"), bg: "rgba(59,130,246,0.16)", fg: "#93c5fd" },
    completed: { label: t("codexpane.toolDone"), bg: "var(--mx-success-soft)", fg: "#86efac" },
    error: { label: t("codexpane.toolError"), bg: "var(--mx-danger-bg)", fg: "#fca5a5" },
    denied: { label: t("codexpane.sandboxDenied"), bg: "var(--mx-warning-soft)", fg: "#fdba74" },
  };
  const s = map[status];
  return (
    <span
      className="inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10px] font-medium leading-[1.4]"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}

/**
 * Bash 专用视图--Codex 式命令行(chevron + 绿 $ + 命令,展开看输出)。
 * 与 ClaudePane 的 BashToolView 同实现(codex 本就是这种风格)。
 */
function BashToolView({
  block,
  config,
  t,
}: {
  block: Extract<CodexBlock, { type: "tool_use" }>;
  config: ToolDisplayConfig;
  t: (k: string) => string;
}) {
  const command = config.getValue?.(block.input) ?? "";
  const output = block.result?.content ?? "";
  const hasOutput = output.trim().length > 0;
  const isError = block.result?.isError === true;
  const status = deriveToolStatus(block);
  const isRunning = status === "running";
  const lineCount = hasOutput ? output.replace(/\s+$/, "").split("\n").length : 0;
  const [open, setOpen] = useState(false);
  const autoApplied = useRef(false);
  useEffect(() => {
    if (!autoApplied.current && hasOutput && (config.defaultOpen ?? true)) {
      autoApplied.current = true;
      setOpen(true);
    }
  }, [hasOutput, config.defaultOpen]);
  const toggle = () => setOpen((p) => !p);
  return (
    <div
      className={`overflow-hidden rounded-lg border bg-[var(--mx-surface-soft)] backdrop-blur-sm transition-all ${
        isError ? "border-[var(--mx-danger-border)]" : "border-[var(--mx-border)]"
      } ${!open ? "hover:border-[var(--mx-border-strong)]" : ""}`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-[var(--mx-accent)]"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden
          className={`shrink-0 text-[var(--mx-faint)] transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span className="shrink-0 font-mono font-semibold text-[var(--mx-success)]">$</span>
        <code
          className={`min-w-0 flex-1 font-mono text-[var(--mx-text)] ${open ? "whitespace-pre-wrap break-all" : "truncate"}`}
        >
          {command || t("codexpane.toolRunning")}
        </code>
        {isRunning && (
          <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--mx-border-strong)] border-t-[var(--mx-success)]" />
        )}
        {!isRunning && <ToolStatusBadge status={status} t={t} />}
        {!open && hasOutput && !isRunning && (
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--mx-faint)]">{lineCount} ln</span>
        )}
      </div>
      {open && hasOutput && (
        <div className="border-t border-[var(--mx-hover-bg)] bg-[var(--mx-surface-2)]">
          <pre
            className={`mx-scroll-pretty max-h-72 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono leading-relaxed ${
              isError ? "text-[var(--mx-danger-bright)]" : "text-[var(--mx-muted)]"
            }`}
          >
            {output.replace(/\s+$/, "")}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * 通用工具视图(mcp_tool_call 等):chevron + 色条 + 工具名 + 参数摘要 + 状态药丸,
 * 展开看 input JSON + result。与 ClaudePane 的 DefaultToolView 同实现。
 */
function DefaultToolView({
  block,
  config,
  t,
}: {
  block: Extract<CodexBlock, { type: "tool_use" }>;
  config: ToolDisplayConfig;
  t: (k: string) => string;
}) {
  const cat = getToolCategory(block.name);
  const { border } = categoryColor(cat);
  const status = deriveToolStatus(block);
  const value = config.getValue?.(block.input) ?? block.inputBrief;
  const isError = block.result?.isError === true;
  const hasResult = !!block.result;
  const [open, setOpen] = useState(config.defaultOpen ?? false);
  const autoExpanded = useRef(false);
  useEffect(() => {
    if (!autoExpanded.current && hasResult && isError) {
      autoExpanded.current = true;
      setOpen(true);
    }
  }, [hasResult, isError]);

  return (
    <div className="my-1 py-0.5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((p) => !p)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((p) => !p);
          }
        }}
        className="flex w-full cursor-pointer select-none items-center gap-1.5 py-0.5 text-xs text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--mx-accent)]"
      >
        <svg
          className="h-3 w-3 flex-shrink-0 transition-transform duration-150"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span aria-hidden className="h-3 w-[2px] flex-shrink-0 rounded-full" style={{ background: border }} />
        <span className="flex-shrink-0 font-medium">{config.label ?? block.name}</span>
        {value && <span className="flex-shrink-0 text-[10px] text-[var(--mx-faint)]">/</span>}
        {value && (
          <span className="min-w-0 flex-1 truncate text-left font-mono text-[var(--mx-text)]" title={value}>
            {value}
          </span>
        )}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2">
          {status !== "completed" && <ToolStatusBadge status={status} t={t} />}
        </span>
      </div>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5 pl-[18px]">
          {block.input !== undefined && block.input !== null && (
            <pre className="mx-scroll-pretty max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--mx-border)] bg-[var(--mx-surface-2)] p-2 font-mono text-[10px] text-[var(--mx-muted)]">
              {formatInput(block.input)}
            </pre>
          )}
          {block.result && (
            <div className="group/result relative">
              <CopyButton
                text={block.result.content}
                t={t}
                className="absolute right-1 top-1 z-10 rounded bg-[var(--mx-surface-2)] px-1 py-0.5 opacity-0 transition-opacity group-hover/result:opacity-100"
              />
              <pre
                className={`mx-scroll-pretty max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded p-2 font-mono text-[10px] ${
                  isError
                    ? "border border-[var(--mx-danger-border)] bg-[var(--mx-danger-bg)] text-[var(--mx-danger-bright)]"
                    : "border border-[var(--mx-border)] bg-[var(--mx-surface-2)] text-[var(--mx-muted)]"
                }`}
              >
                {block.result.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** 时间戳格式化。 */
function formatTime(ts: string | null): string | null {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return null;
  }
}

/** 模型名缩短显示(取末段,超长截断),title 保留全名。 */
function shortModel(model?: string): string {
  if (!model) return "-";
  const last = model.split("/").pop() ?? model;
  return last.length > 22 ? last.slice(0, 22) + "…" : last;
}

/** 会话时长格式化(ms -> m:ss 或 h:mm:ss)。 */
function formatElapsed(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 思考状态动画(三个 violet 圆点错峰呼吸)。 */
function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--mx-violet)]"
          style={{ animationDelay: `${i * 0.18}s`, animationDuration: "1s" }}
        />
      ))}
    </span>
  );
}

/** token 数格式化:<1k 显原数、1k–1M 显 k、≥1M 显 m。 */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${parseFloat((n / 1000).toFixed(1))}k`;
  return `${parseFloat((n / 1_000_000).toFixed(1))}m`;
}

/** 复制图标(剪贴板)。 */
function IconCopy() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

/** 复制按钮:点击写剪贴板,1.2s 显「已复制」。 */
function CopyButton({ text, t, className = "" }: { text: string; t: (k: string) => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      className={`inline-flex items-center gap-1 rounded text-[var(--mx-faint)] transition-colors hover:text-[var(--mx-text)] ${className}`}
      title={t("codexpane.copy")}
    >
      {copied ? <span className="text-[var(--mx-success)]">{t("codexpane.copied")}</span> : <IconCopy />}
    </button>
  );
}

function IconSend() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function IconWarn() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function IconSlash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M7 8l-3 4 3 4" />
      <path d="M17 8l3 4-3 4" />
      <path d="M14 4l-4 16" />
    </svg>
  );
}

/**
 * slash 命令面板单条候选(选中项 scrollIntoView 跟随)。与 ClaudePane 的 CommandItem 同实现。
 */
function CommandItem({
  cmd,
  index,
  selected,
  onSelect,
  onHover,
}: {
  cmd: SlashCmd;
  index: number;
  selected: boolean;
  onSelect: (cmd: SlashCmd) => void;
  onHover: (index: number) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (selected && ref.current) {
      ref.current.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);
  return (
    <button
      ref={ref}
      type="button"
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={() => onHover(index)}
      onClick={() => onSelect(cmd)}
      className={`group relative mb-1 flex w-full cursor-pointer items-start gap-2 rounded border px-2.5 py-2 text-left transition-all ${
        selected
          ? "border-[var(--mx-selected-border)] bg-[var(--mx-selected-bg)]"
          : "border-transparent hover:border-[var(--mx-border)] hover:bg-[var(--mx-hover-bg)]"
      }`}
    >
      {selected && (
        <span className="absolute bottom-1.5 left-1.5 top-1.5 w-0.5 rounded-full bg-[var(--mx-accent)]" />
      )}
      <span
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
          selected
            ? "border-[var(--mx-selected-border)] bg-[var(--mx-selected-bg)] text-[var(--mx-accent)]"
            : "border-[var(--mx-border)] bg-[var(--mx-border-soft)] text-[var(--mx-muted)]"
        }`}
      >
        <IconSlash />
      </span>
      <div className="min-w-0 flex-1 pr-1">
        <span className="block min-w-0 truncate font-mono text-[13px] font-semibold text-[var(--mx-text)]">
          /{cmd.name}
        </span>
        {cmd.description && (
          <span className="block truncate text-[12px] leading-4 text-[var(--mx-faint)]">
            {cmd.description}
          </span>
        )}
      </div>
      {selected && (
        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-[var(--mx-selected-border)] bg-[var(--mx-accent-soft)] text-[var(--mx-accent)]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
            <path d="M9 10l-5 3 5 3" />
            <path d="M4 13h13a4 4 0 0 1 0 8h-1" />
          </svg>
        </span>
      )}
    </button>
  );
}
