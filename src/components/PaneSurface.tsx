import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PaneNode, ShellKind, SplitDirection } from "../domain/paneTree";
import { getActiveTab } from "../domain/paneTree";
import type { TerminalTransport } from "../domain/terminalTransport";
import type { ClaudeTransport } from "../domain/claudeTransport";
import type { CodexTransport } from "../domain/codexTransport";
import type { ShellRunTransport } from "../domain/shellRunTransport";
import type { WorkspaceSession } from "../domain/sessions";
import { TerminalPane } from "./TerminalPane";

// FileTreePane / SessionBrowserPane / ClaudePane 按需懒加载:三者非首屏必需(FileTreePane 还会静态拉
// monaco-editor 4.2MB,是首屏过慢根因),改 React.lazy 后只在对应 shellKind 的 pane 渲染时
// 才加载。named export 需 .then 适配成 lazy 要的 { default } 形式。TerminalPane 保持静态
// (绝大多数 pane 默认 shell,首屏基本必加载,lazy 反而多一次 Suspense 抖动无收益)。
const SessionBrowserPane = lazy(() =>
  import("./SessionBrowserPane").then((m) => ({ default: m.SessionBrowserPane })),
);
const FileTreePane = lazy(() =>
  import("./FileTreePane").then((m) => ({ default: m.FileTreePane })),
);
const ClaudePane = lazy(() =>
  import("./ClaudePane").then((m) => ({ default: m.ClaudePane })),
);
const CodexPane = lazy(() =>
  import("./CodexPane").then((m) => ({ default: m.CodexPane })),
);
const HtmlPreviewPane = lazy(() =>
  import("./HtmlPreviewPane").then((m) => ({ default: m.HtmlPreviewPane })),
);

type PaneSurfaceProps = {
  paneTree: PaneNode;
  sessions: WorkspaceSession[];
  focusedPaneId: string | null;
  onFocusPane: (paneId: string) => void;
  /** 按 (paneId, tabId) 取该 tab 专属 transport(池化,tab 生命周期内稳定)。projectId 由上层闭包注入。 */
  getTransport: (paneId: string, tabId: string) => TerminalTransport;
  /** 按 (paneId, tabId) 取该 tab 专属 ClaudeTransport(claudepane 用,池化)。projectId 由上层闭包注入。 */
  getClaudeTransport: (paneId: string, tabId: string) => ClaudeTransport;
  /** 按 (paneId, tabId) 取该 tab 专属 CodexTransport(codexpane 用,池化)。与 getClaudeTransport 对称。 */
  getCodexTransport: (paneId: string, tabId: string) => CodexTransport;
  /** 按 (paneId, tabId) 取该 tab 专属 ShellRunTransport(`!` 命令用,池化)。与 getClaudeTransport 对称。 */
  getShellRunTransport: (paneId: string, tabId: string) => ShellRunTransport;
  /** 在指定 pane 上触发分屏(由 pane header 的分屏按钮调用,direction 由用户在菜单选)。 */
  onSplitPane: (paneId: string, kind: ShellKind, direction: SplitDirection) => void;
  /** 关闭指定 pane(关掉其所有 tab)。 */
  onClosePane: (paneId: string) => void;
  /** 在指定 pane 新建 tab。 */
  onAddTab: (paneId: string, kind: ShellKind) => void;
  onResumeSession: (provider: "claude" | "codex", sessionId: string, cwd?: string | null) => void;
  /** 关闭指定 pane 的某 tab。 */
  onCloseTab: (paneId: string, tabId: string) => void;
  /** 切换指定 pane 的活动 tab。 */
  onSetActiveTab: (paneId: string, tabId: string) => void;
  /** 上报 pane 实际尺寸(供分屏方向自适应)。 */
  onMeasurePane?: (paneId: string, size: { width: number; height: number }) => void;
  /** React key 前缀(多项目并排时传 projectId):同一 paneId 跨项目不撞 key。 */
  keyPrefix?: string;
  /** 项目 id(FileTreePane 的 fs-watch 生命周期 + fs-change 过滤用;由 ProjectColumn 下传)。 */
  projectId?: string;
};

/**
 * 中央分屏区:递归渲染 WT 式 PaneNode。
 *
 * - `split` → grid 容器,horizontal 用 `grid-cols-2`(左右),vertical 用 `grid-rows-2`(上下),
 *   `gap-px` 作分隔条;均分(ratio 固定 0.5)。
 * - `pane` → `TerminalPane`,按 paneId 过滤出该 pane 的所有 session(一个 tab 一个 session)、
 *   从树取 activeTabId、从池取 transport。TerminalPane 内部为每个 tab 常驻一个 xterm。
 *
 * 布局变化(分屏/关闭)时 grid 重排触发各 TerminalPane 的 ResizeObserver → fit → resize_pty,
 * 无需额外接线。
 */
