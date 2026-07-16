import { useTranslation } from "react-i18next";
import { SHORTCUT_GROUPS } from "../domain/shortcuts";
import { useI18n } from "../i18n/I18nProvider";
import { SUPPORTED_LOCALES, type Locale } from "../i18n";
import { useSettings } from "../settings/SettingsProvider";
import { DEFAULT_FONT_SIZE, FONT_SIZE_MAX, FONT_SIZE_MIN } from "../settings";
import { Button } from "./ui/Button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "./ui/Dialog";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "./ui/Slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/Tabs";
import { ToggleGroup, ToggleGroupItem } from "./ui/ToggleGroup";

/** 应用版本(与 package.json / tauri.conf.json 同步,发版时一并改)。 */
const APP_VERSION = "0.1.0";
/** 公开仓库地址(私有 origin 不暴露,此处指向公开 mirror)。 */
const GITHUB_URL = "https://github.com/timelove/txuyStudio-public";

type SettingsModalProps = {
  /** 是否显示;false 时不渲染。 */
  open: boolean;
  onClose: () => void;
};

/**
 * 设置面板(模态)。基于 Radix Dialog:Esc / 点遮罩 / 焦点陷阱 / scroll lock 全部内置。
 *
 * **固定尺寸 + 内部滚动**:DialogContent 固定 `h-[460px]`,中部内容区 `overflow-y-auto`
 * + `.mx-scroll`(隐藏滚动条);标题行 / Tab 条 / 底部按钮固定不滚。
 *
 * 三个 tab(Radix Tabs 受控 defaultValue):
 * - **通用**:语言 + 字体大小。
 * - **快捷键**:快捷键分组列表。
 * - **关于**:产品描述 + GitHub 仓库链接 + 版本/协议/技术栈。
 */
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { t } = useTranslation();
  const { locale, changeLanguage } = useI18n();
  const { fontSize, changeFontSize } = useSettings();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[460px] w-[440px] max-w-[90vw] flex-col overflow-hidden px-0 py-0">
        {/* Radix 要求 Content 内有 Title(无障碍);视觉标题用原 div,Title 走 sr-only 消 warn。 */}
        <DialogTitle className="sr-only">{t("settings.title")}</DialogTitle>

        {/* 标题行(固定) */}
        <div className="flex shrink-0 items-center justify-between px-4 pb-2.5 pt-3">
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

        <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col">
          {/* tab 条(固定):通用 / 快捷键 / 关于。active 走 cyan 下划线(Radix data-state=active)。 */}
          <TabsList className="mx-4 flex shrink-0 gap-4 border-b border-[var(--mx-border)]">
            <TabsTrigger
              value="general"
              className="border-b-2 border-transparent px-1 pb-1.5 text-[12px] text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)] data-[state=active]:border-[var(--mx-accent)] data-[state=active]:text-[var(--mx-text)]"
            >
              {t("settings.tab.general")}
            </TabsTrigger>
            <TabsTrigger
              value="shortcuts"
              className="border-b-2 border-transparent px-1 pb-1.5 text-[12px] text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)] data-[state=active]:border-[var(--mx-accent)] data-[state=active]:text-[var(--mx-text)]"
            >
              {t("settings.tab.shortcuts")}
            </TabsTrigger>
            <TabsTrigger
              value="about"
              className="border-b-2 border-transparent px-1 pb-1.5 text-[12px] text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)] data-[state=active]:border-[var(--mx-accent)] data-[state=active]:text-[var(--mx-text)]"
            >
              {t("settings.tab.about")}
            </TabsTrigger>
          </TabsList>

          {/* 内容区(固定高内滚动,无滚动条 .mx-scroll) */}
          <div className="mx-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {/* 通用 tab:语言 + 字体大小 */}
            <TabsContent value="general" className="focus-visible:outline-none">
              {/* 语言分区:单选分段控件(ToggleGroup)。数据驱动 SUPPORTED_LOCALES。 */}
              <section className="mb-4">
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

              {/* 字体大小分区:shadcn Slider(终端 + Monaco + md 预览统一一个值)+ 数值 + 重置。 */}
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wide text-[#475569]">{t("settings.fontSize.title")}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] tabular-nums text-[var(--mx-text)]">{fontSize}px</span>
                    <button
                      type="button"
                      onClick={() => changeFontSize(DEFAULT_FONT_SIZE)}
                      disabled={fontSize === DEFAULT_FONT_SIZE}
                      className="text-[11px] text-[var(--mx-faint)] transition-colors hover:text-[var(--mx-text)] disabled:opacity-40 disabled:hover:text-[var(--mx-faint)]"
                    >
                      {t("settings.fontSize.reset")}
                    </button>
                  </div>
                </div>
                <Slider
                  value={[fontSize]}
                  min={FONT_SIZE_MIN}
                  max={FONT_SIZE_MAX}
                  step={1}
                  onValueChange={(v) => changeFontSize(v[0])}
                  aria-label={t("settings.fontSize.title")}
                >
                  <SliderTrack>
                    <SliderRange />
                  </SliderTrack>
                  <SliderThumb />
                </Slider>
                <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[var(--mx-faint)]">
                  <span>{FONT_SIZE_MIN}</span>
                  <span>{FONT_SIZE_MAX}</span>
                </div>
                <div className="mt-1.5 text-[10px] text-[var(--mx-faint)]">{t("settings.fontSize.hint")}</div>
              </section>
            </TabsContent>

            {/* 快捷键 tab */}
            <TabsContent value="shortcuts" className="focus-visible:outline-none">
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
            </TabsContent>

            {/* 关于 tab:产品描述 + GitHub 仓库链接 + 版本/协议/技术栈 */}
            <TabsContent value="about" className="focus-visible:outline-none">
              {/* 品牌标识:brand-gradient 方块 + 产品名 + 版本 */}
              <div className="mb-3 flex items-center gap-2.5">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--mx-radius-lg)] text-[18px] font-extrabold text-white bg-[var(--mx-brand-gradient)] shadow-[0_0_0_1px_rgba(34,211,238,0.45),0_1px_3px_rgba(0,0,0,0.4)]">
                  T
                </div>
                <div className="min-w-0">
                  <div className="text-[14px] font-[760] text-[var(--mx-text)]">txuyStudio</div>
                  <div className="text-[11px] text-[var(--mx-muted)]">{t("about.version")} {APP_VERSION}</div>
                </div>
              </div>

              {/* 产品描述 */}
              <p className="mb-3 text-[12px] leading-relaxed text-[var(--mx-text)]">
                {t("about.description")}
              </p>

              {/* GitHub 仓库链接:外部地址,target=_blank 由 Tauri 转给系统浏览器(无需 opener 依赖)。 */}
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("about.viewOnGithub")}
                className="mx-chip mb-3 flex items-center gap-2 bg-[rgba(15,23,42,0.5)] px-3 py-2 text-[12px] text-[var(--mx-text)] transition-colors hover:bg-[var(--mx-hover-bg)]"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden className="shrink-0">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                </svg>
                <span className="min-w-0 truncate">{GITHUB_URL.replace("https://", "")}</span>
                <span aria-hidden className="ml-auto shrink-0 text-[var(--mx-muted)]">↗</span>
              </a>

              {/* 协议 + 技术栈(固定英文,不译) */}
              <div className="text-[11px] leading-relaxed text-[var(--mx-faint)]">
                MIT License · Tauri + Rust + React + xterm.js
              </div>
            </TabsContent>
          </div>
        </Tabs>

        {/* 底部:关闭按钮(顶部已有 ✕,此为兜底)。固定不滚。 */}
        <div className="flex shrink-0 justify-end px-4 pb-3 pt-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
