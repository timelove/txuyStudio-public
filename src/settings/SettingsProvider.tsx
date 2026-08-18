/**
 * 全局设置 Provider —— 包裹应用,提供终端 + Monaco 编辑器的全局字体大小、
 * Codex 会话默认 sandbox 档位。
 *
 * 与 [[I18nProvider]] 平行:独立 Context,不耦合语言设置(locale 链路已稳定,不动)。
 * 两者在 App 里并列包裹,组件按需 `useI18n()` / `useSettings()` 各取所需。
 *
 * - `initialFontSize`:App 在 hydrate 后从后端 `snap.terminalFontSize` 传入(权威值)。
 *   undefined 时用 `DEFAULT_FONT_SIZE`(13)。
 * - `changeFontSize(n)`:clamp 到 [MIN, MAX] + round → setState + invoke 后端
 *   `set_terminal_font_size` 落盘 state.json(权威持久化)。失败仅 warn 不回滚(本地已是
 *   用户期望值,下次 hydrate 修正,与 I18nProvider.changeLanguage 同策略)。
 * - `initialCodexSandbox`:App 在 hydrate 后从后端 `snap.codexSandbox` 传入(权威值),
 *   经 [[normalizeCodexSandbox]] 归一(旧 state.json 缺字段/非法值 → 默认档)。
 * - `changeCodexSandbox(id)`:归一 → setState + invoke 后端 `set_codex_sandbox` 落盘。
 *   仅影响此后新建的 codex 会话初始档,已开会话不跟随(transport 内部档位独立)。
 *
 * 通过 [[useSettings]] 暴露 `{ fontSize, changeFontSize, codexSandbox, changeCodexSandbox }`。
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { clampFontSize, DEFAULT_FONT_SIZE } from "./index";
import { normalizeCodexSandbox, type CodexSandboxId } from "../domain/codexSandbox";

type SettingsContextValue = {
  /** 当前字体大小(px),已 clamp 到 [MIN, MAX]。 */
  fontSize: number;
  /** 改字体大小:clamp + round + setState + 后端落盘。 */
  changeFontSize: (size: number) => void;
  /** Codex 会话默认 sandbox 档位(已归一)。 */
  codexSandbox: CodexSandboxId;
  /** 改 Codex 默认 sandbox 档位:归一 + setState + 后端落盘(仅影响新建会话)。 */
  changeCodexSandbox: (sandbox: string) => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  initialFontSize,
  initialCodexSandbox,
  children,
}: {
  initialFontSize?: number;
  initialCodexSandbox?: string;
  children: ReactNode;
}) {
  const [fontSize, setFontSize] = useState<number>(
    () => initialFontSize ?? DEFAULT_FONT_SIZE,
  );
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxId>(() =>
    normalizeCodexSandbox(initialCodexSandbox),
  );

  const changeFontSize = (size: number) => {
    const clamped = clampFontSize(size);
    setFontSize(clamped);
    invoke("set_terminal_font_size", { fontSize: clamped }).catch((e) =>
      console.warn("[settings] set_terminal_font_size backend failed:", e),
    );
  };

  const changeCodexSandbox = (sandbox: string) => {
    const normalized = normalizeCodexSandbox(sandbox);
    setCodexSandbox(normalized);
    invoke("set_codex_sandbox", { sandbox: normalized }).catch((e) =>
      console.warn("[settings] set_codex_sandbox backend failed:", e),
    );
  };

  return (
    <SettingsContext.Provider value={{ fontSize, changeFontSize, codexSandbox, changeCodexSandbox }}>
      {children}
    </SettingsContext.Provider>
  );
}

/** 取当前设置(字体大小 + Codex 默认 sandbox)。须在 SettingsProvider 内使用。 */
export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
