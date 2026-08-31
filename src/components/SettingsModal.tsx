import { useTranslation } from "react-i18next";
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getUpdaterSnapshot, publishUpdater, type UpdaterSnapshot } from "../domain/appUpdater";
import { SANDBOX_MODES } from "../domain/codexSandbox";
import { SHORTCUT_GROUPS } from "../domain/shortcuts";
import { useI18n } from "../i18n/I18nProvider";
import { SUPPORTED_LOCALES, type Locale } from "../i18n";
import { useSettings } from "../settings/SettingsProvider";
import { useTheme } from "../theme/ThemeProvider";
import type { ThemeId } from "../domain/themes";
import { DEFAULT_FONT_SIZE, FONT_SIZE_MAX, FONT_SIZE_MIN } from "../settings";
import { Button } from "./ui/Button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "./ui/Dialog";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "./ui/Slider";

/**
 * 滑杆 + 左右 −/+ 步进按钮(设置面板统一规格)。
 * 点击按钮步进一个 step(浮点步进经 round 修误差,clamp 到 [min,max]);
 * 中间滑杆照常拖拽。三处滑杆(字体/模糊/暗化)共用,± 视觉与面板小按钮一致。
 */
function StepperSlider({
  value,
  min,
  max,
  step,
  onValueChange,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onValueChange: (v: number) => void;
  ariaLabel: string;
}) {
  // 浮点 step(0.05)累积误差:先按 step 取整回栅格,再 clamp(min/max 兜住 0.85 这类端点)。
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const btn =
    "grid h-5 w-5 place-items-center rounded-[var(--mx-radius-md)] text-[13px] leading-none text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--mx-muted)]";
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={`- ${ariaLabel}`}
        disabled={value <= min}
        onClick={() => onValueChange(clamp(value - step))}
        className={btn}
      >
        −
      </button>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onValueChange(v[0])}
        aria-label={ariaLabel}
        className="flex-1"
      >
        <SliderTrack>
          <SliderRange />
        </SliderTrack>
        <SliderThumb />
      </Slider>
      <button
        type="button"
        aria-label={`+ ${ariaLabel}`}
        disabled={value >= max}
        onClick={() => onValueChange(clamp(value + step))}
        className={btn}
      >
        +
      </button>
    </div>
  );
}
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/Tabs";
import { ToggleGroup, ToggleGroupItem } from "./ui/ToggleGroup";

/** 公开仓库地址(私有 origin 不暴露,此处指向公开 mirror)。 */
const GITHUB_URL = "https://github.com/timelove/txuyStudio-public";

/**
 * 应用更新器(设置 → 关于 tab)。基于 tauri-plugin-updater:check() 拉 endpoints 的
 * latest.json(公开仓 latest Release 固定资产),与本地版本比对;有更新 → 下载 + 验签
 * (构建时 TAURI_SIGNING_PRIVATE_KEY 签名,pubkey 嵌 tauri.conf.json)→ install →
 * relaunch。状态机:idle(检查)→ checking → upToDate / available(显示版本+notes+「下载并安装」)
 * → downloading(进度条,downloadAndInstall 带 contentLength/total)→ installing → ready(「重启生效」)
 * / error(真实错误信息直接展示,便于定位网络/验签问题)。
 */
