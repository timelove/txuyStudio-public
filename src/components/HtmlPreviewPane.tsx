import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ReadFileResult } from "../domain/fileTree";
import type { ShellKind, SplitDirection } from "../domain/paneTree";
import type { WorkspaceSession } from "../domain/sessions";
import { ShellMenu } from "./ShellMenu";
import { SplitPaneButtons } from "./SplitPaneButtons";
import { Popover, PopoverTrigger } from "./ui/Popover";
import { Button } from "./ui/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import { Tabs, TabsList, TabsTrigger } from "./ui/Tabs";

type HtmlPreviewPaneProps = {
  paneId: string;
  sessions: WorkspaceSession[];
  activeTabId: string;
  focused?: boolean;
  onFocusPane?: (paneId: string) => void;
  onSplitPane?: (paneId: string, kind: ShellKind, direction: SplitDirection) => void;
  onClosePane?: (paneId: string) => void;
  onAddTab?: (paneId: string, kind: ShellKind) => void;
  onCloseTab?: (paneId: string, tabId: string) => void;
  onSetActiveTab?: (paneId: string, tabId: string) => void;
  className?: string;
};

/** 新 tab 的占位示例:打开即见预览效果,清空后用户贴自己的 HTML。 */
const SAMPLE_HTML = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #0b1020; color: #cbd5e1;
           display: grid; place-items: center; height: 100vh; }
    .card { padding: 24px 32px; border-radius: 12px; background: var(--mx-accent-soft);
            border: 1px solid rgba(34,211,238,0.3); text-align: center; }
    h1 { margin: 0 0 8px; font-size: 20px; color: #67e8f9; }
    p { margin: 0; font-size: 13px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>HTML 预览</h1>
    <p>在左侧粘贴或编辑 HTML,右侧即时预览</p>
  </div>
</body>
</html>
`;

/**
 * HTML 预览面板:左侧贴/编辑 HTML 源码,右侧 iframe srcdoc 沙箱即时渲染。
 *
 * 纯 UI 面板(不走 PTY/transport),与 filetree/sessionbrowser 同构。内容存组件内
 * per-tab useState(tab 关闭即清,不落盘)。iframe 用 sandbox=""(全禁:无脚本/无表单/
 * 无同源)+ srcdoc,任意外部 HTML 都安全渲染;禁用脚本是为安全(沙箱内脚本可访问父窗口
 * 会逃逸),纯排版/样式预览不受影响。
 */
export function HtmlPreviewPane({
  paneId,
  sessions,
  activeTabId,
  focused,
  onFocusPane,
  onSplitPane,
  onClosePane,
  onAddTab,
  onCloseTab,
  onSetActiveTab,
  className,
}: HtmlPreviewPaneProps) {
  const { t } = useTranslation();
  const [menuMode, setMenuMode] = useState<"tab" | null>(null);
  /** 左侧 HTML 编辑区是否显示(false = 仅预览,占满全宽)。per pane(非 per tab)。 */
  const [showEditor, setShowEditor] = useState(true);
  /** per-tab HTML 内容(tab id → 源码)。不持久化,tab 关闭即清。 */
  const [htmlByTab, setHtmlByTab] = useState<Record<string, string>>({});
  /** per-tab 已加载文件的来源路径(显示用;空串 = 纯手输,无来源)。 */
  const [sourcePathByTab, setSourcePathByTab] = useState<Record<string, string>>({});
  /** per-tab 路径输入框草稿(待回车/点打开才加载)。 */
  const [pathInputByTab, setPathInputByTab] = useState<Record<string, string>>({});
  /** per-tab 加载错误(文件不存在/二进制/读取失败)。加载成功或手输时清空。 */
  const [loadErrorByTab, setLoadErrorByTab] = useState<Record<string, string>>({});
  /** per-tab 加载中(读盘异步,防重复点击)。 */
  const [loadingByTab, setLoadingByTab] = useState<Record<string, boolean>>({});

  const html = htmlByTab[activeTabId] ?? SAMPLE_HTML;
  const sourcePath = sourcePathByTab[activeTabId] ?? "";
  const pathInput = pathInputByTab[activeTabId] ?? "";
  const loadError = loadErrorByTab[activeTabId] ?? "";
  const loading = loadingByTab[activeTabId] ?? false;

  /** 更新某 tab 某 map 字段的便捷函数(减少样板)。 */
  const patchTab = <T,>(setter: React.Dispatch<React.SetStateAction<Record<string, T>>>, tabId: string, value: T) =>
    setter((prev) => ({ ...prev, [tabId]: value }));

  const setHtml = (v: string) => {
    patchTab<string>(setHtmlByTab, activeTabId, v);
    // 手输即脱离「文件来源」状态(用户改了内容,不再是加载的那个文件)。
    patchTab<string>(setSourcePathByTab, activeTabId, "");
    patchTab<string>(setLoadErrorByTab, activeTabId, "");
  };

  /** 从磁盘加载本地 HTML 文件到当前 tab(读文件 → 填源码 + 预览 + 记录来源)。 */
  const loadFromPath = async (rawPath: string) => {
    const path = rawPath.trim();
    if (!path || loading) return;
    patchTab<boolean>(setLoadingByTab, activeTabId, true);
    patchTab<string>(setLoadErrorByTab, activeTabId, "");
    try {
      const res = await invoke<ReadFileResult>("read_file", { path });
      if (res.binary || res.content == null) {
        patchTab<string>(setLoadErrorByTab, activeTabId, t("htmlpreview.loadErrorBinary"));
      } else {
        patchTab<string>(setHtmlByTab, activeTabId, res.content);
        patchTab<string>(setSourcePathByTab, activeTabId, path);
        patchTab<string>(setPathInputByTab, activeTabId, path);
        if (res.truncated) patchTab<string>(setLoadErrorByTab, activeTabId, t("htmlpreview.loadTruncated"));
      }
    } catch (e) {
      patchTab<string>(setLoadErrorByTab, activeTabId, t("htmlpreview.loadErrorRead", { error: String(e) }));
    } finally {
      patchTab<boolean>(setLoadingByTab, activeTabId, false);
    }
  };

  /** 系统文件选择器选 HTML 文件 → loadFromPath。 */
  const pickFile = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "HTML", extensions: ["html", "htm"] }],
      });
      // open 多选 false 时返回 string | null(取消 = null)。
      if (typeof selected === "string" && selected) void loadFromPath(selected);
    } catch {
      // 非 Tauri 环境 / dialog 不可用,静默忽略。
    }
  };

  return (
    <article
      className={`grid h-full min-h-0 min-w-0 grid-rows-[28px_1fr] overflow-hidden bg-[var(--mx-editor-bg)] ${className ?? ""}`}
      onMouseDown={() => onFocusPane?.(paneId)}
    >
      {/* header:tab 条 + 右侧按钮组(+ 新 tab / ▥ 分屏 / × 关 pane),与 TerminalPane/ClaudePane 同构。 */}
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
                <Tooltip key={s.id}>
                  <TooltipTrigger asChild>
                    <TabsTrigger asChild value={s.id}>
                      <div
                        className={`mx-tab-item group/tab flex h-[24px] min-w-0 shrink cursor-pointer items-center gap-1 px-2 transition-colors ${
                          isActive
                            ? "text-[var(--mx-text-bright)]"
                            : "text-[var(--mx-text-dim)] hover:text-[var(--mx-text)]"
                        }`}
                      >
                        <span className="truncate text-[11px] font-[600]">{t(s.name)}</span>
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

      {/* 主体:工具条(打开本地文件) + 左编辑 + 右预览。 */}
      <div className="flex min-h-0 min-w-0 flex-col">
        {/* 工具条:路径输入(回车/点「打开」加载)+ 📂 系统文件选择器。加载错误在条内红字提示。 */}
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2 py-1.5">
          <input
            value={pathInput}
            onChange={(e) => patchTab<string>(setPathInputByTab, activeTabId, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void loadFromPath(pathInput);
            }}
            placeholder={t("htmlpreview.pathPlaceholder")}
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-[var(--mx-border-strong)] bg-[var(--mx-editor-bg)] px-2 py-1 font-mono text-[11px] text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)] focus:border-[var(--mx-accent)]"
          />
          {/* 编辑区显示/隐藏切换:隐藏后预览占满全宽(只看渲染效果)。 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setShowEditor((v) => !v)}
                className="flex shrink-0 items-center justify-center pb-0.5 text-[12px] leading-none text-[var(--mx-muted)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
              >
                {showEditor ? "◧" : "◨"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showEditor ? t("htmlpreview.hideEditor") : t("htmlpreview.showEditor")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={loading}
                onClick={() => void pickFile()}
                className="flex shrink-0 items-center justify-center leading-none text-[var(--mx-muted)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
              >
                {loading ? (
                  <svg className="block h-[14px] w-[14px] animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                ) : (
                  <svg className="block h-[14px] w-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M15 3H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M15 3v5h6" />
                  </svg>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("htmlpreview.browse")}</TooltipContent>
          </Tooltip>
        </div>
        {/* 来源/错误提示行:有来源显来源(可二次确认),有错误显错误(红)。 */}
        {(sourcePath || loadError) && (
          <div className="shrink-0 truncate border-b border-[var(--mx-border)] px-2 py-1 text-[10px]">
            {loadError ? (
              <span className="text-[var(--mx-danger-bright)]">{loadError}</span>
            ) : (
              <span className="text-[var(--mx-faint)]" title={sourcePath}>
                {t("htmlpreview.loadedFrom")} {sourcePath}
              </span>
            )}
          </div>
        )}
        {/* 编辑 + 预览:showEditor 时两栏(grid-cols-2 + 分割线),隐藏编辑后预览独占全宽(grid-cols-1,无分割线)。 */}
        <div className={`grid min-h-0 min-w-0 flex-1 ${showEditor ? "grid-cols-2 gap-px bg-[var(--mx-border-strong)]" : "grid-cols-1"}`}>
          {/* 编辑区:贴/改 HTML,onChange 实时更新右侧预览。showEditor=false 时整个移除(预览占满)。 */}
          {showEditor && (
            <div className="flex min-h-0 min-w-0 flex-col bg-[var(--mx-editor-bg)]">
              <div className="flex shrink-0 items-center justify-between border-b border-[var(--mx-border)] px-2 py-1 text-[10px] text-[var(--mx-faint)]">
                <span>{t("htmlpreview.source")}</span>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
                  onClick={() => setHtml("")}
                >
                  {t("htmlpreview.clear")}
                </button>
              </div>
              <textarea
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                spellCheck={false}
                placeholder={t("htmlpreview.placeholder")}
                className="mx-scroll-pretty min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-relaxed text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)]"
              />
            </div>
          )}
          {/* 预览区:srcdoc 渲染 html;sandbox="" 全禁(无脚本/表单/同源),纯排版样式即时可见。 */}
          <div className="min-h-0 min-w-0 bg-white">
            <iframe
              title={t("htmlpreview.preview")}
              sandbox=""
              srcDoc={html}
              className="h-full w-full border-0"
            />
          </div>
        </div>
      </div>
    </article>
  );
}
