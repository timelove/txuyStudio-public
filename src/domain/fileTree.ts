import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** list_dir 返回的原始条目(与后端 DirEntry 对齐,camelCase)。 */
export type DirEntry = {
  id: string;
  name: string;
  kind: "dir" | "file";
  size: number | null;
  /** mtime 的 unix 秒(UTC),前端按 locale 格式化。 */
  modified: number | null;
};

/** react-arborist 树节点:在 DirEntry 基础上加 children(懒加载)+ loaded 标记。 */
export type FileNode = DirEntry & {
  /** 目录:已加载的真实子项(null=未加载,由 childrenAccessor 转 [] 显示展开箭头);文件恒 null。 */
  children: FileNode[] | null;
  /** 目录是否已 list_dir 过(防 onToggle 重复加载)。 */
  loaded?: boolean;
};

/** DirEntry → FileNode(children 置 null,待懒加载)。 */
export function entryToNode(e: DirEntry): FileNode {
  return { ...e, children: null };
}

/** 列出指定目录一层(不递归)。非 Tauri 环境 invoke reject → 抛错(调用方 catch 兜底)。 */
export async function listDir(path: string): Promise<FileNode[]> {
  const entries = await invoke<DirEntry[]>("list_dir", { path });
  return entries.map(entryToNode);
}

/** read_file 返回(与后端 ReadFileResult 对齐,camelCase)。 */
export type ReadFileResult = {
  /** 文本=内容;图片=base64;不可预览=null。 */
  content: string | null;
  /** 非 null 表示图片(拼 data URL 用,如 "image/png")。 */
  mime: string | null;
  /** true=不可预览(非文本且非图片)。 */
  binary: boolean;
  /** true=超 512KB 截断(仅文本路径;图片不截断)。 */
  truncated: boolean;
  /** 完整文件大小(字节)。 */
  size: number;
};

// ── 探针 M2:打开文件标签 + 编辑 ──────────────────────────────────────
// OpenFile 是「已打开的文件」运行期状态(不持久化,重开 tab 重新读盘)。
// source of truth 是 Monaco model(text 态),savedContent 仅作 dirty 比较基准。

/** 打开文件的种类:image=图片预览、binary=不可预览、error=读取失败、text=可编辑文本。 */
export type OpenFileKind = "image" | "binary" | "error" | "text";

/**
 * Monaco model 池(path → ITextModel)。用 `unknown` 作 value 类型避免 domain 层依赖 monaco
 * (实际是 `monaco.editor.ITextModel`,FileEditor 内 cast)。提升到 FileTreePane 跨 FileEditor
 * unmount 存活。model 按 `monaco.Uri.file(path)` 全局存活,池 ref 仅追踪「哪些 model 开着」用于 dispose。
 */
export type ModelPool = Map<string, unknown>;

/** 编辑/预览模式:preview=只读、edit=可编辑。 */
export type EditMode = "preview" | "edit";

/**
 * 已打开文件(探针右栏标签池的一项)。≤20,超则 LRU 淘汰最久未激活的(先 flush 脏)。
 *
 * - text 态:content 是 readFile 时的初始内容(批次3 只读用);接 model 池后 source of truth
 *   迁到 Monaco model,此处 savedContent 作 dirty 比较。viewState 存 Monaco 视图状态。
 * - image 态:content 是 base64,mime 拼 data URL。
 * - binary/error 态:content 空,仅 size/error 展示。
 */
export type OpenFile = {
  path: string;
  kind: OpenFileKind;
  mode: EditMode;
  /** 初始/上次落盘内容(text 比较用;image 是 base64)。text 接 model 池后=上次落盘内容。 */
  savedContent: string;
  dirty: boolean;
  saveError?: string;
  language: string;
  /** md 编辑/预览 toggle 态(md 文件 edit 模式专属)。 */
  mdView: "edit" | "preview";
  /** Monaco viewState(滚动/光标/折叠),切文件时 save/restore;跨 FileEditor unmount 存活。unknown 避 domain 依赖 monaco。 */
  viewState?: unknown;
  /** 图片 base64(image 态);其余空。 */
  content?: string;
  /** 图片 MIME(image 态拼 data URL)。 */
  mime?: string | null;
  truncated?: boolean;
  size: number;
  error?: string;
};

/**
 * 读文件内容(只读预览用)。非 Tauri / 失败 → 抛错,调用方 catch 显示错误态。
 * 不内部吞错:预览面板需区分 加载中/错误/二进制/图片/文本 五种态。
 */
export async function readFile(path: string): Promise<ReadFileResult> {
  return await invoke<ReadFileResult>("read_file", { path });
}

/**
 * 写文件内容(M2 编辑落盘)。非 Tauri / 失败 → 抛错,调用方 catch 标 saveError。
 * 后端原子写(.tmp + rename);失败兜底直接写。
 */
export async function writeFile(path: string, content: string): Promise<void> {
  await invoke("write_file", { path, content });
}

/** 启动项目文件监听(后端引用计数,多 filetree pane 共享一个 watcher)。 */
export async function startFsWatch(projectId: string, rootPath: string): Promise<void> {
  await invoke("start_fs_watch", { projectId, rootPath });
}

/** 停止项目文件监听(引用计数,最后一个 pane 卸载才真正停止)。 */
export async function stopFsWatch(projectId: string): Promise<void> {
  await invoke("stop_fs_watch", { projectId });
}

/** fs-change 事件载荷(后端防抖聚合后 emit)。 */
export type FsChangePayload = { projectId: string; paths: string[] };

/**
 * 监听 fs-change,回调收到 {projectId, paths}。返回取消监听函数。
 * 非 Tauri 环境(mock dev)listen reject → catch 返回 null,调用方需判空。
 */
export async function onFsChange(cb: (e: FsChangePayload) => void): Promise<UnlistenFn | null> {
  try {
    return await listen<FsChangePayload>("fs-change", (ev) => cb(ev.payload));
  } catch {
    return null;
  }
}