function AppUpdater({ t }: { t: (k: string, o?: Record<string, unknown>) => string }) {
  type UpdState =
    | { phase: "idle" }
    | { phase: "checking" }
    | { phase: "upToDate" }
    | { phase: "available"; update: Update }
    | { phase: "downloading"; received: number; total: number | null }
    | { phase: "installing" }
    | { phase: "ready" }
    | { phase: "error"; message: string };
  // 初始态联动全局 store:启动自动检查已发现新版本时,打开面板直接显示 available
  //(Update 实例可复用——downloadAndInstall 是它的方法),免二次请求。
  const fromStore = (s: UpdaterSnapshot): UpdState =>
    s.phase === "available" ? { phase: "available", update: s.update } : { phase: "idle" };
  const [state, setState] = useState<UpdState>(() => fromStore(getUpdaterSnapshot()));

  const runCheck = async () => {
    setState({ phase: "checking" });
    try {
      const update = await check();
      console.info("[updater] manual check:", update ? `available v${update.version}` : "up-to-date(null)");
      // 结果同步全局 store(状态栏 chip 出现/消失)。
      publishUpdater(update ? { phase: "available", update } : { phase: "upToDate" });
      setState(update ? { phase: "available", update } : { phase: "upToDate" });
    } catch (err) {
      setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const runInstall = async (update: Update) => {
    try {
      setState({ phase: "downloading", received: 0, total: null });
      // downloaded/contentLength 单位字节(可能无 content-length → total null,显示不定进度)。
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          setState({ phase: "downloading", received: 0, total: event.data.contentLength });
        } else if (event.event === "Progress") {
          setState((s) =>
            s.phase === "downloading"
              ? { phase: "downloading", received: s.received + event.data.chunkLength, total: s.total }
              : s,
          );
        } else if (event.event === "Finished") {
          setState({ phase: "installing" });
        }
      });
      // 安装完成回写全局:状态栏「新版本可用」chip 消失,等用户重启。
      publishUpdater({ phase: "upToDate" });
      setState({ phase: "ready" });
    } catch (err) {
      setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const fmtBytes = (n: number) =>
    n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

  return (
    <section className="mx-chip mb-3 bg-[var(--mx-surface-soft)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-[600] text-[var(--mx-text)]">{t("settings.updater.title")}</span>
        {/* 当前阶段轻提示 */}
        {state.phase === "checking" && <span className="text-[10px] text-[var(--mx-faint)]">{t("settings.updater.checking")}</span>}
        {state.phase === "upToDate" && <span className="text-[10px] text-[#86efac]">{t("settings.updater.upToDate")}</span>}
        {state.phase === "ready" && <span className="text-[10px] text-[#86efac]">{t("settings.updater.installed")}</span>}
        {state.phase === "error" && (
          <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--mx-danger)]" title={state.message}>
            {t("settings.updater.error")} · {state.message}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {(state.phase === "idle" || state.phase === "upToDate" || state.phase === "error") && (
            <Button size="sm" variant="outline" onClick={() => void runCheck()}>
              {t("settings.updater.check")}
            </Button>
          )}
          {state.phase === "available" && (
            <Button size="sm" onClick={() => void runInstall(state.update)}>
              {t("settings.updater.install")}
            </Button>
          )}
          {state.phase === "downloading" && (
            <span className="text-[10px] tabular-nums text-[var(--mx-faint)]">
              {t("settings.updater.downloading")}
              {state.total ? ` ${fmtBytes(state.received)} / ${fmtBytes(state.total)}` : ` ${fmtBytes(state.received)}`}
            </span>
          )}
          {state.phase === "installing" && <span className="text-[10px] text-[var(--mx-faint)]">{t("settings.updater.installing")}</span>}
          {state.phase === "ready" && (
            <Button size="sm" onClick={() => void relaunch().catch(() => {})}>{t("settings.updater.relaunch")}</Button>
          )}
        </span>
      </div>

      {/* 新版本信息:版本号 + 更新日志(notes 是发版时写入 latest.json 的 markdown 原文,按行展示) */}
      {state.phase === "available" && (
        <div className="mt-2 border-t border-[var(--mx-border)] pt-2">
          <div className="text-[11px] font-[600] text-[var(--mx-accent)]">
            {__APP_VERSION__} → {state.update.version}
          </div>
          {state.update.body && (
            <pre className="mx-scroll-pretty mt-1 max-h-[140px] overflow-y-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-[var(--mx-muted)]">
              {state.update.body}
            </pre>
          )}
        </div>
      )}
      {/* 下载进度条:不定进度(total null)时来回动画由 range 宽度 0 隐藏,仅文字计数。 */}
      {state.phase === "downloading" && state.total && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--mx-border-strong)]">
          <div
            className="h-full rounded-full bg-[var(--mx-accent)] transition-[width] duration-150"
            style={{ width: `${Math.min(100, (state.received / state.total) * 100)}%` }}
          />
        </div>
      )}
    </section>
  );
}

