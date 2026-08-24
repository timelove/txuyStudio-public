import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { SettingsModal } from "./SettingsModal";
import { Dialog, DialogContent, DialogTitle } from "./ui/Dialog";
import { useTranslation } from "react-i18next";
import type { ShellKind, SplitDirection } from "../domain/paneTree";
import type { WorkspaceSession } from "../domain/sessions";
import type { ClaudeTransport } from "../domain/claudeTransport";
import type { ShellRunTransport } from "../domain/shellRunTransport";
import type { ShellMessage, ShellRunState } from "../domain/shellRun";
import type { BackgroundTaskInfo, ClaudeBlock, ClaudeMessage, ClaudeSessionKind, ClaudeStreamState, ClaudeUsage, CompactMeta } from "../domain/claudeStream";
import { hasPendingApproval as hasPendingApprovalFn, hasPendingPlan as hasPendingPlanFn, inferContextWindow, summarize } from "../domain/claudeStream";
import {
  getToolConfig,
  getToolCategory,
  categoryColor,
  deriveToolStatus,
  isPermissionDenied,
  type ToolDisplayConfig,
  type ToolBadgeStatus,
} from "../domain/claudeToolConfigs";
import { diffLines, type DiffLine } from "../domain/diff";
import { fetchAiCliSessions, mostRecentSessionInCwd, type AiCliSessionListItem } from "../domain/aiCliSessions";
import { useSettings } from "../settings/SettingsProvider";
import { statusFontSize } from "../settings";
import { ShellMenu } from "./ShellMenu";
import { SplitPaneButtons } from "./SplitPaneButtons";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./ui/Popover";
import { Button } from "./ui/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import { Tabs, TabsList, TabsTrigger } from "./ui/Tabs";


/** MdPreview 懒加载(避免 claudepane 首屏就拉 marked/dompurify,与探针共用 md-render 分包)。 */
const MdPreviewLazy = lazy(() =>
  import("./MdPreview").then((m) => ({ default: m.MdPreview })),
);

/** 统一 slash 命令形状(后端给 string[],兜底给带描述对象,归一成 SlashCmd)。 */
type SlashCmd = { name: string; description?: string };

