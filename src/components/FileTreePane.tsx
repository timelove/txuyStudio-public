import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Tree, type NodeApi, type TreeApi } from "react-arborist";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import type { ShellKind, SplitDirection } from "../domain/paneTree";
import type { WorkspaceSession } from "../domain/sessions";
import { ShellMenu } from "./ShellMenu";
import { SplitPaneButtons } from "./SplitPaneButtons";
import { FilePreview } from "./FilePreview";
import { Button } from "./ui/Button";
import { Popover, PopoverTrigger } from "./ui/Popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import { Tabs, TabsList, TabsTrigger } from "./ui/Tabs";
import { listDir, readFile, writeFile, startFsWatch, stopFsWatch, onFsChange, type FileNode, type OpenFile, type ModelPool } from "../domain/fileTree";
import { basename, guessLang, isImage, formatBytes } from "./FilePreview";
import { FileEditor } from "./FileEditor";
import { MdPreview } from "./MdPreview";
import type * as monaco from "monaco-editor";
import { useSettings } from "../settings/SettingsProvider";
import type { UnlistenFn } from "@tauri-apps/api/event";

type FileTreePaneProps = {
  paneId: string;
  focused: boolean;
  /** 该 pane 所有 tab 的 session(一个 tab = 一个 session)。 */
  sessions: WorkspaceSession[];
  /** 当前可见 tab 的 id(=== 某 session.id)。 */
  activeTabId: string;
  /** 项目 id(用于 fs-watch 生命周期 + fs-change 过滤)。 */
  projectId: string;
  onFocusPane?: (paneId: string) => void;
  onClosePane?: (paneId: string) => void;
  onSplitPane?: (paneId: string, kind: ShellKind, direction: SplitDirection) => void;
  onAddTab?: (paneId: string, kind: ShellKind) => void;
  onCloseTab?: (paneId: string, tabId: string) => void;
  onSetActiveTab?: (paneId: string, tabId: string) => void;
};

/** 构造 OpenFile(合并默认值:preview 模式、不脏、mdView=edit)。partial 覆盖。 */
function mkOpen(
  path: string,
  partial: Partial<OpenFile> & { kind: OpenFile["kind"]; size: number },
): OpenFile {
  return {
    path,
    mode: "preview",
    savedContent: "",
    dirty: false,
    language: "plaintext",
    mdView: "edit",
    ...partial,
  };
}

/**
 * 把 dirId 的子项换成 fresh,保留 fresh 中与旧子项重合且「已加载」节点的 children/loaded
 * (刷新时已展开的孙目录不被清空)。dirId 不命中则递归子树查找。
 */
function reloadAt(nodes: FileNode[], dirId: string, fresh: FileNode[]): FileNode[] {
  return nodes.map((n) => {
    if (n.id === dirId) return { ...n, children: mergeKept(n.children, fresh), loaded: true };
    if (n.children) return { ...n, children: reloadAt(n.children, dirId, fresh) };
    return n;
  });
}

/** fresh 子项里,若某 id 在 old 中已 loaded(有 children),保留 old 的 children/loaded;否则用 fresh。 */
function mergeKept(old: FileNode[] | null, fresh: FileNode[]): FileNode[] {
  if (!old) return fresh;
  const oldById = new Map(old.map((n) => [n.id, n]));
  return fresh.map((n) => {
    const o = oldById.get(n.id);
    if (o && o.loaded && o.children) return { ...n, children: o.children, loaded: true };
    return n;
  });
}

/** 收集所有「已加载」目录 id(用于 fs-change 时定位需重拉的目录;根层单独处理)。 */
function collectLoadedDirs(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "dir" && n.loaded) out.push(n.id);
    if (n.children) collectLoadedDirs(n.children, out);
  }
  return out;
}

/**
 * 文件树 pane(独立 shell,纯 UI 不走 PTY)。
 *
 * 数据源:后端 `list_dir`(只读列一层) + `notify` 实时监听(`fs-change`)。react-arborist 懒加载:
 * 目录未加载 children=null,childrenAccessor 转 [] 显示展开箭头;展开(onToggle→open)时 list_dir
 * 拉一层并塞进 data。仅浏览(只读,无增删改)。
 *
 * 由 PaneSurface 按 activeTab.shellKind === "filetree" 分发挂载。header 结构与 TerminalPane/
 * SessionBrowserPane 同构(tab 条 + 刷新/+/▥/×,复用 ShellMenu)。
 */
