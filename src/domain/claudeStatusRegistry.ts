/**
 * 全局 claude 会话状态注册表(模块单例)。
 *
 * **背景**:每个 claudepane tab 对应一个 `ClaudeTransport` 实例,存于 AppShell 的
 * `claudeTransportsRef`(useRef,非 React state)。ref 集合变化不触发重渲染,故无法直接用
 * React state 镜像全部 transport 的状态喂给全局 `StatusBar`(跨 tab 汇总「有几个 claude 在跑/
 * 报错/等待」)。
 *
 * **方案**(仿后端 `ClaudeRegistry` 双层 map 映射到前端):本注册表作 transport 与 UI 之间的
 * 外部 store。每个 `ClaudeTransport` 构造时 `register`、`emit()` 出口 `update` summary、
 * stop/卸载时 `unregister`。AppShell 用 `useSyncExternalStore` 订阅,拿全部 entry 喂给 StatusBar。
 *
 * **getSnapshot 稳定性**:`useSyncExternalStore` 要求快照引用稳定(否则无限重渲染)。内部维护
 * `cachedEntries`,仅在 register/update/unregister 真变更时重建数组;无变化时返回同一引用。
 */
import { useSyncExternalStore } from "react";
import type { ClaudeSessionSummary } from "./claudeStream";

/** 一条 claude tab 的对外状态项。key = transportKey(projectId,paneId,tabId)。 */
export type ClaudeStatusEntry = {
  key: string;
  projectId: string;
  /** 该 tab 所属 pane 的 id(供 onFocusClaudeTab 反查 pane;transport 不持有 paneId,故由 AppShell
   *  在订阅时补充)。register 时传空串,AppShell 的 useClaudeStatuses 补全。 */
  paneId: string;
  tabId: string;
  summary: ClaudeSessionSummary;
};

class ClaudeStatusRegistry {
  private entries = new Map<string, ClaudeStatusEntry>();
  private listeners = new Set<() => void>();
  /** 缓存的快照数组(getSnapshot 稳定引用)。entries 变更时置 null 强制重建。 */
  private cachedEntries: ClaudeStatusEntry[] | null = null;

  /** 注册一个 tab(初始 idle)。重复 register 同 key 视为更新(不重复入)。 */
  register(key: string, projectId: string, tabId: string, paneId = ""): void {
    const existing = this.entries.get(key);
    if (existing) {
      // 已注册:仅更新 paneId(若变化)。summary 不动(保留 transport 上报的真实值)。
      if (existing.paneId !== paneId && paneId) {
        this.entries.set(key, { ...existing, paneId });
        this.invalidate();
      }
      return;
    }
    this.entries.set(key, { key, projectId, tabId, paneId, summary: { kind: "idle", active: false } });
    this.invalidate();
  }

  /** 补充/更新某 tab 的 paneId(AppShell 订阅时补全,transport 自身不持有 paneId)。 */
  setPaneId(key: string, paneId: string): void {
    const e = this.entries.get(key);
    if (e && e.paneId !== paneId) {
      this.entries.set(key, { ...e, paneId });
      this.invalidate();
    }
  }

  /** transport emit 时上报最新 summary。无变化时不 invalidate(避免无效重渲染)。 */
  update(key: string, summary: ClaudeSessionSummary): void {
    const e = this.entries.get(key);
    if (!e) return;
    const s = e.summary;
    // kind/active 变化 OR ctxPct/model/effort 变化才 invalidate
    // (否则 ctx% / effort 实时值不刷新 StatusBar)。
    if (
      s.kind === summary.kind &&
      s.active === summary.active &&
      s.ctxPct === summary.ctxPct &&
      s.model === summary.model &&
      s.effort === summary.effort
    ) return;
    this.entries.set(key, { ...e, summary });
    this.invalidate();
  }

  /** 注销一个 tab(关 tab/pane/项目/卸载)。 */
  unregister(key: string): void {
    if (this.entries.delete(key)) this.invalidate();
  }

  /** useSyncExternalStore 订阅接口。 */
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /** useSyncExternalStore 快照接口。返回稳定引用(仅 entries 变更时换新数组)。 */
  getSnapshot = (): ClaudeStatusEntry[] => {
    if (this.cachedEntries === null) {
      this.cachedEntries = Array.from(this.entries.values());
    }
    return this.cachedEntries;
  };

  /** 取单条 entry(供 tab chip 用 useSyncExternalStore 选自己那条,避免订阅全量)。无则 undefined。 */
  getEntry(key: string): ClaudeStatusEntry | undefined {
    return this.entries.get(key);
  }

  private invalidate(): void {
    this.cachedEntries = null;
    for (const cb of this.listeners) cb();
  }
}

/** 模块单例。主窗口与 detach 独立窗口各自一个 React app,各自 import 本模块得各自单例(天然隔离)。 */
export const claudeStatusRegistry = new ClaudeStatusRegistry();

/**
 * 订阅全部 claude tab 状态(供 StatusBar 汇总)。useSyncExternalStore 保证引用稳定、
 * 切 tab/并发 emit 不抖动。
 */
export function useClaudeStatuses(): ClaudeStatusEntry[] {
  return useSyncExternalStore(claudeStatusRegistry.subscribe, claudeStatusRegistry.getSnapshot);
}
