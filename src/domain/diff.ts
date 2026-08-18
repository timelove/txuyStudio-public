/**
 * 行级 + 词级 diff(自写 LCS,不引第三方库)。
 *
 * 供 `DiffToolView` 渲染 Edit/MultiEdit/Write 的 old_string → new_string 改动。
 * 经典 LCS 动态规划,O(n*m):Edit 的 old/new 通常几十~几百行,性能足够;超大输入
 * (任一侧 >2000 行)退化为全 del+全 add,避免 DP 表内存爆炸。
 *
 * 纯数据 + 纯函数,零 React 依赖,与 `claudeStream.ts` / `claudeToolConfigs.ts` 同风格(domain 层)。
 */

/** 行类型:ctx(未变)/ add(新增)/ del(删除)。 */
export type DiffLineType = "ctx" | "add" | "del";

/** 词段类型(行内高亮):ctx / add / del。 */
export type WordKind = "ctx" | "add" | "del";

export interface WordSegment {
  kind: WordKind;
  text: string;
}

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 词级高亮段(仅相邻 del+add 配对行才挂;纯增删行无)。 */
  words?: WordSegment[];
}

/**
 * 行级 LCS diff。返回统一行序列(ctx/add/del),相邻 del+add 行附带词级高亮。
 */
export function diffLines(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  // 超大输入保护:退化为全 del + 全 add(无 LCS、无词级),防 DP 表 O(n*m) 内存爆炸。
  if (a.length > 2000 || b.length > 2000) {
    return [
      ...a.map<DiffLine>((text) => ({ type: "del", text })),
      ...b.map<DiffLine>((text) => ({ type: "add", text })),
    ];
  }
  const m = a.length;
  const n = b.length;
  // LCS DP 表(从右下往左上填)。
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // 回溯生成行序列。
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: "del", text: a[i] });
      i++;
    } else {
      lines.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) {
    lines.push({ type: "del", text: a[i] });
    i++;
  }
  while (j < n) {
    lines.push({ type: "add", text: b[j] });
    j++;
  }
  return attachWordDiffs(lines);
}

/**
 * 对相邻的 del+add 行做词级 diff,各自挂上 words(del 行含 del+ctx 段,add 行含 add+ctx 段)。
 * 这样行级红绿之上,还能精确定位行内改动的词(类 git diff --word-diff)。
 */
function attachWordDiffs(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (let k = 0; k < lines.length; k++) {
    const cur = lines[k];
    const next = lines[k + 1];
    if (cur.type === "del" && next && next.type === "add") {
      const segs = diffWords(cur.text, next.text);
      out.push({ ...cur, words: segs.filter((w) => w.kind !== "add") });
      out.push({ ...next, words: segs.filter((w) => w.kind !== "del") });
      k++; // 跳过已配对的 next
    } else {
      out.push(cur);
    }
  }
  return out;
}

/**
 * 词级 LCS diff:按「连续非空白 + 空白」分段(保留空白以便还原),返回词段序列。
 */
export function diffWords(oldLine: string, newLine: string): WordSegment[] {
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const m = a.length;
  const n = b.length;
  // 词数过大(单行超长)保护:直接 del 全 + add 全。
  if (m > 400 || n > 400) {
    return [
      ...(a.length ? [{ kind: "del" as WordKind, text: oldLine }] : []),
      ...(b.length ? [{ kind: "add" as WordKind, text: newLine }] : []),
    ];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segs: WordSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      segs.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      segs.push({ kind: "del", text: a[i] });
      i++;
    } else {
      segs.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) {
    segs.push({ kind: "del", text: a[i] });
    i++;
  }
  while (j < n) {
    segs.push({ kind: "add", text: b[j] });
    j++;
  }
  return mergeAdj(segs);
}

/** 按「连续非空白 + 空白」切分,保留空白段。 */
function tokenize(s: string): string[] {
  if (!s) return [];
  return s.match(/\s+|\S+/g) ?? [s];
}

/** 合并相邻同 kind 的词段(减少 DOM 节点)。 */
function mergeAdj(segs: WordSegment[]): WordSegment[] {
  const out: WordSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.kind === s.kind) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}
