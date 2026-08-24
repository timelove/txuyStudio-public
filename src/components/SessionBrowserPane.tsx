import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchAiCliSessions, deleteAiCliSession, fetchAiCliSessionMessages, fetchAiCliProviders, resumeCommandFor } from "../domain/aiCliSessions";
import type { AiCliKind, AiCliProviderInfo, AiCliSessionListItem, AiCliSessionMessage } from "../domain/aiCliSessions";
import { AI_CLI_PROVIDERS, groupSessionsByProject, isCurrentProjectGroup, UNKNOWN_PROJECT_KEY } from "../domain/aiCliSessions";
import type { ShellKind, SplitDirection } from "../domain/paneTree";
import type { WorkspaceSession } from "../domain/sessions";
import { ShellMenu } from "./ShellMenu";
import { SplitPaneButtons } from "./SplitPaneButtons";
import { Button } from "./ui/Button";
import { Popover, PopoverTrigger } from "./ui/Popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import { Tabs, TabsList, TabsTrigger } from "./ui/Tabs";

type SessionBrowserPaneProps = {
  paneId: string;
  focused: boolean;
  /** 该 pane 所有 tab 的 session(一个 tab = 一个 session)。 */
  sessions: WorkspaceSession[];
  /** 当前可见 tab 的 id(=== 某 session.id)。 */
  activeTabId: string;
  onFocusPane?: (paneId: string) => void;
  onClosePane?: (paneId: string) => void;
  /** 在当前 pane 上分屏(新建一个 pane)。 */
  onSplitPane?: (paneId: string, kind: ShellKind, direction: SplitDirection) => void;
  /** 在当前 pane 新建一个 tab(指定 shell 类型)。 */
  onAddTab?: (paneId: string, kind: ShellKind) => void;
  /** 关闭当前 pane 的某个 tab(关到最后一个 = 关 pane,由上层处理)。 */
  onCloseTab?: (paneId: string, tabId: string) => void;
  /** 切换当前 pane 的活动 tab。 */
  onSetActiveTab?: (paneId: string, tabId: string) => void;
  onResumeSession?: (provider: "claude" | "codex", sessionId: string, cwd?: string | null) => void;
};

/** provider 过滤选项:"all" 合并所有 provider,否则只看该 provider。 */
type ProviderFilter = "all" | AiCliKind;

/** 相对时间格式化器。按当前 i18n locale 取 Intl locale(zh→zh,en→en),非 Tauri/无 Intl 兜底原值。 */
function relativeTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = then - Date.now();
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const intlLocale = locale === "en" ? "en" : "zh";
  const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(intlLocale, { numeric: "auto" }) : null;
  if (!rtf) return iso;
  if (Math.abs(sec) < 60) return rtf.format(sec, "second");
  if (Math.abs(min) < 60) return rtf.format(min, "minute");
  if (Math.abs(hr) < 24) return rtf.format(hr, "hour");
  return rtf.format(day, "day");
}

/** 绝对时间格式化(详情头部用,与 cc-switch formatTimestamp 同语义)。locale 决定 zh-CN/en-US。 */
function absoluteTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const intlLocale = locale === "en" ? "en-US" : "zh-CN";
  return new Date(t).toLocaleString(intlLocale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 折叠分组持久化 key(localStorage,参考 cc-switch SESSION_GROUP_EXPANSION_STORAGE_KEY)。 */
const COLLAPSED_GROUPS_KEY = "mx.sessionGroup.collapsed";

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups(set: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...set]));
  } catch {
    // 忽略写失败(隐私模式/配额)。
  }
}

/**
 * 会话列表 pane(独立 shell,参考 cc-switch 双栏布局)。
 *
 * 不走 PTY(不 spawn PowerShell),纯 UI 面板。左栏合并当前项目 claude+codex 会话(标题/时间/kind 标识
 * + 搜索 + 刷新 + 总数 + 复制 sessionId + 删除),右栏选中会话详情(阶段 3 接消息流渲染)。
 *
 * 由 PaneSurface 按 activeTab.shellKind === "sessionbrowser" 分发挂载。
 */
