// BaoCode P0.2 借鉴 — Turn 指标格式化
//
// 借鉴:[BaoCode `turn_footer.dart`](https://github.com/baocode-dev/baocode) 三件套:
// - speed (tps):tokens per second
// - tokens (in/out)
// - duration:46s / 2m 14s / 1h 5m(按量级)
// - cost:$0.42 / $0.0031 / $0.00031(按量级自适应小数,2-5 位)

/** token 数格式化:<1k 显原数、1k–1M 显 k、≥1M 显 m;末尾 .0 trim。 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${parseFloat((n / 1000).toFixed(1))}k`;
  return `${parseFloat((n / 1_000_000).toFixed(1))}m`;
}

/**
 * 美元成本格式化(baocode 风格,按数值量级选小数位 2~5):
 * - null/undefined/NaN/非正 → "$0"
 * - >= 1 → $1.50 (2 位)
 * - 0 < usd < 1 → 自适应:从 usd.toString() 短表示里取最后一个非零小数位的下标 +1,封顶 5,最少 2
 *   0.42   → "$0.42";0.0031 → "$0.0031";0.00314 → "$0.00314";
 *   0.000314 → "$0.00031"(cap 5,toFixed round);0.0000314 → "$0.00003"
 */
export function formatCost(usd?: number | null): string {
  // undefined / null / NaN / <= 0 → "—"(兼容 ClaudePane 现有"未知"语义)
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return "—";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  // 0 < usd < 1:JS 默认 toString 给短表示("0.42"/"0.0031"…),避免 0.42/0.1=4.1999999 浮点误差
  const s = usd.toString();
  const dot = s.indexOf(".");
  if (dot < 0) return `$${usd.toFixed(2)}`;
  const frac = s.slice(dot + 1);
  // 找最后非 0 的位置
  let lastNonZero = -1;
  for (let i = frac.length - 1; i >= 0; i--) {
    if (frac[i] !== "0") {
      lastNonZero = i;
      break;
    }
  }
  // lastNonZero = -1 表全 0(不可能到这里,前面 usd > 0)
  const digits = Math.min(5, Math.max(2, lastNonZero + 1));
  return `$${usd.toFixed(digits)}`;
}

/**
 * 时长格式化(baocode 风格):< 60s "46s";< 1h "2m 14s";≥ 1h "1h 5m"。
 *
 * `l10n?(key, params)` 可选 — 传 i18n.t 时使用 `turn.seconds`/`minutesSeconds`/`hoursMinutes`
 * 三个键,fallback 英文硬编码。
 */
const DEFAULT_SECONDS = (n: number) => `${n}s`;
const DEFAULT_MIN_SEC = (m: number, s: number) => `${m}m ${s}s`;
const DEFAULT_HOUR_MIN = (h: number, m: number) => `${h}h ${m}m`;

export function formatDuration(
  ms: number,
  l10n?: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return l10n ? l10n("turn.seconds", { n: totalSeconds }) : DEFAULT_SECONDS(totalSeconds);
  }
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return l10n
      ? l10n("turn.minutesSeconds", { m: minutes, s: seconds })
      : DEFAULT_MIN_SEC(minutes, seconds);
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return l10n ? l10n("turn.hoursMinutes", { h: hours, m: minutes }) : DEFAULT_HOUR_MIN(hours, minutes);
}

/** tokens/second(整数)。durationMs ≤ 0 或 outputTokens 缺/为 0 → "—" 退化。 */
export function formatTokensPerSecond(
  outputTokens: number | null | undefined,
  durationMs: number | null | undefined,
): string {
  if (typeof outputTokens !== "number" || typeof durationMs !== "number") return "—";
  if (durationMs <= 0 || !Number.isFinite(durationMs)) return "—";
  const tps = outputTokens / (durationMs / 1000);
  if (!Number.isFinite(tps) || tps <= 0) return "—";
  return String(Math.round(tps));
}
