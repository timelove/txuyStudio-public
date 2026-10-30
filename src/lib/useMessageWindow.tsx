import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/**
 * 消息流窗口化(内存优化):长会话只挂最近 batch 条消息的 DOM,顶部哨兵进入视口时
 * 再往前多渲染一批。JS 消息对象仍全量在内存(折叠计算/导出/反扫依赖全量,体积小),
 * 省的是 DOM/VDOM 与 markdown 渲染节点这个大头——几百轮对话不再全量挂树。
 *
 * 锚点不跳:加载更早一批后内容在顶部增长,scrollHeight 增量 delta 补偿回 scrollTop
 * (paint 前修正),视口保持原内容;程序性 scrollTop 调整不会触发「用户上滚」判定。
 */
export const MESSAGE_RENDER_BATCH = 150;

export function useMessageWindow(total: number, scrollRef: RefObject<HTMLDivElement | null>, resetKey: unknown) {
  const [limit, setLimit] = useState(MESSAGE_RENDER_BATCH);
  // 切 tab/会话:窗口回到默认(新会话消息通常不超一批,无感)。
  useEffect(() => {
    setLimit(MESSAGE_RENDER_BATCH);
  }, [resetKey]);

  const offset = Math.max(0, total - limit);
  const hasMore = offset > 0;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ prevHeight: number } | null>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const r = scrollRef.current;
        if (r) anchorRef.current = { prevHeight: r.scrollHeight };
        setLimit((n) => n + MESSAGE_RENDER_BATCH);
      },
      // 提前 400px 预载,减少肉眼可见的「滚到顶才展开」。
      { root, rootMargin: "400px 0px 0px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, scrollRef]);

  // 顶部增长锚点修正:上一批插入后 scrollTop 补回 delta,视口停在原内容(paint 前,不闪跳)。
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const r = scrollRef.current;
    anchorRef.current = null;
    if (a && r) {
      const delta = r.scrollHeight - a.prevHeight;
      if (delta > 0) r.scrollTop += delta;
    }
  }, [limit, scrollRef]);

  const sentinel: ReactNode = hasMore ? (
    <div ref={sentinelRef} className="mb-2 text-center text-[10px] text-[var(--mx-faint)]">
      ↑ 已收起更早的 {offset} 条消息(滚到顶部自动展开)
    </div>
  ) : null;

  return { offset, hasMore, sentinel };
}
