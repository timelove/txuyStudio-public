// BaoCode P0.5 — 「总是允许」按钮智能文案
//
// 借鉴:BaoCode 中「Allow for this session」按钮在 Bash / Edit / Write 走不同文案;
// 我们这里不依赖 kernel 协议字段(我们直连 stream-json,无该字段),改为本地
// 派生:按 config.label 给出更具体的按钮文案(例 Bash → "总是允许 Bash")。
// label 缺失时退化到 i18n 的通用 "批准且不再问"。

/** 工具展示名 → 简短中文描述(BaoCode 风格:不写"命令/工具"等冗词)。
 *  - 仅覆盖真正高频需批准的:Write / Edit / MultiEdit / NotebookEdit / Bash / NotebookCell。
 *  - 其它工具(Read / Glob / Grep / WebSearch / WebFetch)直接用 label,因为是只读。 */
const ZH_VERB: Record<string, string> = {
  Write: "写入文件",
  Edit: "编辑文件",
  MultiEdit: "批量编辑",
  NotebookEdit: "编辑 Notebook",
  NotebookCell: "执行单元格",
};

/**
 * 派生按钮文案(只读工具不需要"总是允许",这里也返回 null 让 caller 走降级路径)。
 * @param toolName 原始 tool 名(如 "Bash"/"Write")
 * @param label   config.label(展示名;Bash 的 config.label 通常就是 "Bash")
 * @returns 文案(有)/ null(无,降级到通用)
 */
export function deriveAlwaysAllowLabel(
  toolName: string,
  label?: string,
): string | null {
  // 只读类工具:不该走"总是允许"语义(本来就不弹确认),但保守起见仍给降级(返回 null)
  const readOnly = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "ListMcpResourcesTool"]);
  if (readOnly.has(toolName)) return null;

  // 写类工具:中文动词 + 兜底
  const verb = ZH_VERB[toolName];
  if (verb) return `总是允许 ${verb}`;

  // 其它:用 config.label(若存在),否则 null 降级
  if (label && label.trim()) return `总是允许 ${label.trim()}`;
  return null;
}
