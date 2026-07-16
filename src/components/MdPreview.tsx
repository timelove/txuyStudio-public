import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Markdown 预览(探针右栏 md 文件 preview 态)。
 *
 * `marked`(md→html)+ `dompurify`(XSS 防护,sanitize 后再 dangerouslySetInnerHTML)。
 * 两者用 dynamic import 懒加载(vite manualChunks 分到 `md-render` chunk,不拖首屏——
 * 仅 md 预览首次使用时加载)。内容变化重新渲染。
 *
 * 样式手写复用 --mx-* token(标题/代码块/列表/引用),见 .mx-md-preview 容器 class。
 * sanitize 策略:允许基础 HTML 标签(标题/列表/代码/链接/强调),strip `<script>`/事件处理器。
 *
 * **dompurify@3 ESM 关键坑**:ESM `default` 导出是工厂 `createDOMPurify(root)`,不是已绑定
 * window 的实例。若直接 `purifyMod.default.sanitize(...)` → `sanitize is not a function` 抛错,
 * 旧实现 catch 吞错后 html="" → 渲染空 div(深色底)→ 看似「黑屏」。必须先 `default(window)`
 * 取实例再 sanitize。
 */
export function MdPreview({ content }: { content: string }) {
  const { t } = useTranslation();
  const [html, setHtml] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    // dynamic import:marked + dompurify 懒加载(分包 md-render,首屏不加载)。
    void Promise.all([import("marked"), import("dompurify")])
      .then(([markedMod, purifyMod]) => {
        const marked = markedMod.marked;
        // dompurify@3:default 是 createDOMPurify 工厂,需传入 window 取实例。
        const createDOMPurify = purifyMod.default as unknown as (
          w: Window & typeof globalThis,
        ) => { sanitize: (h: string, o?: Record<string, unknown>) => string };
        const DOMPurify = createDOMPurify(window);
        const raw = marked.parse(content, { async: false }) as string;
        const safe = DOMPurify.sanitize(raw, {
          // 允许基础排版标签;ADD_ATTR 不放开(防 on* 事件)。链接默认允许 target 经 rel 控制。
          ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "id", "colspan", "rowspan", "target", "rel"],
        });
        if (alive) {
          setHtml(safe);
          setLoading(false);
        }
      })
      .catch((e) => {
        // 不静默吞错:渲染错误态而非空 div(避免「黑屏」假象,且暴露真实原因)。
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [content]);

  if (loading) {
    return <div className="grid h-full place-items-center text-[11px] text-[var(--mx-faint)]">{t("common.loading")}</div>;
  }
  if (error) {
    return <div className="grid h-full place-items-center px-4 text-center text-[11px] text-[#f87171]">{error}</div>;
  }

  return (
    <div
      className="mx-md-preview mx-scroll-pretty h-full overflow-auto px-4 py-3 text-[12px] leading-relaxed text-[var(--mx-text)]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
