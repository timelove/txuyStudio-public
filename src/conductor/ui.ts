/**
 * Conductor 面板共享小件(避免 Shell ↔ Panel 循环 import,独立成无依赖模块)。
 */

/** 相对时间(刚刚 / N 分钟前 / N 小时前 / N 天前;i18next 插值)。 */
export function relativeTime(ms: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("conductor.time.justNow");
  if (diff < 3_600_000) return t("conductor.time.minutesAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("conductor.time.hoursAgo", { n: Math.floor(diff / 3_600_000) });
  return t("conductor.time.daysAgo", { n: Math.floor(diff / 86_400_000) });
}

/** 到点倒计时(还有 N 分钟 / N 小时;i18next 插值)。循环任务的「下次执行」。 */
export function countdown(ms: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = ms - Date.now();
  if (diff <= 0) return t("conductor.time.justNow");
  if (diff < 3_600_000) return t("conductor.time.inMinutes", { n: Math.max(1, Math.floor(diff / 60_000)) });
  return t("conductor.time.inHours", { n: Math.floor(diff / 3_600_000) });
}

/** 时刻串(HH:mm,本地)。循环「下次 14:32」。 */
export function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 卡片时刻(2026-11-16 用户:「决策流加上时间」):同天 HH:MM,跨天 M/D HH:MM;
 *  绝对时刻一眼可见,完整日期时间交给 hover title(toLocaleString)。 */
export function stampOf(ms: number): string {
  const d = new Date(ms);
  const clock = clockOf(ms);
  return d.toDateString() === new Date().toDateString() ? clock : `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}
