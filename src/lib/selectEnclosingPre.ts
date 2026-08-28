/**
 * Ctrl+A 智能选框:当现行选区的锚点(用户最后点击处)落在 container 内某个
 * 「框」(<pre>,工具输出/代码/子 agent 结果卡片的内容载体)内时,只全选该框内容,
 * 供紧随其后的 Ctrl+C 整块复制;返回是否接管了选择(false = 调用方放行系统默认全选)。
 *
 * 判定只用锚点不在意选区终点:Ctrl+A 前用户通常点过目标区域;没点过时锚点不在
 * container 内,自然回落到「全选整条消息流」的原行为。输入框聚焦时不走这里
 * (调用方先查 activeElement,让浏览器原生全选 textarea 文本)。
 */
export function selectEnclosingPre(container: HTMLElement | null): boolean {
  if (!container) return false;
  const sel = window.getSelection();
  const anchor: Node | null = sel?.anchorNode ?? null;
  if (!anchor || !container.contains(anchor)) return false;
  const el =
    anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement | null);
  const pre = el?.closest("pre");
  // closest 可能向上越出 container(消息流自身无 pre 包裹,防御性仍校验包含关系)。
  if (!pre || !container.contains(pre)) return false;
  const range = document.createRange();
  range.selectNodeContents(pre);
  sel?.removeAllRanges();
  sel?.addRange(range);
  return true;
}
