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

/** fuzzy 排名:workspace 根下的文件,空 query 时按字母排,非空时按 startsWith 优先 + includes 次之。 */
export function rankMentionCandidates(
  candidates: string[],
  query: string,
): string[] {
  if (!query) return [...candidates].sort();
  const q = query.toLowerCase();
  const starts: string[] = [];
  const includes: string[] = [];
  const rest: string[] = [];
  for (const c of candidates) {
    const lower = c.toLowerCase();
    if (lower.startsWith(q)) starts.push(c);
    else if (lower.includes(q)) includes.push(c);
    else rest.push(c);
  }
  // 无匹配也保留原序(rest 保持 candidates 顺序)
  return starts.length + includes.length === 0 ? candidates : [...starts, ...includes, ...rest];
}
