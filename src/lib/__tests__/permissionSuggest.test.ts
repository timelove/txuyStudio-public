// BaoCode P0.5 — permissionSuggest 单元测试
// 跑法(项目根):
//   bun test src/lib/__tests__/permissionSuggest.test.ts

import { describe, expect, it } from "bun:test";
import { deriveAlwaysAllowLabel } from "../permissionSuggest";

describe("deriveAlwaysAllowLabel — 写类工具", () => {
  it("Bash → '总是允许 Bash'(label=Bash 兜底)", () => {
    expect(deriveAlwaysAllowLabel("Bash", "Bash")).toBe("总是允许 Bash");
  });
  it("Write → '总是允许 写入文件'", () => {
    expect(deriveAlwaysAllowLabel("Write", "Write")).toBe("总是允许 写入文件");
  });
  it("Edit → '总是允许 编辑文件'", () => {
    expect(deriveAlwaysAllowLabel("Edit", "Edit")).toBe("总是允许 编辑文件");
  });
  it("MultiEdit → '总是允许 批量编辑'", () => {
    expect(deriveAlwaysAllowLabel("MultiEdit", "MultiEdit")).toBe("总是允许 批量编辑");
  });
  it("NotebookEdit → '总是允许 编辑 Notebook'", () => {
    expect(deriveAlwaysAllowLabel("NotebookEdit", "NotebookEdit")).toBe("总是允许 编辑 Notebook");
  });
  it("NotebookCell → '总是允许 执行单元格'", () => {
    expect(deriveAlwaysAllowLabel("NotebookCell", "NotebookCell")).toBe("总是允许 执行单元格");
  });
});

describe("deriveAlwaysAllowLabel — 只读类工具", () => {
  it("Read → null(降级到 i18n 通用)", () => {
    expect(deriveAlwaysAllowLabel("Read", "Read")).toBeNull();
  });
  it("Glob → null", () => {
    expect(deriveAlwaysAllowLabel("Glob", "Glob")).toBeNull();
  });
  it("Grep → null", () => {
    expect(deriveAlwaysAllowLabel("Grep", "Grep")).toBeNull();
  });
  it("WebSearch → null", () => {
    expect(deriveAlwaysAllowLabel("WebSearch", "WebSearch")).toBeNull();
  });
  it("WebFetch → null", () => {
    expect(deriveAlwaysAllowLabel("WebFetch", "WebFetch")).toBeNull();
  });
});

describe("deriveAlwaysAllowLabel — 未知工具", () => {
  it("MCP 工具 (mcp__server__tool) → 用 config.label", () => {
    expect(deriveAlwaysAllowLabel("mcp__server__tool", "查询天气")).toBe("总是允许 查询天气");
  });
  it("未知工具 + 空 label → null(降级)", () => {
    expect(deriveAlwaysAllowLabel("unknown_tool", "")).toBeNull();
    expect(deriveAlwaysAllowLabel("unknown_tool", undefined)).toBeNull();
  });
  it("未知工具 + 纯空白 label → null", () => {
    expect(deriveAlwaysAllowLabel("unknown_tool", "   ")).toBeNull();
  });
  it("label 前后空白 trim", () => {
    expect(deriveAlwaysAllowLabel("CustomTool", "  我的工具  ")).toBe("总是允许 我的工具");
  });
});

describe("deriveAlwaysAllowLabel — 鲁棒性", () => {
  it("空 toolName → null(走 label 兜底)", () => {
    expect(deriveAlwaysAllowLabel("", "X")).toBe("总是允许 X");
    expect(deriveAlwaysAllowLabel("", "")).toBeNull();
  });
});
