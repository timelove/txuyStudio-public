import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../settings/SettingsProvider";
// highlight.js github-dark 主题(随 md-render 分包加载,首屏不拉)。
import "highlight.js/styles/github-dark.css";

/**
 * Markdown 预览(消息流 inline + 探针/笔记右栏 preview)。
 *
 * `marked`(md→html)+ `dompurify`(XSS 防护,sanitize 后再 dangerouslySetInnerHTML)。
 * 两者用 dynamic import 懒加载(vite manualChunks 分到 `md-render` chunk,不拖首屏)。
 *
 * 性能(长会话卡顿治理):
 * - **模块级 LRU 缓存 content→高亮后 html**:消息内容不可变,切 tab 回来/整树重渲染时
 *   命中缓存同步直出,不再重跑 marked+DOMPurify+highlight.js(长会话切回原本秒卡)。
 * - highlight.js 只高亮**带语言标注**的 ``` 代码块;裸块不跑全语言自动检测
 *   (highlightAuto 对长日志/大代码块单块可达数十上百 ms)。
 * - 组件 memo:content 字符串相同直接跳过重渲染。
 *
 * **dompurify@3 ESM 关键坑**:ESM `default` 导出是工厂 `createDOMPurify(root)`,不是已绑定
 * window 的实例。若直接 `purifyMod.default.sanitize(...)` → `sanitize is not a function` 抛错,
 * 旧实现 catch 吞错后 html="" → 渲染空 div(深色底)→ 看似「黑屏」。必须先 `default(window)`
 * 取实例再 sanitize。
 */

/** 模块级 LRU:content → 最终 html(已含 hljs 高亮 span)。长会话切 tab 零重解析。 */
const htmlCache = new Map<string, string>();
const HTML_CACHE_MAX = 200;

function getCached(content: string): string | undefined {
  const hit = htmlCache.get(content);
  if (hit !== undefined) {
    // LRU:命中移到最新。
    htmlCache.delete(content);
    htmlCache.set(content, hit);
  }
  return hit;
}

function setCached(content: string, html: string): void {
  if (htmlCache.has(content)) htmlCache.delete(content);
  htmlCache.set(content, html);
  if (htmlCache.size > HTML_CACHE_MAX) {
    const oldest = htmlCache.keys().next().value;
    if (oldest !== undefined) htmlCache.delete(oldest);
  }
}

/** marked+DOMPurify+hljs 的懒加载单例 promise(首次解析后复用,不重复 import)。 */
let renderPipelinePromise: null | Promise<{
  render: (content: string) => string;
  highlightAll: (root: HTMLElement) => void;
}> = null;

function getRenderPipeline() {
  if (!renderPipelinePromise) {
    renderPipelinePromise = Promise.all([import("marked"), import("dompurify"), import("highlight.js")]).then(
      ([markedMod, purifyMod, hljsMod]) => {
        const marked = markedMod.marked;
        // dompurify@3:default 是 createDOMPurify 工厂,需传入 window 取实例。
        const createDOMPurify = purifyMod.default as unknown as (
          w: Window & typeof globalThis,
        ) => { sanitize: (h: string, o?: Record<string, unknown>) => string };
        const DOMPurify = createDOMPurify(window);

        const render = (content: string): string => {
          const raw = marked.parse(content, { async: false }) as string;
          const safe = DOMPurify.sanitize(raw, {
            // 允许基础排版标签;ADD_ATTR 不放开(防 on* 事件)。
            ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "id", "colspan", "rowspan", "target", "rel"],
          });
          // table 包一层横向滚动容器(保留表格布局语义,见第 66 条)。
          return safe.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => `<div class="mx-md-table-scroll">${table}</div>`);
        };

        // 只高亮带 language-xxx 标注的块;裸 ``` 块保持纯文本(不跑 hljs 全语言自动检测)。
        const highlightAll = (root: HTMLElement) => {
          root.querySelectorAll("pre code").forEach((code) => {
            if (!/\blanguage-[\w-]+/.test(code.className)) return;
            try {
              hljsMod.default.highlightElement(code as HTMLElement);
            } catch {
              /* 未知语言,保持纯文本 */
            }
          });
        };

        return { render, highlightAll };
      },
    );
  }
  return renderPipelinePromise;
}

/**
 * 代码块增强(会话流 B3):每个 `<pre>` 包进 `.mx-codeblock` 容器,头部加语言 label(取自
 * `language-xxx` 类)+ 复制按钮(⧉,data-mx-copy)+ 长块折叠按钮(▾/▴,data-mx-toggle)。
 * 按钮用纯符号(语言无关,缓存 HTML 不绑定 i18n),点击走 MdPreview 根元素的委托 onClick。
 * 必须在 hljs highlightElement 之后调用(此时 className 已含 language-xxx,未被覆盖)。
 */
