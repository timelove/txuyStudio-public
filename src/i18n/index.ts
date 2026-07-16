/**
 * i18next 实例配置 —— 中英文双语资源。
 *
 * - `fallbackLng: 'zh'`:缺 key 回退中文,再回退 key 本身(品牌名 Claude/Codex 等
 *   不入字典,回退 key 即原样显示,无需为每条品牌名造条目)。
 * - `interpolation.escapeValue: false`:React 已对插值文本防 XSS,i18next 再转义
 *   会把 `<strong>` 等显示成字面量;关掉后富文本由组件层 `<Trans>` 处理。
 * - `lng` 初始值:hydrate 前用 localStorage 兜底(避免首帧英文闪烁给中文用户),
 *   hydrate 后由 [[I18nProvider]] 用后端 `snap.locale` 覆盖为权威值。
 * - `returnNull: false`:不返回 null,缺失一律回退。
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./zh";
import en from "./en";

/** localStorage 兜底 locale key(仅 hydrate 前过渡态用,权威值在后端 state.json)。 */
export const LOCALE_STORAGE_KEY = "mx.locale";

/** 支持的语言列表(供 UI 渲染切换项 + 类型收紧)。 */
export const SUPPORTED_LOCALES = ["zh", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** 检测系统语言是否中文环境(navigator.language 形如 zh-CN/zh-TW/zh)。 */
function isSystemChinese(): boolean {
  const lang = (typeof navigator !== "undefined" && navigator.language) || "zh";
  return lang.toLowerCase().startsWith("zh");
}

/** 读 localStorage 兜底 locale;无值时按系统语言推断。 */
function resolveInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // 隐私模式/不可用 → 走系统推断。
  }
  return isSystemChinese() ? "zh" : "en";
}

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: resolveInitialLocale(),
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
  returnNull: false,
  // 允许翻译串里含基础 HTML 标签(<strong>/<em>/<code> 等),由 <Trans> 组件渲染为 JSX。
  // escapeValue:false 让 t() 返回原串(含标签字面量),Trans 才把它们解析成元素;用于
  // InstallPromptModal 的 pathHint(<strong>重启本应用</strong>)等富文本。
  react: {
    transSupportBasicHtmlNodes: true,
    transKeepBasicHtmlNodesFor: ["strong", "b", "em", "i", "code", "br"],
  },
});

/**
 * 切换语言并写 localStorage 兜底(权威持久化由 [[I18nProvider.changeLanguage]] 调
 * 后端 set_locale 完成;此处仅同步 localStorage,供下次 hydrate 前的过渡态用)。
 */
export async function changeI18nLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // 隐私模式/配额 → 忽略。
  }
}

export default i18n;
