import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import type { ShellKind, SplitDirection } from "../domain/paneTree";
import type { WorkspaceSession } from "../domain/sessions";
import type { DirEntry } from "../domain/fileTree";
import { useSettings } from "../settings/SettingsProvider";
import { MdPreview } from "./MdPreview";
import { ShellMenu } from "./ShellMenu";
import { SplitPaneButtons } from "./SplitPaneButtons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover";
import { Button } from "./ui/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import { Tabs, TabsList, TabsTrigger } from "./ui/Tabs";

type NotesPaneProps = {
  paneId: string;
  sessions: WorkspaceSession[];
  activeTabId: string;
  focused?: boolean;
  onFocusPane?: (paneId: string) => void;
  onSplitPane?: (paneId: string, kind: ShellKind, direction: SplitDirection) => void;
  onClosePane?: (paneId: string) => void;
  onAddTab?: (paneId: string, kind: ShellKind, cwdOverride?: string, titleOverride?: string) => void;
  onCloseTab?: (paneId: string, tabId: string) => void;
  onSetActiveTab?: (paneId: string, tabId: string) => void;
  className?: string;
  /** 项目根路径(笔记 .note 文件存此目录,由 PaneSurface 透传)。 */
  rootPath: string;
  /** 重命名 tab(笔记随 md 一级标题更新 tab 名,由 PaneSurface 透传)。 */
  onRenameTab?: (tabId: string, title: string) => void;
};

/** 单个笔记 tab 的运行时状态(内容草稿/已保存快照/加载态)。tab 关闭即清。 */
type NoteState = {
  /** 当前编辑器内容(含未保存改动)。 */
  content: string;
  /** 最近一次落盘的内容(用于判断 dirty)。 */
  savedContent: string;
  /** 是否已从磁盘加载过(未加载过则切换到该 tab 时触发读取)。 */
  loaded: boolean;
  /** 加载/保存错误信息(null=无错)。 */
  error: string | null;
};

/** 新笔记的初始正文。 */
const NEW_NOTE_BODY = "# 新笔记\n\n";

/**
 * 从 md 正文提取一级标题作为 tab 名:取第一行以 `# ` 开头(允许前导空白)、去掉标记后的文本。
 * 无一级标题返回 null(调用方保留文件名)。标题过长截断到 40 字符(单字符计,中文友好)。
 */
function extractH1(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const m = /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const title = m[1].trim();
      if (title) return title.length > 40 ? title.slice(0, 40) + "…" : title;
    }
  }
  return null;
}

