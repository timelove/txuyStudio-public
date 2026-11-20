import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { lookupResolved, revealLocalPath, resolveLocalPaths, splitPathSegments } from "../domain/localPaths";
import { useSessionCwd } from "../domain/sessionCwd";

/**
 * 纯文本消息的本机路径标蓝(会话流文件链接的纯文本面):thinking 块 / 流式尾巴等
 * 不走 markdown 的文本,候选同步查缓存渲染、miss 异步补验后 bump 一次重渲染。
 * markdown 面由 MdPreview 渲染管线内的 DOM 富化承担(enrichFilePaths),两处共用
 * localPaths 域与 `.mx-filepath` 样式(hover 文件夹图标 + 点击 reveal)。
 */
export const PathAwareText = memo(function PathAwareText({
  text,
  className,
}: {
  text: string;
  /** 外层容器类(如 thinking 的 italic/muted 系列);路径 span 的样式走全局 .mx-filepath。 */
  className?: string;
}) {
  const cwd = useSessionCwd();
  const { t } = useTranslation();
  // [, setVer]:resolve 完成后 bump 触发重渲染,render 中重查缓存即拿到最终标蓝。
  const [, setVer] = useState(0);
  // 已发起过验证的候选(cwd+候选 复合键):防 30ms 批窗口内同候选反复入队/反复 effect。
  const requestedRef = useRef<Set<string>>(new Set());

  const segments = splitPathSegments(text);

  useEffect(() => {
    const cands = segments
      .filter((s) => s.isCand && lookupResolved(cwd, s.text) === undefined)
      .map((s) => s.text)
      .filter((c) => {
        const k = `${cwd}\u0000${c}`;
        if (requestedRef.current.has(k)) return false;
        requestedRef.current.add(k);
        return true;
      });
    if (cands.length === 0) return;
    let alive = true;
    void resolveLocalPaths(cwd, cands).then(() => {
      if (alive) setVer((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [segments, cwd]);

  return (
    <span className={className}>
      {segments.map((s, i) => {
        if (!s.isCand) return s.text;
        const hit = lookupResolved(cwd, s.text);
        if (!hit?.resolved) return s.text;
        return (
          <span
            key={i}
            className="mx-filepath"
            title={t("claudepane.revealInFolder")}
            onClick={() => revealLocalPath(hit.resolved as string)}
          >
            {s.text}
          </span>
        );
      })}
    </span>
  );
});
