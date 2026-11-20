/**
 * 会话工作目录 Context:对话 pane(claude/codex)在消息流根部注入当前 tab 的 cwd,
 * 消息渲染深处的 MdPreview / thinking 文本用 `useSessionCwd()` 自取——相对路径候选
 * 按 cwd 拼后端验证、reveal 落点都依赖它。Provider 之外(文件树/笔记等非会话语境)
 * 默认空串:仅绝对盘符路径可标,相对路径不解析。
 */
import { createContext, useContext } from "react";

export const SessionCwdContext = createContext<string>("");

export function useSessionCwd(): string {
  return useContext(SessionCwdContext);
}
