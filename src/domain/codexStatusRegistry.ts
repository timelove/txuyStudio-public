/**
 * 全局 codex 会话状态注册表(模块单例,仿 `claudeStatusRegistry.ts`)。
 *
 * 每个 codexpane tab 对应一个 `CodexTransport` 实例,存于 AppShell 的 `codexTransportsRef`
 * (useRef,非 React state)。ref 集合变化不触发重渲染,故用本外部 store 作 transport 与 UI
 * 之间的桥:transport 构造时 `register`、`emit()` 出口 `update` summary、stop 时 `unregister`。
 * StatusBar 用 `useSyncExternalStore` 订阅,拿全部 entry 汇总(与 claude 的注册表并列、互不影响)。
 *
 * `getSnapshot` 稳定性:内部维护 cachedEntries,仅真变更时重建数组。
 */
import { useSyncExternalStore } from "react";
import type { CodexSessionSummary } from "./codexStream";

/** 一条 codex tab 的对外状态项。key = transportKey(projectId,paneId,tabId)。 */
export type CodexStatusEntry = {
  key: string;
  projectId: string;
  /** 该 tab 所属 pane 的 id(供 StatusBar 聚焦反查;transport 不持有,由 AppShell 订阅时补全)。 */
  paneId: string;
  tabId: string;
  summary: CodexSessionSummary;
};

class CodexStatusRegistry {
  private entries = new Map<string, CodexStatusEntry>();
  private listeners = new Set<() => void>();
  /** 缓存的快照数组(getSnapshot 稳定引用)。entries 变更时置 null 强制重建。 */
  private cachedEntries: CodexStatusEntry[] | null = null;

  /** 注册一个 tab(初始 idle)。重复 register 同 key 视为更新(不重复入)。 */
  register(key: string, projectId: string, tabId: string, paneId = ""): void {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.paneId !== paneId && paneId) {
        this.entries.set(key, { ...existing, paneId });
        this.invalidate();
      }
      return;
    }
    this.entries.set(key, { key, projectId, tabId, paneId, summary: { kind: "idle", active: false } });
    this.invalidate();
  }

  /** 补充/更新某 tab 的 paneId(AppShell 订阅时补全)。 */
  setPaneId(key: string, paneId: string): void {
    const e = this.entries.get(key);
    if (e && e.paneId !== paneId) {
      this.entries.set(key, { ...e, paneId });
      this.invalidate();
    }
  }

  /** transport emit 时上报最新 summary。无变化时不 invalidate(避免无效重渲染)。 */
  update(key: string, summary: CodexSessionSummary): void {
    const e = this.entries.get(key);
    if (!e) return;
    const s = e.summary;
    if (
      s.kind === summary.kind &&
      s.active === summary.active &&
      s.ctxPct === summary.ctxPct &&
      s.model === summary.model &&
      s.reasoningEffort === summary.reasoningEffort
    )
      return;
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
  getSnapshot = (): CodexStatusEntry[] => {
    if (this.cachedEntries === null) {
      this.cachedEntries = Array.from(this.entries.values());
    }
    return this.cachedEntries;
  };

  /** 取单条 entry(供 tab chip 选自己那条,避免订阅全量)。无则 undefined。 */
  getEntry(key: string): CodexStatusEntry | undefined {
    return this.entries.get(key);
  }

  private invalidate(): void {
    this.cachedEntries = null;
    for (const cb of this.listeners) cb();
  }
}

/** 模块单例。主窗口与 detach 独立窗口各自一个 React app,各自 import 本模块得各自单例。 */
export const codexStatusRegistry = new CodexStatusRegistry();

/** 订阅全部 codex tab 状态(供 StatusBar 汇总)。 */
export function useCodexStatuses(): CodexStatusEntry[] {
  return useSyncExternalStore(codexStatusRegistry.subscribe, codexStatusRegistry.getSnapshot);
}
