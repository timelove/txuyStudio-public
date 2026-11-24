/**
 * 实况分色与分类口径(2026-11-23 从 StagePanel 拆出独立模块):EngineCore(canvas
 * 引擎)与 StagePanel(图表/拍流)、StatusBar(微条)三方共用,收在独立文件避免
 * StagePanel ↔ EngineCore 循环 import。
 */

/** 会话色签(hash 稳定取色;柔和降饱和色板——玫红/粉两色原 #e11d48/#ec4899 太亮
 *  刺眼,2026-11-19 用户反馈压暗为灰玫/灰粉;一群会话混流也一眼分得清)。 */
const SESSION_COLORS = [
  "#c96f85",
  "#d9a03f",
  "#3f9d78",
  "#4f83c4",
  "#8f7cc9",
  "#4aa3b5",
  "#bd7aa6",
  "#7fa04a",
];

export function sessionColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return SESSION_COLORS[h % SESSION_COLORS.length];
}

export type ToolCat = "read" | "write" | "exec" | "spawn" | "other";

/** 工具分类(图表/XP 权重/彗星着色共用一套口径):
 *  读=青 / 写=accent 金 / 执行=紫(mcp 归执行) / 派生=绿 / 其他=灰。 */
export function toolCat(tool: string): ToolCat {
  const t = tool.toLowerCase();
  const is = (...names: string[]) =>
    names.some((n) => t === n || t.startsWith(n + "(") || t.startsWith(n + ":"));
  if (is("read", "grep", "glob", "ls", "view", "search", "todowrite", "todoread", "websearch", "webfetch"))
    return "read";
  if (is("edit", "write", "multiedit", "notebookedit", "apply_patch", "patch", "save", "create"))
    return "write";
  if (is("bash", "shell", "powershell", "cmd", "exec") || t.startsWith("mcp:")) return "exec";
  if (is("task", "agent", "dispatch", "fork")) return "spawn";
  return "other";
}

export const CAT_COLORS: Record<ToolCat, string> = {
  read: "#06b6d4",
  write: "var(--mx-accent)",
  exec: "#8b5cf6",
  spawn: "#10b981",
  other: "var(--mx-muted)",
};

/** 工具名分色(微条/拍流/图表/引擎彗星共口径)。 */
export function toolColor(tool: string): string {
  return CAT_COLORS[toolCat(tool)];
}

/** XP 权重:动手比动眼值钱,派生(子任务)最值钱。 */
export function beatWeight(tool: string): number {
  switch (toolCat(tool)) {
    case "write":
      return 2;
    case "exec":
      return 2;
    case "spawn":
      return 3;
    default:
      return 1;
  }
}