function enrichCodeBlocks(root: HTMLElement): void {
  root.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code) return;
    const lang = /\blanguage-([\w-]+)/.exec(code.className)?.[1] ?? "";
    // 长块阈值:>30 行折叠(默认限高滚动),短块直接全显。
    const long = (code.textContent ?? "").split("\n").length > 30;

    const wrap = document.createElement("div");
    wrap.className = `mx-codeblock${long ? " long" : ""}`;
    const head = document.createElement("div");
    head.className = "mx-codeblock-head";
    const label = document.createElement("span");
    label.className = "mx-codeblock-lang";
    label.textContent = lang || "code";
    head.appendChild(label);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "mx-codeblock-copy";
    copy.title = "copy";
    copy.textContent = "⧉";
    copy.setAttribute("data-mx-copy", "1");
    head.appendChild(copy);
    if (long) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "mx-codeblock-toggle";
      toggle.title = "expand";
      toggle.textContent = "▾";
      toggle.setAttribute("data-mx-toggle", "1");
      head.appendChild(toggle);
    }
    pre.parentNode?.insertBefore(wrap, pre);
    wrap.appendChild(head);
    wrap.appendChild(pre);
  });
}

export const MdPreview = memo(function MdPreview({ content, inline = false }: { content: string; inline?: boolean }) {
  const { t } = useTranslation();
  const { fontSize } = useSettings();
  // 命中缓存同步直出(切 tab/重渲染零解析、无 loading 闪烁)。
  const [html, setHtml] = useState<string | null>(() => getCached(content) ?? null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 先查缓存(同 content 在 effect 时可能已被别的实例解析完)。
    const cached = getCached(content);
    if (cached !== undefined) {
      setHtml(cached);
      setError(null);
      return;
    }
    // 未命中且已有旧 html(content 变了,如笔记预览逐字输入):先清空回 loading 态,
    // 避免解析完成前短暂显示上一条内容的 html(陈旧闪现)。
    setHtml((prev) => (prev === null ? prev : null));
    let alive = true;
    void getRenderPipeline()
      .then(({ render, highlightAll }) => {
        if (!alive) return;
        // 在离屏容器上完成 hljs 后处理,取 innerHTML 入缓存(缓存串已含高亮 span)。
        const off = document.createElement("div");
        off.innerHTML = render(content);
        highlightAll(off);
        enrichCodeBlocks(off);
        const finalHtml = off.innerHTML;
        setCached(content, finalHtml);
        setHtml(finalHtml);
        setError(null);
      })
      .catch((e) => {
        // 不静默吞错:渲染错误态而非空 div(避免「黑屏」假象,且暴露真实原因)。
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [content]);

  if (error) {
    return inline ? null : <div className="grid h-full place-items-center px-4 text-center text-[11px] text-[var(--mx-danger)]">{error}</div>;
  }
  if (html === null) {
    // inline(消息流)未就绪不显占位(流式文本分支本来就不走 MdPreview);非 inline 显 loading。
    return inline ? null : <div className="grid h-full place-items-center text-[11px] text-[var(--mx-faint)]">{t("common.loading")}</div>;
  }

  // 代码块复制/折叠委托:缓存 HTML 是静态串,按钮交互经根元素 onClick 委托处理
  // (复制→取 .mx-codeblock 内 code 文本;折叠→toggle .expanded 并换 ▾/▴)。
  const handleBlockClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const wrap = target.closest<HTMLElement>(".mx-codeblock");
    if (!wrap) return;
    if (target.dataset?.mxCopy !== undefined) {
      const code = wrap.querySelector("pre code");
      const text = code?.textContent ?? "";
      void navigator.clipboard?.writeText(text).catch(() => {});
    } else if (target.dataset?.mxToggle !== undefined) {
      const expanded = wrap.classList.toggle("expanded");
      target.textContent = expanded ? "▴" : "▾";
    }
  };

  return (
    <div
      ref={ref}
      onClick={handleBlockClick}
      className={
        inline
          ? "mx-md-preview mx-scroll-pretty break-words leading-relaxed text-[var(--mx-text)]"
          : "mx-md-preview mx-scroll-pretty h-full overflow-auto px-4 py-3 leading-relaxed text-[var(--mx-text)]"
      }
      style={{ fontSize }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