export function FileTreePane({
  paneId,
  focused,
  sessions,
  activeTabId,
  projectId,
  onFocusPane,
  onClosePane,
  onSplitPane,
  onAddTab,
  onCloseTab,
  onSetActiveTab,
}: FileTreePaneProps) {
  const { t } = useTranslation();
  const { fontSize } = useSettings();
  // 文件树行高随字号联动(react-arborist rowHeight 固定,字号变大需加高否则文字被裁)。默认 13→22,与原固定值一致。
  const treeRowHeight = fontSize + 9;
  // rootPath 由活动 tab 对应 session 的 cwd 派生(= 项目根,与 SessionBrowserPane 取法一致)。
  const activeSession = sessions.find((s) => s.id === activeTabId);
  const rootPath = activeSession?.cwd ?? "";
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [treeSize, setTreeSize] = useState({ width: 0, height: 0 });
  // 探针 M2:打开文件标签池(≤20)+ 活动文件。selectedPath(单选)升级为 openFiles(多开)。
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const treeRef = useRef<TreeApi<FileNode> | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 左 Panel 内层 div:Tree 只占左 Panel,尺寸测它(而非整个 body)喂给 react-arborist 必填的 width/height。
  const treeBoxRef = useRef<HTMLDivElement | null>(null);
  // fs-change 回调里读最新 roots(回调闭包不随 roots 变化重建)。
  const rootsRef = useRef<FileNode[]>([]);
  rootsRef.current = roots;
  // 新建/分屏菜单:`"tab"`(+) / `"split"`(▥) / null(关)。open/close 由 Radix Popover 管。
  const [menuMode, setMenuMode] = useState<"tab" | null>(null);

  /** 打开文件上限(超则 LRU 淘汰最久未激活的)。 */
  const MAX_OPEN_FILES = 20;
  const openFilesRef = useRef<OpenFile[]>([]);
  openFilesRef.current = openFiles;
  /** Monaco model 池(path → ITextModel),跨 FileEditor unmount 存活。LRU/关文件/切 rootPath 时 dispose。 */
  const modelPoolRef = useRef<ModelPool>(new Map());
  /** 自动保存防抖间隔(5s)。 */
  const AUTOSAVE_MS = 5000;
  /** per-file 保存状态(不放 state 避免渲染抖动):{timer, inflight, resaveNeeded}。跨 FileEditor unmount 存活。 */
  const saveStateRef = useRef<Map<string, { timer: ReturnType<typeof setTimeout> | null; inflight: Promise<void> | null; resaveNeeded: boolean }>>(new Map());
  /** fs-notify 重载已打开文件时,setValue 会触发 onDidChangeModelContent → onContentChange 误判 dirty;
   *  用此 set 标记「正在重载」,onContentChange 检查跳过。 */
  const suppressDirtyRef = useRef<Set<string>>(new Set());
  /** 组件是否仍挂载(unmount 后异步 writeFile/setState 守卫)。 */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // unmount:先 forceFlushAll(同步快照所有脏文件落盘)再 dispose model 防泄漏。
      forceFlushAll();
      for (const model of modelPoolRef.current.values()) {
        (model as monaco.editor.ITextModel).dispose();
      }
      modelPoolRef.current.clear();
      saveStateRef.current.clear();
    };
    // forceFlushAll 读 ref(openFilesRef/modelPoolRef),不依赖其闭包变化;空依赖即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 按需加载 monaco:打开探针 pane 才动态 import monacoSetup(loader.config 注入本地 monaco
  // 实例禁 CDN、defineTheme("mx-dark")、MonacoEnvironment.getWorker 按 label 返回语言 worker)。
  // 必须在 FileEditor 的 <Editor> 首次渲染前完成 loader.config(Tauri 离线硬前提);本组件挂载
  // 早于用户点树文件打开 FileEditor,时序满足。ESM 单例,多次 import 只执行一次顶层副作用。
  useEffect(() => {
    void import("../monacoSetup");
  }, []);

  /** 活动文件(派生自 openFiles + activeFilePath)。 */
  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null;

  /**
   * 打开或激活文件(点树文件触发):
   * - 已在标签池 → 激活(移到数组头部,LRU 顺序)。
   * - 否则 readFile → 构造 OpenFile → 加入池(满 20 则 LRU 淘汰最久未激活的)→ 设为 active。
   * 批次3 只读:image=base64、text=初始内容、binary/error=展示态。编辑/保存批次5 接入。
   */
  const openOrActivate = useCallback((path: string) => {
    // 已在池:激活 + 移到头部(LRU 顺序,末尾=最久未激活=淘汰候选)。
    setOpenFiles((prev) => {
      const idx = prev.findIndex((f) => f.path === path);
      if (idx >= 0) {
        const [hit] = prev.splice(idx, 1);
        return [hit, ...prev];
      }
      return prev;
    });
    const existing = openFilesRef.current.find((f) => f.path === path);
    if (existing) {
      setActiveFilePath(path);
      return;
    }
    // 新开:readFile 构造 OpenFile。
    setLoadingFile(true);
    void readFile(path)
      .then((r) => {
        const image = isImage(path);
        let file: OpenFile;
        if (r.binary) {
          file = mkOpen(path, { kind: "binary", size: r.size });
        } else if (image && r.content != null && r.mime) {
          file = mkOpen(path, { kind: "image", size: r.size, content: r.content, mime: r.mime });
        } else if (r.content != null) {
          // 文本:truncated 文件(M1 已截断到 512KB)批次4 只读预览;批次6 拦截大文件进编辑。
          file = mkOpen(path, {
            kind: "text",
            size: r.size,
            content: r.content,
            truncated: r.truncated,
            language: guessLang(path),
          });
        } else {
          file = mkOpen(path, { kind: "binary", size: r.size });
        }
        // LRU:满 20 则淘汰末尾(最久未激活)——先 forceFlush 脏(落盘最新)再 dispose model 防泄漏。
        if (openFilesRef.current.length >= MAX_OPEN_FILES) {
          const evict = openFilesRef.current[MAX_OPEN_FILES - 1];
          if (evict) {
            forceFlushOne(evict.path);
            disposeModel(evict.path);
            clearSaveState(evict.path);
          }
        }
        setOpenFiles((prev) => {
          if (prev.some((f) => f.path === path)) return prev; // 竞态:期间已被打开
          const next = prev.length >= MAX_OPEN_FILES ? prev.slice(0, MAX_OPEN_FILES - 1) : prev;
          return [file, ...next];
        });
        setActiveFilePath(path);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        const file = mkOpen(path, { kind: "error", size: 0, error: msg });
        if (openFilesRef.current.length >= MAX_OPEN_FILES) {
          const evict = openFilesRef.current[MAX_OPEN_FILES - 1];
          if (evict) {
            forceFlushOne(evict.path);
            disposeModel(evict.path);
            clearSaveState(evict.path);
          }
        }
        setOpenFiles((prev) => {
          if (prev.some((f) => f.path === path)) return prev;
          const next = prev.length >= MAX_OPEN_FILES ? prev.slice(0, MAX_OPEN_FILES - 1) : prev;
          return [file, ...next];
        });
        setActiveFilePath(path);
      })
      .finally(() => setLoadingFile(false));
  }, []);

  /** 关闭标签(点 × / LRU 内部):先 forceFlush(同步快照最新内容落盘)再 dispose model + 移除。 */
  const closeFile = useCallback((path: string) => {
    // text 态:强制落盘最新内容(5s 未到也立即写),再 dispose model。
    const file = openFilesRef.current.find((f) => f.path === path);
    if (file?.kind === "text") forceFlushOne(path);
    disposeModel(path);
    clearSaveState(path);
    setOpenFiles((prev) => prev.filter((f) => f.path !== path));
    setActiveFilePath((cur) => {
      if (cur !== path) return cur;
      // 活动被关:激活剩余的第一个(数组头部=最近)。
      const rest = openFilesRef.current.filter((f) => f.path !== path);
      return rest[0]?.path ?? null;
    });
  }, []);

  /** viewState 变化上提(FileEditor saveViewState → 存 OpenFile.viewState,跨 unmount 存活)。 */
  const handleViewStateChange = useCallback((path: string, viewState: unknown) => {
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, viewState } : f)));
  }, []);

  /** 切文件 mode:preview↔edit。点「编辑」进 edit(可改、触发 5s 自动保存),点「只读」回 preview。 */
  const handleModeChange = useCallback((path: string, mode: "preview" | "edit") => {
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, mode } : f)));
  }, []);

  /** 切 md 视图:edit(Monaco 源码)↔ preview(marked 渲染 HTML)。仅 md 文件 edit 模式有此 toggle。 */
  const handleMdViewChange = useCallback((path: string, mdView: "edit" | "preview") => {
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, mdView } : f)));
  }, []);

  /** dispose 某文件 model(LRU 淘汰/关文件复用)。 */
  const disposeModel = (path: string) => {
    const model = modelPoolRef.current.get(path);
    if (model) {
      (model as monaco.editor.ITextModel).dispose();
      modelPoolRef.current.delete(path);
    }
  };

  /** 取某文件 model 的当前内容(text 态;非 text 返回 null)。 */
  const getModelValue = (path: string): string | null => {
    const model = modelPoolRef.current.get(path);
    return model ? (model as monaco.editor.ITextModel).getValue() : null;
  };

  /**
   * 执行保存(inflight+resave 串行链,content 快照作幂等键)。
   * - inflight 中:置 resaveNeeded=true 合并,不并发。
   * - 入口快照 content,落盘即此串;返回后重算 dirty(保存期间又改则 dirty 仍 true),resave 链补存最新。
   */
  const doSave = useCallback((path: string) => {
    const st = saveStateRef.current.get(path) ?? { timer: null, inflight: null, resaveNeeded: false };
    st.timer = null;
    if (st.inflight) {
      st.resaveNeeded = true;
      return;
    }
    const content = getModelValue(path);
    if (content == null) return;
    st.inflight = writeFile(path, content)
      .then(() => {
        const cur = getModelValue(path);
        const stillDirty = cur != null && cur !== content;
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === path ? { ...f, savedContent: content, dirty: stillDirty, saveError: undefined } : f,
          ),
        );
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, saveError: msg, dirty: true } : f)));
        // 不自动重试死循环;dirty 保持 true,内容不丢。
      })
      .finally(() => {
        st.inflight = null;
        if (st.resaveNeeded) {
          st.resaveNeeded = false;
          doSave(path);
        }
      });
  }, []);

  /**
   * 内容变化(FileEditor onChange 上提):标 dirty + 重置 5s timer。
   * 仅 edit 模式有意义(FileTreePane 在切 mode 时调 onContentChange 等价;此处统一由 FileEditor 上提)。
   */
  const onContentChange = useCallback((path: string) => {
    // fs-notify 重载触发的 setValue 跳过(不误判 dirty/不起 timer)。
    if (suppressDirtyRef.current.has(path)) return;
    const st = saveStateRef.current.get(path) ?? { timer: null, inflight: null, resaveNeeded: false };
    saveStateRef.current.set(path, st);
    const cur = getModelValue(path);
    const dirty = cur != null && cur !== openFilesRef.current.find((f) => f.path === path)?.savedContent;
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, dirty } : f)));
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => doSave(path), AUTOSAVE_MS);
  }, [doSave]);

  /**
   * 强制保存单文件(关文件/LRU/切项目/unmount 用):同步快照 model.getValue()(此刻 model 活着)
   * + 清 timer + fire writeFile(不 await inflight)。inflight 若在跑,两者并发写同文件,最后写者赢,
   * forceFlush 拿的是最新 content,故磁盘=最新。冗余一次写可接受。setState 用 mountedRef 守卫。
   */
  const forceFlushOne = useCallback((path: string) => {
    const st = saveStateRef.current.get(path);
    if (st?.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    const content = getModelValue(path);
    if (content == null) return;
    // 仅当与上次落盘不同才写(避免无谓并发写;但 inflight 可能正写旧值,这里仍写新值保证最新)。
    const file = openFilesRef.current.find((f) => f.path === path);
    if (file && content === file.savedContent && !file.dirty) return;
    void writeFile(path, content)
      .then(() => {
        if (!mountedRef.current) return;
        setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, savedContent: content, dirty: false, saveError: undefined } : f)));
      })
      .catch(() => {
        /* flush 失败:内容不丢(在 model/未 dispose);下次打开重读。unmount 路径无法提示。 */
      });
  }, []);

  /** 强制保存所有脏文件(切项目/unmount/关 pane)。 */
  const forceFlushAll = useCallback(() => {
    for (const f of openFilesRef.current) {
      if (f.kind === "text" && f.dirty) forceFlushOne(f.path);
    }
  }, [forceFlushOne]);

  /** 清单文件保存状态(timer/inflight 不强清,forceFlushOne 已清 timer)。 */
  const clearSaveState = (path: string) => {
    const st = saveStateRef.current.get(path);
    if (st?.timer) clearTimeout(st.timer);
    saveStateRef.current.delete(path);
  };

  // childrenAccessor:目录恒返回数组(未加载也 [],显示展开箭头);文件返回 null(叶子)。
  // 见 react-arborist create-root:children 为 null→isLeaf=true 无箭头;必须把未加载目录转 []。
  const childrenAccessor = useCallback(
    (d: FileNode): readonly FileNode[] | null => (d.kind === "dir" ? d.children ?? [] : null),
    [],
  );

  // 拉根层。rootPath 变化(切 tab/切项目)重拉(merge 保留已展开子树,虽切项目通常 roots 不同)。
  const loadRoot = useCallback(() => {
    if (!rootPath) return;
    setLoadingRoot(true);
    void listDir(rootPath)
      .then((fresh) => {
        setRoots((prev) => mergeKept(prev, fresh));
        setLoadingRoot(false);
      })
      .catch(() => setLoadingRoot(false));
  }, [rootPath]);
  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  // fs-watch 生命周期:挂载 start(projectId+rootPath),卸载 stop(后端引用计数,多 pane 共享)。
  useEffect(() => {
    if (!rootPath) return;
    void startFsWatch(projectId, rootPath).catch(() => {
      /* 非 Tauri 环境(mock dev)静默 */
    });
    return () => {
      void stopFsWatch(projectId).catch(() => {});
    };
  }, [projectId, rootPath]);

  // 切 tab(rootPath 变,即换项目或换到不同 cwd 的 filetree tab)清空打开的文件,避免跨项目串文件。
  // 先 forceFlushAll(同步快照所有脏文件落盘)再 dispose model 防泄漏。同项目根下 rootPath 不变则不清。
  useEffect(() => {
    forceFlushAll();
    for (const model of modelPoolRef.current.values()) {
      (model as monaco.editor.ITextModel).dispose();
    }
    modelPoolRef.current.clear();
    saveStateRef.current.clear();
    setOpenFiles([]);
    setActiveFilePath(null);
  }, [rootPath, forceFlushAll]);

  // 懒加载:展开未加载目录时 list_dir。仅 open 触发(close 忽略)。
  const handleToggle = useCallback((id: string) => {
    const tree = treeRef.current;
    if (!tree || !tree.isOpen(id)) return;
    const node = tree.get(id);
    if (!node || node.data.loaded === true) return;
    setLoadingId(id);
    void listDir(id)
      .then((fresh) => {
        setRoots((prev) => reloadAt(prev, id, fresh));
      })
      .catch(() => {})
      .finally(() => setLoadingId((cur) => (cur === id ? null : cur)));
  }, []);

  // fs-change 刷新:本项目的变更 → 重拉根层 + 所有已加载目录(merge 保留展开子树)。
  // 后端已 500ms 防抖聚合,这里按批重拉(targets 通常只有几个已展开目录)。
  useEffect(() => {
    let un: UnlistenFn | null = null;
    void onFsChange(async (e) => {
      if (e.projectId !== projectId) return;
      const targets = [rootPath, ...collectLoadedDirs(rootsRef.current)];
      for (const t of targets) {
        try {
          const fresh = await listDir(t);
          setRoots((prev) => (t === rootPath ? mergeKept(prev, fresh) : reloadAt(prev, t, fresh)));
        } catch {
          /* 路径暂不可达(被删等),跳过 */
        }
      }
      // 已打开文件的 fs-notify 重载:dirty 文件忽略(用户编辑优先,不 clobber);干净文件重载 model。
      const changed = new Set(e.paths);
      for (const f of openFilesRef.current) {
        if (f.kind !== "text" || f.dirty) continue; // dirty 忽略
        if (!changed.has(f.path)) continue;
        try {
          const r = await readFile(f.path);
          if (r.content == null) continue;
          const model = modelPoolRef.current.get(f.path) as monaco.editor.ITextModel | undefined;
          if (model) {
            suppressDirtyRef.current.add(f.path);
            model.setValue(r.content);
            // setValue 后下一 tick 清 suppress(onContentChange 在 setValue 同步触发,已跳过;保险)。
            queueMicrotask(() => suppressDirtyRef.current.delete(f.path));
          }
          setOpenFiles((prev) =>
            prev.map((o) => (o.path === f.path ? { ...o, savedContent: r.content ?? "", content: r.content ?? "", dirty: false } : o)),
          );
        } catch {
          /* 重载失败:保持现状 */
        }
      }
    }).then((u) => {
      un = u;
    });
    return () => {
      un?.();
    };
  }, [projectId, rootPath]);

  // 测左 Panel 内层尺寸供 react-arborist(内部 react-window)的 height/width(必填)。
  // 双栏后 Tree 只占左 Panel,故测 treeBoxRef 而非整个 body。
  // 用 useLayoutEffect(DOM 变更后、paint 前同步测)避免首帧 0 值闪现:react-window 收到
  // width/height=0 时不渲染任何行 → 树空白 → 点不到节点(不能展开/预览)。0 值不更新(保留上次有效值)。
  useLayoutEffect(() => {
    const el = treeBoxRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setTreeSize({ width: w, height: h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [roots.length]);

  // 新建/分屏菜单的 open/close 由 Radix Popover 管理(点外、Esc 内置),无需手写 effect。

  return (
    <article
      className="grid h-full min-h-0 min-w-0 grid-rows-[length:var(--mx-paneheader-h)_1fr] overflow-hidden bg-[var(--mx-editor-bg)]"
      onMouseDown={() => onFocusPane?.(paneId)}
    >
      {/* 顶部 header:tab 条 + 右侧按钮组(刷新 / + 新 tab / ▥ 分屏 / × 关 pane),与 TerminalPane/SessionBrowserPane 同构。 */}
      <header
        className={`flex min-w-0 shrink-0 items-center justify-between gap-2 px-2 text-xs transition-colors ${
          "bg-[var(--mx-tabbar-bg)]"
        }`}
      >
        {/* tab 条:每个 tab 一个 chip,点击切换,× 关闭。 */}
        {/* tab 条:Radix Tabs 受控(value=activeTabId)。TabsTrigger 内置 onMouseDown→onValueChange,
            替代手写 chip onMouseDown 切 tab。× 关闭按钮 onMouseDown stopPropagation 防点 × 误切 tab。 */}
        <Tabs value={activeTabId} onValueChange={(id) => onSetActiveTab?.(paneId, id)}>
        <TabsList className="mx-tabs-list flex min-w-0 items-center gap-0 overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {sessions.map((s) => {
            const isActive = s.id === activeTabId;
            return (
              <Tooltip>
              <TooltipTrigger asChild>
              <TabsTrigger asChild value={s.id}>
              <div
                key={s.id}
                className={`mx-tab-item group/tab flex h-[length:var(--mx-tab-h)] min-w-0 shrink cursor-pointer items-center gap-1 px-2 transition-colors ${
                  isActive
                    ? "text-[var(--mx-text-bright)]"
                    : "text-[var(--mx-text-dim)] hover:text-[var(--mx-text)]"
                }`}
              >
                <span className="min-w-0 max-w-[180px] truncate text-[length:var(--mx-ui-fs-sm)] font-[600]">{t(s.name)}</span>
                {sessions.length > 1 && onCloseTab && (
                  <Tooltip>
                  <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-3.5 w-3.5 text-[10px] text-[var(--mx-text-dim)] opacity-0 transition-opacity hover:text-[var(--mx-danger-bright)] group-hover/tab:opacity-100 hover:bg-transparent"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      onCloseTab(paneId, s.id);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    ×
                  </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("shell.tab.close")}</TooltipContent>
                  </Tooltip>
                )}
              </div>
              </TabsTrigger>
              </TooltipTrigger>
              <TooltipContent>{t(s.name)}</TooltipContent>
              </Tooltip>
            );
          })}
        </TabsList>
        </Tabs>
        <div className="flex shrink-0 items-center gap-1 text-[var(--mx-muted)]">
          {/* 刷新:重拉根层(merge 保留展开子树)。 */}
          <Tooltip>
          <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-[var(--mx-faint)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)] disabled:opacity-40"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={loadRoot}
            disabled={loadingRoot}
            aria-label={t("common.refresh")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </Button>
          </TooltipTrigger>
          <TooltipContent>{t("common.refresh")}</TooltipContent>
          </Tooltip>
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
      {/* 主体:双栏(左树 | 右预览),react-resizable-panels 可拖拽分隔条。
          bodyRef 保留(占位/空态测整体);Tree 尺寸由 treeBoxRef(左 Panel 内层)测。 */}
      <div ref={bodyRef} className="min-h-0 min-w-0 overflow-hidden font-mono text-xs">
        {loadingRoot && roots.length === 0 ? (
          <div className="grid h-full place-items-center text-[var(--mx-faint)]">{t("common.loading")}</div>
        ) : roots.length === 0 ? (
          <div className="grid h-full place-items-center px-3 text-center text-[var(--mx-faint)]">
            {rootPath ? t("filetree.emptyDir") : t("filetree.noProjectPath")}
          </div>
        ) : (
          <PanelGroup orientation="horizontal" className="h-full">
            {/* 左:react-arborist 懒加载树。treeBoxRef 测尺寸喂 Tree 必填的 width/height。
                size 用百分比字符串(v4 数字=像素,字符串=百分比);左栏 min 10% / max 60%,
                预览可占主体(40%~90%),树可收窄到 10% 也能放大到 60%。 */}
            <Panel defaultSize="40%" minSize="10%" maxSize="60%">
              {/* mx-scroll-pretty:美化 react-window 外层滚动条(后代选择器命中 ListOuterElement)。
                  treeBoxRef 自身 overflow:hidden 不滚动;滚动发生在 react-arborist 内部 react-window 外层。 */}
              <div ref={treeBoxRef} className="mx-scroll-pretty h-full min-h-0 min-w-0 overflow-hidden px-1 py-1">
                <Tree
                  ref={treeRef}
                  data={roots}
                  childrenAccessor={childrenAccessor}
                  openByDefault={false}
                  onToggle={handleToggle}
                  rowHeight={treeRowHeight}
                  width={treeSize.width}
                  height={treeSize.height}
                  disableDrag
                  disableDrop
                  disableEdit
                  disableMultiSelection
                >
                  {({ node, style }: { node: NodeApi<FileNode>; style: CSSProperties }) => {
                    const isSel = activeFilePath === node.data.id;
                    return (
                      <Tooltip>
                      <TooltipTrigger asChild>
                      <div
                        style={{ ...style, fontSize, lineHeight: `${treeRowHeight}px` }}
                        className={`flex cursor-pointer items-center gap-1 whitespace-nowrap px-1 hover:bg-[var(--mx-hover-bg)] ${
                          isSel ? "bg-[var(--mx-selected-bg)]" : ""
                        }`}
                        // react-arborist 用 react-dnd,行 div 会被设 draggable=true。
                        // 实测:draggable div 上 mousedown 后,react-dnd 的 selectstart 处理调
                        // target.dragDrop() 启动 drag,会吞掉浏览器合成的 click 事件 → onClick 不触发
                        // → 点目录不展开。改用 onMouseDown(必定触发)绕过;onDragStart 阻止残留 drag。
                        onDragStart={(e) => e.preventDefault()}
                        onMouseDown={(e) => {
                          // 双击的第二次 mousedown(detail>=2)跳过:否则与第一次 toggle 抵消(开→关)。
                          if (e.detail >= 2) return;
                          // 目录展开/收起;文件打开/激活(= 绝对路径)触发右栏。
                          if (node.data.kind === "dir") node.toggle();
                          else openOrActivate(node.data.id);
                        }}
                      >
                        {node.data.kind === "dir" ? (
                          <span className="w-3 shrink-0 text-[#34d399]">{node.isOpen ? "▾" : "▸"}</span>
                        ) : (
                          // 文件选中指示用小三角 ▸(U+25B8,与目录箭头同尺寸变体),非标准 ▶(U+25B6,偏大)。
                          // 选中态配 cyan 高亮指示「当前预览项」,与目录绿色箭头区分;未选中用中点 · 淡化。
                          <span className={`w-3 shrink-0 ${isSel ? "text-[var(--mx-accent)]" : "text-[var(--mx-text-dim)]"}`}>
                            {isSel ? "▸" : "·"}
                          </span>
                        )}
                        <span className={node.data.kind === "dir" ? "text-[#7dd3fc]" : isSel ? "text-[var(--mx-text-bright)]" : "text-[var(--mx-text)]"}>
                          {node.data.name}
                        </span>
                        {loadingId === node.id && <span className="text-[var(--mx-faint)]">…</span>}
                      </div>
                      </TooltipTrigger>
                      <TooltipContent>{node.data.id}</TooltipContent>
                      </Tooltip>
                    );
                  }}
                </Tree>
              </div>
            </Panel>
            <PanelResizeHandle className="w-px shrink-0 bg-[var(--mx-border-strong)] transition-colors hover:bg-[var(--mx-accent)] cursor-col-resize" />
            {/* 右:文件标签栏 + 预览/编辑。min 40%=左 max 60% 协调;max 90%=左 min 10% 协调。 */}
            <Panel defaultSize="60%" minSize="40%" maxSize="90%">
              <div className="flex h-full min-h-0 flex-col">
                {/* 打开文件标签栏:横向滚动,最多 20,LRU 淘汰。脏点 ● 批次5 编辑接入后显示。 */}
                {openFiles.length > 0 && (
                  <div className="flex shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-1 py-1 [&::-webkit-scrollbar]:hidden">
                    {openFiles.map((f) => {
                      const isActive = f.path === activeFilePath;
                      return (
                        <Tooltip key={f.path}>
                        <TooltipTrigger asChild>
                        <div
                          className={`group/ftab flex shrink-0 cursor-pointer items-center gap-1 rounded-[var(--mx-radius-sm)] border px-2 py-[2px] text-[11px] transition-colors ${
                            isActive
                              ? "border-[var(--mx-selected-border)] bg-[var(--mx-selected-bg)] text-[var(--mx-text)]"
                              : "border-transparent text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                          }`}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            if (e.detail >= 2) return;
                            openOrActivate(f.path);
                          }}
                        >
                          {f.dirty && <span className="text-[var(--mx-permissive)]">●</span>}
                          <span className="max-w-[120px] truncate font-mono">{basename(f.path)}</span>
                          <button
                            type="button"
                            className="ml-0.5 text-[10px] leading-none text-[var(--mx-faint)] opacity-0 transition-opacity hover:text-[var(--mx-danger-bright)] group-hover/ftab:opacity-100"
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              closeFile(f.path);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={t("shell.tab.close")}
                          >
                            ×
                          </button>
                        </div>
                        </TooltipTrigger>
                        <TooltipContent>{f.path}</TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                )}
                <div className="min-h-0 flex-1">
                  {activeFile?.kind === "text" ? (() => {
                    const isMd = activeFile.language === "markdown";
                    // md 预览(preview 模式 或 edit 模式下 mdView=preview):渲染 HTML;否则 Monaco。
                    const showMdPreview = isMd && (activeFile.mode === "preview" || activeFile.mdView === "preview");
                    // MdPreview 内容:model 优先(编辑后最新),fallback 初始 content。
                    const mdModel = modelPoolRef.current.get(activeFile.path) as monaco.editor.ITextModel | undefined;
                    // guard:防御任意路径在池里留下的悬空 disposed model(getValue 会 throw
                    //   "Model is disposed!",render 期抛错 → 黑屏)。disposed/缺失回退初始 content。
                    const mdContent = mdModel && !mdModel.isDisposed() ? mdModel.getValue() : (activeFile.content ?? "");
                    return (
                    <div className="flex h-full min-h-0 flex-col">
                      {/* truncated 提示(M1 已截断到 512KB 的文本)。 */}
                      {activeFile.truncated && (
                        <div className="shrink-0 border-b border-[var(--mx-border)] bg-[var(--mx-warning-soft)] px-2 py-0.5 text-[10px] text-[var(--mx-permissive)]">
                          {t("preview.truncated", { size: formatBytes(activeFile.size) })}
                        </div>
                      )}
                      {/* 编辑顶栏:文件名 + 脏/错误标 + (md 预览/编辑 toggle)+ 编辑/只读 toggle。 */}
                      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--mx-border)] px-2 py-1 text-[10px] text-[var(--mx-muted)]">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-mono">{basename(activeFile.path)}</span>
                          {activeFile.dirty && <span className="shrink-0 text-[var(--mx-permissive)]" title={t("probe.unsaved")}>●</span>}
                          {activeFile.saveError && (
                            <Tooltip>
                            <TooltipTrigger asChild>
                            <span className="shrink-0 text-[var(--mx-danger)]">⚠</span>
                            </TooltipTrigger>
                            <TooltipContent>{activeFile.saveError}</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {/* md 文件 edit 模式:编辑/预览 toggle(切 Monaco 源码 vs 渲染 HTML)。 */}
                          {isMd && activeFile.mode === "edit" && (
                            <div className="flex items-center rounded-[var(--mx-radius-sm)] border border-[var(--mx-border-strong)]">
                              <button
                                type="button"
                                className={`px-1.5 py-[1px] text-[10px] transition-colors ${
                                  activeFile.mdView === "edit" ? "bg-[var(--mx-selected-bg)] text-[var(--mx-text)]" : "text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
                                }`}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={() => handleMdViewChange(activeFile.path, "edit")}
                              >
                                {t("probe.edit")}
                              </button>
                              <button
                                type="button"
                                className={`px-1.5 py-[1px] text-[10px] transition-colors ${
                                  activeFile.mdView === "preview" ? "bg-[var(--mx-selected-bg)] text-[var(--mx-text)]" : "text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
                                }`}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={() => handleMdViewChange(activeFile.path, "preview")}
                              >
                                {t("probe.mdPreview")}
                              </button>
                            </div>
                          )}
                          <button
                            type="button"
                            disabled={activeFile.truncated}
                            title={activeFile.truncated ? t("probe.tooLarge") : undefined}
                            className={`shrink-0 rounded-[var(--mx-radius-sm)] border px-1.5 py-[1px] text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                              activeFile.mode === "edit"
                                ? "border-[var(--mx-selected-border)] bg-[var(--mx-selected-bg)] text-[var(--mx-text)]"
                                : "border-[var(--mx-border-strong)] text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                            }`}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => handleModeChange(activeFile.path, activeFile.mode === "edit" ? "preview" : "edit")}
                          >
                            {activeFile.mode === "edit" ? t("probe.readonly") : t("probe.edit")}
                          </button>
                        </div>
                      </div>
                      <div className="min-h-0 flex-1">
                        {showMdPreview ? (
                          <MdPreview content={mdContent} />
                        ) : (
                          <FileEditor
                            file={activeFile}
                            modelPool={modelPoolRef.current}
                            mode={activeFile.mode}
                            onViewStateChange={handleViewStateChange}
                            onContentChange={onContentChange}
                          />
                        )}
                      </div>
                    </div>
                    );
                  })() : (
                    <FilePreview file={activeFile} loading={loadingFile} />
                  )}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        )}
      </div>
    </article>
  );
}
