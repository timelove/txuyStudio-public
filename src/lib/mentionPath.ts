// BaoCode P3.1 — @ 提及路径解析(纯函数,源 A 本地 fileTree + 源 C 任意绝对路径)
//
// 借鉴:BaoCode file_mentions.dart 中 query 解析(@ 触发后按 query 形态分源:
//  纯文本 → workspace fuzzy;@~/ → home;@/abs 或 @C:\ → absolute path)
//
// 我们的实现只覆盖源 A(workspace)+ 源 C(绝对路径),不引入源 B(kernel 800ms 超时):
//  我们直连 claude CLI stream-json,无 kernel 抽象,新增"kernel file suggestions"
//  协议字段不在本阶段范围;源 C 已经能覆盖 99% 用户场景(本地任意路径)。
//
// 用法:
//   const resolved = resolveMentionPath("@C:\\Users\\x\\App", "C:\\Users\\");
//   → { kind: "absolute", path: "C:\\Users\\x\\App", prefix: "@C:\\Users\\x\\App" }
//   集成侧按 kind 走 list_files(workspace) / list_files(absolute path) / list_files(home)。

export type ResolvedMention =
  | { kind: "workspace"; path: string; prefix: string } // 走 workspace fuzzy
  | { kind: "absolute"; path: string; prefix: string } // 走 list_files(absolute)
  | { kind: "home"; path: string; prefix: string }     // 走 list_files(home-expanded)
  | { kind: "empty" };                                 // 空 token(刚按 @,列 workspace 根)

/**
 * 解析 @ 触发后的 query(token 部分,不含前导 @)。
 * @param query   紧贴 @ 后的输入文本(可能含前缀/子串)
 * @param home    用户主目录(从 Tauri 拿),用于 ~/ 展开
 * @param cwd     当前 workspace 根(用于 workspace 模式拼前缀)
 */
export function resolveMentionPath(
  query: string,
  home: string,
  cwd: string,
): ResolvedMention {
  if (!query) return { kind: "empty" };
  // 1) home 模式:@~/ 开头
  if (query === "~" || query.startsWith("~/") || query.startsWith("~\\")) {
    const rest = query.slice(1).replace(/^[/\\]/, "");
    const expanded = rest ? joinPath(home, rest) : home;
    return { kind: "home", path: expanded, prefix: "~/" + rest };
  }
  // 2) absolute 模式:Windows 盘符或 POSIX 绝对路径
  if (/^[A-Za-z]:[\\/]/.test(query) || query.startsWith("/")) {
    return { kind: "absolute", path: query, prefix: query };
  }
  // 3) workspace 模式
  const seg = query.replace(/\\/g, "/");
  return { kind: "workspace", path: joinPath(cwd, seg), prefix: seg };
}

/** 跨平台路径拼接(简单实现:POSIX 用 /,Windows 沿用 \\ 或盘符)。 */
function joinPath(base: string, rest: string): string {
  if (!rest) return base;
  const isWinRoot = /^[A-Za-z]:[\\/]?$/.test(base);
  const isWin = isWinRoot || base.includes("\\");
  const sep = isWin ? "\\" : "/";
  const trimmedBase = base.replace(/[\\/]+$/, "");
  const trimmedRest = rest.replace(/^[\\/]+/, "");
  return trimmedBase + sep + trimmedRest;
}

/**
 * fuzzy 打分(2026-11-11 二次升级:文件名匹配语义)。`usc` 命中 `userCard.tsx`,
 * 且纯名字 query **只看文件名**——目录段的 incidental 命中不再把无关文件搅进来。
 *
 * 打分规则(VSCode/fzf 式简化):
 * - 纯名字 query 对 basename 子序列打分;含 `/`/`\` 的 query 对整条 path 打分;
 * - 每命中字符基础 2 分;连续 run 第 n 个字符额外 +(n-1)×2(连续远优于跳跃);
 * - 边界命中(路径分隔符/`.`/`-`/`_`/空格之后、驼峰首字母、串首)+3;
 * - basename 以整个 query 开头大加分(文件名越短加成越高)、basename 含 query 次加成;
 * - 长度惩罚:匹配主体长度为主,整条 path 长度小权重 tie-break;
 * - 任意字符接不上(query 不是匹配主体的子序列)→ null,不匹配。
 */
