import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ShellKind, SplitDirection } from "../domain/paneTree";
import type { WorkspaceSession } from "../domain/sessions";
import type { TerminalTransport } from "../domain/terminalTransport";
import { useSettings } from "../settings/SettingsProvider";
import { useTheme } from "../theme/ThemeProvider";
import { TERMINAL_THEMES } from "../domain/themes";
import { colorWithAlpha } from "../domain/bg";
import { ShellMenu } from "./ShellMenu";
import { SplitPaneButtons } from "./SplitPaneButtons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover";
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
  onSplitPane?: (paneId: string, kind: ShellKind, direction: SplitDirection) => void;
  /** 关闭当前 pane(关掉其所有 tab)。 */
  onClosePane?: (paneId: string) => void;
  /** 在当前 pane 新建一个 tab(指定 shell 类型)。 */
  onAddTab?: (paneId: string, kind: ShellKind) => void;
  /** 输入 session id 恢复历史会话(仅 codex pane 启用)。 */
  onResumeSession?: (sessionId: string) => void;
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
  /** onCursorMove 订阅取消(IME textarea 重定位用)。 */
  disposeCursorMove: { dispose: () => void };
  /** onRender 订阅取消(IME textarea 重定位用)。 */
  disposeImeOnRender: { dispose: () => void };
  /** onRender 订阅取消(无 scrollback 时隐藏滚动条,容器 toggle mx-no-scrollback)。 */
  disposeScrollback: { dispose: () => void };
  /** DECSCUSR 拦截器 dispose(锁定光标形状为 bar)。null=注册失败兜底。 */
  disposeCursorLock: { dispose: () => void } | null;
  /** buffer 切换(normal↔alternate)订阅取消:TUI 进出时按 buffer 类型 refit 切换 margin。 */
  disposeBufferChange: { dispose: () => void };
};

/** 底部滚动留白行数:PTY 逻辑屏比视口少这些行,提示符/光标距视口底 N 行(可滚过)。
 *  **当前置 0 = 停用**:真 PowerShell/Windows Terminal 即贴底,无此功能(用户决策 B,
 *  见 PROGRESS 83);要启用改回 3 即可,alternate screen(TUI)豁免逻辑保留不受影响。 */
const SCROLL_MARGIN_ROWS = 0;

/**
 * fit + refresh + resize 三步统一重排,修「resize 后文字/光标错位」。
 *
 * 根因:resize 时 fit() 重算 cols/rows,但 xterm canvas 的字符像素度量(cell 宽高)不会在
 * fit 后立即重算;若直接 transport.resize() 通知后端,后端(claude TUI)按新尺寸重绘、光标
 * 移到新坐标,而前端 canvas 还用旧度量变换坐标 → 文字渲染到光标显示位置的别处。
 *
 * 修法:① 重算 cols/rows → ② refresh(0, rows-1) 强制 xterm 重算渲染度量并整屏重绘,
 * 让 canvas 坐标系与新 cols/rows 对齐 → ③ 再通知后端 resize。
 *
 * 行数不用 fitAddon.fit() 的取满值:proposeDimensions 后 rows 减 SCROLL_MARGIN_ROWS,
 * terminal.resize 到缩水尺寸(viewport 物理高度不变,少掉的行在 buffer 尾部是空行)。
 * PTY(ConPTY)按缩水后的逻辑屏重绘:提示符写在逻辑屏末行 = 距视口底 margin 行;其
 * 重绘/滚动带 DECSTBM region(限逻辑屏范围),底部空行不被卷动,始终留白。TUI 程序
 * (claude code/fresh 等)占满逻辑屏,底 margin 行空,可接受。
 *
 * 注意:IME 候选框跟随光标是另一个问题(xterm TUI 下 _syncTextArea 同步滞后),此处不修,
 * 见 [[ime-diagnostic]] 诊断。
 */
/** fit 的 margin 版:propose 后 rows 扣 SCROLL_MARGIN_ROWS(见 refit 注释);容器过小/未布局
 *  退回 fit 默认行为。创建 xterm 后首 fit 与后续 refit 共用,保证 spawn 尺寸即最终缩水尺寸。
 *  **alternate screen(TUI 全屏程序)豁免**:TUI(claude code/fresh/yazi 等)切进 alternate
 *  buffer 自绘整屏,逻辑屏缩水会让它们错位,故按满行数;裸 shell(normal buffer)才留 margin。
 *  进入/退出 TUI 由 onBufferChange 订阅触发 refit,PTY 尺寸随之切换。 */
