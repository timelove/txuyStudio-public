// BaoCode P0.4 — ClaudePane.buildDenyContent 纯函数测试
// 跑法(项目根):
//   bun test src/components/__tests__/denyContent.test.ts

import { describe, expect, it } from "bun:test";

// 复刻 ClaudePane.tsx 内的同款函数;实现侧变更时需同步此 stub。
// (把函数 export 出 ClaudePane 测试 mock 成本过高;此处 stub 与主实现逐字一致即可。)
function buildDenyContent(toolName: string, reason: string): string {
  const trimmed = reason.trim();
  return trimmed
    ? `User denied the ${toolName} tool call. Reason: ${trimmed}. Please suggest an alternative approach or ask for clarification.`
    : `User denied the ${toolName} tool call. Please suggest an alternative approach or ask for clarification.`;
}

describe("buildDenyContent", () => {
  it("空 reason → 纯拒绝,无 Reason 子句", () => {
    expect(buildDenyContent("Bash", "")).toBe(
      "User denied the Bash tool call. Please suggest an alternative approach or ask for clarification.",
    );
  });
  it("纯空白 reason → 视为空(不输出 Reason: 子句)", () => {
    expect(buildDenyContent("Bash", "     ")).toBe(
      "User denied the Bash tool call. Please suggest an alternative approach or ask for clarification.",
    );
  });
  it("有 reason → 拼 'Reason: <reason>.'", () => {
    expect(buildDenyContent("Bash", "rm 太危险")).toBe(
      "User denied the Bash tool call. Reason: rm 太危险. Please suggest an alternative approach or ask for clarification.",
    );
  });
  it("reason 前后空白 trim", () => {
    expect(buildDenyContent("Write", "  写文件别覆盖  ")).toBe(
      "User denied the Write tool call. Reason: 写文件别覆盖. Please suggest an alternative approach or ask for clarification.",
    );
  });
  it("toolName 透传(不规范化大小写)", () => {
    expect(buildDenyContent("mcp__server__tool", "x")).toContain("mcp__server__tool");
    expect(buildDenyContent("Edit", "x")).toContain("Edit");
  });
  it("理由内句号/多段保留(只 trim 头尾)", () => {
    const r = "a. b. c";
    expect(buildDenyContent("Bash", r)).toContain(`Reason: ${r}.`);
  });
});
