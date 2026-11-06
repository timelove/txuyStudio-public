import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * 跟踪“最新用户问题”是否离开消息流视口。
 *
 * 除了几何判定,还刻意把“定位节点不存在”视为离开视口:桌面消息流有虚拟窗口,
 * 远距离上滚时该消息 DOM 会被裁剪,IntersectionObserver/ref 都拿不到节点。
 */
export function useCurrentPromptStick({
  promptId,
  scrollRef,
  revision,
}: {
  promptId: string | undefined;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** 消息数量 / 虚拟偏移等廉价修订号,内容或挂载状态变化后复评。 */
  revision: number | string;
}) {
  const promptRef = useRef<HTMLDivElement | null>(null);
  const [detached, setDetached] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const evaluate = useCallback(() => {
    if (!promptId) {
      setDetached(false);
      return;
    }
    const scroller = scrollRef.current;
    if (!scroller) return;
    const prompt = promptRef.current;
    if (!prompt) {
      setDetached(true);
      return;
    }
    const viewport = scroller.getBoundingClientRect();
    const rect = prompt.getBoundingClientRect();
    const visible = rect.bottom >= viewport.top + 8 && rect.top <= viewport.bottom - 8;
    setDetached(!visible);
  }, [promptId, scrollRef]);

  useEffect(() => {
    setExpanded(false);
    evaluate();
  }, [evaluate, revision]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener("scroll", evaluate, { passive: true });
    window.addEventListener("resize", evaluate);
    return () => {
      scroller.removeEventListener("scroll", evaluate);
      window.removeEventListener("resize", evaluate);
    };
  }, [evaluate, scrollRef]);

  return { promptRef, detached, expanded, setExpanded };
}
