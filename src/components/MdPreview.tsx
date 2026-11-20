import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { lookupResolved, revealLocalPath, resolveLocalPaths, splitPathSegments } from "../domain/localPaths";
import { useSessionCwd } from "../domain/sessionCwd";
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
    // 长块阈值:>30 行折叠(默认限高滚动),短块直接全显。indexOf 数换行且到 30 即止——
    // 不为「数行数」分配整段 split 数组(千行块在笔记逐字预览路径是每次按键的常客)。
    const src = code.textContent ?? "";
    let lines = 1;
    let nl = -1;
    while (lines <= 30 && (nl = src.indexOf("\n", nl + 1)) !== -1) lines++;
    const long = lines > 30;

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

/**
 * 本机文件路径富化(会话流文件链接的 markdown 面):遍历文本节点(跳过 code/pre/a),
 * 候选查缓存命中且存在的包 `.mx-filepath` span(data-mx-resolved = 绝对路径,点击走
 * 根元素 onClick 委托 reveal)。`awaitMissing` = true 时同步等待未验证候选批量解析
 * 完成(终态渲染:缓存串里链接完整);false 只用已就绪缓存并发起补验不等待(流式
 * live:下一 delta / 轮末终态自然补上,不阻塞增量渲染节奏)。
 */
async function enrichFilePaths(root: HTMLElement, cwd: string, titleText: string, awaitMissing: boolean): Promise<void> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const el = node.parentElement;
      if (!el || el.closest("pre, code, a, .mx-codeblock")) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && /[:\\/]/.test(node.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  if (nodes.length === 0) return;
  const missing = new Set<string>();
  for (const n of nodes) {
    for (const seg of splitPathSegments(n.nodeValue ?? "")) {
      if (seg.isCand && lookupResolved(cwd, seg.text) === undefined) missing.add(seg.text);
    }
  }
  if (missing.size > 0) {
    const p = resolveLocalPaths(cwd, [...missing]);
    if (!awaitMissing) void p.catch(() => {});
    else await p.catch(() => {});
  }
  for (const n of nodes) {
    const segs = splitPathSegments(n.nodeValue ?? "");
    if (!segs.some((s) => s.isCand)) continue;
    const frag = document.createDocumentFragment();
    let linked = false;
    for (const seg of segs) {
      const hit = seg.isCand ? lookupResolved(cwd, seg.text) : undefined;
      if (seg.isCand && hit?.resolved) {
        const span = document.createElement("span");
        span.className = "mx-filepath";
        span.title = titleText;
        span.setAttribute("data-mx-resolved", hit.resolved);
        span.textContent = seg.text;
        frag.appendChild(span);
        linked = true;
      } else {
        frag.appendChild(document.createTextNode(seg.text));
      }
    }
    // 有任一命中才替换节点,避免纯文本节点被无意义重建。
    if (linked) n.parentNode?.replaceChild(frag, n);
  }
}

