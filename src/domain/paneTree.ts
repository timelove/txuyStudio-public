import type { SessionKind } from "./sessions";

/**
 * Windows Terminal 式分屏 Pane Tree + 单 pane 内的 tab 栈。
 *
 * 两个正交维度:
 * - **分屏(空间)**:二叉树,叶子是 `Pane`,分支是 `Split`(沿某方向把空间均分给两子树)。
 *   `ratio` 固定 0.5(核心分屏不调比例);`children` 恒为二元。
 * - **tab(栈层)**:一个 `Pane` 叶子内叠多个 `PaneTab`,同一格子切 tab 不占额外空间。
 *   `activeTabId` 指向当前可见的 tab;tab 关到 0 个 = 该 pane 被关(树回填)。
 *
 * 方向约定:
 * - `horizontal`:左右两列(grid-cols-2),对应 WT「duplicate right」。
 * - `vertical`:上下两行(grid-rows-2),对应 WT「duplicate down」。
 *
 * 树结构持久化到后端 state.json(见 [[BackendAppSnapshot]]),PTY 进程不持久化——
 * 启动时按 tab 配置重新 spawn。所有变更都是纯函数:返回新树,不改入参。
 */

export type ShellKind = SessionKind;

export type SplitDirection = "horizontal" | "vertical";

/** 单个 tab = 一个终端会话的身份层配置。`id` 即 PTY sessionId,贯穿 transport 池 / React key。 */
export type PaneTab = {
  id: string;
  shellKind: ShellKind;
  title: string;
  cwd?: string;
};

export type PaneNode =
  | {
      type: "pane";
      /** pane 稳定身份:左栏图标 / 分屏树 / transport 池前缀。与 tab 无关。 */
      id: string;
      /** 该格子内的 tab 栈,≥1;关到 0 个 = pane 被关。 */
      tabs: PaneTab[];
      /** 当前可见 tab(=== tabs 之一)。 */
      activeTabId: string;
    }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      ratio: number;
      children: [PaneNode, PaneNode];
    };

/** 叶子 pane 的具体类型(有 tabs/activeTabId),供消费方安全访问。 */
export type PaneLeaf = Extract<PaneNode, { type: "pane" }>;

/**
 * 复合身份:多项目并排时,paneId 不再全局唯一(不同项目默认树叶子都叫 `ps-1`),
 * 必须用 `(projectId, paneId)` 作为左栏/焦点的真身份;tab 级再叠 tabId。
 */
export type PaneRef = { projectId: string; paneId: string };

/**
 * 复合键:transport 池 / React key 统一用此,根除跨项目 paneId 撞车。
 * tab 引入后 transport 池升到 triple key(见 [[transportKey]]),此处保留二段版供左栏/焦点用。
 */
export function surfaceKey(projectId: string, paneId: string): string {
  return `${projectId}::${paneId}`;
}

/** transport 池 triple key:`projectId::paneId::tabId`。一个 tab = 一个 transport = 一个 PTY。 */
export function transportKey(projectId: string, paneId: string, tabId: string): string {
  return `${projectId}::${paneId}::${tabId}`;
}

/** 新建一个 tab(不挂到 pane 上)。id 由调用方生成(运行期唯一即可)。 */
export function createTab(id: string, shellKind: ShellKind, title: string, cwd?: string): PaneTab {
  return { id, shellKind, title, ...(cwd ? { cwd } : {}) };
}

/** 默认 pane tree:单根 pane + 单 PowerShell tab。新项目 / 旧数据迁移用。 */
export function defaultPaneTree(paneId = "ps-1", tabId = "ps-1"): PaneNode {
  return {
    type: "pane",
    id: paneId,
    tabs: [createTab(tabId, "shell", "PowerShell")],
    activeTabId: tabId,
  };
}

/** 生成稳定的 split id(父 pane id + 方向,便于调试;非身份)。 */
function splitId(parentPaneId: string, direction: SplitDirection): string {
  return `${parentPaneId}::split-${direction}`;
}

/**
 * 把 `targetPaneId` 叶子替换为一个 split:原 pane + 新 pane,按 `direction` 均分。
 * 新 pane 复制原 pane 的整个 tab 栈(WT「duplicate」语义,含 activeTabId)。找不到目标则原样返回。
 */
