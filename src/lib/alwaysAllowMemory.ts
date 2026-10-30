// BaoCode P4.2 — Always Allow 智能决策记忆
//
// 借鉴:BaoCode 中「上次用户对这个 tool 怎么决定的」记忆(localStorage)。
// 我们这里:
//  - alwaysAllowMemory:从 localStorage 读 toolName 决策历史(allowOnce/allowAlways/deny + count)
//  - suggestAlwaysAllow:基于历史推荐"下次默认高亮哪行"
//  - recordAlwaysAllowDecision:写一条决策(供调用方在 onAnswer 后调)
//
// localStorage key:`mx.alwaysAllow.<toolName>` → JSON 字符串 { allowOnce: n, allowAlways: n, deny: n, lastDecision: 'allow'|'allowAlways'|'deny' }

export type AlwaysAllowDecision = "allowOnce" | "allowAlways" | "deny";
export type AlwaysAllowHistory = {
  allowOnce: number;
  allowAlways: number;
  deny: number;
  lastDecision: AlwaysAllowDecision | null;
};

export const EMPTY_HISTORY: AlwaysAllowHistory = {
  allowOnce: 0,
  allowAlways: 0,
  deny: 0,
  lastDecision: null,
};

const STORAGE_PREFIX = "mx.alwaysAllow.";

/** 读 history(从 storage 对象读;无 storage 或无 key → EMPTY_HISTORY)。
 *  storage 默认 globalThis.localStorage(浏览器内);Node/bun 测试可传 mock。 */
export function readAlwaysAllowHistory(
  toolName: string,
  storage: { getItem(k: string): string | null } | null = typeof localStorage !== "undefined" ? localStorage : null,
): AlwaysAllowHistory {
  if (!storage) return { ...EMPTY_HISTORY };
  try {
    const raw = storage.getItem(STORAGE_PREFIX + toolName);
    if (!raw) return { ...EMPTY_HISTORY };
    const parsed = JSON.parse(raw) as Partial<AlwaysAllowHistory>;
    return {
      allowOnce: typeof parsed.allowOnce === "number" ? parsed.allowOnce : 0,
      allowAlways: typeof parsed.allowAlways === "number" ? parsed.allowAlways : 0,
      deny: typeof parsed.deny === "number" ? parsed.deny : 0,
      lastDecision: parsed.lastDecision ?? null,
    };
  } catch {
    return { ...EMPTY_HISTORY };
  }
}

/** 写 history(同步;try/catch 静默 storage 不可用)。 */
export function writeAlwaysAllowHistory(
  toolName: string,
  history: AlwaysAllowHistory,
  storage: { setItem(k: string, v: string): void } | null = typeof localStorage !== "undefined" ? localStorage : null,
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_PREFIX + toolName, JSON.stringify(history));
  } catch {
    // quota / disabled
  }
}

/** 推一条决策(返回新 history;原 history 不变)。 */
export function recordAlwaysAllowDecision(
  toolName: string,
  decision: AlwaysAllowDecision,
  prev: AlwaysAllowHistory,
): AlwaysAllowHistory {
  return {
    allowOnce: prev.allowOnce + (decision === "allowOnce" ? 1 : 0),
    allowAlways: prev.allowAlways + (decision === "allowAlways" ? 1 : 0),
    deny: prev.deny + (decision === "deny" ? 1 : 0),
    lastDecision: decision,
  };
}

/** 派生建议默认高亮行:
 *  - 多数 allowAlways(> 其它两类总和)→ "allowAlways"
 *  - 多数 deny → "deny"
 *  - 其它(allowOnce 多 / 数据少 / 平衡)→ "allowOnce" (默认安全) */
export function suggestAlwaysAllow(history: AlwaysAllowHistory): AlwaysAllowDecision {
  const total = history.allowOnce + history.allowAlways + history.deny;
  if (total === 0) return "allowOnce";
  if (history.allowAlways > history.allowOnce + history.deny) return "allowAlways";
  if (history.deny > history.allowOnce + history.allowAlways) return "deny";
  return "allowOnce";
}
