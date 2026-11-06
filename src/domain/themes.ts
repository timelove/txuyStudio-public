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

export type ThemeId = "midnight" | "one-dark" | "intellij-light" | "intellij-dark" | "cream-gold" | "indigo-night";

export const DEFAULT_THEME_ID: ThemeId = "midnight";

/** 主题白名单(用于校验 hydrate 回传/未知值回退默认)。 */
export const KNOWN_THEME_IDS: readonly ThemeId[] = [
  "midnight",
  "one-dark",
  "intellij-light",
  "intellij-dark",
  "cream-gold",
  "indigo-night",
];

/** UI 列表(数据驱动 SettingsModal 的主题 ToggleGroup)。labelKey 走 i18n。 */
export const THEMES: { id: ThemeId; labelKey: string }[] = [
  { id: "midnight", labelKey: "theme.midnight" },
  { id: "one-dark", labelKey: "theme.one-dark" },
  { id: "intellij-light", labelKey: "theme.intellijLight" },
  { id: "intellij-dark", labelKey: "theme.intellijDark" },
  { id: "cream-gold", labelKey: "theme.creamGold" },
  { id: "indigo-night", labelKey: "theme.indigoNight" },
];

/** 把任意字符串归一为合法 ThemeId(未知/空 -> 默认)。 */
export function normalizeThemeId(raw: string | null | undefined): ThemeId {
  return (KNOWN_THEME_IDS as readonly string[]).includes(raw ?? "")
    ? (raw as ThemeId)
    : DEFAULT_THEME_ID;
}

/** 浅色主题集合。背景图遮罩/玻璃化等「按明暗分叉」的视觉效果以此判定(见 AppShell 背景层)。 */
const LIGHT_THEME_IDS: readonly ThemeId[] = ["intellij-light", "cream-gold"];

/** 是否浅色主题。深色主题的背景图用黑罩压暗保白字可读;浅色主题文字是深色,须反转为白纱提亮。 */
export function isLightTheme(id: ThemeId): boolean {
  return LIGHT_THEME_IDS.includes(id);
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
  /** IntelliJ Light(JetBrains IDEA Light 新 UI:白底终端 + 高饱和深档 ANSI,白底可读;
   *  bg 对齐 --mx-editor-bg #FFFFFF,与 ClaudePane 输入流统一)。white 给中灰、brightWhite
   *  反转近黑(浅底惯例,亮白在白底不可见)。 */
  "intellij-light": {
    background: "#ffffff",
    foreground: "#1f1f1f",
    cursor: "#1f1f1f",
    selectionBackground: "#c9dbf9",
    black: "#000000",
    red: "#ff3535",
    green: "#0a8400",
    yellow: "#bf8c00",
    blue: "#3064bf",
    magenta: "#8264f4",
    cyan: "#0e9ba8",
    white: "#8a8a8a",
    brightBlack: "#767676",
    brightRed: "#ff6d68",
    brightGreen: "#3fa22c",
    brightYellow: "#d9a400",
    brightBlue: "#4c82f0",
    brightMagenta: "#9a7bf7",
    brightCyan: "#3bb8c4",
    brightWhite: "#1f1f1f",
  },
  /** IntelliJ Dark(JetBrains IDEA Dark 新 UI:深灰底终端 + Darcula console ANSI;
   *  bg 对齐 --mx-editor-bg #1E1F22,与 ClaudePane 输入流统一)。ANSI 取 JetBrains
   *  Darcula console 官方 16 色(部分 bright 与 normal 同值,官方口径如此)。 */
  "intellij-dark": {
    background: "#1e1f22",
    foreground: "#a9b7c6",
    cursor: "#dfe1e5",
    selectionBackground: "#2e4a7a",
    black: "#000000",
    red: "#ff6b68",
    green: "#a8c023",
    yellow: "#d6bf55",
    blue: "#5394ec",
    magenta: "#ae8abe",
    cyan: "#299999",
    white: "#a9b7c6",
    brightBlack: "#555555",
    brightRed: "#ff8785",
    brightGreen: "#a8c023",
    brightYellow: "#d6bf55",
    brightBlue: "#7eaef1",
    brightMagenta: "#ae8abe",
    brightCyan: "#6cdada",
    brightWhite: "#ffffff",
  },
  /** 奶油金(暖纸浅色主题:米白/暖纸底 + 白卡 + 金色强调,取自用户提供的 Dark Mode Toggle
   *  参考图浅侧;官方口径 bg #ffffff / text #333333,金色按钮 ≈ #d4a843)。终端用暖纸底
   *  (bg 对齐 --mx-editor-bg #FAF6EC),前景深棕,ANSI 走白底可读深档 + 暖调。brightWhite
   *  反转近黑而非近白(浅底惯例,同 intellij-light):PowerShell prompt/输入等常用
   *  brightWhite,近白 #fffdf7 在米白底上不可见(2026-10-21 用户实测报障)。 */
  "cream-gold": {
    background: "#faf6ec",
    foreground: "#3d3a33",
    cursor: "#b8860b",
    selectionBackground: "#ecdcb8",
    black: "#3d3a33",
    red: "#c25656",
    green: "#4f7d3a",
    yellow: "#b3851a",
    blue: "#3056c8",
    magenta: "#8a5cf6",
    cyan: "#0e7490",
    white: "#8a8378",
    brightBlack: "#6b6558",
    brightRed: "#d96c6c",
    brightGreen: "#6a9a50",
    brightYellow: "#d1a02e",
    brightBlue: "#4f74e0",
    brightMagenta: "#a67cf8",
    brightCyan: "#2e9ab0",
    brightWhite: "#3d3a33",
  },
  /** 午夜靛蓝(深色主题:官方口径 bg #1a1a2e / text #eaeaea,靛蓝强调 ≈ #7c83f0,取自
   *  同一参考图深侧)。bg 对齐 --mx-editor-bg #1A1A2E,ANSI 靛蓝系和谐色。 */
  "indigo-night": {
    background: "#1a1a2e",
    foreground: "#eaeaea",
    cursor: "#7c83f0",
    selectionBackground: "#2e2e52",
    black: "#12122a",
    red: "#f07178",
    green: "#6fd08c",
    yellow: "#f5a623",
    blue: "#7c83f0",
    magenta: "#a78bfa",
    cyan: "#4cc9e0",
    white: "#c9c9e8",
    brightBlack: "#67678a",
    brightRed: "#f8a0a6",
    brightGreen: "#96e2ab",
    brightYellow: "#ffc53d",
    brightBlue: "#a3a8fa",
    brightMagenta: "#c4b2fd",
    brightCyan: "#7fdcee",
    brightWhite: "#ffffff",
  },
};