/** 去掉命令名前导 /(claude init 的 slash_commands 可能是 "/clear" 或 "clear" 两种形态)。 */
function normalizeSlashCmds(raw: unknown): SlashCmd[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => {
      if (typeof c === "string") return { name: c.replace(/^\//, "") };
      if (typeof c === "object" && c && "name" in c) {
        const obj = c as SlashCmd;
        return { name: obj.name.replace(/^\//, ""), description: obj.description };
      }
      return null;
    })
    .filter((c): c is SlashCmd => c !== null);
}

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
 * claude CLI 原生 slash 命令完整集(带描述)。
 *
 * 后端 init 透传的 slash_commands 在 headless 模式下往往不全(rewind/skills/agents 等原生命令
 * 不返回),故前端维护一份完整原生集作兜底,与后端返回的合并去重(后端真实优先,描述缺则补)。
 * 后端额外返回的(skill 自定义命令等)也会被合并保留。
 *
 * 描述暂硬编码中文(命令面板提示文案);后续按需抽 i18n key。
 */
const FALLBACK_SLASH_CMDS: SlashCmd[] = [
  { name: "add-dir", description: "添加工作目录到上下文" },
  { name: "agents", description: "查看与管理子代理" },
  { name: "bug", description: "报告 bug 或问题" },
  { name: "clear", description: "清空对话上下文" },
  { name: "compact", description: "压缩对话历史以节省 token" },
  { name: "config", description: "查看与修改配置" },
  { name: "cost", description: "显示当前会话 token 用量与花费" },
  { name: "doctor", description: "诊断 Claude CLI 环境" },
  { name: "exit", description: "退出当前会话并关闭 tab" },
  { name: "export", description: "导出当前对话" },
  { name: "help", description: "查看可用命令与帮助" },
  { name: "init", description: "为当前项目初始化 CLAUDE.md" },
  { name: "login", description: "登录 Claude 账号" },
  { name: "logout", description: "退出 Claude 账号" },
  { name: "mcp", description: "查看与管理 MCP 服务器" },
  { name: "memory", description: "查看与编辑记忆文件" },
  { name: "model", description: "查看或切换模型" },
  { name: "permissions", description: "查看与修改工具权限" },
  { name: "privacy-settings", description: "查看隐私设置" },
  { name: "release-notes", description: "查看版本发布说明" },
  { name: "resume", description: "恢复指定会话" },
  { name: "review", description: "请求 Claude 复审代码" },
  { name: "rewind", description: "回溯到之前的对话状态" },
  { name: "skills", description: "查看与管理可用 Skills" },
  { name: "status", description: "查看 Claude CLI 状态" },
  { name: "terminal-setup", description: "配置终端集成(Shift+Enter 等)" },
  { name: "usage", description: "查看用量统计" },
  { name: "vim", description: "切换 vim 编辑模式" },
];

/**
 * claude 权限模式(--permission-mode),状态栏可切换 + Shift+Tab 循环。
 * id 传后端;label 状态栏显示;desc 菜单说明。
 */
const PERMISSION_MODES = [
  { id: "acceptEdits", label: "auto", desc: "自动接受文件编辑" },
  { id: "plan", label: "plan", desc: "计划模式(只读,先提方案)" },
  { id: "default", label: "default", desc: "每次操作都确认" },
  { id: "bypassPermissions", label: "yolo", desc: "跳过所有权限(谨慎)" },
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
        <span className="min-w-0 flex-1 truncate text-[var(--mx-muted)]" title={main.label}>
          {main.label}
        </span>
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
            <span className="min-w-0 flex-1 truncate text-[var(--mx-text)]" title={task.description}>
              {task.description || task.taskType}
            </span>
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
                className="shrink-0 rounded p-0.5 text-[var(--mx-faint)] opacity-0 transition-opacity hover:bg-[var(--mx-danger-bg)] hover:text-[#fca5a5] group-hover/task:opacity-100"
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
                  <svg className="mt-[4px] h-2.5 w-2.5 shrink-0" viewBox="0 0 24 24" fill="#fbbf24" aria-hidden>
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
                  <svg
                    className="mt-[3px] h-3 w-3 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={done ? "#86efac" : "#fca5a5"}
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
 * claude 自渲染对话面板(stream-json wrapper),Cursor 式行内流 UI。
 *
 * 不走 PTY/不渲染 claude TUI,而是消费后端 `claude-event` 事件流,用 React 自渲染对话流
 * + 行内可折叠工具卡片 + 底部圆角浮动输入区(slash 命令面板 / 发送 / 中断)。输入走原生
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
    className,
  } = props;
  const { t, i18n } = useTranslation();
  const { fontSize } = useSettings();
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
  /** 高亮层 div ref:同步 textarea 滚动(内容超 2 行时高亮跟随)。 */
  const highlightRef = useRef<HTMLDivElement | null>(null);
  // composing 不再用 state:textarea 始终可见文字(见下方 className),高亮层只画命令背景(文字透明),
  // 消除「透明 textarea + 高亮层文字」重叠导致的抗锯齿叠加发亮(IME 候选框弹出时色值变高亮的根因)。
  // textarea 始终可见也保证 IME 候选框/组合文字正常显示,无需在 compositionStart/End 切换样式。

  // —— slash 命令面板状态(对齐 claudecodeui useSlashCommands)——
  const slashCommands = state?.meta?.slashCommands ?? [];
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  /** 防抖后的查询词(去掉前导 /)。input 变化后 150ms 才更新,避免每次按键都过滤。 */
  const [commandQuery, setCommandQuery] = useState("");
  /** 当前触发命令面板的 `/` token 在 input 中的起始位置(插入替换用)。 */
  const slashPositionRef = useRef(-1);
  const queryTimerRef = useRef<number | null>(null);
  // —— @ 文件引用面板(复用 slash 触发模式:@ token → list_files → fuzzy → 选中插入 @path)——
  const [atOpen, setAtOpen] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [atQuery, setAtQuery] = useState("");
  const [atFiles, setAtFiles] = useState<{ path: string; name: string }[]>([]);
  const atPositionRef = useRef(-1);
  /** 已加载文件列表的 cwd(避免重复 list_files;cwd 变化时重载)。 */
  const atLoadedCwdRef = useRef<string | null>(null);
  // slash 命令逐个触发的弹窗状态(/config /help /cost)+ 不支持命令的内联提示。
  const [configOpen, setConfigOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  const [unsupportedMsg, setUnsupportedMsg] = useState<string | null>(null);
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
  const [rewindOpen, setRewindOpen] = useState(false);
  /** 模型选择器:每次打开时从后端 list_claude_models 实时拉取的可用 model id 列表(读 claude
   *  settings.json env,cc-switch 切供应商后下次打开即见新模型,无需改前端预置)。 */
  const [availableModels, setAvailableModels] = useState<string[]>([]);
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

  // unmount 时清理 slash 防抖 timer。
  useEffect(() => {
    return () => {
      if (queryTimerRef.current !== null) window.clearTimeout(queryTimerRef.current);
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

  // 打开 tab 即启动 claude 进程(拿 init 回填 model/cwd/slashCommands,状态栏打开即显示 model)。
  // 既有 lazy 启动(发消息才 spawn)改为打开即启动。start() 幂等(进程已在跑直接 return),切 tab 回来不重复 spawn;
  // 失败统一 handleEvent(terminated)(如 claude 未装,由 claudeMissing UI 覆盖显示)。probeDone 后才启动,
  // 避免探测未完成时 claudeMissing 恒 false 误触发 spawn。
  useEffect(() => {
    if (!activeTabId || !probeDone || claudeMissing) return;
    const transport = getClaudeTransportRef.current(activeTabId);
    console.log("[ClaudePane] start effect -> transport.start()", { activeTabId, probeDone, claudeMissing });
    void transport.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, probeDone, claudeMissing]);

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

  // 自动贴底:流式 token / 新消息 / 状态变化时,若用户未上滚(stickRef)则滚到底。
  // useLayoutEffect(paint 前同步跑)而非 useEffect,避免「先 paint 未滚、再滚」的 1 帧闪烁。
  // lastMsg 捕获流式 token 增长(applyEvent 每次给流式消息建新对象 -> ref 变 -> effect 触发)。
  const lastMsg = state && state.messages.length > 0 ? state.messages[state.messages.length - 1] : undefined;
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastMsg, state?.status]);
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

  // —— slash 面板:基于防抖后的 commandQuery 过滤候选(对齐 claudecodeui filterSlashCommands)——
  const slashMatches = useMemo<SlashCmd[]>(() => {
    if (!slashOpen) return [];
    // 合并后端真实 slash_commands ∪ FALLBACK 原生集,后端优先(描述缺则用 FALLBACK 补),去重。
    // headless 下后端返回的往往不全(rewind/skills/agents 等原生不返回),合并保证全量。
    const backend = normalizeSlashCmds(slashCommands);
    const byName = new Map<string, SlashCmd>();
    for (const fb of FALLBACK_SLASH_CMDS) byName.set(fb.name, fb);
    for (const b of backend) {
      const exist = byName.get(b.name);
      byName.set(b.name, exist && !exist.description ? { ...exist, description: b.description } : b);
    }
    const all = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    // commandQuery 已去前导 /(handleInputChange 里 strip)。空 query 显示全部。
    const q = commandQuery.trim().toLowerCase();
    if (!q) return all;
    // 前缀匹配优先(更符合直觉),不足时回退子串/描述包含。
    const namePrefix = all.filter((c) => c.name.toLowerCase().startsWith(q));
    if (namePrefix.length > 0) return namePrefix;
    return all.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.description?.toLowerCase().includes(q) ?? false),
    );
  }, [slashOpen, commandQuery, slashCommands]);

  /** 已知 slash 命令名集合(后端真实 ∪ FALLBACK),用于判定输入框中哪些 /xxx token 是命令名(高亮)vs 路径参数(不高亮)。 */
  const knownCmdNames = useMemo(() => {
    const set = new Set<string>();
    for (const fb of FALLBACK_SLASH_CMDS) set.add(fb.name);
    for (const c of normalizeSlashCmds(slashCommands)) set.add(c.name);
    return set;
  }, [slashCommands]);

  /**
   * 渲染输入框高亮层:命令 token(行首/空格后的 /xxx 且 xxx 是已知命令)套 chip 背景色,与后续参数文字区分。
   * 纯背景色 + 圆角,不加 padding/border/margin--否则 token 渲染宽度变化,与透明 textarea 文字逐字错位。
   * 非已知命令的 /xxx(如路径参数 /abs/path)不高亮,避免误判。
   */
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

  // 候选变化时重置选中索引。
  useEffect(() => {
    setSlashIndex(0);
  }, [slashMatches.length]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      const cursorPos = e.target.selectionStart ?? v.length;
      setInput(v);

      // 代码块内(``` 计数为奇数)不触发命令/@面板,避免写代码时干扰。
      const backticksBefore = (v.slice(0, cursorPos).match(/```/g) || []).length;
      if (backticksBefore % 2 === 1) {
        setSlashOpen(false);
        setAtOpen(false);
        slashPositionRef.current = -1;
        atPositionRef.current = -1;
        return;
      }

      const textBeforeCursor = v.slice(0, cursorPos);

      // @ 文件引用:光标前 @token(行首/空格后)→ 触发文件列表 Popover(fuzzy 过滤)。
      const atMatch = textBeforeCursor.match(/(?:^|\s)@(\S*)$/);
      if (atMatch) {
        atPositionRef.current = (atMatch.index ?? 0) + (atMatch[0].length - atMatch[1].length - 1);
        setAtOpen(true);
        setAtIndex(0);
        setAtQuery(atMatch[1]);
        setSlashOpen(false);
        slashPositionRef.current = -1;
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

      // 匹配「光标前以 / 开头的 token」(行首或空格后),支持文中触发,不限输入框开头。
      const match = textBeforeCursor.match(/(?:^|\s)(\/\S*)$/);
      if (!match) {
        setSlashOpen(false);
        slashPositionRef.current = -1;
        return;
      }
      // / 在全文中的实际位置。
      const slashPos = (match.index ?? 0) + (match[0].length - match[1].length);
      const query = match[1].slice(1); // 去前导 /
      slashPositionRef.current = slashPos;
      setSlashOpen(true);
      setSlashIndex(-1);

      // 防抖 150ms 更新 query(避免每次按键都过滤 + 重渲染)。
      if (queryTimerRef.current !== null) window.clearTimeout(queryTimerRef.current);
      queryTimerRef.current = window.setTimeout(() => setCommandQuery(query), 150);
    },
    [state],
  );

  const applySlashCommand = useCallback(
    (cmd: SlashCmd) => {
      const ta = inputRef.current;
      // 触发式:/ 指令选中即执行(不把命令文本插入输入框——/ 指令是「触发」不是「输入」)。
      // 先清掉触发的 /token(保留 token 之外的其余输入),关面板,再按命令分发:
      //   /clear → 清空会话;/exit → 关闭 tab;其他 → 作为消息发给 claude(选中即触发)。
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

      const transport = getClaudeTransportRef.current(activeTabId);
      // 逐个触发:/ 指令不再作为消息发给 claude(headless 下无效),按命令名 dispatch 到对应前端能力。
      switch (cmd.name) {
        case "clear":
          void transport.clear();
          break;
        case "exit":
          onCloseTab?.(paneId, activeTabId);
          break;
        case "config":
        case "permissions":
          setConfigOpen(true);
          break;
        case "help":
          setHelpOpen(true);
          break;
        case "cost":
        case "usage":
        case "status":
          setCostOpen(true);
          break;
        case "agents":
        case "skills":
        case "mcp": {
          // 打开 claude 配置位置(agents/skills 目录 / mcp 的 .claude.json)用系统默认程序管理。
          invoke<string>("get_claude_config_path", { target: cmd.name })
            .then((p) => void openPath(p).catch(() => {}))
            .catch(() => setUnsupportedMsg(t("claudepane.unsupported", { cmd: `/${cmd.name}` })));
          break;
        }
        case "compact": {
          // 真 compact:写 stdin /compact(local command),后端长进程执行,产出 compact_status/
          // compact_boundary 事件 → applyEvent 归并成 boundary/summary 消息。不 kill 进程、
          // 不前端模拟。GLM 代理 compact 约 60-70s,compact_status{compacting} 即驱动「正在压缩…」指示。
          void transport.send("/compact");
          break;
        }
        case "rewind":
          // 历史消息选择器:选一条 user 消息 → clear(重置 session)+ 回填输入框,基于它重开。
          setRewindOpen(true);
          break;
        case "memory": {
          // 打开项目 CLAUDE.md(系统默认编辑器);无 cwd 则提示。
          const cwd = state?.meta?.cwd;
          if (cwd) void openPath(`${cwd}/CLAUDE.md`).catch(() => {});
          else setUnsupportedMsg(t("claudepane.unsupportedNoCwd"));
          break;
        }
        default:
          setUnsupportedMsg(t("claudepane.unsupported", { cmd: `/${cmd.name}` }));
      }
    },
    [input, activeTabId, paneId, onCloseTab, state, t],
  );

  /** Tab 补全:把触发的 /token 替换为 `/<name> `(带尾空格),关面板,不执行--
   *  让用户继续输入命令参数,回车再发送(对齐 claude code CLI:Tab 补全、Enter 发送)。
   *  带参数命令(如 /add-dir <path>、/resume <id>)由此可用:Tab 补全命令名 -> 输参数 -> Enter 走 handleSend send。 */
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
      // 清防抖 query + 计时器,避免残留旧值污染下次面板过滤。
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
  // - 一旦开始吐 text/tool_use → 视为思考结束,thinkingNow=false,隐藏浮动指示器。
  // - compact 进行中(compactRunning)另算,与 thinkingNow 取或(文案由 compactRunning 优先)。
  const thinkingNow = useMemo(() => {
    if (!busy || !state) return false;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role === "assistant") {
        if (
          m.streaming &&
          m.blocks.some((b) => (b.type === "text" && b.text.length > 0) || b.type === "tool_use")
        ) {
          return false;
        }
        return true;
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
      setSlashOpen(false);
      if (cmd) {
        const shellTransport = getShellRunTransportRef.current(activeTabId);
        const cwd = state?.meta?.cwd ?? sessions.find((s) => s.id === activeTabId)?.cwd;
        void shellTransport.run(cmd, cwd);
      }
      return;
    }
    // /clear:前端拦截(headless 下 `/clear` 发给 claude 只当文本,不执行),清 state + 后端 reset
    // session(下次 spawn 不带 --resume → 全新会话)。其他 slash 命令仍走 send。
    if (text === "/clear") {
      setInput("");
      setSlashOpen(false);
      await transport.clear();
      return;
    }
    // /exit:同 /clear 走触发式(面板选中即关 tab);这里防御用户直接打字发送。
    if (text === "/exit") {
      setInput("");
      setSlashOpen(false);
      onCloseTab?.(paneId, activeTabId);
      return;
    }
    // model 切换走状态栏 Popover(/model local command 改由 UI 上拉选择器触发,
    // 不再支持指令式 /model--避免与 UI 重复)。此处不拦截,落下面的 send 兜底(若用户仍打 /model xxx)。
    // busy 时(claude 仍在上轮)先中断当前轮——后端 spawn busy 会拒绝。
    // 中断后发新轮会带 --resume 续接上下文,新消息在下一轮被 Claude 看到(对齐 claude code 体验)。
    if (busy) {
      await transport.interrupt();
    }
    setInput("");
    setSlashOpen(false);
    // 发送前立即贴底:用户手动发消息后若已上滚看历史,此时仍强制滚到底,
    // 避免用户消息插入后还留在原视口(optimistic 插入 + transport.send 异步,时序抖动),
    // 也与 stickRef 在 send 后已为 true 的 useLayoutEffect 行为一致。
    scrollToBottom();
    void transport.send(text);
  }, [activeTabId, input, busy, shellRunning, scrollToBottom]);

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
    await transport.interrupt();
    void transport.send("批准该计划,开始执行");
  }, [activeTabId]);
  // 拒绝计划:不切模式,聚焦输入框让用户说明修改意见(下一轮 --resume 时 Claude 看到)。
  const handleReject = useCallback(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  // 批准被拒的工具调用(确认框「批准本次」/「批准且不再问」):标记 resolved + interrupt(幂等,
  // headless 单轮被拒后进程已退)+ approveTool。persist=true 持久化到项目 allowlist(后续免确认)。
  // resolve 时一并清掉最后一条 assistant 消息里所有「需审批被拒」的 block——同轮常有多项被拒,
  // 一次批准/拒绝就整批隐藏确认框(批准只放行点中的工具,其余下轮若再被调会重新弹框)。
  const handleApproveTool = useCallback(
    async (block: Extract<ClaudeBlock, { type: "tool_use" }>, persist: boolean) => {
      const transport = getClaudeTransportRef.current(activeTabId);
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
  const handleRejectTool = useCallback(
    (block: Extract<ClaudeBlock, { type: "tool_use" }>) => {
      const transport = getClaudeTransportRef.current(activeTabId);
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
      void transport.sendToolResult(
        block.id,
        `User denied the ${block.name} tool call. Please suggest an alternative approach or ask for clarification.`,
        true,
      );
    },
    [activeTabId, t],
  );
  // 反馈修改(确认框「反馈修改」):聚焦输入框让用户写具体反馈(复用 handleReject 的 focus 模式)。
  const handleFeedback = useCallback(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // —— 双击 Esc 中断快捷键(对齐 claude code)——
  // pane focused 时监听 window keydown:slash 面板打开时单击 Esc 只关面板(由 textarea 处理,这里跳过);
  // 面板关闭状态下,400ms 内连续两次 Esc → 中断当前轮。用 ref 镜像避免 stale closure。
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
      if (slashOpenRef.current) return; // 面板开着:让 textarea 关面板,不中断
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

  // —— 会话时长计时(首次出现消息开始,setInterval 每秒更新)——
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

  // 本轮(thinking/running)已耗时:busy 从 false→true 时记 turnStart(=本轮开始),
  // 每秒 tick 显示「本轮思考时长」(区别于 elapsed 会话总时长)。busy 结束清零。
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

  // 本次会话累计 token(遍历所有 assistant message 的 usage 求和;input 每轮含历史,反映实际计费)。
  const sessionTokens = useMemo(() => {
    if (!state) return { input: 0, output: 0 };
    let input = 0;
    let output = 0;
    for (const m of state.messages) {
      if (m.role === "assistant" && m.usage) {
        input +=
          (m.usage.input_tokens ?? 0) +
          (m.usage.cache_creation_input_tokens ?? 0) +
          (m.usage.cache_read_input_tokens ?? 0);
        output += m.usage.output_tokens ?? 0;
      }
    }
    return { input, output };
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

  // 当前上下文用量:取最近一条 assistant message 的 usage(input_tokens 含全部历史 ≈ 当前上下文占用)。
  // window = 上下文窗口上限(从 result.modelUsage.contextWindow 动态取,200k 或 1m;未到 result 前用 200k 兜底)。
  // ctx 显示「ctx <window> · <pct>%」:<window> 是会话上限,pct 是当前占用。无 usage 时也返回 window(显上限)。
  const contextInfo = useMemo(() => {
    if (!state) return null;
    const window = state.meta?.contextWindow ?? inferContextWindow(model);
    let usage: ClaudeUsage | undefined;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === "assistant" && state.messages[i].usage) {
        usage = state.messages[i].usage;
        break;
      }
    }
    const ctx = usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
      : 0;
    const pct = ctx > 0 ? Math.min(100, (ctx / window) * 100) : 0;
    return { window, ctx, pct };
  }, [state]);

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
      // 只收后台任务 notice;history_resumed(恢复会话历史回填)不属于任务完成列表。
      if (m.role === "notice" && n && n.kind !== "history_resumed") {
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
  const [pendingKillTasks, setPendingKillTasks] = useState<{ taskId: string; description: string }[]>([]);
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
    if ((hasPendingPlan || hasPendingApproval) && busy && !interruptedForPendingRef.current) {
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

      {/* 主体:消息流(上,flex-1 滚动) + 底部浮动输入区(下)。 */}
      <div className="grid min-h-0 min-w-0 grid-rows-[1fr_auto]">
        <div ref={scrollRef} onScroll={handleScroll} className="mx-scroll-pretty relative min-h-0 overflow-y-auto px-4 py-4" style={{ fontSize }}>
          {state && (state.messages.length > 0 || (shellState?.messages.length ?? 0) > 0) ? (
            <div ref={contentRef} className="mx-auto w-full max-w-[54.25rem] space-y-1">
              {mergeClaudeAndShellMessages(state.messages, shellState?.messages ?? []).map((item) =>
                item.kind === "shell" ? (
                  <ShellRow key={`shell-${item.msg.id}`} message={item.msg} t={t} onInterrupt={handleShellInterrupt} />
                ) : (
                  <MessageRow
                    key={item.msg.id}
                    message={item.msg}
                    t={t}
                    onApprovePlan={handleApprovePlan}
                    onReject={handleReject}
                    resolvedApprovals={resolvedApprovals}
                    onApproveTool={handleApproveTool}
                    onRejectTool={handleRejectTool}
                    onFeedback={handleFeedback}
                  />
                ),
              )}
            </div>
          ) : (
            <div className="grid h-full place-items-center text-xs text-[var(--mx-faint)]">
              {state ? t("claudepane.empty") : probeDone ? t("claudepane.loading") : "…"}
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

        {/* 底部浮动输入区:状态行 + textarea + 发送/中断按钮。 */}
        <div className="shrink-0 px-4 pb-3 pt-1">
          <div className="mx-auto max-w-[54.25rem]">
            {/* 会话状态指示行:retrying(API error 自动重试,最高优先,橙色)> compactRunning(紫)>
                thinkingNow 思考中(紫)> busy 执行中(蓝,不显示具体工具名,只显「执行中…」)。悬浮在输入框上方,
                busy 全程可见 -- 此前仅思考阶段显示,长工具运行中用户无从察觉会话仍在进行。
                retrying 期间 status 被覆写 running 维持 busy,中断按钮可用;idle → 此条消失。 */}
            {(retrying || busy || compactRunning) && !hasPendingPlan && !hasPendingApproval && (
              <div
                className={`mb-1.5 flex items-center gap-2 px-1 text-[11px] ${
                  retrying
                    ? "text-[var(--mx-warning)]"
                    : thinkingNow || compactRunning
                      ? "text-[var(--mx-violet)]"
                      : "text-[var(--mx-accent)]"
                }`}
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
                  ⏱ {formatElapsed(turnElapsed)}　↑{formatTokens(sessionTokens.input)} ↓{formatTokens(sessionTokens.output)}
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
                        className="mx-menu w-[340px] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
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
                    className="mx-menu w-[340px] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
                  >
                    <TaskListContent t={t} main={mainTask} bgTasks={state?.backgroundTasks ?? []} doneNotices={bgDoneNotices} onKillTask={handleKillBgTask} pendingKillIds={pendingKillIds} />
                  </PopoverContent>
                )}
              </Popover>
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
              <Popover open={(slashOpen && slashMatches.length > 0) || (atOpen && atMatches.length > 0)}>
                <PopoverAnchor asChild>
                  <div className="mx-chip flex flex-col border border-[var(--mx-border)] bg-[var(--mx-card-bg)] px-3 py-2 shadow-lg focus-within:border-[var(--mx-accent)]">
                    <div className="flex items-end gap-2">
                    <div className="relative min-w-0 flex-1">
                      {/* 高亮层:与 textarea 同排版,命令 token(/xxx 已知命令)套 chip 背景色,与参数文字区分。
                          pointer-events-none 不挡交互;透明 textarea 露光标,此层露高亮。纯背景无 padding/border 保逐字对齐。 */}
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
                        // ↑/↓ 浏览输入历史(类 shell 命令历史):slash 面板关闭 + 非 IME 组合输入时;
                        // 仅当光标在首行拦 ↑、末行拦 ↓(否则放行让光标在多行文本里正常上下移动)。
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
                        // @ 文件引用面板:↑↓ 导航 + Enter/Tab 选中插入 + Esc 关(对齐 slash 面板键位)。
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
                        // slash 面板打开时拦截导航键(对齐 claudecodeui handleCommandMenuKeyDown)。
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
                          // Tab 补全:把选中命令名插入输入框(带尾空格),不执行--留待输入参数后回车发送
                          // (对齐 claude code CLI:Tab 补全 / Enter 发送)。带参数命令(如 /add-dir)由此可用。
                          if (e.key === "Tab" && !e.shiftKey && !e.nativeEvent.isComposing && slashMatches.length > 0) {
                            e.preventDefault();
                            completeSlashCommand(slashMatches[slashIndex >= 0 ? slashIndex : 0] ?? slashMatches[0]);
                            return;
                          }
                          // Enter 选中即执行(原行为:无参数命令直接 dispatch,如 /clear /help /compact)。
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
                        // Shift+Tab 循环切换权限模式(auto/plan/default/yolo)。
                        if (e.key === "Tab" && e.shiftKey) {
                          e.preventDefault();
                          cycleMode();
                          return;
                        }
                        // 回车发送(无 Shift)、Shift+Enter 换行。IME 组合输入中不触发(防打断中文输入)。
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
                      placeholder={t("claudepane.slashHint")}
                      className="relative max-h-[160px] min-h-[36px] w-full resize-none bg-transparent p-0 font-mono caret-[var(--mx-text)] text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)]"
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
                        className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--mx-danger-bright)] transition-colors hover:bg-[var(--mx-danger-bg)] hover:text-[var(--mx-danger)]"
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
                        className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-accent-soft)] hover:text-[var(--mx-accent)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--mx-muted)]"
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
                      {/* 权限模式:auto/plan/default/yolo,点击切换,Shift+Tab 循环。 */}
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
                            className="mx-menu w-[230px] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
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
                                <span className="w-14 shrink-0 font-mono text-[11px] font-semibold">{m.label}</span>
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
                        // 每次打开:实时拉取 claude settings.json env 里的可用模型 + 检测 env 是否
                        // 变了(cc-switch 切供应商后),变了则重启长进程拾取新配置。
                        void invoke<string[]>("list_claude_models").then(setAvailableModels).catch(() => {});
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
                            className="mx-menu w-[260px] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
                          >
                            {/* 当前模型(仿 claude /model:先展示当前实际跑的 model 完整 id;代理把别名
                                全映射到 GLM 时,预置项均不高亮,此行是「当前」的权威展示)。 */}
                            <div className="flex items-center gap-2 rounded px-2 py-1.5 text-[var(--mx-text)]">
                              <span className="w-14 shrink-0 font-mono text-[10px] font-semibold text-[var(--mx-accent)]">{t("claudepane.modelCurrent")}</span>
                              <span className="flex-1 truncate font-mono text-[11px]" title={model ?? ""}>{model ?? "-"}</span>
                            </div>
                            <div className="mx-1 mb-1 border-t border-[var(--mx-border)]" />
                            {availableModels.length === 0 ? (
                              <div className="px-2 py-1.5 text-[10px] text-[var(--mx-faint)]">
                                {t("claudepane.modelEmpty")}
                              </div>
                            ) : (
                              availableModels.map((m) => {
                                const alias = getClaudeTransportRef.current(activeTabId)?.getSelectedModelAlias();
                                const active = alias === m || model === m;
                                return (
                                  <button
                                    key={m}
                                    type="button"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={() => void applyModel(m)}
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
                              })
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
                            className="mx-menu w-[150px] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
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
                      {/* ctx:上下文窗口 + 占用%(取最近 assistant usage / contextWindow)。
                          全局 StatusBar 已移除 ctx(避免重复),此为每 tab 唯一 ctx 显示。 */}
                      <span
                        className="shrink-0"
                        title={contextInfo && contextInfo.ctx > 0 ? `已用 ${contextInfo.ctx.toLocaleString()} / ${contextInfo.window.toLocaleString()} tokens(${contextInfo.pct.toFixed(1)}%)` : `窗口上限 ${(contextInfo?.window ?? inferContextWindow(model)).toLocaleString()} tokens`}
                      >
                        ctx {formatTokens(contextInfo?.window ?? inferContextWindow(model))}{contextInfo && contextInfo.ctx > 0 ? ` · ${contextInfo.pct.toFixed(1)}%` : ""}
                      </span>
                      <span className="shrink-0">
                        ↑{formatTokens(sessionTokens.input)} ↓{formatTokens(sessionTokens.output)}
                      </span>
                      <span className="shrink-0 whitespace-nowrap">⏱ {formatElapsed(elapsed)}</span>
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
            {/* slash 命令逐个触发的弹窗 + 不支持命令的底部 toast。 */}
            <SettingsModal open={configOpen} onClose={() => setConfigOpen(false)} />
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
                          onClick={() => {
                            const transport = getClaudeTransportRef.current(activeTabId);
                            void transport.clear();
                            setInput(text);
                            setRewindOpen(false);
                            requestAnimationFrame(() => inputRef.current?.focus());
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
                  <div>↑ 输入<span className="ml-2 text-[var(--mx-text)]">{formatTokens(sessionTokens.input)}</span></div>
                  <div>↓ 输出<span className="ml-2 text-[var(--mx-text)]">{formatTokens(sessionTokens.output)}</span></div>
                  <div>ctx 窗口<span className="ml-2 text-[var(--mx-text)]">{formatTokens(contextInfo?.window ?? inferContextWindow(model))}</span></div>
                  <div>累计成本<span className="ml-2 text-[var(--mx-text)]">{formatCost(state?.lastResult?.totalCostUsd)}</span></div>
                  <div>耗时<span className="ml-2 text-[var(--mx-text)]">{formatElapsed(elapsed)}</span></div>
                </div>
              </DialogContent>
            </Dialog>
            {unsupportedMsg && (
              <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-[var(--mx-orange-border)] bg-[var(--mx-surface)] px-3 py-1.5 text-[11px] text-[var(--mx-warning-bright)] shadow-lg">
                {unsupportedMsg}
              </div>
            )}
            {state?.compactError && (
              <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-[var(--mx-danger-border)] bg-[var(--mx-surface)] px-3 py-1.5 text-[11px] text-[var(--mx-danger-bright)] shadow-lg">
                {t("claudepane.compactFailed", { error: state.compactError })}
              </div>
            )}
            {retryFailedMsg && (
              <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 max-w-[80vw] rounded-lg border border-[var(--mx-danger-border)] bg-[var(--mx-surface)] px-3 py-1.5 text-[11px] text-[var(--mx-danger-bright)] shadow-lg">
                {retryFailedMsg}
              </div>
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
 *   violet 卡片 + MdPreview 渲染总结正文 + 标题「压缩总结」。
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
      <div className="my-1 overflow-hidden rounded-lg border border-[var(--mx-violet-border)] bg-[var(--mx-violet-soft)]">
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" aria-hidden>
            <path d="M21 12a9 9 0 11-6.219-8.56" />
            <path d="M9 11l3 3L22 4" />
          </svg>
          <span className="font-semibold text-[var(--mx-violet)]">{t("claudepane.compactSummary")}</span>
        </div>
        <div className="border-t border-[var(--mx-violet-border)] px-3 py-2.5 leading-relaxed text-[var(--mx-text)]">
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
 * - assistant:violet 实心圆点(输出色)+ 正文块流;流式空时显示思考动画。末行时间 + token 消耗。
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
}: {
  message: ClaudeMessage;
  t: (k: string, opts?: Record<string, unknown>) => string;
  onApprovePlan?: () => void;
  onReject?: () => void;
  resolvedApprovals?: Set<string>;
  onApproveTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>, persist: boolean) => void;
  onRejectTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>) => void;
  onFeedback?: () => void;
}) {
  const time = formatTime(message.timestamp);

  if (message.role === "compact") {
    // compact 节点:boundary=边界分隔线(已压缩 pre→post tokens(pct)·耗时);
    // summary=压缩总结卡片(MdPreview 渲染,violet 色调,assistant 风格)。
    return <CompactRow message={message} t={t} />;
  }

  if (message.role === "notice") {
    // notice 节点:系统级轻提示行(后台任务完成/失败/停止、恢复会话历史回填)。
    // 仿 compact boundary 的居中轻量样式,绿勾/红叉/琥珀方块/青勾区分,不参与角色流。
    const kind = message.notice?.kind;
    const stopped = kind === "bg_stopped";
    const done = kind === "bg_done";
    const resumed = kind === "history_resumed";
    const hist = message.notice?.history;
    const ok = done || (resumed && !hist?.failed);
    const tone = stopped ? "#fbbf24" : ok ? (resumed ? "#7dd3fc" : "#86efac") : "#fca5a5";
    const label = stopped
      ? t("claudepane.bgTaskStoppedLabel")
      : done
        ? t("claudepane.bgTaskDoneLabel")
        : resumed
          ? hist?.failed
            ? t("claudepane.historyFailed")
            : t("claudepane.historyResumed", { n: hist?.count ?? 0 })
          : t("claudepane.bgTaskFailedLabel");
    // 后台任务 notice 的 summary 是 claude 原文直接拼;历史回填 notice 的附注(截断提示)走 i18n。
    const suffix = resumed ? (hist?.truncated ? t("claudepane.historyTruncated") : "") : message.notice?.summary;
    return (
      <div className="my-2 flex items-center gap-3 select-none">
        <div className="h-px flex-1" style={{ borderTop: "1px dashed rgba(148,163,184,0.32)", background: "transparent" }} />
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-[var(--mx-faint)]">
          {stopped ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill={tone} aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={tone} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {ok ? <path d="M20 6L9 17l-5-5" /> : <path d="M18 6L6 18M6 6l12 12" />}
            </svg>
          )}
          <span style={{ color: tone }}>{label}</span>
          {suffix}
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
    return (
      <div className="flex gap-2">
        {/* 行首圆点:与 assistant violet 圆点同构,改青色(mx-accent)区分 user/assistant。
            高度 = 一行行高(1.625em = leading-relaxed),圆点 items-center 垂直居中,任意字号对齐首行中心。 */}
        <span aria-hidden className="flex h-[1.625em] shrink-0 items-center">
          <span className="h-2 w-2 rounded-full bg-[var(--mx-accent)]" />
        </span>
        <div className="group min-w-0 flex-1">
          <div dir="auto" className="whitespace-pre-wrap break-words leading-relaxed text-[var(--mx-text)]">
            {text}
          </div>
          {/* 末行:时间 + 复制按钮(user 不显示消耗时长/tokens,只时间 + 复制)。 */}
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] tabular-nums text-[var(--mx-faint)]">
            {time && <span>{time}</span>}
            <CopyButton text={text} t={t} className="ml-auto opacity-0 group-hover:opacity-100" />
          </div>
        </div>
      </div>
    );
  }

  // assistant:行首 violet 圆点(悬挂左侧)+ 正文块流 + 末行时间。
  const fullText = message.blocks
    .filter((b): b is Extract<ClaudeBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return (
    <div className="flex gap-2">
      {/* 圆点列:高度 = 一行行高(1.625em = leading-relaxed),圆点 items-center 垂直居中 →
          圆点中心精确对齐第一行文字中心(任意字号下成立,不再靠固定 mt 估算)。 */}
      <span aria-hidden className="flex h-[1.625em] shrink-0 items-center">
        <span className="h-2 w-2 rounded-full bg-[var(--mx-violet)]" />
      </span>
      <div className="group min-w-0 flex-1">
        <div className="flex flex-col gap-2">
          {message.blocks.map((b, i) => (
            <BlockView
              key={i}
              block={b}
              t={t}
              streaming={message.streaming}
              onApprovePlan={onApprovePlan}
              onReject={onReject}
              resolvedApprovals={resolvedApprovals}
              onApproveTool={onApproveTool}
              onRejectTool={onRejectTool}
              onFeedback={onFeedback}
            />
          ))}
          {message.blocks.length === 0 && message.streaming && (
            <div className="flex items-center gap-2 text-xs text-[var(--mx-muted)]">
              <ThinkingDots />
              {t("claudepane.thinking")}
            </div>
          )}
        </div>
        {/* 末行:时间 + ⏱消耗时长 + ↑↓tokens + 复制按钮(claude code CLI 式右下角小字)。
            时长/tokens 仅本轮 result 事件回填后才有(流式中不显示,避免假数据)。 */}
        {(time || message.durationMs || message.usage || fullText) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-[var(--mx-faint)]">
            {time && <span>{time}</span>}
            {message.durationMs != null && message.durationMs > 0 && (
              <span>⏱ {formatElapsed(message.durationMs)}</span>
            )}
            {message.usage &&
              ((message.usage.input_tokens ?? 0) > 0 ||
                (message.usage.output_tokens ?? 0) > 0) && (
                <span>
                  ↑{formatTokens(message.usage.input_tokens ?? 0)} ↓
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

/**
 * thinking 手风琴块(仿 claudecodeui Reasoning)。
 *
 * 展开行为:思考中(streaming)默认展开实时显示思考过程,本轮结束(streaming→false)自动收起
 * 保持对话紧凑。用户手动点过 summary 后,以用户操作为准不再自动收/展(避免和用户抢控制权)。
 * 每轮 assistant 是新挂载的消息,内部状态随消息生命周期,不跨轮残留。
 */
function ThinkingBlock({ text, streaming, t }: { text: string; streaming: boolean; t: (k: string) => string }) {
  // 内部 open 状态:仅在「用户尚未手动操作」时跟随 streaming(思考中开、结束关)。
  const [userToggled, setUserToggled] = useState(false);
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (!userToggled) setOpen(streaming);
  }, [streaming, userToggled]);
  return (
    <details
      className="group"
      open={open}
      onToggle={(e) => {
        setUserToggled(true);
        setOpen((e.currentTarget as HTMLDetailsElement).open);
      }}
    >
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
        <span className="italic">{t("claudepane.thinking")}</span>
        {text && <span className="text-[var(--mx-faint)]">· {text.length} chars</span>}
      </summary>
      <div className="mt-1.5 pl-[18px]">
        <div className="whitespace-pre-wrap break-words text-xs italic leading-relaxed text-[var(--mx-muted)]">
          {text || "…"}
        </div>
      </div>
    </details>
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
}: {
  block: ClaudeBlock;
  t: (k: string) => string;
  streaming: boolean;
  onApprovePlan?: () => void;
  onReject?: () => void;
  resolvedApprovals?: Set<string>;
  onApproveTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>, persist: boolean) => void;
  onRejectTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>) => void;
  onFeedback?: () => void;
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
      <div dir="auto" className="leading-relaxed text-[var(--mx-text)]">
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
        {/* 输出区:逐行渲染,stdout 默认色 / stderr 红色。默认展开(便于看实时流)。无输出时 running 显占位。 */}
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
 * 思考状态动画(claude code CLI 风格:三个 violet 圆点错峰呼吸)。
 * 用于状态栏整体思考反馈 + assistant 流式空块占位。
 */
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

/**
 * token 数格式化:<1k 显原数、1k–1M 显 k、≥1M 显 m;末尾 .0 trim 掉(200k 而非 200.0k)。
 * m 阈值收到 1M:上下文窗口可能 1M,需显示「1m」而非「1000k」。
 * 例:14 → "14"、1918 → "1.9k"、26112 → "26k"、200_000 → "200k"、1_000_000 → "1m"。
 */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${parseFloat((n / 1000).toFixed(1))}k`;
  return `${parseFloat((n / 1_000_000).toFixed(1))}m`;
}

/** 美元成本格式化:无/0 → "—";<$0.01 → 4 位小数;否则 2 位。lastResult.totalCostUsd 是会话累计。 */
function formatCost(usd?: number): string {
  if (typeof usd !== "number" || !isFinite(usd) || usd <= 0) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
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

/** 复制按钮:点击写剪贴板,1.2s 显「已复制」;父容器加 `group` + 本按钮 `opacity-0 group-hover:opacity-100` 做 hover 显。 */
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
      title={t("claudepane.copy")}
    >
      {copied ? <span className="text-[var(--mx-success)]">{t("claudepane.copied")}</span> : <IconCopy />}
    </button>
  );
}

/**
 * 工具调用卡片——配置驱动渲染(参考 claudecodeui 的 ToolRenderer + toolConfigs)。
 *
 * 按 `getToolConfig(name).variant` 路由:
 * - `bash` → BashToolView(Codex 式命令行:chevron + 绿 `$` + 命令,展开看输出)
 * - `task` → TaskToolView(subagent 展开查看:result 用 markdown 渲染 + 大区域可滚动)
 * - `default` → 通用可折叠卡片(左色条 + 工具名 + 参数摘要 + 状态药丸,展开看 result)
 *
 * 状态用 ToolStatusBadge 药丸(running/completed/error/denied)。分类左色条由
 * `categoryColor(getToolCategory(name))` 决定(edit=amber/bash=green/search=gray/
 * todo/task=violet/plan=indigo)。
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
}: {
  block: Extract<ClaudeBlock, { type: "tool_use" }>;
  t: (k: string) => string;
  onApprovePlan?: () => void;
  onReject?: () => void;
  resolvedApprovals?: Set<string>;
  onApproveTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>, persist: boolean) => void;
  onRejectTool?: (block: Extract<ClaudeBlock, { type: "tool_use" }>) => void;
  onFeedback?: () => void;
}) {
  const config = getToolConfig(block.name);
  if (config.variant === "plan") {
    return <PlanToolView block={block} config={config} t={t} onApprove={onApprovePlan} onReject={onReject} />;
  }
  // 权限确认:被拒的敏感操作(且未 resolved)→ 多选项确认框(批准本次/批准且不再问/拒绝/反馈)。
  // 已 resolved 的走下方正常视图(显示成「已完成」药丸)。plan 卡已在上文先行处理。
  if (isPermissionDenied(block) && !resolvedApprovals?.has(block.id)) {
    return (
      <PermissionConfirmCard
        block={block}
        config={config}
        t={t}
        onApproveOnce={() => onApproveTool?.(block, false)}
        onApprovePersist={() => onApproveTool?.(block, true)}
        onReject={() => onRejectTool?.(block)}
        onFeedback={onFeedback}
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
    return <BashToolView block={block} config={config} t={t} />;
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
 * 批准 → transport.approveTool(persist) interrupt + --resume --allowedTools 重放;
 * 拒绝 → transport.rejectTool 发拒绝消息;反馈 → 聚焦输入框。
 * 卡片三段:标题行(⚠ + 工具名 + 摘要 + 需批准药丸)+ 次要文本 + 决策条 4 按钮。
 */
function PermissionConfirmCard({
  block,
  config,
  t,
  onApproveOnce,
  onApprovePersist,
  onReject,
  onFeedback,
}: {
  block: Extract<ClaudeBlock, { type: "tool_use" }>;
  config: ToolDisplayConfig;
  t: (k: string) => string;
  onApproveOnce?: () => void;
  onApprovePersist?: () => void;
  onReject?: () => void;
  onFeedback?: () => void;
}) {
  const value = config.getValue?.(block.input) ?? "";
  const secondary = config.getSecondary?.(block.input);
  const badge = config.getBadge?.(block.input);
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
              color: badge.tone === "new" ? "#86efac" : "#fbbf24",
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
      {/* 决策条:批准本次(主) / 批准且不再问(indigo 边框) / 拒绝(ghost) / 反馈修改(faint ghost) */}
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--mx-orange-border)] bg-[var(--mx-orange-soft)] px-3 py-2">
        <button
          type="button"
          onClick={onApproveOnce}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--mx-accent-deep)] px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-[var(--mx-accent-deep)]"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
            <path d="M20 6L9 17l-5-5" />
          </svg>
          {t("claudepane.approveOnce")}
        </button>
        <button
          type="button"
          onClick={onApprovePersist}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--mx-indigo-border)] bg-transparent px-3 py-1.5 text-[11px] font-medium text-[var(--mx-violet)] transition-colors hover:border-[var(--mx-indigo-border)] hover:bg-[var(--mx-indigo-soft)]"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
            <path d="M20 6L9 17l-5-5" />
          </svg>
          {t("claudepane.approvePersist")}
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
        <button
          type="button"
          onClick={onFeedback}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--mx-border-strong)] bg-transparent px-3 py-1.5 text-[11px] font-medium text-[var(--mx-faint)] transition-colors hover:border-[var(--mx-border-strong)] hover:bg-[var(--mx-border-soft)] hover:text-[var(--mx-muted)]"
        >
          {t("claudepane.feedback")}
        </button>
      </div>
    </div>
  );
}

