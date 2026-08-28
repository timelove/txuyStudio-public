/**
 * 钉住区并排布局的领域模型:流向(横/纵) + 行分组。
 *
 * 布局偏好 `{ flow, groups }` 走 localStorage 轻持久化(与 bgSetting 同模式,纯视觉不走后端
 * state.json);钉住集合本身(pinnedProjectIds)仍是会话内 view 态,重启即空。
 *
 * groups 存「用户上次显式点选的形态」而非当前渲染形态:与可见项目数 n 失配时由
 * resolveGroups 在渲染期归一,存储不覆写——n 暂变(取消钉住)再恢复时,原形态自动找回。
 */

/** 并排流向:row = 项目沿横向流动(单排横排);column = 纵向流,分组语义整体旋转 90°。 */
export type PinnedFlowLayout = "row" | "column";

/** 钉住区布局偏好。groups 为空数组 = 从未选过(归一为 [n],即现状单排)。 */
export type PinnedLayout = {
  flow: PinnedFlowLayout;
  /** 每组项目数(如 [2,1] = 横向流时上 2 下 1 / 纵向流时左 2 右 1)。 */
  groups: number[];
};

export const DEFAULT_PINNED_LAYOUT: PinnedLayout = { flow: "row", groups: [] };

/** 钉住项目上限(手动 ●/○、下拉联动钉、历史恢复自动钉三入口共用)。 */
export const MAX_PINNED_PROJECTS = 10;

const PINNED_LAYOUT_KEY = "mx.pinnedLayout";

/**
 * 从 localStorage 读布局偏好。损坏/缺字段逐项回退默认(仿 SettingsProvider.loadBgSetting):
 * flow 非 "column" 一律回 "row"(防脏数据注入未知流向);groups 非正整数数组回空。
 */
export function loadPinnedLayout(): PinnedLayout {
  try {
    const raw = localStorage.getItem(PINNED_LAYOUT_KEY);
    if (!raw) return DEFAULT_PINNED_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<PinnedLayout>;
    return {
      flow: parsed.flow === "column" ? "column" : "row",
      groups:
        Array.isArray(parsed.groups) && parsed.groups.every((g) => Number.isInteger(g) && g > 0)
          ? parsed.groups
          : DEFAULT_PINNED_LAYOUT.groups,
    };
  } catch {
    return DEFAULT_PINNED_LAYOUT;
  }
}

/** 写 localStorage(隐私模式等写失败静默忽略,仅本次会话内存态生效)。 */
export function savePinnedLayout(layout: PinnedLayout): void {
  try {
    localStorage.setItem(PINNED_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // 忽略:持久化是锦上添花,不值得打断交互。
  }
}

/**
 * 生成 n 个项目的分组预设(有序数组,每项是一组「每组项目数」)。
 *
 * 完整有序划分有 2^(n-1) 种(n=10 即 512),不可全列。采用「近均分 + 段数分级」:
 * - 段数 k ∈ [1, min(5, n)];
 * - k ≤ 3:给全部近均分形态(每段 floor(n/k) 或 floor(n/k)+1,组合数 C(k,r) ≤ 3),
 *   保住奇数的 1+2 / 2+1 / 2+2+1 / 2+1+2 等选择性排列;
 * - k ∈ [4,5]:仅当 n % k === 0 给唯一纯均分形态,保住 8 个的 [2,2,2,2]、10 个的
 *   [2,2,2,2,2] 这类平衡网格,又不引入 C(4,2)=6 / C(5,2)=10 的长尾;
 * - 末尾追加全 1(竖排基准;n ≤ 5 时与 k=n 形态重合,按 key 去重)。
 *
 * 每个清单首项 [n] = 横排基准、末项全 1 = 竖排基准(column 流下两者互换语义),
 * 奇偶数均横/纵/网格全覆盖;候选恒 ≤ 7。n > 10(上限溢出的可见数边缘)同规则安全。
 *
 * 输出按段数升序、同段数大段靠前([3,2] 先于 [2,3])。
 */
export function generateGroupPresets(n: number): number[][] {
  if (!Number.isInteger(n) || n < 1) return [[Math.max(1, n)]];
  const presets: number[][] = [];
  const maxK = Math.min(5, n);
  for (let k = 1; k <= maxK; k++) {
    const q = Math.floor(n / k);
    const r = n % k;
    if (k <= 3) {
      // k 个位置里选 r 个放 q+1(其余放 q)。k≤3 时组合至多 C(3,1)=3 个,直接枚举。
      for (const combo of combinations(k, r)) presets.push(expandCombo(k, q, combo));
    } else if (r === 0) {
      // k≥4 只留纯均分形态(r=0 唯一)。
      presets.push(Array.from({ length: k }, () => q));
    }
  }
  presets.push(Array.from({ length: n }, () => 1)); // 全 1(竖排基准)
  // 按段数升序、同段数大段靠前(逐元素数值比较,防 "10" < "9" 的字符串序陷阱);key 去重。
  const seen = new Set<string>();
  return presets
    .sort((a, b) => a.length - b.length || compareDesc(a, b))
    .filter((g) => {
      const key = g.join(",");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** k 个位置的 r 个放大位 → 形态数组(放大位放 q+1,其余 q)。 */
function expandCombo(k: number, q: number, boosted: Set<number>): number[] {
  return Array.from({ length: k }, (_, i) => (boosted.has(i) ? q + 1 : q));
}

/** 枚举 {0..k-1} 中选 r 个的全部组合(r=0 → 一个空集)。k ≤ 5、r < k,量极小。 */
function combinations(k: number, r: number): Set<number>[] {
  if (r === 0) return [new Set<number>()];
  const result: Set<number>[] = [];
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length === r) {
      result.push(new Set(chosen));
      return;
    }
    for (let i = start; i < k; i++) {
      chosen.push(i);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return result;
}

/** 逐元素数值降序比较:首个不同元素大的排前([3,2] < [2,3] 意为 [3,2] 排前)。 */
function compareDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]! !== b[i]!) return (b[i] ?? 0) - (a[i] ?? 0);
  }
  return 0;
}