function fitWithMargin(terminal: Terminal, fitAddon: FitAddon) {
  try {
    const dims = fitAddon.proposeDimensions();
    if (dims && dims.cols > 0 && dims.rows > SCROLL_MARGIN_ROWS) {
      const alt = terminal.buffer.active.type === "alternate";
      terminal.resize(dims.cols, alt ? dims.rows : dims.rows - SCROLL_MARGIN_ROWS);
    } else {
      fitAddon.fit();
    }
  } catch {
    /* 容器尺寸为 0 时可能抛,忽略 */
  }
}

function refit(
  terminal: Terminal,
  fitAddon: FitAddon,
  resize: (cols: number, rows: number) => void,
) {
  fitWithMargin(terminal, fitAddon);
  terminal.refresh(0, terminal.rows - 1);
  resize(terminal.cols, terminal.rows);
}

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
  onResumeSession,
  onCloseTab,
  onSetActiveTab,
  onMeasurePane,
  className,
}: TerminalPaneProps) {
  const { t } = useTranslation();
  const { fontSize, bgSetting } = useSettings();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);
  /** tab id → 常驻 xterm 资源。tab 首次可见时懒创建,切走不销毁。 */
  const terminalsRef = useRef<Map<string, TabTerminal>>(new Map());
  /** tab id → 该 tab 的 DOM 容器 ref(由渲染层挂载,创建 xterm 时用)。 */
  const tabContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  /** 当前展开的新建菜单:`"tab"`(+) / `"split"`(▥) / null(关)。两菜单互斥,
   *  open/close 由 Radix Popover 管理(点外/Esc 内置),无需手写点外关闭 effect。 */
  const [menuMode, setMenuMode] = useState<"tab" | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeInput, setResumeInput] = useState("");

  // onMeasurePane 是父组件每次渲染新建的内联函数,若进 effect 依赖会致 xterm 重建。
  // 用 ref 持有最新引用,effect 依赖里去掉它。
  const onMeasurePaneRef = useRef(onMeasurePane);
  onMeasurePaneRef.current = onMeasurePane;
  // getTransport 同理:父闭包每次渲染新建,进依赖会重建。用 ref。
  const getTransportRef = useRef(getTransport);
  getTransportRef.current = getTransport;

  const { themeId } = useTheme();
  // 背景图开时 xterm **完全透明**(贴合主题图):theme.background 置 rgba(...,0) + 容器
  // article 也不再垫 editor-bg(见渲染层 inline style),文字直接浮在背景图的暗化层上,
  // 可读性由用户调「暗化」滑杆掌控。**必须开 allowTransparency**——xterm 默认 false 时垫
  // 不透明底,rgba 也不会真正透明。
  const terminalTheme = useMemo(() => {
    const t = TERMINAL_THEMES[themeId];
    if (!bgSetting.path) return t;
    const bg = t.background ? colorWithAlpha(t.background, 0) : null;
    return bg ? { ...t, background: bg } : t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeId, bgSetting.path]);

  // 主题热切:themeId/背景开关变时更新所有已创建 terminal 的配色(xterm 运行时支持
  // options.theme / options.allowTransparency)。
  useEffect(() => {
    terminalsRef.current.forEach((tt) => {
      tt.terminal.options.allowTransparency = !!bgSetting.path;
      tt.terminal.options.theme = terminalTheme;
      // .xterm 的 padding 留白区背景(xterm.css 用 var(--mx-editor-bg)):玻璃化时 canvas
      // 全透明,留白区也要透明才一体(玻璃化下 --mx-editor-bg 被覆写成半透明,会反成实色块)。
      if (tt.terminal.element) tt.terminal.element.style.background = bgSetting.path ? "transparent" : "";
    });
  }, [terminalTheme, bgSetting.path]);

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
      // 细竖线光标(bar):block 默认整格实心块显粗,改 1px 竖线。cursorStyle 仅初始值,
      // 运行时会被 PowerShell/ConPTY 的 DECSCUSR 设回 block,故下方注册拦截器锁定。
      cursorStyle: "bar",
      cursorWidth: 1,
      // 等宽栈与 --mx-mono / FileEditor 保持一致(MesloLGM NF -> CaskaydiaCoveNF -> Cascadia -> Consolas)。
      fontFamily: '"CaskaydiaCoveNF", "MesloLGM NF", "Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize,
      lineHeight: 1.1,
      theme: terminalTheme,
      // 背景图开时允许透明(theme.background 是 rgba);关闭时保持默认 false(有渲染优化差异)。
      allowTransparency: !!bgSetting.path,
      allowProposedApi: false,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    // 玻璃化下新建 terminal 也要透明 padding 区(theme effect 依赖不变不会重跑,此处补一次)。
    if (bgSetting.path && terminal.element) terminal.element.style.background = "transparent";
    // Ctrl+C 智能复制(Windows Terminal 行为):有非空选区时 Ctrl+C = 复制选中文本到剪贴板 +
    // 清选区(吞掉,不作为 \x03 发给 PTY);无选区时放行,Ctrl+C 照常中断。选区是 xterm 层的
    // (非 DOM selection),用 hasSelection() 判断;复制走 navigator.clipboard(与 ClaudePane
    // 等处同模式)。吞掉后返回 false 阻止 xterm 自行处理(不产生 ^C);清选区让第二次 Ctrl+C
    // 可立即中断(复制一次后选区已消失)。
    terminal.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || !ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) return true;
      if (ev.key !== "c") return true;
      if (!terminal.hasSelection()) return true;
      const text = terminal.getSelection();
      if (!text) return true;
      navigator.clipboard?.writeText(text).catch(() => {});
      terminal.clearSelection();
      return false;
    });
    // 锁定光标形状为 bar:拦截 DECSCUSR(CSI Ps q,无中间字节),阻止 PowerShell/ConPTY 或
    // TUI 把光标设回 block。返回 true 吞掉序列,xterm 保持 cursorStyle:'bar'。仅拦形状;
    // 可见性(\e[?25h/l)走另一序列不受影响,TUI 隐藏/显示光标正常。
    let disposeCursorLock: { dispose: () => void } | null = null;
    try {
      disposeCursorLock = terminal.parser.registerCsiHandler({ final: "q" }, () => true);
    } catch {
      /* parser API 兼容兜底 */
    }
    fitWithMargin(terminal, fitAddon);

    // === IME 候选框跟随光标修复(DOM 层硬修) ===
    // 根因(诊断确认):xterm `_syncTextArea` 在 scrollback baseY>0(claude TUI 对话滚动后产生历史行,
    // baseY 被推到非 0)时,把隐藏 textarea 的 top 算成含 scrollback 偏移的越界值(如 cy=43 但
    // xtermTop=846px,超出可视区),微软拼音候选框锚不住光标飘到屏幕左上角。裸 shell(baseY=0)不受影响。
    //
    // 修法:绕过 xterm 内部 _syncTextArea,用公开 API(buffer.cursorX/cursorY)+ DOM 实测 cell 度量
    // 重算 textarea 的 left/top,**只用 cy(可见行坐标),不叠加 baseY 偏移**。光标移动 / PTY 输出 /
    // resize 后均触发,rAF 节流避免高频重绘性能问题。
    //
    // 注意:直接操作 xterm 内部 .xterm-helper-textarea DOM,xterm 升级可能需调整(见 [[ime-domfix]])。
    const syncImeTextarea = () => {
      const ta = terminal.textarea;
      if (!ta) return;
      const buf = terminal.buffer.active;
      const cols = terminal.cols;
      const rows = terminal.rows;
      if (cols <= 0 || rows <= 0) return;
      // cell 像素度量从 DOM 实测(container 即 xterm.open 的目标,铺满可视区),
      // 避免估错行高(xterm 实际行高含 padding,非简单 fontSize×lineHeight)。
      const cellW = container.clientWidth / cols;
      const cellH = container.clientHeight / rows;
      const cx = Math.min(Math.max(buf.cursorX, 0), cols - 1);
      const cy = Math.min(Math.max(buf.cursorY, 0), rows - 1);
      // [IME 诊断] 对比 claude vs codex:buffer.type(normal/alternate)、cursorY、baseY、viewportY、算出的 top。
      // 目标:确认 claude TUI 偏移根因(cursorY 是否含 baseY?alternate screen 差异?)。
      const bt = (buf as unknown as { type?: string }).type ?? "?";
      const baseY = (buf as unknown as { baseY?: number; baseYTop?: number }).baseY ?? -1;
      const vpY = (buf as unknown as { viewportY?: number; scrollTop?: number }).viewportY ?? -1;
      console.log(`[IME] type=${bt} cursorX=${buf.cursorX} cursorY=${buf.cursorY} cy(clamped)=${cy} baseY=${baseY} viewportY=${vpY} rows=${rows} cellH=${cellH.toFixed(1)} top=${(cy * cellH).toFixed(0)}`);
      ta.style.left = `${cx * cellW}px`;
      ta.style.top = `${cy * cellH}px`;
    };
    // 光标移动 + 数据写入后,rAF 节流重定位(xterm 写入是同步的,但渲染在下一帧,等渲染后定位才准)。
    let imeRaf = 0;
    const scheduleImeSync = () => {
      if (imeRaf) return;
      imeRaf = requestAnimationFrame(() => {
        imeRaf = 0;
        syncImeTextarea();
      });
    };
    const disposeCursorMove = terminal.onCursorMove(scheduleImeSync);
    const disposeImeOnRender = terminal.onRender(scheduleImeSync);
    // === IME 候选框跟随光标修复 结束 ===

    const transport = getTransportRef.current(tabId);
    const unsubscribe = transport.onOutput(tabId, (chunk) => terminal.write(chunk));
    const disposeOnData = terminal.onData((data) => {
      void transport.write(tabId, data);
    });

    const observer = new ResizeObserver(() => {
      // 隐藏 tab 的容器尺寸为 0,fit 会算错;仅在 tab 可见时 fit + resize。
      if (container.offsetParent === null) return;
      refit(terminal, fitAddon, (cols, rows) => void transport.resize(tabId, cols, rows));
      // 上报 pane 整体尺寸(分屏方向自适应)。各 tab 共用同一 pane 尺寸,任一可见 tab 上报即可。
      const el = paneRef.current;
      const measure = onMeasurePaneRef.current;
      if (el && measure) {
        const r = el.getBoundingClientRect();
        measure(paneId, { width: r.width, height: r.height });
      }
    });
    observer.observe(container);

    // 无 scrollback(内容未超出可视区)时给容器加 .mx-no-scrollback,隐藏滚动条(见 xterm.css)。
    // 有 scrollback 才显示常驻滚动条。onRender 渲染后 buffer 已更新,据此 toggle(幂等,高频无害)。
    const disposeScrollback = terminal.onRender(() => {
      container.classList.toggle("mx-no-scrollback", terminal.buffer.active.length <= terminal.rows);
    });

    // TUI 进出(alternate screen 切换)时按 buffer 类型 refit:进 TUI 满行数、退回裸 shell
    // 恢复 margin。resize 通知 PTY,ConPTY 按新逻辑屏重绘(与 WT 中途 resize 同路径)。
    // 该 xterm 版本无 onBufferChange,用 CSI handler 拦 DEC private mode set/reset(?1049/
    // ?1047/?47);返回 false 不吞,xterm 照常切 buffer,handler 里 defer 一拍等它切完再量类型。
    const refitForAltScreen = () => {
      window.setTimeout(() => {
        if (container.offsetParent === null) return;
        refit(terminal, fitAddon, (cols, rows) => void transport.resize(tabId, cols, rows));
      }, 0);
    };
    const isAltMode = (params: (number | number[])[]) =>
      params.some((p) => typeof p === "number" && (p === 47 || p === 1047 || p === 1049));
    const disposeAltSet = terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (isAltMode(params)) refitForAltScreen();
      return false;
    });
    const disposeAltReset = terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (isAltMode(params)) refitForAltScreen();
      return false;
    });
    const disposeBufferChange = {
      dispose: () => {
        disposeAltSet.dispose();
        disposeAltReset.dispose();
      },
    };

    terminalsRef.current.set(tabId, {
      terminal,
      fitAddon,
      element: container,
      observer,
      unsubscribe,
      disposeOnData,
      disposeCursorMove,
      disposeImeOnRender,
      disposeScrollback,
      disposeCursorLock,
      disposeBufferChange,
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
    t.disposeCursorMove.dispose();
    t.disposeImeOnRender.dispose();
    t.disposeScrollback.dispose();
    t.disposeBufferChange.dispose();
    t.disposeCursorLock?.dispose();
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
      const transport = getTransportRef.current(activeTabId);
      refit(t.terminal, t.fitAddon, (cols, rows) => void transport.resize(activeTabId, cols, rows));
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

  // 字体大小变化:对所有已建 xterm 更新 options.fontSize;可见 tab 立即 fit + resize 通知后端,
  // 隐藏 tab 仅改 options(切回时由上方「切活动 tab」effect 重 fit)。xterm 改 fontSize 不自动
  // reflow,必须 fit 重算 cols/rows 并 resize,否则光标定位错乱。
  useEffect(() => {
    for (const [tabId, tt] of terminalsRef.current) {
      tt.terminal.options.fontSize = fontSize;
      const container = tabContainerRefs.current.get(tabId);
      if (!container || container.offsetParent === null) continue; // 隐藏 tab 跳过 fit
      // 改 fontSize 会改 cell 像素度量,与 resize 同病同治:用 refit 统一 fit→refresh→resize,
      // 避免 canvas 度量未刷新致文字/光标/IME 候选框错位(见 refit 注释)。
      const transport = getTransportRef.current(tabId);
      refit(tt.terminal, tt.fitAddon, (cols, rows) => void transport.resize(tabId, cols, rows));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize]);

  // 新建/分屏菜单的 open/close 由 Radix Popover 管理(点外、Esc 内置),无需手写 effect。

  const activeSession = sessionById.get(activeTabId);

  return (
    <article
      ref={paneRef}
      className={`terminal-pane grid h-full min-h-0 min-w-0 grid-rows-[length:var(--mx-paneheader-h)_1fr] overflow-hidden rounded-none bg-[var(--mx-editor-bg)] ${className ?? ""}`}
      // 背景图开时容器完全透明(inline 覆盖 class 的 editor-bg),终端贴合主题图;
      // 文字可读性由背景层的暗化遮罩(设置滑杆)保证。关闭背景图后回落 class 实色。
      style={bgSetting.path ? { background: "transparent" } : undefined}
      onMouseDown={() => onFocusPane?.(paneId)}
    >
      <header className={`flex min-w-0 items-center justify-between gap-2 px-2 text-xs transition-colors ${"bg-[var(--mx-tabbar-bg)]"}`}>
        {/* tab 条:每个 tab 一个 chip,点击切换,× 关闭。窄宽度时 chip 可收缩(标题截断),
            tab 过多仍可横向滚但不显示滚动条(避免占位撑乱 header)。 */}
        {/* tab 条:Radix Tabs 受控(value=activeTabId)。TabsTrigger 内置 onMouseDown→onValueChange,
            替代手写 chip onMouseDown 切 tab。TabsList/TabsTrigger 均 asChild,chip 自定义样式全保留。
            × 关闭按钮的 onMouseDown stopPropagation 阻止冒泡到 TabsTrigger(防点 × 误切 tab)。 */}
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
          {onResumeSession && (
            <Popover open={resumeOpen} onOpenChange={setResumeOpen}>
              <Tooltip>
              <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-[14px] text-[var(--mx-muted)] hover:bg-[var(--mx-border)] hover:text-[var(--mx-text)]"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  ↻
                </Button>
              </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("session.resumeById")}</TooltipContent>
              </Tooltip>
              <PopoverContent className="w-72 p-2" align="end">
                <div className="flex flex-col gap-2">
                  <input
                    autoFocus
                    value={resumeInput}
                    onChange={(e) => setResumeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && resumeInput.trim()) {
                        onResumeSession(resumeInput.trim());
                        setResumeOpen(false);
                        setResumeInput("");
                      }
                    }}
                    placeholder={t("session.resumeSessionIdPlaceholder")}
                    className="rounded border border-[var(--mx-border-strong)] bg-[var(--mx-editor-bg)] px-2 py-1 text-xs text-[var(--mx-text)] outline-none focus:border-[var(--mx-accent)]"
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      if (resumeInput.trim()) {
                        onResumeSession(resumeInput.trim());
                        setResumeOpen(false);
                        setResumeInput("");
                      }
                    }}
                  >
                    {t("session.resumeById")}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
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
      {/* 终端区:每个 tab 一个绝对定位容器,active 显隐。xterm 懒建并常驻。
          容器满铺(inset-0),四周留白由 .xterm 自身 padding 提供(见 xterm.css),
          留白区是终端背景的一部分、一整块颜色,非外部拼色。 */}
      <div ref={surfaceRef} className="relative min-h-0 min-w-0">
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
          <div className="grid h-full place-items-center text-xs text-[var(--mx-faint)]">
            {t("shell.pane.noActiveTab")}
          </div>
        )}
      </div>
    </article>
  );
}

