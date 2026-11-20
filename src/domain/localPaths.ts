/**
 * 会话流「本机文件路径」识别与解析(蓝色文件链接)。
 *
 * assistant/thinking 自由文本里提到本机文件时标蓝、hover 显文件夹图标、点击走
 * `reveal_in_folder` 打开所在目录。识别两形态:
 * - Windows 绝对路径(盘符):`D:\a\b.rs` / `D:/a/b.rs`;
 * - 相对多段路径(至少一个分隔段 + 扩展名形态):`src/domain/x.ts`——按会话 cwd 拼
 *   后端验证,存在才标(防把版本号/日期/普通词组误当路径)。
 *
 * 存在性走后端 `resolve_local_paths` 批量探测(metadata 微秒级),前端两层缓存:
 * 模块级 Map(cwd+候选 → 解析结果,跨消息/跨渲染共享)+ 微批合并(同帧多组件的候选
 * 攒一拨 30ms 一次 invoke)。reveal 复用 system 域 `reveal_in_folder`(相对路径自带
 * cwd 参数,工具卡定位同款链路)。
 *
 * 边界:含空格的绝对路径(`C:\Program Files\...`)会被切在空格处,拼 cwd 验证不过即
 * 不标——验证兜底让误报自然消失,不做带空格路径的贪婪匹配(误吞正文风险更高)。
 */

import { invoke } from "@tauri-apps/api/core";

/** Windows 盘符绝对路径。首边界 \b;段内排除空白与路径非法字符。 */
const ABS_PATH_RE = /\b[A-Za-z]:[\\/](?:[^\s:*?"<>|\\/]+[\\/])*[^\s:*?"<>|\\/]+/g;

/**
 * 相对多段路径:≥1 个分隔段 + 文件名带扩展名(字母开头,≤10 位)。lookbehind 挡住
 * URL/其他路径的中段起配(`https://a.com/b.ts` 里 `com/` 前是 `.`、`a.com` 前是 `/`,
 * 均被拦);`(?!\w)` 尾边界防截断半截词。无分隔段的 `v1.2.3` / `2026.11.19` 形态天然不配。
 */
const REL_PATH_RE = /(?<![\w.\\/-])(?:[\w.@+-]+[\\/])+[\w.@+-]+\.[A-Za-z][A-Za-z0-9]{0,9}(?!\w)/g;

/** 匹配尾部不会是路径成分的标点(路径自身字符类已排除,这里剥句读残留)。 */
const TRAILING_PUNCT = /[.,;:!?)\]}>'"`]+$/;

/** 分段结果:isCand 段是路径候选(已剥尾标点),其余为原文。 */
export type PathSegment = { text: string; isCand: boolean };

/**
 * 按路径候选切段(组件渲染与 MdPreview DOM 富化共用)。REL 的 lookbehind 保证不会
 * 在 ABS 命中区间内部起配(段首总被 `/` `\` 挡住),两集合天然不相交,直接合并排序。
 */
export function splitPathSegments(text: string): PathSegment[] {
  if (text.length < 5 || !/[:\\/]/.test(text)) return [{ text, isCand: false }];
  type Hit = { start: number; end: number; cand: string };
  const hits: Hit[] = [];
  for (const re of [ABS_PATH_RE, REL_PATH_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const cand = m[0].replace(TRAILING_PUNCT, "");
      // `D:\work\`(尾裸分隔符的目录引用)保留;`D:\` 本体过短跳过。
      if (cand.length >= 4) hits.push({ start: m.index, end: m.index + cand.length, cand });
    }
  }
  if (hits.length === 0) return [{ text, isCand: false }];
  hits.sort((a, b) => a.start - b.start);
  const out: PathSegment[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.start < pos) continue; // 理论不发生(两正则区间不相交),防御性丢弃
    if (h.start > pos) out.push({ text: text.slice(pos, h.start), isCand: false });
    out.push({ text: h.cand, isCand: true });
    pos = h.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), isCand: false });
  return out;
}

/** 解析结果:resolved = 存在时的绝对路径(点击 reveal 用),null = 不存在(不标)。 */
export type ResolvedPath = { resolved: string | null; isDir: boolean };

const resolvedCache = new Map<string, ResolvedPath>();
const RESOLVED_CACHE_MAX = 2000;

