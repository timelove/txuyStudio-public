/**
 * 字体大小设置 Provider —— 包裹应用,提供终端 + Monaco 编辑器的全局字体大小。
 *
 * 与 [[I18nProvider]] 平行:独立 Context,不耦合语言设置(locale 链路已稳定,不动)。
 * 两者在 App 里并列包裹,组件按需 `useI18n()` / `useSettings()` 各取所需。
 *
 * - `initialFontSize`:App 在 hydrate 后从后端 `snap.terminalFontSize` 传入(权威值)。
 *   undefined 时用 `DEFAULT_FONT_SIZE`(13)。
 * - `changeFontSize(n)`:clamp 到 [MIN, MAX] + round → setState + invoke 后端
 *   `set_terminal_font_size` 落盘 state.json(权威持久化)。失败仅 warn 不回滚(本地已是
 *   用户期望值,下次 hydrate 修正,与 I18nProvider.changeLanguage 同策略)。
 *
 * 通过 [[useSettings]] 暴露 `{ fontSize, changeFontSize }`。
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { clampFontSize, DEFAULT_FONT_SIZE } from "./index";

type SettingsContextValue = {
  /** 当前字体大小(px),已 clamp 到 [MIN, MAX]。 */
  fontSize: number;
  /** 改字体大小:clamp + round + setState + 后端落盘。 */
  changeFontSize: (size: number) => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  initialFontSize,
  children,
}: {
  initialFontSize?: number;
  children: ReactNode;
}) {
  const [fontSize, setFontSize] = useState<number>(
    () => initialFontSize ?? DEFAULT_FONT_SIZE,
  );

  const changeFontSize = (size: number) => {
    const clamped = clampFontSize(size);
    setFontSize(clamped);
    invoke("set_terminal_font_size", { fontSize: clamped }).catch((e) =>
      console.warn("[settings] set_terminal_font_size backend failed:", e),
    );
  };

  return (
    <SettingsContext.Provider value={{ fontSize, changeFontSize }}>
      {children}
    </SettingsContext.Provider>
  );
}

/** 取当前字体大小 + 改变函数。须在 SettingsProvider 内使用。 */
export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
