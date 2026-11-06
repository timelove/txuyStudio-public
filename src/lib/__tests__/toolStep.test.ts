// BaoCode 借鉴 — toolStep 单元测试
// 跑法:bun test src/lib/__tests__/toolStep.test.ts
import { describe, expect, it } from "bun:test";
import {
  oneLine,
  toolStepDetail,
  toolStepKind,
  toolStepObject,
  toolStepTitle,
  toolStepVerbKey,
} from "../toolStep";

describe("toolStepKind", () => {
  it("已知工具归类", () => {
    expect(toolStepKind("Read")).toBe("read");
    expect(toolStepKind("Grep")).toBe("search");
    expect(toolStepKind("Glob")).toBe("search");
    expect(toolStepKind("LS")).toBe("list");
    expect(toolStepKind("Edit")).toBe("edit");
    expect(toolStepKind("MultiEdit")).toBe("edit");
    expect(toolStepKind("Write")).toBe("edit");
    expect(toolStepKind("Bash")).toBe("command");
    expect(toolStepKind("WebFetch")).toBe("web");
    expect(toolStepKind("Task")).toBe("agent");
    expect(toolStepKind("TodoWrite")).toBe("todo");
    expect(toolStepKind("ExitPlanMode")).toBe("plan");
  });
  it("mcp__ 前缀 → mcp", () => {
    expect(toolStepKind("mcp__github__list_issues")).toBe("mcp");
  });
  it("未知工具 → other", () => {
    expect(toolStepKind("SomeNewTool")).toBe("other");
  });
});

describe("toolStepVerbKey", () => {
  it("进行中用 -ing key,其余用完成时 key", () => {
    expect(toolStepVerbKey("Read", "running")).toBe("toolStep.reading");
    expect(toolStepVerbKey("Read", "completed")).toBe("toolStep.read");
    expect(toolStepVerbKey("Read", "error")).toBe("toolStep.read");
    expect(toolStepVerbKey("Read", "denied")).toBe("toolStep.read");
  });
  it("command 归类映射到 running/ran", () => {
    expect(toolStepVerbKey("Bash", "running")).toBe("toolStep.running");
    expect(toolStepVerbKey("Bash", "completed")).toBe("toolStep.ran");
  });
  it("mcp / agent 不区分状态", () => {
    expect(toolStepVerbKey("mcp__x__y", "running")).toBe("toolStep.mcp");
    expect(toolStepVerbKey("mcp__x__y", "completed")).toBe("toolStep.mcp");
    expect(toolStepVerbKey("Task", "running")).toBe("toolStep.agent");
  });
});

describe("toolStepObject", () => {
  it("Read 取 basename(不是全路径)", () => {
    expect(toolStepObject("Read", { file_path: "D:\\work\\a\\b\\main.dart" })).toBe("main.dart");
  });
  it("Edit/Write 取 basename", () => {
    expect(toolStepObject("Edit", { file_path: "/home/u/src/app.ts" })).toBe("app.ts");
    expect(toolStepObject("Write", { file_path: "/home/u/src/new.ts" })).toBe("new.ts");
  });
  it("Grep 把 in 路径并进目标", () => {
    expect(toolStepObject("Grep", { pattern: "useEffect", path: "/a/b/src" })).toBe("useEffect in src");
  });
  it("Glob 只有 pattern", () => {
    expect(toolStepObject("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });
  it("Bash 取命令原文", () => {
    expect(toolStepObject("Bash", { command: "bun test" })).toBe("bun test");
  });
  it("WebFetch 取 url、WebSearch 取 query", () => {
    expect(toolStepObject("WebFetch", { url: "https://x.dev/a" })).toBe("https://x.dev/a");
    expect(toolStepObject("WebSearch", { query: "vite 7 watch" })).toBe("vite 7 watch");
  });
  it("Task 取 description", () => {
    expect(toolStepObject("Task", { description: "Find the router" })).toBe("Find the router");
  });
  it("mcp 把 __ 拆成 ·", () => {
    expect(toolStepObject("mcp__github__list_issues", {})).toBe("github · list_issues");
  });
  it("TodoWrite 取条数", () => {
    expect(toolStepObject("TodoWrite", { todos: [{}, {}, {}] })).toBe("3");
  });
  it("未知工具取 input 里第一个非空字符串字段", () => {
    expect(toolStepObject("WeirdTool", { a: 1, b: "hello", c: "x" })).toBe("hello");
  });
  it("input 缺失 / 非对象 → 空串(不抛)", () => {
    expect(toolStepObject("Read", null)).toBe("");
    expect(toolStepObject("Bash", undefined)).toBe("");
    expect(toolStepObject("WeirdTool", 42)).toBe("");
  });
  it("命令里的换行被压成单行", () => {
    expect(toolStepObject("Bash", { command: "cd a\nbun test" })).toBe("cd a bun test");
  });
});

describe("toolStepDetail", () => {
  it("Read 的 offset/limit → L 区间", () => {
    expect(toolStepDetail("Read", { offset: 10, limit: 41 })).toBe("L10-50");
  });
  it("Read 只有 offset → 开区间", () => {
    expect(toolStepDetail("Read", { offset: 10 })).toBe("L10-");
  });
  it("Read 只有 limit → 从 1 起", () => {
    expect(toolStepDetail("Read", { limit: 40 })).toBe("L1-40");
  });
  it("Read 无 offset/limit → null", () => {
    expect(toolStepDetail("Read", { file_path: "a.ts" })).toBeNull();
  });
  it("Grep 的 glob / type", () => {
    expect(toolStepDetail("Grep", { pattern: "x", glob: "*.ts" })).toBe("*.ts");
    expect(toolStepDetail("Grep", { pattern: "x", type: "rust" })).toBe("*.rust");
  });
  it("Bash 取 description", () => {
    expect(toolStepDetail("Bash", { command: "bun test", description: "Run tests" })).toBe("Run tests");
  });
  it("Task 取 subagent_type", () => {
    expect(toolStepDetail("Task", { description: "d", subagent_type: "Explore" })).toBe("Explore");
  });
  it("TodoWrite 取 完成/总数", () => {
    expect(
      toolStepDetail("TodoWrite", { todos: [{ status: "completed" }, { status: "pending" }] }),
    ).toBe("1/2");
  });
  it("其余工具 → null", () => {
    expect(toolStepDetail("Edit", { file_path: "a.ts" })).toBeNull();
    expect(toolStepDetail("mcp__x__y", {})).toBeNull();
  });
});

describe("toolStepTitle", () => {
  it("Read/Edit 给全路径(供 hover)", () => {
    expect(toolStepTitle("Read", { file_path: "D:\\a\\b.ts" })).toBe("D:\\a\\b.ts");
    expect(toolStepTitle("Edit", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
  });
  it("非文件类 → null", () => {
    expect(toolStepTitle("Bash", { command: "ls" })).toBeNull();
    expect(toolStepTitle("Grep", { pattern: "x" })).toBeNull();
  });
});

describe("oneLine", () => {
  it("压平空白", () => {
    expect(oneLine("  a \n\t b  ")).toBe("a b");
  });
  it("超长截断加省略号", () => {
    const out = oneLine("x".repeat(200), 20);
    expect(out.length).toBe(20);
    expect(out.endsWith("…")).toBe(true);
  });
  it("未超长原样", () => {
    expect(oneLine("short", 20)).toBe("short");
  });
});