export function splitPane(
  root: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  newPaneId: string,
  newPaneCwd?: string,
): PaneNode {
  if (root.type === "pane") {
    if (root.id !== targetPaneId) return root;
    // 复制 tab 栈:每个 tab 用稳定新 id(原 tabId + paneId 后缀,避免跨 pane 撞 sessionId)。
    // 原 active tab 对应的新 tab 成为新 pane 的 active。
    const dupTabs = root.tabs.map((t) =>
      createTab(`${t.id}::${newPaneId}`, t.shellKind, t.title, newPaneCwd ?? t.cwd),
    );
    const dupActiveTabId = `${root.activeTabId}::${newPaneId}`;
    const newPane: PaneLeaf = {
      type: "pane",
      id: newPaneId,
      tabs: dupTabs,
      activeTabId: dupActiveTabId,
    };
    return {
      type: "split",
      id: splitId(root.id, direction),
      direction,
      ratio: 0.5,
      children: [root, newPane],
    };
  }
  // split:递归到子树。
  return {
    ...root,
    children: [
      splitPane(root.children[0], targetPaneId, direction, newPaneId, newPaneCwd),
      splitPane(root.children[1], targetPaneId, direction, newPaneId, newPaneCwd),
    ],
  };
}

/**
 * 把 `targetPaneId` 叶子替换为一个 split:原 pane + 调用方预制的 `newPane`,按 `direction` 均分。
 * 与 [[splitPane]] 的区别:新 pane **不复制**原 pane 的 tab 栈,而是用传入的预制 pane(通常只含单个默认 tab)。
 * 找不到目标则原样返回。供「快捷键分屏:只开一个新空 pane」场景用。
 */
export function splitPaneWithPane(
  root: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  newPane: PaneLeaf,
): PaneNode {
  if (root.type === "pane") {
    if (root.id !== targetPaneId) return root;
    return {
      type: "split",
      id: splitId(root.id, direction),
      direction,
      ratio: 0.5,
      children: [root, newPane],
    };
  }
  return {
    ...root,
    children: [
      splitPaneWithPane(root.children[0], targetPaneId, direction, newPane),
      splitPaneWithPane(root.children[1], targetPaneId, direction, newPane),
    ],
  };
}

/**
 * 移除 `targetPaneId` 叶子:用兄弟节点顶替父 split 的位置(WT 回填语义)。
 * 若移除后只剩单根 pane,返回该 pane(或 null 表示整棵树空了)。
 */
export function closePane(root: PaneNode, targetPaneId: string): PaneNode | null {
  if (root.type === "pane") {
    return root.id === targetPaneId ? null : root;
  }
  const [left, right] = root.children;
  const newLeft = closePane(left, targetPaneId);
  const newRight = closePane(right, targetPaneId);

  // 左子被删 → 右子顶替;右子被删 → 左子顶替。
  if (newLeft === null) return newRight;
  if (newRight === null) return newLeft;
  // 两子都在(递归下沉移除),重建 split。
  return { ...root, children: [newLeft, newRight] };
}

/**
 * 设置某 split 节点的 ratio(拖拽分隔线用)。递归按 split `id` 定位(形如
 * `ps-1::split-horizontal`,splitId 稳定身份),clamp 到 [0.15, 0.85](留最小可用宽度/高度),
 * 不可变更新。找不到该 split 原样返回。ratio 持久化到 state.json(split 节点 ratio 字段已在 serde 模型里)。
 */
export function setSplitRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  const clamped = Math.max(0.15, Math.min(0.85, ratio));
  if (root.type === "pane") return root;
  if (root.id === splitId) {
    // ratio 未变(含已 clamp 到同值)返回原引用,避免无谓的 setState/持久化。
    if (root.ratio === clamped) return root;
    return { ...root, ratio: clamped };
  }
  const left = setSplitRatio(root.children[0], splitId, clamped);
  const right = setSplitRatio(root.children[1], splitId, clamped);
  // 两子树均未变(目标不在此子树)返回原引用,保引用相等供调用方短路。
  if (left === root.children[0] && right === root.children[1]) return root;
  return { ...root, children: [left, right] };
}

/** 列出所有叶子 pane(左栏 shell 列表用)。 */
export function listPanes(root: PaneNode): PaneLeaf[] {
  if (root.type === "pane") return [root];
  return [...listPanes(root.children[0]), ...listPanes(root.children[1])];
}

/** 找某叶子 id,返回该 pane 节点(无则 null)。 */
export function findPane(root: PaneNode, paneId: string): PaneLeaf | null {
  if (root.type === "pane") return root.id === paneId ? root : null;
  return findPane(root.children[0], paneId) ?? findPane(root.children[1], paneId);
}

