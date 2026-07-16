import { useTranslation } from "react-i18next";
import type { PromptSpec } from "../domain/toolInstall";
import { Button } from "./ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/Dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";

type InstallPromptModalProps = {
  /** 提示内容(TUI 工具未安装 / yazi 缺依赖);null 时不显示。 */
  prompt: PromptSpec | null;
  onClose: () => void;
};

/**
 * 安装提示模态(TUI 工具未安装 / yazi 缺依赖)。基于 Radix Dialog:Esc / 点遮罩 /
 * 焦点陷阱 / scroll lock 全部内置,不再手写 createPortal 与 Esc effect。
 *
 * 展示说明 + 各安装方式命令块(遍历 `prompt.installs`,点击全选便于复制),
 * 提醒安装后重新打开窗口。
 */
export function InstallPromptModal({ prompt, onClose }: InstallPromptModalProps) {
  const { t } = useTranslation();

  // 命令块列表(主组与附加组共用):左侧 tag 标签 + 可点击全选复制的 code。
  const renderInstalls = (installs: { tag: string; cmd: string }[]) => (
    <div className="mt-2 space-y-1.5">
      {installs.map(({ tag, cmd }) => (
        <Tooltip key={tag}>
        <TooltipTrigger asChild>
        <button
          type="button"
          className="group flex w-full items-stretch gap-0 border border-[rgba(148,163,184,0.18)] bg-[rgba(2,6,23,0.5)] text-left"
          onClick={(e) => {
            const range = document.createRange();
            range.selectNodeContents(e.currentTarget.querySelector("[data-cmd]") as Node);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }}
        >
          <span className="mx-icon-tile grid w-12 shrink-0 place-items-center bg-[rgba(148,163,184,0.1)] text-[10px] font-semibold uppercase text-[var(--mx-muted)]">
            {tag}
          </span>
          <code
            data-cmd
            className="block flex-1 overflow-x-auto whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px] text-[var(--mx-text)]"
          >
            {cmd}
          </code>
        </button>
        </TooltipTrigger>
        <TooltipContent>{t("install.selectAllCopy")}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );

  return (
    <Dialog open={prompt !== null} onOpenChange={(o) => !o && onClose()}>
      {/* prompt 为 null 时 Dialog open=false,Radix 不挂 Content;故 Content 内可安全用 prompt! */}
      {prompt !== null && (
        <DialogContent className="w-[420px] max-w-[88vw] px-5 py-4">
          {/* Radix 要求 Content 内有 Title/Description(无障碍);视觉标题用原结构,二者走 sr-only 消 warn。 */}
          <DialogTitle className="sr-only">{t(prompt.title)}</DialogTitle>
          <DialogDescription className="sr-only">{t(prompt.note)}</DialogDescription>

          {/* 标题行:图标(prompt.title 首字符)+ 名称 + 一句话说明 */}
          <div className="flex items-center gap-2.5">
            <span
              className="mx-icon-tile grid h-6 w-6 shrink-0 place-items-center text-xs font-bold"
              style={{ background: "var(--mx-accent)", color: "#0b1020" }}
            >
              {prompt.title.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--mx-text)]">{t(prompt.title)}</div>
              <div className="truncate text-[11px] text-[var(--mx-muted)]">{t(prompt.note)}</div>
            </div>
          </div>

          <div className="mt-3 text-xs text-[var(--mx-muted)]">
            {t("install.notDetected", { name: t(prompt.title) })}
          </div>

          {/* 安装命令块:遍历 prompt.installs(各工具支持的安装方式不同,如 winget/scoop/npm),点击全选便于复制 */}
          {renderInstalls(prompt.installs)}

          {/* 附加命令组(如 yazi 缺时连带依赖 file):分隔线下依次渲染,每组自带标题/说明/命令块 */}
          {prompt.extras?.map((group, idx) => (
            <div key={idx} className="mt-4 border-t border-[rgba(148,163,184,0.18)] pt-3">
              <div className="flex items-center gap-2.5">
                <span
                  className="mx-icon-tile grid h-6 w-6 shrink-0 place-items-center text-xs font-bold"
                  style={{ background: "var(--mx-accent)", color: "#0b1020" }}
                >
                  {t(group.title).charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[var(--mx-text)]">{t(group.title)}</div>
                  <div className="truncate text-[11px] text-[var(--mx-muted)]">{t(group.note)}</div>
                </div>
              </div>
              <div className="mt-3 text-xs text-[var(--mx-muted)]">
                {t("install.notDetectedGroup", { name: t(group.title) })}
              </div>
              {renderInstalls(group.installs)}
            </div>
          ))}

          <div className="mt-3 text-[11px] text-[var(--mx-muted)]">
            {t("install.afterInstallHint")}
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--mx-muted)]"
            dangerouslySetInnerHTML={{ __html: t("install.pathHint") }}
          />

          {/* 底部:关闭按钮 */}
          <div className="mt-4 flex justify-end">
            <Button variant="outline" onClick={onClose}>
              {t("common.close")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
