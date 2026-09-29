/**
 * 全局设置 Provider —— 包裹应用,提供终端 + Monaco 编辑器的全局字体大小、背景图设置。
 *
 * 与 [[I18nProvider]] 平行:独立 Context,不耦合语言设置(locale 链路已稳定,不动)。
 * 两者在 App 里并列包裹,组件按需 `useI18n()` / `useSettings()` 各取所需。
 *
 * - `initialFontSize`:App 在 hydrate 后从后端 `snap.terminalFontSize` 传入(权威值)。
 *   undefined 时用 `DEFAULT_FONT_SIZE`(13)。
 * - `changeFontSize(n)`:clamp 到 [MIN, MAX] + round → setState + invoke 后端
 *   `set_terminal_font_size` 落盘 state.json(权威持久化)。失败仅 warn 不回滚(本地已是
 *   用户期望值,下次 hydrate 修正,与 I18nProvider.changeLanguage 同策略)。
 * - Codex sandbox 全局默认档已移除(2026-09-29):每 tab 在 CodexPane 状态栏切换,
 *   新会话初始档 = DEFAULT_CODEX_SANDBOX(workspace-write),不再有全局设置项。
 *
 * 通过 [[useSettings]] 暴露 `{ fontSize, changeFontSize, bgSetting, changeBgSetting }`。
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { clampFontSize, DEFAULT_FONT_SIZE } from "./index";
import { DEFAULT_BG_SETTING, type BgSetting } from "../domain/bg";

/** 背景图设置的 localStorage 键(纯视觉,不走后端 state.json)。 */
const BG_SETTING_KEY = "mx.bgSetting";

/** 从 localStorage 读背景图设置(损坏/缺字段回退默认)。 */
function loadBgSetting(): BgSetting {
  try {
    const raw = localStorage.getItem(BG_SETTING_KEY);
    if (!raw) return DEFAULT_BG_SETTING;
    const parsed = JSON.parse(raw) as Partial<BgSetting>;
    return {
      path: typeof parsed.path === "string" ? parsed.path : "",
      blur: typeof parsed.blur === "number" ? parsed.blur : DEFAULT_BG_SETTING.blur,
      dim: typeof parsed.dim === "number" ? parsed.dim : DEFAULT_BG_SETTING.dim,
    };
  } catch {
    return DEFAULT_BG_SETTING;
  }
}

type SettingsContextValue = {
  /** 当前字体大小(px),已 clamp 到 [MIN, MAX]。 */
  fontSize: number;
  /** 改字体大小:clamp + round + setState + 后端落盘。 */
  changeFontSize: (size: number) => void;
  /** 背景图设置(path 空 = 关)。 */
  bgSetting: BgSetting;
  /** 改背景图设置(局部合并)+ localStorage 持久化。 */
  changeBgSetting: (patch: Partial<BgSetting>) => void;
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
  const [bgSetting, setBgSetting] = useState<BgSetting>(loadBgSetting);

  const changeBgSetting = (patch: Partial<BgSetting>) => {
    setBgSetting((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(BG_SETTING_KEY, JSON.stringify(next));
      } catch {
        /* 写失败(隐私模式)忽略,仅内存生效 */
      }
      return next;
    });
  };

  const changeFontSize = (size: number) => {
    const clamped = clampFontSize(size);
    setFontSize(clamped);
    invoke("set_terminal_font_size", { fontSize: clamped }).catch((e) =>
      console.warn("[settings] set_terminal_font_size backend failed:", e),
    );
  };

  return (
    <SettingsContext.Provider value={{ fontSize, changeFontSize, bgSetting, changeBgSetting }}>
      {children}
    </SettingsContext.Provider>
  );
}

/** 取当前设置(字体大小 + 背景图)。须在 SettingsProvider 内使用。 */
export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