/** 按 tabId 反查所属 pane(供 StatusBar onFocusClaudeTab 从 tabId 定位 paneId)。无则 null。 */
export function findPaneByTabId(root: PaneNode, tabId: string): PaneLeaf | null {
  if (root.type === "pane") {
    return root.tabs.some((t) => t.id === tabId) ? root : null;
  }
  return findPaneByTabId(root.children[0], tabId) ?? findPaneByTabId(root.children[1], tabId);
}

/** 取某 pane 的 tab 栈(找不到 pane 返回空数组)。 */
export function listTabs(root: PaneNode, paneId: string): PaneTab[] {
  return findPane(root, paneId)?.tabs ?? [];
}

/** 取某 pane 的活动 tab(找不到 pane 或 activeTabId 失效返回 null)。 */
export function getActiveTab(root: PaneNode, paneId: string): PaneTab | null {
  const pane = findPane(root, paneId);
  if (!pane) return null;
  return pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0] ?? null;
}

/**
 * 往指定 pane 追加一个 tab 并设为 active。找不到 pane 原样返回。
 * `newTab` 由调用方构造(含已生成的 id)。
 */
export function addTab(root: PaneNode, paneId: string, newTab: PaneTab): PaneNode {
  if (root.type === "pane") {
    if (root.id !== paneId) return root;
    return { ...root, tabs: [...root.tabs, newTab], activeTabId: newTab.id };
  }
  return {
    ...root,
    children: [addTab(root.children[0], paneId, newTab), addTab(root.children[1], paneId, newTab)],
  };
}

/**
 * 重命名某 pane 某 tab 的标题(笔记 pane 随 md 一级标题更新 tab 名用)。
 * 找不到 pane/tab 原样返回;标题与现值相同也原样返回(避免无谓的持久化)。
 */
export function renameTab(root: PaneNode, paneId: string, tabId: string, title: string): PaneNode {
  if (root.type === "pane") {
    if (root.id !== paneId) return root;
    const tab = root.tabs.find((t) => t.id === tabId);
    if (!tab || tab.title === title) return root;
    const tabs = root.tabs.map((t) => (t.id === tabId ? { ...t, title } : t));
    return { ...root, tabs };
  }
  const left = renameTab(root.children[0], paneId, tabId, title);
  const right = renameTab(root.children[1], paneId, tabId, title);
  if (left === root.children[0] && right === root.children[1]) return root;
  return { ...root, children: [left, right] };
}

/**
 * 切换某 pane 的活动 tab。`tabId` 不在该 pane 的 tabs 中则原样返回(防脏数据)。
 */
export function setActiveTab(root: PaneNode, paneId: string, tabId: string): PaneNode {
  if (root.type === "pane") {
    if (root.id !== paneId) return root;
    if (!root.tabs.some((t) => t.id === tabId)) return root;
    return { ...root, activeTabId: tabId };
  }
  return {
    ...root,
    children: [
      setActiveTab(root.children[0], paneId, tabId),
      setActiveTab(root.children[1], paneId, tabId),
    ],
  };
}

/**
 * 移除某 pane 的一个 tab。
 * - 移除后 tabs 仍 ≥1:active 落到相邻 tab(优先后者,否则前者)。
 * - 移除后 tabs 空:返回特殊标记,调用方据此走 `closePane` 回填(见 [[closeTabOrPane]])。
 *
 * 返回 `{ tree, paneClosed }`:`paneClosed=true` 表示该 pane 已无 tab,需在树层关闭。
 */
export function closeTab(
  root: PaneNode,
  paneId: string,
  tabId: string,
): { tree: PaneNode; paneClosed: boolean } | null {
  const pane = findPane(root, paneId);
  if (!pane) return null;
  const remaining = pane.tabs.filter((t) => t.id !== tabId);
  if (remaining.length === 0) {
    // pane 空了:在树层移除整个 pane(兄弟顶替)。
    const tree = closePane(root, paneId);
    return tree ? { tree, paneClosed: true } : null;
  }
  // active 落到相邻:被关 tab 后一个,否则前一个。
  const closedIdx = pane.tabs.findIndex((t) => t.id === tabId);
  const nextActive =
    remaining[closedIdx]?.id ?? remaining[Math.max(0, closedIdx - 1)].id;
  const replaced: PaneLeaf = {
    ...pane,
    tabs: remaining,
    activeTabId: pane.activeTabId === tabId ? nextActive : pane.activeTabId,
  };
  return { tree: replacePane(root, paneId, replaced), paneClosed: false };
}

/** 把树里某 paneId 叶子替换为 `next`(内部用,closeTab 复用)。 */
function replacePane(root: PaneNode, paneId: string, next: PaneLeaf): PaneNode {
  if (root.type === "pane") {
    return root.id === paneId ? next : root;
  }
  return {
    ...root,
    children: [
      replacePane(root.children[0], paneId, next),
      replacePane(root.children[1], paneId, next),
    ],
  };
}

