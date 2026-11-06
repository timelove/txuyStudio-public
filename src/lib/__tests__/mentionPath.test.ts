// BaoCode P3.1 — @ mention 路径解析单测
// 跑法(项目根):
//   bun test src/lib/__tests__/mentionPath.test.ts

import { describe, expect, it } from "bun:test";
import { rankMentionCandidates, resolveMentionPath } from "../mentionPath";

describe("resolveMentionPath — home 模式", () => {
  it("'~' → home 根", () => {
    expect(resolveMentionPath("~", "/home/u", "/work")).toEqual({
      kind: "home",
      path: "/home/u",
      prefix: "~/",
    });
  });
  it("'~/projects/x' → /home/u/projects/x", () => {
    expect(resolveMentionPath("~/projects/x", "/home/u", "/work")).toEqual({
      kind: "home",
      path: "/home/u/projects/x",
      prefix: "~/projects/x",
    });
  });
  it("'~\\proj' (Windows home) → home 模式", () => {
    expect(resolveMentionPath("~\\proj", "C:\\Users\\u", "C:\\work")).toEqual({
      kind: "home",
      path: "C:\\Users\\u\\proj",
      prefix: "~/proj",
    });
  });
});

describe("resolveMentionPath — absolute 模式", () => {
  it("Windows 盘符 'C:\\\\proj' → absolute", () => {
    expect(resolveMentionPath("C:\\proj", "/h", "/w")).toEqual({
      kind: "absolute",
      path: "C:\\proj",
      prefix: "C:\\proj",
    });
  });
  it("POSIX 绝对 '/etc/hosts' → absolute", () => {
    expect(resolveMentionPath("/etc/hosts", "/h", "/w")).toEqual({
      kind: "absolute",
      path: "/etc/hosts",
      prefix: "/etc/hosts",
    });
  });
  it("小写盘符 'd:\\\\' → absolute", () => {
    expect(resolveMentionPath("d:\\", "/h", "/w").kind).toBe("absolute");
  });
});

describe("resolveMentionPath — workspace 模式", () => {
  it("'src/lib' → workspace", () => {
    const r = resolveMentionPath("src/lib", "/h", "/w");
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.path).toBe("/w/src/lib");
      expect(r.prefix).toBe("src/lib");
    }
  });
  it("'src\\\\lib' (Windows 反斜杠) → workspace,prefix 规范化", () => {
    const r = resolveMentionPath("src\\lib", "C:\\h", "C:\\w");
    expect(r.kind).toBe("workspace");
    if (r.kind === "workspace") {
      expect(r.prefix).toBe("src/lib");
    }
  });
});

describe("resolveMentionPath — empty", () => {
  it("'' → empty(刚 @ 还没输入)", () => {
    expect(resolveMentionPath("", "/h", "/w")).toEqual({ kind: "empty" });
  });
});

describe("rankMentionCandidates", () => {
  it("空 query → 按字母排", () => {
    expect(rankMentionCandidates(["zeta", "alpha", "Mu"], "")).toEqual(["Mu", "alpha", "zeta"]);
  });
  it("startsWith 优先,includes 次之", () => {
    const r = rankMentionCandidates(
      ["src/components/Button.tsx", "test/button.test.ts", "src/lib/foo.ts"],
      "but",
    );
    // "button" startsWith "but" 命中;test/button.test.ts includes "but" 命中;
    // src/lib/foo.ts 都不命中,保原序放在最后
    expect(r.slice(0, 2)).toContain("src/components/Button.tsx");
    expect(r[r.length - 1]).toBe("src/lib/foo.ts");
  });
  it("大小写不敏感", () => {
    const r = rankMentionCandidates(["Readme.md", "readme-old.md", "test.ts"], "Read");
    expect(r[0]).toBe("Readme.md");
  });
  it("无匹配 → 原序(只把 includes 的放后)", () => {
    const r = rankMentionCandidates(["a.ts", "b.ts"], "xyz");
    expect(r).toEqual(["a.ts", "b.ts"]);
  });
});