/**
 * Task/subagent 视图——单独展开查看子 agent 的完整输出。
 *
 * header:violet 左色条 + 「Task」+ description 摘要 + 状态药丸。
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
  const cat = getToolCategory(block.name);
  const { border } = categoryColor(cat);
  const status = deriveToolStatus(block);
  const value = config.getValue?.(block.input) ?? "";
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
    <div className="my-1 py-0.5">
      <div
        role="button"
        tabIndex={0}
        onClick={() => hasResult && setOpen((p) => !p)}
        onKeyDown={(e) => {
          if (hasResult && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen((p) => !p);
          }
        }}
        className={`flex w-full select-none items-center gap-1.5 py-0.5 text-xs text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--mx-accent)] ${
          hasResult ? "cursor-pointer" : "cursor-default"
        }`}
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
        <span className="flex-shrink-0 font-medium text-[var(--mx-violet)]">{config.label ?? "Task"}</span>
        {value && (
          <span className="min-w-0 flex-1 truncate text-left font-mono text-[var(--mx-text)]" title={value}>
            {value}
          </span>
        )}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2">
          {status !== "completed" && <ToolStatusBadge status={status} t={t} />}
        </span>
      </div>
      {open && block.result && (
        <div className="mt-1.5 pl-[18px]">
          <div
            className={`mx-scroll max-h-[60vh] overflow-auto rounded border p-3 ${
              isError
                ? "border-[var(--mx-danger-border)] bg-[var(--mx-danger-bg)] text-[var(--mx-danger-bright)]"
                : "border-[var(--mx-border)] bg-[var(--mx-surface-2)] text-[var(--mx-text)]"
            }`}
          >
            {isError ? (
              <pre className="whitespace-pre-wrap break-words font-mono">
                {block.result.content}
              </pre>
            ) : (
              <Suspense fallback={<div className="text-[11px] text-[var(--mx-muted)]">{t("common.loading")}</div>}>
                <MdPreviewLazy content={block.result.content} />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 状态药丸(参考 claudecodeui ToolStatusBadge):小药丸 text-[10px] 四态。 */