/**
 * 把存储的 groups 归一到 sum === n(渲染期调用,纯函数不回写):
 * 1. sum 相等 → 原样返回(拷贝);
 * 2. 段数 > n(每组至少 1 个放不下)→ 全 1;
 * 3. 否则按权重保形重映射:raw_i = g_i × n / sum,round + clamp(≥1) 后修和
 *    (差值逐个落在「取整误差最大」的段上,减法只作用在 >1 的段,防 0 段);
 * 4. 意外(空数组/n<1)→ [n](现状行为)。
 *
 * 例:[2,1](n=3) → n=2 得 [1,1];[1,2](n=3) → n=5 得 [2,3](前小后大保形);
 * [2,1,2](n=5) → n=3 得 [1,1,1];n 回 5 时存储未动,形态自动恢复。
 */
export function resolveGroups(groups: number[], n: number): number[] {
  if (!Number.isInteger(n) || n < 1) return [Math.max(1, n)];
  const valid = groups.filter((g) => Number.isInteger(g) && g > 0);
  if (valid.length === 0) return [n];
  const sum = valid.reduce((a, b) => a + b, 0);
  if (sum === n) return [...valid];
  if (valid.length > n) return Array.from({ length: n }, () => 1);
  // 保形重映射:先 round + clamp(≥1),再逐点修和(每步调整取整误差最大的段)。
  const raw = valid.map((g) => (g * n) / sum);
  const out = raw.map((v) => Math.max(1, Math.round(v)));
  while (out.reduce((a, b) => a + b, 0) !== n) {
    const total = out.reduce((a, b) => a + b, 0);
    const need = n - total; // >0 该加 / <0 该减
    let bestIdx = -1;
    let bestErr = -Infinity;
    for (let i = 0; i < out.length; i++) {
      if (need < 0 && out[i]! <= 1) continue; // 减法跳过已到下限 1 的段
      const err = need > 0 ? raw[i]! - out[i]! : out[i]! - raw[i]!; // 调整该段的取整误差
      if (err > bestErr) {
        bestErr = err;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break; // 理论不可达(加法总有候选),防御退出
    out[bestIdx] = (out[bestIdx] ?? 0) + (need > 0 ? 1 : -1);
  }
  return out;
}

/** 按归一后的 groups 依序切 items(防御:groups 耗尽后剩余项尾追末组,不丢项目)。 */
export function chunkByGroups<T>(items: T[], groups: number[]): T[][] {
  const rows: T[][] = [];
  let idx = 0;
  for (const g of groups) {
    if (idx >= items.length) break;
    rows.push(items.slice(idx, idx + g));
    idx += g;
  }
  if (idx < items.length && rows.length > 0) {
    rows[rows.length - 1]!.push(...items.slice(idx));
  }
  return rows;
}
