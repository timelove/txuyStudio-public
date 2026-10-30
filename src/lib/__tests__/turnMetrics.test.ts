// BaoCode P0.2 — turnMetrics 单元测试
// 跑法(项目根):
//   bun test src/lib/__tests__/turnMetrics.test.ts

import { describe, expect, it } from "bun:test";
import { formatCost, formatDuration, formatTokens, formatTokensPerSecond } from "../turnMetrics";

describe("formatTokens", () => {
  it("0/负/NaN → '0' 兜底", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-1)).toBe("0");
    expect(formatTokens(NaN)).toBe("0");
  });
  it("< 1k → 原数(int)", () => {
    expect(formatTokens(14)).toBe("14");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12.4)).toBe("12"); // Math.round
  });
  it("1k ~ 999_999 → 'k' 一位小数(.0 trim)", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1918)).toBe("1.9k");
    expect(formatTokens(26_112)).toBe("26.1k");
    expect(formatTokens(200_000)).toBe("200k"); // .0 trim
    expect(formatTokens(950)).toBe("950"); // < 1k 不变
  });
  it(">= 1M → 'm'", () => {
    expect(formatTokens(1_000_000)).toBe("1m");
    expect(formatTokens(1_400_000)).toBe("1.4m");
    expect(formatTokens(13_000_000)).toBe("13m");
  });
});

describe("formatCost", () => {
  it("null/undefined/NaN/0/负 → '—'(兼容现有状态栏语义)", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(undefined)).toBe("—");
    expect(formatCost(0)).toBe("—");
    expect(formatCost(-1)).toBe("—");
    expect(formatCost(NaN)).toBe("—");
    expect(formatCost(Infinity)).toBe("—");
  });
  it(">= 1 → 2 位小数", () => {
    expect(formatCost(1)).toBe("$1.00");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(42.5)).toBe("$42.50");
  });
  it("$0.01 ~ $0.99 → 2 位小数(baocode 一致)", () => {
    expect(formatCost(0.42)).toBe("$0.42");
    expect(formatCost(0.05)).toBe("$0.05");
    expect(formatCost(0.01)).toBe("$0.01"); // 边界
  });
  it("< $0.01 自适应(2-5 位,封顶 5 位)", () => {
    // 0.0031 → 首个非 0 在第 4 位 → 4 位小数
    expect(formatCost(0.0031)).toBe("$0.0031");
    // 0.00314 → 5 位(刚好够)
    expect(formatCost(0.00314)).toBe("$0.00314");
    // 0.000314 → 5 位 cap(原始需要 6 位 → "$0.000314",但 cap=5 → "$0.00031")
    expect(formatCost(0.000314)).toBe("$0.00031");
    // 0.0000314 → cap 5 → 末 4 round
    expect(formatCost(0.0000314)).toBe("$0.00003");
  });
  it("$0.999 自适应 3 位(baocode 风格保留精度)", () => {
    // 0.999 最后一个非零在第 3 位 → "$0.999"(不到 1 不进位,与 0.999.toFixed(3) 一致)
    expect(formatCost(0.999)).toBe("$0.999");
  });
});

describe("formatDuration", () => {
  it("无效输入 → '0s'", () => {
    expect(formatDuration(NaN)).toBe("0s");
    expect(formatDuration(-100)).toBe("0s");
  });
  it("< 60s '46s'(59s 仍秒级)", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(46_000)).toBe("46s");
    expect(formatDuration(59_000)).toBe("59s"); // 边界:仍秒级
  });
  it("59.5s round 到 60s → 进 1m 分支", () => {
    expect(formatDuration(59_500)).toBe("1m 0s");
  });
  it("60s ~ 3599s '2m 14s'", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(2 * 60_000 + 14_000)).toBe("2m 14s");
    expect(formatDuration(59 * 60_000 + 30_000)).toBe("59m 30s");
  });
  it(">= 1h '1h 5m'", () => {
    expect(formatDuration(3600_000)).toBe("1h 0m");
    expect(formatDuration(3600_000 + 5 * 60_000)).toBe("1h 5m");
    expect(formatDuration(2 * 3600_000 + 30 * 60_000)).toBe("2h 30m");
  });
  it("l10n 透传键值(翻译路径)", () => {
    const l10n = (k: string, params?: Record<string, unknown>): string => {
      if (k === "turn.seconds") return `${params?.n} 秒`;
      if (k === "turn.minutesSeconds") return `${params?.m} 分 ${params?.s} 秒`;
      if (k === "turn.hoursMinutes") return `${params?.h} 小时 ${params?.m} 分`;
      return k;
    };
    expect(formatDuration(46_000, l10n)).toBe("46 秒");
    expect(formatDuration(2 * 60_000 + 14_000, l10n)).toBe("2 分 14 秒");
    expect(formatDuration(3600_000 + 5 * 60_000, l10n)).toBe("1 小时 5 分");
  });
});

describe("formatTokensPerSecond", () => {
  it("null/undefined 退化 '—'", () => {
    expect(formatTokensPerSecond(null, 1000)).toBe("—");
    expect(formatTokensPerSecond(100, undefined)).toBe("—");
    expect(formatTokensPerSecond(undefined, undefined)).toBe("—");
  });
  it("durationMs ≤ 0 → '—'(避除零)", () => {
    expect(formatTokensPerSecond(100, 0)).toBe("—");
    expect(formatTokensPerSecond(100, -1)).toBe("—");
  });
  it("output 0/负 → '—'", () => {
    expect(formatTokensPerSecond(0, 1000)).toBe("—");
    expect(formatTokensPerSecond(-1, 1000)).toBe("—");
  });
  it("正常值 → 整数 tps(round)", () => {
    expect(formatTokensPerSecond(120, 1000)).toBe("120");
    expect(formatTokensPerSecond(601, 1000)).toBe("601");
    expect(formatTokensPerSecond(1500, 1000)).toBe("1500");
    expect(formatTokensPerSecond(12, 2000)).toBe("6"); // 12 tokens / 2s
  });
  it("四舍五入到整数", () => {
    expect(formatTokensPerSecond(99, 2000)).toBe("50"); // 49.5 → 50 (banker's? JS: 50)
    expect(formatTokensPerSecond(101, 2000)).toBe("51"); // 50.5 → 51
  });
});
