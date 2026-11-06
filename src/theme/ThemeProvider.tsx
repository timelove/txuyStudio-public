/**
 * 主题 Provider -- 包裹应用,提供当前主题 id + 切换。
 *
 * 与 [[SettingsProvider]] / [[I18nProvider]] 平行:独立 Context。
 * - `initialThemeId`:App 在 hydrate 后从后端 `snap.themeId` 传入(权威值)。
 *   undefined/null -> `DEFAULT_THEME_ID`(midnight)。
 * - `changeTheme(id)`:setState + 设 `html[data-theme]`(CSS `[data-theme]` 选择器
 *   生效,chrome 界面色立即变)+ invoke 后端 `set_theme` 落盘 state.json。
 *   失败仅 warn 不回滚(本地已是用户期望值,下次 hydrate 修正,与字体/语言同策略)。
 *
 * 通过 [[useTheme]] 暴露 `{ themeId, changeTheme, themes }`。终端 ANSI 热切由
 * TerminalPane 读 themeId 自行处理(此处只管 CSS data-theme + 持久化)。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_THEME_ID,
  normalizeThemeId,
  THEMES,
  type ThemeId,
} from "../domain/themes";

type ThemeContextValue = {
  /** 当前主题 id(已归一为合法值)。 */
  themeId: ThemeId;
  /** 切主题:setState + 设 data-theme + 后端落盘。
   * `origin`:View Transitions 圆形 reveal 的触发点(通常是主题切换控件的中心,
   * 视口坐标);缺省从视口中上荡开。WebView2 支持 startViewTransition,旧环境
   * (纯浏览器/无 API)直接切换,无副作用。 */
  changeTheme: (id: ThemeId, origin?: { x: number; y: number }) => void;
  /** 主题列表(数据驱动 UI)。 */
  themes: typeof THEMES;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  initialThemeId,
  children,
}: {
  initialThemeId?: string | null;
  children: ReactNode;
}) {
  const [themeId, setThemeId] = useState<ThemeId>(
    () => normalizeThemeId(initialThemeId) ?? DEFAULT_THEME_ID,
  );

  // applyTheme:写 html[data-theme],CSS [data-theme] 选择器覆盖 --mx-* 变量。
  useEffect(() => {
    document.documentElement.dataset.theme = themeId;
  }, [themeId]);

  const changeTheme = (id: ThemeId, origin?: { x: number; y: number }) => {
    const root = document.documentElement;
    // reveal 触发点写入 CSS 变量(mx-theme-reveal keyframes 读);无 origin 时清除,
    // 回退到视口中上(50% 38%)。
    if (origin) {
      root.style.setProperty("--mx-vt-x", `${origin.x}px`);
      root.style.setProperty("--mx-vt-y", `${origin.y}px`);
    } else {
      root.style.removeProperty("--mx-vt-x");
      root.style.removeProperty("--mx-vt-y");
    }
    // flushSync:同步完成 render + effect(data-theme 写入 + AppShell 背景图玻璃 token
    // 重建),让 startViewTransition 的新帧截图拿到完整新主题——否则 AppShell 的 effect
    // 会在 Provider effect 之前抢先手写 data-theme(背景图场景),旧帧已是新色,reveal 失真。
    const apply = () => {
      flushSync(() => setThemeId(id));
    };
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => unknown;
    };
    if (doc.startViewTransition) doc.startViewTransition(apply);
    else apply();
    invoke("set_theme", { themeId: id }).catch((e) =>
      console.warn("[theme] set_theme backend failed:", e),
    );
  };

  return (
    <ThemeContext.Provider value={{ themeId, changeTheme, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
}

/** 取当前主题 + 切换函数 + 列表。须在 ThemeProvider 内使用。 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
