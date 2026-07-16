import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ProjectId, ProjectSnapshot } from "../domain/projects";
import type { ShellKind, PaneNode, PaneLeaf, PaneRef, SplitDirection, PaneTab } from "../domain/paneTree";
import {
  addTab,
  closePane,
  closeTab,
  createTab,
  defaultPaneTree,
  findPane,
  focusPane,
  getActiveTab,
  listPanes,
  setActiveTab,
  splitPaneWithPane,
  surfaceKey,
  transportKey,
} from "../domain/paneTree";
import { SHELL_KIND_META } from "../domain/shellKinds";
import { isTuiTool, TUI_TOOLS, toolPromptSpec, YAZI_DEPS, type PromptSpec } from "../domain/toolInstall";
import type { TerminalTransport } from "../domain/terminalTransport";
import { TauriPtyTransport } from "../domain/tauriPtyTransport";
import { ProjectColumn } from "./ProjectColumn";
import { ShellSidebar } from "./ShellSidebar";
import { StatusBar } from "./StatusBar";
import { TopProjectBar } from "./TopProjectBar";
import { InstallPromptModal } from "./InstallPromptModal";

type AppShellProps = {
  projects: ProjectSnapshot[];
  activeProjectId: ProjectId | null;
  onSelectProject: (projectId: ProjectId) => void;
  onAddProject?: () => void;
  /** 删除项目:后端 kill 该项目 PTY + 移除记录 + 落盘,返回最新 snap(由 App 同步)。 */
  onCloseProject?: (projectId: ProjectId) => Promise<void> | void;
  /** 把项目弹出为独立窗口(主窗口模式专用)。 */
  onDetachProject?: (projectId: ProjectId) => void;
  /** 已弹出为独立窗口的项目集合(主窗口模式下隐藏这些项目的终端列)。 */
  detachedProjectIds?: Set<ProjectId>;
  /** 独立项目窗口模式:顶栏降级为精简态(只显项目名 + dock back),不渲染项目切换。 */
  singleProjectMode?: boolean;
  /** 独立窗口「回到主窗口」回调(关掉自己,后端 emit 事件让主窗口恢复显示)。 */
  onDockBack?: () => void;
};

