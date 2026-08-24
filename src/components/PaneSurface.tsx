import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const NotesPane = lazy(() =>
  import("./NotesPane").then((m) => ({ default: m.NotesPane })),
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
  /** 在指定 pane 新建 tab。cwdOverride/titleOverride 供笔记 pane 传文件路径/文件名。 */
  onAddTab: (paneId: string, kind: ShellKind, cwdOverride?: string, titleOverride?: string) => void;
  onResumeSession: (provider: "claude" | "codex", sessionId: string, cwd?: string | null) => void;
  /** 关闭指定 pane 的某 tab。 */
  onCloseTab: (paneId: string, tabId: string) => void;
  /** 切换指定 pane 的活动 tab。 */
  onSetActiveTab: (paneId: string, tabId: string) => void;
  /** 上报 pane 实际尺寸(供分屏方向自适应)。 */
  onMeasurePane?: (paneId: string, size: { width: number; height: number }) => void;
  /** 拖拽分隔线调比例。commit=false 仅内存态(拖拽中),true 松手落盘 save_pane_tree。 */
  onSetSplitRatio?: (splitId: string, ratio: number, commit: boolean) => void;
  /** 重命名某 tab(笔记随 md 一级标题更新用)。 */
  onRenameTab?: (paneId: string, tabId: string, title: string) => void;
  /** React key 前缀(多项目并排时传 projectId):同一 paneId 跨项目不撞 key。 */
  keyPrefix?: string;
  /** 项目 id(FileTreePane 的 fs-watch 生命周期 + fs-change 过滤用;由 ProjectColumn 下传)。 */
  projectId?: string;
  /** 项目根路径(NotesPane 定位 notes/ 目录用;由 ProjectColumn 下传)。 */
  rootPath?: string;
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
  onSetSplitRatio,
  onRenameTab,
  keyPrefix,
  projectId,
  rootPath,
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
      {renderNode(paneTree, sessionsByPane, focusedPaneId, onFocusPane, getTransport, getClaudeTransport, getCodexTransport, getShellRunTransport, onSplitPane, onClosePane, onAddTab, onResumeSession, onCloseTab, onSetActiveTab, t, onMeasurePane, keyPrefix, projectId, rootPath, onSetSplitRatio, onRenameTab)}
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
  onAddTab: (paneId: string, kind: ShellKind, cwdOverride?: string, titleOverride?: string) => void,
  onResumeSession: (provider: "claude" | "codex", sessionId: string, cwd?: string | null) => void,
  onCloseTab: (paneId: string, tabId: string) => void,
  onSetActiveTab: (paneId: string, tabId: string) => void,
  t: TFunc,
  onMeasurePane?: (paneId: string, size: { width: number; height: number }) => void,
  keyPrefix?: string,
  projectId?: string,
  rootPath?: string,
  onSetSplitRatio?: (splitId: string, ratio: number, commit: boolean) => void,
  onRenameTab?: (paneId: string, tabId: string, title: string) => void,
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
    // notes:Markdown 笔记(Typora 式左编辑右预览),纯 UI 不走 PTY;存项目 notes/ 目录。
    // 收 rootPath(定位 notes/)+ onAddTab(新建/打开笔记开新 tab,cwd 存文件路径,title 存文件名)。
    if (activeTab?.shellKind === "notes") {
      return (
        <Suspense fallback={lazyFallback}>
          <NotesPane
            {...paneProps}
            rootPath={rootPath ?? ""}
            onRenameTab={(tabId, title) => onRenameTab?.(node.id, tabId, title)}
          />
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

  // split:三轨 grid——左/上子(fr,ratio) + 1px 视觉分隔线 + 右/下子(fr,1-ratio)。
  // 轨道只占 1px(回到 gap-px 的细线观感,容器中间无空白);SplitHandle 内部用负 margin
  // 把命中区扩展到 7px(好拖拽),hover 时细线变 3px accent。minmax(0,…) 防内容撑爆轨道。
  const horizontal = node.direction === "horizontal";
  const r = node.ratio;
  const trackStyle: React.CSSProperties = horizontal
    ? { gridTemplateColumns: `minmax(0,${r}fr) 1px minmax(0,${1 - r}fr)` }
    : { gridTemplateRows: `minmax(0,${r}fr) 1px minmax(0,${1 - r}fr)` };
  return (
    <div key={k(node.id)} className="grid h-full min-h-0 min-w-0" style={trackStyle}>
      {renderNode(node.children[0], sessionsByPane, focusedPaneId, onFocusPane, getTransport, getClaudeTransport, getCodexTransport, getShellRunTransport, onSplitPane, onClosePane, onAddTab, onResumeSession, onCloseTab, onSetActiveTab, t, onMeasurePane, keyPrefix, projectId, rootPath, onSetSplitRatio, onRenameTab)}
      <SplitHandle
        horizontal={horizontal}
        splitId={k(node.id)}
        onSetSplitRatio={onSetSplitRatio}
      />
      {renderNode(node.children[1], sessionsByPane, focusedPaneId, onFocusPane, getTransport, getClaudeTransport, getCodexTransport, getShellRunTransport, onSplitPane, onClosePane, onAddTab, onResumeSession, onCloseTab, onSetActiveTab, t, onMeasurePane, keyPrefix, projectId, rootPath, onSetSplitRatio, onRenameTab)}
    </div>
  );
}

/**
 * 分屏分隔线拖拽手柄。grid 轨道 1px(视觉细线),手柄用负 margin 向两侧各扩 3px 命中区
 * (共 7px,易拖拽,不占视觉空间);内部居中 1px 线,hover/拖拽时提亮为 accent 3px。
 * pointer 事件全程挂 window(拖出手柄也不丢),rAF 节流,拖拽中只回传 commit=false
 * (内存态,不刷后端),松手 commit=true 落盘 save_pane_tree。
 * 拖拽期间 body 加 .mx-dragging-split(禁文本选中 + 全局 resize 光标)。
 */
function SplitHandle({
  horizontal,
  splitId,
  onSetSplitRatio,
}: {
  horizontal: boolean;
  splitId: string;
  onSetSplitRatio?: (splitId: string, ratio: number, commit: boolean) => void;
}) {
  const dragging = useRef(false);
  const rectRef = useRef<DOMRect | null>(null);
  const rafRef = useRef<number | null>(null);
  /** 拖拽中最近一次 ratio(松手 commit 时用,避免最后一帧未 flush 丢失)。 */
  const lastRatio = useRef(0.5);
  /** 保存清理函数,卸载时若仍在拖拽则移除 window 监听(防关 pane 时泄漏)。 */
  const cleanupRef = useRef<(() => void) | null>(null);
  /** 拖拽中的 React state:驱动分隔线加粗高亮(group-active 在 pointer capture 下不可靠)。 */
  const [active, setActive] = useState(false);

  // 组件卸载:若拖拽进行中,清理 window 监听 + body class(防泄漏)。
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      setActive(true);
      rectRef.current = (e.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect() ?? null;
      document.body.classList.add("mx-dragging-split");
      // 纵向 split(上下分屏)拖水平手柄,光标用 row-resize;横向 split 用 col-resize(默认)。
      if (!horizontal) document.body.classList.add("dragging-vertical");
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current || !rectRef.current || !onSetSplitRatio) return;
        const rect = rectRef.current;
        const raw = horizontal
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
        lastRatio.current = Math.max(0.15, Math.min(0.85, raw));
        if (rafRef.current !== null) return; // rAF 节流:每帧最多一次
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          if (dragging.current) onSetSplitRatio(splitId, lastRatio.current, false);
        });
      };
      const onUp = () => {
        dragging.current = false;
        setActive(false);
        document.body.classList.remove("mx-dragging-split");
        document.body.classList.remove("dragging-vertical");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        cleanupRef.current = null;
        // 提交最终 ratio 落盘(上层 commit=true 时 save_pane_tree)。
        onSetSplitRatio?.(splitId, lastRatio.current, true);
      };
      cleanupRef.current = () => {
        dragging.current = false;
        setActive(false);
        document.body.classList.remove("mx-dragging-split");
        document.body.classList.remove("dragging-vertical");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [horizontal, splitId, onSetSplitRatio],
  );

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      // 轨道只 1px(细线观感);负 margin 把命中区向两侧各扩 3px(共 7px),
      // 鼠标好拖且视觉上容器中间无空白。z-10 保证可点。
      className={`group/handle relative z-10 flex items-center justify-center bg-transparent ${
        horizontal ? "cursor-col-resize -mx-[3px]" : "cursor-row-resize -my-[3px]"
      }`}
    >
      {/* 视觉分隔线:平时 1px border-strong;hover/拖拽时提亮为 accent 并加粗到 3px,带过渡。
          active 状态用 data-active(React state)而非 group-active(pointer capture 下不可靠)。 */}
      <div
        className={`absolute bg-[var(--mx-border-strong)] transition-[width,height,background-color] duration-100 group-hover/handle:bg-[var(--mx-accent)] ${
          horizontal
            ? `h-full w-px ${active ? "w-[3px] bg-[var(--mx-accent)]" : "group-hover/handle:w-[3px]"}`
            : `w-full h-px ${active ? "h-[3px] bg-[var(--mx-accent)]" : "group-hover/handle:h-[3px]"}`
        }`}
      />
    </div>
  );
}