export function PaneSurface({
  paneTree,
  sessions,
  focusedPaneId,
  onFocusPane,
  getTransport,
  getClaudeTransport,
  getCodexTransport,
  getShellRunTransport,
  onSplitPane,
  onClosePane,
  onAddTab,
  onResumeSession,
  onCloseTab,
  onSetActiveTab,
  onMeasurePane,
  keyPrefix,
  projectId,
}: PaneSurfaceProps) {
  const { t } = useTranslation();
  // paneId → 该 pane 的 sessions(按 session.paneId 分组)。一个 pane 的 tabs 对应它的 sessions。
  const sessionsByPane = useMemo(() => {
    const map = new Map<string, WorkspaceSession[]>();
    for (const s of sessions) {
      const arr = map.get(s.paneId) ?? [];
      arr.push(s);
      map.set(s.paneId, arr);
    }
    return map;
  }, [sessions]);

  return (
    <div className="grid h-full min-h-0 min-w-0 border border-[var(--mx-border-strong)]">
      {renderNode(paneTree, sessionsByPane, focusedPaneId, onFocusPane, getTransport, getClaudeTransport, getCodexTransport, getShellRunTransport, onSplitPane, onClosePane, onAddTab, onResumeSession, onCloseTab, onSetActiveTab, t, onMeasurePane, keyPrefix, projectId)}
    </div>
  );
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

function renderNode(
  node: PaneNode,
  sessionsByPane: Map<string, WorkspaceSession[]>,
  focusedPaneId: string | null,
  onFocusPane: (paneId: string) => void,
  getTransport: (paneId: string, tabId: string) => TerminalTransport,
  getClaudeTransport: (paneId: string, tabId: string) => ClaudeTransport,
  getCodexTransport: (paneId: string, tabId: string) => CodexTransport,
  getShellRunTransport: (paneId: string, tabId: string) => ShellRunTransport,
  onSplitPane: (paneId: string, kind: ShellKind, direction: SplitDirection) => void,
  onClosePane: (paneId: string) => void,
  onAddTab: (paneId: string, kind: ShellKind) => void,
  onResumeSession: (provider: "claude" | "codex", sessionId: string, cwd?: string | null) => void,
  onCloseTab: (paneId: string, tabId: string) => void,
  onSetActiveTab: (paneId: string, tabId: string) => void,
  t: TFunc,
  onMeasurePane?: (paneId: string, size: { width: number; height: number }) => void,
  keyPrefix?: string,
  projectId?: string,
): React.ReactNode {
  const k = (id: string) => (keyPrefix ? `${keyPrefix}::${id}` : id);
  if (node.type === "pane") {
    const paneSessions = sessionsByPane.get(node.id) ?? [];
    // 活动 tab:树里的 activeTabId;失效时回退首个 session。
    const activeTab = getActiveTab(node, node.id);
    const activeTabId = activeTab?.id ?? paneSessions[0]?.id ?? "";
    if (paneSessions.length === 0) {
      return (
        <div className="grid min-h-0 min-w-0 place-items-center rounded-none bg-[var(--mx-editor-bg)] text-xs text-[var(--mx-faint)]">
          {t("paneSurface.noSession", { id: node.id })}
        </div>
      );
    }
    const paneProps = {
      key: k(node.id),
      paneId: node.id,
      sessions: paneSessions,
      activeTabId,
      focused: node.id === focusedPaneId,
      onFocusPane,
      onSplitPane,
      onClosePane,
      onAddTab,
      onCloseTab,
      onSetActiveTab,
    };
    // 按 活动 tab shellKind 分发:sessionbrowser → SessionBrowserPane;filetree → FileTreePane
    // (两者都纯 UI 不走 PTY);其余 → TerminalPane。切 tab 时按活动 tab 切组件。
    // TerminalPane 额外需 getTransport(PTY IO) + onMeasurePane(分屏方向自适应);
    // SessionBrowserPane/FileTreePane 不走 PTY 故不需要。FileTreePane 额外需 projectId(fs-watch)。
    // 懒加载组件用 Suspense 包裹:fallback 深色占位对齐 pane 底色,避免动态加载期闪白。
    const lazyFallback = (
      <div className="grid min-h-0 min-w-0 place-items-center bg-[var(--mx-editor-bg)] text-xs text-[var(--mx-faint)]">
        {t("common.loading")}
      </div>
    );
    if (activeTab?.shellKind === "sessionbrowser") {
      return (
        <Suspense fallback={lazyFallback}>
          <SessionBrowserPane {...paneProps} onResumeSession={onResumeSession} />
        </Suspense>
      );
    }
    if (activeTab?.shellKind === "filetree") {
      return (
        <Suspense fallback={lazyFallback}>
          <FileTreePane {...paneProps} projectId={projectId ?? ""} />
        </Suspense>
      );
    }
    // htmlpreview:HTML 源码编辑 + iframe srcdoc 沙箱预览,纯 UI 不走 PTY/transport。
    if (activeTab?.shellKind === "htmlpreview") {
      return (
        <Suspense fallback={lazyFallback}>
          <HtmlPreviewPane {...paneProps} />
        </Suspense>
      );
    }
    if (activeTab?.shellKind === "claudepane") {
      // claudepane:自渲染 claude 对话(stream-json wrapper,不走 xterm)。收 getClaudeTransport
      // (与 TerminalPane 收 getTransport 对称)+ getShellRunTransport(`!` 命令内联执行),
      // 不收 onMeasurePane(非 PTY 无需尺寸自适应)。
      return (
        <Suspense fallback={lazyFallback}>
          <ClaudePane
            {...paneProps}
            getClaudeTransport={(tabId: string) => getClaudeTransport(node.id, tabId)}
            getShellRunTransport={(tabId: string) => getShellRunTransport(node.id, tabId)}
            onResumeSession={(sid: string) => {
              // ↻ 在当前已终止的 claudepane tab 上恢复该历史 session(kill+用 resume id 重新 spawn),
              // 不再新建 tab。当前 tab 进程若仍存活也会被 kill 重启到目标 session(切换会话语义)。
              const tid = activeTab?.id;
              if (!tid) return;
              getClaudeTransport(node.id, tid)?.resumeSession(sid);
            }}
          />
        </Suspense>
      );
    }
    if (activeTab?.shellKind === "codexpane") {
      // codexpane:自渲染 codex 对话(每轮短命 codex exec --json + resume 续接,不走 xterm)。
      // 收 getCodexTransport + getShellRunTransport(`!` 命令),与 claudepane 对称。
      return (
        <Suspense fallback={lazyFallback}>
          <CodexPane
            {...paneProps}
            getCodexTransport={(tabId: string) => getCodexTransport(node.id, tabId)}
            getShellRunTransport={(tabId: string) => getShellRunTransport(node.id, tabId)}
            onResumeSession={(sid: string) => {
              // ↻ 在当前 codexpane tab 上恢复该历史 thread(设 resume id,下次 send 带它续接;
              // codex 无长进程,清 terminatedReason 即可,下轮 spawn 用 resume id)。
              const tid = activeTab?.id;
              if (!tid) return;
              getCodexTransport(node.id, tid)?.resumeSession(sid);
            }}
          />
        </Suspense>
      );
    }
    return (
      <TerminalPane
        {...paneProps}
        getTransport={(tabId: string) => getTransport(node.id, tabId)}
        onMeasurePane={onMeasurePane}
        onResumeSession={
          activeTab?.shellKind === "codex"
            ? (sid: string) => onResumeSession("codex", sid)
            : undefined
        }
      />
    );
  }

  // split:按方向用 grid 均分两子树。min-h-0 让 1fr track 不被内容撑爆;h-full 占满父级。
  // gap-px + 容器 accent 底色:1px 间隙露出底色成「分割线」,作为窗格间的视觉分隔。
  const gridClass =
    node.direction === "horizontal"
      ? "grid h-full min-h-0 min-w-0 grid-cols-2 gap-px bg-[var(--mx-border-strong)]"
      : "grid h-full min-h-0 min-w-0 grid-rows-2 gap-px bg-[var(--mx-border-strong)]";
  return (
    <div key={k(node.id)} className={gridClass}>
      {renderNode(node.children[0], sessionsByPane, focusedPaneId, onFocusPane, getTransport, getClaudeTransport, getCodexTransport, getShellRunTransport, onSplitPane, onClosePane, onAddTab, onResumeSession, onCloseTab, onSetActiveTab, t, onMeasurePane, keyPrefix, projectId)}
      {renderNode(node.children[1], sessionsByPane, focusedPaneId, onFocusPane, getTransport, getClaudeTransport, getCodexTransport, getShellRunTransport, onSplitPane, onClosePane, onAddTab, onResumeSession, onCloseTab, onSetActiveTab, t, onMeasurePane, keyPrefix, projectId)}
    </div>
  );
}
