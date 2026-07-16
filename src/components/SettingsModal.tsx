import { useTranslation } from "react-i18next";
import { SHORTCUT_GROUPS } from "../domain/shortcuts";
import { useI18n } from "../i18n/I18nProvider";
import { SUPPORTED_LOCALES, type Locale } from "../i18n";
import { Button } from "./ui/Button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "./ui/Dialog";
import { ToggleGroup, ToggleGroupItem } from "./ui/ToggleGroup";

type SettingsModalProps = {
  /** 是否显示;false 时不渲染。 */
  open: boolean;
  onClose: () => void;
};

/**
 * 设置面板(模态)。基于 Radix Dialog:Esc / 点遮罩 / 焦点陷阱 / scroll lock 全部内置,
 * 不再手写 createPortal 与 Esc effect。
 *
 * 含「快捷键」分区(数据来自 `domain/shortcuts.ts` 真源),结构预留供后续扩展其他设置项
 * (主题/健康提醒间隔等)。
 */
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { t } = useTranslation();
  const { locale, changeLanguage } = useI18n();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[440px] max-w-[90vw] px-4 py-3">
        {/* Radix 要求 Content 内有 Title(无障碍);视觉标题用原 div,Title 走 sr-only 消 warn。 */}
        <DialogTitle className="sr-only">{t("settings.title")}</DialogTitle>

        {/* 标题 */}
        <div className="mb-2.5 flex items-center justify-between">
          <div className="text-[13px] font-semibold text-[var(--mx-text)]">{t("settings.title")}</div>
          <Button
            variant="ghost"
            size="sm"
            className="text-[12px] leading-none"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            ✕
          </Button>
        </div>

        {/* 语言分区:单选分段控件(ToggleGroup)。数据驱动 SUPPORTED_LOCALES,
            加语言只需往 i18n/index.ts 的数组加一项 + 补对应字典条目,UI 自动渲染。
            react-i18next 响应 changeLanguage 自动重渲染全树。 */}
        <section className="mb-3">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[#475569]">{t("settings.language.title")}</div>
          <ToggleGroup
            type="single"
            value={locale}
            onValueChange={(v) => {
              // type="single" 点中已选中项会回传 ""(取消选中);语言必有选中项,空串忽略。
              if (v) changeLanguage(v as Locale);
            }}
          >
            {SUPPORTED_LOCALES.map((lng) => (
              <ToggleGroupItem key={lng} value={lng}>
                {t(`settings.language.${lng}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </section>

        {/* 快捷键分区 */}
        <section>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[#475569]">{t("settings.shortcut.title")}</div>
          <div className="space-y-2">
            {SHORTCUT_GROUPS.map((group) => (
              <div key={group.title}>
                <div className="mb-0.5 text-[11px] text-[var(--mx-muted)]">{t(group.title)}</div>
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <div
                      key={item.keys}
                      className="flex items-center justify-between gap-3 text-[12px]"
                    >
                      <span className="text-[var(--mx-text)]">{t(item.desc)}</span>
                      <kbd className="mx-icon-tile shrink-0 border border-[rgba(148,163,184,0.28)] bg-[rgba(2,6,23,0.5)] px-1.5 py-[1px] font-mono text-[11px] text-[var(--mx-text)]">
                        {item.keys}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 底部:关闭按钮(顶部已有 ✕,此为兜底;收小避免喧宾夺主)。 */}
        <div className="mt-2.5 flex justify-end">
          <Button size="sm" variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