export function SessionBrowserPane({ paneId, focused, sessions, activeTabId, onFocusPane, onClosePane, onSplitPane, onAddTab, onCloseTab, onSetActiveTab, onResumeSession }: SessionBrowserPaneProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  // rootPath 由活动 tab 对应 session 的 cwd 派生(与 PaneSurface 取法一致):不同 tab cwd 不同则切 tab 重拉。
  const activeSession = sessions.find((s) => s.id === activeTabId);
  const rootPath = activeSession?.cwd ?? "";
  const [items, setItems] = useState<AiCliSessionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** provider 下拉选择(默认 all 合并)。 */
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  /** provider 注册表(从后端拉,失败回退本地 AI_CLI_PROVIDERS)。 */
  const [providers, setProviders] = useState<AiCliProviderInfo[]>(AI_CLI_PROVIDERS);
  /** 折叠的项目分组 key 集合(默认全展开,localStorage 持久化)。 */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups);
  /** 正在二次确认删除的分组 key(null = 无)。 */
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  /** 新建/分屏菜单:`"tab"`(+) / `"split"`(▥) / null(关)。open/close 由 Radix Popover 管。 */
  const [menuMode, setMenuMode] = useState<"tab" | null>(null);
  const [resumeProvider, setResumeProvider] = useState<AiCliKind>("claude");
  const [resumeInput, setResumeInput] = useState("");

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedGroups(next);
      return next;
    });
  }, []);

  // 拉取 provider 注册表(挂载一次)。
  useEffect(() => {
    fetchAiCliProviders().then(setProviders);
  }, []);

  // 拉取会话列表:providerFilter=all 时合并拉所有 provider,否则只拉选中的。
  // rootPath/providerFilter 变化时重拉(丢弃旧响应)。
  const load = useCallback(() => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    const targets: AiCliKind[] =
      providerFilter === "all" ? providers.map((p) => p.id) : [providerFilter];
    Promise.all(targets.map((pid) => fetchAiCliSessions(rootPath, pid))).then((lists) => {
      if (reqIdRef.current !== reqId) return;
      const merged = lists
        .flat()
        .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
      setItems(merged);
      setLoading(false);
    });
  }, [rootPath, providerFilter, providers]);

  useEffect(() => {
    load();
  }, [load]);

  // 切 sessionbrowser tab = 切上下文(不同 rootPath 对应不同项目的会话列表):
  // 清空选中/搜索,避免残留。rootPath 变化由 load effect 自动重拉;cwd 相同则不重拉(数据相同,正确)。
  useEffect(() => {
    setSelectedId(null);
    setQuery("");
  }, [activeTabId]);

  // 新建/分屏菜单的 open/close 由 Radix Popover 管理(点外、Esc 内置),无需手写 effect。

  // 搜索过滤:按标题/cwd/sessionId 匹配(大小写不敏感)。
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        (it.title ?? "").toLowerCase().includes(q) ||
        (it.cwd ?? "").toLowerCase().includes(q) ||
        it.sessionId.toLowerCase().includes(q),
    );
  }, [items, query]);

  const selected = useMemo(
    () => filtered.find((it) => it.sessionId === selectedId) ?? null,
    [filtered, selectedId],
  );

  // 按项目(cwd 末段)分组:全局扫后聚合,当前项目组(rootPath)强制置顶,其余按组内最新 lastAt 降序。
  const grouped = useMemo(() => groupSessionsByProject(filtered, rootPath), [filtered, rootPath]);

  // 选中会话 → 拉消息流。selectedId/kind 变化时重拉(丢弃旧响应)。
  const [messages, setMessages] = useState<AiCliSessionMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const msgReqRef = useRef(0);
  useEffect(() => {
    if (!selected) {
      setMessages([]);
      return;
    }
    const reqId = ++msgReqRef.current;
    setMsgLoading(true);
    // rootPath 用会话自己 cwd(claude 读消息需按 cwd encode 定位文件)。
    fetchAiCliSessionMessages(selected.cwd ?? rootPath, selected.providerId, selected.sessionId).then((list) => {
      if (msgReqRef.current !== reqId) return;
      setMessages(list);
      setMsgLoading(false);
    });
  }, [selected, rootPath]);

  // 删除:调后端删 jsonl,成功后从本地列表移除。
  // rootPath 用**会话自己的 cwd**(全局扫后,组件级 rootPath 可能不等于该会话所属项目;
  // claude 删/读需按 cwd encode 定位文件,codex 按 sessionId 文件名定位不依赖 cwd)。
  const handleDelete = useCallback(
    async (sessionId: string, providerId: AiCliKind, cwd: string | null) => {
      const rootForItem = cwd ?? rootPath;
      const ok = await deleteAiCliSession(rootForItem, providerId, sessionId);
      if (ok) {
        setItems((prev) => prev.filter((it) => it.sessionId !== sessionId));
        if (selectedId === sessionId) setSelectedId(null);
      }
      setPendingDelete(null);
    },
    [rootPath, selectedId],
  );

  // 分组批量删除:并行删该组所有会话,全部完成后从本地列表移除已删项。
  // 每条仍用其自己的 cwd 作 rootPath(跨 provider/项目混合组也各自定位正确)。
  const handleDeleteGroup = useCallback(
    async (sessions: AiCliSessionListItem[]) => {
      const results = await Promise.all(
        sessions.map((it) =>
          deleteAiCliSession(it.cwd ?? rootPath, it.providerId, it.sessionId).then((ok) => ({ id: it.sessionId, ok })),
        ),
      );
      const removed = new Set(results.filter((r) => r.ok).map((r) => r.id));
      if (removed.size > 0) {
        setItems((prev) => prev.filter((it) => !removed.has(it.sessionId)));
        if (selectedId && removed.has(selectedId)) setSelectedId(null);
      }
      setPendingDeleteGroup(null);
    },
    [rootPath, selectedId],
  );

  const handleResumeById = useCallback(() => {
    const sid = resumeInput.trim();
    if (!sid) return;
    const matched = items.find((it) => it.sessionId === sid);
    onResumeSession?.(resumeProvider, sid, matched?.cwd ?? null);
    setResumeInput("");
  }, [resumeInput, resumeProvider, items, onResumeSession]);

  return (
    <article
      className="grid h-full min-h-0 min-w-0 grid-rows-[length:var(--mx-paneheader-h)_1fr] overflow-hidden bg-[var(--mx-editor-bg)]"
      onMouseDown={() => onFocusPane?.(paneId)}
    >
      {/* 顶部 header:tab 条 + 右侧按钮组(刷新 / + 新 tab / ▥ 分屏 / × 关 pane),与 TerminalPane 同构。 */}
      <header className={`flex min-w-0 shrink-0 items-center justify-between gap-2 px-2 text-xs transition-colors ${"bg-[var(--mx-tabbar-bg)]"}`}>
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
          {/* 刷新:重拉当前 rootPath 的会话列表。 */}
          <Tooltip>
          <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-[var(--mx-faint)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)] disabled:opacity-40"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={load}
            disabled={loading}
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

      {/* 双栏:左列表 + 右详情。 */}
      <div className="grid min-h-0 min-w-0 grid-cols-[280px_1fr]">
        {/* 左栏:provider 下拉 + 搜索 + 列表。 */}
        <div className="flex min-h-0 min-w-0 flex-col border-r border-[var(--mx-border)]">
          <div className="shrink-0 px-2 py-1.5 border-b border-[var(--mx-border)]">
            {/* provider 下拉框 + 搜索框 同行(下拉窄,搜索占剩余);尾部显示 过滤数/总数。 */}
            <div className="flex items-center gap-1.5">
              <select
                value={providerFilter}
                onChange={(e) => { setProviderFilter(e.target.value as ProviderFilter); setSelectedId(null); }}
                className="mx-chip w-[88px] shrink-0 border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-1.5 py-1 text-[11px] text-[var(--mx-text)] focus:outline-none focus:border-[var(--mx-accent)] cursor-pointer"
              >
                <option value="all">{t("session.all")}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("session.searchPlaceholder")}
                className="mx-chip min-w-0 flex-1 border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2 py-1 text-[11px] text-[var(--mx-text)] placeholder:text-[var(--mx-faint)] focus:outline-none focus:border-[var(--mx-accent)]"
              />
              <Tooltip>
              <TooltipTrigger asChild>
              <span className="shrink-0 tabular-nums text-[10px] text-[var(--mx-faint)]">{filtered.length}/{items.length}</span>
              </TooltipTrigger>
              <TooltipContent>{t("session.filterCount")}</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div className="shrink-0 border-b border-[var(--mx-border)] px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <select
                value={resumeProvider}
                onChange={(e) => setResumeProvider(e.target.value as AiCliKind)}
                className="mx-chip w-[72px] shrink-0 border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-1.5 py-1 text-[11px] text-[var(--mx-text)] focus:outline-none focus:border-[var(--mx-accent)] cursor-pointer"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <input
                type="text"
                value={resumeInput}
                onChange={(e) => setResumeInput(e.target.value)}
                placeholder={t("session.resumeSessionIdPlaceholder")}
                className="mx-chip min-w-0 flex-1 border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2 py-1 font-mono text-[11px] text-[var(--mx-text)] placeholder:text-[var(--mx-faint)] focus:outline-none focus:border-[var(--mx-accent)]"
              />
              <Button
                size="sm"
                className="shrink-0 px-2 py-1 text-[11px]"
                onClick={handleResumeById}
                disabled={!resumeInput.trim()}
              >
                {t("session.resumeById")}
              </Button>
            </div>
          </div>
          <div className="mx-scroll min-h-0 flex-1 overflow-y-auto">
            {loading && items.length === 0 ? (
              <div className="grid h-full place-items-center text-[11px] text-[var(--mx-faint)]">{t("session.loading")}</div>
            ) : filtered.length === 0 ? (
              <div className="grid h-full place-items-center px-3 text-center text-[11px] text-[var(--mx-faint)]">
                {items.length === 0 ? t("session.empty") : t("session.noMatch")}
              </div>
            ) : (
              <ul className="py-1">
                {grouped.map((group) => {
                  const collapsed = collapsedGroups.has(group.key);
                  const isCurrent = isCurrentProjectGroup(group, rootPath);
                  const confirmingGroup = pendingDeleteGroup === group.key;
                  return (
                    <li key={group.key ?? UNKNOWN_PROJECT_KEY}>
                      {/* 分组 header:可折叠,显示项目名 + 该组会话数。当前项目组高亮(accent 左边框)。 */}
                      <Tooltip>
                      <TooltipTrigger asChild>
                      <div
                        role="button"
                        tabIndex={0}
                        className={`group relative flex cursor-pointer items-center gap-1 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide hover:bg-[var(--mx-hover-bg)] ${isCurrent ? "border-l-2 border-[var(--mx-accent)] bg-[var(--mx-accent-soft)] text-[var(--mx-accent)]" : "text-[var(--mx-muted)]"}`}
                        onClick={() => toggleGroup(group.key)}
                      >
                        <span className="text-[8px] leading-none text-[var(--mx-faint)]">{collapsed ? "▶" : "▼"}</span>
                        <span className="truncate">{t(group.label)}</span>
                        {isCurrent && <span className="mx-icon-tile shrink-0 bg-[var(--mx-accent)] px-1 text-[8px] text-[var(--mx-editor-bg)]">{t("session.current")}</span>}
                        <span className="ml-auto shrink-0 tabular-nums text-[var(--mx-faint)]">{group.sessions.length}</span>
                        {/* hover:删除整组(小图标,与组会话数同行)。 */}
                        {!confirmingGroup && (
                          <Tooltip>
                          <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="ml-1 shrink-0 text-[var(--mx-faint)] opacity-0 group-hover:opacity-100 hover:text-[var(--mx-danger)]"
                            onClick={(e) => { e.stopPropagation(); setPendingDeleteGroup(group.key); }}
                            aria-label={t("session.deleteGroup", { count: group.sessions.length })}
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                            </svg>
                          </button>
                          </TooltipTrigger>
                          <TooltipContent>{t("session.deleteGroup", { count: group.sessions.length })}</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      </TooltipTrigger>
                      <TooltipContent>{group.cwd ?? t("session.unknownProject")}</TooltipContent>
                      </Tooltip>
                      {/* 整组删除二次确认。 */}
                      {confirmingGroup && (
                        <div className="flex items-center gap-1 px-3 py-1 text-[10px]">
                          <span className="text-[var(--mx-danger)]">{t("session.deleteGroupConfirm", { count: group.sessions.length })}</span>
                          <Button size="xs" variant="danger" className="ml-auto" onClick={(e) => { e.stopPropagation(); void handleDeleteGroup(group.sessions); }}>{t("common.confirm")}</Button>
                          <Button size="xs" variant="outline" onClick={(e) => { e.stopPropagation(); setPendingDeleteGroup(null); }}>{t("common.cancel")}</Button>
                        </div>
                      )}
                      {!collapsed &&
                        group.sessions.map((item) => (
                          <SessionRow
                            key={`${item.providerId}-${item.sessionId}`}
                            item={item}
                            providers={providers}
                            isSel={selectedId === item.sessionId}
                            confirming={pendingDelete === item.sessionId}
                            onSelect={setSelectedId}
                            onAskDelete={setPendingDelete}
                            onCancelDelete={() => setPendingDelete(null)}
                            onDelete={handleDelete}
                            onResume={(it) => onResumeSession?.(it.providerId, it.sessionId, it.cwd)}
                          />
                        ))}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* 右栏:选中会话详情(元数据 + resume 命令 + 消息流)。 */}
        <div className="min-h-0 min-w-0 overflow-hidden">
          {selected ? (
            <div className="mx-scroll flex h-full flex-col overflow-y-auto">
              {/* 元数据 + resume 命令 + 删除。 */}
              <div className="shrink-0 border-b border-[var(--mx-border)] px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-[var(--mx-text)]">{selected.title ?? t("session.noTitle", { id: selected.sessionId.slice(0, 8) })}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--mx-muted)]">
                      <span>{providers.find((p) => p.id === selected.providerId)?.label ?? selected.providerId}</span>
                      <span className="text-[var(--mx-faint)]">·</span>
                      <span>{relativeTime(selected.lastAt, locale)}</span>
                      <span className="text-[var(--mx-faint)]">·</span>
                      <span className="tabular-nums">{t("session.messageCount", { count: selected.messageCount })}</span>
                      {selected.gitBranch && (
                        <>
                          <span className="text-[var(--mx-faint)]">·</span>
                          <span className="font-mono text-[var(--mx-accent)]">⎇ {selected.gitBranch}</span>
                        </>
                      )}
                    </div>
                    {/* 绝对时间(开始 / 最近)。 */}
                    <div className="mt-0.5 text-[10px] text-[var(--mx-faint)]">
                      {t("session.startedAt")} {absoluteTime(selected.startedAt, locale)} · {t("session.lastAt")} {absoluteTime(selected.lastAt, locale)}
                    </div>
                    {/* 完整 cwd(可点击复制,删/读 claude 会话的 rootPath 即此)。 */}
                    <Tooltip>
                    <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="mt-0.5 block max-w-full truncate font-mono text-[10px] text-[var(--mx-faint)] hover:text-[var(--mx-muted)] cursor-pointer"
                      onClick={() => selected.cwd && navigator.clipboard?.writeText(selected.cwd).catch(() => {})}
                    >
                      {selected.cwd ?? t("session.unknownProjectPath")}
                    </button>
                    </TooltipTrigger>
                    <TooltipContent>{selected.cwd ? t("session.copyPath", { cwd: selected.cwd }) : t("session.unknownProjectPath")}</TooltipContent>
                    </Tooltip>
                    <div className="mt-0.5 font-mono text-[10px] text-[var(--mx-faint)]">{selected.sessionId}</div>
                  </div>
                  {/* 删除:小图标,点击二次确认(与列表项一致,防误删)。 */}
                  {pendingDelete === selected.sessionId ? (
                    <div className="flex shrink-0 items-center gap-1 text-[10px]">
                      <span className="text-[var(--mx-danger)]">{t("session.deleteConfirm")}</span>
                      <Button size="xs" variant="danger" onClick={() => void handleDelete(selected.sessionId, selected.providerId, selected.cwd)}>{t("common.confirm")}</Button>
                      <Button size="xs" variant="outline" onClick={() => setPendingDelete(null)}>{t("common.cancel")}</Button>
                    </div>
                  ) : (
                    <Tooltip>
                    <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="shrink-0 text-[var(--mx-faint)] hover:text-[var(--mx-danger)] cursor-pointer"
                      onClick={() => setPendingDelete(selected.sessionId)}
                      aria-label={t("session.deleteSession")}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                      </svg>
                    </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("session.deleteRecord")}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
                {/* resume 命令文本(可复制,用户手动在终端粘贴执行)。 */}
                <Tooltip>
                <TooltipTrigger asChild>
                <button
                  type="button"
                  className="mx-chip mt-2 block w-full truncate border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2 py-1 text-left font-mono text-[11px] text-[var(--mx-accent)] hover:bg-[var(--mx-hover-bg)] cursor-pointer"
                  onClick={() => navigator.clipboard?.writeText(resumeCommandFor(selected.providerId, selected.sessionId)).catch(() => {})}
                >
                  {resumeCommandFor(selected.providerId, selected.sessionId)}
                </button>
                </TooltipTrigger>
                <TooltipContent>{t("session.copy")}</TooltipContent>
                </Tooltip>
                <Button
                  size="sm"
                  className="mt-2 w-full"
                  onClick={() => onResumeSession?.(selected.providerId, selected.sessionId, selected.cwd)}
                >
                  {t("session.resume")}
                </Button>
              </div>
              {/* 消息流。 */}
              <div className="min-h-0 flex-1 px-4 py-3 space-y-2.5">
                {msgLoading ? (
                  <div className="text-[11px] text-[var(--mx-faint)]">{t("session.loadingMessages")}</div>
                ) : messages.length === 0 ? (
                  <div className="text-[11px] text-[var(--mx-faint)]">{t("session.noMessages")}</div>
                ) : (
                  messages.map((m, i) => (
                    <MessageRow key={i} msg={m} />
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center text-[11px] text-[var(--mx-faint)]">{t("session.tipSelect")}</div>
          )}
        </div>
      </div>
    </article>
  );
}

/** 单个会话列表行:provider 标识 + 标题 + 相对时间 + git 分支 + 条数 + hover 操作。 */
function SessionRow({
  item,
  providers,
  isSel,
  confirming,
  onSelect,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onResume,
}: {
  item: AiCliSessionListItem;
  providers: AiCliProviderInfo[];
  isSel: boolean;
  confirming: boolean;
  onSelect: (id: string) => void;
  onAskDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (sessionId: string, providerId: AiCliKind, cwd: string | null) => void;
  onResume: (item: AiCliSessionListItem) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const title = item.title ?? t("session.noTitle", { id: item.sessionId.slice(0, 8) });
  const pmeta = providers.find((p) => p.id === item.providerId) ?? AI_CLI_PROVIDERS[0];
  return (
    <Tooltip>
    <TooltipTrigger asChild>
    <div
      role="button"
      tabIndex={0}
      className={`group relative flex cursor-pointer flex-col gap-0.5 px-2.5 py-1.5 text-left transition-colors ${isSel ? "bg-[var(--mx-hover-bg)]" : "hover:bg-[var(--mx-hover-bg)]"}`}
      onClick={() => onSelect(item.sessionId)}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="mx-icon-tile grid h-3.5 w-3.5 shrink-0 place-items-center text-[9px] font-bold"
          style={{ background: pmeta.accent, color: "var(--mx-editor-bg)" }}
        >{pmeta.glyph}</span>
        <span className={`min-w-0 flex-1 truncate text-[12px] leading-tight ${isSel ? "text-[var(--mx-text)]" : "text-[var(--mx-muted)] group-hover:text-[var(--mx-text)]"}`}>{title}</span>
        {/* hover:复制 sessionId(小图标,不抢标题空间)。 */}
        {!confirming && (
          <Tooltip>
          <TooltipTrigger asChild>
          <button
            type="button"
            className="shrink-0 text-[var(--mx-faint)] opacity-0 group-hover:opacity-100 hover:text-[var(--mx-text)]"
            onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(item.sessionId).catch(() => {}); }}
            aria-label={t("session.copySessionId")}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <rect x="9" y="9" width="11" height="11" rx="1" />
              <path d="M5 15V5a1 1 0 0 1 1-1h10" />
            </svg>
          </button>
          </TooltipTrigger>
          <TooltipContent>{t("session.copySessionId")}</TooltipContent>
          </Tooltip>
        )}
        {!confirming && (
          <Tooltip>
          <TooltipTrigger asChild>
          <button
            type="button"
            className="shrink-0 text-[var(--mx-accent)] opacity-0 group-hover:opacity-100 hover:brightness-125"
            onClick={(e) => { e.stopPropagation(); onResume(item); }}
            aria-label={t("session.resume")}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          </TooltipTrigger>
          <TooltipContent>{t("session.resume")}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex items-center gap-1.5 pl-5 text-[10px] text-[var(--mx-faint)]">
        <span className="shrink-0">{relativeTime(item.lastAt, locale)}</span>
        {item.gitBranch && (
          <Tooltip>
          <TooltipTrigger asChild>
          <span className="truncate font-mono text-[var(--mx-muted)]">⎇ {item.gitBranch}</span>
          </TooltipTrigger>
          <TooltipContent>{item.gitBranch}</TooltipContent>
          </Tooltip>
        )}
        <span className="shrink-0 tabular-nums">{t("session.messageCount", { count: item.messageCount })}</span>
        {/* hover:删除(小图标,与条数同行)。 */}
        {!confirming && (
          <Tooltip>
          <TooltipTrigger asChild>
          <button
            type="button"
            className="ml-auto shrink-0 text-[var(--mx-faint)] opacity-0 group-hover:opacity-100 hover:text-[var(--mx-danger)]"
            onClick={(e) => { e.stopPropagation(); onAskDelete(item.sessionId); }}
            aria-label={t("session.deleteSession")}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
            </svg>
          </button>
          </TooltipTrigger>
          <TooltipContent>{t("session.deleteRecord")}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {confirming && (
        <div className="mt-0.5 flex items-center gap-1 pl-5 text-[10px]">
          <span className="text-[var(--mx-danger)]">{t("session.deleteConfirm")}</span>
          <Button size="xs" variant="danger" className="ml-auto" onClick={(e) => { e.stopPropagation(); void onDelete(item.sessionId, item.providerId, item.cwd); }}>{t("common.confirm")}</Button>
          <Button size="xs" variant="outline" onClick={(e) => { e.stopPropagation(); onCancelDelete(); }}>{t("common.cancel")}</Button>
        </div>
      )}
    </div>
    </TooltipTrigger>
    <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

/** 单条消息行:user/assistant 区分样式,text + toolUse + toolResult,点击复制。 */
function MessageRow({ msg }: { msg: AiCliSessionMessage }) {
  const { t } = useTranslation();
  const isUser = msg.role === "user";
  const copy = (s: string) => navigator.clipboard?.writeText(s).catch(() => {});
  return (
    <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      <span className={`text-[10px] font-semibold uppercase tracking-wide ${isUser ? "text-[var(--mx-accent)]" : "text-[var(--mx-violet)]"}`}>{t(`session.role.${msg.role}`)}</span>
      {msg.text && (
        <Tooltip>
        <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => copy(msg.text)}
          className={`mx-chip max-w-[88%] whitespace-pre-wrap break-words px-2.5 py-1.5 text-left text-[12px] leading-relaxed cursor-pointer ${isUser ? "bg-[var(--mx-accent-soft)] text-[var(--mx-text)]" : "bg-[var(--mx-accent-deep-soft)] text-[var(--mx-text)]"} hover:brightness-110`}
        >{msg.text}</button>
        </TooltipTrigger>
        <TooltipContent>{t("session.copy")}</TooltipContent>
        </Tooltip>
      )}
      {msg.toolUse && (
        <Tooltip>
        <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => copy(`${msg.toolUse!.name}: ${msg.toolUse!.inputBrief}`)}
          className="mx-chip max-w-[88%] truncate border border-[var(--mx-border)] px-2 py-1 text-left font-mono text-[10px] text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] cursor-pointer"
        >
          <span className="text-[var(--mx-violet)]">⟡ {msg.toolUse.name}</span> <span className="text-[var(--mx-faint)]">{msg.toolUse.inputBrief}</span>
        </button>
        </TooltipTrigger>
        <TooltipContent>{t("session.copyToolUse")}</TooltipContent>
        </Tooltip>
      )}
      {msg.toolResult && (
        <Tooltip>
        <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => copy(msg.toolResult!)}
          className="mx-chip max-w-[88%] whitespace-pre-wrap break-words border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2 py-1 text-left font-mono text-[10px] text-[var(--mx-faint)] hover:bg-[var(--mx-hover-bg)] cursor-pointer"
        >{msg.toolResult}</button>
        </TooltipTrigger>
        <TooltipContent>{t("session.copyToolResult")}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
