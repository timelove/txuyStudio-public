import { useEffect, useRef, useState } from "react";

/**
 * 流式 Markdown 双轨拆分 + 节流值。
 *
 * 背景:AI 自渲染消息流原来两种流式形态都有瑕疵——
 * - ClaudePane:流式中整块纯文本、轮末才切 markdown。用户观感「md 内容先展示
 *   文本类型,然后再真实渲染」:写完的内容迟迟不渲染,最后一秒整体跳变。
 * - CodexPane:流式中直接全量渲染 markdown——每个 delta 重跑 marked+hljs,且
 *   MdPreview 每次 content 变先清空再异步 parse,表现为持续闪烁。
 *
 * 双轨方案:稳定前缀(已完成的块级元素)实时走 markdown 渲染,活跃尾巴(正在写的
 * 最后一段 / 未闭合代码块)保持纯文本。内容边写边渲染,只有当前正在写的一小段
 * 显示原文,消除「整段原文 → 整体渲染」的跳变。
 */

/** 拆分结果:stable=可安全渲染的前缀(含切分处的空行),tail=未写完的原文。 */
export type StableTailSplit = { stable: string; tail: string };

/**
 * 拆稳定前缀与活跃尾巴。稳定边界取**最靠前的未完成结构**(宁可少渲染也不错渲染):
 * ① 未闭合代码块:行首 fence(```)数为奇数 → 边界在最后一个 fence 起点,tail 含
 *    fence 行及其后代码原文(未写完的代码块保持纯文本,写完即整体渲染);
 * ② 段落边界:最后一个空行(`\n\n`)之后是未写完段,tail 即该段;
 * ③ 全部闭合且无空行分隔(刚写完的代码块就在文本末尾):边界取闭合 fence 行尾,
 *    代码块整体进 stable(它已完整可渲染);
 * ④ 都不可用(单段流式):整条是 tail。
 */
export function splitStableTail(text: string): StableTailSplit {
  if (!text) return { stable: "", tail: "" };
  // 行首 fence(允许任意缩进;md 规范 fence 缩进 ≤3 空格,此处宽容)。多行模式,
  // lastIndex 手动推进,exec 循环收集全部命中。
  const fenceRe = /^[ \t]*```/gm;
  let fenceCount = 0;
  let lastFenceStart = -1;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    fenceCount++;
    lastFenceStart = m.index;
  }
  if (fenceCount % 2 === 1 && lastFenceStart >= 0) {
    return { stable: text.slice(0, lastFenceStart), tail: text.slice(lastFenceStart) };
  }
  const gap = text.lastIndexOf("\n\n");
  if (gap >= 0) {
    return { stable: text.slice(0, gap + 2), tail: text.slice(gap + 2) };
  }
  // fence 偶数且成对:最后 fence 是闭合行,其行尾之后才是未写完内容
  // (无 \n\n 时闭合代码块就在末尾,整体可渲染)。fence 后若紧跟空行,第二个 \n
  // 一并并入 stable,避免 tail 以孤立空行开头。
  if (fenceCount >= 2 && lastFenceStart >= 0) {
    const lineEnd = text.indexOf("\n", lastFenceStart);
    let boundary = lineEnd === -1 ? text.length : lineEnd + 1;
    if (text[boundary] === "\n") boundary += 1;
    return { stable: text.slice(0, boundary), tail: text.slice(boundary) };
  }
  return { stable: "", tail: text };
}

/**
 * 节流值:高频更新(claude 流式 delta 每 token 一发)下按最小间隔 ms 合并渲染,
 * 避免每个 delta 都触发一次 marked 全量解析。
 *
 * leading-edge + trailing timer:距上次放行已过 ms 立即更新;否则挂尾定时器补
 * 最后一次——流式停止(不再有 delta)时尾巴必定 flush,不会吞掉最终态。
 */
export function useThrottledValue(value: string, ms: number): string {
  const [throttled, setThrottled] = useState(value);
  const lastRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const flush = () => {
      lastRef.current = Date.now();
      setThrottled(value);
    };
    const elapsed = Date.now() - lastRef.current;
    if (elapsed >= ms) {
      flush();
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, ms - elapsed);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [value, ms]);

  return throttled;
}
