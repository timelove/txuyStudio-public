/**
 * i18n React Provider —— 包裹应用,提供语言切换能力。
 *
 * 基于 `react-i18next`:`I18nextProvider` 注入 i18next 实例,`useTranslation` 的 `t`
 * 会响应 `i18n.changeLanguage` 自动触发组件重渲染(无需手动广播)。
 *
 * - `initialLocale`:App 在 hydrate 后从后端 `snap.locale` 传入(权威值)。undefined
 *   时保持 i18next 初始化时读的 localStorage/系统推断值,不强制覆盖。
 * - `changeLanguage(locale)`:同步切 i18next + 写 localStorage 兜底 + invoke 后端
 *   `set_locale` 落盘 state.json(权威持久化)。三步并行无依赖,失败仅 warn 不阻断切换。
 *
 * 通过 [[useI18n]] 暴露 `{ locale, changeLanguage }`;`t` 直接用 `useTranslation`。
 */
import { useEffect, useState, type ReactNode } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import i18n, { changeI18nLocale, type Locale } from "./index";

type I18nContextValue = {
  /** 当前语言标识("zh" | "en"),供设置面板高亮选中项。 */
  locale: Locale;
  /** 切换语言:切 i18next + localStorage + 后端落盘。 */
  changeLanguage: (locale: Locale) => void;
};

import { createContext, useContext } from "react";
const I18nContext = createContext<I18nContextValue | null>(null);

/** 取 i18n 当前语言,收紧为 Locale 联合类型(兜底 zh)。 */
function currentLocale(): Locale {
  const lng = i18n.language;
  return lng === "en" ? "en" : "zh";
}

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale?: string | null;
  children: ReactNode;
}) {
  const [locale, setLocale] = useState<Locale>(() => {
    // hydrate 后的后端 locale 为权威值;有则用之覆盖 i18next 初始值。
    if (initialLocale === "zh" || initialLocale === "en") {
      void changeI18nLocale(initialLocale);
      return initialLocale;
    }
    return currentLocale();
  });

  // 初次挂载时若 initialLocale 与 i18next 当前值不一致,上面 init 里已异步切;
  // 这里再保底同步一次 state(i18next.changeLanguage 是异步的)。
  useEffect(() => {
    if (initialLocale === "zh" || initialLocale === "en") {
      setLocale(initialLocale);
    }
  }, [initialLocale]);

  const changeLanguage = (next: Locale) => {
    void changeI18nLocale(next)
      .then(() => setLocale(next))
      .catch((e) => console.warn("[i18n] changeLanguage local failed:", e));
    // 后端落盘:失败仅 warn,不回滚本地切换(本地已是用户期望语言,下次 hydrate 仍读后端旧值,
    // 但用户体感已切;下次 set_locale 成功即修正)。
    invoke("set_locale", { locale: next }).catch((e) =>
      console.warn("[i18n] set_locale backend failed:", e),
    );
  };

  return (
    <I18nextProvider i18n={i18n}>
      <I18nContext.Provider value={{ locale, changeLanguage }}>
        {children}
      </I18nContext.Provider>
    </I18nextProvider>
  );
}

/** 取当前语言 + 切换函数。`t` 用 react-i18next 的 useTranslation(自动响应切换)。 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

/** 便捷 hook:同时取 t 和 locale/changeLanguage(组件里 `const { t, locale } = useT()`)。 */
export function useT() {
  const { t } = useTranslation();
  const { locale, changeLanguage } = useI18n();
  return { t, locale, changeLanguage };
}