export const MdPreview = memo(function MdPreview({
  content,
  inline = false,
  live = false,
}: {
  content: string;
  inline?: boolean;
  /**
   * live(流式增量渲染,消息流双轨的稳定前缀):内容持续增长,每次 content 变
   * ① **不清空旧 html**——照默认行为先清回 loading 再异步 parse,流式下就是
   *    每个 delta 闪空一次;保留旧渲染直到新 html ready,视觉上是原地增量更新;
   * ② **不进 LRU 缓存**——流式前缀每个 delta 都是不同 content,全 miss,会把
   *    200 条缓存预算耗在中间态上,挤出真正需要缓存的历史消息/终态。
   */
  live?: boolean;
}) {
  const { t } = useTranslation();
  const { fontSize } = useSettings();
  // 会话 cwd(对话 pane Provider 注入;文件树/笔记等语境默认空串 → 仅绝对路径可标)。
  // 缓存 key 掺 cwd:同 content 不同项目下相对路径解析基不同,链接串不可共享。
  const cwd = useSessionCwd();
  const cacheKey = `${cwd}\u0000${content}`;
  // 命中缓存同步直出(切 tab/重渲染零解析、无 loading 闪烁);live 模式不查缓存。
  const [html, setHtml] = useState<string | null>(() => (live ? null : getCached(cacheKey)) ?? null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 先查缓存(同 content 在 effect 时可能已被别的实例解析完;live 模式跳过)。
    const cached = live ? undefined : getCached(cacheKey);
    if (cached !== undefined) {
      setHtml(cached);
      setError(null);
      return;
    }
    // 未命中且已有旧 html(content 变了,如笔记预览逐字输入):先清空回 loading 态,
    // 避免解析完成前短暂显示上一条内容的 html(陈旧闪现)。
    // live(流式增量)模式不清空:保留旧 html 直到新 html ready,防每个 delta 闪空。
    if (!live) setHtml((prev) => (prev === null ? prev : null));
    let alive = true;
    void getRenderPipeline()
      .then(async ({ render, highlightAll }) => {
        // 在离屏容器上完成 hljs 后处理,取 innerHTML 入缓存(缓存串已含高亮 span)。
        const off = document.createElement("div");
        off.innerHTML = render(content);
        highlightAll(off);
        enrichCodeBlocks(off);
        // 路径富化:终态等待批量验证(缓存串里链接完整);live 只用已就绪缓存并发起
        // 补验不等待(见 enrichFilePaths 注释),轮末终态渲染兜底补全。
        await enrichFilePaths(off, cwd, t("claudepane.revealInFolder"), !live);
        if (!alive) return;
        const finalHtml = off.innerHTML;
        if (!live) setCached(cacheKey, finalHtml);
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
  }, [cacheKey, live, cwd, t]);

  if (error) {
    return inline ? null : <div className="grid h-full place-items-center px-4 text-center text-[11px] text-[var(--mx-danger)]">{error}</div>;
  }
  if (html === null) {
    // inline(消息流)未就绪不显占位(流式文本分支本来就不走 MdPreview);非 inline 显 loading。
    return inline ? null : <div className="grid h-full place-items-center text-[11px] text-[var(--mx-faint)]">{t("common.loading")}</div>;
  }

  // 代码块复制/折叠委托:缓存 HTML 是静态串,按钮交互经根元素 onClick 委托处理
  // (复制→取 .mx-codeblock 内 code 文本,成功后按钮 1.2s 显 ✓ 反馈,与 CopyButton 对齐——
  // 点击无反馈会让用户怀疑没复制上;折叠→toggle .expanded 并换 ▾/▴)。
  const handleBlockClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // 本机文件路径链接(富化注入的静态 span):reveal 所在目录。
    const fp = target.closest<HTMLElement>(".mx-filepath");
    if (fp?.dataset.mxResolved) {
      revealLocalPath(fp.dataset.mxResolved);
      return;
    }
    const wrap = target.closest<HTMLElement>(".mx-codeblock");
    if (!wrap) return;
    if (target.dataset?.mxCopy !== undefined) {
      const code = wrap.querySelector("pre code");
      const text = code?.textContent ?? "";
      void navigator.clipboard
        ?.writeText(text)
        .then(() => {
          target.textContent = "✓";
          target.classList.add("copied");
          window.setTimeout(() => {
            target.textContent = "⧉";
            target.classList.remove("copied");
          }, 1200);
        })
        .catch(() => {});
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
        // inline(嵌入消息流)只用 break-words 之外的隐性需求:宽度收缩交给 app.css 的
        // `.mx-md-preview{min-width:0; overflow-wrap:anywhere}`——break-word 不参与 min-content
        // 计算,长路径会把消息流撑出横向滚动条。block 态(探针预览)保持自带滚动。
        inline
          ? "mx-md-preview mx-scroll-pretty leading-relaxed text-[var(--mx-text)]"
          : "mx-md-preview mx-scroll-pretty h-full overflow-auto px-4 py-3 leading-relaxed text-[var(--mx-text)]"
      }
      style={{ fontSize }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