type SettingsModalProps = {
  /** 是否显示;false 时不渲染。 */
  open: boolean;
  onClose: () => void;
  /** 打开时定位到的 tab(状态栏「新版本可用」点击 → about);缺省 general。Dialog 关闭即
   *  卸载内容,defaultValue 每次打开取新值,无需受控切换。 */
  initialTab?: "general" | "shortcuts" | "about";
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
export function SettingsModal({ open, onClose, initialTab }: SettingsModalProps) {
  const { t } = useTranslation();
  const { locale, changeLanguage } = useI18n();
  const { fontSize, changeFontSize, codexSandbox, changeCodexSandbox, bgSetting, changeBgSetting } = useSettings();
  const { themeId, changeTheme, themes } = useTheme();

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

        <Tabs defaultValue={initialTab ?? "general"} className="flex min-h-0 flex-1 flex-col">
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
              {/* 主题分区:单选分段控件(ToggleGroup)。数据驱动 THEMES,切换即时生效(CSS data-theme + 终端热切)。 */}
              <section className="mb-4">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">{t("settings.theme.title")}</div>
                <ToggleGroup
                  type="single"
                  value={themeId}
                  onValueChange={(v) => {
                    if (v) changeTheme(v as ThemeId);
                  }}
                >
                  {themes.map((th) => (
                    <ToggleGroupItem key={th.id} value={th.id}>
                      {t(th.labelKey)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </section>
              {/* 语言分区:单选分段控件(ToggleGroup)。数据驱动 SUPPORTED_LOCALES。 */}
              <section className="mb-4">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">{t("settings.language.title")}</div>
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
                  <span className="text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">{t("settings.fontSize.title")}</span>
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
                <StepperSlider
                  value={fontSize}
                  min={FONT_SIZE_MIN}
                  max={FONT_SIZE_MAX}
                  step={1}
                  onValueChange={changeFontSize}
                  ariaLabel={t("settings.fontSize.title")}
                />
                <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[var(--mx-faint)]">
                  <span>{FONT_SIZE_MIN}</span>
                  <span>{FONT_SIZE_MAX}</span>
                </div>
                <div className="mt-1.5 text-[10px] text-[var(--mx-faint)]">{t("settings.fontSize.hint")}</div>
              </section>

              {/* 背景图分区:选图(系统文件选择器,仅图片)+ 模糊/暗化滑杆 + 清除。
                  开启后前景面板半透明(玻璃态)透出虚化背景。 */}
              <section className="mt-4 border-t border-[var(--mx-border)] pt-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">{t("settings.bg.title")}</span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void openDialog({
                          multiple: false,
                          filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
                        })
                          .then((sel) => {
                            if (typeof sel === "string" && sel) changeBgSetting({ path: sel });
                          })
                          .catch(() => { /* 非 Tauri 环境,静默 */ });
                      }}
                    >
                      {t("settings.bg.choose")}
                    </Button>
                    {bgSetting.path && (
                      <button
                        type="button"
                        onClick={() => changeBgSetting({ path: "" })}
                        className="text-[11px] text-[var(--mx-faint)] transition-colors hover:text-[var(--mx-text)]"
                      >
                        {t("settings.bg.clear")}
                      </button>
                    )}
                  </div>
                </div>
                {bgSetting.path && (
                  <>
                    <div className="mb-0.5 truncate text-[10px] text-[var(--mx-faint)]" title={bgSetting.path}>
                      {bgSetting.path}
                    </div>
                    {/* 模糊滑杆:0-40px。 */}
                    <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--mx-faint)]">
                      <span>{t("settings.bg.blur")}</span>
                      <span className="tabular-nums">{bgSetting.blur}px</span>
                    </div>
                    <StepperSlider
                      value={bgSetting.blur}
                      min={0}
                      max={40}
                      step={1}
                      onValueChange={(v) => changeBgSetting({ blur: v })}
                      ariaLabel={t("settings.bg.blur")}
                    />
                    {/* 暗化滑杆:0-0.85。 */}
                    <div className="mb-1 mt-2 flex items-center justify-between text-[10px] text-[var(--mx-faint)]">
                      <span>{t("settings.bg.dim")}</span>
                      <span className="tabular-nums">{Math.round(bgSetting.dim * 100)}%</span>
                    </div>
                    <StepperSlider
                      value={bgSetting.dim}
                      min={0}
                      max={0.85}
                      step={0.05}
                      onValueChange={(v) => changeBgSetting({ dim: v })}
                      ariaLabel={t("settings.bg.dim")}
                    />
                  </>
                )}
                <div className="mt-1.5 text-[10px] text-[var(--mx-faint)]">{t("settings.bg.hint")}</div>
              </section>

              {/* Codex 沙箱分区:默认档三选一(ToggleGroup,与 CodexPane 状态栏同源 SANDBOX_MODES)。
                  只影响新建 codex 会话的初始 -s;已开会话不跟随(其状态栏单独切)。 */}
              <section className="mt-4 border-t border-[var(--mx-border)] pt-3">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">{t("settings.codexSandbox.title")}</div>
                <ToggleGroup
                  type="single"
                  value={codexSandbox}
                  onValueChange={(v) => {
                    // type="single" 点中已选中项回传 "",忽略(必有选中档)。
                    if (v) changeCodexSandbox(v);
                  }}
                >
                  {SANDBOX_MODES.map((m) => (
                    <ToggleGroupItem key={m.id} value={m.id}>
                      {m.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {/* 当前选中档的中文描述(随选择动态变),让用户知道每档含义而不只看短标签。 */}
                <div className="mt-1.5 text-[10px] text-[var(--mx-faint)]">
                  {t(SANDBOX_MODES.find((m) => m.id === codexSandbox)?.desc ?? "")}
                </div>
                <div className="mt-1.5 text-[10px] text-[var(--mx-faint)]">{t("settings.codexSandbox.hint")}</div>
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
                          <kbd className="mx-icon-tile shrink-0 border border-[var(--mx-border-strong)] bg-[var(--mx-surface-2)] px-1.5 py-[1px] font-mono text-[11px] text-[var(--mx-text)]">
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
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--mx-radius-lg)] text-[18px] font-extrabold text-white bg-[var(--mx-brand-gradient)] shadow-[0_0_0_1px_var(--mx-selected-border),0_1px_3px_rgba(0,0,0,0.4)]">
                  T
                </div>
                <div className="min-w-0">
                  <div className="text-[14px] font-[760] text-[var(--mx-text)]">txuyStudio</div>
                  <div className="text-[11px] text-[var(--mx-muted)]">{t("about.version")} {__APP_VERSION__}</div>
                </div>
              </div>

              {/* 产品描述 */}
              <p className="mb-3 text-[12px] leading-relaxed text-[var(--mx-text)]">
                {t("about.description")}
              </p>

              {/* 应用更新:检查/下载/安装/重启 + 新版本更新日志(见 AppUpdater 注释) */}
              <AppUpdater t={t} />

              {/* GitHub 仓库链接:外部地址,target=_blank 由 Tauri 转给系统浏览器(无需 opener 依赖)。 */}
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("about.viewOnGithub")}
                className="mx-chip mb-3 flex items-center gap-2 bg-[var(--mx-surface-soft)] px-3 py-2 text-[12px] text-[var(--mx-text)] transition-colors hover:bg-[var(--mx-hover-bg)]"
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