function ToolStatusBadge({ status, t }: { status: ToolBadgeStatus; t: (k: string) => string }) {
  const map: Record<ToolBadgeStatus, { label: string; bg: string; fg: string }> = {
    running: { label: t("claudepane.toolRunning"), bg: "rgba(59,130,246,0.16)", fg: "#93c5fd" },
    completed: { label: t("claudepane.toolDone"), bg: "var(--mx-success-soft)", fg: "#86efac" },
    error: { label: t("claudepane.permissionDenied"), bg: "var(--mx-danger-bg)", fg: "#fca5a5" },
    denied: { label: t("claudepane.permissionDenied"), bg: "var(--mx-warning-soft)", fg: "#fdba74" },
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
 * Bash 专用视图——Codex 式命令行(参考 claudecodeui BashCommandDisplay)。
 * 一行:chevron + 绿 `$` + 命令(mono),有输出时点击展开,带行数提示。
 * running 时右侧 spinner;非 running 显示状态药丸。
 */
function BashToolView({
  block,
  config,
  t,
}: {
  block: Extract<ClaudeBlock, { type: "tool_use" }>;
  config: ToolDisplayConfig;
  t: (k: string) => string;
}) {
  const command = config.getValue?.(block.input) ?? "";
  const description = config.getSecondary?.(block.input);
  const output = block.result?.content ?? "";
  const hasOutput = output.trim().length > 0;
  const isError = block.result?.isError === true;
  const status = deriveToolStatus(block);
  const isRunning = status === "running";
  const lineCount = hasOutput ? output.replace(/\s+$/, "").split("\n").length : 0;
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
        {/* chevron */}
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
          {command || t("claudepane.toolRunning")}
        </code>
        {isRunning && (
          <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--mx-border-strong)] border-t-[var(--mx-success)]" />
        )}
        {!isRunning && <ToolStatusBadge status={status} t={t} />}
        {!open && hasOutput && !isRunning && (
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--mx-faint)]">{lineCount} ln</span>
        )}
      </div>
      {description && !open && (
        <div className="truncate px-2.5 pb-1.5 pl-[2.2rem] text-[10px] italic text-[var(--mx-faint)]">{description}</div>
      )}
      {open && hasOutput && (
        <div className="border-t border-[var(--mx-hover-bg)] bg-[var(--mx-surface-2)]">
          {description && <div className="px-3 pt-2 text-[10px] italic text-[var(--mx-faint)]">{description}</div>}
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
 * Edit/MultiEdit/Write diff 视图 —— 红绿行级 + 词级高亮(自写 LCS,见 domain/diff.ts)。
 *
 * header 复用通用工具的 chevron+色条+label+badge+status;展开显示 diff 块:
 * - Edit:old_string → new_string 单个 diff
 * - MultiEdit:edits[] 每个 {old_string,new_string} 独立 diff,序号标注
 * - Write:content 全绿(新文件)
 * header 右侧附 +N -M 行数统计。
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
  const { border } = categoryColor(getToolCategory(block.name));
  const status = deriveToolStatus(block);
  const value = config.getValue?.(block.input) ?? "";
  const badge = config.getBadge?.(block.input);
  const [open, setOpen] = useState(config.defaultOpen ?? true);
  const segments = useMemo(() => extractDiffSegments(block), [block]);
  /** 文件绝对路径(点击 → openPath 系统默认程序打开,类 claude code 的文件超链接)。 */
  const filePath = useMemo(() => {
    const fp = (block.input as Record<string, unknown> | null)?.file_path;
    return typeof fp === "string" ? fp : "";
  }, [block]);

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
        <svg className="h-3 w-3 flex-shrink-0 transition-transform duration-150" style={{ transform: open ? "rotate(90deg)" : undefined }} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span aria-hidden className="h-3 w-[2px] flex-shrink-0 rounded-full" style={{ background: border }} />
        <span className="flex-shrink-0 font-medium">{config.label ?? block.name}</span>
        {value && <span className="flex-shrink-0 text-[10px] text-[var(--mx-faint)]">/</span>}
        {value && (
          <span
            className={`min-w-0 flex-1 truncate text-left font-mono text-[var(--mx-text)] ${filePath ? "cursor-pointer hover:underline" : ""}`}
            title={filePath ? `打开 ${filePath}` : value}
            onClick={filePath ? (e) => { e.stopPropagation(); void openPath(filePath).catch(() => {}); } : undefined}
          >
            {value}
          </span>
        )}
        {badge && (
          <span className="flex-shrink-0 rounded px-1 py-px text-[9px] font-semibold" style={{ background: badge.tone === "new" ? "var(--mx-success-soft)" : "var(--mx-warning-soft)", color: badge.tone === "new" ? "#86efac" : "#fbbf24" }}>{badge.text}</span>
        )}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2">
          {segments.stats && (
            <span className="text-[10px] tabular-nums">
              <span className="text-[var(--mx-success-bright)]">+{segments.stats.add}</span>{" "}
              <span className="text-[var(--mx-danger-bright)]">-{segments.stats.del}</span>
            </span>
          )}
          {status !== "completed" && <ToolStatusBadge status={status} t={t} />}
        </span>
      </div>
      {open && segments.diffs.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1.5 pl-[18px]">
          {segments.diffs.map((d, i) => (
            <DiffBlockView key={i} diff={d} index={segments.diffs.length > 1 ? i + 1 : null} />
          ))}
        </div>
      )}
      {open && block.result && (
        <pre className={`mx-scroll-pretty mt-1.5 max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--mx-border)] bg-[var(--mx-surface-2)] p-2 pl-[18px] font-mono text-[10px] text-[var(--mx-muted)]`}>{block.result.content}</pre>
      )}
    </div>
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
  const { border } = categoryColor(getToolCategory(block.name));
  const status = deriveToolStatus(block);
  const value = config.getValue?.(block.input) ?? "";
  const todos = useMemo(() => extractTodos(block), [block]);
  const [open, setOpen] = useState(config.defaultOpen ?? true);
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const td of todos) {
    const k = td.status in counts ? (td.status as keyof typeof counts) : "pending";
    counts[k]++;
  }

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
        <svg className="h-3 w-3 flex-shrink-0 transition-transform duration-150" style={{ transform: open ? "rotate(90deg)" : undefined }} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span aria-hidden className="h-3 w-[2px] flex-shrink-0 rounded-full" style={{ background: border }} />
        <span className="flex-shrink-0 font-medium">{config.label ?? block.name}</span>
        {value && <span className="flex-shrink-0 text-[10px] text-[var(--mx-faint)]">/</span>}
        {value && <span className="min-w-0 flex-1 truncate text-left text-[var(--mx-text)]" title={value}>{value}</span>}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2 text-[10px] tabular-nums">
          <span className="text-[var(--mx-success)]">✓{counts.completed}</span>
          <span className="text-[var(--mx-violet)]">◐{counts.in_progress}</span>
          <span className="text-[var(--mx-faint)]">○{counts.pending}</span>
          {status !== "completed" && <ToolStatusBadge status={status} t={t} />}
        </span>
      </div>
      {open && todos.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-0.5 pl-[18px]">
          {todos.map((td, i) => (
            <TodoRow key={i} todo={td} />
          ))}
        </div>
      )}
    </div>
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
      return { icon: "◐", color: "#a78bfa", strike: "", bg: "bg-[var(--mx-violet-soft)]" };
    case "cancelled":
      return { icon: "✕", color: "#64748b", strike: "line-through", bg: "" };
    case "pending":
    default:
      return { icon: "○", color: "#94a3b8", strike: "", bg: "" };
  }
}