/** 简单自增 id 生成(运行期唯一即可,持久化用的是后端已有 id)。 */
let idCounter = 1;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${idCounter++}`;
}

/**
 * 主窗口两段式布局:顶部项目栏 + (左栏 shell 列表 | 中央 pane tree 分屏)。
 *
 * 两个正交维度:分屏(空间,pane tree)+ tab(栈层,每 pane 内叠多个终端)。
 * 身份用复合键贯穿 transport 池 / React key / 焦点:
 * - pane 级:`(projectId, paneId)` —— 左栏图标 / 分屏树 / 焦点。
 * - tab 级:`(projectId, paneId, tabId)` —— transport 池(一个 tab = 一个 PTY)。
 * transport 按 triple key 池化,tab 生命周期内稳定;切 tab 不换 transport(PTY 常驻)。
 */
export function AppShell({
  projects,
  activeProjectId,
  onSelectProject,
  onAddProject,
  onCloseProject,
  onDetachProject,
  detachedProjectIds,
  singleProjectMode,
  onDockBack,
}: AppShellProps) {
  const { t } = useTranslation();
  // 每项目一棵 pane tree(从 workspace.paneTree 初始化;deriver 已迁移旧形态到 tabs)。
  const [treesByProject, setTreesByProject] = useState<Record<string, PaneNode>>(() => {
    const init: Record<string, PaneNode> = {};
    for (const p of projects) init[p.id] = p.workspace.paneTree;
    return init;
  });
  // 钉住到并排视图的项目(前端 view 态,本轮不持久化)。
  const [pinnedProjectIds, setPinnedProjectIds] = useState<string[]>([]);
  // 焦点:复合身份(哪个项目的哪个 pane)。tab 级 active 存在树里(activeTabId)。
  const [focused, setFocused] = useState<PaneRef | null>(null);

  // 安装提示模态内容(TUI 工具未安装 / yazi 缺依赖)。null=不显示。
  const [installPrompt, setInstallPrompt] = useState<PromptSpec | null>(null);

  // git 分支缓存:rootPath → branch(null=已查且非 git;undefined=未查)。按项目根去重。
  const [gitBranchByRoot, setGitBranchByRoot] = useState<Record<string, string | null | undefined>>({});

  // transport 池:transportKey(projectId,paneId,tabId) → transport。一个 tab 一个 PTY,存活期复用。
  const transportsRef = useRef<Map<string, TerminalTransport>>(new Map());

  // pane 实际尺寸(由 TerminalPane 的 ResizeObserver 上报,按 pane 复合键存):供分屏方向自适应。
  const paneRectsRef = useRef<Map<string, { width: number; height: number }>>(new Map());

  // 新项目进来时补建空树(open_project 后)。
  useEffect(() => {
    setTreesByProject((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const p of projects) {
        if (!next[p.id]) {
          next[p.id] = p.workspace.paneTree;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [projects]);

  // 可见项目:钉住集合(去重、保序)并入 active,保证选中项目始终在中央;为空回退 [active]。
  // 主窗口模式:过滤掉已弹出为独立窗口的项目(它们由独立窗口独占,主窗口不再渲染终端列)。
  // 单项目模式:detachedProjectIds 为空集,不参与过滤,projects(单一项)原样可见。
  const visibleProjectIds = useMemo(() => {
    const detached = detachedProjectIds ?? new Set<ProjectId>();
    const ids: string[] = [];
    const pushIfVisible = (id: string) => {
      if (ids.includes(id)) return;
      if (detached.has(id)) return; // 已弹出 → 主窗口隐藏
      if (!projects.some((p) => p.id === id)) return;
      ids.push(id);
    };
    for (const id of pinnedProjectIds) pushIfVisible(id);
    if (activeProjectId) pushIfVisible(activeProjectId);
    return ids;
  }, [pinnedProjectIds, activeProjectId, projects, detachedProjectIds]);

  const visibleProjects = useMemo(
    () => visibleProjectIds.map((id) => projects.find((p) => p.id === id)).filter((p): p is ProjectSnapshot => !!p),
    [visibleProjectIds, projects],
  );

  // 拉取可见项目的 git 分支:仅对缓存中未查过的 rootPath invoke 一次。
  useEffect(() => {
    let alive = true;
    const missing = Array.from(
      new Set(visibleProjects.map((p) => p.rootPath).filter((rp) => gitBranchByRoot[rp] === undefined)),
    );
    if (missing.length === 0) return;
    Promise.all(
      missing.map(async (rp) => {
        try {
          const branch = await invoke<string | null>("get_git_branch", { rootPath: rp });
          return [rp, branch] as const;
        } catch {
          return [rp, null] as const;
        }
      }),
    ).then((entries) => {
      if (!alive) return;
      setGitBranchByRoot((prev) => {
        const next = { ...prev };
        for (const [rp, branch] of entries) next[rp] = branch;
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [visibleProjects, gitBranchByRoot]);

  /** 按某 pane 当前尺寸决定分屏方向:宽 ≥ 高 → 左右,否则上下。无尺寸默认左右。 */
  const autoDirection = useCallback((projectId: string, paneId: string): SplitDirection => {
    const rect = paneRectsRef.current.get(surfaceKey(projectId, paneId));
    if (!rect) return "horizontal";
    return rect.width >= rect.height ? "horizontal" : "vertical";
  }, []);

  // transport 池取/建:triple key 不变则复用同一实例。一个 tab = 一个 transport = 一个 PTY。
  const getTransport = useCallback(
    (projectId: string, paneId: string, tabId: string): TerminalTransport => {
      const pool = transportsRef.current;
      const key = transportKey(projectId, paneId, tabId);
      let t = pool.get(key);
      if (!t) {
        t = new TauriPtyTransport(projectId);
        pool.set(key, t);
      }
      return t;
    },
    [],
  );

  /** 把某项目的新 tree 写入本地 + 落盘后端。 */
  const commitTree = useCallback((projectId: ProjectId, next: PaneNode) => {
    setTreesByProject((prev) => ({ ...prev, [projectId]: next }));
    invoke("save_pane_tree", { projectId, paneTree: next }).catch((err) => {
      console.warn("[AppShell] save_pane_tree failed:", err);
    });
  }, []);

  // 聚焦某项目的某 pane,并把该项目设为 active(状态行上下文跟随)。
  const focusPaneRef = useCallback(
    (projectId: string, paneId: string) => {
      setFocused({ projectId, paneId });
      if (projectId !== activeProjectId) onSelectProject(projectId);
    },
    [activeProjectId, onSelectProject],
  );

  /**
   * TUI 工具安装守卫(合并本体 + 依赖检测:一次 invoke、一次模态)。
   *
   * 新建 TUI 窗口(lazygit/yazi/fresh)前探测本体是否在 PATH;yazi 额外探测其依赖(当前仅 `file`)。
   * 据缺失组合弹【单个】模态,避免「先弹工具、装完再弹依赖」的二次提示:
   * - 本体缺 → 弹模态(本体命令组,缺失依赖作为附加组 extras 一并展示)、返回 false(调用方据此中断建 tab);
   * - 本体在、仅依赖缺 → 弹模态(仅依赖命令组)、返回 true(不阻止,yazi 仍能启动,仅功能降级);
   * - 都在(或非 TUI 工具)→ 放行 true。非 Tauri 环境 invoke reject → catch 兜底放行,不阻断 mock 演示。
   */
  const ensureToolAndDeps = useCallback(async (kind: ShellKind): Promise<boolean> => {
    if (!isTuiTool(kind)) return true;
    const detect = TUI_TOOLS[kind].detect;
    const deps = kind === "yazi" ? YAZI_DEPS : [];
    try {
      const result = await invoke<Record<string, boolean>>("check_commands_installed", {
        commands: [detect, ...deps.map((d) => d.detect)],
      });
      const toolMissing = !result[detect];
      const missingDeps = deps.filter((d) => !result[d.detect]);
      if (toolMissing) {
        // 本体缺 → 阻止建 tab。把缺失依赖挂到 extras,一次弹完。
        const base = toolPromptSpec(kind);
        setInstallPrompt(
          missingDeps.length > 0 ? { ...base, extras: missingDeps.map((d) => d.spec) } : base,
        );
        return false;
      }
      // 本体在、仅依赖缺 → 不阻止,仅警告(YAZI_DEPS 当前仅 file 一项,取首个)。
      if (missingDeps.length > 0) setInstallPrompt(missingDeps[0].spec);
      return true;
    } catch {
      return true;
    }
  }, []);

  // 分屏并指定新 pane 的 shell 类型:自适应方向 + 新 pane 复制当前 pane 的 tab 栈(但首 tab 用指定 kind)。
  // 分屏并指定新 pane 的 shell 类型:自适应方向 + 新 pane 只含单个菜单选 kind 的 tab。
  // 不复制原 pane 的 tab 栈(与 splitFocused 同语义,区别在 kind 可选 + 方向自适应)。
  const handleSplitWithKind = useCallback(
    async (projectId: string, paneId: string, kind: ShellKind) => {
      if (!(await ensureToolAndDeps(kind))) return; // TUI 未装(含 yazi+依赖合并提示)→ 弹模态,不分屏。
      const cur = treesByProject[projectId];
      if (!cur) return;
      // 新 pane 始终起在项目根目录:不继承当前活动 tab 的 cwd(避免「复制整个 shell」)。
      const rootPath = projects.find((p) => p.id === projectId)?.rootPath ?? "";
      const newPaneId = nextId("pane");
      const newTabId = nextId("tab");
      const newPane: PaneLeaf = {
        type: "pane",
        id: newPaneId,
        tabs: [createTab(newTabId, kind, SHELL_KIND_META[kind].defaultTitle, rootPath)],
        activeTabId: newTabId,
      };
      const next = splitPaneWithPane(cur, paneId, autoDirection(projectId, paneId), newPane);
      commitTree(projectId, next);
      setFocused({ projectId, paneId: newPaneId });
    },
    [treesByProject, projects, commitTree, autoDirection, ensureToolAndDeps],
  );

  // 新建 tab:在焦点 pane 追加一个指定 kind 的 tab 并设为 active。
  const handleAddTab = useCallback(
    async (projectId: string, paneId: string, kind: ShellKind) => {
      if (!(await ensureToolAndDeps(kind))) return; // TUI 未装(含 yazi+依赖合并提示)→ 弹模态,不建 tab。
      const cur = treesByProject[projectId];
      if (!cur) return;
      // 新 tab 始终起在项目根目录:不继承当前活动 tab 的 cwd(避免「复制整个 shell」)。
      const rootPath = projects.find((p) => p.id === projectId)?.rootPath;
      const newTab: PaneTab = {
        id: nextId("tab"),
        shellKind: kind,
        title: SHELL_KIND_META[kind].defaultTitle,
        ...(rootPath ? { cwd: rootPath } : {}),
      };
      // 用领域纯函数 addTab 追加并设 active。
      const next = addTab(cur, paneId, newTab);
      commitTree(projectId, next);
      // 焦点落到该 pane(新 tab 自动 active)。
      setFocused({ projectId, paneId });
    },
    [treesByProject, projects, commitTree, ensureToolAndDeps],
  );

  // 切换某 pane 的活动 tab(只改树,不换 transport —— PTY 常驻)。
  const handleSetActiveTab = useCallback(
    (projectId: string, paneId: string, tabId: string) => {
      const cur = treesByProject[projectId];
      if (!cur) return;
      const next = setActiveTab(cur, paneId, tabId);
      // setActiveTab 是纯函数返回新树;只有真切换了才 commit(避免无谓落盘)。
      if (next !== cur) {
        commitTree(projectId, next);
        setFocused({ projectId, paneId });
      }
    },
    [treesByProject, commitTree],
  );

  // 关闭某 tab:stop 该 tab 的 transport + 改树(若 pane tabs 空 → 树回填 + 焦点落邻居)。
  const handleCloseTab = useCallback(
    (projectId: string, paneId: string, tabId: string) => {
      const cur = treesByProject[projectId];
      if (!cur) return;
      // stop + 清理该 tab 的 transport。
      const key = transportKey(projectId, paneId, tabId);
      const t = transportsRef.current.get(key);
      if (t) {
        void t.stop(tabId).catch(() => {});
        transportsRef.current.delete(key);
      }
      const result = closeTab(cur, paneId, tabId);
      if (!result) return;
      const { tree, paneClosed } = result;
      commitTree(projectId, tree);
      if (paneClosed) {
        // pane 被关:焦点落邻居(同项目)。
        if (focused?.projectId === projectId && focused.paneId === paneId) {
          const fallback = listPanes(tree)[0]?.id ?? null;
          setFocused(fallback ? { projectId, paneId: fallback } : null);
        }
      } else {
        // pane 还在,焦点保持在它(其 activeTabId 已由 closeTab 调整)。
        setFocused({ projectId, paneId });
      }
    },
    [treesByProject, focused, commitTree],
  );

  // 关闭 pane:stop 其所有 tab 的 transport,树回填,焦点落邻居。
  const handleClosePane = useCallback(
    (projectId: string, paneId: string) => {
      const cur = treesByProject[projectId];
      if (!cur) return;
      if (listPanes(cur).length <= 1) return; // 至少留一个 pane
      // stop 该 pane 所有 tab 的 transport(前缀 `${projectId}::${paneId}::`)。
      const prefix = transportKey(projectId, paneId, "");
      for (const key of Array.from(transportsRef.current.keys())) {
        if (!key.startsWith(prefix)) continue;
        const tabId = key.slice(prefix.length);
        const t = transportsRef.current.get(key);
        if (t) void t.stop(tabId).catch(() => {});
        transportsRef.current.delete(key);
      }
      paneRectsRef.current.delete(surfaceKey(projectId, paneId));
      const next = closePane(cur, paneId);
      if (!next) return;
      commitTree(projectId, next);
      if (focused?.projectId === projectId && focused.paneId === paneId) {
        const fallback = listPanes(next)[0]?.id ?? null;
        setFocused(fallback ? { projectId, paneId: fallback } : null);
      }
    },
    [treesByProject, focused, commitTree],
  );

  // 左栏新建 shell:在焦点 pane 上新建 tab(不再分屏)。焦点不在该项目则取其第一个 pane。
  const handleCreateShell = useCallback(
    (projectId: string, kind: ShellKind) => {
      const cur = treesByProject[projectId];
      if (!cur) return;
      const anchor =
        focused?.projectId === projectId ? focused.paneId : listPanes(cur)[0]?.id;
      if (!anchor) return;
      handleAddTab(projectId, anchor, kind);
    },
    [treesByProject, focused, handleAddTab],
  );

  // 快捷键:方向切焦点。focusPane 纯函数按方向找相邻叶子,重组 PaneRef(此前 AppShell 未接)。
  const moveFocus = useCallback(
    (dir: "up" | "down" | "left" | "right") => {
      if (!focused) return;
      const tree = treesByProject[focused.projectId];
      if (!tree) return;
      const nextPaneId = focusPane(tree, focused.paneId, dir);
      if (nextPaneId !== focused.paneId) setFocused({ projectId: focused.projectId, paneId: nextPaneId });
    },
    [focused, treesByProject],
  );

  // 快捷键:固定方向分屏(新 pane 只含单个默认 PowerShell tab,不复制原 tab 栈)。
  // 区别于菜单入口 handleSplitWithKind(后者 kind 可选 + 方向自适应,但同样不复制 tab 栈)。
  const splitFocused = useCallback(
    (dir: SplitDirection) => {
      if (!focused) return;
      const cur = treesByProject[focused.projectId];
      if (!cur) return;
      // 新 pane 始终起在项目根目录:不继承当前活动 tab 的 cwd(避免「复制整个 shell」)。
      const rootPath = projects.find((p) => p.id === focused.projectId)?.rootPath ?? "";
      const newPaneId = nextId("pane");
      const newTabId = nextId("tab");
      const newPane: PaneLeaf = {
        type: "pane",
        id: newPaneId,
        tabs: [createTab(newTabId, "shell", SHELL_KIND_META.shell.defaultTitle, rootPath)],
        activeTabId: newTabId,
      };
      const next = splitPaneWithPane(cur, focused.paneId, dir, newPane);
      commitTree(focused.projectId, next);
      setFocused({ projectId: focused.projectId, paneId: newPaneId });
    },
    [focused, treesByProject, projects, commitTree],
  );

  // 快捷键:相对切 tab(idx±1 取模循环)。tabs<2 时不动。
  const cycleTab = useCallback(
    (delta: 1 | -1) => {
      if (!focused) return;
      const cur = treesByProject[focused.projectId];
      if (!cur) return;
      const pane = findPane(cur, focused.paneId);
      if (!pane || pane.tabs.length < 2) return;
      const idx = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
      const nextIdx = (idx + delta + pane.tabs.length) % pane.tabs.length;
      handleSetActiveTab(focused.projectId, focused.paneId, pane.tabs[nextIdx].id);
    },
    [focused, treesByProject, handleSetActiveTab],
  );

  // 顶栏切换钉住。
  const handleTogglePin = useCallback((projectId: string) => {
    setPinnedProjectIds((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId],
    );
  }, []);

  // 释放某项目在主窗口的所有 transport(stop + 清池 + 清 pane 尺寸),但**不删项目记录、
  // 不删 tree**。用于 detach 弹出独立窗口前:主窗口停止持有该项目旧 PTY,避免与独立窗口
  // 新 spawn 的 PTY 重叠。与 handleCloseProject 的区别:后者还删 tree/钉住/焦点 + 调后端移除。
  // 注意 tree 保留:独立窗口 dock back 后主窗口恢复该 tree 配置重新 spawn。
  const releaseProjectTransports = useCallback((projectId: string) => {
    const pool = transportsRef.current;
    const prefix = `${projectId}::`;
    for (const key of Array.from(pool.keys())) {
      if (!key.startsWith(prefix)) continue;
      const parts = key.split("::");
      const tabId = parts[2] ?? "";
      const paneId = parts[1] ?? "";
      const t = pool.get(key);
      if (t) void t.stop(tabId).catch(() => {});
      pool.delete(key);
      paneRectsRef.current.delete(surfaceKey(projectId, paneId));
    }
  }, []);

  // 删除项目:前端乐观清理(transport 池按 `${projectId}::` 前缀批量 stop+delete、删 tree、
  // 取消钉住、清焦点),再 await 后端 close_project(kill PTY + 移除记录 + 落盘)。
  const handleCloseProject = useCallback(
    async (projectId: string) => {
      releaseProjectTransports(projectId);
      setTreesByProject((prev) => {
        if (!(projectId in prev)) return prev;
        const next = { ...prev };
        delete next[projectId];
        return next;
      });
      setPinnedProjectIds((prev) => prev.filter((id) => id !== projectId));
      setFocused((prev) => (prev?.projectId === projectId ? null : prev));
      if (onCloseProject) {
        try {
          await onCloseProject(projectId);
        } catch (err) {
          console.warn("[AppShell] close_project failed:", err);
        }
      }
    },
    [onCloseProject, releaseProjectTransports],
  );

  // 弹出为独立窗口:先释放主窗口该项目的 transport(避免与独立窗口新 PTY 重叠),
  // 再调后端建窗。tree 配置保留,以便 dock back 后恢复。
  const handleDetachProject = useCallback(
    (projectId: string) => {
      releaseProjectTransports(projectId);
      // 焦点若在被弹出项目上,清掉让焦点回退到下一个可见项目。
      setFocused((prev) => (prev?.projectId === projectId ? null : prev));
      setPinnedProjectIds((prev) => prev.filter((id) => id !== projectId));
      onDetachProject?.(projectId);
    },
    [onDetachProject, releaseProjectTransports],
  );

  // 焦点缺失/失效时,落到第一个可见项目的第一个 pane。
  useEffect(() => {
    const valid =
      focused &&
      visibleProjectIds.includes(focused.projectId) &&
      listPanes(treesByProject[focused.projectId] ?? defaultPaneTree()).some((p) => p.id === focused.paneId);
    if (valid) return;
    for (const pid of visibleProjectIds) {
      const first = listPanes(treesByProject[pid] ?? defaultPaneTree())[0];
      if (first) {
        setFocused({ projectId: pid, paneId: first.id });
        return;
      }
    }
    setFocused(null);
  }, [focused, visibleProjectIds, treesByProject]);

  // 卸载时停掉所有 transport。
  useEffect(() => {
    return () => {
      for (const [, t] of transportsRef.current) {
        void t.stop("").catch(() => {});
      }
      transportsRef.current.clear();
    };
  }, []);

  // WT 式全局快捷键(window keydown,capture 阶段抢在 xterm 之前,避免终端把组合键当输入吞掉)。
  // 应用聚焦时生效(非系统级全局快捷键,无需 tauri-plugin-global-shortcut)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!focused) return;
      const a = e.altKey;
      const s = e.shiftKey;
      const c = e.ctrlKey;
      const k = e.key;
      // Alt+Shift 系列:分屏 / 切焦点 / 关 pane。
      // 分屏键用 e.code(物理键位,不受 Shift 改变字符影响):Alt+Shift+- 的 e.key 是 "_",Alt+Shift++ 是 "+",
      // 用 e.code "Minus"/"Equal" 稳定匹配。
      if (a && s && !c) {
        if (e.code === "Minus") {
          e.preventDefault();
          splitFocused("vertical");
          return;
        }
        if (e.code === "Equal") {
          e.preventDefault();
          splitFocused("horizontal");
          return;
        }
        if (k === "ArrowUp") {
          e.preventDefault();
          moveFocus("up");
          return;
        }
        if (k === "ArrowDown") {
          e.preventDefault();
          moveFocus("down");
          return;
        }
        if (k === "ArrowLeft") {
          e.preventDefault();
          moveFocus("left");
          return;
        }
        if (k === "ArrowRight") {
          e.preventDefault();
          moveFocus("right");
          return;
        }
        if (k === "w" || k === "W") {
          e.preventDefault();
          handleClosePane(focused.projectId, focused.paneId);
          return;
        }
      }
      // Ctrl+Shift 系列:新 tab(复制当前活动 tab shellKind)/ 关 tab。
      if (c && s && !a) {
        if (k === "t" || k === "T") {
          e.preventDefault();
          const tree = treesByProject[focused.projectId];
          const at = tree && getActiveTab(tree, focused.paneId);
          if (at) void handleAddTab(focused.projectId, focused.paneId, at.shellKind);
          return;
        }
        if (k === "w" || k === "W") {
          e.preventDefault();
          const tree = treesByProject[focused.projectId];
          const at = tree && getActiveTab(tree, focused.paneId);
          if (at) handleCloseTab(focused.projectId, focused.paneId, at.id);
          return;
        }
      }
      // Ctrl+Tab / Ctrl+Shift+Tab:切 tab(循环)。
      if (c && k === "Tab") {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      // Ctrl+Alt+数字:切焦点到对应项目(按 visibleProjectIds 顺序)。Ctrl+Alt+1 → 第 1 个,Ctrl+Alt+2 → 第 2 个。
      // 加 Ctrl 避开纯 Alt+数字 的系统/输入法冲突。焦点跳到目标项目的当前 pane(若焦点曾在该项目则复用其
      // paneId,否则落首个 pane),active 同步切换。
      if (a && c && !s && k >= "1" && k <= "9") {
        const idx = Number(k) - 1;
        const targetId = visibleProjectIds[idx];
        if (!targetId) return; // 数字超出可见项目数,忽略
        e.preventDefault();
        const tree = treesByProject[targetId];
        const paneId = focused?.projectId === targetId ? focused.paneId : listPanes(tree)[0]?.id;
        if (!paneId) return;
        setFocused({ projectId: targetId, paneId });
        if (targetId !== activeProjectId) onSelectProject(targetId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    focused,
    treesByProject,
    visibleProjectIds,
    activeProjectId,
    onSelectProject,
    splitFocused,
    moveFocus,
    cycleTab,
    handleAddTab,
    handleCloseTab,
    handleClosePane,
  ]);

  const hasProject = visibleProjects.length > 0;

  // 聚焦项目(选中 shell 所属项目):供底部状态栏显示其绝对路径。
  const focusedProject = focused ? projects.find((p) => p.id === focused.projectId) ?? null : null;

  return (
    <main className="grid h-screen min-h-0 grid-rows-[36px_1fr_26px] overflow-hidden bg-[#070a12]">
      <TopProjectBar
        projects={projects}
        activeProjectId={activeProjectId}
        pinnedProjectIds={pinnedProjectIds}
        onSelectProject={onSelectProject}
        onTogglePin={handleTogglePin}
        onAddProject={onAddProject}
        onCloseProject={onCloseProject ? handleCloseProject : undefined}
        onDetachProject={onDetachProject ? handleDetachProject : undefined}
        detachedProjectIds={detachedProjectIds}
        singleProjectMode={singleProjectMode}
        onDockBack={onDockBack}
      />
      <div className="grid min-h-0 grid-cols-[52px_1fr]">
        <div className="flex min-h-0 flex-col">
          {hasProject ? (
            <ShellSidebar
              visibleProjects={visibleProjects}
              treesByProject={treesByProject}
              focused={focused}
              onFocusPane={(ref) => focusPaneRef(ref.projectId, ref.paneId)}
              onClosePane={handleClosePane}
              onCreateShell={handleCreateShell}
            />
          ) : (
            <div className="grid place-items-center p-4 text-center text-xs text-[#94a3b8]">
              {t("project.emptyHint")}
            </div>
          )}
        </div>
        <div className="min-h-0 min-w-0 p-2">
          {hasProject ? (
            <div
              className="grid h-full min-h-0 min-w-0 gap-px bg-[var(--mx-border-strong)]"
              style={{ gridTemplateColumns: `repeat(${visibleProjects.length}, minmax(0, 1fr))` }}
            >
              {visibleProjects.map((p) => (
                <ProjectColumn
                  key={p.id}
                  project={p}
                  paneTree={treesByProject[p.id] ?? defaultPaneTree()}
                  focusedPaneId={focused?.projectId === p.id ? focused.paneId : null}
                  onFocusPane={(paneId) => focusPaneRef(p.id, paneId)}
                  getTransport={(paneId, tabId) => getTransport(p.id, paneId, tabId)}
                  onSplitPane={(paneId, kind) => handleSplitWithKind(p.id, paneId, kind)}
                  onClosePane={(paneId) => handleClosePane(p.id, paneId)}
                  onAddTab={(paneId, kind) => handleAddTab(p.id, paneId, kind)}
                  onCloseTab={(paneId, tabId) => handleCloseTab(p.id, paneId, tabId)}
                  onSetActiveTab={(paneId, tabId) => handleSetActiveTab(p.id, paneId, tabId)}
                  onMeasurePane={(paneId, size) =>
                    paneRectsRef.current.set(surfaceKey(p.id, paneId), size)
                  }
                />
              ))}
            </div>
          ) : (
            <div className="grid h-full place-items-center text-xs text-[#475569]">
              {t("project.empty")}
            </div>
          )}
        </div>
      </div>
      <StatusBar
        focusedProject={focusedProject}
        gitBranch={focusedProject ? gitBranchByRoot[focusedProject.rootPath] : undefined}
      />
      <InstallPromptModal prompt={installPrompt} onClose={() => setInstallPrompt(null)} />
    </main>
  );
}