function cacheKey(cwd: string | undefined, cand: string): string {
  return `${cwd ?? ""}\u0000${cand}`;
}

/** 同步查缓存(渲染热路径):未验证过返回 undefined。 */
export function lookupResolved(cwd: string | undefined, cand: string): ResolvedPath | undefined {
  return resolvedCache.get(cacheKey(cwd, cand));
}

/** in-flight 去重 + 微批:同 key 并发只发一次;30ms 窗口内的候选合一次 invoke。 */
const inflight = new Map<string, Promise<void>>();
let batchTimer: number | null = null;
let batchKeys: string[] = [];
let batchCwd: string | undefined;
let batchWaiters: Array<() => void> = [];

function flushBatch(): void {
  batchTimer = null;
  const keys = batchKeys;
  const cwd = batchCwd;
  const waiters = batchWaiters;
  batchKeys = [];
  batchWaiters = [];
  if (keys.length === 0) return;
  // 非 Tauri(浏览器兜底)全判不存在:标蓝只在桌面运行时生效。
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    for (const k of keys) resolvedCache.set(k, { resolved: null, isDir: false });
    for (const w of waiters) w();
    return;
  }
  // cache key 还原候选串(key = cwd \0 cand)。
  const prefix = `${cwd ?? ""}\u0000`;
  const cands = keys.map((k) => k.slice(prefix.length));
  void invoke<{ input: string; resolved: string | null; isDir: boolean }[]>(
    "resolve_local_paths",
    { baseDir: cwd ?? null, paths: cands },
  )
    .then((rows) => {
      const byInput = new Map(rows.map((r) => [r.input, r]));
      for (const k of keys) {
        const cand = k.slice(prefix.length);
        const hit = byInput.get(cand);
        resolvedCache.set(k, hit ? { resolved: hit.resolved, isDir: hit.isDir } : { resolved: null, isDir: false });
      }
    })
    .catch(() => {
      for (const k of keys) resolvedCache.set(k, { resolved: null, isDir: false });
    })
    .finally(() => {
      for (const w of waiters) w();
      if (resolvedCache.size > RESOLVED_CACHE_MAX) {
        // 简单 FIFO 淘汰:候选缓存量级 = 消息内路径数,超限场景罕见。
        const it = resolvedCache.keys();
        for (let i = 0; i < RESOLVED_CACHE_MAX / 2; i++) {
          const n = it.next();
          if (n.done) break;
          resolvedCache.delete(n.value);
        }
      }
    });
}

function enqueueResolve(cwd: string | undefined, cands: string[]): Promise<void> {
  const prefix = `${cwd ?? ""}\u0000`;
  const fresh = cands.filter((c) => {
    const k = prefix + c;
    if (resolvedCache.has(k) || inflight.has(k)) return false;
    return true;
  });
  if (fresh.length === 0) return Promise.resolve();
  // 首个入队者定批次 cwd(同帧渲染同 pane,cwd 一致;跨 pane 极端场景按先到者批,
  // 慢一拍不过错——候选取舍由后端 exists 兜底)。
  if (batchKeys.length === 0) batchCwd = cwd;
  const done = new Promise<void>((resolve) => {
    batchWaiters.push(resolve);
    for (const c of fresh) {
      const k = prefix + c;
      inflight.set(k, done);
      batchKeys.push(k);
    }
  });
  done.finally(() => {
    for (const c of fresh) inflight.delete(prefix + c);
  });
  if (batchTimer == null) batchTimer = window.setTimeout(flushBatch, 30);
  return done;
}

/**
 * 批量解析:缓存命中同步返回,未验证候选微批走后端。返回后缓存一定就绪(调用方
 * 重渲染即拿到最终标蓝结果)。流式热路径只配 `extractPathCandidates` + `lookupResolved`
 * 同步查,miss 的调本函数补验,完成后 setState 触发一次重渲染即可。
 */
export async function resolveLocalPaths(cwd: string | undefined, cands: string[]): Promise<void> {
  if (cands.length === 0) return;
  await enqueueResolve(cwd, cands);
}

/** 点击标蓝路径:reveal 所在目录(explorer /select;复用工具卡定位同款命令)。 */
export function revealLocalPath(resolved: string): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  invoke("reveal_in_folder", { path: resolved }).catch(() => {});
}
