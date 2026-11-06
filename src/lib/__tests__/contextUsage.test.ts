// BaoCode 借鉴 — contextUsage 单元测试
// 跑法:bun test src/lib/__tests__/contextUsage.test.ts
import { describe, expect, it } from "bun:test";
import type { ClaudeUsage } from "../../domain/claudeStream";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  buildContextTooltip,
  deriveContextBreakdown,
  deriveContextUsage,
  deriveContextUsed,
  usableContextWindow,
} from "../contextUsage";
import { normalizeContextUsage } from "../../domain/claudeStream";

const noopFmt = (n: number) => `${n}`;

describe("deriveContextUsed", () => {
  it("undefined / null → 0", () => {
    expect(deriveContextUsed(undefined)).toBe(0);
    expect(deriveContextUsed(null)).toBe(0);
  });
  it("只 input → input", () => {
    expect(deriveContextUsed({ input_tokens: 100 })).toBe(100);
  });
  it("input + cache_creation + cache_read 三段加和", () => {
    expect(
      deriveContextUsed({ input_tokens: 50, cache_creation_input_tokens: 30, cache_read_input_tokens: 20 }),
    ).toBe(100);
  });
  it("0 字段也参与加和(不应忽略)", () => {
    expect(deriveContextUsed({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toBe(0);
    expect(deriveContextUsed({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toBe(10);
  });
});

describe("deriveContextBreakdown", () => {
  it("空 usage → 全 0", () => {
    expect(deriveContextBreakdown(undefined)).toEqual({ input: 0, cacheCreation: 0, cacheRead: 0 });
  });
  it("正常 usage → 拆 3 段", () => {
    expect(
      deriveContextBreakdown({ input_tokens: 50, cache_creation_input_tokens: 30, cache_read_input_tokens: 20 }),
    ).toEqual({ input: 50, cacheCreation: 30, cacheRead: 20 });
  });
});

describe("deriveContextUsage", () => {
  it("usage 缺失 → null", () => {
    expect(deriveContextUsage(undefined, 200_000)).toBeNull();
  });
  it("window=0 → null(防 0 除)", () => {
    expect(deriveContextUsage({ input_tokens: 100 }, 0)).toBeNull();
  });
  it("used=0 → null(无 token 不显示)", () => {
    expect(deriveContextUsage({ input_tokens: 0 }, 200_000)).toBeNull();
  });
  it("正常 → 返回 { used, window, buffer, free, pct, breakdown },pct 分母 = window − buffer", () => {
    const info = deriveContextUsage({ input_tokens: 50_000, cache_read_input_tokens: 30_000 }, 200_000);
    expect(info).not.toBeNull();
    expect(info!.used).toBe(80_000);
    expect(info!.window).toBe(200_000);
    expect(info!.buffer).toBe(33_000);
    expect(info!.free).toBe(200_000 - 33_000 - 80_000);
    // 80_000 / 167_000 = 47.9%(此前按原始窗口算 40%,偏乐观)。
    expect(info!.pct).toBeCloseTo(47.904, 2);
    expect(info!.breakdown).toEqual({ input: 50_000, cacheCreation: 0, cacheRead: 30_000 });
  });
  it("pct cap 100(超可用窗口仍 cap,UI 显示满)", () => {
    const info = deriveContextUsage({ input_tokens: 250_000 }, 200_000);
    expect(info!.pct).toBe(100);
  });
});

describe("usableContextWindow / autocompact buffer", () => {
  it("200k 窗口 → 可用 167k(buffer 33k)", () => {
    expect(usableContextWindow(200_000)).toBe(167_000);
    expect(AUTOCOMPACT_BUFFER_TOKENS).toBe(33_000);
  });
  it("buffer 不超过窗口本身(小窗口不吃负)", () => {
    expect(usableContextWindow(10_000)).toBe(1);
    expect(usableContextWindow(33_000)).toBe(1);
  });
  it("buffer 随窗口收缩(窗口 < buffer 时 buffer = window)", () => {
    expect(deriveContextUsage({ input_tokens: 5_000 }, 10_000)!.buffer).toBe(10_000);
  });
});

describe("buildContextTooltip", () => {
  it("只 main input → 单段", () => {
    const info = deriveContextUsage({ input_tokens: 1000 }, 200_000)!;
    expect(buildContextTooltip(info, noopFmt)).toBe("1000 main input");
  });
  it("input + cache write → 2 段", () => {
    const info = deriveContextUsage(
      { input_tokens: 1000, cache_creation_input_tokens: 500 },
      200_000,
    )!;
    expect(buildContextTooltip(info, noopFmt)).toBe("1000 main input · 500 cache write");
  });
  it("input + cache hit → 2 段", () => {
    const info = deriveContextUsage(
      { input_tokens: 1000, cache_read_input_tokens: 300 },
      200_000,
    )!;
    expect(buildContextTooltip(info, noopFmt)).toBe("1000 main input · 300 cache hit");
  });
  it("input + write + hit → 3 段全显", () => {
    const info = deriveContextUsage(
      { input_tokens: 1000, cache_creation_input_tokens: 500, cache_read_input_tokens: 300 },
      200_000,
    )!;
    expect(buildContextTooltip(info, noopFmt)).toBe(
      "1000 main input · 500 cache write · 300 cache hit",
    );
  });
  it("cache write = 0 时不出现该段", () => {
    const info = deriveContextUsage(
      { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
      200_000,
    )!;
    expect(buildContextTooltip(info, noopFmt)).toBe("1000 main input · 100 cache hit");
  });
});

describe("normalizeContextUsage(P2:get_context_usage 回包归一)", () => {
  it("spike 实测形态(categories kind 三档 + autoCompactThreshold)→ 全字段保留", () => {
    const u = normalizeContextUsage({
      totalTokens: 38471,
      maxTokens: 272000,
      autoCompactThreshold: 239000,
      categories: [
        { name: "System prompt", tokens: 2074, kind: "used" },
        { name: "Autocompact buffer", tokens: 33000, kind: "buffer" },
        { name: "Free space", tokens: 200529, kind: "free" },
      ],
    });
    expect(u!.totalTokens).toBe(38471);
    expect(u!.maxTokens).toBe(272000);
    expect(u!.autoCompactThreshold).toBe(239000);
    expect(u!.categories).toHaveLength(3);
    expect(u!.categories[0]).toEqual({ name: "System prompt", tokens: 2074, kind: "used" });
  });
  it("null / 非对象 / 全 0 → null(不进 meta)", () => {
    expect(normalizeContextUsage(null)).toBeNull();
    expect(normalizeContextUsage(undefined)).toBeNull();
    expect(normalizeContextUsage({})).toBeNull();
    expect(normalizeContextUsage({ totalTokens: 0, maxTokens: 0 })).toBeNull();
  });
  it("字段缺失逐项兜底(totalTokens 缺失但 maxTokens>0 仍有效)", () => {
    const u = normalizeContextUsage({ maxTokens: 200000 });
    expect(u).not.toBeNull();
    expect(u!.totalTokens).toBe(0);
    expect(u!.maxTokens).toBe(200000);
    expect(u!.autoCompactThreshold).toBeUndefined();
    expect(u!.categories).toEqual([]);
  });
  it("categories 项字段缺失逐项兜底(坏项过滤)", () => {
    const u = normalizeContextUsage({
      totalTokens: 10,
      categories: [{ name: "X" }, null, "bad", { name: "Y", tokens: "3", kind: 7 }],
    });
    expect(u!.categories).toHaveLength(2);
    expect(u!.categories[1]).toEqual({ name: "Y", tokens: 0, kind: "used" });
  });
});
