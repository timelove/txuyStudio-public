import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";

/**
 * 自绘窗口控制按钮(Windows 11 原生标题栏样式仿真):最小化 / 最大化·还原 / 关闭。
 *
 * 配合 `decorations: false`,整条标题栏由前端绘制,本组件放标题栏右端。
 * 仿真 Win11 标题栏按钮特征:
 * - **等宽 46px、直角无圆角**(悬停背景铺满到按钮边缘,非通用按钮的圆角);
 * - 深色主题下图标偏白(`#cbd5e1`),悬停变纯白;
 * - 最小化/最大化悬停浅白底 `rgba(255,255,255,0.08)`,关闭键悬停 `#e81123` 红(系统关闭色);
 * - 图标用 Segoe Fluent 风格几何 SVG(横线/方框/叠加方框/X)。
 *
 * 三键交互走 Tauri window API;最大化态用 `onResized` 事件同步,避免双击标题栏拖拽区
 * 最大化/还原后按钮图标不同步。非 Tauri 环境(`bun run dev`,getCurrentWindow 不可用)按钮静默禁用。
 *
 * **不复用 ui/Button**:标题栏按钮是直角铺满 + 专属悬停色的特殊样式,与通用按钮
 * (圆角 + `--mx-*` token hover)语义不同,直接原生 button 表达更清晰。
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

  // Win11 标题栏按钮共用样式:等宽 46px、直角、深色主题浅图标 + 各自悬停色。
  // border-0/bg-transparent/p-0:覆盖原生 button 默认边框/背景/内边距(Tailwind preflight 已重置大部分,显式声明保险)。
  const base = "grid h-full w-[46px] place-items-center border-0 bg-transparent p-0 text-[#cbd5e1] transition-colors";
  const hoverNormal = "hover:bg-[rgba(255,255,255,0.08)] hover:text-white";
  const hoverClose = "hover:bg-[#e81123] hover:text-white";

  return (
    <div className="flex h-full items-stretch">
      <Tooltip>
      <TooltipTrigger asChild>
      <button
        type="button"
        aria-label={t("window.minimize")}
        className={`${base} ${hoverNormal}`}
        onClick={() => void getCurrentWindow().minimize().catch(() => {})}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>
      </TooltipTrigger>
      <TooltipContent>{t("window.minimize")}</TooltipContent>
      </Tooltip>
      <Tooltip>
      <TooltipTrigger asChild>
      <button
        type="button"
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
        className={`${base} ${hoverNormal}`}
        onClick={() => void getCurrentWindow().toggleMaximize().catch(() => {})}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x="2.5" y="0.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1" fill="none" />
            <path d="M0.5 2.5h7v7" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" fill="none" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        )}
      </button>
      </TooltipTrigger>
      <TooltipContent>{maximized ? t("window.restore") : t("window.maximize")}</TooltipContent>
      </Tooltip>
      <Tooltip>
      <TooltipTrigger asChild>
      <button
        type="button"
        aria-label={t("window.close")}
        className={`${base} ${hoverClose}`}
        onClick={() => void getCurrentWindow().close().catch(() => {})}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>
      </TooltipTrigger>
      <TooltipContent>{t("window.close")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
