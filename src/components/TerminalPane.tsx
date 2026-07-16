import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ShellKind } from "../domain/paneTree";
import { SHELL_KIND_META } from "../domain/shellKinds";
import type { WorkspaceSession } from "../domain/sessions";
import type { TerminalTransport } from "../domain/terminalTransport";
import { ShellMenu } from "./ShellMenu";
import { Popover, PopoverTrigger } from "./ui/Popover";
import { Button } from "./ui/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import { Tabs, TabsList, TabsTrigger } from "./ui/Tabs";

type TerminalPaneProps = {
  /** 该 pane 的稳定身份(分屏树 / 左栏 / transport 池前缀)。 */
  paneId: string;
  /** 该 pane 所有 tab 的 session(一个 tab = 一个 session)。 */
  sessions: WorkspaceSession[];
  /** 当前可见 tab 的 id(=== 某 session.id)。 */
  activeTabId: string;
  /** 按 tabId 取该 tab 专属 transport(池化,tab 生命周期内稳定)。 */
  getTransport: (tabId: string) => TerminalTransport;
  /** 该 pane 是否为焦点 pane(焦点 pane 的活动 tab xterm 抢键盘焦点)。 */
  focused?: boolean;
  onFocusPane?: (paneId: string) => void;
  /** 在当前 pane 上分屏(新建一个 pane)。 */
  onSplitPane?: (paneId: string, kind: ShellKind) => void;
  /** 关闭当前 pane(关掉其所有 tab)。 */
  onClosePane?: (paneId: string) => void;
  /** 在当前 pane 新建一个 tab(指定 shell 类型)。 */
  onAddTab?: (paneId: string, kind: ShellKind) => void;
  /** 关闭当前 pane 的某个 tab(关到最后一个 = 关 pane,由上层处理)。 */
  onCloseTab?: (paneId: string, tabId: string) => void;
  /** 切换当前 pane 的活动 tab。 */
  onSetActiveTab?: (paneId: string, tabId: string) => void;
  /** 上报 pane 实际尺寸(供分屏方向自适应:宽≥高→左右,否则→上下)。 */
  onMeasurePane?: (paneId: string, size: { width: number; height: number }) => void;
  className?: string;
};

/** 单个 tab 的常驻 xterm 资源(terminal + fitAddon + 所属 DOM 容器)。切 tab 不销毁,只切显隐。 */
type TabTerminal = {
  terminal: Terminal;
  fitAddon: FitAddon;
  /** xterm.open 的目标 div;切 tab 时通过 CSS display 切显隐。 */
  element: HTMLDivElement;
  /** ResizeObserver 监听该 tab 容器尺寸变化 → fit + resize。 */
  observer: ResizeObserver;
  /** onOutput 订阅取消函数。 */
  unsubscribe: () => void;
  /** onData(xterm 键盘输入)订阅取消。 */
  disposeOnData: { dispose: () => void };
};