/**
 * 通用工具视图——忠实复刻 claudecodeui OneLineDisplay + CollapsibleDisplay。
 *
 * 极简风格:**左色条 border-l-2(分类色)+ 无外框背景** + `my-1 py-0.5 pl-3`。
 * header:chevron + toolName + `/` + 参数摘要(value)+ badge + 状态药丸(右)。
 * 展开:input JSON + result(`pl-[18px]` 缩进,仿 CollapsibleSection)。
 *
 * **hideOnSuccess**:成功时默认折叠(只显示一行摘要);出错(isError)或显式 defaultOpen
 * 时自动展开。这是 claudecodeui 的核心清爽哲学(用户改主意要原封复刻)。
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
  const cat = getToolCategory(block.name);
  const { border } = categoryColor(cat);
  const status = deriveToolStatus(block);
  const value = config.getValue?.(block.input) ?? "";
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
    <div className="my-1 py-0.5">
      {/* header 行:chevron + toolName + / + value + badge + 状态药丸 */}
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
        {secondary && !value && (
          <span className="min-w-0 flex-1 truncate text-left text-[10px] italic text-[var(--mx-faint)]">
            {secondary}
          </span>
        )}
        {badge && (
          <span
            className="flex-shrink-0 rounded px-1 py-px text-[9px] font-semibold"
            style={{
              background: badge.tone === "new" ? "var(--mx-success-soft)" : "var(--mx-border)",
              color: badge.tone === "new" ? "#86efac" : "#cbd5e1",
            }}
          >
            {badge.text}
          </span>
        )}
        <span className="ml-auto flex flex-shrink-0 items-center gap-2">
          {secondary && value && (
            <span className="hidden text-[10px] italic text-[var(--mx-faint)] sm:inline">{secondary}</span>
          )}
          {status !== "completed" && <ToolStatusBadge status={status} t={t} />}
        </span>
      </div>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5 pl-[18px]">
          {/* input JSON(折叠详情) */}
          {block.input !== undefined && block.input !== null && (
            <pre className="mx-scroll-pretty max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--mx-border)] bg-[var(--mx-surface-2)] p-2 font-mono text-[10px] text-[var(--mx-muted)]">
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
                className={`mx-scroll-pretty max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded p-2 font-mono text-[10px] ${
                  isError
                    ? "border border-[var(--mx-danger-border)] bg-[var(--mx-danger-bg)] text-[var(--mx-danger-bright)]"
                    : "border border-[var(--mx-border)] bg-[var(--mx-surface-2)] text-[var(--mx-muted)]"
                }`}
              >
                {isError ? `${t("claudepane.permissionDenied")}\n\n` : ""}
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
 * slash 命令面板单条候选。
 *
 * 选中项用 ref + scrollIntoView({block:"nearest"}) 滚动跟随:↑↓ 移动到列表可视区外的项时,
 * 列表容器自动滚动让其可见(对齐 claude code CLI / VSCode command palette 行为)。
 * 用「最近」对齐而非「居中」,避免列表抖动。
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
      {/* 选中态左侧 accent 高亮条 */}
      {selected && (
        <span className="absolute bottom-1.5 left-1.5 top-1.5 w-0.5 rounded-full bg-[var(--mx-accent)]" />
      )}
      {/* 命令前缀图标方块 */}
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
      {/* 选中时右侧 ⏎ 回车提示 */}
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
