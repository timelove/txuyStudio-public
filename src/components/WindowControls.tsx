import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";

/**
 * 自绘窗口控制按钮(IDEA 新 UI 风格):最小化 / 最大化·还原 / 关闭。
 * 配合 `decorations: false`,整条标题栏由前端绘制,本组件放标题栏右端。
 * 非 Tauri 环境(`bun run dev`,getCurrentWindow 不可用)按钮静默禁用,不报错。
 *
 * 三键交互走 Tauri window API;最大化态用 `onResized` 事件同步,避免
 * 双击标题栏拖拽区最大化/还原后按钮图标不同步。
 */
export function WindowControls() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      const appWindow = getCurrentWindow();
      setAvailable(true);
      void appWindow.isMaximized().then(setMaximized).catch(() => {});
      void appWindow.onResized(() => {
        void appWindow.isMaximized().then(setMaximized).catch(() => {});
      }).then((u) => {
        unlisten = u;
      });
    } catch {
      // 非 Tauri 环境:纯浏览器 dev,无窗口 API,按钮保持禁用。
      setAvailable(false);
    }
    return () => {
      unlisten?.();
    };
  }, []);

  if (!available) return null;

  return (
    <div className="flex h-full items-stretch">
      <Tooltip>
      <TooltipTrigger asChild>
      <Button
        variant="ghost"
        size="icon-lg"
        className="text-[#94a3b8] hover:bg-[rgba(148,163,184,0.16)] hover:text-[#94a3b8]"
        onClick={() => void getCurrentWindow().minimize().catch(() => {})}
      >
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
          <path d="M1 5.5h9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      </Button>
      </TooltipTrigger>
      <TooltipContent>{t("window.minimize")}</TooltipContent>
      </Tooltip>
      <Tooltip>
      <TooltipTrigger asChild>
      <Button
        variant="ghost"
        size="icon-lg"
        className="text-[#94a3b8] hover:bg-[rgba(148,163,184,0.16)] hover:text-[#94a3b8]"
        onClick={() => void getCurrentWindow().toggleMaximize().catch(() => {})}
      >
        {maximized ? (
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
            <rect x="1.6" y="3" width="6" height="6" rx="0.8" stroke="currentColor" strokeWidth="1.1" />
            <path d="M3.4 3V2h6v6h-1" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
            <rect x="1.6" y="1.6" width="7.8" height="7.8" rx="0.8" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        )}
      </Button>
      </TooltipTrigger>
      <TooltipContent>{maximized ? t("window.restore") : t("window.maximize")}</TooltipContent>
      </Tooltip>
      <Tooltip>
      <TooltipTrigger asChild>
      <Button
        variant="ghost"
        size="icon-lg"
        className="text-[#94a3b8] hover:bg-[#e81123] hover:text-white"
        onClick={() => void getCurrentWindow().close().catch(() => {})}
      >
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
          <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      </Button>
      </TooltipTrigger>
      <TooltipContent>{t("window.close")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
