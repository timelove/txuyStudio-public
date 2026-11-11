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
  it("fuzzy 子序列命中 + 不匹配项过滤(basename 连续命中优先)", () => {
    const r = rankMentionCandidates(
      ["src/components/Button.tsx", "test/button.test.ts", "src/lib/foo.ts"],
      "but",
    );
    // button 两项命中(foo.ts 无 b/u 子序列,不显示);Button.tsx 路径短排前
    expect(r).toEqual(["src/components/Button.tsx", "test/button.test.ts"]);
  });
  it("缩写子序列:'usc' 命中 userCard.tsx(2026-11-11 fuzzy 升级的动机)", () => {
    const r = rankMentionCandidates(
      ["src/components/userCard.tsx", "src/lib/util.ts", "src/store/cart.ts"],
      "usc",
    );
    expect(r).toContain("src/components/userCard.tsx");
    expect(r[0]).toBe("src/components/userCard.tsx");
    // util.ts 无 c、cart.ts 无 u —— 都不该出现
    expect(r).not.toContain("src/lib/util.ts");
    expect(r).not.toContain("src/store/cart.ts");
  });
  it("纯名字 query 只看文件名:目录段 incidental 命中不算数(2026-11-11 二次升级)", () => {
    const r = rankMentionCandidates(
      ["docs/usc/index.md", "src/components/userCard.tsx"],
      "usc",
    );
    // index.md 文件名不含 u/c 子序列——目录里的 usc 不应把它带进来
    expect(r).toEqual(["src/components/userCard.tsx"]);
  });
  it("带分隔符的 query 走整条 path 匹配(搜目录+文件名)", () => {
    const r = rankMentionCandidates(
      ["src/components/Button.tsx", "docs/readme.md"],
      "src/bu",
    );
    // readme.md 路径无 s..r..c 顺序子序列 —— 不命中
    expect(r).toEqual(["src/components/Button.tsx"]);
  });
  it("大小写不敏感", () => {
    const r = rankMentionCandidates(["Readme.md", "readme-old.md", "test.ts"], "Read");
    expect(r[0]).toBe("Readme.md");
  });
  it("无匹配 → 原序兜底(一个不中显示全部)", () => {
    const r = rankMentionCandidates(["a.ts", "b.ts"], "xyz");
    expect(r).toEqual(["a.ts", "b.ts"]);
  });
});