export function NotesPane({
  paneId,
  sessions,
  activeTabId,
  onFocusPane,
  onSplitPane,
  onClosePane,
  onAddTab,
  onCloseTab,
  onSetActiveTab,
  className,
  rootPath,
  onRenameTab,
}: NotesPaneProps) {
  const { t } = useTranslation();
  const { fontSize, bgSetting } = useSettings();
  const [menuMode, setMenuMode] = useState<"tab" | null>(null);
  const [openOpen, setOpenOpen] = useState(false);
  const [showEditor, setShowEditor] = useState(true);
  /** tab id → 该笔记的运行时状态。 */
  const notesRef = useRef<Map<string, NoteState>>(new Map());
  const [, forceTick] = useState(0);
  const bump = useCallback(() => forceTick((n) => n + 1), []);
  /** 保存防抖定时器(tab id → timer)。 */
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** notes 目录里的现有笔记(打开菜单用),打开菜单时拉取。 */
  const [dirEntries, setDirEntries] = useState<DirEntry[]>([]);
  const [loadingDir, setLoadingDir] = useState(false);

  const activeSession = sessions.find((s) => s.id === activeTabId);
  /** 当前 tab 对应的笔记文件绝对路径(tab.cwd 复用存笔记路径)。无 cwd 或非 .note = 空态。 */
  const notePath = activeSession?.cwd ?? "";
  const isNoteFile = notePath.toLowerCase().endsWith(".note");

  /** 取(或初始化)某 tab 的 NoteState。 */
  const getState = useCallback((tabId: string): NoteState => {
    let s = notesRef.current.get(tabId);
    if (!s) {
      s = { content: "", savedContent: "", loaded: false, error: null };
      notesRef.current.set(tabId, s);
    }
    return s;
  }, []);

  // 切到某 tab 且是笔记文件、尚未加载 → read_file 读盘。tab 关闭由外层 sessions 变化驱动,
  // 这里不主动清理(切回同 tab 已加载的内容仍在,避免重复读);组件卸载时清全部。
  useEffect(() => {
    if (!isNoteFile || !activeTabId) return;
    const s = getState(activeTabId);
    if (s.loaded) return;
    let alive = true;
    s.loaded = true; // 先置位防并发重复读(读失败也不重试,用户可切走再切回?此处保持简单)。
    invoke<{ content: string | null; truncated: boolean }>("read_file", { path: notePath })
      .then((res) => {
        if (!alive) return;
        s.content = res.content ?? "";
        s.savedContent = s.content;
        s.error = null;
        // 打开已有笔记:若含一级标题,同步 tab 名(无则保留文件名)。
        const title = extractH1(s.content);
        if (title) onRenameTab?.(activeTabId, title);
        bump();
      })
      .catch((e) => {
        if (!alive) return;
        // 非 Tauri/读失败:标记 loaded 但留空内容 + 错误,允许内存编辑(草稿不丢)。
        s.content = "";
        s.savedContent = "";
        s.error = String(e);
        bump();
      });
    return () => {
      alive = false;
    };
  }, [activeTabId, isNoteFile, notePath, getState, bump, onRenameTab]);

  // flushSave 的最新引用(卸载时用,避免空依赖 effect 捕获初始闭包读到旧 sessions)。
  const flushSaveRef = useRef<(tabId: string, s: NoteState) => void>(() => {});

  /** 立即把某 tab 内容写盘(清防抖)。 */
  const flushSave = useCallback((tabId: string, s: NoteState) => {
    const timer = saveTimers.current.get(tabId);
    if (timer) {
      clearTimeout(timer);
      saveTimers.current.delete(tabId);
    }
    const path = sessions.find((x) => x.id === tabId)?.cwd;
    if (!path?.toLowerCase().endsWith(".note")) return;
    s.error = null;
    bump();
    invoke("write_file", { path, content: s.content })
      .then(() => {
        s.savedContent = s.content;
        bump();
      })
      .catch((e) => {
        s.error = String(e);
        bump();
      });
  }, [sessions, bump]);

  // 每次渲染更新 ref 为最新 flushSave;卸载 effect 经 ref 调用,无 stale closure。
  flushSaveRef.current = flushSave;

  // 卸载:flush 所有未保存草稿(防丢最后一次防抖未触发的写入)。
  useEffect(() => {
    return () => {
      for (const [tid, timer] of saveTimers.current) {
        clearTimeout(timer);
        const s = notesRef.current.get(tid);
        if (s) flushSaveRef.current(tid, s);
      }
    };
  }, []);

  /** 编辑:更新内容 + 600ms 防抖保存。同时从一级标题同步 tab 名(debounce 以 rAF)。 */
  const handleChange = useCallback((text: string) => {
    if (!activeTabId) return;
    const s = getState(activeTabId);
    s.content = text;
    bump();
    // tab 名跟随一级标题:提取首条 # 标题,无则不动(保留文件名)。重名/相同标题 renameTab 短路不写盘。
    const title = extractH1(text);
    if (title) onRenameTab?.(activeTabId, title);
    const existing = saveTimers.current.get(activeTabId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => flushSave(activeTabId, s), 600);
    saveTimers.current.set(activeTabId, timer);
  }, [activeTabId, getState, bump, flushSave, onRenameTab]);

  /** 新建笔记:在项目根写初始 .note 文件 → 新开 tab(cwd=文件路径,title=文件名)。 */
  const handleNew = useCallback(async () => {
    if (!rootPath || !onAddTab) return;
    try {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const fname = `note-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.note`;
      const fpath = await join(rootPath, fname);
      await invoke("write_file", { path: fpath, content: NEW_NOTE_BODY });
      onAddTab(paneId, "notes", fpath, fname);
    } catch (e) {
      console.warn("[NotesPane] new note failed:", e);
    }
  }, [rootPath, onAddTab, paneId]);

  /** 打开菜单展开时列项目根下的 .note 文件。 */
  const refreshDir = useCallback(async () => {
    if (!rootPath) return;
    setLoadingDir(true);
    try {
      const entries = await invoke<DirEntry[]>("list_dir", { path: rootPath }).catch(() => [] as DirEntry[]);
      setDirEntries(entries.filter((e) => e.kind === "file" && e.name.toLowerCase().endsWith(".note")));
    } finally {
      setLoadingDir(false);
    }
  }, [rootPath]);

  // 打开菜单开关变化:打开时拉一次目录。
  useEffect(() => {
    if (openOpen) void refreshDir();
  }, [openOpen, refreshDir]);

  /** 打开某现有笔记:新开 tab(已开则切到它)。 */
  const handleOpenFile = useCallback(async (name: string) => {
    if (!rootPath || !onAddTab) return;
    setOpenOpen(false);
    const fpath = await join(rootPath, name);
    onAddTab(paneId, "notes", fpath, name);
  }, [rootPath, onAddTab, paneId]);

  // 失焦立即 flush(切 tab 由 activeTabId 变化 + textarea onBlur 双保险)。
  const handleBlur = useCallback(() => {
    if (!activeTabId) return;
    const s = notesRef.current.get(activeTabId);
    if (s && s.content !== s.savedContent) flushSave(activeTabId, s);
  }, [activeTabId, flushSave]);

  const current = activeTabId ? notesRef.current.get(activeTabId) : undefined;
  const content = current?.content ?? "";
  const dirty = !!current && current.content !== current.savedContent;
  const saving = saveTimers.current.has(activeTabId ?? "");
  const hasError = !!current?.error;

  // 空态:当前 tab 不是笔记文件(初始 notes tab,cwd=项目根)→ 引导新建。
  const showEmpty = !isNoteFile;

  return (
    <article
      className={`grid h-full min-h-0 min-w-0 grid-rows-[length:var(--mx-paneheader-h)_1fr] overflow-hidden bg-[var(--mx-editor-bg)] ${className ?? ""}`}
      // 背景图开时笔记完全透明(贴合主题图);inline 覆盖 class 的 editor-bg。
      style={bgSetting.path ? { background: "transparent" } : undefined}
      onMouseDown={() => onFocusPane?.(paneId)}
    >
      {/* header:tab 条 + 右侧按钮(新建/打开/编辑显隐/分屏/关闭),与其他 pane 同构。 */}
      <header className="flex min-w-0 shrink-0 items-center justify-between gap-2 bg-[var(--mx-tabbar-bg)] px-2 text-xs transition-colors">
        <Tabs value={activeTabId} onValueChange={(id) => onSetActiveTab?.(paneId, id)}>
          <TabsList className="mx-tabs-list flex min-w-0 items-center gap-0 overflow-x-auto [&::-webkit-scrollbar]:hidden">
            {sessions.map((s) => {
              const isActive = s.id === activeTabId;
              return (
                <Tooltip key={s.id}>
                  <TooltipTrigger asChild>
                    <TabsTrigger asChild value={s.id}>
                      <div
                        className={`mx-tab-item group/tab flex h-[length:var(--mx-tab-h)] min-w-0 shrink cursor-pointer items-center gap-1 px-2 transition-colors ${
                          isActive ? "text-[var(--mx-text-bright)]" : "text-[var(--mx-text-dim)] hover:text-[var(--mx-text)]"
                        }`}
                      >
                        <span className="min-w-0 max-w-[180px] truncate text-[length:var(--mx-ui-fs-sm)] font-[600]">{t(s.name)}</span>
                        {sessions.length > 1 && onCloseTab && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-3.5 w-3.5 text-[10px] text-[var(--mx-text-dim)] opacity-0 transition-opacity hover:bg-transparent hover:text-[var(--mx-danger-bright)] group-hover/tab:opacity-100"
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              onCloseTab(paneId, s.id);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            ×
                          </Button>
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
          {/* 保存状态点:未保存●/已保存✓/错误!。空态不显示。 */}
          {!showEmpty && (
            <span
              className={`px-1 text-[length:var(--mx-ui-fs-xs)] ${hasError ? "text-[var(--mx-danger-bright)]" : dirty ? "text-[var(--mx-accent)]" : "text-[var(--mx-faint)]"}`}
              title={current?.error ?? (dirty ? t("notes.unsaved") : t("notes.saved"))}
            >
              {hasError ? "!" : saving ? "…" : dirty ? "●" : "✓"}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={handleNew} onMouseDown={(e) => e.stopPropagation()} className="text-[14px]">
                ✎
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("notes.newNote")}</TooltipContent>
          </Tooltip>
          {onAddTab && (
            <Popover open={openOpen} onOpenChange={setOpenOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onMouseDown={(e) => e.stopPropagation()} className="text-[14px]">
                      📄
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{t("notes.openNote")}</TooltipContent>
              </Tooltip>
              <PopoverContent className="w-56 p-1" align="end">
                <div className="mx-scroll-pretty max-h-[min(50vh,320px)] overflow-y-auto">
                  {loadingDir ? (
                    <div className="px-3 py-2 text-[length:var(--mx-ui-fs-xs)] text-[var(--mx-faint)]">…</div>
                  ) : dirEntries.length === 0 ? (
                    <div className="px-3 py-2 text-[length:var(--mx-ui-fs-xs)] text-[var(--mx-faint)]">{t("notes.emptyNotesDir")}</div>
                  ) : (
                    dirEntries.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        onMouseDown={(ev) => ev.stopPropagation()}
                        onClick={() => void handleOpenFile(e.name)}
                        className="block w-full truncate rounded px-3 py-1.5 text-left text-xs text-[var(--mx-text)] hover:bg-[var(--mx-hover-bg)]"
                        title={e.name}
                      >
                        {e.name}
                      </button>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}
          {isNoteFile && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowEditor((v) => !v)}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="pb-0.5 text-[12px] leading-none"
                >
                  {showEditor ? "◧" : "◨"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{showEditor ? t("notes.hideEditor") : t("notes.showEditor")}</TooltipContent>
            </Tooltip>
          )}
          {onAddTab && (
            <Popover open={menuMode === "tab"} onOpenChange={(o) => setMenuMode(o ? "tab" : null)}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onMouseDown={(e) => e.stopPropagation()} className="text-[14px]">
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
                    onAddTab?.(paneId, kind);
                  }}
                />
              )}
            </Popover>
          )}
          {onSplitPane && <SplitPaneButtons onSplit={(kind, direction) => onSplitPane(paneId, kind, direction)} />}
          {onClosePane && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    onClosePane(paneId);
                  }}
                  className="text-[13px]"
                >
                  ×
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("shell.pane.close")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      {/* 主体。 */}
      {showEmpty ? (
        <div className="grid h-full place-items-center px-6 text-center text-sm text-[var(--mx-faint)]">
          <div className="flex flex-col items-center gap-3">
            <span className="text-3xl">✎</span>
            <span>{t("notes.empty")}</span>
            <Button size="sm" onClick={handleNew}>
              {t("notes.newNote")}
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={`grid min-h-0 min-w-0 flex-1 ${showEditor ? "grid-cols-2 gap-px" : "grid-cols-1"}`}
          // 背景开时 grid 容器也透明:它原用 bg-border-strong 作 1px 分割线底色,但子面板
          // 透明时这层浅灰会透出来像白雾;分割线改由右子面板左边框承担(见预览区)。
          style={bgSetting.path ? { background: "transparent" } : showEditor ? { background: "var(--mx-border-strong)" } : undefined}
        >
          {showEditor && (
            <div className="flex min-h-0 min-w-0 flex-col bg-[var(--mx-editor-bg)]" style={bgSetting.path ? { background: "transparent" } : undefined}>
              <div className="flex shrink-0 items-center justify-between border-b border-[var(--mx-border)] px-2 py-1 text-[10px] text-[var(--mx-faint)]">
                <span>{t("notes.source")}</span>
                {current?.error && <span className="text-[var(--mx-danger-bright)]" title={current.error}>{t("notes.saveFailed")}</span>}
              </div>
              <textarea
                value={content}
                onChange={(e) => handleChange(e.target.value)}
                onBlur={handleBlur}
                spellCheck={false}
                placeholder="# 标题…"
                className="mx-scroll-pretty min-h-0 flex-1 resize-none bg-transparent p-3 leading-relaxed text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)]"
                style={{
                  fontSize,
                  fontFamily: '"CaskaydiaCoveNF", "MesloLGM NF", "Cascadia Code", Consolas, monospace',
                  ...(bgSetting.path ? { background: "transparent" } : {}),
                }}
              />
            </div>
          )}
          {/* 预览:MdPreview 实时渲染(marked+DOMPurify+highlight.js),随全局 fontSize 缩放。
              双栏时左边框作分割线(替代 grid gap-px + 容器底色,后者在透明面板下会透白雾)。 */}
          <div
            className={`mx-scroll-pretty min-h-0 min-w-0 overflow-auto bg-[var(--mx-editor-bg)] p-3 ${showEditor ? "border-l border-[var(--mx-border-strong)]" : ""}`}
            style={bgSetting.path ? { background: "transparent" } : undefined}
          >
            <div className="mx-auto w-full max-w-[54.25rem]">
              <MdPreview content={content || ""} inline />
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
