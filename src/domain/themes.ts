import type { ITheme } from "@xterm/xterm";

/**
 * 主题数据模型(chrome 界面色走 CSS 变量 `--mx-*` + `[data-theme]` 选择器,
 * 终端 ANSI 走此处的 xterm `ITheme`)。
 *
 * 新增主题:① 这里加 `ThemeId` + `TERMINAL_THEMES` 条目;② `app.css` 加
 * `[data-theme="<id>"]` 覆盖 `--mx-*` 变量;③ `THEMES` 列表加 UI 项 + i18n label。
 *
 * 默认 `midnight` = 改动前的深蓝/slate 配色(变量值与原硬编码一致,观感零变化)。
 */

export type ThemeId = "midnight" | "one-dark";

export const DEFAULT_THEME_ID: ThemeId = "midnight";

/** 主题白名单(用于校验 hydrate 回传/未知值回退默认)。 */
export const KNOWN_THEME_IDS: readonly ThemeId[] = ["midnight", "one-dark"];

/** UI 列表(数据驱动 SettingsModal 的主题 ToggleGroup)。labelKey 走 i18n。 */
export const THEMES: { id: ThemeId; labelKey: string }[] = [
  { id: "midnight", labelKey: "theme.midnight" },
  { id: "one-dark", labelKey: "theme.one-dark" },
];

/** 把任意字符串归一为合法 ThemeId(未知/空 -> 默认)。 */
export function normalizeThemeId(raw: string | null | undefined): ThemeId {
  return (KNOWN_THEME_IDS as readonly string[]).includes(raw ?? "")
    ? (raw as ThemeId)
    : DEFAULT_THEME_ID;
}

/**
 * 各主题的 xterm ANSI 配色(16 色 + bg/fg/cursor/selection)。终端创建时读,
 * 主题切换时热切 `terminal.options.theme`。
 *
 * **约束**:每主题的 `background` 必须与 app.css 对应 `[data-theme]` 块的 `--mx-editor-bg`
 * 同值 -- TerminalPane 的 article 背景用 `var(--mx-editor-bg)`(与 ClaudePane/CodexPane
 * 输入流背景统一),与 xterm 画布同色,否则 pane 边缘/padding 区会出现色差条。
 */
export const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
  /** 深蓝/slate「终端工作台」(改动前配色;bg 对齐 --mx-editor-bg #0b1020,与 ClaudePane 输入流统一)。 */
  midnight: {
    background: "#0b1020",
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
  },
  /** One Dark(经典编辑器配色:深灰蓝底 + 柔和语法色;bg 对齐 --mx-editor-bg #1e2127,与 ClaudePane 输入流统一)。 */
  "one-dark": {
    background: "#1e2127",
    foreground: "#abb2bf",
    cursor: "#61afef",
    selectionBackground: "#3b4048",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
};