export function fuzzyMatchScore(candidate: string, query: string): number | null {
  if (!query) return 0;
  const sep = Math.max(candidate.lastIndexOf("/"), candidate.lastIndexOf("\\"));
  const basePath = candidate.slice(sep + 1);
  // 纯名字 query 只对 basename 匹配(目录命中不算数,2026-11-11 用户反馈「不准」
  // 的根源:整条 path 子序列会把目录段 incidental 命中的无关文件排进来);
  // 带分隔符的 query 按整条 path 匹配(搜「目录 + 文件名」场景)。
  const pathMode = /[/\\]/.test(query);
  const target = pathMode ? candidate : basePath;
  const lower = target.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let qi = 0;
  let run = 0;
  let prevHit = -2;
  let firstHit = -1;
  for (let i = 0; i < target.length && qi < q.length; i++) {
    if (lower[i] !== q[qi]) {
      run = 0;
      continue;
    }
    if (firstHit === -1) firstHit = i;
    run = prevHit === i - 1 ? run + 1 : 1;
    score += 2 + (run - 1) * 2;
    const prev = i > 0 ? target[i - 1] : "";
    const ch = target[i];
    if (i === 0 || /[/\\._\- ]/.test(prev) || (ch >= "A" && ch <= "Z" && prev >= "a" && prev <= "z")) {
      score += 3;
    }
    prevHit = i;
    qi++;
  }
  if (qi < q.length) return null; // 子序列未走完
  const base = basePath.toLowerCase();
  // basename 命中加分按文件名长度衰减:同是 startsWith,"Button.tsx" 应排在
  // "button.test.ts" 前(匹配占文件名比例更高,更贴合搜索意图)。
  if (base.startsWith(q)) {
    // 前缀命中大加分,文件名越短加成越高("Button.tsx" 排 "button.test.ts" 前)。
    score += Math.max(4, 14 - basePath.length * 0.2);
  } else if (base.includes(q)) {
    score += Math.max(2, 8 - basePath.length * 0.1);
  }
  if (firstHit === 0) score += 2; // 首字符即命中
  // 长度惩罚:匹配主体(basename 模式=文件名,path 模式=整条)为主,path 长度小权重 tie-break。
  score -= (pathMode ? target.length : basePath.length) * 0.15;
  score -= candidate.length * 0.02;
  return score;
}

/**
 * fuzzy 排名:空 query 按字母排;非空按 [fuzzyMatchScore] 降序(同分按字母),
 * **一个都不匹配时保留原序**(兜底语义,与旧实现一致)。
 */
export function rankMentionCandidates(
  candidates: string[],
  query: string,
): string[] {
  if (!query) return [...candidates].sort();
  const scored: { c: string; s: number }[] = [];
  for (const c of candidates) {
    const s = fuzzyMatchScore(c, query);
    if (s != null) scored.push({ c, s });
  }
  if (scored.length === 0) return candidates;
  scored.sort((a, b) => b.s - a.s || a.c.localeCompare(b.c));
  return scored.map((x) => x.c);
}

/** [rankMentionCandidates] 的对象版:按 label 打分排序,无匹配返回空(调用方自行兜底)。 */
export function fuzzyRankBy<T>(items: T[], label: (t: T) => string, query: string): T[] {
  if (!query) return [...items].sort((a, b) => label(a).localeCompare(label(b)));
  const scored: { it: T; s: number }[] = [];
  for (const it of items) {
    const s = fuzzyMatchScore(label(it), query);
    if (s != null) scored.push({ it, s });
  }
  scored.sort((a, b) => b.s - a.s || label(a.it).localeCompare(label(b.it)));
  return scored.map((x) => x.it);
}
