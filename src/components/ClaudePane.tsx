import { Fragment, lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { selectEnclosingPre } from "../lib/selectEnclosingPre";
import { useCurrentPromptStick } from "../lib/useCurrentPromptStick";
import { useMessageWindow } from "../lib/useMessageWindow";
import { formatCost, formatTokens, formatTokensPerSecond } from "../lib/turnMetrics";
import { deriveAlwaysAllowLabel } from "../lib/permissionSuggest";
import { toolStepDetail, toolStepObject, toolStepTitle, toolStepVerbKey } from "../lib/toolStep";
import { StepBody, StepCard, StepRow } from "./StepRow";
import { InteractivePanel } from "./InteractivePanel";
import { StepFoldRow, WorkFoldRow } from "./StepFoldRow";
import { CurrentPromptBanner } from "./chat/CurrentPromptBanner";
import { computeFolds, type RowFold, type StepFold } from "../domain/stepFolds";
import { classifyCommand } from "../lib/commandClassifier";
import type { SettingsTab } from "./SettingsModal";
import { Dialog, DialogContent, DialogTitle } from "./ui/Dialog";
import { BottomToast } from "./ui/BottomToast";
import { ContextMeter } from "./ui/ContextMeter";
import { useTranslation } from "react-i18next";
import type { ShellKind, SplitDirection } from "../domain/paneTree";
import type { WorkspaceSession } from "../domain/sessions";
import type { ClaudeTransport } from "../domain/claudeTransport";
import type { ShellRunTransport } from "../domain/shellRunTransport";
import { SHELL_MAX_OUTPUT_LINES, type ShellMessage, type ShellRunState } from "../domain/shellRun";
import type { BackgroundTaskInfo, ClaudeBlock, ClaudeMessage, ClaudeSessionKind, ClaudeStreamState, ClaudeUsage, CompactMeta, PendingPermission } from "../domain/claudeStream";
import { claudeInputTokens, computeContextInfo, hasPendingApproval as hasPendingApprovalFn, hasPendingPlan as hasPendingPlanFn, hasUsage, inferContextWindow, summarize } from "../domain/claudeStream";
import {
  PROVIDER_CHANGED_EVENT,
  applyProvider,
  configuredModelsOf,
  loadClaudeProviders,
  notifyProviderChanged,
  pickActiveProviderId,
  readCurrentEnv,
  type ClaudeProvider,
} from "../domain/claudeProviders";
import { filterSlashCommands, parseSlashInput, type SlashCommandDef } from "../domain/slashCommands";
import {
  getToolConfig,
  deriveToolStatus,
  isPermissionDenied,
  type ToolDisplayConfig,
  type ToolBadgeStatus,
} from "../domain/claudeToolConfigs";
import { diffLines, type DiffLine } from "../domain/diff";
import { fetchAiCliSessions, mostRecentSessionInCwd, type AiCliSessionListItem } from "../domain/aiCliSessions";
import { useSettings } from "../settings/SettingsProvider";
import { statusFontSize } from "../settings";
import { TabCloseIcon, SessionIcon, SpeakAiIcon } from "./icons";
import { ShellMenu } from "./ShellMenu";
import { SplitPaneButtons } from "./SplitPaneButtons";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./ui/Popover";
import { Button } from "./ui/Button";
import { CopyButton } from "./ui/CopyButton";
import { PaneExpandButton } from "./ui/PaneExpandButton";
import { PaneToolsMenu, TOOL_SIDEBAR_MIN_PANE_W, type PaneToolsMenuGroup } from "./ui/PaneToolsMenu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import { SessionHeader } from "./chat/SessionHeader";
import { ChatUserBubble } from "./chat/ChatUserBubble";
import { MESSAGE_GAP_MS, TimeGapDivider, messageTimeMs } from "./chat/TimeGapDivider";
import { Tabs, TabsList, TabsTrigger } from "./ui/Tabs";


/** MdPreview 懒加载(避免 claudepane 首屏就拉 marked/dompurify,与探针共用 md-render 分包)。 */
const MdPreviewLazy = lazy(() =>
  import("./MdPreview").then((m) => ({ default: m.MdPreview })),
);

/**
 * 相对时间格式化(↻ 弹窗「恢复上一次」用)。与 SessionBrowserPane.relativeTime 同语义,
 * 此处内联简版(避免跨文件耦合);按当前 i18n locale 取 Intl,zh→zh、en→en,无 Intl 兜底空串。
 */
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
 * claude 权限模式(--permission-mode),状态栏可切换 + Shift+Tab 循环。
 * id 传后端;label 状态栏显示;desc 菜单说明。
 * id 必须是 claude CLI --permission-mode 的合法 choices(本机 2.1.23x 实测:
 * acceptEdits/auto/bypassPermissions/manual/dontAsk/plan)——旧档 "default" 已被
 * CLI 移除(改名 manual),传非法值 claude 进程启动即退(commander invalid choice),
 * 状态栏显示与实际权限对不上(UI 徽标来自期望值,进程根本没起来)。
 * label 一并显示 CLI 原值(不用自创短标签 auto/yolo——与 codex 侧 sandbox 的 auto/yolo
 * 混淆,且不是 CLI 里的真实名字);auto/dontAsk 两值未暴露(语义与 acceptEdits/manual 重叠)。
 */
const PERMISSION_MODES = [
  { id: "acceptEdits", label: "acceptEdits", desc: "自动接受文件编辑" },
  { id: "plan", label: "plan", desc: "计划模式(只读,先提方案)" },
  { id: "manual", label: "manual", desc: "每次操作都确认" },
  { id: "bypassPermissions", label: "bypassPermissions", desc: "跳过所有权限(谨慎)" },
] as const;

/**
 * effort 档位(claude --effort,reasoning 强度)。auto=不传 flag(claude 内置默认);其余 5 档。
 * per tab 跟 transport 走:setEffort 下轮生效(不打断当前轮),乐观回填 meta.effort 供 UI 即时反映。
 * 原在全局 StatusBar,移至输入框底部状态栏(与 model/perm 并列)--更贴近会话上下文,且每个 claude tab
 * 独立切换,不依赖「聚焦 pane」语义。
 */
const EFFORT_LEVELS: { value: string; label: string }[] = [
  { value: "auto", label: "auto" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

type ClaudePaneProps = {
  paneId: string;
  sessions: WorkspaceSession[];
  activeTabId: string;
  /** 取该 pane 内某 tab 的 ClaudeTransport(池化,tab 生命周期内稳定)。 */
  getClaudeTransport: (tabId: string) => ClaudeTransport;
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
  /** ◱ 展开/还原所在分屏比例(主体 pane 占大头,方便操控)。无分屏(单 pane)时 AppShell no-op。 */
  onToggleExpand?: () => void;
  /** 当前是否处于 ◱ 展开态(AppShell 展开记忆派生;按钮图标/文案随它切换)。 */
  expanded?: boolean;
  className?: string;
};

/**
 * 订阅某 claude tab 的 transport,派生对外汇总语义态(供 tab chip 状态点)。含 shellRunning
 * (同 tab 的 `!` 命令在跑算 running);非活动 tab 无 shellState 跟踪,传 false(shell 罕见并发)。
 * 复用 `summarize` 纯函数(与 StatusBar/registry 同源,tab chip 额外融合 shell + resolvedApprovals)。
 */
function useTabSummary(
  transport: ClaudeTransport | undefined,
  shellRunning: boolean,
  resolvedApprovals: Set<string>,
): ClaudeSessionKind | null {
  const [kind, setKind] = useState<ClaudeSessionKind | null>(null);
  useEffect(() => {
    if (!transport) {
      setKind(null);
      return;
    }
    const unsub = transport.onEvents((state) => {
      setKind(summarize(state, shellRunning, resolvedApprovals).kind);
    });
    return unsub;
  }, [transport, shellRunning, resolvedApprovals]);
  return kind;
}

/** tab chip 旁的状态点。颜色:running cyan(呼吸)/bg 琥珀(呼吸)/retrying 橙/waiting 紫/error 红/idle 灰。 */
function TabStatusDot({ kind }: { kind: ClaudeSessionKind | null }) {
  if (!kind) return null;
  const color =
    kind === "error"
      ? "#f87171"
      : kind === "retrying"
        ? "#fb923c"
        : kind === "waiting"
          ? "#a78bfa"
          : kind === "running"
            ? "#22d3ee"
            : kind === "bg"
              ? "#fbbf24"
              : "#475569";
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${kind === "running" || kind === "bg" ? "animate-pulse" : ""}`}
      style={{ background: color }}
    />
  );
}

/**
 * 任务列表面板内容——「后台任务 ×N」状态行(非 busy)与 busy 行琥珀徽标共用,Popover 挂输入框上方。
 * 三节:
 * - 主任务:claude 主对话轮当前状态(执行中/思考中/等待确认/空闲),色与 tab dot 语义一致;
 * - 后台任务:`background_tasks_changed` 快照(运行中,琥珀呼吸点 + description + taskType 徽标);
 * - 最近完成:messages 里 notice 消息末尾若干条(绿勾/红叉 + claude 原 summary)。
 */
function TaskListContent({
  t,
  main,
  bgTasks,
  doneNotices,
  onKillTask,
  pendingKillIds,
}: {
  t: (k: string, opts?: Record<string, unknown>) => string;
  main: { label: string; color: string; pulse: boolean };
  bgTasks: BackgroundTaskInfo[];
  doneNotices: { kind: "bg_done" | "bg_failed" | "bg_stopped"; summary: string }[];
  /** 停止单个后台任务(借道模型层 TaskStop,见 ClaudePane handleKillBgTask)。 */
  onKillTask: (taskId: string, description: string) => void;
  /** 已排队待停止的任务 id(busy 期间点停止,回 idle 后合并发送)。这些项按钮替换为「待停止」。 */
  pendingKillIds: Set<string>;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {/* 主任务(主对话轮) */}
      <div className="flex items-center gap-2 rounded px-2 py-1.5 text-[11px]">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${main.pulse ? "animate-pulse" : ""}`} style={{ background: main.color }} />
        <span className="shrink-0 font-[600] text-[var(--mx-text)]">{t("claudepane.mainTask")}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 flex-1 cursor-default truncate text-[var(--mx-muted)]">{main.label}</span>
          </TooltipTrigger>
          <TooltipContent>{main.label}</TooltipContent>
        </Tooltip>
      </div>
      <div className="mx-1 border-t border-[var(--mx-border)]" />
      {/* 后台任务(运行中) */}
      <div className="px-2 pb-0.5 pt-1 text-[10px] font-[600] text-[var(--mx-faint)]">
        {t("claudepane.bgTaskRunningSection", { n: bgTasks.length })}
      </div>
      {bgTasks.length === 0 ? (
        <div className="px-2 py-1 text-[10px] text-[var(--mx-faint)]">{t("claudepane.bgTaskNone")}</div>
      ) : (
        bgTasks.map((task) => (
          <div key={task.taskId} className="group/task flex items-center gap-2 rounded px-2 py-1 text-[11px]">
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#fbbf24]" />
            {/* 原生 title 在 Windows 是单行超宽气泡,长 description 撑出屏幕——换 Radix Tooltip(限宽换行)。 */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 flex-1 cursor-default truncate text-[var(--mx-text)]">{task.description || task.taskType}</span>
              </TooltipTrigger>
              <TooltipContent>{task.description || task.taskType}</TooltipContent>
            </Tooltip>
            <span className="shrink-0 rounded bg-[var(--mx-border)] px-1 py-px font-mono text-[9px] text-[var(--mx-muted)]">{task.taskType}</span>
            {pendingKillIds.has(task.taskId) ? (
              /* busy 期间点停止已入队:等主轮回 idle 自动合并发送(不能 interrupt——会杀进程树连坐全部后台任务)。 */
              <span className="shrink-0 text-[9px] text-[var(--mx-faint)]">{t("claudepane.killTaskQueuedShort")}</span>
            ) : (
              /* 停止单个后台任务:借道模型层 TaskStop(官方工具;stdin 控制协议无单任务 kill)。
                 走一轮对话(~数秒),claude 杀掉任务后 background_tasks_changed 快照自动回流。 */
              <button
                type="button"
                title={t("claudepane.killTaskTitle")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onKillTask(task.taskId, task.description);
                }}
                className="shrink-0 rounded p-0.5 text-[var(--mx-faint)] opacity-0 transition-opacity hover:bg-[var(--mx-danger-bg)] hover:text-[var(--mx-danger-bright)] group-hover/task:opacity-100"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            )}
          </div>
        ))
      )}
      {/* 最近完成(notice 消息摘录) */}
      {doneNotices.length > 0 && (
        <>
          <div className="mx-1 mt-1 border-t border-[var(--mx-border)]" />
          <div className="px-2 pb-0.5 pt-1 text-[10px] font-[600] text-[var(--mx-faint)]">{t("claudepane.bgTaskDoneSection")}</div>
          {doneNotices.map((n, i) => {
            const done = n.kind === "bg_done";
            const stopped = n.kind === "bg_stopped";
            return (
              <div key={i} className="flex items-start gap-2 rounded px-2 py-1 text-[10px] leading-relaxed">
                {stopped ? (
                  <svg className="mt-[4px] h-2.5 w-2.5 shrink-0" viewBox="0 0 24 24" fill="var(--mx-warning-bright)" aria-hidden>
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
                  <svg
                    className="mt-[3px] h-3 w-3 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={done ? "var(--mx-success-bright)" : "var(--mx-danger-bright)"}
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    {done ? <path d="M20 6L9 17l-5-5" /> : <path d="M18 6L6 18M6 6l12 12" />}
                  </svg>
                )}
                <span className="min-w-0 flex-1 break-words text-[var(--mx-faint)]">
                  {stopped ? `${t("claudepane.bgTaskStoppedLabel")} ${n.summary}` : n.summary}
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/**
 * claudepane tab chip(glyph + 名称 + 状态点 + 关闭×)。订阅该 tab 的 transport 派生状态点
 * (useTabSummary 是 hook,故抽成独立组件,不能在 .map 循环里直接调)。
 */
const ClaudeTabChip = memo(function ClaudeTabChip({
  session,
  isActive,
  showClose,
  paneId,
  getClaudeTransport,
  shellRunning,
  resolvedApprovals,
  onCloseTab,
}: {
  session: WorkspaceSession;
  isActive: boolean;
  showClose: boolean;
  paneId: string;
  getClaudeTransport: (tabId: string) => ClaudeTransport;
  shellRunning: boolean;
  resolvedApprovals: Set<string>;
  onCloseTab?: (paneId: string, tabId: string) => void;
}) {
  const { t } = useTranslation();
  // 仅 claudepane tab 订阅状态点(其余 shellKind tab 无 claude transport,传 undefined -> 点不显)。
  // getClaudeTransport 是 AppShell 池化函数,同 tabId 返回同一实例,跨 render 稳定。
  const transport = session.kind === "claudepane" ? getClaudeTransport(session.id) : undefined;
  const kind = useTabSummary(transport, shellRunning, resolvedApprovals);
  return (
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
                <TabCloseIcon className="h-2 w-2" />
              </Button>
            )}
          </div>
        </TabsTrigger>
  );
});

/**
 * ↻ 弹窗顶部「恢复上一次」快捷行:展示当前项目最近一条 claude 历史会话(title + 相对时间),
 * 点击直接 resume。loading 显示加载中;空列表显示「暂无历史会话」(均不可点)。
 */
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
          <SessionIcon className="h-3.5 w-3.5 text-[var(--mx-accent)]" />
          <span className="min-w-0 flex-1 truncate text-[length:var(--mx-ui-fs-sm)] text-[var(--mx-text)]">{title}</span>
          <span className="shrink-0 text-[10px] text-[var(--mx-faint)]">{relativeTime(item.lastAt, locale)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{t("session.resumeLast")}</TooltipContent>
    </Tooltip>
  );
}


/**
 * claude 自渲染对话面板(stream-json wrapper),Cursor 式行内流 UI。
 *
 * 不走 PTY/不渲染 claude TUI,而是消费后端 `claude-event` 事件流,用 React 自渲染对话流
 * + 行内可折叠工具卡片 + 底部圆角浮动输入区(⋯ 工具菜单 / 发送 / 中断)。输入走原生
 * textarea → IME 候选框天然跟随(根治 xterm + TUI 下中文输入法候选框错位)。
 *
 * 数据流:`getClaudeTransport(tabId)` 取池化的 ClaudeTransport → `onEvents(setState)` 订阅
 * 归并后的 `ClaudeStreamState` → 渲染 messages。输入框回车 → `transport.send(prompt)`
 * (后端 spawn_claude 起短命子进程,事件回推)。中断按钮 → `transport.interrupt()`。
 *
 * transport 池化在 AppShell(`claudeTransportsRef`),跨 ClaudePane unmount 存活 → 切 tab 不丢消息
 * (onEvents 回放当前 state)。详见 plan: ClaudePane。
 */
export function ClaudePane(props: ClaudePaneProps) {
  const {
    paneId,
    sessions,
    activeTabId,
    getClaudeTransport,
    getShellRunTransport,
    focused,
    onFocusPane,
    onSplitPane,
    onClosePane,
    onAddTab,
    onResumeSession,
    onCloseTab,
    onSetActiveTab,
    onToggleExpand,
    expanded,
    className,
  } = props;
  const { t, i18n } = useTranslation();
  const { fontSize, showPromptBanner } = useSettings();
  /** 输入框底部状态栏字号:随全局 fontSize 缩放(14→10,与原 text-[10px] 一致)。 */
  const statusFontPx = statusFontSize(fontSize);
  const [state, setState] = useState<ClaudeStreamState | null>(null);
  /** state 的 ref 镜像:供回调读「最新 state」而不进 useCallback deps(state 每 token 变会让回调每 token 变、击穿 memo)。每次渲染同步更新。 */
  const stateRef = useRef(state);
  stateRef.current = state;
  /** `!` 命令内联执行的输出流(独立于 claude 流,不进 ClaudeStreamState)。 */
  const [shellState, setShellState] = useState<ShellRunState | null>(null);
  const [input, setInput] = useState("");
  // ↑/↓ 输入历史浏览(类 shell 命令历史):history=已发送记录(去重置末、限 100 条),
  // historyIndex=-1 表示「未浏览,在最新草稿」,>=0 表示当前浏览到的下标。
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  /** 进入历史浏览前输入框的草稿,按 ↓ 回到最新时恢复。 */
  const draftRef = useRef("");
  // 输入历史持久化:按当前项目 cwd 隔离(localStorage),跟随项目,重启后保留。用活动 session 的
  // cwd(项目根,稳定)作 key--切 tab 同项目不变(共享 history),跨项目不同(各自独立)。ref 镜像供
  // handleSend 回调读最新值(避免进 deps 击穿 memo)。
  const historyKey = sessions.find((s) => s.id === activeTabId)?.cwd;
  const historyStorageKey = historyKey ? `claude-history:${historyKey}` : null;
  const historyStorageKeyRef = useRef(historyStorageKey);
  historyStorageKeyRef.current = historyStorageKey;
  // 挂载 / 切到不同项目(cwd 变)时,从 localStorage 加载该项目的输入历史(跟随当前项目)。
  useEffect(() => {
    if (!historyStorageKey) return;
    try {
      const raw = localStorage.getItem(historyStorageKey);
      const arr = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(arr)) {
        setHistory(arr.filter((x) => typeof x === "string").slice(-100));
      } else {
        setHistory([]); // 该项目尚无历史 / 切到新项目:清空当前,避免串项目。
      }
    } catch {
      /* localStorage 不可用(隐私模式等),降级为仅内存 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyStorageKey]);
  const [menuMode, setMenuMode] = useState<"tab" | "perm" | "model" | "effort" | "tasks" | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeInput, setResumeInput] = useState("");
  /** ↻ 弹窗「恢复上一次」:当前项目(活动 tab cwd)最近一条 claude 历史会话。弹窗打开时懒拉。 */
  const [lastSession, setLastSession] = useState<AiCliSessionListItem | null>(null);
  const [lastLoading, setLastLoading] = useState(false);
  const resumeRootPath = sessions.find((s) => s.id === activeTabId)?.cwd ?? "";
  useEffect(() => {
    // 弹窗打开且有项目根才拉;fetchAiCliSessions 非 Tauri / 失败兜底返回 [](见 aiCliSessions.ts)。
    // 取最近一条用 mostRecentSessionInCwd 按 cwd 过滤--只显示同工作空间的会话(跨项目不混)。
    if (!resumeOpen || !resumeRootPath) return;
    let alive = true;
    setLastLoading(true);
    void fetchAiCliSessions(resumeRootPath, "claude").then((list) => {
      if (!alive) return;
      setLastSession(mostRecentSessionInCwd(list, resumeRootPath));
      setLastLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [resumeOpen, resumeRootPath]);
  const [claudeMissing, setClaudeMissing] = useState(false);
  const [probeDone, setProbeDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 消息内容容器(条件渲染):ResizeObserver 观察其高度变化,兜底异步撑高(markdown/高亮)后补滚。 */
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** 是否「贴底」(用户未上滚)。流式/新消息/内容撑高时若贴底则自动滚到底;用户上滚后不抢回,直到再滚回底部。 */
  const stickRef = useRef(true);
  /** 上滚(非贴底)时显示右下角「回到底部」按钮。与 stickRef 镜像(用于渲染显隐)。 */
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  /** 上次 scrollTop:判定滚动方向(向上 = 用户看历史)。程序自动滚动只向最大值设,不会触发「向上」。 */
  const lastScrollTopRef = useRef(0);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) {
      // 滚到底(用户滚回底部 / 程序刚滚到底)-> 恢复贴底。
      stickRef.current = true;
      setShowScrollBottom(false);
    } else if (el.scrollTop < lastScrollTopRef.current - 2) {
      // 向上滚且非底 -> 用户主动看历史,取消贴底(覆盖滚轮/PageUp/拖滚动条;程序设
      // scrollTop=scrollHeight 只向最大值,不触发此分支,故内容增长/自动滚动不会误锁死贴底)。
      stickRef.current = false;
      setShowScrollBottom(true);
    }
    lastScrollTopRef.current = el.scrollTop;
  }, []);
  /** 「回到底部」按钮点击:滚到底 + 恢复贴底(后续流式自动贴底)。 */
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setShowScrollBottom(false);
  }, []);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // —— @ 文件引用面板(@ token → list_files → fuzzy → 选中插入 @path)——
  const [atOpen, setAtOpen] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [atQuery, setAtQuery] = useState("");
  const [atFiles, setAtFiles] = useState<{ path: string; name: string }[]>([]);
  const atPositionRef = useRef(-1);
  /** 已加载文件列表的 cwd(避免重复 list_files;cwd 变化时重载)。 */
  const atLoadedCwdRef = useRef<string | null>(null);
  // —— / 命令面板(注册表驱动,#131;与 @ 文件引用面板同交互范式)——
  /** 面板开合:输入恰为 "/xxx"(无空格,未进参数输入)时开;Esc 手动关。 */
  const [cmdOpen, setCmdOpen] = useState(false);
  /** 键盘/鼠标选中项索引(cmdMatches 变化时归零)。 */
  const [cmdIndex, setCmdIndex] = useState(0);
  // 工具栏菜单弹窗状态(原 /config /help /cost /mcp 等 slash 触发,现由 ⋯ 菜单打开)。
  const [helpOpen, setHelpOpen] = useState(false);
  /** /mcp 弹窗:~/.claude.json 解析的 MCP 服务器(全局 + 本项目;null=加载中)。 */
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpEntries, setMcpEntries] = useState<
    { scope: "global" | "project"; name: string; brief: string }[] | null
  >(null);
  /** Skills 弹窗:全局 ~/.claude/skills + 项目 <cwd>/.claude/skills 下的子目录名(null=加载中)。 */
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillEntries, setSkillEntries] = useState<{ scope: "global" | "project"; name: string; path: string }[] | null>(null);
  /** Plugins 弹窗:~/.claude/plugins/installed_plugins.json 宽松解析(按来源分组;null=加载中)。 */
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [pluginGroups, setPluginGroups] = useState<{ source: string; names: string[] }[] | null>(null);
  const [costOpen, setCostOpen] = useState(false);
  // —— 宽度自适应工具侧栏:pane 足够宽时右侧常驻 Skills/MCP/Plugins(与弹窗同源数据),
  //    窄 pane 侧栏隐藏回落弹窗模式;⋯ 菜单点击在宽 pane 下也切到侧栏 ——
  /** 侧栏当前面板(null=未开)。宽 pane 首次自动开 skills(默认)。 */
  const [toolPanel, setToolPanel] = useState<"skills" | "mcp" | "plugins" | null>(null);
  /** 缩小态:侧栏收成悬浮在右侧边缘的小竖条(点击展开),非关闭——保留恢复入口。 */
  const [toolCollapsed, setToolCollapsed] = useState(false);
  /** pane 内容区宽度 ≥ 阈值(对话区仍留 ~700px 可读 + 侧栏 248px)。 */
  const [paneWide, setPaneWide] = useState(false);
  const paneBoxRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = paneBoxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const wide = el.clientWidth >= TOOL_SIDEBAR_MIN_PANE_W;
      setPaneWide((prev) => (prev === wide ? prev : wide));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** API 重试用尽 toast:重试序列从有(retry≠null)变无(null)且最终 status=error 时弹一次。
   *  边沿检测(不常驻):避免 error 期间一直浮着;一次提示即 self-clear。 */
  const [retryFailedMsg, setRetryFailedMsg] = useState<string | null>(null);
  const prevRetryRef = useRef<{ attempt: number; maxAttempts: number } | null>(null);
  useEffect(() => {
    const cur = state?.retry ?? null;
    const prev = prevRetryRef.current;
    // 重试序列结束:之前在重试(prev≠null)、现在不在(cur=null)、且最终 status=error(5 次用尽/不可重试终止)。
    if (prev && !cur && state?.status === "error") {
      const err = state.lastResult?.error?.trim();
      setRetryFailedMsg(
        t("claudepane.retryFailed", {
          max: prev.maxAttempts,
          error: err ? `:${err}` : "",
        }),
      );
    }
    prevRetryRef.current = cur;
  }, [state?.retry, state?.status, state?.lastResult?.error, t]);

  // 重试失败 toast 5s 后自动消失(一次性提示,不常驻)。
  useEffect(() => {
    if (!retryFailedMsg) return;
    const id = setTimeout(() => setRetryFailedMsg(null), 5000);
    return () => clearTimeout(id);
  }, [retryFailedMsg]);

  // compact 失败 toast:transport state 的 compactError 常驻(直至下次 compact 覆盖),
  // UI 层 dismissed 镜像——compactError 变化(新错误)时重置重新弹,8s 自动消失 + ✕ 手动关。
  const compactError = state?.compactError ?? null;
  const [compactErrorDismissed, setCompactErrorDismissed] = useState(false);
  useEffect(() => {
    setCompactErrorDismissed(false);
  }, [compactError]);
  useEffect(() => {
    if (!compactError || compactErrorDismissed) return;
    const id = window.setTimeout(() => setCompactErrorDismissed(true), 8000);
    return () => window.clearTimeout(id);
  }, [compactError, compactErrorDismissed]);
  const [rewindOpen, setRewindOpen] = useState(false);
  // 回溯执行中(禁弹窗按钮防重复点击)+ 失败提示(fork/定位失败不动现有会话)。
  const [rewindBusy, setRewindBusy] = useState(false);
  const [rewindError, setRewindError] = useState<string | null>(null);
  /** 模型选择器列表:每次打开并行拉两路——env 里已配置的别名(`list_claude_models`)+
   *  供应商端点真实目录(`list_claude_catalog_models`),后者去重追加,故供应商支持的模型全在。 */
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  /** 模型选择器的本地过滤词(目录常有上百条,列出时按子串过滤,输中文也能搜)。 */
  const [modelQuery, setModelQuery] = useState("");
  /** 供应商分组下拉(2026-10-29 用户两轮定调:不要常驻标签条,「下拉里放我配置的
   *  供应商,供应商作为一级目录,点供应商下的模型即整体切换」):
   *  - providers:设置中心同一份(localStorage);currentEnv:判定当前生效家(三键匹配)。
   *  - 组内只列**已配置**的模型(configuredModelsOf);端点全目录不进下拉(2026-10-30
   *    用户定调:高级配置本来就要单独配,消息框只给配好的),也不做打开即 probe。
   *  无供应商配置时下拉回退 env+catalog 平铺(现状)。 */
  const [providers, setProviders] = useState<ClaudeProvider[]>([]);
  const [currentEnv, setCurrentEnv] = useState<Record<string, string> | null>(null);
  const refreshProviders = useCallback(() => {
    setProviders(loadClaudeProviders());
    void readCurrentEnv().then((env) => setCurrentEnv(env));
  }, []);
  useEffect(() => {
    refreshProviders();
    // 别处(设置中心/其他 pane)切了供应商,这里同步当前生效态。
    const onProviderChanged = () => void readCurrentEnv().then((env) => setCurrentEnv(env));
    window.addEventListener(PROVIDER_CHANGED_EVENT, onProviderChanged);
    return () => window.removeEventListener(PROVIDER_CHANGED_EVENT, onProviderChanged);
  }, [activeTabId, refreshProviders]);
  /** 点供应商下的模型:整体切换(端点+token+该模型写 env 的 *_MODEL)→ 广播 →
   *  AppShell 对活跃会话 kill+--resume 拾取(busy 静默跳过,下轮拾取)。 */
  const switchProviderModel = useCallback(
    async (p: ClaudeProvider, m: string) => {
      const ok = await applyProvider({ ...p, model: m });
      if (ok) {
        notifyProviderChanged();
        // 写完立刻回读 env:下拉顶部「当前」与生效家标记不等会话重启的 init 回填
        // (busy 会话会跳过 kill,meta.model 可能长时间还是旧值)。
        void readCurrentEnv().then((env) => setCurrentEnv(env));
        setMenuMode(null);
      }
    },
    [],
  );
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return availableModels;
    return availableModels.filter((m) => m.toLowerCase().includes(q));
  }, [availableModels, modelQuery]);
  /** 分组下拉的可见组(2026-10-29 用户反馈两修;2026-10-30 再收敛):
   *  ① 组内**只列已配置**的模型(configuredModelsOf:默认模型 + extraEnv 的 *_MODEL)——
   *     端点全目录/「全部模型」折叠项已按用户要求撤掉,要配别的模型去设置中心;
   *  ② 生效判定收敛**单一真源**:生效家由 pickActiveProviderId 打分选出唯一一条(同端点
   *     同密钥的兜底条目不会两家都亮),组内勾选只看 env 的 ANTHROPIC_MODEL(切完供应商
   *     +模型后 meta.model 还是旧值,原来 alias/model 双来源各命中一个 → 两个都打勾)。 */
  // 同端点同密钥多条配置的打分去重(与设置中心徽标同一条规则,见 pickActiveProviderId)。
  const activeProviderId = useMemo(() => pickActiveProviderId(providers, currentEnv), [providers, currentEnv]);
  const providerGroups = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    // 生效家里把 env 的当前模型补进「已配置」头位:切换只写 settings.json,不回写
    // localStorage 的 p.model,不补的话刚选中的勾选行会消失。
    const envModel = (currentEnv?.ANTHROPIC_MODEL ?? "").trim();
    return providers.map((p) => {
      const base = configuredModelsOf(p);
      const configured = p.id === activeProviderId && envModel && !base.includes(envModel) ? [envModel, ...base] : base;
      const nameHit = !q || p.name.toLowerCase().includes(q);
      const shown = nameHit ? configured : configured.filter((m) => m.toLowerCase().includes(q));
      return {
        p,
        active: p.id === activeProviderId,
        configured: shown,
        // 没配模型的家:不搜索时保留组头 + 提示行(可发现);搜索无命中整组隐藏。
        visible: shown.length > 0 || (!q && configured.length === 0),
      };
    }).filter((g) => g.visible);
  }, [providers, activeProviderId, currentEnv, modelQuery]);
  // /compact 走真 compact:transport.send("/compact") 写 stdin(local command),后端长进程执行,
  // 产出 compact_status/compact_boundary 事件 → applyEvent 归并成 boundary/summary 消息(见 MessageRow
  // compact 分支)。compaction 进行中由 state.compactRunning(busy)驱动,无需前端模拟编排。

  // getClaudeTransport 是父闭包每次渲染新建,用 ref 避免 effect 依赖重建。
  const getClaudeTransportRef = useRef(getClaudeTransport);
  getClaudeTransportRef.current = getClaudeTransport;
  // 同理 getShellRunTransport。
  const getShellRunTransportRef = useRef(getShellRunTransport);
  getShellRunTransportRef.current = getShellRunTransport;
  // 父闭包(getClaudeTransport/onCloseTab)每次渲染新建,直接传给 ClaudeTabChip 会让其 memo 失效 ->
  // 输入/流式时所有 tab chip 重绘。用 ref 包一层稳定引用,tab chip memo 生效,header 不随 input 重绘。
  const onCloseTabRef = useRef(onCloseTab);
  onCloseTabRef.current = onCloseTab;
  const getClaudeTransportStable = useCallback(
    (tabId: string) => getClaudeTransportRef.current(tabId),
    [],
  );
  const onCloseTabStable = useCallback(
    (paneId: string, tabId: string) => onCloseTabRef.current?.(paneId, tabId),
    [],
  );

  // 挂载时探测 claude CLI 是否安装(非 Tauri 环境静默放行,不挡 dev 浏览器兜底)。
  useEffect(() => {
    let alive = true;
    invoke<Record<string, boolean>>("check_commands_installed", { commands: ["claude"] })
      .then((result) => {
        if (!alive) return;
        setClaudeMissing(!result["claude"]);
        setProbeDone(true);
      })
      .catch(() => {
        if (!alive) return;
        // 非 Tauri 环境:放行,不挡 dev 兜底。
        setProbeDone(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 订阅活动 tab 的 transport:切 tab 时换 transport + 重新订阅。
  // state 初始 null(未订阅),onEvents 立即回放当前 state → setState 非 null。
  useEffect(() => {
    if (!activeTabId) return;
    const transport = getClaudeTransportRef.current(activeTabId);
    const off = transport.onEvents((s) => setState(s));
    // 焦点 pane 时抢焦点到输入框。
    if (focused) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, focused]);

  // 首次聚焦本 pane 才启动 claude 进程(拿 init 回填 model/cwd/slashCommands,状态栏打开即显示 model)。
  // 默认 pane tree 每项目自带 Claude pane 后,「挂载即启动」会让并排的所有项目冷启动无差别各拉
  // 一个 claude 长进程(启动延迟/常驻内存随项目数线性涨)——改为聚焦触发:只有用户正在操作的
  // pane 有 AI 进程。start() 幂等(进程已在跑直接 return),失焦不 stop、切回不重复 spawn;
  // 失败统一 handleEvent(terminated)(如 claude 未装,由 claudeMissing UI 覆盖显示)。probeDone 后才启动,
  // 避免探测未完成时 claudeMissing 恒 false 误触发 spawn。
  useEffect(() => {
    if (!activeTabId || !probeDone || claudeMissing || !focused) return;
    const transport = getClaudeTransportRef.current(activeTabId);
    console.log("[ClaudePane] start effect (on focus) -> transport.start()", { activeTabId, probeDone, claudeMissing });
    void transport.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, probeDone, claudeMissing, focused]);

  // 自动恢复到最近会话:tab 首次出现 terminated(spawn/resume 失败,或进程 eof)时,主动拉项目
  // 最近一条历史会话调 transport.resumeSession 重拉起 -- 给用户「打开即接着上次聊」的体验,而非
  // 显示「已终止」等用户手动点 ↻。切 tab 回来 transport 已 start(无 terminated)不触发。
  // 防重入:每个 activeTabId 只恢复一次(autoResumeDoneRef),恢复中也跳过(resumingRef)。
  const autoResumeDoneRef = useRef<Set<string>>(new Set());
  const resumingRef = useRef(false);
  useEffect(() => {
    if (!activeTabId || !probeDone || claudeMissing) return;
    const reason = state?.terminatedReason;
    if (!reason) return;
    // interrupted(用户主动中断)不算失败,不自动恢复;仅 eof/spawn failed 等真异常触发。
    // (claudeStream 对 interrupted 已置 terminatedReason=null,此处 reason 实际只可能是 eof/spawn failed。)
    if (autoResumeDoneRef.current.has(activeTabId)) return;
    if (resumingRef.current) return;
    const cwd = sessions.find((s) => s.id === activeTabId)?.cwd;
    if (!cwd) return;
    autoResumeDoneRef.current.add(activeTabId);
    resumingRef.current = true;
    console.log("[ClaudePane] auto-resume on terminated", { activeTabId, reason, cwd });
    void fetchAiCliSessions(cwd, "claude").then((list) => {
      // 只取当前工作空间(cwd)下的最近会话--跨项目不混(用户明确「当前工作空间下统一性」)。
      // cwd 比较走 normalizeCwdForCompare(去 \\?\ 前缀 + 小写),容忍 jsonl 写入形态差异。
      const top = mostRecentSessionInCwd(list, cwd);
      if (top?.sessionId) {
        getClaudeTransportRef.current(activeTabId)?.resumeSession(top.sessionId);
      }
      resumingRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.terminatedReason, activeTabId, probeDone, claudeMissing]);

  // 订阅活动 tab 的 `!` 命令 transport(独立于 claude 流,切 tab 各自回放)。
  useEffect(() => {
    if (!activeTabId) return;
    const transport = getShellRunTransportRef.current(activeTabId);
    const off = transport.onEvents((s) => setShellState(s));
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // 自动贴底:**条数变化/新末条/状态翻转**时 paint 前同步滚(无 1 帧闪烁);流式 token 同条
  // 文本增长不触发本 effect——每 token 读 scrollHeight 在十万节点容器上是强制同步布局(卡顿源),
  // 换行撑高/异步 md 高亮撑高由下方 ResizeObserver 兜底贴底。
  const msgCount = state?.messages.length ?? 0;
  const lastMsgId = msgCount > 0 ? state!.messages[msgCount - 1].id : undefined;
  const shellCount = shellState?.messages.length ?? 0;
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgCount, lastMsgId, shellCount, state?.status]);
  // 切 tab:重置贴底 + 立即滚到底(切到的 tab 应显示最新)。
  useLayoutEffect(() => {
    stickRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeTabId]);

  // ResizeObserver 兜底:useLayoutEffect 设 scrollTop 时 scrollHeight 可能仍是纯文本高度,
  // markdown 渲染 / 代码块语法高亮 / 图片加载等异步撑高后没有后续 effect 触发 -> 最新内容落在
  // 视口下方(「流式末尾没贴底」根因)。监听内容容器尺寸变化,贴底则补滚,根治异步高度变化。
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

  // @ 文件引用:fuzzy 过滤(路径含 query),限 50 条防巨列表卡。
  const atMatches = useMemo(() => {
    if (!atOpen) return [];
    const q = atQuery.trim().toLowerCase();
    const filtered = q ? atFiles.filter((f) => f.path.toLowerCase().includes(q)) : atFiles;
    return filtered.slice(0, 50);
  }, [atOpen, atQuery, atFiles]);
  useEffect(() => {
    setAtIndex(0);
  }, [atMatches.length]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      const cursorPos = e.target.selectionStart ?? v.length;
      setInput(v);

      // 代码块内(``` 计数为奇数)不触发 @/命令 面板,避免写代码时干扰。
      const backticksBefore = (v.slice(0, cursorPos).match(/```/g) || []).length;
      if (backticksBefore % 2 === 1) {
        setAtOpen(false);
        setCmdOpen(false);
        atPositionRef.current = -1;
        return;
      }

      // / 命令面板(#131):输入恰为 "/xxx"(无空格,未进参数输入)时开;进参数(含空格)/
      // 非 / 开头即关。与 @ 面板天然互斥(@ 前须行首/空格,"/@x" 不触发 @)。
      setCmdOpen(/^\/\S*$/.test(v));

      const textBeforeCursor = v.slice(0, cursorPos);

      // @ 文件引用:光标前 @token(行首/空格后)→ 触发文件列表 Popover(fuzzy 过滤)。
      const atMatch = textBeforeCursor.match(/(?:^|\s)@(\S*)$/);
      if (atMatch) {
        atPositionRef.current = (atMatch.index ?? 0) + (atMatch[0].length - atMatch[1].length - 1);
        setAtOpen(true);
        setAtIndex(0);
        setAtQuery(atMatch[1]);
        const cwd = state?.meta?.cwd;
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
    },
    [state],
  );

  /** 拉 MCP 服务器列表(弹窗与工具侧栏共用):~/.claude.json(user/local scope:顶层
   *  mcpServers + projects[cwd].mcpServers)+ 项目根 .mcp.json(project scope,
   *  `claude mcp add -s project` 的写入位置,并入"本项目"组)。 */
  const loadMcp = useCallback(() => {
    const cwd = sessions.find((s) => s.id === activeTabId)?.cwd;
    void invoke<string>("get_claude_config_path", { target: "mcp" })
      .then((p) => invoke<{ content: string | null; binary: boolean }>("read_file", { path: p }))
      .then((res) => {
        const entries = parseClaudeMcpServers(res.content ?? "", cwd);
        if (!cwd) {
          setMcpEntries(entries);
          return;
        }
        void invoke<{ content: string | null; binary: boolean }>("read_file", { path: `${cwd}/.mcp.json` })
          .then((r2) => {
            const extra = r2.content && !r2.binary ? parseProjectMcpJson(r2.content) : [];
            setMcpEntries([...entries, ...extra]);
          })
          .catch(() => setMcpEntries(entries));
      })
      .catch(() => setMcpEntries([]));
  }, [sessions, activeTabId]);

  /** 打开 MCP 弹窗(⋯ 工具菜单,窄 pane):对齐 claude CLI /mcp 语义,每次打开重读。 */
  const openMcpDialog = useCallback(() => {
    setMcpOpen(true);
    loadMcp();
  }, [loadMcp]);

  /** 拉 Skills 列表(全局 ~/.claude/skills + 项目 <cwd>/.claude/skills 子目录;弹窗与侧栏共用)。 */
  const loadSkills = useCallback(() => {
    setSkillEntries(null);
    void invoke<string>("get_claude_config_path", { target: "skills" })
      .then((dir) =>
        invoke<{ id: string; name: string; kind: string }[]>("list_dir", { path: dir }).then((entries) => {
          const global = entries
            .filter((e) => e.kind === "dir")
            .map((e) => ({ scope: "global" as const, name: e.name, path: e.id }));
          const cwd = sessions.find((s) => s.id === activeTabId)?.cwd;
          if (!cwd) {
            setSkillEntries(global);
            return;
          }
          void invoke<{ id: string; name: string; kind: string }[]>("list_dir", { path: `${cwd}/.claude/skills` })
            .then((pe) => {
              const project = pe
                .filter((e) => e.kind === "dir")
                .map((e) => ({ scope: "project" as const, name: e.name, path: e.id }));
              setSkillEntries([...global, ...project]);
            })
            .catch(() => setSkillEntries(global));
        }),
      )
      .catch(() => setSkillEntries([]));
  }, [sessions, activeTabId]);

  /** 打开 Skills 弹窗(窄 pane):每次打开重读。 */
  const openSkillsDialog = useCallback(() => {
    setSkillsOpen(true);
    loadSkills();
  }, [loadSkills]);

  /** 拉 Plugins 列表(installed_plugins.json 宽松解析 + marketplaces 回退;弹窗与侧栏共用)。 */
  const loadPlugins = useCallback(() => {
    setPluginGroups(null);
    void homeDir()
      .then((home) => {
        const root = `${home}/.claude/plugins`;
        void invoke<{ content: string | null; binary: boolean }>("read_file", { path: `${root}/installed_plugins.json` })
          .then((res) => {
            const groups: { source: string; names: string[] }[] = [];
            if (res.content && !res.binary) {
              try {
                const parsed: unknown = JSON.parse(res.content);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  for (const [source, value] of Object.entries(parsed as Record<string, unknown>)) {
                    let names: string[] = [];
                    if (Array.isArray(value)) {
                      names = value.filter((v): v is string => typeof v === "string");
                    } else if (value && typeof value === "object") {
                      names = Object.keys(value as Record<string, unknown>);
                    }
                    if (names.length > 0) {
                      groups.push({ source, names: names.map((n) => n.split("@")[0]) });
                    }
                  }
                }
              } catch {
                // 非 JSON/损坏:走 marketplaces 回退。
              }
            }
            if (groups.length > 0) {
              setPluginGroups(groups);
              return;
            }
            void invoke<{ name: string; kind: string }[]>("list_dir", { path: `${root}/marketplaces` })
              .then((entries) =>
                setPluginGroups([
                  { source: "marketplaces", names: entries.filter((e) => e.kind === "dir").map((e) => e.name) },
                ]),
              )
              .catch(() => setPluginGroups([]));
          })
          .catch(() => setPluginGroups([]));
      })
      .catch(() => setPluginGroups([]));
  }, []);

  /** 打开 Plugins 弹窗(窄 pane):每次打开重读。 */
  const openPluginsDialog = useCallback(() => {
    setPluginsOpen(true);
    loadPlugins();
  }, [loadPlugins]);

  // 宽 pane 首次达标 → 自动开侧栏(默认 skills);缩小态是用户意图,不自动展开。
  useEffect(() => {
    if (paneWide && toolPanel === null) setToolPanel("skills");
  }, [paneWide, toolPanel]);
  // 侧栏面板切换/出现时拉数据(与弹窗打开同源,每次重读)。
  useEffect(() => {
    if (!toolPanel || !paneWide) return;
    if (toolPanel === "skills") loadSkills();
    else if (toolPanel === "mcp") loadMcp();
    else loadPlugins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolPanel, paneWide]);

  /** ⋯ 菜单/侧栏共用的面板切换(宽 pane):展开侧栏并切 panel。 */
  const showToolPanel = useCallback((p: "skills" | "mcp" | "plugins") => {
    setToolCollapsed(false);
    setToolPanel(p);
  }, []);

  /** ⋯ 工具菜单分组:资源查看(skills/mcp/plugins/agents)+ 会话动作(compact/rewind/config/
   *  help/cost)+ 定位(CLAUDE.md/打开项目文件夹)。承接原 / 面板的全部能力入口(slash 面板已移除);
   *  宽 pane 下 Skills/MCP/Plugins 点击切工具侧栏(常驻展示),窄 pane 开弹窗。 */
  /** slash 命令注册表(#131,单一真相源):⋯ 菜单 / 输入分发 / 命令面板三入口共用。
   *  direct=前端直达(不进消息流,不发给模型);stdin=写 claude 进程(local command,
   *  CLI 进程内执行,模型不可见,与菜单 /compact 同通道)。**不 memo**(每渲染重建,
   *  ~20 个小对象):闭包永远新鲜,规避「前文 memo 引用后文声明 handler」的 deps/TDZ
   *  纠缠——闭包内引用后文声明的 addDirDirect/pickAddDir/exportSession 等运行时才求值。 */
  const slashCommands: SlashCommandDef[] = [
    // —— 会话 ——
    {
      name: "/compact",
      labelKey: "claudepane.toolsCompact",
      group: "session",
      kind: "stdin",
      glyph: "⁝",
      run: () => {
        void getClaudeTransportRef.current(activeTabId)?.send("/compact");
      },
    },
    {
      name: "/add-dir",
      labelKey: "claudepane.toolsAddDir",
      group: "session",
      kind: "direct",
      glyph: "⊞",
      takesArg: true,
      // 带参直达添加(剥引号在 transport.addDir);无参弹文件夹选择器。
      run: (arg) => (arg ? void addDirDirect(arg) : void pickAddDir()),
    },
    { name: "/rewind", labelKey: "claudepane.toolsRewind", group: "session", kind: "direct", glyph: "↺", run: () => setRewindOpen(true) },
    { name: "/model", labelKey: "claudepane.cmdModel", group: "session", kind: "direct", glyph: "✳", run: () => setMenuMode("model") },
    { name: "/effort", labelKey: "claudepane.cmdEffort", group: "session", kind: "direct", glyph: "≈", run: () => setMenuMode("effort") },
    { name: "/config", labelKey: "claudepane.toolsConfig", group: "session", kind: "direct", glyph: "⚙", run: () => window.dispatchEvent(new CustomEvent("mx-open-settings", {})) },
    { name: "/cost", labelKey: "claudepane.toolsCost", group: "session", kind: "direct", glyph: "◷", run: () => setCostOpen(true) },
    { name: "/export", labelKey: "claudepane.cmdExport", group: "session", kind: "direct", glyph: "⤓", run: () => void exportSession() },
    {
      name: "/doctor",
      labelKey: "claudepane.cmdDoctor",
      group: "session",
      kind: "direct",
      glyph: "✚",
      // 环境体检在设置弹窗 general 页:经全局 CustomEvent 请求 AppShell 开设置(避免 prop 深钻)。
      run: () => window.dispatchEvent(new CustomEvent("mx-open-settings", { detail: { tab: "general" } })),
    },
    { name: "/help", labelKey: "claudepane.toolsHelp", group: "session", kind: "direct", glyph: "?", run: () => setHelpOpen(true) },
    {
      name: "/clear",
      labelKey: "claudepane.cmdClear",
      group: "session",
      kind: "direct",
      glyph: "⌫",
      run: () => {
        void getClaudeTransportRef.current(activeTabId)?.clear();
      },
    },
    { name: "/exit", labelKey: "claudepane.cmdExit", group: "session", kind: "direct", glyph: "✕", run: () => onCloseTab?.(paneId, activeTabId) },
    // —— 资源(宽 pane 切工具侧栏,窄 pane 弹窗——与菜单同逻辑) ——
    { name: "/skills", labelKey: "claudepane.toolsSkills", group: "resources", kind: "direct", glyph: "✦", run: () => (paneWide ? showToolPanel("skills") : openSkillsDialog()) },
    { name: "/mcp", labelKey: "claudepane.toolsMcp", group: "resources", kind: "direct", glyph: "⬡", run: () => (paneWide ? showToolPanel("mcp") : openMcpDialog()) },
    { name: "/plugins", labelKey: "claudepane.toolsPlugins", group: "resources", kind: "direct", glyph: "⊞", run: () => (paneWide ? showToolPanel("plugins") : openPluginsDialog()) },
    {
      name: "/agents",
      labelKey: "claudepane.toolsAgents",
      group: "resources",
      kind: "direct",
      glyph: "◈",
      run: () => {
        invoke<string>("get_claude_config_path", { target: "agents" })
          .then((p) => void invoke("reveal_in_folder", { path: p }).catch(() => {}))
          .catch(() => {});
      },
    },
    // —— 定位 ——
    {
      name: "/memory",
      labelKey: "claudepane.toolsMemory",
      group: "locate",
      kind: "direct",
      glyph: "⌖",
      run: () => {
        const cwd = state?.meta?.cwd;
        if (cwd) void invoke("reveal_in_folder", { path: `${cwd}/CLAUDE.md`, cwd }).catch(() => {});
      },
    },
    {
      name: "/folder",
      labelKey: "claudepane.toolsOpenFolder",
      group: "locate",
      kind: "direct",
      glyph: "▤",
      // 项目根目录在资源管理器中打开(cwd 为目录 → explorer 直接打开)。
      run: () => {
        const cwd = state?.meta?.cwd;
        if (cwd) void invoke("reveal_in_folder", { path: cwd }).catch(() => {});
      },
    },
  ];

  // / 命令面板匹配(#131):注册表按输入过滤(剥首 / 后子串匹配)。必须声明在注册表之后
  // (useMemo 渲染期即执行,前文引用后文 const 会 TDZ)。注册表每渲染重建→memo 同步重算,
  // ~18 条小数组无感。
  const cmdMatches = useMemo(() => {
    if (!cmdOpen) return [];
    return filterSlashCommands(slashCommands, input.slice(1));
  }, [cmdOpen, input, slashCommands]);
  useEffect(() => {
    setCmdIndex(0);
  }, [cmdMatches.length]);

  /** ⋯ 工具菜单分组:由注册表按 group 生成(与命令面板/输入分发同源,#131);hint=命令名
   *  反哺 slash 别名可发现性。承接原 / 面板能力入口;宽 pane 下 Skills/MCP/Plugins 点击切
   *  工具侧栏(常驻展示),窄 pane 开弹窗(run 内闭包分支)。 */
  const toolsMenuGroups = useMemo<PaneToolsMenuGroup[]>(
    () =>
      ([["resources", "claudepane.toolsGroupResources", "claude"], ["session", "claudepane.toolsGroupSession", "accent"], ["locate", "claudepane.toolsGroupLocate", "muted"]] as const).map(
        ([group, labelKey, tone]) => ({
          label: t(labelKey),
          tone,
          items: slashCommands
            .filter((c) => c.group === group)
            .map((c) => ({ label: t(c.labelKey), hint: c.name, glyph: c.glyph, onClick: () => void c.run("") })),
        }),
      ),
    // slashCommands 每渲染重建(注册表注释的设计决策)→ memo 每渲染重算,小数组可接受。
    [t, slashCommands],
  );

  /** @ 文件引用:选中文件 → 替换 @token 为 `@<path> `(光标置末尾)。 */
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

  const busy = state?.status === "running" || state?.status === "thinking";
  // API error 自动重试状态(非 null=重试中)。重试期间 status 被覆写 running 维持 busy(中断按钮可用),
  // 此状态驱动状态行「API 错误,正在重试 (n/max)」(最高优先,盖住 thinkingNow)。
  const retrying = state?.retry ?? null;
  // 后台任务运行数(`background_tasks_changed` 快照)。本轮可能已结束(idle),驱动输入框上方
  // 琥珀状态行「后台任务 ×N」;busy/等待确认时被上方状态行盖住,不影响 busy 与发送。
  const bgCount = state?.backgroundTasks.length ?? 0;

  // 当前是否处于「思考中」:busy 且当前轮的 assistant 消息尚无可见文本/工具内容。
  // - 新轮发起后、纯 thinking 阶段(只有 thinking block)→ thinkingNow=true,显「思考中…」。
  // - 有流式文本或 pending/running 工具 → 视为思考结束,thinkingNow=false(执行中)。
  // - **已 done/error 的工具不阻断思考态**:工具完成到下一条 assistant 到达之间正是
  //   模型在生成下一步(批准后的等待期,glm 代理 RTT 数秒)——此前一律显「执行中…」,
  //   直到下一条消息首个 thinking 块到达才翻「思考中」,用户感知「批准完不立马思考中、
  //   有延迟」(2026-10-21 修复)。
  // - compact 进行中(compactRunning)另算,与 thinkingNow 取或(文案由 compactRunning 优先)。
  const thinkingNow = useMemo(() => {
    if (!busy || !state) return false;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role === "assistant") {
        if (m.streaming && m.blocks.some((b) => b.type === "text" && b.text.length > 0)) {
          return false;
        }
        return !m.blocks.some(
          (b) => b.type === "tool_use" && (b.status === "pending" || b.status === "running"),
        );
      }
    }
    return true;
  }, [busy, state]);

  // 「执行中」上下文:busy 且思考结束(已吐文本/工具)后,取最近 assistant 消息里
  // 最后一个仍 pending/running 的 tool_use,驱动输入框上方指示行显示「正在执行 X…」。
  // 此前该阶段指示行完全隐藏,长工具(构建/测试/子 agent)运行中用户无从察觉。
  // 无 running 工具(纯文本流式输出阶段)返回 null,由文案兜底为通用「运行中」。
  const runningTool = useMemo(() => {
    if (!busy || thinkingNow || !state) return null;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role !== "assistant") continue;
      for (let j = m.blocks.length - 1; j >= 0; j--) {
        const b = m.blocks[j];
        if (b.type === "tool_use" && (b.status === "pending" || b.status === "running")) {
          const cfg = getToolConfig(b.name);
          const value = cfg.getValue?.(b.input) ?? "";
          return `${cfg.label ?? b.name}${value ? ` ${value}` : ""}`.slice(0, 60);
        }
      }
      return null; // 只看最近一条 assistant(其前的 pending 已被轮末 finalize 兜底清掉)
    }
    return null;
  }, [busy, thinkingNow, state]);

  // ↑/↓ 浏览输入历史(类 shell):↑ 首次回溯到末条、继续上溯;↓ 前进,越过最新则恢复进入浏览前的草稿。
  const navigateHistory = useCallback(
    (dir: 1 | -1) => {
      if (history.length === 0) return;
      setHistoryIndex((idx) => {
        let next = idx;
        if (dir === -1) {
          if (next === -1) {
            // 首次进入浏览:记下当前草稿,↓ 回到最新时恢复。
            draftRef.current = inputRef.current?.value ?? input;
            next = history.length - 1;
          } else {
            next = Math.max(0, next - 1);
          }
        } else {
          if (next === -1) return -1; // 已在最新,↓ 不动(交还光标下移)
          next += 1;
          if (next >= history.length) next = -1; // 越过最新 → 恢复草稿
        }
        setInput(next === -1 ? draftRef.current : history[next]);
        // 整条替换后跳到末尾,方便接着编辑。
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

  // `!` 命令执行中(提前于 handleSend 派生:其 deps/closure 引用,声明在后会 TDZ)。
  const shellRunning = shellState?.running ?? false;

  /** 选择文件夹追加工作目录(/add-dir 无参数时 & ⋯ 菜单「添加工作目录」共用)。
   *  busy 经 busyRef 读(不进 deps——同 resendText 模式:toolsMenuGroups 的 memo 闭包不随
   *  busy 翻转失效,读的永远是当前值):busy 时先 interrupt(transport.addDir 的立即重启只
   *  在 idle 生效;中断后下次 send 的 ensureStarted 检测 addDirs 变更重启生效)。
   *  非 Tauri 环境对话框 reject → 静默跳过。 */
  /** 直连添加工作目录(带参 /add-dir & 选择器路径共用):busy 先 interrupt
   *  (transport.addDir 的立即重启只在 idle 生效;中断后下次 send 的 ensureStarted
   *  检测 addDirs 变更重启生效)。路径规范化(剥引号)在 transport.addDir 内。 */
  const addDirDirect = useCallback(
    async (path: string) => {
      const transport = getClaudeTransportRef.current(activeTabId);
      if (!transport) return;
      if (busy) await transport.interrupt();
      void transport.addDir(path);
    },
    [activeTabId, busy],
  );

  /** 选择文件夹追加工作目录(/add-dir 无参数 & ⋯ 菜单「添加工作目录」入口)。
   *  非 Tauri 环境对话框 reject → 静默跳过。 */
  const pickAddDir = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false }).catch(() => null);
    if (typeof picked !== "string" || !picked) return;
    await addDirDirect(picked);
  }, [addDirDirect]);

  /** /export 导出 toast(#131):成功/失败一次性提示(3.5s 自动消失)。 */
  const [exportToast, setExportToast] = useState<{ ok: boolean; msg: string } | null>(null);
  useEffect(() => {
    if (!exportToast) return;
    const id = window.setTimeout(() => setExportToast(null), 3500);
    return () => window.clearTimeout(id);
  }, [exportToast]);

  /** /export:当前 tab 会话导出 Markdown(state.messages 拼 user/assistant 文本 + 工具行 +
   *  压缩边界)→ 保存对话框 → write_file 落盘。取消静默;成功/失败 toast 反馈。 */
  const exportSession = useCallback(async () => {
    const msgs = state?.messages ?? [];
    if (msgs.length === 0) return;
    const lines: string[] = ["# txuyStudio Session", ""];
    for (const m of msgs) {
      if (m.role === "user") {
        const text = m.blocks.filter((b): b is Extract<ClaudeBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");
        if (text.trim()) lines.push("## 🧑 User", "", text, "");
      } else if (m.role === "assistant") {
        const text = m.blocks.filter((b): b is Extract<ClaudeBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");
        const tools = m.blocks.filter((b): b is Extract<ClaudeBlock, { type: "tool_use" }> => b.type === "tool_use").map((b) => `> 🔧 \`${b.name}\``);
        if (text.trim() || tools.length) {
          lines.push(`## 🤖 Assistant${m.model ? ` (${m.model})` : ""}`, "");
          if (text.trim()) lines.push(text, "");
          if (tools.length) lines.push(...tools, "");
        }
      } else if (m.role === "compact" && m.compactKind === "boundary") {
        const pre = m.compactMeta?.preTokens;
        const post = m.compactMeta?.postTokens;
        lines.push(`> ⏳ compact boundary${pre != null && post != null ? ` (${pre} → ${post} tokens)` : ""}`, "");
      }
    }
    const md = lines.join("\n");
    const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
    const path = await saveDialog({
      defaultPath: `session-${stamp}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    }).catch(() => null);
    if (typeof path !== "string" || !path) return;
    try {
      await invoke("write_file", { path, content: md });
      setExportToast({ ok: true, msg: t("claudepane.exportDone", { path }) });
    } catch (err) {
      setExportToast({ ok: false, msg: t("claudepane.exportFailed", { error: String(err) }) });
    }
  }, [state, t]);

  /**
   * 回溯到某条历史消息(↺ 弹窗点击):后端 `fork_claude_session` 把当前会话 jsonl 在该消息
   * **之前**截断分叉成新会话文件 → `resumeSession(新 id)` kill 旧进程 + `--resume` 拉起分叉
   * (上下文真正回到该消息之前;glm 不重放历史,消息流由 backfillHistory 读分叉文件回填,
   * 消息流同步截断)→ 该消息文本回填输入框,可改后重发。截断点前无对话(回溯到第一条)→
   * 分叉是空壳,走 `clear()` 等价路径(空上下文重开)。
   *
   * 定位:stream-json 不回显用户消息、UI user 消息是乐观插入的自生成 id,无 uuid 可用;
   * 以「同文本第几次出现」匹配 UI 顺序 == jsonl 行顺序(occurrence,与后端约定一致)。
   * fork/定位失败 → toast 报错且**不动现有会话**(替换旧「/clear 全清+回填」——上下文全丢、
   * 用户实测「清空了也没回溯成功」)。
   */
  const rewindToMessage = useCallback(
    async (m: ClaudeMessage) => {
      const transport = getClaudeTransportRef.current(activeTabId);
      const sessionId = state?.meta?.claudeSessionId;
      const fullText = (blocks: ClaudeBlock[]) =>
        blocks
          .filter((b): b is Extract<ClaudeBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
      const text = fullText(m.blocks);
      if (!transport || !sessionId || !text.trim()) return;
      // 同文本第几次出现(0-based);indexOf 找不到(理论上不会)兜底 0。
      const occ = Math.max(
        0,
        (state?.messages ?? []).filter((x) => x.role === "user" && fullText(x.blocks) === text).indexOf(m),
      );
      setRewindBusy(true);
      try {
        const res = await invoke<{ newSessionId: string | null }>("fork_claude_session", {
          sessionId,
          text,
          occurrence: occ,
        });
        if (res.newSessionId) {
          await transport.resumeSession(res.newSessionId);
        } else {
          await transport.clear();
        }
        setInput(text);
        setRewindOpen(false);
        requestAnimationFrame(() => inputRef.current?.focus());
      } catch (err) {
        setRewindError(t("claudepane.rewindFailed", { error: String(err) }));
      } finally {
        setRewindBusy(false);
      }
    },
    [activeTabId, state, t],
  );

  /** 执行注册表命令(输入分发与命令面板共用):stdin 类 busy 先 interrupt(对齐原输入框
   *  /compact 路径——busy 中直写会因后端拒发触发 kill+resume 竞态);direct 类 busy 语义
   *  由命令自理(需重启进程的 add-dir 自行 interrupt,开弹窗/资源面板的无视 busy)。 */
  const runSlash = useCallback(
    async (def: SlashCommandDef, arg: string) => {
      if (def.kind === "stdin" && busy) {
        const transport = getClaudeTransportRef.current(activeTabId);
        if (transport) await transport.interrupt();
      }
      await def.run(arg);
    },
    [activeTabId, busy],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    // 记入输入历史(去重后置末,限 100 条),重置浏览位置。
    setHistory((h) => {
      const filtered = h.filter((x) => x !== text);
      const next = [...filtered, text];
      const trimmed = next.length > 100 ? next.slice(next.length - 100) : next;
      // 持久化到 localStorage(按项目 cwd key),跟随当前项目,重启后保留。
      const sk = historyStorageKeyRef.current;
      if (sk) {
        try { localStorage.setItem(sk, JSON.stringify(trimmed)); } catch { /* ignore */ }
      }
      return trimmed;
    });
    setHistoryIndex(-1);
    const transport = getClaudeTransportRef.current(activeTabId);
    // `!` 命令:内联执行 PowerShell(不走 claude 进程)。`!` 后即命令,如 `!Get-Date`。
    // 在当前项目根执行,输出实时流式显示在对话流里。空 `!`(无命令)忽略。
    // cwd 来源:优先 meta.cwd(claude 进程 cwd,已启动时最准);未启动时兜底活动 session 的 cwd
    // (派生层 = 项目根),避免 claude 未启动就 `!ls` 跑到应用启动目录。
    if (text.startsWith("!")) {
      // shell 命令在跑:拒绝新命令(后端 busy 也会拒,这里前置拦避免清掉用户输入像「凭空消失」)。
      // 不清 input 直接返回,用户可 ✕ 中断当前命令后再发。Enter 已拦(canSend 守卫),此为兜底。
      if (shellRunning) return;
      const cmd = text.slice(1).trim();
      setInput("");
      if (cmd) {
        const shellTransport = getShellRunTransportRef.current(activeTabId);
        const cwd = state?.meta?.cwd ?? sessions.find((s) => s.id === activeTabId)?.cwd;
        void shellTransport.run(cmd, cwd);
      }
      return;
    }
    // slash 命令分发(注册表,#131):命中 → 直达执行(direct 前端直调 / stdin 写进程,
    // 均不进消息流、模型不可见——headless 下未集成的 slash 只当文本,注册表拦截是唯一
    // 可靠通道);未命中 → 透传当普通消息(保留「故意发 /xxx 给模型当提示词」的自由)。
    if (text.startsWith("/")) {
      const parsed = parseSlashInput(text);
      const def = parsed ? slashCommands.find((c) => c.name === parsed.token) : undefined;
      if (def && parsed) {
        setInput("");
        await runSlash(def, parsed.arg);
        return;
      }
    }
    // busy 时(claude 仍在上轮)先中断当前轮——后端 spawn busy 会拒绝。
    // 中断后发新轮会带 --resume 续接上下文,新消息在下一轮被 Claude 看到(对齐 claude code 体验)。
    if (busy) {
      await transport.interrupt();
    }
    setInput("");
    // 发送前立即贴底:用户手动发消息后若已上滚看历史,此时仍强制滚到底,
    // 避免用户消息插入后还留在原视口(optimistic 插入 + transport.send 异步,时序抖动),
    // 也与 stickRef 在 send 后已为 true 的 useLayoutEffect 行为一致。
    scrollToBottom();
    void transport.send(text);
  }, [activeTabId, input, busy, shellRunning, scrollToBottom, runSlash]);

  // C6 重新发送:user 消息 ↻ 重跑同一轮。busy 时**先 await interrupt 再 send**(与 handleSend
  // 同语义:后端 busy 会拒新轮,不 await 会竞速丢消息);经 busyRef 读 busy(不进 deps——
  // resendText 作为 onResend 传 memo MessageRow,busy 每轮翻转两次身份会击穿全部消息行 memo)。
  // 不记输入历史(重发不是新输入),发送前贴底。
  const resendText = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      const transport = getClaudeTransportRef.current(activeTabId);
      if (busyRef.current) await transport.interrupt();
      scrollToBottom();
      void transport.send(text);
    },
    [activeTabId, scrollToBottom],
  );

  const handleInterrupt = useCallback(() => {
    const transport = getClaudeTransportRef.current(activeTabId);
    void transport.interrupt();
    // compact 进行中被中断:kill 进程 → 后端 emit interrupted → state.compactRunning 复位(idle)。
    // 无需前端清标记(由事件驱动)。
  }, [activeTabId]);

  // 中断当前 `!` 命令(kill powershell 进程)。后端 emit interrupted → shellState 复位。
  const handleShellInterrupt = useCallback(() => {
    const transport = getShellRunTransportRef.current(activeTabId);
    void transport.interrupt();
  }, [activeTabId]);


  // 应用选中的 model:调 transport.setModel(--model 启动 flag,重启进程生效;stdin `/model` 对
  // 后续轮次不可靠)。idle 时 setModel 内部立即 restart(带 --resume,session 保留);busy 时先
  // interrupt 当前轮,下次 send 以新 --model 启动。乐观更新状态栏 model 立即反映。
  const applyModel = useCallback(
    async (name: string) => {
      const transport = getClaudeTransportRef.current(activeTabId);
      setMenuMode(null);
      if (busy) await transport.interrupt();
      void transport.setModel(name);
    },
    [activeTabId, busy],
  );

  // 应用选中的 effort:调 transport.setEffort("auto" -> undefined,不传 --effort flag)。
  // setEffort 只更新 effort 标记 + 乐观回填 meta.effort 并 emit(UI 即时反映),下次 send 前
  // ensureStarted 检测 effort!==activeEffort 才 kill+start(--resume)换 effort--下轮生效,
  // 不打断当前轮(与 setMode 同语义),故无需 interrupt。
  const applyEffort = useCallback(
    (level: string) => {
      const transport = getClaudeTransportRef.current(activeTabId);
      transport.setEffort(level === "auto" ? undefined : level);
      setMenuMode(null);
    },
    [activeTabId],
  );

  // busy 时也允许输入与发送(发送会先 interrupt 再发,对齐 claude code)。仅未装/无文本/compact 进行中时禁用发送
  // (compact 进行中发送会打断压缩 + 状态错乱;state.compactRunning 由 compact_status 事件驱动)。
  const compactRunning = state?.compactRunning ?? false;
  // shellRunning 已提前派生(见 handleSend 前);canSend 与 Enter 守卫共用。
  const canSend = !!input.trim() && !claudeMissing && !compactRunning && !shellRunning;

  // —— 权限模式(permission-mode):状态栏显示 + 切换 + Shift+Tab 循环。mode 跟 transport(per tab)——
  const [mode, setModeState] = useState<string>(() => getClaudeTransport(activeTabId).getMode());
  // 切 tab 时同步该 tab transport 的 mode。
  useEffect(() => {
    setModeState(getClaudeTransport(activeTabId).getMode());
  }, [activeTabId, getClaudeTransport]);
  // 已处理(批准/拒绝)的权限确认 tool_use id 集合:避免重放后老 denied block 永久挂确认框。
  // 切 tab 清空(各 tab 独立);批准/拒绝后 add 对应 block.id,确认框消失,改走正常视图显「已完成」药丸。
  const [resolvedApprovals, setResolvedApprovals] = useState<Set<string>>(new Set());
  useEffect(() => {
    setResolvedApprovals(new Set());
    // compact 状态由 transport 的 state 跟随(切 tab 回来 onEvents 回放当前 state),无需手动清。
  }, [activeTabId]);
  const setMode = useCallback(
    (m: string) => {
      getClaudeTransportRef.current(activeTabId).setMode(m);
      setModeState(m);
      setMenuMode(null);
    },
    [activeTabId],
  );
  const cycleMode = useCallback(() => {
    const transport = getClaudeTransportRef.current(activeTabId);
    const cur = transport.getMode();
    const idx = PERMISSION_MODES.findIndex((m) => m.id === cur);
    const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length];
    transport.setMode(next.id);
    setModeState(next.id);
  }, [activeTabId]);
  const currentModeMeta = PERMISSION_MODES.find((m) => m.id === mode) ?? PERMISSION_MODES[0];
  // plan 批准:切 auto + 中断当前 plan 轮 + 发"执行计划"。
  const handleApprovePlan = useCallback(async () => {
    const transport = getClaudeTransportRef.current(activeTabId);
    transport.setMode("acceptEdits");
    setModeState("acceptEdits");
    // 控制通道优先:ExitPlanMode 以 can_use_tool 控制请求到达时 CLI 正阻塞等答复,
    // 回 allow 让 **CLI 自己退出 plan 模式续跑**(零中断零重放)。老路径(interrupt+发文字)
    // 会把阻塞中的 CLI 杀掉——界面上先渲染「[Request interrupted by user]」再乐观插入批准
    // 文字,restart 后才可能恢复,glm 代理下常停在半路(用户报告的「批准后状态停止」)。
    const pending = stateRef.current?.pendingPermissions.find(
      (p) => p.toolName === "ExitPlanMode" || p.toolName === "exit_plan_mode",
    );
    if (pending) {
      void transport.respondPermission(pending.requestId, "allow");
      return;
    }
    await transport.interrupt();
    void transport.send("批准该计划,开始执行");
  }, [activeTabId]);
  // 拒绝计划:不切模式,聚焦输入框让用户说明修改意见(下一轮 --resume 时 Claude 看到)。
  const handleReject = useCallback(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  // 批准被拒的工具调用(确认框「批准本次」/「批准且不再问」):标记 resolved + approveToolRun
  // (本地执行 + tool_result 原地回传;busy 时 transport 自愈 kill+--resume+重试,见 sendToolResult)。
  // persist=true 持久化到项目 allowlist(后续免确认)。
  // resolve 时一并清掉最后一条 assistant 消息里所有「需审批被拒」的 block——同轮常有多项被拒,
  // 一次批准/拒绝就整批隐藏确认框(批准只放行点中的工具,其余下轮若再被调会重新弹框)。
  const handleApproveTool = useCallback(
    async (block: Extract<ClaudeBlock, { type: "tool_use" }>, persist: boolean) => {
      const transport = getClaudeTransportRef.current(activeTabId);
      // ① 控制通道(can_use_tool):CLI 正阻塞等答复 —— 回 allow 后**CLI 自己执行并续跑**,
      // 不本地代执行、不注入 tool_result(原启发式路径批准后常断链:CLI 又吃拒绝 + 轮次不继续)。
      // persist(批准且不再问)仍写项目 allowlist(下次 spawn 生效),当轮照常 allow。
      const pending = pendingByBlockIdRef.current.get(block.id);
      if (pending) {
        // persist(批准且不再问)→ 写项目 allowlist(下次 spawn 免问;当轮照常 allow)。
        if (persist) transport.persistAllowedTool(block.name);
        void transport.respondPermission(pending.requestId, "allow", { input: pending.input });
        return;
      }
      setResolvedApprovals((s) => {
        const next = new Set(s).add(block.id);
        const st = stateRef.current;
        const last = st && st.messages.length > 0 ? st.messages[st.messages.length - 1] : undefined;
        if (last?.role === "assistant") {
          for (const b of last.blocks) {
            if (b.type === "tool_use" && isPermissionDenied(b)) next.add(b.id);
          }
        }
        return next;
      });
      void transport.approveToolRun({
        toolUseId: block.id,
        tool: block.name,
        input: block.input,
        persist,
        cwd: stateRef.current?.meta.cwd ?? null,
        fallbackApproveMsg: t("claudepane.approveProceed"),
      });
    },
    [activeTabId, t],
  );
  // 拒绝被拒的工具调用(确认框「拒绝」):标记 resolved + 发拒绝消息(--resume 时 Claude 看到,换方式)。
  // reason 为空 → 走原「请建议替代方式」;非空 → 把用户说明拼进 tool_result content,Claude 据此调整路径
  // (借鉴 BaoCode interaction_panel.dart deny 行 textHint→message 语义)。
  const handleRejectTool = useCallback(
    (block: Extract<ClaudeBlock, { type: "tool_use" }>, reason: string = "") => {
      const transport = getClaudeTransportRef.current(activeTabId);
      // 控制通道:回 deny + 用户理由(模型据此换方式继续,不 kill 不重启)。
      const pending = pendingByBlockIdRef.current.get(block.id);
      if (pending) {
        void transport.respondPermission(pending.requestId, "deny", {
          message: reason.trim() || undefined,
        });
        return;
      }
      setResolvedApprovals((s) => {
        const next = new Set(s).add(block.id);
        const st = stateRef.current;
        const last = st && st.messages.length > 0 ? st.messages[st.messages.length - 1] : undefined;
        if (last?.role === "assistant") {
          for (const b of last.blocks) {
            if (b.type === "tool_use" && isPermissionDenied(b)) next.add(b.id);
          }
        }
        return next;
      });
      void transport.sendToolResult(block.id, buildDenyContent(block.name, reason), true);
    },
    [activeTabId, t],
  );
  // 反馈修改(确认框「反馈修改」):聚焦输入框让用户写具体反馈(复用 handleReject 的 focus 模式)。
  const handleFeedback = useCallback(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // —— 待确认权限卡的键盘流(焦点留在输入框,不抢焦点) ——
  // 派生「当前待确认 block」= 最近一条 assistant 消息里第一个被拒且未 resolved 的 tool_use
  // (同轮多卡时任何一张批准即整批 resolve,故键盘只控制第一张)。空输入 + 无面板时输入框里
  // ←→ 移动高亮、Enter 触发对应动作(见输入框 onKeyDown);非空输入不拦(打字优先,发消息
  // 本身也是对确认的回应)。卡片高亮由 approvalFocusIdx 驱动(外部状态,非 DOM 焦点)。
  // 待决策的 CLI 权限请求按 block.id 索引(can_use_tool 的 tool_use_id 与 assistant tool_use block
  // id 一致,spike 实测)。CLI 未带 tool_use_id(旧版/异常)时兜底挂到最近一条 assistant 里同名且
  // 无结果的 tool_use——否则卡片无处可挂,用户看不见请求。
  const pendingByBlockId = useMemo(() => {
    const m = new Map<string, PendingPermission>();
    if (!state) return m;
    for (const p of state.pendingPermissions) {
      if (p.toolUseId) {
        m.set(p.toolUseId, p);
        continue;
      }
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const msg = state.messages[i];
        if (msg.role !== "assistant") continue;
        const hit = [...msg.blocks]
          .reverse()
          .find((x) => x.type === "tool_use" && x.name === p.toolName && !x.result);
        if (hit && hit.type === "tool_use") {
          m.set(hit.id, p);
          break;
        }
      }
    }
    return m;
  }, [state]);

  // handler 用 ref 读 map(避免把每次渲染新建的 Map 塞进 useCallback deps 造成回调抖动)。
  const pendingByBlockIdRef = useRef(pendingByBlockId);
  useEffect(() => {
    pendingByBlockIdRef.current = pendingByBlockId;
  }, [pendingByBlockId]);
  const activeApproval = useMemo(() => {
    if (!state) return null;
    // 控制通道优先:CLI 阻塞等待的请求挂着的那个 tool_use block 即键盘流目标。
    for (const p of state.pendingPermissions) {
      if (!p.toolUseId) continue;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.role !== "assistant") continue;
        const hit = m.blocks.find((b) => b.type === "tool_use" && b.id === p.toolUseId);
        if (hit && hit.type === "tool_use") return hit;
        break; // 只认最近一条 assistant
      }
    }
    // 启发式兜底(旧路径:被拒文案识别)。
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role !== "assistant") continue;
      for (const b of m.blocks) {
        if (b.type === "tool_use" && isPermissionDenied(b) && !resolvedApprovals.has(b.id)) return b;
      }
      return null; // 只认最近一条 assistant(更早的属历史轮,不进键盘流)
    }
    return null;
  }, [state, resolvedApprovals]);
  const activeApprovalId = activeApproval?.id ?? null;
  const [approvalFocusIdx, setApprovalFocusIdx] = useState(0);
  useEffect(() => {
    setApprovalFocusIdx(0);
  }, [activeApprovalId]);
  const triggerApprovalAction = useCallback(
    (idx: number) => {
      const block = activeApproval;
      if (!block) return;
      if (idx === 0) void handleApproveTool(block, false);
      else if (idx === 1) void handleApproveTool(block, true);
      else if (idx === 2) handleRejectTool(block);
      // 3 = 反馈修改:聚焦输入框——键盘流前提即焦点在输入框,no-op。
    },
    [activeApproval, handleApproveTool, handleRejectTool],
  );

  // —— Ctrl+A 智能选框(pane focused 时)——
  // 选区锚点(最后点击处)落在消息流某个 <pre> 输出框内 → 只全选该框,配合 Ctrl+C 整块复制;
  // 否则放行系统默认(全选整条消息流)。输入框聚焦时让浏览器原生全选 textarea 文本。
  useEffect(() => {
    if (!focused) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "a" || e.altKey || e.shiftKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;
      if (selectEnclosingPre(scrollRef.current)) e.preventDefault();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focused]);

  // —— 双击 Esc 中断快捷键(对齐 claude code)——
  // pane focused 时监听 window keydown;面板关闭状态下,400ms 内连续两次 Esc → 中断当前轮。
  // 用 ref 镜像避免 stale closure。
  const lastEscRef = useRef(0);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const handleInterruptRef = useRef(handleInterrupt);
  handleInterruptRef.current = handleInterrupt;
  useEffect(() => {
    if (!focused) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
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

  // —— 会话时长:首次出现消息记起点;显示走 ElapsedText 本地 tick(不每秒重渲染整个 pane)——
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  useEffect(() => {
    if (sessionStart === null && state && state.messages.length > 0) {
      setSessionStart(Date.now());
    }
  }, [state, sessionStart]);

  // 本轮(thinking/running)已耗时:busy 从 false→true 时记 turnStart(=本轮开始)。
  // busy 结束清零。显示走 ElapsedText 本地每秒 tick,不触发消息流父组件重渲染。
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const prevBusyRef = useRef(false);
  useEffect(() => {
    if (busy && !prevBusyRef.current) setTurnStart(Date.now());
    else if (!busy) setTurnStart(null);
    prevBusyRef.current = busy;
  }, [busy]);

  // 底部 ↑↓ / 用量弹窗的 token 数字(产品决策 2026-10-08:计费累计不再上屏——长会话
  // 轻松超窗口,对用户是「瞎统计」)。只取最近一条**真实用量的 assistant**的本轮值
  // (#133 底层权威:官方流式快照 / glm result.usage 回填,均本轮口径;compact boundary
  // 停扫——压缩前的旧快照不代表当前):↑ = 本轮完整输入(≈当前上下文)、↓ = 本轮输出。
  // 成本权威值在 result.totalCostUsd,与 token 显示解耦。
  const turnTokens = useMemo(() => {
    if (!state) return { input: 0, output: 0 };
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role === "compact" && m.compactKind === "boundary") break;
      if (m.role === "assistant" && hasUsage(m.usage)) {
        return { input: claudeInputTokens(m.usage!), output: m.usage!.output_tokens ?? 0 };
      }
    }
    return { input: 0, output: 0 };
  }, [state]);

  // 状态栏 model:优先用 meta.model(当前会话设定:init 回填 + setModel 乐观更新 + 每轮真实
  // assistant 事件校正),使切 model 后状态栏立即反映;回退最近 assistant 消息的 model(双保险)。
  const model = state?.meta?.model ?? (() => {
    for (let i = (state?.messages.length ?? 0) - 1; i >= 0; i--) {
      const m = state!.messages[i];
      if (m.role === "assistant" && m.model) return m.model;
    }
    return undefined;
  })();

  /** 分组下拉「生效中」的唯一真源:优先 env 的 ANTHROPIC_MODEL(点了应用即生效),
   *  env 没配默认模型时退当前运行 model。绝不用 alias 与 model 双来源——切完
   *  供应商+模型后 meta.model 还是旧值,双来源会让两个模型同时打勾。 */
  const activeModelName = useMemo(() => {
    const fromEnv = (currentEnv?.ANTHROPIC_MODEL ?? "").trim();
    return fromEnv || model || "";
  }, [currentEnv, model]);
  /** 分组下拉里的一行模型:点 → 确认弹窗 → switchProviderModel 整体切换。 */
  const renderProviderModelRow = useCallback(
    (g: { p: ClaudeProvider; active: boolean }, m: string) => {
      const active = g.active && m === activeModelName;
      return (
        <button
          key={m}
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            setMenuMode(null);
            setPendingProviderModel({ p: g.p, m });
          }}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors ${
            active
              ? "bg-[var(--mx-selected-bg)] text-[var(--mx-text)]"
              : "text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
          }`}
        >
          <span className="flex-1 truncate font-mono text-[11px] font-semibold" title={m}>{m}</span>
          {active && (
            <svg className="h-3 w-3 shrink-0 text-[var(--mx-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
              <path d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>
      );
    },
    [activeModelName],
  );

  // 当前上下文用量:公共口径 computeContextInfo(#133 底层权威直取——最近一次 compact
  // 后最近一条真实 usage,官方流式快照 / glm result.usage 回填,不再差分/统计消息流)。
  const contextInfo = useMemo(
    () => (state ? computeContextInfo(state, inferContextWindow(model)) : null),
    [state, model],
  );

  // P5.2 — 作曲区 ctx 仪表点击弹悬浮框的数据源:取「最后一条带真实 usage 的 assistant 消息」
  // (与 computeContextInfo 同口径:遇 compact boundary 截断),供弹窗拆 input/cache 明细。
  const ctxDetailSource = useMemo(() => {
    const msgs = state?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role === "compact" && m.compactKind === "boundary") break;
      if (m.role !== "assistant" || !hasUsage(m.usage)) continue;
      return m.usage!;
    }
    return null;
  }, [state?.messages]);


  // 合并后的消息流(claude + `!` shell),useMemo 缓存:否则每次按键/每帧 render 都重跑
  // O(n) 归并 + Date.parse,跑过 `!` 命令后是每帧 O(n log n)。
  const mergedMessages = useMemo(
    () => mergeClaudeAndShellMessages(state?.messages ?? [], shellState?.messages ?? []),
    [state?.messages, shellState?.messages],
  );

  // P2.1 — StepFolds 派生(纯函数 computeFolds + classifyCommand)
  //  - 只对 claude 消息算;shell 消息不参与 fold
  //  - live=true 时(任何 message.streaming)→ 不折叠
  //  - **优化**:useMemo 依赖结构化 key 而非 mergedMessages 整体引用 — 流式 partial block
  //    更新时(usage / streaming=false / blocks 追加)不重算 foldMap,只「id 序列变化」或
  //    「live 状态切换」时重算。claudeMsgCount 用 shell 侧稳定参考。
  const claudeMsgCount = useMemo(
    () => mergedMessages.reduce((n, x) => n + (x.kind === "claude" ? 1 : 0), 0),
    [mergedMessages],
  );
  // can_use_tool 挂起数(CLI 阻塞等审批):此时消息 streaming 已结束但轮次未完,
  // 折叠必须整体暂停 —— 否则审批卡被折进 steps fold,只剩「N 个步骤」提示没有选择框。
  const pendingPermCount = state?.pendingPermissions.length ?? 0;
  const foldKey = useMemo(() => {
    // 拼接「id 序列 + 任一 streaming + 待审批挂起」:只在「新增/删除/streaming 切换/审批挂起切换」时变
    let key = `${claudeMsgCount}|`;
    let live = false;
    for (const x of mergedMessages) {
      if (x.kind !== "claude") continue;
      key += x.msg.id + ":";
      if (x.msg.streaming) live = true;
    }
    if (pendingPermCount > 0) live = true;
    key += `|live=${live}`;
    return key;
  }, [mergedMessages, claudeMsgCount, pendingPermCount]);
  const foldMap = useMemo(() => {
    const claudeMsgs = mergedMessages
      .filter((x): x is { kind: "claude"; msg: ClaudeMessage; ts: number } => x.kind === "claude")
      .map((x) => x.msg);
    const live = claudeMsgs.some((m) => m.streaming) || pendingPermCount > 0;
    return computeFolds(claudeMsgs, { live, commandAction: classifyCommand });
  }, [foldKey, pendingPermCount]);

  // P2.1 — foldMap.rows 按 claude 顺序排;映射回 mergedMessages 索引(shell 位置 null)
  // **优化**:foldRowByItemIndex 只在 mergedMessages 数量或 foldMap 变化时算
  const foldRowByItemIndex = useMemo(() => {
    const out: (typeof foldMap.rows[number] | null)[] = new Array(mergedMessages.length).fill(null);
    let ci = 0;
    for (let i = 0; i < mergedMessages.length; i++) {
      const item = mergedMessages[i]!;
      if (item.kind === "claude") {
        out[i] = foldMap.rows[ci] ?? null;
        ci++;
      }
    }
    return out;
  }, [mergedMessages, foldMap]);

  // P2.2 — work fold 答案反查表(end+1 → fold):答案行不在 fold 段内(work 字段 null),
  // 渲染循环靠它识别「本行是某轮的答案」→ 卡片内部渲染「已处理」摘要行。
  const workFoldByAnswer = useMemo(() => {
    const m = new Map<number, StepFold>();
    for (const f of foldMap.workFolds) m.set(f.end + 1, f);
    return m;
  }, [foldMap]);

  // P2.2 — 折叠行 open 状态(受控,fold key 集合;localStorage 持久化)。
  // key 稳定性:work/steps 都用 `${kind}:${start}:${end}` —— start/end 是 claude 消息
  // 数组下标,轮次推进时旧 fold 的 key 不变(段只会在尾部增长),跨刷新稳定。
  const claudeMessagesForFolds = useMemo(
    () => mergedMessages.filter((x): x is { kind: "claude"; msg: ClaudeMessage; ts: number } => x.kind === "claude").map((x) => x.msg),
    [mergedMessages],
  );
  // merged 索引 → claude 消息下标(shell 行 null):渲染 map 里查表拿 fold 坐标系下的 i。
  const claudeIndexByMerged = useMemo(() => {
    const out: (number | null)[] = new Array(mergedMessages.length).fill(null);
    let ci = 0;
    for (let i = 0; i < mergedMessages.length; i++) {
      if (mergedMessages[i].kind === "claude") {
        out[i] = ci;
        ci++;
      }
    }
    return out;
  }, [mergedMessages]);
  const workFoldKey = (f: { kind: string; start: number; end: number }) => `work:${f.start}:${f.end}`;
  const stepsFoldKey = (f: { kind: string; start: number; end: number }) => `steps:${f.start}:${f.end}`;

  // 消息流窗口化(内存优化):只挂最近一批消息的 DOM,顶部哨兵上滚自动展开更早一批。
  // 折叠索引表按 mergedMessages 全量下标工作 → 渲染循环用 gi = i + msgOffset 回查。
  const { offset: msgOffset, sentinel: msgSentinel } = useMessageWindow(mergedMessages.length, scrollRef, activeTabId);
  const visibleMessages = msgOffset > 0 ? mergedMessages.slice(msgOffset) : mergedMessages;
  const currentPrompt = useMemo(() => {
    for (let i = mergedMessages.length - 1; i >= 0; i--) {
      const item = mergedMessages[i];
      if (item?.kind !== "claude" || item.msg.role !== "user") continue;
      const text = item.msg.blocks
        .map((block) => (block.type === "text" ? block.text.trim() : ""))
        .filter(Boolean)
        .join("\n");
      if (text) return { id: item.msg.id, text };
    }
    return null;
  }, [mergedMessages]);
  const currentPromptStick = useCurrentPromptStick({
    promptId: currentPrompt?.id,
    scrollRef,
    revision: `${mergedMessages.length}:${msgOffset}`,
  });
  const [openFolds, setOpenFolds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(`mx.foldOpen.${activeTabId}`);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  const toggleFold = useCallback((key: string) => {
    setOpenFolds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(`mx.foldOpen.${activeTabId}`, JSON.stringify([...next]));
      } catch {
        /* localStorage 不可用 — 静默 */
      }
      return next;
    });
  }, [activeTabId]);
  // work fold 级 toggle(MessageRow memo 友好:fold 引用稳定,key 在此内联拼)。
  const toggleWorkFold = useCallback((f: StepFold) => toggleFold(`work:${f.start}:${f.end}`), [toggleFold]);

  // 是否有待决策的计划:最后一条 assistant 消息的末块是 exit_plan_mode。
  // 批准/拒绝后会追加 user 消息 → 末消息变 user → false,自然反映「已处理」(暂停解除)。
  const hasPendingPlan = useMemo(() => (state ? hasPendingPlanFn(state) : false), [state]);
  // 是否有待批准的敏感操作:最近一条 assistant 消息里有「需审批被拒」且未 resolved 的 tool_use。
  // 批准/拒绝后 block.id 进 resolvedApprovals → 该 block 不再计入 → 状态栏提示解除。
  const hasPendingApproval = useMemo(
    () => (state ? hasPendingApprovalFn(state, resolvedApprovals) : false),
    [state, resolvedApprovals],
  );
  // 后台任务「最近完成」列表(任务面板第三节):从 messages 反向扫 notice 消息取末尾 5 条,
  // 倒序收集后 reverse 回时间正序。summary 是 claude 原文(含命令 description + exit code)。
  const bgDoneNotices = useMemo(() => {
    if (!state) return [] as { kind: "bg_done" | "bg_failed" | "bg_stopped"; summary: string }[];
    const out: { kind: "bg_done" | "bg_failed" | "bg_stopped"; summary: string }[] = [];
    for (let i = state.messages.length - 1; i >= 0 && out.length < 5; i--) {
      const m = state.messages[i];
      const n = m.notice;
      // 只收后台任务 notice(正向匹配);history_resumed(恢复会话历史回填)与 add_dir
      // (添加工作目录)不属于任务完成列表。
      if (m.role === "notice" && n && (n.kind === "bg_done" || n.kind === "bg_failed" || n.kind === "bg_stopped")) {
        out.push({ kind: n.kind, summary: n.summary });
      }
    }
    return out.reverse();
  }, [state]);
  // 主任务(claude 主对话轮)状态——任务面板首行,文案/色与 summarize 语义态一致
  // (running 青/retrying 橙/waiting 紫/idle 灰),busy 内细分 thinking/工具。
  const mainTask = retrying
    ? { label: t("claudepane.retrying", { n: retrying.attempt, max: retrying.maxAttempts }), color: "#fb923c", pulse: false }
    : hasPendingPlan || hasPendingApproval
      ? { label: t("claudepane.mainWaiting"), color: "#a78bfa", pulse: true }
      : compactRunning
        ? { label: t("claudepane.compactRunning"), color: "#a78bfa", pulse: true }
        : busy
          ? {
              label: thinkingNow
                ? t("claudepane.thinking")
                : runningTool
                  ? t("claudepane.runningTool", { tool: runningTool })
                  : t("claudepane.toolRunning"),
              color: "#22d3ee",
              pulse: true,
            }
          : { label: t("claudepane.mainIdle"), color: "#475569", pulse: false };
  /**
   * 排队的待停止后台任务(busy 期间点的):回 idle 后由下方 effect 合并成一条指令发送。
   * 不能 busy 时 interrupt——interrupt 是 kill 整个 claude 进程树(taskkill /F /T),全部后台
   * 任务都是它的子进程,会**全部连坐被杀**(实测「点一个停一个却全停」的根因)。
   */
  const [pendingKillTasks, setPendingKillTasks] = useState<
    { taskId: string; description: string }[]
  >([]);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  /** 供应商+模型整体切换的待确认项(分组下拉点模型 → 确认弹窗 → switchProviderModel)。 */
  const [pendingProviderModel, setPendingProviderModel] = useState<{ p: ClaudeProvider; m: string } | null>(null);
  const pendingKillIds = useMemo(() => new Set(pendingKillTasks.map((t) => t.taskId)), [pendingKillTasks]);
  /**
   * 停止单个后台任务。claude stdin 控制协议没有单任务 kill(实测二进制:REPL bridge 只认
   * set_model/interrupt/… 十种 subtype,interrupt 会全停+打断当前轮),官方精确路径是模型层
   * TaskStop 工具——故借道:发一条系统指令让 claude 调 TaskStop(taskId),实测 ~数秒生效,
   * 任务被杀后 `background_tasks_changed` 快照自动回流(列表消失 + stopped notice)。
   * idle 立即发;busy/compact 中不能发(后端拒)也不能 interrupt(连坐)→ 入队待 idle 合并发。
   */
  const handleKillBgTask = useCallback(
    (taskId: string, description: string) => {
      const transport = getClaudeTransportRef.current(activeTabId);
      if (!transport) return;
      setMenuMode(null);
      if (busy || compactRunning) {
        setPendingKillTasks((prev) =>
          prev.some((t) => t.taskId === taskId) ? prev : [...prev, { taskId, description }],
        );
        return;
      }
      void transport.send(t("claudepane.killTaskMsg", { id: taskId, desc: description || taskId }));
    },
    [busy, compactRunning, activeTabId, t],
  );
  // 排队的停止指令:回 idle 后合并一条发送(一次 TaskStop 多任务,省轮次)。先清队再发防重入;
  // 过滤掉排队期间已自然结束的任务(快照里已不在)。state 变化频繁(逐 token)但 guard 早退无害。
  useEffect(() => {
    if (busy || compactRunning || pendingKillTasks.length === 0) return;
    const transport = getClaudeTransportRef.current(activeTabId);
    if (!transport) {
      setPendingKillTasks([]);
      return;
    }
    const runningIds = new Set((state?.backgroundTasks ?? []).map((t) => t.taskId));
    const due = pendingKillTasks.filter((t) => runningIds.has(t.taskId));
    setPendingKillTasks([]);
    if (due.length === 0) return;
    const tasksStr = due.map((t) => `${t.description || t.taskId}(${t.taskId})`).join("、");
    void transport.send(t("claudepane.killTaskQueuedMsg", { tasks: tasksStr }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, compactRunning, pendingKillTasks, activeTabId]);
  // 弹框确认(plan/permission)出现时,若 Claude 还在跑(被拒后它会继续尝试别的工具,把 denied
  // block 移出「最后消息」会让确认框消失),自动 interrupt 让它停下等用户决策——而非一边转圈思考
  // 一边等确认。headless 单轮已退(plan)时 interrupt 幂等,无害。
  //
  // **循环保护**:interruptedForPendingRef 确保同一 pending 项只 interrupt 一次,防止死循环:
  //   handleSend busy→interrupt→send→ensureStarted(start)→init→busy→effect 再次 interrupt→...
  //   hasPendingPlan/hasPendingApproval 变为 false 时自动复位,允许下一轮再次 auto-interrupt。
  const interruptedForPendingRef = useRef(false);
  useEffect(() => {
    // 控制通道等待(can_use_tool)时 CLI 正阻塞等我们答复,interrupt 会 kill 掉这一轮、
    // 请求也一并作废 —— 只对「启发式拒绝卡」(CLI 还在跑,见上)做 auto-interrupt。
    const controlWaiting = (stateRef.current?.pendingPermissions.length ?? 0) > 0;
    if ((hasPendingPlan || hasPendingApproval) && busy && !controlWaiting && !interruptedForPendingRef.current) {
      interruptedForPendingRef.current = true;
      const transport = getClaudeTransportRef.current(activeTabId);
      void transport.interrupt();
    }
    if (!hasPendingPlan && !hasPendingApproval) {
      interruptedForPendingRef.current = false;
    }
  }, [hasPendingPlan, hasPendingApproval, busy, activeTabId]);

  // 完成通知:busy 从 true→false(一轮完成,且非 plan/approval 等待)且窗口未聚焦时,
  // 发桌面通知(浏览器 Notification API;WebView2 通常支持,若不弹需换 tauri-plugin-notification)。
  const prevNotifBusyRef = useRef(false);
  useEffect(() => {
    const justFinished = prevNotifBusyRef.current && !busy;
    prevNotifBusyRef.current = busy;
    if (!justFinished || hasPendingPlan || hasPendingApproval) return;
    if (typeof Notification === "undefined" || document.hasFocus()) return;
    try {
      if (Notification.permission === "granted") {
        new Notification(t("claudepane.notifTitle"), { body: t("claudepane.notifBody") });
      } else if (Notification.permission !== "denied") {
        void Notification.requestPermission();
      }
    } catch {
      /* 通知不可用,忽略 */
    }
  }, [busy, hasPendingPlan, hasPendingApproval, t]);

  return (
    <article
      ref={paneBoxRef}
      className={`grid h-full min-h-0 min-w-0 grid-rows-[length:var(--mx-paneheader-h)_1fr] overflow-hidden bg-[var(--mx-editor-bg)] ${className ?? ""}`}
      onMouseDown={() => onFocusPane?.(paneId)}
    >
      {/* header:tab 条 + 右侧按钮组(+ 新 tab / ▥ 分屏 / × 关 pane),与 TerminalPane/SessionBrowserPane 同构。 */}
      <header
        className={`flex min-w-0 shrink-0 items-center justify-between gap-2 px-2 text-xs transition-colors ${
          "bg-[var(--mx-tabbar-bg)]"
        }`}
      >
        <Tabs value={activeTabId} onValueChange={(id) => onSetActiveTab?.(paneId, id)}>
          <TabsList className="mx-tabs-list flex min-w-0 items-center gap-0 overflow-x-auto [&::-webkit-scrollbar]:hidden">
            {sessions.map((s) => {
              const isActive = s.id === activeTabId;
              return (
                <ClaudeTabChip
                  key={s.id}
                  session={s}
                  isActive={isActive}
                  showClose={sessions.length > 1 && !!onCloseTab}
                  paneId={paneId}
                  getClaudeTransport={getClaudeTransportStable}
                  shellRunning={isActive && shellRunning}
                  resolvedApprovals={resolvedApprovals}
                  onCloseTab={onCloseTabStable}
                />
              );
            })}
          </TabsList>
        </Tabs>
        <div className="flex shrink-0 items-center gap-1 text-[var(--mx-muted)]">
          {/* ⋯ 工具菜单:skills/mcp/plugins 等资源查看 + 会话动作(compact/rewind 等,承接原 / 面板入口)。 */}
          <PaneToolsMenu groups={toolsMenuGroups} tooltip={t("claudepane.toolsTooltip")} />
          {/* ◱ 展开/还原所在分屏比例(主体 pane 占大头;单 pane 项目 AppShell no-op)。
              展开态图标/文案切换(◱ 展开 / ◫ 还原),状态真身在 AppShell 展开记忆。 */}
          {onToggleExpand && <PaneExpandButton expanded={expanded} onToggle={onToggleExpand} t={t} />}
          {/* 重置当前会话:清屏 + kill 进程 + 用 registry live id --resume 重启(session 续接)。 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-[14px] text-[var(--mx-muted)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  void getClaudeTransportRef.current(activeTabId)?.resetSession();
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
                  {/* 快捷恢复:当前项目最近一条 claude 历史会话(弹窗打开时懒拉,点击直接 resume)。 */}
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

      {/* 主体行:对话区(flex-1:消息流 + 输入区)+ 宽 pane 工具侧栏(Skills/MCP/Plugins 常驻)。
          relative 供缩小态悬浮小竖条定位。 */}
      <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* 对话区:消息流(上,flex-1 滚动) + 底部浮动输入区(下)。 */}
      <div className="relative grid min-h-0 min-w-0 flex-1 grid-rows-[1fr_auto]">
        {/* overflow-x-hidden:消息流只纵向滚动。内含 markdown(压缩总结等)时,任何宽度计算
            意外(长路径串/代码块 min-content)都会让 overflow-x 被 UA 计算成 auto,底部冒横向
            滚动条;横向阅读需求由 pre/表格各自的内部滚动承担,故这里直接钳掉。 */}
        <div ref={scrollRef} onScroll={handleScroll} className="mx-scroll-pretty relative min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4" style={{ fontSize }}>
          {state && (state.messages.length > 0 || (shellState?.messages.length ?? 0) > 0) ? (
            <div ref={contentRef} className="mx-auto w-full max-w-[54.25rem] space-y-1">
              {/* C5 会话头:会话开端信息(品牌块 + 模型 + session 尾部 + 窗口),让会话有"开端感"。
                  本分支已在 hasMessages 守卫内(mergedMessages 必非空),只需 meta 有模型/会话 id 其一。
                  窗口截断(msgOffset>0)时隐藏——它之上还有更早消息,不是"开端"。 */}
              {msgOffset === 0 && state?.meta && (state.meta.model || state.meta.claudeSessionId) && (
                <SessionHeader
                  brandLetter="C"
                  brandClass="bg-[var(--mx-claude)] text-white"
                  name="Claude"
                  model={state.meta.model}
                  sessionId={state.meta.claudeSessionId}
                  contextWindow={state.meta.contextWindow}
                />
              )}
              {msgSentinel}
              {visibleMessages.map((item, i) => {
                // 全量下标(fold 索引表按 mergedMessages 全量坐标工作)。
                const gi = i + msgOffset;
                // 相邻消息间隔超阈值(30 分钟)插时间分隔线:长会话的时间断层一眼可辨。
                // timestamp 可空且串/数字并存(claude ISO 串,`!` shell 消息 epoch ms),空值不参与比较。
                const ts = item.msg.timestamp;
                const prevTs = i > 0 ? visibleMessages[i - 1].msg.timestamp : null;
                const gapTs =
                  ts != null && prevTs != null && messageTimeMs(ts) - messageTimeMs(prevTs) > MESSAGE_GAP_MS ? ts : null;
                // P2.1/P2.2 — 折叠渲染(两层渐进,baoocode rowAt 同构):
                //  ① 该行是 work fold 段首 → 渲染 work 折叠行;work 未展开时段内其余行隐藏;
                //     展开 → 段内行继续判定 steps
                //  ② 该行是 steps fold 段首(work 展开时)→ 渲染 steps 折叠行;未展开 → 段内其余行隐藏
                //  ③ 无归属 → 正常渲染
                const foldRow = foldRowByItemIndex[gi] ?? null;
                const workFold = foldRow?.work ?? null;
                const stepsFold = foldRow?.steps ?? null;
                const ci = claudeIndexByMerged[gi] ?? -1;
                const isStepsStart = stepsFold != null && stepsFold.start === ci;
                // 本消息是 work fold 的答案(fold.end+1 = 答案下标,答案行不在段内、work 字段为
                // null,走 workFoldByAnswer 反查):卡片内部第一个块渲染「已处理…」摘要行,点击
                // **就地展开** —— 段内步骤渲染在摘要行下方(向下生长,收起点始终在内容首行,
                // BaoCode Column[WorkFoldLine, items] 的卡片内翻版),不再在消息流原位展开。
                const answerWorkFold = workFoldByAnswer.get(ci) ?? null;
                // work 段内行一律不在消息流渲染(折叠/展开都由答案卡片内部承载)。
                if (workFold != null) return null;
                // 展开的 steps fold 段内(非段首,仅非 work 区的 steps):命令恒显命令原文 ——
                // 展开「运行了 N 条命令」即读到全部执行过的命令(用户反馈)。
                const stepsOpen = stepsFold != null && openFolds.has(stepsFoldKey(stepsFold));
                const foldExpanded = stepsFold != null && !isStepsStart && stepsOpen;
                // steps 折叠中:段首渲染折叠行,段内其余行隐藏(work 展开体同构;漏了这行
                // 折叠时段内内容仍全可见,折叠只剩标题语义)。
                if (stepsFold != null && !isStepsStart && !stepsOpen) return null;
                if (isStepsStart) {
                  return (
                    <Fragment key={`fold-${i}`}>
                      {gapTs != null && <TimeGapDivider timestamp={gapTs} />}
                      <div className="mx-chat-row">
                        <StepFoldRow
                          fold={stepsFold}
                          messages={claudeMessagesForFolds}
                          t={t}
                          open={stepsOpen}
                          onToggle={() => toggleFold(stepsFoldKey(stepsFold))}
                        />
                      </div>
                    </Fragment>
                  );
                }
                return (
                  <Fragment key={item.kind === "shell" ? `shell-${item.msg.id}` : item.msg.id}>
                    {gapTs != null && <TimeGapDivider timestamp={gapTs} />}
                    {item.kind === "shell" ? (
                      <div className="mx-chat-row">
                        <ShellRow message={item.msg} t={t} onInterrupt={handleShellInterrupt} />
                      </div>
                    ) : (
                      <div
                        className="mx-chat-row"
                        ref={item.msg.id === currentPrompt?.id ? currentPromptStick.promptRef : undefined}
                      >
                        <MessageRow
                          message={item.msg}
                          t={t}
                          onApprovePlan={handleApprovePlan}
                          onReject={handleReject}
                          resolvedApprovals={resolvedApprovals}
                          onApproveTool={handleApproveTool}
                          onRejectTool={handleRejectTool}
                          onFeedback={handleFeedback}
                          onResend={resendText}
                          approvalActiveId={activeApprovalId}
                          approvalActiveIdx={
                            activeApprovalId !== null &&
                            item.msg.role === "assistant" &&
                            item.msg.blocks.some((b) => b.type === "tool_use" && b.id === activeApprovalId)
                              ? approvalFocusIdx
                              : -1
                          }
                          contextWindow={state?.meta.contextWindow ?? inferContextWindow(model)}
                          bashCommandOpen={foldExpanded}
                          workFold={answerWorkFold ?? undefined}
                          workFoldOpen={answerWorkFold != null && openFolds.has(workFoldKey(answerWorkFold))}
                          onToggleWorkFold={toggleWorkFold}
                          foldMessages={claudeMessagesForFolds}
                          foldRows={foldMap.rows}
                          openFoldKeys={openFolds}
                          toggleFoldByKey={toggleFold}
                        />
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          ) : (
            // 品牌化空状态(会话未开始):大品牌块 + 名称 + (已知时)模型 + 引导文案,
            // 替代原先一行灰字——AI 主体叙事从空状态开始;probe/加载中保持轻量占位。
            <div className="grid h-full place-items-center">
              {state ? (
                <div className="flex flex-col items-center gap-2.5 py-10">
                  <span aria-hidden className="grid h-10 w-10 place-items-center rounded-full bg-[var(--mx-claude)] text-sm font-extrabold text-white shadow-lg">
                    C
                  </span>
                  <span className="text-xs text-[var(--mx-muted)]">
                    Claude{state.meta?.model ? <span className="font-mono"> · {state.meta.model}</span> : null}
                  </span>
                  <span className="text-xs text-[var(--mx-faint)]">{t("claudepane.empty")}</span>
                </div>
              ) : probeDone ? (
                <div className="text-xs text-[var(--mx-faint)]">{t("claudepane.loading")}</div>
              ) : (
                <div className="text-xs text-[var(--mx-faint)]">…</div>
              )}
            </div>
          )}
          {/* 回到底部按钮:仅用户上滚离开底部时显示(showScrollBottom),点击滚到底并恢复贴底。
              sticky 浮于消息流右下(滚动容器内),absolute 会被裁剪。 */}
          {showScrollBottom && (
            <button
              type="button"
              aria-label={t("claudepane.scrollToBottom")}
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

        {showPromptBanner && currentPrompt && currentPromptStick.detached && (
          <CurrentPromptBanner
            text={currentPrompt.text}
            expanded={currentPromptStick.expanded}
            onToggle={() => currentPromptStick.setExpanded((v) => !v)}
          />
        )}

        {/* 底部浮动输入区:状态行 + textarea + 发送/中断按钮。 */}
        <div className="shrink-0 px-4 pb-3 pt-1">
          <div className="mx-auto w-full max-w-[54.25rem]">
            {/* 会话状态指示行:retrying(API error 自动重试,最高优先,橙色告警)> compactRunning >
                thinkingNow 思考中 > busy 执行中(不显示具体工具名,只显「执行中…」)。悬浮在输入框上方,
                busy 全程可见 -- 此前仅思考阶段显示,长工具运行中用户无从察觉会话仍在进行。
                retrying 期间 status 被覆写 running 维持 busy,中断按钮可用;idle → 此条消失。
                文字一律 muted(高饱和品牌色整行显示:深主题刺眼/亮主题对比不足看不清),
                色彩语义由 ThinkingDots 呼吸点承载;仅 retrying 保留 warning 橙(短暂告警态)。 */}
            {(retrying || busy || compactRunning) && !hasPendingPlan && !hasPendingApproval && (
              <div
                className={`mb-1.5 flex items-center gap-2 px-1 ${
                  retrying ? "text-[var(--mx-warning)]" : "text-[var(--mx-muted)]"
                }`}
                style={{ fontSize: statusFontPx }}
              >
                <ThinkingDots />
                <span>
                  {retrying
                    ? t("claudepane.retrying", { n: retrying.attempt, max: retrying.maxAttempts })
                    : compactRunning
                      ? t("claudepane.compactRunning")
                      : thinkingNow
                        ? t("claudepane.thinking")
                        : t("claudepane.toolRunning")}
                </span>
                <span className="tabular-nums text-[var(--mx-faint)]">
                  <ElapsedText start={turnStart} prefix="⏱ " />　↑{formatTokens(turnTokens.input)} ↓{formatTokens(turnTokens.output)}
                </span>
                {/* busy 期间的后台任务入口:琥珀徽标点开任务面板(主任务正显示在左侧,bgCount>0 才显)。
                    与非 busy 琥珀行共用 menuMode==="tasks" 与 TaskListContent(busy 与非 busy 互斥渲染,不冲突)。 */}
                {bgCount > 0 && (
                  <Popover open={menuMode === "tasks"} onOpenChange={(o) => setMenuMode(o ? "tasks" : null)}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        onMouseDown={(e) => e.stopPropagation()}
                        className="flex shrink-0 items-center gap-1 rounded bg-[var(--mx-border)] px-1.5 py-0.5 text-[10px] text-[#fbbf24] transition-colors hover:bg-[var(--mx-hover-bg)]"
                      >
                        <span aria-hidden className="h-1 w-1 animate-pulse rounded-full bg-[#fbbf24]" />
                        {t("claudepane.bgCountBadge", { n: bgCount })}
                      </button>
                    </PopoverTrigger>
                    {menuMode === "tasks" && (
                      <PopoverContent
                        side="top"
                        align="end"
                        sideOffset={4}
                        onOpenAutoFocus={(e) => e.preventDefault()}
                        className="mx-menu w-[340px] max-w-[calc(100vw-2rem)] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
                      >
                        <TaskListContent t={t} main={mainTask} bgTasks={state?.backgroundTasks ?? []} doneNotices={bgDoneNotices} onKillTask={handleKillBgTask} pendingKillIds={pendingKillIds} />
                      </PopoverContent>
                    )}
                  </Popover>
                )}
              </div>
            )}
            {/* 后台任务状态行:本轮已结束(非 busy/非等待确认)、可继续对话,但有 N 个后台任务在跑
                (Bash run_in_background / 后台 subagent,`background_tasks_changed` 快照驱动)。
                琥珀色与「执行中」青色区分;busy 时被上方状态行盖住,turn 结束后透出。
                整行可点击 → 任务面板 Popover(主任务 + 后台任务列表 + 最近完成)。 */}
            {!retrying && !busy && !compactRunning && !hasPendingPlan && !hasPendingApproval && bgCount > 0 && (
              <Popover open={menuMode === "tasks"} onOpenChange={(o) => setMenuMode(o ? "tasks" : null)}>
                <PopoverTrigger asChild>
                  <div
                    className="mb-1.5 flex w-fit cursor-pointer items-center gap-2 rounded px-1 text-[11px] text-[var(--mx-warning)] transition-colors hover:bg-[var(--mx-border)]"
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--mx-warning)]" />
                    <span>{t("claudepane.bgTasks", { n: bgCount })}</span>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                      <path d="M6 15l6-6 6 6" />
                    </svg>
                  </div>
                </PopoverTrigger>
                {menuMode === "tasks" && (
                  <PopoverContent
                    side="top"
                    align="start"
                    sideOffset={4}
                    onOpenAutoFocus={(e) => e.preventDefault()}
                    className="mx-menu w-[340px] max-w-[calc(100vw-2rem)] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
                  >
                    <TaskListContent t={t} main={mainTask} bgTasks={state?.backgroundTasks ?? []} doneNotices={bgDoneNotices} onKillTask={handleKillBgTask} pendingKillIds={pendingKillIds} />
                  </PopoverContent>
                )}
              </Popover>
            )}
            {/* can_use_tool 审批坞:控制通道待批请求固定挂在输入框上方 —— 不依赖消息流渲染,
                折叠/上翻滚动都丢不了卡(内联卡曾因此「没有选择框」,用户实测)。坞卡直接持
                requestId 回包,连 tool_use_id 与 block 的配对都不依赖;待批期间折叠整体暂停
                (foldMap live 合成),消息流保持展开。决策后 transport 乐观移除 pending,坞自动消失。 */}
            {state != null && state.pendingPermissions.length > 0 && (
              <div className="mb-1.5 flex min-w-0 flex-col gap-1.5">
                {state.pendingPermissions.map((p, permIdx) => {
                  const config = getToolConfig(p.toolName);
                  const title = config.label ?? p.displayName ?? p.toolName;
                  const cmdValue = config.getValue?.(p.input) ?? "";
                  const detail = cmdValue ? (
                    <pre className="mx-scroll max-h-24 min-w-0 overflow-auto break-all rounded bg-[var(--mx-bg-soft)] px-2 py-1 text-[11px] text-[var(--mx-muted)]">
                      <code>{cmdValue}</code>
                    </pre>
                  ) : null;
                  const approvalRequest: import("../domain/interactive").InteractiveRequest = {
                    kind: "approval",
                    id: p.requestId,
                    title,
                    steps: [
                      {
                        prompt: "",
                        header: title,
                        detail,
                        rows: [
                          { label: t("interactive.allowOnce") },
                          { label: "__allowAlways__" },
                          { label: "__deny__" },
                        ],
                      },
                    ],
                  };
                  return (
                    <div key={p.requestId} className="mx-dock-in" style={{ animationDelay: `${permIdx * 45}ms` }}>
                    <InteractivePanel
                      request={approvalRequest}
                      t={t}
                      alwaysAllowLabel={deriveAlwaysAllowLabel(p.toolName, config.label) ?? undefined}
                      externalHighlight={
                        activeApprovalId !== null && p.toolUseId === activeApprovalId ? approvalFocusIdx : undefined
                      }
                      noAutoFocus
                      onAnswer={(ans) => {
                        if (ans.kind !== "approval") return;
                        const transport = getClaudeTransportRef.current(activeTabId);
                        if (ans.decision === "allow") {
                          void transport.respondPermission(p.requestId, "allow", { input: p.input });
                        } else if (ans.decision === "allowAlways") {
                          // 批准且不再问:allowlist 落盘(下次 spawn 免问),当轮照常 allow。
                          transport.persistAllowedTool(p.toolName);
                          void transport.respondPermission(p.requestId, "allow", { input: p.input });
                        } else {
                          void transport.respondPermission(p.requestId, "deny", { message: ans.message });
                        }
                      }}
                    />
                    </div>
                  );
                })}
              </div>
            )}
            {claudeMissing ? (
              /* 未安装提示卡片(不进全局模态,本组件内渲染)。 */
              <div className="mx-chip flex flex-col gap-2 border border-[var(--mx-danger-border)] bg-[var(--mx-danger-bg)] px-3 py-3 text-[11px] text-[var(--mx-text)]">
                <div className="flex items-center gap-2 font-[600] text-[var(--mx-danger-bright)]">
                  <IconWarn />
                  {t("claudepane.notInstalled")}
                </div>
                <code className="mx-scroll-pretty rounded bg-[var(--mx-bg)] px-2 py-1 font-mono text-[10px] text-[var(--mx-muted)]">
                  {t("claudepane.installCmd")}
                </code>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="self-start text-[10px] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
                  onClick={() => {
                    setClaudeMissing(false);
                    setProbeDone(false);
                    invoke<Record<string, boolean>>("check_commands_installed", { commands: ["claude"] })
                      .then((r) => {
                        setClaudeMissing(!r["claude"]);
                        setProbeDone(true);
                      })
                      .catch(() => setProbeDone(true));
                  }}
                >
                  {t("claudepane.retry")}
                </Button>
              </div>
            ) : (
              <Popover open={(atOpen && atMatches.length > 0) || (cmdOpen && cmdMatches.length > 0)}>
                <PopoverAnchor asChild>
                  <div className="mx-chip flex flex-col rounded-[var(--mx-radius-lg)] border border-[var(--mx-border)] bg-[var(--mx-card-bg)] px-3 py-2 shadow-lg focus-within:border-[var(--mx-accent)]">
                    <div className="flex items-end gap-2">
                    <div className="relative min-w-0 flex-1">
                      <textarea
                      ref={inputRef}
                      value={input}
                      onChange={handleInputChange}
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
                        // 待确认权限卡键盘流(见 activeApproval 注释):空输入 + 面板全关时
                        // ←→ 移动卡上高亮、Enter 触发(空输入 Enter 本就无操作,拦截无损失;
                        // ←→ 在空文本域里也无光标语义)。
                        if (
                          activeApprovalId !== null &&
                          !input.trim() &&
                          !atOpen &&
                          !e.nativeEvent.isComposing
                        ) {
                          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                            e.preventDefault();
                            setApprovalFocusIdx((i) => (e.key === "ArrowRight" ? (i + 1) % 4 : (i + 3) % 4));
                            return;
                          }
                          if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
                            e.preventDefault();
                            triggerApprovalAction(approvalFocusIdx);
                            return;
                          }
                        }
                        // ↑/↓ 浏览输入历史(类 shell 命令历史):@ 面板关闭 + 非 IME 组合输入时;
                        // 仅当光标在首行拦 ↑、末行拦 ↓(否则放行让光标在多行文本里正常上下移动)。
                        if (!atOpen && !e.nativeEvent.isComposing && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
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
                        // / 命令面板(#131):↑↓ 导航 + Tab 补全 + Enter 执行 + Esc 关(与 @ 面板互斥,同范式)。
                        if (cmdOpen && cmdMatches.length > 0) {
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setCmdIndex((i) => (i < cmdMatches.length - 1 ? i + 1 : 0));
                            return;
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setCmdIndex((i) => (i > 0 ? i - 1 : cmdMatches.length - 1));
                            return;
                          }
                          if (e.key === "Tab" && !e.shiftKey && !e.nativeEvent.isComposing) {
                            // 补全:takesArg 补 "/cmd "(带参数位,含空格面板即关,setInput 不走 onChange 须手动关);
                            // 无参补全命令名(仍无空格,面板保持开,Enter 即执行)。
                            e.preventDefault();
                            const d = cmdMatches[cmdIndex] ?? cmdMatches[0];
                            if (d) {
                              if (d.takesArg) {
                                setInput(`${d.name} `);
                                setCmdOpen(false);
                              } else {
                                setInput(d.name);
                              }
                            }
                            return;
                          }
                          if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            const d = cmdMatches[cmdIndex] ?? cmdMatches[0];
                            setInput("");
                            setCmdOpen(false);
                            if (d) void runSlash(d, "");
                            return;
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setCmdOpen(false);
                            return;
                          }
                        }
                        // @ 文件引用面板:↑↓ 导航 + Enter/Tab 选中插入 + Esc 关。
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
                        // Shift+Tab 循环切换权限模式(acceptEdits/plan/manual/bypassPermissions)。
                        if (e.key === "Tab" && e.shiftKey) {
                          e.preventDefault();
                          cycleMode();
                          return;
                        }
                        // 回车发送(无 Shift/Alt)、Shift+Enter 或 Alt+Enter 换行。IME 组合输入中不触发(防打断中文输入)。
                        // 发送守卫与 canSend 同源:claudeMissing/compactRunning/shellRunning 时拦 Enter
                        // (仅按钮 disabled 拦不住键盘;busy 不拦--handleSend 会先 interrupt 再发,
                        // 与 claude 对话路径语义一致;shellRunning 拦--! 命令与 claude 对话串行,
                        // 防「shell 还在跑又发第二条消息」致状态药丸看起来不准)。
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !claudeMissing && !compactRunning && !shellRunning) {
                          e.preventDefault();
                          handleSend();
                        }
                      }}
                      rows={2}
                      placeholder={t("claudepane.inputHint")}
                      /* field-sizing-content:随内容在 min-h~max-h 间自动长高,超高才内部滚动(滚轮仍可滚);
                         滚动条隐藏而非美化:占宽会让 textarea 换行窄于 inset-0 高亮层,chip 背景与文字错行。 */
                      className="relative max-h-[160px] min-h-[36px] w-full field-sizing-content resize-none bg-transparent p-0 font-mono caret-[var(--mx-text)] text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                      style={{ fontSize, lineHeight: "1.5" }}
                    />
                    </div>
                    {/* 按钮:busy 且无输入→中断;否则→发送(busy 时发送会自动中断续接)。双击 Esc 亦可中断。 */}
                    {busy && !input.trim() ? (
                      <button
                        type="button"
                        aria-label={t("claudepane.interrupt")}
                        onClick={handleInterrupt}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--mx-danger-bright)] transition-colors hover:bg-[var(--mx-danger-bg)] hover:text-[var(--mx-danger)]"
                      >
                        <IconStop />
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={t("claudepane.send")}
                        onClick={handleSend}
                        disabled={!canSend}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-accent-soft)] hover:text-[var(--mx-accent)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--mx-muted)]"
                      >
                        <IconSend />
                      </button>
                    )}
                    </div>
                    {/* 卡片内底部状态栏:思考反馈 + 权限 + 模型 + effort + tokens + 时长(左对齐,busy 时也显示)。
                        ctx% 已移至全局 StatusBar(避免重复),effort 从全局 StatusBar 移此(每 tab 独立切换)。
                        颜色提到 mx-muted(原 mx-faint 偏暗),让 tokens/时长/cost 等次要信息更可读。
                        字号随全局 fontSize 缩放(statusFontSize,14→10 与原 text-[10px] 一致)。 */}
                    <div
                      className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-[var(--mx-border)] pt-1.5 tabular-nums text-[var(--mx-muted)]"
                      style={{ fontSize: statusFontPx }}
                    >
                      {state?.terminatedReason ? (
                        <span className="shrink-0 text-[var(--mx-danger)]">{t("claudepane.terminated")}</span>
                      ) : hasPendingPlan ? (
                        <span className="flex shrink-0 items-center gap-1.5 font-medium text-[var(--mx-violet)]">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <rect x="6" y="5" width="3.5" height="14" rx="1" />
                            <rect x="14.5" y="5" width="3.5" height="14" rx="1" />
                          </svg>
                          <span>{t("claudepane.planWaiting")}</span>
                        </span>
                      ) : hasPendingApproval ? (
                        <span className="flex shrink-0 items-center gap-1.5 font-medium text-[var(--mx-warning)]">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <path d="M12 9v4M12 17h.01" />
                          </svg>
                          <span>{t("claudepane.approvalWaiting")}</span>
                        </span>
                      ) : null}
                      {/* 权限模式:acceptEdits/plan/manual/bypassPermissions,点击切换,Shift+Tab 循环。 */}
                      <Popover open={menuMode === "perm"} onOpenChange={(o) => setMenuMode(o ? "perm" : null)}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            onMouseDown={(e) => e.stopPropagation()}
                            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[var(--mx-text)] transition-colors hover:bg-[var(--mx-border)]"
                            title={currentModeMeta.desc}
                          >
                            <span
                              className={
                                mode === "plan"
                                  ? "text-[var(--mx-violet)]"
                                  : mode === "bypassPermissions"
                                    ? "text-[var(--mx-danger-bright)]"
                                    : "text-[var(--mx-success)]"
                              }
                            >
                              {currentModeMeta.label}
                            </span>
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </button>
                        </PopoverTrigger>
                        {menuMode === "perm" && (
                          <PopoverContent
                            side="top"
                            align="start"
                            sideOffset={4}
                            onOpenAutoFocus={(e) => e.preventDefault()}
                            className="mx-menu w-[330px] max-w-[calc(100vw-2rem)] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
                          >
                            {PERMISSION_MODES.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={() => setMode(m.id)}
                                className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                                  m.id === mode
                                    ? "bg-[var(--mx-selected-bg)] text-[var(--mx-text)]"
                                    : "text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                                }`}
                              >
                                <span className="w-32 shrink-0 whitespace-nowrap font-mono text-[11px] font-semibold">{m.label}</span>
                                <span className="text-[10px] leading-tight">{m.desc}</span>
                              </button>
                            ))}
                          </PopoverContent>
                        )}
                      </Popover>
                      {/* model:点击上拉选择器(--model flag 重启进程生效,--resume 保留 session)。
                          选模型 id -> applyModel;重启后 init 回填真实 model 经状态栏反映。 */}
                      <Popover open={menuMode === "model"} onOpenChange={(o) => {
                        setMenuMode(o ? "model" : null);
                        if (!o) return;
                        // 每次打开,两种形态:
                        // A. 配了供应商(设置中心) → 下拉按供应商分组:供应商一级目录,组内只挂
                        //    该家**已配置**的模型(configuredModelsOf;全目录不进下拉,要配去设置
                        //    中心)。点模型 = 整体切换(端点+token+*_MODEL 一并写 env,确认后广播重启拾取)。
                        // B. 没配供应商 → 现有平铺:env 别名(list_claude_models,瞬时)+
                        //    当前生效端点目录(list_claude_catalog_models,4s 超时降级)归并。
                        setAvailableModels([]);
                        setModelQuery("");
                        const provs = loadClaudeProviders();
                        refreshProviders();
                        if (provs.length === 0) {
                          void invoke<string[]>("list_claude_models")
                            .then((envList) => {
                              setAvailableModels((prev) => {
                                const seen = new Set(envList);
                                return [...envList, ...prev.filter((m) => !seen.has(m))];
                              });
                            })
                            .catch(() => {});
                          void invoke<string[]>("list_claude_catalog_models")
                            .then((catalog) => {
                              if (!catalog?.length) return;
                              setAvailableModels((prev) => {
                                const seen = new Set(prev);
                                return [...prev, ...catalog.filter((m) => !seen.has(m))];
                              });
                            })
                            .catch(() => {});
                        }
                        // env 若变了(cc-switch 切供应商),重启长进程拾取新配置。
                        void getClaudeTransportRef.current(activeTabId)?.refreshIfSettingsChanged();
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
                            className="mx-menu w-[260px] max-w-[calc(100vw-2rem)] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
                          >
                            {/* 当前模型(仿 claude /model:先展示当前实际跑的 model 完整 id;代理把别名
                                全映射到 GLM 时,预置项均不高亮,此行是「当前」的权威展示)。 */}
                            <div className="flex items-center gap-2 rounded px-2 py-1.5 text-[var(--mx-text)]">
                              <span className="w-14 shrink-0 font-mono text-[10px] font-semibold text-[var(--mx-accent)]">{t("claudepane.modelCurrent")}</span>
                              {/* 与勾选同一真源(env 的 ANTHROPIC_MODEL 优先):切完模型会话未重启时
                                  meta.model 还是旧值,这里用 model 会显示成「没切过去」。 */}
                              <span className="flex-1 truncate font-mono text-[11px]" title={activeModelName}>{activeModelName || "-"}</span>
                            </div>
                            <div className="mx-1 mb-1 border-t border-[var(--mx-border)]" />
                            {providers.length > 0 ? (
                              /* 供应商分组形态:一级目录=设置里配置的供应商(当前生效家组头
                                 accent 标记),组内**只列已配置**的模型(全目录不进下拉,要配
                                 别的去设置中心);点模型弹确认整体切换。 */
                              <>
                                {providerGroups.reduce((n, g) => n + g.configured.length, 0) > 8 && (
                                  <input
                                    autoFocus
                                    value={modelQuery}
                                    onChange={(e) => setModelQuery(e.target.value)}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    placeholder={t("claudepane.modelFilterPlaceholder")}
                                    className="mb-1 w-full rounded-[var(--mx-radius-sm)] border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2 py-1 font-mono text-[11px] text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)] focus-visible:border-[var(--mx-accent)]"
                                  />
                                )}
                                <div className="mx-scroll-pretty max-h-[min(50vh,360px)] overflow-y-auto">
                                  {providerGroups.map((g) => (
                                    <div key={g.p.id}>
                                      <div
                                        className={`flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide ${
                                          g.active ? "text-[var(--mx-accent)]" : "text-[var(--mx-faint)]"
                                        }`}
                                        title={g.p.baseUrl}
                                      >
                                        <span className="min-w-0 flex-1 truncate">{g.p.name}</span>
                                        {g.active && <span aria-hidden>●</span>}
                                      </div>
                                      {g.configured.map((m) => renderProviderModelRow(g, m))}
                                      {g.configured.length === 0 && (
                                        <div className="px-2 py-1 text-[10px] text-[var(--mx-faint)]">
                                          {t("claudepane.providerNoModels")}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </>
                            ) : (
                            <>
                            {availableModels.length > 8 && (
                              <input
                                autoFocus
                                value={modelQuery}
                                onChange={(e) => setModelQuery(e.target.value)}
                                onMouseDown={(e) => e.stopPropagation()}
                                placeholder={t("claudepane.modelFilterPlaceholder")}
                                className="mb-1 w-full rounded-[var(--mx-radius-sm)] border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2 py-1 font-mono text-[11px] text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)] focus-visible:border-[var(--mx-accent)]"
                              />
                            )}
                            {availableModels.length === 0 ? (
                              <div className="px-2 py-1.5 text-[10px] text-[var(--mx-faint)]">
                                {t("claudepane.modelEmpty")}
                              </div>
                            ) : filteredModels.length === 0 ? (
                              <div className="px-2 py-1.5 text-[10px] text-[var(--mx-faint)]">
                                {t("claudepane.modelNoMatch")}
                              </div>
                            ) : (
                              // 完整列表(可能上百条):限高滚动,不把 popover 撑出屏幕。
                              <div className="mx-scroll-pretty max-h-[min(50vh,360px)] overflow-y-auto">
                              {filteredModels.map((m) => {
                                // 单一真源(同分组分支):alias 与 model 双来源会让代理映射后
                                // 的两个模型同时打勾。
                                const active = m === activeModelName;
                                return (
                                  <button
                                    key={m}
                                    type="button"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={() => {
                                      // 与供应商分组分支同款:点选即收下拉,只留确认弹窗
                                      //(原先 popover 不关,确认完列表还糊在屏上)。
                                      setMenuMode(null);
                                      setPendingModel(m);
                                    }}
                                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                                      active
                                        ? "bg-[var(--mx-selected-bg)] text-[var(--mx-text)]"
                                        : "text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                                    }`}
                                  >
                                    <span className="flex-1 truncate font-mono text-[11px] font-semibold" title={m}>{m}</span>
                                    {active && (
                                      <svg className="h-3 w-3 shrink-0 text-[var(--mx-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                                        <path d="M5 13l4 4L19 7" />
                                      </svg>
                                    )}
                                  </button>
                                );
                              })}
                              </div>
                            )}
                            </>
                            )}
                          </PopoverContent>
                        )}
                      </Popover>
                      {/* effort:reasoning 强度(claude --effort),auto=不传 flag。原在全局 StatusBar,
                          移此与 model/perm 并列--每 tab 独立,setEffort 下轮生效不打断当前轮。 */}
                      <Popover open={menuMode === "effort"} onOpenChange={(o) => setMenuMode(o ? "effort" : null)}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            onMouseDown={(e) => e.stopPropagation()}
                            className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
                            title={t("statusbar.effort")}
                          >
                            <span aria-hidden>⚡</span>
                            <span>{state?.meta?.effort ?? "auto"}</span>
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </button>
                        </PopoverTrigger>
                        {menuMode === "effort" && (
                          <PopoverContent
                            side="top"
                            align="start"
                            sideOffset={4}
                            onOpenAutoFocus={(e) => e.preventDefault()}
                            className="mx-menu w-[150px] max-w-[calc(100vw-2rem)] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
                          >
                            {EFFORT_LEVELS.map((l) => {
                              const cur = state?.meta?.effort ?? "auto";
                              const active = l.value === cur;
                              return (
                                <button
                                  key={l.value}
                                  type="button"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={() => applyEffort(l.value)}
                                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors ${
                                    active
                                      ? "bg-[var(--mx-selected-bg)] text-[var(--mx-text)]"
                                      : "text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                                  }`}
                                >
                                  <span className="w-12 shrink-0 font-mono font-semibold">{l.label}</span>
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
                      {/* ctx 迷你仪表:进度条=占用、分数=已用/窗口,阈值着色提示该 /compact;
                          hover 看剩余/百分比明细;点击弹上下文详情(与消息 footer chip 同一弹窗)。
                          全局 StatusBar 已移除 ctx,此为每 tab 唯一显示。 */}
                      {contextInfo && (
                        <ContextMeter
                          used={contextInfo.ctx}
                          window={contextInfo.window}
                          usage={ctxDetailSource}
                          authoritative={state?.meta?.contextUsage}
                          t={t}
                        />
                      )}
                      <span className="shrink-0">
                        ↑{formatTokens(turnTokens.input)} ↓{formatTokens(turnTokens.output)}
                      </span>
                      <span className="shrink-0 whitespace-nowrap"><ElapsedText start={sessionStart} prefix="⏱ " /></span>
                      <span className="shrink-0 tabular-nums" title="本会话累计成本(估算)">{formatCost(state?.lastResult?.totalCostUsd)}</span>
                    </div>
                  </div>
                </PopoverAnchor>
                <PopoverContent
                  side="top"
                  align="start"
                  sideOffset={6}
                  // 关键:阻止 Radix 打开时把焦点抢到 Content(否则 textarea 失焦,
                  // ↑↓/Enter/Tab 的 onKeyDown 不再触发,键盘导航失效)。这是 Radix 把
                  // Popover 当 combobox 锚定到输入框时的标准修法——保持焦点在 textarea。
                  onOpenAutoFocus={(e) => e.preventDefault()}
                  onCloseAutoFocus={(e) => e.preventDefault()}
                  className="mx-menu w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1.5 shadow-xl"
                >
                  <div className="mx-scroll-pretty max-h-[min(50vh,420px)] overflow-y-auto p-0.5">
                  {cmdOpen && cmdMatches.length > 0
                    ? cmdMatches.map((c, i) => (
                        <button
                          key={c.name}
                          type="button"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => {
                            setInput("");
                            setCmdOpen(false);
                            void runSlash(c, "");
                          }}
                          onMouseEnter={() => setCmdIndex(i)}
                          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors ${i === cmdIndex ? "bg-[var(--mx-selected-bg)]" : "hover:bg-[var(--mx-hover-bg)]"}`}
                        >
                          {c.glyph && (
                            <span aria-hidden className="mx-icon-tile grid h-4 w-4 shrink-0 place-items-center text-[10px] font-bold bg-[var(--mx-accent-soft)] text-[var(--mx-accent)]">
                              {c.glyph}
                            </span>
                          )}
                          <span className="shrink-0 font-mono text-[11px] font-medium text-[var(--mx-accent)]">{c.name}</span>
                          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--mx-muted)]">{t(c.labelKey)}</span>
                        </button>
                      ))
                    : atMatches.map((f, i) => (
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
                  ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </div>
      {/* 宽 pane 工具侧栏(悬浮卡片式,同输入卡质感):Skills/MCP/Plugins 常驻列表;
          缩小态收成右侧边缘悬浮小竖条(点击展开),窄 pane 整体回落弹窗。 */}
      {toolPanel && paneWide && !toolCollapsed && (
        <aside className="my-2 mr-2 flex w-[248px] shrink-0 flex-col overflow-hidden rounded-[var(--mx-radius-lg)] border border-[var(--mx-border)] bg-[var(--mx-card-bg)] shadow-md">
          {/* 面板切换:纯文字 mini tab(10px,极细竖线分隔,active=亮色 medium,无图标,
              视觉重量最小)+ 缩小按钮(收成边缘悬浮图标块,非关闭)。 */}
          <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--mx-border)] px-3 py-1.5">
            {([["skills", "Skills"], ["mcp", "MCP"], ["plugins", "Plugins"]] as const).map(([p, label], i) => {
              const active = toolPanel === p;
              return (
                <Fragment key={p}>
                  {i > 0 && <span aria-hidden className="h-[9px] w-px shrink-0 bg-[var(--mx-border)]" />}
                  <button
                    type="button"
                    onClick={() => setToolPanel(p)}
                    className={`cursor-pointer text-[10px] transition-colors ${
                      active
                        ? "font-medium text-[var(--mx-text)]"
                        : "text-[var(--mx-faint)] hover:text-[var(--mx-text)]"
                    }`}
                  >
                    {label}
                  </button>
                </Fragment>
              );
            })}
            <button
              type="button"
              aria-label="collapse"
              onClick={() => setToolCollapsed(true)}
              onMouseDown={(e) => e.stopPropagation()}
              className="ml-auto grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded text-[11px] text-[var(--mx-faint)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
            >
              »
            </button>
          </div>
          {/* 列表(行样式与弹窗一致:圆角 hover 行 + 语义色点 + 等宽名)。 */}
          <div className="mx-scroll-pretty min-h-0 flex-1 overflow-y-auto p-2">
            {toolPanel === "skills" &&
              (skillEntries === null ? (
                <div className="grid place-items-center py-8 text-[11px] text-[var(--mx-faint)]">{t("common.loading")}</div>
              ) : skillEntries.length === 0 ? (
                <div className="grid place-items-center px-4 py-8 text-center text-[11px] text-[var(--mx-faint)]">{t("claudepane.skillsEmpty")}</div>
              ) : (
                (["global", "project"] as const).map((scope) => {
                  const items = skillEntries.filter((e) => e.scope === scope);
                  if (items.length === 0) return null;
                  return (
                    <div key={scope}>
                      <div className="flex items-center px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--mx-muted)]">
                        <span>{scope === "global" ? t("claudepane.mcpGlobal") : t("claudepane.mcpProject")}</span>
                        <span className="ml-auto tabular-nums text-[var(--mx-faint)]">{items.length}</span>
                      </div>
                      {items.map((e) => (
                        <div
                          key={`${scope}:${e.name}`}
                          title={e.path}
                          onClick={() => void invoke("reveal_in_folder", { path: e.path }).catch(() => {})}
                          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-[5px] hover:bg-[var(--mx-hover-bg)]"
                        >
                          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mx-accent)]" />
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--mx-text)]">{e.name}</span>
                        </div>
                      ))}
                    </div>
                  );
                })
              ))}
            {toolPanel === "mcp" &&
              (mcpEntries === null ? (
                <div className="grid place-items-center py-8 text-[11px] text-[var(--mx-faint)]">{t("common.loading")}</div>
              ) : mcpEntries.length === 0 ? (
                <div className="grid place-items-center px-4 py-8 text-center text-[11px] text-[var(--mx-faint)]">{t("claudepane.mcpEmpty")}</div>
              ) : (
                (["global", "project"] as const).map((scope) => {
                  const items = mcpEntries.filter((e) => e.scope === scope);
                  if (items.length === 0) return null;
                  return (
                    <div key={scope}>
                      <div className="flex items-center px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--mx-muted)]">
                        <span>{scope === "global" ? t("claudepane.mcpGlobal") : t("claudepane.mcpProject")}</span>
                        <span className="ml-auto tabular-nums text-[var(--mx-faint)]">{items.length}</span>
                      </div>
                      {items.map((e) => (
                        <div key={`${scope}:${e.name}`} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-[5px] hover:bg-[var(--mx-hover-bg)]">
                          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mx-success)]" />
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--mx-text)]">{e.name}</span>
                          {e.brief && (
                            <span className="max-w-[90px] shrink-0 truncate text-right font-mono text-[10px] text-[var(--mx-faint)]" title={e.brief}>
                              {e.brief}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })
              ))}
            {toolPanel === "plugins" &&
              (pluginGroups === null ? (
                <div className="grid place-items-center py-8 text-[11px] text-[var(--mx-faint)]">{t("common.loading")}</div>
              ) : pluginGroups.length === 0 ? (
                <div className="grid place-items-center px-4 py-8 text-center text-[11px] text-[var(--mx-faint)]">{t("claudepane.pluginsEmpty")}</div>
              ) : (
                pluginGroups.map((g) => (
                  <div key={g.source}>
                    <div className="flex items-center px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--mx-muted)]">
                      <span className="truncate">{g.source}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-[var(--mx-faint)]">{g.names.length}</span>
                    </div>
                    {g.names.map((n) => (
                      <div key={n} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-[5px] hover:bg-[var(--mx-hover-bg)]">
                        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mx-claude)]" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--mx-text)]">{n}</span>
                      </div>
                    ))}
                  </div>
                ))
              ))}
          </div>
          {/* footer:在资源管理器定位当前面板对应目录/文件(轻量文字链接式,非按钮)。 */}
          <div className="shrink-0 border-t border-[var(--mx-border)] px-3 py-1.5">
            <button
              type="button"
              onClick={() => {
                if (toolPanel === "skills") {
                  void invoke<string>("get_claude_config_path", { target: "skills" })
                    .then((p) => void invoke("reveal_in_folder", { path: p }).catch(() => {}))
                    .catch(() => {});
                } else if (toolPanel === "mcp") {
                  void invoke<string>("get_claude_config_path", { target: "mcp" })
                    .then((p) => void invoke("reveal_in_folder", { path: p }).catch(() => {}))
                    .catch(() => {});
                } else {
                  void homeDir()
                    .then((home) => void invoke("reveal_in_folder", { path: `${home}/.claude/plugins` }).catch(() => {}))
                    .catch(() => {});
                }
              }}
              className="cursor-pointer text-[10px] text-[var(--mx-faint)] transition-colors hover:text-[var(--mx-accent)]"
            >
              ↗{" "}
              {toolPanel === "skills" ? t("claudepane.skillsReveal") : toolPanel === "mcp" ? t("claudepane.mcpReveal") : t("claudepane.pluginsReveal")}
            </button>
          </div>
        </aside>
      )}
      {/* 缩小态:悬浮在右侧偏顶部的小图标块(当前面板 glyph;点击展开;窄 pane 隐藏)。 */}
      {toolPanel && paneWide && toolCollapsed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="expand tools"
              onClick={() => setToolCollapsed(false)}
              onMouseDown={(e) => e.stopPropagation()}
              className="mx-icon-tile absolute right-1 top-3 z-10 grid h-7 w-7 cursor-pointer place-items-center border border-[var(--mx-border)] bg-[var(--mx-card-bg)] text-[13px] font-bold text-[var(--mx-muted)] shadow-md transition-colors hover:border-[var(--mx-accent)] hover:text-[var(--mx-accent)]"
            >
              {toolPanel === "skills" ? "✦" : toolPanel === "mcp" ? "⬡" : "⊞"}
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("claudepane.toolsTooltip")}</TooltipContent>
        </Tooltip>
      )}
      </div>
            {/* ⋯ 工具菜单触发的弹窗(config/rewind/cost/mcp/skills/plugins)+ 底部 toast。 */}
            <Dialog open={rewindOpen} onOpenChange={(o) => !o && setRewindOpen(false)}>
              <DialogContent className="w-[480px] max-w-[90vw] px-5 py-4">
                <DialogTitle className="text-sm font-semibold text-[var(--mx-text)]">{t("claudepane.rewindTitle")}</DialogTitle>
                <div className="mx-scroll-pretty mt-3 max-h-[55vh] space-y-1 overflow-y-auto">
                  {state?.messages
                    .filter((m) => m.role === "user")
                    .map((m, i) => {
                      const text = m.blocks
                        .filter((b): b is Extract<ClaudeBlock, { type: "text" }> => b.type === "text")
                        .map((b) => b.text)
                        .join(" ");
                      if (!text.trim()) return null;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          disabled={rewindBusy}
                          onClick={() => {
                            void rewindToMessage(m);
                          }}
                          className="block w-full rounded px-2 py-1 text-left text-[11px] text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                        >
                          <span className="mr-1 text-[var(--mx-faint)]">#{i + 1}</span>
                          {text.length > 100 ? `${text.slice(0, 100)}…` : text}
                        </button>
                      );
                    })}
                </div>
                <div className="mt-2 text-[10px] text-[var(--mx-faint)]">{t("claudepane.rewindHint")}</div>
              </DialogContent>
            </Dialog>
            <Dialog open={helpOpen} onOpenChange={(o) => !o && setHelpOpen(false)}>
              <DialogContent className="w-[420px] max-w-[90vw] px-5 py-4">
                <DialogTitle className="text-sm font-semibold text-[var(--mx-text)]">{t("claudepane.helpTitle")}</DialogTitle>
                <div className="mt-3 space-y-1.5 text-[11px] text-[var(--mx-muted)]">
                  <div><kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Enter</kbd> 发送 · <kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Shift+Enter</kbd> 换行</div>
                  <div><kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">↑/↓</kbd> 输入历史</div>
                  <div><kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">/</kbd> 命令面板(<kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Tab</kbd> 补全 · <kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Enter</kbd> 执行) · <kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">@</kbd> 文件引用</div>
                  <div><kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Shift+Tab</kbd> 切权限模式</div>
                  <div><kbd className="rounded bg-[var(--mx-hover-bg)] px-1 font-mono text-[10px]">Esc Esc</kbd> 中断当前轮</div>
                </div>
              </DialogContent>
            </Dialog>
            <Dialog open={costOpen} onOpenChange={(o) => !o && setCostOpen(false)}>
              <DialogContent className="w-[380px] max-w-[90vw] px-5 py-4">
                <DialogTitle className="text-sm font-semibold text-[var(--mx-text)]">{t("claudepane.costTitle")}</DialogTitle>
                <div className="mt-3 space-y-1.5 text-[11px] tabular-nums text-[var(--mx-muted)]">
                  <div>↑ 输入<span className="ml-2 text-[var(--mx-text)]">{formatTokens(turnTokens.input)}</span></div>
                  <div>↓ 输出<span className="ml-2 text-[var(--mx-text)]">{formatTokens(turnTokens.output)}</span></div>
                  <div>ctx 窗口<span className="ml-2 text-[var(--mx-text)]">{formatTokens(contextInfo?.window ?? inferContextWindow(model))}</span></div>
                  <div>累计成本<span className="ml-2 text-[var(--mx-text)]">{formatCost(state?.lastResult?.totalCostUsd)}</span></div>
                  <div>耗时<span className="ml-2 text-[var(--mx-text)]"><ElapsedText start={sessionStart} /></span></div>
                </div>
              </DialogContent>
            </Dialog>


            {/* P3.2 — 切模型二次确认(避免误触 — setModel 触发进程重启,丢当前 stream) */}
            <Dialog open={pendingModel != null} onOpenChange={(o) => !o && setPendingModel(null)}>
              <DialogContent className="w-[420px] max-w-[90vw] px-5 py-4">
                <DialogTitle className="text-sm font-semibold text-[var(--mx-text)]">
                  {t("claudepane.modelSwitchTitle")}
                </DialogTitle>
                <div className="mt-3 text-[12px] leading-relaxed text-[var(--mx-muted)]">
                  {t("claudepane.modelSwitchDesc", { model: pendingModel ?? "" })}
                </div>
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPendingModel(null)}
                    className="inline-flex items-center rounded-md border border-[var(--mx-border-strong)] bg-transparent px-3 py-1.5 text-[11px] font-medium text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                  >
                    {t("claudepane.modelSwitchCancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const m = pendingModel;
                      setPendingModel(null);
                      setMenuMode(null);
                      if (m) void applyModel(m);
                    }}
                    className="inline-flex items-center rounded-md bg-[var(--mx-accent-deep)] px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-[var(--mx-accent-deep)]"
                  >
                    {t("claudepane.modelSwitchConfirm")}
                  </button>
                </div>
              </DialogContent>
            </Dialog>

            {/* 供应商+模型整体切换二次确认(分组下拉点模型:写 env 新端点+密钥+默认模型,
                会话重启拾取;比同家切模型动作更大,独立确认文案)。 */}
            <Dialog open={pendingProviderModel != null} onOpenChange={(o) => !o && setPendingProviderModel(null)}>
              <DialogContent className="w-[420px] max-w-[90vw] px-5 py-4">
                <DialogTitle className="text-sm font-semibold text-[var(--mx-text)]">
                  {t("claudepane.modelSwitchTitle")}
                </DialogTitle>
                <div className="mt-3 text-[12px] leading-relaxed text-[var(--mx-muted)]">
                  {t("claudepane.providerSwitchDesc", {
                    provider: pendingProviderModel?.p.name ?? "",
                    model: pendingProviderModel?.m ?? "",
                  })}
                </div>
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPendingProviderModel(null)}
                    className="inline-flex items-center rounded-md border border-[var(--mx-border-strong)] bg-transparent px-3 py-1.5 text-[11px] font-medium text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                  >
                    {t("claudepane.modelSwitchCancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const pm = pendingProviderModel;
                      setPendingProviderModel(null);
                      if (pm) void switchProviderModel(pm.p, pm.m);
                    }}
                    className="inline-flex items-center rounded-md bg-[var(--mx-accent-deep)] px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-[var(--mx-accent-deep)]"
                  >
                    {t("claudepane.modelSwitchConfirm")}
                  </button>
                </div>
              </DialogContent>
            </Dialog>
            {/* /mcp:MCP 服务器列表(~/.claude.json 全局 mcpServers + 本项目 projects[cwd].mcpServers;⋯ 工具菜单打开)。 */}
            <Dialog open={mcpOpen} onOpenChange={(o) => !o && setMcpOpen(false)}>
              <DialogContent className="w-[440px] max-w-[90vw] px-5 py-4">
                <div className="flex items-baseline justify-between border-b border-[var(--mx-border)] pb-2">
                  <DialogTitle className="text-sm font-semibold text-[var(--mx-text)]">{t("claudepane.mcpTitle")}</DialogTitle>
                  {mcpEntries && mcpEntries.length > 0 && (
                    <span className="shrink-0 tabular-nums text-[10px] text-[var(--mx-faint)]">{mcpEntries.length}</span>
                  )}
                </div>
                <div className="mx-scroll-pretty mt-2 max-h-[55vh] overflow-y-auto">
                  {mcpEntries === null ? (
                    <div className="grid place-items-center py-8 text-[11px] text-[var(--mx-faint)]">{t("common.loading")}</div>
                  ) : mcpEntries.length === 0 ? (
                    <div className="grid place-items-center px-6 py-8 text-center text-[11px] text-[var(--mx-faint)]">
                      {t("claudepane.mcpEmpty")}
                    </div>
                  ) : (
                    (["global", "project"] as const).map((scope) => {
                      const items = mcpEntries.filter((e) => e.scope === scope);
                      if (items.length === 0) return null;
                      return (
                        <div key={scope}>
                          <div className="flex items-center px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--mx-muted)]">
                            <span>{scope === "global" ? t("claudepane.mcpGlobal") : t("claudepane.mcpProject")}</span>
                            <span className="ml-auto tabular-nums text-[var(--mx-faint)]">{items.length}</span>
                          </div>
                          {items.map((e) => (
                            <div key={`${scope}:${e.name}`} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-[5px] hover:bg-[var(--mx-hover-bg)]">
                              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mx-success)]" />
                              <span className="shrink-0 font-mono text-[11px] text-[var(--mx-text)]">{e.name}</span>
                              {e.brief && (
                                <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-[var(--mx-faint)]" title={e.brief}>
                                  {e.brief}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      );
                    })
                  )}
                  <div className="mt-2 border-t border-[var(--mx-border)] pt-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-[10px] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
                      onClick={() => {
                        void invoke<string>("get_claude_config_path", { target: "mcp" })
                          .then((p) => void invoke("reveal_in_folder", { path: p }).catch(() => {}));
                      }}
                    >
                      {t("claudepane.mcpReveal")}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
            {/* Skills 列表(全局 ~/.claude/skills + 项目 <cwd>/.claude/skills;⋯ 工具菜单打开),点击定位该 skill 目录。 */}
            <Dialog open={skillsOpen} onOpenChange={(o) => !o && setSkillsOpen(false)}>
              <DialogContent className="w-[440px] max-w-[90vw] px-5 py-4">
                <div className="flex items-baseline justify-between border-b border-[var(--mx-border)] pb-2">
                  <DialogTitle className="text-sm font-semibold text-[var(--mx-text)]">{t("claudepane.skillsTitle")}</DialogTitle>
                  {skillEntries && skillEntries.length > 0 && (
                    <span className="shrink-0 tabular-nums text-[10px] text-[var(--mx-faint)]">{skillEntries.length}</span>
                  )}
                </div>
                <div className="mx-scroll-pretty mt-2 max-h-[55vh] overflow-y-auto">
                  {skillEntries === null ? (
                    <div className="grid place-items-center py-8 text-[11px] text-[var(--mx-faint)]">{t("common.loading")}</div>
                  ) : skillEntries.length === 0 ? (
                    <div className="grid place-items-center px-6 py-8 text-center text-[11px] text-[var(--mx-faint)]">
                      {t("claudepane.skillsEmpty")}
                    </div>
                  ) : (
                    (["global", "project"] as const).map((scope) => {
                      const items = skillEntries.filter((e) => e.scope === scope);
                      if (items.length === 0) return null;
                      return (
                        <div key={scope}>
                          <div className="flex items-center px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--mx-muted)]">
                            <span>{scope === "global" ? t("claudepane.mcpGlobal") : t("claudepane.mcpProject")}</span>
                            <span className="ml-auto tabular-nums text-[var(--mx-faint)]">{items.length}</span>
                          </div>
                          {items.map((e) => (
                            <button
                              key={`${scope}:${e.name}`}
                              type="button"
                              onClick={() => void invoke("reveal_in_folder", { path: e.path }).catch(() => {})}
                              className="flex w-full cursor-pointer items-center gap-2 px-1.5 py-1 text-left hover:bg-[var(--mx-hover-bg)]"
                            >
                              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mx-accent)]" />
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--mx-text)]">{e.name}</span>
                            </button>
                          ))}
                        </div>
                      );
                    })
                  )}
                  <div className="mt-2 border-t border-[var(--mx-border)] pt-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-[10px] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
                      onClick={() => {
                        void invoke<string>("get_claude_config_path", { target: "skills" })
                          .then((p) => void invoke("reveal_in_folder", { path: p }).catch(() => {}));
                      }}
                    >
                      {t("claudepane.skillsReveal")}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
            {/* Plugins 列表(installed_plugins.json 按来源分组,解析失败/空回退列 marketplaces 目录;⋯ 工具菜单打开)。 */}
            <Dialog open={pluginsOpen} onOpenChange={(o) => !o && setPluginsOpen(false)}>
              <DialogContent className="w-[440px] max-w-[90vw] px-5 py-4">
                <div className="flex items-baseline justify-between border-b border-[var(--mx-border)] pb-2">
                  <DialogTitle className="text-sm font-semibold text-[var(--mx-text)]">{t("claudepane.pluginsTitle")}</DialogTitle>
                  {pluginGroups && pluginGroups.some((g) => g.names.length > 0) && (
                    <span className="shrink-0 tabular-nums text-[10px] text-[var(--mx-faint)]">
                      {pluginGroups.reduce((n, g) => n + g.names.length, 0)}
                    </span>
                  )}
                </div>
                <div className="mx-scroll-pretty mt-2 max-h-[55vh] overflow-y-auto">
                  {pluginGroups === null ? (
                    <div className="grid place-items-center py-8 text-[11px] text-[var(--mx-faint)]">{t("common.loading")}</div>
                  ) : pluginGroups.every((g) => g.names.length === 0) ? (
                    <div className="grid place-items-center px-6 py-8 text-center text-[11px] text-[var(--mx-faint)]">
                      {t("claudepane.pluginsEmpty")}
                    </div>
                  ) : (
                    pluginGroups.map((g) => (
                      <div key={g.source}>
                        <div className="flex items-center px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--mx-muted)]">
                          <span className="truncate">{g.source}</span>
                          <span className="ml-auto shrink-0 tabular-nums text-[var(--mx-faint)]">{g.names.length}</span>
                        </div>
                        {g.names.map((n) => (
                          <div key={`${g.source}:${n}`} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-[5px] hover:bg-[var(--mx-hover-bg)]">
                            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mx-claude)]" />
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--mx-text)]">{n}</span>
                          </div>
                        ))}
                      </div>
                    ))
                  )}
                  <div className="mt-2 border-t border-[var(--mx-border)] pt-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-[10px] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
                      onClick={() => {
                        void homeDir()
                          .then((home) => invoke("reveal_in_folder", { path: `${home}/.claude/plugins` }).catch(() => {}))
                          .catch(() => {});
                      }}
                    >
                      {t("claudepane.pluginsReveal")}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
            {compactError && !compactErrorDismissed && (
              <BottomToast onClose={() => setCompactErrorDismissed(true)}>
                {t("claudepane.compactFailed", { error: compactError })}
              </BottomToast>
            )}
            {rewindError && (
              <BottomToast onClose={() => setRewindError(null)}>
                {rewindError}
              </BottomToast>
            )}
            {retryFailedMsg && (
              <BottomToast onClose={() => setRetryFailedMsg(null)}>
                {retryFailedMsg}
              </BottomToast>
            )}
            {exportToast && (
              <BottomToast tone={exportToast.ok ? "warning" : "danger"} onClose={() => setExportToast(null)}>
                {exportToast.msg}
              </BottomToast>
            )}
    </article>
  );
}

/**
 * compact 节点渲染——/compact 的视觉锚点(事件驱动,见 claudeStream applyEvent)。
 *
 * - boundary(compactKind:"boundary"):`compact_boundary` 事件归并的分隔线。虚线横贯 + 居中文案
 *   「已压缩 pre→post tokens(pct)· durationMs」。pre/post 缺失时降级显「已压缩对话历史」。
 *   折叠可展开看完整 compact_metadata(JSON)。
 * - summary(compactKind:"summary"):`compact_boundary` 后紧跟的 user 总结消息。assistant 风格
 *   claude 色卡片 + MdPreview 渲染总结正文 + 标题「压缩总结」。
 */
function CompactRow({
  message,
  t,
}: {
  message: ClaudeMessage;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  if (message.compactKind === "summary") {
    const text = message.blocks
      .filter((b): b is Extract<ClaudeBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return (
      <div className="my-1 overflow-hidden rounded-lg border border-[var(--mx-claude-border)] bg-[var(--mx-claude-soft)]">
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--mx-claude)" strokeWidth="2" aria-hidden>
            <path d="M21 12a9 9 0 11-6.219-8.56" />
            <path d="M9 11l3 3L22 4" />
          </svg>
          <span className="font-semibold text-[var(--mx-claude)]">{t("claudepane.compactSummary")}</span>
        </div>
        <div className="border-t border-[var(--mx-claude-border)] px-3 py-2.5 leading-relaxed text-[var(--mx-text)]">
          <Suspense fallback={<div className="text-[11px] text-[var(--mx-muted)]">{t("common.loading")}</div>}>
            <MdPreviewLazy content={text} inline />
          </Suspense>
        </div>
      </div>
    );
  }
  // boundary:虚线分隔线 + 居中压缩比文案。
  const meta: CompactMeta | undefined = message.compactMeta;
  const pre = meta?.preTokens;
  const post = meta?.postTokens;
  const pct = meta?.pct;
  const durationMs = meta?.durationMs;
  const hasStats = pre !== undefined && post !== undefined;
  const label = hasStats
    ? t("claudepane.compactBoundary", { pre: formatTokens(pre!), post: formatTokens(post!), pct: pct ?? 0 })
    : t("claudepane.compactBoundaryFallback");
  return (
    <div className="my-2 flex items-center gap-3 select-none">
      <div className="h-px flex-1 bg-[var(--mx-border-strong)]" style={{ borderTop: "1px dashed rgba(148,163,184,0.32)", background: "transparent" }} />
      <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-[var(--mx-faint)]">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M4 4h16v16H4z" />
          <path d="M9 9h6v6H9z" />
        </svg>
        {label}
        {durationMs !== undefined && durationMs > 0 && <span className="opacity-70">· {formatElapsed(durationMs)}</span>}
      </span>
      <div className="h-px flex-1 bg-[var(--mx-border-strong)]" style={{ borderTop: "1px dashed rgba(148,163,184,0.32)", background: "transparent" }} />
    </div>
  );
}

/**
 * 单条消息渲染——claude code CLI 式行内流(非气泡)。
 *
 * 不显示「user/助手」文字 label,用行首图标 + 色值区分角色:
 * - user:cyan「›」(输入色)+ 正文(`whitespace-pre-wrap`)+ 右下角时间。
 * - assistant:claude 品牌块「C」(输出色)+ 正文块流;流式空时显示思考动画。末行时间 + token 消耗。
 * 每条独立显示标记(不分组省略),让角色一眼可辨。
 * 展示完整返回体:文本不截断,工具结果由 ToolCard 自管折叠/展开。
 */
const MessageRow = memo(function MessageRow({
  message,
  t,
  onApprovePlan,
  onReject,
  resolvedApprovals,
  onApproveTool,
  onRejectTool,
  onFeedback,
  onResend,
  approvalActiveId,
  approvalActiveIdx,
  contextWindow,
  bashCommandOpen,
  workFold,
  workFoldOpen,
  onToggleWorkFold,
  foldMessages,
  foldRows,
  openFoldKeys,
  toggleFoldByKey,
}: {
  message: ClaudeMessage;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onApprovePlan?: () => void;
  onReject?: () => void;
  resolvedApprovals?: Set<string>;
  onApproveTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>, persist: boolean) => void;
  onRejectTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>, reason?: string) => void;
  onFeedback?: () => void;
  /** user 消息 hover「重新发送」(C6):重跑同一轮。 */
  onResend?: (text: string) => void;
  /** 键盘流当前待确认 block 的 id(见 ClaudePane activeApproval);null=无待确认。 */
  approvalActiveId: string | null;
  /** 本消息内待确认 block 的键盘高亮索引(0-3);消息不含 active block 时恒 -1(memo 稳定)。 */
  approvalActiveIdx: number;
  /** 模型 context window 容量(从 state.meta.contextWindow / inferContextWindow 来)。
   *  (ctx chip 已移除,目前仅作占位透传;保留避免大范围动 MessageRow 签名。) */
  contextWindow?: number | null;
  /** 所在 steps/work fold 已展开(非段首):命令步骤(Bash/PowerShell)恒显命令原文。 */
  bashCommandOpen?: boolean;
  /** 本消息是某轮 work fold 的答案:卡片内部第一个块渲染「已处理…」摘要行(替代原答案前
   *  外部独立行),点击 toggle 该 fold。fold/workFoldOpen/onToggleWorkFold 引用均稳定(memo 友好)。 */
  workFold?: StepFold;
  workFoldOpen?: boolean;
  onToggleWorkFold?: (fold: StepFold) => void;
  /** claude 消息数组(供 WorkFoldRow 段内步骤语义计数 + 展开体逐消息渲染)。 */
  foldMessages?: ClaudeMessage[];
  /** foldMap.rows(段内行 steps 归属查询,展开体的两层渐进用)。 */
  foldRows?: RowFold[];
  /** openFolds(open key 集合,折叠态源)。 */
  openFoldKeys?: Set<string>;
  /** toggleFold(work 展开体内 StepFoldRow 的 onToggle 用)。 */
  toggleFoldByKey?: (key: string) => void;
}) {
  const time = formatTime(message.timestamp);

  if (message.role === "compact") {
    // compact 节点:boundary=边界分隔线(已压缩 pre→post tokens(pct)·耗时);
    // summary=压缩总结卡片(MdPreview 渲染,claude 色调,assistant 风格)。
    return <CompactRow message={message} t={t} />;
  }

  if (message.role === "notice") {
    // notice 节点:系统级轻提示行(后台任务完成/失败/停止、恢复会话历史回填、添加工作目录)。
    // 仿 compact boundary 的居中轻量样式,绿勾/红叉/琥珀方块/青勾区分,不参与角色流。
    const kind = message.notice?.kind;
    const stopped = kind === "bg_stopped";
    const done = kind === "bg_done";
    const resumed = kind === "history_resumed";
    const addedDir = kind === "add_dir";
    const hist = message.notice?.history;
    const ok = done || (resumed && !hist?.failed) || addedDir;
    const tone = stopped ? "var(--mx-warning-bright)" : ok ? (resumed || addedDir ? "var(--mx-info)" : "var(--mx-success-bright)") : "var(--mx-danger-bright)";
    const label = stopped
      ? t("claudepane.bgTaskStoppedLabel")
      : done
        ? t("claudepane.bgTaskDoneLabel")
        : resumed
          ? hist?.failed
            ? t("claudepane.historyFailed")
            : t("claudepane.historyResumed", { n: hist?.count ?? 0 })
          : addedDir
            ? t("claudepane.addDirDone")
            : t("claudepane.bgTaskFailedLabel");
    // 后台任务 notice 的 summary 是 claude 原文直接拼;添加工作目录 notice 的 summary 是路径
    // 原文直接拼;历史回填 notice 的附注(截断提示)走 i18n。
    const suffix = resumed ? (hist?.truncated ? t("claudepane.historyTruncated") : "") : message.notice?.summary;
    return (
      <div className="my-2 flex items-center gap-3 select-none">
        <div className="h-px flex-1" style={{ borderTop: "1px dashed rgba(148,163,184,0.32)", background: "transparent" }} />
        {/* 容器可收缩(min-w-0 shrink)+suffix anywhere 断行:后台任务 summary 是 claude 原文
            (常含无空格长命令串),不可断会撑高整行 min-content,顶出消息流横向滚动条。 */}
        <span className="flex min-w-0 shrink items-center gap-1.5 text-[10px] text-[var(--mx-faint)]">
          {stopped ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill={tone} className="shrink-0" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={tone} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
              {ok ? <path d="M20 6L9 17l-5-5" /> : <path d="M18 6L6 18M6 6l12 12" />}
            </svg>
          )}
          <span className="shrink-0" style={{ color: tone }}>{label}</span>
          {suffix && <span className="min-w-0 [overflow-wrap:anywhere]">{suffix}</span>}
        </span>
        <div className="h-px flex-1" style={{ borderTop: "1px dashed rgba(148,163,184,0.32)", background: "transparent" }} />
      </div>
    );
  }

  if (message.role === "user") {
    // user:仅文本块(stream-json 不回显 user,前端乐观插入的就是单 text 块)。
    const text = message.blocks
      .filter((b): b is Extract<ClaudeBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text.trim().length === 0) return null;
    // 左右对话框:user 消息靠右(共享 ChatUserBubble:中性色气泡 + 人形徽标 + ↻/⧉ 常显淡 hover 实)。
    return <ChatUserBubble text={text} time={time ?? undefined} onResend={onResend} t={t} />;
  }

  // assistant:行首 claude 品牌块「C」(悬挂左侧)+ 正文块流 + 末行时间。
  const fullText = message.blocks
    .filter((b): b is Extract<ClaudeBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return (
    // 左右对话框:assistant 消息靠左,深底气泡 + 左侧品牌徽标。
    // **气泡内**的内容是 BaoCode 式步骤行(见 components/StepRow.tsx)——即「我们的气泡框
    // 装借鉴来的步骤」,不再为每个工具套一层卡片边框。不设 max-w 限宽(代码块/diff 需要宽)。
    <div className="mx-msg-in group/message flex items-start gap-1.5">
      {/* A1 角色徽标:assistant 品牌块(紫 C),置于气泡左侧。 */}
      <span aria-hidden className="flex h-[1.625em] shrink-0 items-center">
        <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-[var(--mx-claude)] text-[10px] font-extrabold text-white">C</span>
      </span>
      <div className="group min-w-0 flex-1">
        <div className="flex flex-col gap-2 rounded-2xl rounded-bl-[6px] bg-[var(--mx-card-bg)] px-3 py-1.5">
          {/* work fold 摘要行(「已处理 4m32s · 读取了 3 个文件…」):卡片内部第一个块,
              替代原答案前外部独立行(用户反馈不协调);点击 toggle 该轮 work fold。 */}
          {workFold && (
            <WorkFoldRow
              fold={workFold}
              messages={foldMessages}
              open={!!workFoldOpen}
              onToggle={() => onToggleWorkFold?.(workFold)}
              t={t}
            />
          )}
          {/* work fold 就地展开体:段内步骤渲染在摘要行**下方**(向下生长)——控制点与内容
              连续,收起点始终在展开内容的第一行,不再「往上展开」把答案顶出视口找不到收缩处
              (BaoCode Column[WorkFoldLine, steps…] 同构)。两层渐进保留:段内 quick steps
              仍按 steps fold 收拢成 StepFoldRow,点开再见明细。 */}
          {workFold && workFoldOpen && foldRows && foldMessages && openFoldKeys && toggleFoldByKey && (
            <div className="flex flex-col gap-2">
              {Array.from({ length: workFold.end - workFold.start + 1 }, (_, off) => {
                const k = workFold.start + off;
                const m = foldMessages[k];
                if (!m || m.role !== "assistant") return null;
                const stepsFold = foldRows[k]?.steps ?? null;
                const isStepsStart = stepsFold != null && stepsFold.start === k;
                const stepsOpen =
                  stepsFold != null && openFoldKeys.has(`steps:${stepsFold.start}:${stepsFold.end}`);
                // steps 折叠中:段首渲染折叠行,段内其余跳过(与消息流侧同构)
                if (stepsFold != null && !isStepsStart && !stepsOpen) return null;
                if (isStepsStart && !stepsOpen) {
                  return (
                    <StepFoldRow
                      key={`sf-${k}`}
                      fold={stepsFold}
                      messages={foldMessages}
                      open={false}
                      onToggle={() => toggleFoldByKey(`steps:${stepsFold.start}:${stepsFold.end}`)}
                      t={t}
                    />
                  );
                }
                // 历史步骤逐块渲染(「已思考」行 / 工具卡);work 已展开 → 命令恒显命令原文。
                return m.blocks.map((b, bi) => (
                  <BlockView
                    key={`wb-${k}-${bi}`}
                    block={b}
                    t={t}
                    streaming={false}
                    onApprovePlan={onApprovePlan}
                    onReject={onReject}
                    resolvedApprovals={resolvedApprovals}
                    onApproveTool={onApproveTool}
                    onRejectTool={onRejectTool}
                    onFeedback={onFeedback}
                    approvalActiveId={approvalActiveId}
                    approvalActiveIdx={-1}
                    bashCommandOpen
                  />
                ));
              })}
            </div>
          )}
          {message.blocks.map((b, i) => (
            /* work fold 存在时本消息的 thinking 块不渲染:折叠态由「已处理」摘要行承载轮末
             * 「已思考」的位置(用户口径:换成「已处理」);展开态段内各消息的思考块仍可见。 */
            workFold && b.type === "thinking" ? null : (
            <BlockView
              key={i}
              block={b}
              t={t}
              /* thinking 块仅在仍是消息末块时显示流式思考中——后续 text/tool 块到达即视为
               * 思考结束,变「已思考」(及时反馈);跨消息拆分(glm 一轮拆多条 assistant)场景
               * 由 claudeStream result 分支全量置 streaming=false 兜底。text/tool 不受影响。 */
              streaming={message.streaming && (b.type !== "thinking" || i === message.blocks.length - 1)}
              onApprovePlan={onApprovePlan}
              onReject={onReject}
              resolvedApprovals={resolvedApprovals}
              onApproveTool={onApproveTool}
              onRejectTool={onRejectTool}
              onFeedback={onFeedback}
              approvalActiveId={approvalActiveId}
              approvalActiveIdx={approvalActiveIdx}
              bashCommandOpen={bashCommandOpen}
            />
            )
          ))}
          {message.blocks.length === 0 && message.streaming && (
            <div className="flex items-center gap-2 text-xs text-[var(--mx-muted)]">
              <ThinkingDots />
              {t("claudepane.thinking")}
            </div>
          )}
        </div>
        {/* 末行:时间 + ⏱消耗时长 + ↑↓tokens + 复制按钮(claude code CLI 式小字)。
            时长/tokens 仅本轮 result 事件回填后才有(流式中不显示,避免假数据)。 */}
        {(time || message.durationMs || message.usage || fullText) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-[var(--mx-faint)]">
            {time && <span>{time}</span>}
            {message.durationMs != null && message.durationMs > 0 && (
              <span>⏱ {formatElapsed(message.durationMs)}</span>
            )}
            {/* 本轮 token 用量 + t/s(仅 result 回填后有)+ ctx 占用 chip(有 usage 即显示,
                不依赖 durationMs —— 之前嵌在 durationMs>0 条件里,无耗时轮次会整条缺失)。 */}
            {message.usage && hasUsage(message.usage) && (
              <>
                <span title={t("claudepane.turnInputTitle")}>
                  ↑{formatTokens(claudeInputTokens(message.usage))} ↓
                  {formatTokens(message.usage.output_tokens ?? 0)}
                </span>
                {message.durationMs != null && message.durationMs > 0 && (
                  <span title={t("claudepane.turnSpeedTitle")}>
                    ⚡{formatTokensPerSecond(message.usage.output_tokens ?? null, message.durationMs)} t/s
                  </span>
                )}
                {/* ctx 占用 chip 已移除(2026-10-20 用户反馈:每条消息都展示意义不大);
                    会话级占用仍可见 —— 输入卡底栏 ContextMeter + 状态栏汇总。 */}
              </>
            )}
            {/* 复制常显淡(内层 div.group 命中裸 group-hover),hover 变实。 */}
            {fullText && <CopyButton text={fullText} t={t} className="ml-auto opacity-60 group-hover:opacity-100" />}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * 思考状态动画(claude code CLI 风格:三个 Claude 品牌色圆点错峰呼吸;baocode 火花默认色
 * 同为 AppColors.claude #D97857)。用于状态栏整体思考反馈 + assistant 流式空块占位。
 */
function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--mx-claude)]"
          style={{ animationDelay: `${i * 0.18}s`, animationDuration: "1s" }}
        />
      ))}
    </span>
  );
}

/**
 * 一段思考——BaoCode 式**一行步骤**(见 components/StepRow.tsx)。
 *
 * 旧结构是 `<details>` 手风琴:chevron + 「思考中…/已思考」+ 字符数。现在读作一行
 * 「思考中 · N chars」/「已思考 · N chars」,hover 才浮现 chevron,点击展开原文——
 * 与工具调用行完全同构,整条消息流因此是「一列对齐的步骤」,而不是一堆形态各异的块。
 *
 * 行为保持不变:默认收起(对话紧凑)、展开态限高内部滚动、流式中自动贴底
 * (用户上翻 >24px 即暂停,滚回底部恢复),每轮 assistant 是新挂载消息故状态不跨轮残留。
 */
function ThinkingBlock({ text, streaming, t }: { text: string; streaming: boolean; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 贴底守卫:距底 <24px 视为「在底部」续贴;用户上翻即停,滚回底部恢复。
  const stickRef = useRef(true);
  // 用户展开且流式中 text 增长 → 贴底(仅手动展开时才有意义;上翻后暂停)。
  useEffect(() => {
    const el = bodyRef.current;
    if (streaming && open && el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text, streaming, open]);
  return (
    <div>
      <StepRow
        verb={streaming ? t("toolStep.thinking") : t("toolStep.thought")}
        detail={text ? `${text.length} chars` : null}
        running={streaming}
        expanded={open}
        onToggle={() => setOpen((p) => !p)}
        testId="thinking-step"
      />
      {open && (
        <div className="mt-1 mb-1.5 overflow-hidden rounded-lg border border-[var(--mx-border)] bg-[var(--mx-surface-2)]">
          <div
            ref={bodyRef}
            onScroll={() => {
              const el = bodyRef.current;
              if (!el) return;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="mx-scroll-pretty max-h-[min(40vh,320px)] overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 text-[12px] italic leading-relaxed text-(color:--mx-muted)"
          >
            {text || "…"}
          </div>
        </div>
      )}
    </div>
  );
}

/** 单个 block 渲染:text / thinking / tool_use(忠实复刻 claudecodeui MessageComponent 分支)。 */
function BlockView({
  block,
  t,
  streaming,
  onApprovePlan,
  onReject,
  resolvedApprovals,
  onApproveTool,
  onRejectTool,
  onFeedback,
  approvalActiveId,
  approvalActiveIdx,
  bashCommandOpen,
}: {
  block: ClaudeBlock;
  t: (k: string) => string;
  streaming: boolean;
  onApprovePlan?: () => void;
  onReject?: () => void;
  resolvedApprovals?: Set<string>;
  onApproveTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>, persist: boolean) => void;
  onRejectTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>, reason?: string) => void;
  onFeedback?: () => void;
  /** 键盘流当前待确认 block 的 id;null=无待确认(见 ClaudePane activeApproval)。 */
  approvalActiveId: string | null;
  /** 本消息内待确认 block 的键盘高亮索引;非 active block 恒 -1(memo 稳定)。 */
  approvalActiveIdx: number;
  /** 所在 fold 已展开:命令步骤恒显命令原文。 */
  bashCommandOpen?: boolean;
}) {
  if (block.type === "text") {
    if (streaming) {
      // 流式中:纯文本(高频 delta,避免逐 token 重渲染 marked)。
      return <div dir="auto" className="whitespace-pre-wrap break-words leading-relaxed text-[var(--mx-text)]">{block.text}</div>;
    }
    if (!block.text.trim()) return null;
    // 纯 JSON 检测:整体是 {}/[] 时用 pre 代码块渲染(仿 claudecodeui JSON.response 分支)。
    const trimmed = block.text.trim();
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
              <span className="font-medium">{t("claudepane.jsonResponse")}</span>
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
      // D7 流式切换平滑:轮末由纯文本切 markdown 时新元素挂载带 0.18s 淡入,不突兀。
      <div dir="auto" className="mx-fade-in leading-relaxed text-[var(--mx-text)]">
        <Suspense fallback={null}>
          <MdPreviewLazy content={block.text} inline />
        </Suspense>
      </div>
    );
  }
  if (block.type === "thinking") {
    return <ThinkingBlock text={block.text} streaming={streaming} t={t} />;
  }
  // tool_use
  return (
    <ToolCard
      block={block}
      t={t}
      onApprovePlan={onApprovePlan}
      onReject={onReject}
      resolvedApprovals={resolvedApprovals}
      onApproveTool={onApproveTool}
      onRejectTool={onRejectTool}
      onFeedback={onFeedback}
      approvalActiveIdx={block.id === approvalActiveId ? approvalActiveIdx : -1}
      bashCommandOpen={bashCommandOpen}
    />
  );
}

/**
 * 合并 claude 消息流与 `!` 命令消息流,按发起顺序交错渲染。
 *
 * claude 消息无 timestamp 数字(ClaudeMessage.timestamp 是 ISO 串或 null),shell 消息有
 * 数字 timestamp(ms)。两者混合排序需统一时间戳:claude 用「数组下标顺序」(先到的在前),
 * shell 用 timestamp。这里采用稳定归并——claude 保持原序,shell 按 timestamp 插入到「所有
 * timestamp 不大于它的 claude 消息之后」。因 shell 消息发起于用户当前轮末尾,自然落到流尾。
 */
function mergeClaudeAndShellMessages(
  claudeMsgs: ClaudeMessage[],
  shellMsgs: ShellMessage[],
): Array<{ kind: "claude"; msg: ClaudeMessage } | { kind: "shell"; msg: ShellMessage }> {
  if (shellMsgs.length === 0) {
    return claudeMsgs.map((msg) => ({ kind: "claude" as const, msg }));
  }
  // shell 消息按 timestamp 升序(claude 消息保持原序)。统一用 timestamp 排序,claude 消息
  // timestamp 缺失时按「已出现顺序」赋递增序号(保证 claude 内部相对顺序稳定)。
  type Tagged = { ts: number; kind: "claude"; msg: ClaudeMessage } | { ts: number; kind: "shell"; msg: ShellMessage };
  const now = Date.now();
  const items: Tagged[] = claudeMsgs.map((msg, i) => {
    let ts = now;
    if (msg.timestamp) {
      const parsed = Date.parse(msg.timestamp);
      if (!Number.isNaN(parsed)) ts = parsed;
    } else {
      // claude 消息无 timestamp:用「早于所有 shell」的递增序号(0,1,2...),保证排在 shell 前。
      ts = i;
    }
    return { ts, kind: "claude" as const, msg };
  });
  for (const msg of shellMsgs) {
    items.push({ ts: msg.timestamp, kind: "shell" as const, msg });
  }
  items.sort((a, b) => a.ts - b.ts);
  return items;
}

/**
 * `!` 命令执行消息行(header: `$ <command>` + 状态药丸 + 中断按钮;展开区:实时输出)。
 *
 * 与 MessageRow 平级(不经 MessageRow,因 ShellMessage 不是 ClaudeMessage)。仿 BashToolView
 * 的 chevron + `$` + 命令范式,但默认展开输出(stderr 红色),running 时显示中断按钮。
 */
/**
 * 把连续同 stream 的输出行合并成段:20k 行也只渲染数个 span(逐行 div 会撑出海量节点)。
 * 后端 BufReader::lines() 剥掉了行尾,合并时补回 \n。
 */
function outputSegments(lines: ShellMessage["output"]): Array<{ stream: "stdout" | "stderr"; text: string }> {
  const segs: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
  for (const line of lines) {
    const last = segs[segs.length - 1];
    if (last && last.stream === line.stream) last.text += line.text + "\n";
    else segs.push({ stream: line.stream, text: line.text + "\n" });
  }
  return segs;
}

const ShellRow = memo(function ShellRow({
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
        return { label: t("claudepane.shellRunning"), bg: "var(--mx-info-soft)", fg: "var(--mx-info)" };
      case "done":
        return { label: t("claudepane.shellDone"), bg: "var(--mx-success-soft)", fg: "var(--mx-success-bright)" };
      case "error":
        return {
          label:
            message.exitCode != null
              ? t("claudepane.shellError", { code: message.exitCode })
              : t("claudepane.shellError", { code: 1 }),
          bg: "var(--mx-danger-bg)",
          fg: "var(--mx-danger-bright)",
        };
      case "interrupted":
        return { label: t("claudepane.shellInterrupted"), bg: "var(--mx-border)", fg: "var(--mx-text)" };
    }
  })();
  return (
    <div className="flex gap-2">
      {/* 行首图标列:绿色 $(与 BashToolView 的命令行语义一致)。高度 = 一行行高,垂直居中。 */}
      <span
        aria-hidden
        className="flex h-[1.625em] shrink-0 items-center justify-center font-mono text-[var(--mx-success)]"
      >
        $
      </span>
      <div className="group min-w-0 flex-1">
        {/* 命令行 + 状态药丸 + 中断按钮。 */}
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
              title={t("claudepane.interrupt")}
            >
              ✕
            </button>
          )}
        </div>
        {/* 输出区:连续同 stream 合并成段(节点数=颜色切换次数),stdout muted / stderr 红。
            默认展开便于看实时流;超 SHELL_MAX_OUTPUT_LINES 截尾时有提示。 */}
        {message.output.length > 0 ? (
          <pre className="mx-scroll mt-0.5 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--mx-surface-2)] px-2 py-1 font-mono leading-relaxed">
            {message.truncated && (
              <div className="mb-1 text-[10px] text-[var(--mx-warning)]">
                {t("claudepane.shellOutputTruncated", { n: SHELL_MAX_OUTPUT_LINES })}
              </div>
            )}
            {outputSegments(message.output).map((seg, i) => (
              <span key={i} className={seg.stream === "stderr" ? "text-[var(--mx-danger-bright)]" : "text-[var(--mx-muted)]"}>
                {seg.text}
              </span>
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
});

/** 时间戳格式化(message.timestamp 可能是 ISO 串或 null)。 */
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
  if (!model) return "—";
  const last = model.split("/").pop() ?? model;
  return last.length > 22 ? last.slice(0, 22) + "…" : last;
}

/** 会话时长格式化(ms → m:ss 或 h:mm:ss)。 */
function formatElapsed(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 自更新的耗时文本:内部 setInterval 每秒只重渲染自己,避免在父级(ClaudePane)放
 * setState 每秒惊动整棵消息流树(长会话下每秒一次全树 reconcile)。start=null 显 0:00。
 */
const ElapsedText = memo(function ElapsedText({ start, prefix }: { start: number | null; prefix?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (start === null) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [start]);
  return (
    <>
      {prefix}
      {formatElapsed(start === null ? 0 : Date.now() - start)}
    </>
  );
});

/**
 * token 数格式化:<1k 显原数、1k–1M 显 k、≥1M 显 m;末尾 .0 trim 掉(200k 而非 200.0k)。
 * m 阈值收到 1M:上下文窗口可能 1M,需显示「1m」而非「1000k」。
 * 例:14 → "14"、1918 → "1.9k"、26112 → "26k"、200_000 → "200k"、1_000_000 → "1m"。
 */
// formatTokens / formatCost 已抽共享到 src/lib/turnMetrics.ts(顶部 import)。

// CopyButton 已抽共享(src/components/ui/CopyButton.tsx,ClaudePane/CodexPane 复用)。

/**
 * 工具调用——配置驱动渲染(参考 claudecodeui 的 ToolRenderer + toolConfigs)。
 *
 * 按 `getToolConfig(name).variant` 路由:
 * - `bash` → BashToolView(「运行了 bun test」+ 展开深底输出框)
 * - `task` → TaskToolView(「子代理 · 任务描述 · Explore」+ 展开 result 的 markdown)
 * - `diff` → DiffToolView(「编辑了 app.ts」+ 展开红绿 diff)
 * - `todo` → TodoToolView(「更新了待办」+ 展开清单)
 * - `plan` → PlanToolView(计划确认卡,唯一保留卡片的形态——它本就是一次决策)
 * - `default` → DefaultToolView(「调用了 X · 参数摘要」+ 展开 input/result)
 *
 * **BaoCode 借鉴(2026-10-19)**:以上除 plan 外,header 一律是 `StepRow` 的
 * **一行**「动词 目标 细节」,不再带分类左色条 / 边框 / 卡片底色——整个消息流因此
 * 是一列对齐的步骤行。动词/目标/细节由 `src/lib/toolStep.ts` 纯函数派生(有单测)。
 * 状态仍用 ToolStatusBadge 药丸(running/completed/error/denied)。
 */
function ToolCard({
  block,
  t,
  onApprovePlan,
  onReject,
  resolvedApprovals,
  onApproveTool,
  onRejectTool,
  onFeedback,
  approvalActiveIdx,
  bashCommandOpen,
}: {
  block: Extract<ClaudeBlock, { type: "tool_use" }>;
  t: (k: string) => string;
  onApprovePlan?: () => void;
  onReject?: () => void;
  resolvedApprovals?: Set<string>;
  onApproveTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>, persist: boolean) => void;
  onRejectTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>, reason?: string) => void;
  onFeedback?: () => void;
  /** 键盘流高亮索引(本 block 为 active 待确认时 0-3,否则 -1)。 */
  approvalActiveIdx: number;
  /** 所在 fold 已展开:命令步骤(Bash/PowerShell)恒显命令原文。 */
  bashCommandOpen?: boolean;
}) {
  const config = getToolConfig(block.name);
  if (config.variant === "plan") {
    return <PlanToolView block={block} config={config} t={t} onApprove={onApprovePlan} onReject={onReject} />;
  }
  // 权限确认(启发式兜底路径):被拒的敏感操作且未 resolved(如真 sandbox 拒绝)→ 内联确认框。
  // 控制通道(can_use_tool)的待批请求**不在此弹卡**:审批坞(输入框上方)统一承载 ——
  // 内联卡依赖消息流渲染,折叠/滚走即「没有选择框」(用户实测);坞卡直接持 requestId 回包,
  // 连 tool_use_id 配对都不依赖。待批期间此处照常渲染步骤视图(审批坞负责决策)。
  if (isPermissionDenied(block) && !resolvedApprovals?.has(block.id)) {
    // P1:用 InteractivePanel 统一驱动(把 approval 适配成 1-step InteractiveRequest)。
    // rows 顺序约定:[allow(默认), __allowAlways__(标 allowAlways 行), __deny__(标 deny 行)]
    //  — 行即动作:点击 / 数字键直接派发,Enter 按 highlighted 派发;面板底部只留键位提示(2026-10-27 收敛,替代旧「rows + 底部三按钮」重复)。
    const cmdValue = config.getValue?.(block.input) ?? "";
    const detail = cmdValue ? (
      <pre className="mx-scroll max-h-24 min-w-0 overflow-auto break-all rounded bg-[var(--mx-bg-soft)] px-2 py-1 text-[11px] text-[var(--mx-muted)]">
        <code>{cmdValue}</code>
      </pre>
    ) : null;
    const approvalRequest: import("../domain/interactive").InteractiveRequest = {
      kind: "approval",
      id: block.id,
      title: config.label ?? block.name,
      steps: [
        {
          prompt: "",
          header: config.label ?? block.name,
          detail,
          rows: [
            { label: t("interactive.allowOnce") },
            { label: "__allowAlways__" },
            { label: "__deny__" },
          ],
        },
      ],
    };
    const alwaysLabel = deriveAlwaysAllowLabel(block.name, config.label);
    return (
      <InteractivePanel
        request={approvalRequest}
        t={t}
        alwaysAllowLabel={alwaysLabel ?? undefined}
        onAnswer={(ans) => {
          if (ans.kind !== "approval") return;
          if (ans.decision === "allow") onApproveTool?.(block, false);
          else if (ans.decision === "allowAlways") onApproveTool?.(block, true);
          else onRejectTool?.(block, ans.message);
        }}
      />
    );
  }
  if (config.variant === "diff") {
    return <DiffToolView block={block} config={config} t={t} />;
  }
  if (config.variant === "todo") {
    return <TodoToolView block={block} config={config} t={t} />;
  }
  if (config.variant === "bash") {
    return <BashToolView block={block} config={config} t={t} commandOpen={bashCommandOpen} />;
  }
  if (config.variant === "task") {
    return <TaskToolView block={block} config={config} t={t} />;
  }
  return <DefaultToolView block={block} config={config} t={t} />;
}

/**
 * Plan 决策卡(exit_plan_mode)——参考 cursor / claudecodeui 的选项卡式确认条。
 *
 * 卡片三段:标题行(✓ 计划已就绪)+ 计划正文(markdown 渲染,可滚动)+ 底部决策条
 * [批准执行](indigo 实心,主操作)+ [拒绝/修改](ghost 边框,聚焦输入框让用户说明)。
 *
 * 批准→切 auto 模式 + 中断当前 plan 轮 + 发「批准该计划,开始执行」(下一轮 --resume 续接,自动落地)。
 * 拒绝→不切模式,聚焦输入框(用户在输入框说明修改意见,下一轮 resume 时 Claude 看到)。
 * headless 下 exit_plan_mode 后 Claude 进程已退出,此卡即「暂停等待用户决策」的锚点。
 */
function PlanToolView({
  block,
  config,
  t,
  onApprove,
  onReject,
}: {
  block: Extract<ClaudeBlock, { type: "tool_use" }>;
  config: ToolDisplayConfig;
  t: (k: string) => string;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const plan = config.getValue?.(block.input) ?? "";
  const hasPlanText = !!plan && plan !== "implementation plan";
  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-[var(--mx-indigo-border)] bg-[var(--mx-indigo-soft)] shadow-[0_0_0_1px_var(--mx-indigo-soft)]">
      {/* 标题行 */}
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" aria-hidden>
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        <span className="font-semibold text-[var(--mx-violet)]">{t("claudepane.planReady")}</span>
      </div>
      {/* 计划正文(markdown 渲染,与 assistant 正文一致风格) */}
      {hasPlanText && (
        <div className="mx-scroll max-h-[40vh] overflow-auto border-t border-[var(--mx-indigo-border)] px-3 py-2.5 leading-relaxed text-[var(--mx-text)]">
          <Suspense fallback={<div className="text-[11px] text-[var(--mx-muted)]">{t("common.loading")}</div>}>
            <MdPreviewLazy content={plan} inline />
          </Suspense>
        </div>
      )}
      {/* 决策选项卡:[批准执行](主) / [拒绝/修改](次) */}
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--mx-indigo-border)] bg-[var(--mx-indigo-soft)] px-3 py-2">
        <button
          type="button"
          onClick={onApprove}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--mx-accent-deep)] px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-[var(--mx-accent-deep)]"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
            <path d="M20 6L9 17l-5-5" />
          </svg>
          {t("claudepane.approve")}
        </button>
        <button
          type="button"
          onClick={onReject}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--mx-border-strong)] bg-transparent px-3 py-1.5 text-[11px] font-medium text-[var(--mx-muted)] transition-colors hover:border-[var(--mx-border-strong)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
          {t("claudepane.reject")}
        </button>
        <span className="text-[10px] text-[var(--mx-faint)]">{t("claudepane.approveHint")}</span>
      </div>
    </div>
  );
}

/**
 * 权限确认卡(被拒的敏感操作)——参考 claude cli 权限菜单 + cursor 决策条。
 *
 * claude headless 下未授权的敏感操作(写文件/非只读命令)被拒 → 此卡替代静态 denied 药丸,
 * 给用户多选项:批准本次 / 批准且不再问[工具](持久化)/ 拒绝(发消息)/ 反馈修改(聚焦输入框)。
 * 批准 → transport.approveToolRun(本地执行 + tool_result 原地回传,busy 自愈);
 * 拒绝 → transport.rejectTool 发拒绝消息;反馈 → 聚焦输入框。
 * 卡片三段:标题行(⚠ + 工具名 + 摘要 + 需批准药丸)+ 次要文本 + 决策条 4 按钮。
 * 决策条键盘流(焦点留在输入框,不抢焦点):输入框空且无面板时 ←→ 移动高亮(activeIdx 由
 * ClaudePane 的 approvalFocusIdx 驱动,非 DOM 焦点)、Enter 触发——见 ClaudePane 输入框
 * onKeyDown 与 activeApproval 派生。按钮本身仍可鼠标点击/Tab 聚焦。
 */
function PermissionConfirmCard({
  block,
  config,
  t,
  activeIdx,
  onApproveOnce,
  onApprovePersist,
  onReject,
  onDeny,
  onFeedback,
}: {
  block: Extract<ClaudeBlock, { type: "tool_use" }>;
  config: ToolDisplayConfig;
  t: (k: string) => string;
  /** 键盘流高亮索引(0-3;-1=非当前控制卡)。 */
  activeIdx: number;
  onApproveOnce?: () => void;
  onApprovePersist?: () => void;
  /** 切到 deny-mode(就地展开 deny reason 文本框)。 */
  onReject?: () => void;
  /** 提交带 reason 的拒绝(reason 拼进 tool_result content,Claude 据此调整)。 */
  onDeny?: (reason: string) => void;
  onFeedback?: () => void;
}) {
  const [denyMode, setDenyMode] = useState(false);
  const [denyReason, setDenyReason] = useState("");
  const value = config.getValue?.(block.input) ?? "";
  const secondary = config.getSecondary?.(block.input);
  const badge = config.getBadge?.(block.input);
  const focusRing = (i: number) =>
    i === activeIdx ? " ring-1 ring-[var(--mx-accent-bright)] ring-offset-0" : "";
  // Tab 键盘聚焦仍有原生 outline 提示(键盘流 ring 与 DOM 焦点是两套,鼠标点击不显 outline)。
  const focusVisible = " focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-[var(--mx-accent-bright)]";
  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-[var(--mx-orange-border)] bg-[var(--mx-orange-soft)] shadow-[0_0_0_1px_var(--mx-orange-soft)]">
      {/* 标题行:⚠ + 工具名 + 摘要 + Edit/New badge + 「需手动批准」药丸 */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fb923c" strokeWidth="2" aria-hidden>
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <path d="M12 9v4M12 17h.01" />
        </svg>
        <span className="font-semibold text-[var(--mx-warning)]">{t("claudepane.approvalTitle")}</span>
        <span className="font-mono text-[11px] text-[var(--mx-text)]">{config.label ?? block.name}</span>
        {value && <span className="truncate text-[11px] text-[var(--mx-muted)]">{value}</span>}
        {badge && (
          <span
            className="rounded px-1.5 py-px text-[9px] font-semibold"
            style={{
              background: badge.tone === "new" ? "var(--mx-success-soft)" : "var(--mx-warning-soft)",
              color: badge.tone === "new" ? "var(--mx-success-bright)" : "var(--mx-warning-bright)",
            }}
          >
            {badge.text}
          </span>
        )}
        <span
          className="ml-auto inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10px] font-medium leading-[1.4]"
          style={{ background: "var(--mx-warning-soft)", color: "#fdba74" }}
        >
          {t("claudepane.permissionDenied")}
        </span>
      </div>
      {secondary && (
        <div className="border-t border-[var(--mx-orange-border)] px-3 py-1.5 text-[11px] italic text-[var(--mx-muted)]">
          {secondary}
        </div>
      )}
      {/* 决策条:批准本次(主) / 批准且不再问(indigo 边框) / 拒绝(ghost) / 反馈修改(faint ghost)。
          无图标紧凑档(px-2.5 py-1);键盘流在输入框操作(空输入 ←→/Enter,见组件头注释)。 */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--mx-orange-border)] bg-[var(--mx-orange-soft)] px-3 py-1.5">
        <button
          type="button"
          onClick={onApproveOnce}
          className={"inline-flex items-center rounded-md bg-[var(--mx-accent-deep)] px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-[var(--mx-accent-deep)] focus:outline-none" + focusVisible + focusRing(0)}
        >
          {t("claudepane.approveOnce")}
        </button>
        <button
          type="button"
          onClick={onApprovePersist}
          className={"inline-flex items-center rounded-md border border-[var(--mx-indigo-border)] bg-transparent px-2.5 py-1 text-[11px] font-medium text-[var(--mx-violet)] transition-colors hover:border-[var(--mx-indigo-border)] hover:bg-[var(--mx-indigo-soft)] focus:outline-none" + focusVisible + focusRing(1)}
        >
          {deriveAlwaysAllowLabel(block.name, config.label) ?? t("claudepane.approvePersist")}
        </button>
        <button
          type="button"
          onClick={() => {
            setDenyMode(true);
            onReject?.();
          }}
          className={"inline-flex items-center rounded-md border border-[var(--mx-border-strong)] bg-transparent px-2.5 py-1 text-[11px] font-medium text-[var(--mx-muted)] transition-colors hover:border-[var(--mx-border-strong)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)] focus:outline-none" + focusVisible + focusRing(2)}
        >
          {t("claudepane.reject")}
        </button>
        <button
          type="button"
          onClick={onFeedback}
          className={"inline-flex items-center rounded-md border border-[var(--mx-border-strong)] bg-transparent px-2.5 py-1 text-[11px] font-medium text-[var(--mx-faint)] transition-colors hover:border-[var(--mx-border-strong)] hover:bg-[var(--mx-border-soft)] hover:text-[var(--mx-muted)] focus:outline-none" + focusVisible + focusRing(3)}
        >
          {t("claudepane.feedback")}
        </button>
        <span className="ml-auto shrink-0 text-[10px] text-[var(--mx-faint)]">{t("claudepane.approvalKeysHint")}</span>
      </div>
      {/* deny-mode:就地表单(借鉴 BaoCode interaction_panel.dart deny 行 textHint)。
          点击 reject 后展开,reason 拼进 tool_result content,Claude 据此调整替代路径。 */}
      {denyMode && (
        <div className="space-y-1.5 border-t border-[var(--mx-orange-border)] bg-[var(--mx-orange-soft)] px-3 py-2">
          <label className="block text-[11px] font-medium text-[var(--mx-text)]">
            {t("claudepane.denyReasonTitle")}
          </label>
          <textarea
            autoFocus
            rows={2}
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            placeholder={t("claudepane.denyReasonPlaceholder")}
            className="block w-full resize-y rounded-md border border-[var(--mx-orange-border)] bg-transparent px-2 py-1.5 text-[11px] text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)] focus:border-[var(--mx-orange-border)] focus:ring-1 focus:ring-[var(--mx-orange-border)]"
          />
          <p className="text-[10px] text-[var(--mx-faint)]">{t("claudepane.denyReasonHint")}</p>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setDenyMode(false);
                setDenyReason("");
              }}
              className="inline-flex items-center rounded-md border border-[var(--mx-border-strong)] bg-transparent px-2.5 py-1 text-[11px] font-medium text-[var(--mx-muted)] transition-colors hover:border-[var(--mx-border-strong)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
            >
              {t("claudepane.denyCancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                onDeny?.(denyReason);
                setDenyMode(false);
                setDenyReason("");
              }}
              className="inline-flex items-center rounded-md bg-[var(--mx-accent-deep)] px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-[var(--mx-accent-deep)] focus:outline-none"
            >
              {t("claudepane.denySubmit")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Task/subagent 视图——单独展开查看子 agent 的完整输出。
 *
 * header:「Task」步骤行(动词 claude 色)+ description 摘要 + 状态药丸。
 * 展开:result(subagent 回复,通常是 markdown 文本)用 MdPreview 渲染 + 大区域可滚动(max-h-[60vh]),
 * 不再挤在小 pre 里——多个 task 各自独立展开查看。
 */
function TaskToolView({
  block,
  config,
  t,
}: {
  block: Extract<ClaudeBlock, { type: "tool_use" }>;
  config: ToolDisplayConfig;
  t: (k: string) => string;
}) {
  const status = deriveToolStatus(block);
  const isError = block.result?.isError === true;
  const hasResult = !!block.result;
  const [open, setOpen] = useState(config.defaultOpen ?? true);
  const autoExpanded = useRef(false);
  // 结果到达(尤其出错)时确保展开,让用户看到子 agent 输出。
  useEffect(() => {
    if (!autoExpanded.current && hasResult) {
      autoExpanded.current = true;
      setOpen(true);
    }
  }, [hasResult]);

  return (
    <StepCard className={isError ? "border-[var(--mx-danger-border)]" : ""}>
      <StepRow
        // 子 agent 步骤图标:speak-ai-line(琥珀),「有人在说话」,对齐 baocode
        // tool_call_row 的 ToolKind.message 图标语义。
        icon={<SpeakAiIcon className="h-[15px] w-[15px] text-(color:--mx-warning)" />}
        verb={t(toolStepVerbKey(block.name, status))}
        object={toolStepObject(block.name, block.input)}
        detail={toolStepDetail(block.name, block.input)}
        running={status === "running"}
        expanded={open}
        onToggle={() => setOpen((p) => !p)}
        verbColor="var(--mx-claude)"
        testId="task-step"
      />
      {/* running 中也可展开:先看「子代理运行中」占位,result 到达后原地换成正文。 */}
      {open && (hasResult || status === "running") && (
        <StepBody
          maxHeight={480}
          className={isError ? "text-[var(--mx-danger-bright)]" : ""}
        >
          {!block.result ? (
            <div className="flex items-center gap-2 text-[11px] text-(color:--mx-faint)">
              <ThinkingDots />
              {t("claudepane.toolRunning")}
            </div>
          ) : isError ? (
            <pre className="whitespace-pre-wrap break-words font-mono">{block.result.content}</pre>
          ) : (
            <Suspense fallback={<div className="text-[11px] text-(color:--mx-muted)">{t("common.loading")}</div>}>
              <MdPreviewLazy content={block.result.content} />
            </Suspense>
          )}
        </StepBody>
      )}
    </StepCard>
  );
}

/** 状态药丸(参考 claudecodeui ToolStatusBadge):小药丸 text-[10px] 四态。 */
function ToolStatusBadge({ status, t }: { status: ToolBadgeStatus; t: (k: string) => string }) {
  const map: Record<ToolBadgeStatus, { label: string; bg: string; fg: string }> = {
    running: { label: t("claudepane.toolRunning"), bg: "var(--mx-info-soft)", fg: "var(--mx-info)" },
    completed: { label: t("claudepane.toolDone"), bg: "var(--mx-success-soft)", fg: "var(--mx-success-bright)" },
    error: { label: t("claudepane.permissionDenied"), bg: "var(--mx-danger-bg)", fg: "var(--mx-danger-bright)" },
    denied: { label: t("claudepane.permissionDenied"), bg: "var(--mx-warning-soft)", fg: "var(--mx-warning-bright)" },
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
 * Bash 专用视图。
 *
 * BaoCode 式一行:「运行了 bun test · Run tests」(动词绿色,与 ShellRow 的 `$` 同语义),
 * 有输出时点击展开深底输出框;折叠时尾随显示行数,running 时 spinner,否则状态药丸。
 */
function BashToolView({
  block,
  config,
  t,
  commandOpen,
}: {
  block: Extract<ClaudeBlock, { type: "tool_use" }>;
  config: ToolDisplayConfig;
  t: (k: string) => string;
  /** 所在 steps/work fold 已展开(非段首)时 true:命令原文恒显 —— 展开折叠即读到全部
   *  执行过的命令,不必再逐行点开(用户反馈)。 */
  commandOpen?: boolean;
}) {
  const description = config.getSecondary?.(block.input);
  const output = block.result?.content ?? "";
  const hasOutput = output.trim().length > 0;
  const isError = block.result?.isError === true;
  const status = deriveToolStatus(block);
  const isRunning = status === "running";
  const lineCount = hasOutput ? output.replace(/\s+$/, "").split("\n").length : 0;
  const command = config.getValue?.(block.input) ?? "";
  // 输出/error 到达后自动展开(一次);之后用户自由折叠。
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
    <StepCard className={isError ? "border-[var(--mx-danger-border)]" : ""}>
      <StepRow
        verb={t(toolStepVerbKey(block.name, status))}
        object={toolStepObject(block.name, block.input) || t("claudepane.toolRunning")}
        detail={toolStepDetail(block.name, block.input)}
        running={isRunning}
        expanded={open}
        onToggle={toggle}
        verbColor="var(--mx-success)"
        title={command || undefined}
        testId="bash-step"
        trailing={
          <>
            {/* running 也显示命令复制钮(用户反馈:想手动复制正在运行的命令)。 */}
            <CopyButton
              text={command}
              t={t}
              className="shrink-0 opacity-0 transition-opacity group-hover/step:opacity-100"
            />
            {!isRunning && <ToolStatusBadge status={status} t={t} />}
            {!open && hasOutput && (
              <span className="shrink-0 text-[10px] tabular-nums text-(color:--mx-faint)">{lineCount} ln</span>
            )}
          </>
        }
      />
      {/* 命令原文:① fold 展开时段内恒显(展开即读全部命令,用户反馈);② running 且本行展开时
          显示(可看可复制,昨轮反馈)。输出到达后原地接上。 */}
      {command && (commandOpen || (isRunning && open)) && (
        <pre className="mx-scroll-pretty max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--mx-bg-soft)] px-2 py-1 font-mono text-[11px] text-(color:--mx-muted)">{command}</pre>
      )}
      {/* running 中也可展开:输出到达后原地接上并自动贴底。 */}
      {open && (hasOutput || isRunning) && (
        <StepBody maxHeight={288} followEnd={isRunning}>
          {description && (
            <div className="mb-1 text-[10px] italic text-(color:--mx-faint)">{description}</div>
          )}
          {hasOutput ? (
            <pre
              className={`whitespace-pre-wrap break-all font-mono leading-relaxed ${
                isError ? "text-[var(--mx-danger-bright)]" : "text-(color:--mx-muted)"
              }`}
            >
              {output.replace(/\s+$/, "")}
            </pre>
          ) : (
            <div className="flex items-center gap-2 text-[11px] text-(color:--mx-faint)">
              <ThinkingDots />
              {t("claudepane.toolRunning")}
            </div>
          )}
        </StepBody>
      )}
    </StepCard>
  );
}

/**
 * Edit/MultiEdit/Write diff 视图 —— 红绿行级 + 词级高亮(自写 LCS,见 domain/diff.ts)。
 *
 * header 是一行 StepRow(「编辑了 app.ts」),尾随 +N -M 行数统计与「在文件夹中显示」按钮
 * (hover 才浮现,全路径走 hover title);展开显示 diff 块:
 * - Edit:old_string → new_string 单个 diff
 * - MultiEdit:edits[] 每个 {old_string,new_string} 独立 diff,序号标注
 * - Write:content 全绿(新文件)
 */
function DiffToolView({
  block,
  config,
  t,
}: {
  block: Extract<ClaudeBlock, { type: "tool_use" }>;
  config: ToolDisplayConfig;
  t: (k: string) => string;
}) {
  const status = deriveToolStatus(block);
  const badge = config.getBadge?.(block.input);
  const [open, setOpen] = useState(config.defaultOpen ?? true);
  const segments = useMemo(() => extractDiffSegments(block), [block]);
  /** 文件绝对路径(点击 → 资源管理器定位该文件,类 claude code 的文件超链接;编辑与否用户自决)。 */
  const filePath = useMemo(() => {
    const fp = (block.input as Record<string, unknown> | null)?.file_path;
    return typeof fp === "string" ? fp : "";
  }, [block]);

  return (
    <StepCard>
      {/* 编辑读作一行:「编辑了 app.ts · +12 -3」;全路径 hover 可见,尾随文件夹按钮定位。 */}
      <StepRow
        verb={t(toolStepVerbKey(block.name, status))}
        object={toolStepObject(block.name, block.input)}
        detail={toolStepDetail(block.name, block.input)}
        running={status === "running"}
        expanded={open}
        onToggle={() => setOpen((p) => !p)}
        title={toolStepTitle(block.name, block.input) ?? undefined}
        testId="diff-step"
        trailing={
          <>
            {badge && (
              <span className="shrink-0 rounded px-1 py-px text-[9px] font-semibold" style={{ background: badge.tone === "new" ? "var(--mx-success-soft)" : "var(--mx-warning-soft)", color: badge.tone === "new" ? "var(--mx-success-bright)" : "var(--mx-warning-bright)" }}>{badge.text}</span>
            )}
            {segments.stats && (
              <span className="text-[10px] tabular-nums">
                <span className="text-[var(--mx-success-bright)]">+{segments.stats.add}</span>{" "}
                <span className="text-[var(--mx-danger-bright)]">-{segments.stats.del}</span>
              </span>
            )}
            {filePath && (
              <button
                type="button"
                title={`${t("claudepane.revealInFolder")} ${filePath}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void invoke("reveal_in_folder", { path: filePath }).catch(() => {});
                }}
                className="shrink-0 rounded p-0.5 text-(color:--mx-faint) opacity-0 transition-opacity hover:text-[var(--mx-text)] group-hover/step:opacity-100"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
              </button>
            )}
            {status !== "completed" && <ToolStatusBadge status={status} t={t} />}
          </>
        }
      />
      {open && (segments.diffs.length > 0 || block.result) && (
        <StepBody maxHeight={400}>
          {segments.diffs.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {segments.diffs.map((d, i) => (
                <DiffBlockView key={i} diff={d} index={segments.diffs.length > 1 ? i + 1 : null} />
              ))}
            </div>
          )}
          {block.result && (
            <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[10px] text-(color:--mx-muted)">
              {block.result.content}
            </pre>
          )}
        </StepBody>
      )}
    </StepCard>
  );
}

/** 从 tool_use input 提取 diff 段(Edit/MultiEdit/Write)+ 增删行统计。 */
function extractDiffSegments(block: Extract<ClaudeBlock, { type: "tool_use" }>): {
  diffs: { lines: DiffLine[]; label?: string }[];
  stats?: { add: number; del: number };
} {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const strOf = (o: unknown, k: string): string => {
    if (o && typeof o === "object" && k in (o as Record<string, unknown>)) {
      const v = (o as Record<string, unknown>)[k];
      if (typeof v === "string") return v;
    }
    return "";
  };
  // MultiEdit:edits[] 每个 {old_string, new_string}
  const editsRaw = Array.isArray(input.edits) ? input.edits : null;
  if (editsRaw && editsRaw.length > 0) {
    const diffs = editsRaw.map((e, i) => ({ lines: diffLines(strOf(e, "old_string"), strOf(e, "new_string")), label: `edit #${i + 1}` }));
    return { diffs, stats: sumDiffStats(diffs.map((d) => d.lines)) };
  }
  // Write:content 全绿(新文件)
  if (block.name === "Write") {
    const content = strOf(input, "content");
    const lines: DiffLine[] = content.split("\n").map((text) => ({ type: "add", text }));
    return { diffs: [{ lines, label: "new file" }], stats: { add: lines.length, del: 0 } };
  }
  // Edit:old_string → new_string
  const lines = diffLines(strOf(input, "old_string"), strOf(input, "new_string"));
  return { diffs: [{ lines }], stats: sumDiffStats([lines]) };
}

function sumDiffStats(grouped: DiffLine[][]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const lines of grouped) {
    for (const l of lines) {
      if (l.type === "add") add++;
      else if (l.type === "del") del++;
    }
  }
  return { add, del };
}

/** 单个 diff 块(红绿行 + 词级高亮)。 */
function DiffBlockView({ diff, index }: { diff: { lines: DiffLine[]; label?: string }; index: number | null }) {
  return (
    <div className="overflow-hidden rounded border border-[var(--mx-border)] bg-[var(--mx-surface-2)]">
      {diff.label && <div className="border-b border-[var(--mx-border)] px-2 py-0.5 text-[10px] text-[var(--mx-faint)]">{diff.label}</div>}
      <div className="mx-scroll-pretty max-h-[300px] overflow-auto font-mono text-[10px] leading-relaxed">
        {diff.lines.map((line, i) => (
          <DiffLineRow key={i} line={line} />
        ))}
      </div>
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const bg = line.type === "add" ? "bg-[var(--mx-success-soft)]" : line.type === "del" ? "bg-[var(--mx-danger-bg)]" : "";
  const color = line.type === "add" ? "text-[var(--mx-success-bright)]" : line.type === "del" ? "text-[var(--mx-danger-bright)]" : "text-[var(--mx-muted)]";
  const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return (
    <div className={`flex ${bg} ${color} px-2`}>
      <span className="w-4 flex-shrink-0 select-none text-center opacity-60">{sign}</span>
      <span className="whitespace-pre-wrap break-all">
        {line.words && line.words.length > 0
          ? line.words.map((w, i) => (
              <span key={i} className={w.kind === "add" ? "bg-[var(--mx-success-soft)]" : w.kind === "del" ? "bg-[var(--mx-danger-border)]" : ""}>{w.text}</span>
            ))
          : line.text || " "}
      </span>
    </div>
  );
}

/**
 * TodoWrite checklist 视图 —— pending/in_progress/completed 状态色 + 划线。
 *
 * header 显示完成统计(✓N ◐M ○K);展开渲染 todos 清单。取最新一次 TodoWrite
 * (stream-json 多次发,applyEvent 已用 tool_use id 覆盖最新)。
 */
function TodoToolView({
  block,
  config,
  t,
}: {
  block: Extract<ClaudeBlock, { type: "tool_use" }>;
  config: ToolDisplayConfig;
  t: (k: string) => string;
}) {
  const status = deriveToolStatus(block);
  const todos = useMemo(() => extractTodos(block), [block]);
  const [open, setOpen] = useState(config.defaultOpen ?? true);
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const td of todos) {
    const k = td.status in counts ? (td.status as keyof typeof counts) : "pending";
    counts[k]++;
  }

  return (
    <StepCard>
      {/* 待办读作一行:「更新了待办 · 3 · 1/3」;尾随 ✓/◐/○ 统计。 */}
      <StepRow
        verb={t(toolStepVerbKey(block.name, status))}
        object={toolStepObject(block.name, block.input)}
        detail={toolStepDetail(block.name, block.input)}
        running={status === "running"}
        expanded={open}
        onToggle={() => setOpen((p) => !p)}
        testId="todo-step"
        trailing={
          <>
            <span className="text-[10px] tabular-nums">
              <span className="text-[var(--mx-success)]">✓{counts.completed}</span>{" "}
              <span className="text-[var(--mx-claude)]">◐{counts.in_progress}</span>{" "}
              <span className="text-(color:--mx-faint)">○{counts.pending}</span>
            </span>
            {status !== "completed" && <ToolStatusBadge status={status} t={t} />}
          </>
        }
      />
      {open && todos.length > 0 && (
        <StepBody maxHeight={360}>
          <div className="flex flex-col gap-0.5">
            {todos.map((td, i) => (
              <TodoRow key={i} todo={td} />
            ))}
          </div>
        </StepBody>
      )}
    </StepCard>
  );
}

function TodoRow({ todo }: { todo: { content: string; status: string } }) {
  const s = todoStyle(todo.status);
  return (
    <div className={`flex items-start gap-1.5 rounded px-2 py-0.5 text-[11px] ${s.bg}`}>
      <span className="flex-shrink-0 font-mono leading-relaxed" style={{ color: s.color }} aria-hidden>{s.icon}</span>
      <span className={`min-w-0 break-words leading-relaxed ${s.strike} ${todo.status === "completed" ? "text-[var(--mx-faint)]" : "text-[var(--mx-text)]"}`}>
        {todo.content || "(empty)"}
      </span>
    </div>
  );
}

/** 从 TodoWrite input 提取 todos 列表(content/status)。 */
function extractTodos(block: Extract<ClaudeBlock, { type: "tool_use" }>): { content: string; status: string }[] {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return todos.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      content: typeof o.content === "string" ? o.content : "",
      status: typeof o.status === "string" ? o.status : "pending",
    };
  });
}

function todoStyle(status: string): { icon: string; color: string; strike: string; bg: string } {
  switch (status) {
    case "completed":
      return { icon: "✓", color: "#4ade80", strike: "line-through", bg: "" };
    case "in_progress":
      return { icon: "◐", color: "var(--mx-claude)", strike: "", bg: "bg-[var(--mx-claude-soft)]" };
    case "cancelled":
      return { icon: "✕", color: "#64748b", strike: "line-through", bg: "" };
    case "pending":
    default:
      return { icon: "○", color: "#94a3b8", strike: "", bg: "" };
  }
}

/**
 * 通用工具视图——兜底(未配专门 variant 的工具都走这里)。
 *
 * 一行 StepRow:动词(「调用了」/「正在调用」)+ 目标(input 里最可辨识的字符串,
 * 无则退回工具名)+ 细节 + badge + 状态药丸(右)。
 * 展开:input JSON + result(深底框)。
 *
 * **hideOnSuccess**:成功时默认折叠(只显示一行);出错(isError)或显式 defaultOpen
 * 时自动展开。
 */
function DefaultToolView({
  block,
  config,
  t,
}: {
  block: Extract<ClaudeBlock, { type: "tool_use" }>;
  config: ToolDisplayConfig;
  t: (k: string) => string;
}) {
  const status = deriveToolStatus(block);
  const secondary = config.getSecondary?.(block.input);
  const badge = config.getBadge?.(block.input);
  const isError = block.result?.isError === true;
  const hasResult = !!block.result;

  // hideOnSuccess:成功 → 折叠(只显示一行);出错 → 自动展开;config.defaultOpen 强制开。
  const [open, setOpen] = useState(config.defaultOpen ?? false);
  // 出错自动展开(一次):result 到达且 isError 时强制 open,不论初始。
  const autoExpanded = useRef(false);
  useEffect(() => {
    if (!autoExpanded.current && hasResult && isError) {
      autoExpanded.current = true;
      setOpen(true);
    }
  }, [hasResult, isError]);

  return (
    <StepCard>
      {/* 通用工具读作一行:「调用了 SomeTool · 参数摘要」;无目标时退回工具名,行不至于空。 */}
      <StepRow
        verb={t(toolStepVerbKey(block.name, status))}
        object={toolStepObject(block.name, block.input) || config.label || block.name}
        detail={toolStepDetail(block.name, block.input) ?? secondary}
        running={status === "running"}
        expanded={open}
        onToggle={() => setOpen((p) => !p)}
        title={toolStepTitle(block.name, block.input) ?? undefined}
        testId="tool-step"
        trailing={
          <>
            {badge && (
              <span
                className="flex-shrink-0 rounded px-1 py-px text-[9px] font-semibold"
                style={{
                  background: badge.tone === "new" ? "var(--mx-success-soft)" : "var(--mx-border)",
                  color: badge.tone === "new" ? "var(--mx-success-bright)" : "var(--mx-text)",
                }}
              >
                {badge.text}
              </span>
            )}
            {status !== "completed" && <ToolStatusBadge status={status} t={t} />}
          </>
        }
      />
      {open && (
        <StepBody maxHeight={360}>
          <div className="flex flex-col gap-2">
            {/* input JSON(折叠详情) */}
            {block.input !== undefined && block.input !== null && (
              <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-(color:--mx-muted)">
                {formatInput(block.input)}
              </pre>
            )}
            {/* result */}
            {block.result && (
              <div className="group/result relative">
                <CopyButton
                  text={block.result.content}
                  t={t}
                  className="absolute right-1 top-1 z-10 rounded bg-[var(--mx-surface-2)] px-1 py-0.5 opacity-0 transition-opacity group-hover/result:opacity-100"
                />
                <pre
                  className={`whitespace-pre-wrap break-words font-mono text-[10px] ${
                    isError
                      ? "rounded border border-[var(--mx-danger-border)] bg-[var(--mx-danger-bg)] p-2 text-[var(--mx-danger-bright)]"
                      : "text-(color:--mx-muted)"
                  }`}
                >
                  {isError ? `${t("claudepane.permissionDenied")}\n\n` : ""}
                  {block.result.content}
                </pre>
              </div>
            )}
          </div>
        </StepBody>
      )}
    </StepCard>
  );
}

/**
 * 解析 ~/.claude.json(/mcp 弹窗):顶层全局 `mcpServers` + `projects[cwd].mcpServers`
 * (cwd = 当前会话工作区)。条目摘要:HTTP/SSE 型显 url,stdio 型显 command + 前两个 args。
 * JSON 不合法(被 read_file 512KB 截断/损坏)返回 [] 由空态文案兜底。
 */
function parseClaudeMcpServers(
  raw: string,
  cwd: string | undefined,
): { scope: "global" | "project"; name: string; brief: string }[] {
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!cfg || typeof cfg !== "object") return [];
  const root = cfg as Record<string, unknown>;
  const out: { scope: "global" | "project"; name: string; brief: string }[] = [];
  const push = (obj: unknown, scope: "global" | "project") => {
    if (!obj || typeof obj !== "object") return;
    for (const [name, v] of Object.entries(obj)) {
      const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      const brief =
        typeof s.url === "string" && s.url
          ? `url: ${s.url}`
          : typeof s.command === "string" && s.command
            ? [
                s.command,
                ...(Array.isArray(s.args) ? s.args.slice(0, 2).map(String) : []),
              ].join(" ")
            : "";
      out.push({ scope, name, brief });
    }
  };
  push(root.mcpServers, "global");
  if (cwd) {
    const projects = root.projects;
    if (projects && typeof projects === "object") {
      const proj = (projects as Record<string, unknown>)[cwd];
      if (proj && typeof proj === "object") {
        push((proj as Record<string, unknown>).mcpServers, "project");
      }
    }
  }
  return out;
}

/**
 * 解析项目根 .mcp.json(claude 官方 project scope,`claude mcp add -s project` 写入位置):
 * 结构 `{ "mcpServers": { <name>: { command/url/args } } }`,全部并入"本项目"组。
 * 不存在/损坏返回 [](read_file 对不存在文件本身 reject,由调用方 catch 兜底)。
 */
function parseProjectMcpJson(raw: string): { scope: "project"; name: string; brief: string }[] {
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!cfg || typeof cfg !== "object") return [];
  const servers = (cfg as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object") return [];
  const out: { scope: "project"; name: string; brief: string }[] = [];
  for (const [name, v] of Object.entries(servers)) {
    const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const brief =
      typeof s.url === "string" && s.url
        ? `url: ${s.url}`
        : typeof s.command === "string" && s.command
          ? [s.command, ...(Array.isArray(s.args) ? s.args.slice(0, 2).map(String) : [])].join(" ")
          : "";
    out.push({ scope: "project", name, brief });
  }
  return out;
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
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


// 拒绝内容拼装(纯函数 — 便于单测;借鉴 BaoCode interaction_panel.dart deny 行
// 把用户填的 reason 拼进 tool_result content,Claude 据此调整替代路径)。
function buildDenyContent(toolName: string, reason: string): string {
  const trimmed = reason.trim();
  return trimmed
    ? `User denied the ${toolName} tool call. Reason: ${trimmed}. Please suggest an alternative approach or ask for clarification.`
    : `User denied the ${toolName} tool call. Please suggest an alternative approach or ask for clarification.`;
}
