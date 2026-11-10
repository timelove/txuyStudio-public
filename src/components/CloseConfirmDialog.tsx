import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "./ui/Button";
import { Dialog, DialogContent } from "./ui/Dialog";
import { useSettings } from "../settings/SettingsProvider";

/**
 * 全局关闭确认弹窗(手抖保护)。
 *
 * 后端 `CloseRequested` 判定需确认时 `prevent_close` 并 emit `close-confirm-requested`
 * (payload = 窗口 label)。本组件全局挂载监听,**仅目标窗口弹**(比对当前 WebView 的
 * label;emit 是全窗口广播,非目标窗口忽略)。
 *
 * 确认流程:可选勾选「不再提示」(invoke set_skip_close_confirm,持久偏好,之后所有
 * 窗口直接放行)→ invoke confirm_close_window(后端登记一次性票据再 close,归档/子进程
 * 回收照常走 CloseRequested 原路径)。取消 = 什么都不做,窗口保持打开。
 *
 * 非 Tauri 环境(纯浏览器兜底)listen 不生效,组件静默无行为。
 */
export function CloseConfirmDialog() {
  const { t } = useTranslation();
  const { changeSkipCloseConfirm } = useSettings();
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [neverAsk, setNeverAsk] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const un = listen<string>("close-confirm-requested", (event) => {
      // 全窗口广播:只响应当前 WebView 自己的关闭请求。
      const myLabel = getCurrentWebviewWindow().label;
      if (event.payload === myLabel) {
        setNeverAsk(false); // 每次弹窗重置勾选,防上次状态串场
        setPendingLabel(event.payload);
      }
    });
    return () => {
      void un.then((dispose) => dispose());
    };
  }, []);

  const confirmClose = async () => {
    const label = pendingLabel;
    if (!label || closing) return;
    setClosing(true);
    try {
      if (neverAsk) changeSkipCloseConfirm(true); // 后端落盘先于 close,二次 CloseRequested 即凭偏好放行
      await invoke("confirm_close_window", { windowLabel: label });
      // 窗口即将销毁,下面的状态复位通常不会执行;失败(窗口已不在)也静默收尾。
    } catch (e) {
      console.warn("[CloseConfirmDialog] confirm_close_window failed:", e);
    } finally {
      setClosing(false);
      setPendingLabel(null);
    }
  };

  return (
    <Dialog open={pendingLabel !== null} onOpenChange={(open) => !open && setPendingLabel(null)}>
      <DialogContent className="w-[360px] gap-0 p-4">
        <div className="text-[13px] font-medium text-(color:--mx-text)">
          {t("closeConfirm.title")}
        </div>
        <div className="mt-1.5 text-[12px] leading-relaxed text-(color:--mx-muted)">
          {t("closeConfirm.body")}
        </div>
        {/* 不再提示:勾选后本次与今后所有窗口关闭直接放行(设置-通用可重新打开) */}
        <label className="mt-3 flex cursor-pointer select-none items-center gap-2 text-[12px] text-(color:--mx-muted)">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-(color:--mx-accent)"
            checked={neverAsk}
            onChange={(e) => setNeverAsk(e.target.checked)}
          />
          {t("closeConfirm.neverAsk")}
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPendingLabel(null)}>
            {t("closeConfirm.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            className="bg-(color:--mx-danger) text-white hover:bg-(color:--mx-danger-bright)"
            disabled={closing}
            onClick={() => void confirmClose()}
          >
            {t("closeConfirm.confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