/**
 * 焦点切换:从 `currentId` 沿 `direction` 找相邻叶子。
 * 简化策略——水平方向(horizontal/left/right):在最近的水平 split 里取另一子树的最左/最右叶子;
 * 垂直方向(vertical/up/down):在最近的垂直 split 里取另一子树的最上/最下叶子。
 * 找不到则返回 currentId(WT 行为:到边界不动)。
 */
export function focusPane(
  root: PaneNode,
  currentId: string,
  direction: "up" | "down" | "left" | "right",
): string {
  const wantHorizontal = direction === "left" || direction === "right";
  const wantDir = direction === "right" || direction === "down";

  // 自底向上:找包含 currentId 的路径,在第一个方向匹配的 split 处切到兄弟子树。
  const stack: Array<{ node: PaneNode; sibling: PaneNode | null }> = [];
  walk(root, currentId, stack);

  for (let i = stack.length - 1; i >= 0; i--) {
    const { node, sibling } = stack[i];
    if (node.type !== "split" || !sibling) continue;
    const isHorizontal = node.direction === "horizontal";
    if (isHorizontal !== wantHorizontal) continue;
    // wantDir=true:current 在 split 的第一子(左/上),要切到第二子(右/下)的边缘叶子。
    // wantDir=false:current 在第二子,要切到第一子的边缘叶子。
    // 判断 current 在哪一侧:看 stack 下一层。
    const currentInFirst = contains(node.children[0], currentId);
    const moveRight = wantDir;
    if ((moveRight && currentInFirst) || (!moveRight && !currentInFirst)) {
      return edgeLeaf(sibling, wantHorizontal ? (moveRight ? "left" : "right") : (moveRight ? "up" : "down"));
    }
  }
  return currentId;
}

/** 判断 subtree 是否含 paneId。 */
function contains(node: PaneNode, paneId: string): boolean {
  return findPane(node, paneId) !== null;
}

/** 沿 root → currentId 路径压栈,每层记录 sibling。 */
function walk(node: PaneNode, targetId: string, stack: Array<{ node: PaneNode; sibling: PaneNode | null }>): void {
  if (node.type === "pane") return;
  const [left, right] = node.children;
  if (contains(left, targetId)) {
    stack.push({ node, sibling: right });
    walk(left, targetId, stack);
  } else if (contains(right, targetId)) {
    stack.push({ node, sibling: left });
    walk(right, targetId, stack);
  }
}

/** 取 subtree 在某方向的边缘叶子(right/down→最后一个;left/up→第一个)。 */
function edgeLeaf(node: PaneNode, edge: "up" | "down" | "left" | "right"): string {
  const panes = listPanes(node);
  if (panes.length === 0) return "";
  const takeLast = edge === "right" || edge === "down";
  return panes[takeLast ? panes.length - 1 : 0].id;
}

/**
 * 旧数据迁移:把旧形态 pane(单终端,`{ id, shellKind, title, cwd? }` 无 tabs)转成新形态
 * (单 tab 包一层)。新形态原样返回。递归处理 split 子树。
 *
 * 用于:前端 deriver/hydrate 入口、mock 兼容。后端 persistence.rs 各自做等价迁移。
 */
export function migratePaneNode(node: PaneNode): PaneNode {
  if (node.type === "pane") {
    // 新形态(有 tabs)原样返回;旧形态(有 shellKind 无 tabs)包成单 tab。
    if ("tabs" in node && Array.isArray(node.tabs)) {
      const pane = node as PaneLeaf;
      // 防御:activeTabId 失效时回退首个 tab。
      const activeTabId = pane.tabs.some((t) => t.id === pane.activeTabId)
        ? pane.activeTabId
        : pane.tabs[0]?.id ?? "";
      return { ...pane, tabs: pane.tabs, activeTabId };
    }
    // 旧形态:顶层有 shellKind/title/cwd(此时 node 类型是联合的旧分支,ts 看不到字段,用 any 取)。
    const legacy = node as unknown as {
      id: string;
      shellKind: ShellKind;
      title: string;
      cwd?: string;
    };
    return {
      type: "pane",
      id: legacy.id,
      tabs: [createTab(legacy.id, legacy.shellKind, legacy.title, legacy.cwd)],
      activeTabId: legacy.id,
    };
  }
  return {
    ...node,
    children: [migratePaneNode(node.children[0]), migratePaneNode(node.children[1])],
  };
}
