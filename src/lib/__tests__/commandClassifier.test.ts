// BaoCode P0.3 — commandClassifier 单元测试
// 跑法: bun test src/lib/__tests__/commandClassifier.test.ts

import { describe, expect, it } from "bun:test";
import { classifyCommand } from "../commandClassifier";

describe("classifyCommand — read", () => {
  it("简单 cat/head/tail/nl/bat/less 归 read", () => {
    expect(classifyCommand("cat foo")).toBe("read");
    expect(classifyCommand("head -n 5 foo")).toBe("read");
    expect(classifyCommand("tail -f foo")).toBe("read");
    expect(classifyCommand("nl foo")).toBe("read");
    expect(classifyCommand("bat foo")).toBe("read");
    expect(classifyCommand("less foo")).toBe("read");
  });
  it("'cd ... && cat foo' → cd 剥离 → read", () => {
    expect(classifyCommand("cd /tmp && cat foo")).toBe("read");
    expect(classifyCommand("cd /some/long/path  &&  head foo")).toBe("read");
  });
  it("'cat foo 2>&1' / '... 2>/dev/null' → 错误流剥离 → read", () => {
    expect(classifyCommand("cat foo 2>&1")).toBe("read");
    expect(classifyCommand("grep x foo 2>/dev/null")).toBe("search");
  });
  it("sed -n 单读情境 → read", () => {
    expect(classifyCommand("sed -n '1,5p' foo")).toBe("read");
    expect(classifyCommand("sed -nE 's/x/y/p' foo")).toBe("read");
  });
});

describe("classifyCommand — search", () => {
  it("grep 系列", () => {
    expect(classifyCommand("grep x foo")).toBe("search");
    expect(classifyCommand("egrep x foo")).toBe("search");
    expect(classifyCommand("rg \"x\"")).toBe("search");
    expect(classifyCommand("ag 'x'")).toBe("search");
  });
  it("find / fd 系列", () => {
    expect(classifyCommand("find . -name \"*.ts\"")).toBe("search");
    expect(classifyCommand("fd README")).toBe("search");
  });
});

describe("classifyCommand — list", () => {
  it("ls / tree 系列", () => {
    expect(classifyCommand("ls")).toBe("list");
    expect(classifyCommand("ls -la")).toBe("list");
    expect(classifyCommand("tree -L 2")).toBe("list");
  });
});

describe("classifyCommand — run(chained / pipeline / redirect / unknown)", () => {
  it("含 ; 链 → run", () => {
    expect(classifyCommand("ls; ls; ls")).toBe("run");
  });
  it("含 && 链 → run", () => {
    expect(classifyCommand("cat foo && echo done")).toBe("run");
  });
  it("含 || 链 → run", () => {
    expect(classifyCommand("cat foo || echo fail")).toBe("run");
  });
  it("单 | pipeline → run(baocode 原文只判 ||,我们扩判单 |)", () => {
    expect(classifyCommand("cat foo | grep x")).toBe("run");
  });
  it("含 > 重定向 → run", () => {
    expect(classifyCommand("cat foo > bar")).toBe("run");
    expect(classifyCommand("echo x > out")).toBe("run");
  });
  it("含换行 → run", () => {
    expect(classifyCommand("cat foo\necho done")).toBe("run");
  });
  it("sed -i 含 → run(原地编辑)", () => {
    expect(classifyCommand("sed -i 's/x/y/' foo")).toBe("run");
    expect(classifyCommand("sed -inE 's/x/y/' foo")).toBe("run"); // -i 复合参数
  });
  it("sed -nE -i 复合 → run", () => {
    expect(classifyCommand("sed -nEi 's/x/y/' foo")).toBe("run");
  });
  it("未知命令 → run(npm/git/echo 等)", () => {
    expect(classifyCommand("git status")).toBe("run");
    expect(classifyCommand("npm run build")).toBe("run");
    expect(classifyCommand("echo \"hello\"")).toBe("run");
    expect(classifyCommand("python script.py")).toBe("run");
  });
  it("trim 后空 → run", () => {
    expect(classifyCommand("")).toBe("run");
    expect(classifyCommand("   ")).toBe("run");
  });
});

describe("classifyCommand — 边界鲁棒性", () => {
  it("'cd dir && cat foo' 复合 + cd 剥离优先级", () => {
    expect(classifyCommand("cd /tmp && cat foo 2>&1")).toBe("read");
  });
  it("多空格 / 制表符 / 前后空格", () => {
    expect(classifyCommand("   cat    foo   ")).toBe("read");
    expect(classifyCommand("cat\tfoo")).toBe("read");
  });
  it("非 string 输入 → run", () => {
    // @ts-expect-error 测 runtime 兜底
    expect(classifyCommand(null)).toBe("run");
    // @ts-expect-error
    expect(classifyCommand(undefined)).toBe("run");
    // @ts-expect-error
    expect(classifyCommand(42)).toBe("run");
  });
});