export function TerminalPane({
  paneId,
  sessions,
  activeTabId,
  getTransport,
  focused,
  onFocusPane,
  onSplitPane,
  onClosePane,
  onAddTab,
  onCloseTab,
  onSetActiveTab,
  onMeasurePane,
  className,
}: TerminalPaneProps) {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);
  /** tab id → 常驻 xterm 资源。tab 首次可见时懒创建,切走不销毁。 */
  const terminalsRef = useRef<Map<string, TabTerminal>>(new Map());
  /** tab id → 该 tab 的 DOM 容器 ref(由渲染层挂载,创建 xterm 时用)。 */
  const tabContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  /** 当前展开的新建菜单:`"tab"`(+) / `"split"`(▥) / null(关)。两菜单互斥,
   *  open/close 由 Radix Popover 管理(点外/Esc 内置),无需手写点外关闭 effect。 */
  const [menuMode, setMenuMode] = useState<"tab" | "split" | null>(null);

  // onMeasurePane 是父组件每次渲染新建的内联函数,若进 effect 依赖会致 xterm 重建。
  // 用 ref 持有最新引用,effect 依赖里去掉它。
  const onMeasurePaneRef = useRef(onMeasurePane);
  onMeasurePaneRef.current = onMeasurePane;
  // getTransport 同理:父闭包每次渲染新建,进依赖会重建。用 ref。
  const getTransportRef = useRef(getTransport);
  getTransportRef.current = getTransport;

  const terminalTheme = useMemo(
    () => ({
      background: "#070a12",
      foreground: "#cbd5e1",
      cursor: "#22d3ee",
      selectionBackground: "#1e293b",
      black: "#0f172a",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#f59e0b",
      blue: "#3b82f6",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#e2e8f0",
      brightBlack: "#475569",
      brightRed: "#f87171",
      brightGreen: "#4ade80",
      brightYellow: "#fbbf24",
      brightBlue: "#60a5fa",
      brightMagenta: "#c084fc",
      brightCyan: "#67e8f9",
      brightWhite: "#ffffff",
    }),
    [],
  );

  // session 字典:tab id → session。渲染 tab 容器 + 创建 xterm 时用。
  const sessionById = useMemo(() => {
    const map = new Map<string, WorkspaceSession>();
    for (const s of sessions) map.set(s.id, s);
    return map;
  }, [sessions]);

  /** 为某 tab 懒创建常驻 xterm(若尚未创建)。首次可见时调用。 */
  const ensureTerminal = (tabId: string) => {
    if (terminalsRef.current.has(tabId)) return;
    const session = sessionById.get(tabId);
    const container = tabContainerRefs.current.get(tabId);
    if (!session || !container) return;

    const terminal = new Terminal({
      // convertEol=false:TUI 应用(yazi/lazygit/fresh)用 \r + 光标移动 + 清行序列重绘,
      // convertEol=true 会把 \n 错误转成 \r\n 致光标定位错乱、某些行重绘丢失(文件列表局部不刷新)。
      // PTY 模式下 PowerShell 等程序本就发 \r\n,关掉对裸 shell 无影响。
      convertEol: false,
      cursorBlink: true,
      fontFamily: "CaskaydiaCoveNF, Cascadia Code, Cascadia Mono, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      theme: terminalTheme,
      allowProposedApi: false,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    const transport = getTransportRef.current(tabId);
    const unsubscribe = transport.onOutput(tabId, (chunk) => terminal.write(chunk));
    const disposeOnData = terminal.onData((data) => {
      void transport.write(tabId, data);
    });

    const observer = new ResizeObserver(() => {
      // 隐藏 tab 的容器尺寸为 0,fit 会算错;仅在 tab 可见时 fit + resize。
      if (container.offsetParent === null) return;
      try {
        fitAddon.fit();
      } catch {
        /* fit 在尺寸为 0 时可能抛,忽略 */
      }
      void transport.resize(tabId, terminal.cols, terminal.rows);
      // 上报 pane 整体尺寸(分屏方向自适应)。各 tab 共用同一 pane 尺寸,任一可见 tab 上报即可。
      const el = paneRef.current;
      const measure = onMeasurePaneRef.current;
      if (el && measure) {
        const r = el.getBoundingClientRect();
        measure(paneId, { width: r.width, height: r.height });
      }
    });
    observer.observe(container);

    terminalsRef.current.set(tabId, {
      terminal,
      fitAddon,
      element: container,
      observer,
      unsubscribe,
      disposeOnData,
    });

    // 启动后端会话(先 listen 后 spawn 由 transport 内部保证)。
    void transport.start(tabId, {
      size: { cols: terminal.cols, rows: terminal.rows },
      cwd: session.cwd,
      shellKind: session.kind,
    });
  };

  /** 销毁某 tab 的 xterm 资源(关 tab / 关 pane 时调用)。 */
  const disposeTerminal = (tabId: string) => {
    const t = terminalsRef.current.get(tabId);
    if (!t) return;
    t.unsubscribe();
    t.disposeOnData.dispose();
    t.observer.disconnect();
    t.terminal.dispose();
    terminalsRef.current.delete(tabId);
  };

  // tab 集合变化:为新增 tab 创建容器(xterm 懒建),销毁已移除 tab 的 xterm。
  // 用 effect 同步 terminalsRef 与当前 sessions,避免 tab 关闭后残留实例。
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id));
    // 销毁已不存在的 tab xterm(被关的 tab)。
    for (const tabId of Array.from(terminalsRef.current.keys())) {
      if (!currentIds.has(tabId)) disposeTerminal(tabId);
    }
    // 当前活动 tab 若尚未建 xterm,建之(非活动 tab 待切到时再建)。
    if (activeTabId && currentIds.has(activeTabId)) {
      ensureTerminal(activeTabId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, activeTabId, terminalTheme]);

  // 切活动 tab:显隐切换 + 切到的 tab 懒建 + rAF 后 fit/resize(隐藏期间尺寸可能变过)。
  useEffect(() => {
    if (!activeTabId) return;
    ensureTerminal(activeTabId);
    const t = terminalsRef.current.get(activeTabId);
    if (!t) return;
    // 切到的 tab fit 一次(用当前可见容器尺寸)+ 通知后端 resize。
    const raf = requestAnimationFrame(() => {
      const container = tabContainerRefs.current.get(activeTabId);
      if (!container || container.offsetParent === null) return;
      try {
        t.fitAddon.fit();
      } catch {
        /* ignore */
      }
      const transport = getTransportRef.current(activeTabId);
      void transport.resize(activeTabId, t.terminal.cols, t.terminal.rows);
      // 聚焦:切到 tab 时把焦点交给它的 xterm。
      t.terminal.focus();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // pane 获得焦点(非切 tab 触发):把键盘焦点交给活动 tab 的 xterm。
  // 点 pane body / 左栏图标 → onFocusPane → 父设 focused → 此处抢焦点。
  // rAF:等 React 提交 DOM 重排(多列场景点击会重排列)再 focus,避免重排中途被打断。
  useEffect(() => {
    if (!focused) return;
    const t = terminalsRef.current.get(activeTabId);
    if (!t) return;
    const raf = requestAnimationFrame(() => t.terminal.focus());
    return () => cancelAnimationFrame(raf);
  }, [focused, activeTabId]);

  // 组件卸载:销毁所有 tab 的 xterm(transport 由 AppShell 在关 pane/项目时统一 stop,
  // 这里只清前端 xterm 实例,避免泄漏)。
  useEffect(() => {
    return () => {
      for (const tabId of Array.from(terminalsRef.current.keys())) {
        disposeTerminal(tabId);
      }
      terminalsRef.current.clear();
    };
  }, []);

  // 新建/分屏菜单的 open/close 由 Radix Popover 管理(点外、Esc 内置),无需手写 effect。

  const activeSession = sessionById.get(activeTabId);

  return (
    <article
      ref={paneRef}
      className={`terminal-pane grid min-h-0 min-w-0 grid-rows-[28px_1fr] overflow-hidden rounded-none bg-[#0b1020] ${className ?? ""}`}
      onMouseDown={() => onFocusPane?.(paneId)}
    >
      <header className={`flex min-w-0 items-center justify-between gap-2 px-2 text-xs transition-colors ${focused ? "bg-[rgba(34,211,238,0.16)]" : "bg-[rgba(148,163,184,0.055)]"}`}>
        {/* tab 条:每个 tab 一个 chip,点击切换,× 关闭。窄宽度时 chip 可收缩(标题截断),
            tab 过多仍可横向滚但不显示滚动条(避免占位撑乱 header)。 */}
        {/* tab 条:Radix Tabs 受控(value=activeTabId)。TabsTrigger 内置 onMouseDown→onValueChange,
            替代手写 chip onMouseDown 切 tab。TabsList/TabsTrigger 均 asChild,chip 自定义样式全保留。
            × 关闭按钮的 onMouseDown stopPropagation 阻止冒泡到 TabsTrigger(防点 × 误切 tab)。 */}
        <Tabs value={activeTabId} onValueChange={(id) => onSetActiveTab?.(paneId, id)}>
        <TabsList className="flex min-w-0 items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {sessions.map((s) => {
            const meta = SHELL_KIND_META[s.kind] ?? SHELL_KIND_META.shell;
            const isActive = s.id === activeTabId;
            return (
              <Tooltip>
              <TooltipTrigger asChild>
              <TabsTrigger asChild value={s.id}>
              <div
                key={s.id}
                className={`group/tab flex min-w-0 shrink cursor-pointer items-center gap-1 border-b-2 px-2 py-[3px] transition-colors ${
                  isActive
                    ? "border-[#22d3ee] text-[#e2e8f0]"
                    : "border-transparent text-[#64748b] hover:text-[#cbd5e1]"
                }`}
              >
                <span
                  className="mx-icon-tile grid h-3.5 w-3.5 place-items-center text-[9px] font-bold"
                  style={{ background: meta.accent, color: "#0b1020" }}
                >
                  {meta.glyph}
                </span>
                <span className="truncate text-[11px] font-[600]">{t(s.name)}</span>
                {sessions.length > 1 && onCloseTab && (
                  <Tooltip>
                  <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-3.5 w-3.5 text-[10px] text-[#64748b] opacity-0 transition-opacity hover:text-[#fca5a5] group-hover/tab:opacity-100 hover:bg-transparent"
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
        <div className="flex shrink-0 items-center gap-1 text-[#94a3b8]">
          {onAddTab && (
            <Popover open={menuMode === "tab"} onOpenChange={(o) => setMenuMode(o ? "tab" : null)}>
              <Tooltip>
              <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-[14px] text-[#94a3b8] hover:bg-[rgba(148,163,184,0.14)] hover:text-[#cbd5e1]"
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
            <Popover open={menuMode === "split"} onOpenChange={(o) => setMenuMode(o ? "split" : null)}>
              <Tooltip>
              <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-[#94a3b8] hover:bg-[rgba(148,163,184,0.14)] hover:text-[#cbd5e1]"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  ▥
                </Button>
              </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("shell.pane.split")}</TooltipContent>
              </Tooltip>
              {menuMode === "split" && (
                <ShellMenu
                  onSelect={(kind) => {
                    setMenuMode(null);
                    onSplitPane(paneId, kind);
                  }}
                />
              )}
            </Popover>
          )}
          {onClosePane && (
            <Tooltip>
            <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-[13px] text-[#94a3b8] hover:bg-[rgba(239,68,68,0.14)] hover:text-[#fca5a5]"
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
      {/* 终端区:每个 tab 一个绝对定位容器,active 显隐。xterm 懒建并常驻。 */}
      <div ref={surfaceRef} className="relative min-h-0 min-w-0 px-2 pt-1.5 mb-1.5">
        {sessions.map((s) => {
          const isActive = s.id === activeTabId;
          return (
            <div
              key={s.id}
              ref={(el) => {
                if (el) tabContainerRefs.current.set(s.id, el);
                else tabContainerRefs.current.delete(s.id);
              }}
              className="absolute inset-0 overflow-hidden"
              style={{ display: isActive ? "block" : "none" }}
            />
          );
        })}
        {/* 活动 tab 缺失 session 兜底(理论上 activeTabId 必在 sessions 中)。 */}
        {!activeSession && (
          <div className="grid h-full place-items-center text-xs text-[#475569]">
            {t("shell.pane.noActiveTab")}
          </div>
        )}
      </div>
    </article>
  );
}

