import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * 底部一次性 toast(ClaudePane/CodexPane 共用):fixed 底部居中,右上角 ✕ 手动关闭;
 * 自动消失由调用方 setTimeout 后置空/置 dismissed(见各 pane 的 effect),这里只管展示与手动关。
 * tone:danger(红,错误)/warning(橙,不支持命令等轻提示)。
 */
export function BottomToast({
  tone = "danger",
  onClose,
  children,
}: {
  tone?: "danger" | "warning";
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className={`fixed bottom-4 left-1/2 z-50 flex max-w-[80vw] -translate-x-1/2 items-start gap-2 rounded-lg border bg-[var(--mx-surface)] px-3 py-1.5 text-[11px] shadow-lg ${
        tone === "danger"
          ? "border-[var(--mx-danger-border)] text-[var(--mx-danger-bright)]"
          : "border-[var(--mx-orange-border)] text-[var(--mx-warning-bright)]"
      }`}
    >
      <span className="min-w-0 break-words leading-relaxed">{children}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
        className="mt-px shrink-0 cursor-pointer text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)]"
      >
        ✕
      </button>
    </div>
  );
}
