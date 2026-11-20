import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FleetWorkerView, ExternalWorktree } from "../domain/fleet";
import {
  listFleetWorkers,
  listExternalWorktrees,
  previewFleetMerge,
  mergeFleetWorker,
  removeFleetWorker,
  removeExternalWorktree,
} from "../domain/fleet";
import type { ClaudeStatusEntry } from "../domain/claudeStatusRegistry";
import type { CodexStatusEntry } from "../domain/codexStatusRegistry";
import type { ClaudeSessionKind } from "../domain/claudeStream";
import { Button } from "./ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/Dialog";

/**
 * Fleet Worker 面板(StatusBar Fleet 按钮的 Popover 内容,side="top" 向上弹)。
 *
 * 每次打开(挂载)拉一次 `list_fleet_workers` 并 3s 轮询刷新 diff 统计;关闭即停
 * (面板只在打开期存在,轮询不跨生命周期)。worker busy 状态不查后端——按 tabId 从
 * claude/codex 状态注册表(与 StatusBar 药丸同源)读 summary.kind,无 tab 或 idle 视为空闲。
 *
 * 合并走「决策手动,执行自动」:点合并 → preview_fleet_merge 干跑预判(冲突列表 + 主仓
 * 干净度)→ 二次确认 Dialog 展示 → 确认后 merge_fleet_worker(merge --no-ff + 清理)。
 * 冲突不为空时仍允许执行(用户自行在主仓解决),但预览里明确列出。
 */
export function FleetPanel({
  projectId,
  claudeStatuses,
  codexStatuses,
  onFocusFleetTab,
  onWorkersChange,
}: {
  /** 面板只展示聚焦项目的 workers(与状态栏其余部分同一项目上下文)。 */
  projectId: string;
  /** 全部 claude tab 状态(按 worker.tabId 反查 busy)。 */
  claudeStatuses: ClaudeStatusEntry[];
  /** 全部 codex tab 状态(与 claude 并列反查)。 */
  codexStatuses: CodexStatusEntry[];
  /** 聚焦 worker 的 tab(切项目 + 聚焦 pane + 切活动 tab,同 StatusBar 药丸动线)。 */
  onFocusFleetTab?: (projectId: string, tabId: string) => void;
  /** 列表每次拉到数据后回报当前 worker 数(StatusBar Fleet 徽标用;AppShell 维护计数)。 */
  onWorkersChange?: (count: number) => void;
}) {
  const { t } = useTranslation();
  const [workers, setWorkers] = useState<FleetWorkerView[] | null>(null);
  /** 外部 worktree(`-fleet/` 目录下无记录的)独立一节,失败静默空(不影响主列表)。 */
  const [external, setExternal] = useState<ExternalWorktree[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null); // 正在执行合并/丢弃的 worker id
  const [removingExt, setRemovingExt] = useState<string | null>(null); // 正在删除的外部 worktree 路径
  const [actionError, setActionError] = useState<string | null>(null);
  /** 合并预览中(点「合并」→ 拉 preview → 弹确认 Dialog)。worker = 待合并对象。 */
  const [mergeTarget, setMergeTarget] = useState<FleetWorkerView | null>(null);
  const [mergePreview, setMergePreview] = useState<
    { conflicts: string[]; dirty: boolean } | null
  >(null);
  const [merging, setMerging] = useState(false);
  const aliveRef = useRef(true);

  // 打开期拉取 + 3s 轮询(面板卸载即停);失败置 null 显示加载态,下轮重试。
  // 每次拿到数据回报 worker 数(空/失败回报 0),StatusBar Fleet 徽标同步。
  useEffect(() => {
    aliveRef.current = true;
    const refresh = () => {
      listFleetWorkers(projectId)
        .then((ws) => {
          if (!aliveRef.current) return;
          setWorkers(ws);
          onWorkersChange?.(ws.length);
        })
        .catch(() => {
          if (!aliveRef.current) return;
          setWorkers(null);
          onWorkersChange?.(0);
        });
      listExternalWorktrees(projectId)
        .then((xs) => {
          if (!aliveRef.current) return;
          setExternal(xs);
        })
        .catch(() => {
          if (!aliveRef.current) return;
          setExternal(null);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
    // onWorkersChange 由 AppShell useCallback 包裹(引用稳定),不进依赖。
  }, [projectId, onWorkersChange]);

  // 按 tabId 反查 busy 态(两注册表并列找;kind 映射同 StatusBar 药丸口径)。
  const kindFor = useCallback(
    (tabId: string | null | undefined): ClaudeSessionKind | null => {
      if (!tabId) return null;
      const e =
        claudeStatuses.find((c) => c.tabId === tabId) ??
        codexStatuses.find((c) => c.tabId === tabId);
      return e ? e.summary.kind : null;
    },
    [claudeStatuses, codexStatuses],
  );

  // busy = AI 正在产出(合并前必须空闲,防止半成品改动被合走)。bg 是后台任务
  // 在跑、主轮次空闲,允许合并——但改动可能还在变,同样视为忙更稳妥。
  const isBusy = useCallback(
    (w: FleetWorkerView): boolean => {
      const k = kindFor(w.tabId);
      return k === "running" || k === "waiting" || k === "retrying" || k === "error" || k === "bg";
    },
    [kindFor],
  );

  const statusLabel = (k: ClaudeSessionKind | null): string => {
    switch (k) {
      case "running":
        return t("fleet.panel.statusRunning");
      case "waiting":
        return t("fleet.panel.statusWaiting");
      case "retrying":
        return t("fleet.panel.statusRetrying");
      case "error":
        return t("fleet.panel.statusError");
      case "bg":
        return t("fleet.panel.statusBg");
      case "idle":
        return t("fleet.panel.statusIdle");
      default:
        return t("fleet.panel.noTab");
    }
  };
  const statusColor = (k: ClaudeSessionKind | null): string => {
    switch (k) {
      case "running":
        return "#22d3ee";
      case "waiting":
        return "#a78bfa";
      case "retrying":
        return "#fb923c";
      case "error":
        return "#f87171";
      case "bg":
        return "#fbbf24";
      default:
        return "#64748b"; // idle / 未挂载:中性灰点
    }
  };

  // 点「合并」:先 preview 干跑(旧 git 不支持 merge-tree 时报错,内联展示)。
  const startMerge = (w: FleetWorkerView) => {
    if (isBusy(w)) {
      setActionError(t("fleet.panel.mergeBusy"));
      return;
    }
    setActionError(null);
    setMergeTarget(w);
    setMergePreview(null);
    previewFleetMerge(projectId, w.id)
      .then((p) => {
        if (mergeTargetRef.current) setMergePreview(p);
      })
      .catch((e) => {
        setMergeTarget(null);
        setActionError(String(e));
      });
  };

  // mergeTarget 闭包陈旧问题:preview 回包时对话框可能已关,用 ref 镜像判活。
  const mergeTargetRef = useRef<FleetWorkerView | null>(null);
  mergeTargetRef.current = mergeTarget;

  // 确认合并:执行 merge_fleet_worker,成功后刷新列表 + 关确认框。
  const confirmMerge = async () => {
    const w = mergeTarget;
    if (!w) return;
    setMerging(true);
    try {
      await mergeFleetWorker(projectId, w.id);
      setMergeTarget(null);
      setMergePreview(null);
      listFleetWorkers(projectId)
        .then((ws) => {
          if (!aliveRef.current) return;
          setWorkers(ws);
          onWorkersChange?.(ws.length);
        })
        .catch(() => {});
    } catch (e) {
      setActionError(String(e));
      setMergeTarget(null);
    } finally {
      setMerging(false);
    }
  };

  // 丢弃:原生 confirm 二次确认(删除不可逆,改动全丢)。
  const handleRemove = async (w: FleetWorkerView) => {
    if (!window.confirm(t("fleet.panel.removeConfirm"))) return;
    setBusyId(w.id);
    setActionError(null);
    try {
      await removeFleetWorker(projectId, w.id);
      listFleetWorkers(projectId)
        .then((ws) => {
          if (!aliveRef.current) return;
          setWorkers(ws);
          onWorkersChange?.(ws.length);
        })
        .catch(() => {});
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  // 删除外部 worktree(无 worker 记录的 `-fleet/` 目录残留):confirm 后删目录 + fleet/ 分支。
  const handleRemoveExt = async (w: ExternalWorktree) => {
    if (!window.confirm(t("fleet.panel.removeExternalConfirm"))) return;
    setRemovingExt(w.worktreePath);
    setActionError(null);
    try {
      await removeExternalWorktree(projectId, w.worktreePath, w.branch);
      listFleetWorkers(projectId)
        .then((ws) => {
          if (!aliveRef.current) return;
          setWorkers(ws);
          onWorkersChange?.(ws.length);
        })
        .catch(() => {});
      listExternalWorktrees(projectId)
        .then((xs) => {
          if (!aliveRef.current) return;
          setExternal(xs);
        })
        .catch(() => {});
    } catch (e) {
      setActionError(String(e));
    } finally {
      setRemovingExt(null);
    }
  };
  return (
    <div className="w-[380px] max-w-[92vw] px-3 py-2">
      {/* 标题行 */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--mx-faint)]">
          {t("fleet.panel.title")}
        </span>
        <button
          type="button"
          className="cursor-pointer rounded px-1.5 text-[11px] text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
          onClick={() => {
            listFleetWorkers(projectId)
              .then((ws) => {
                setWorkers(ws);
                onWorkersChange?.(ws.length);
              })
              .catch(() => {});
          }}
        >
          ⟳
        </button>
      </div>

      {/* 列表 */}
      {workers === null ? (
        <div className="py-6 text-center text-[11px] text-[var(--mx-faint)]">
          {t("fleet.panel.loading")}
        </div>
      ) : workers.length === 0 ? (
        <div className="py-5 text-center text-[11px] leading-relaxed text-[var(--mx-faint)]">
          {t("fleet.panel.empty")}
        </div>
      ) : (
        <div className="mt-1 flex flex-col gap-1.5">
          {workers.map((w) => {
            const k = kindFor(w.tabId);
            const busy = isBusy(w);
            return (
              <div
                key={w.id}
                className="rounded-[var(--mx-radius-md)] border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2.5 py-1.5"
              >
                {/* 行 1:taskId + provider 色点 + 状态 + diff 统计 */}
                <div className="flex items-center gap-2">
                  <span
                    className="mx-icon-tile grid h-4 w-4 shrink-0 place-items-center text-[9px] font-bold"
                    style={{
                      background: w.provider === "claude" ? "#7c3aed" : "#22d3ee",
                      color: "#0b1020",
                    }}
                  >
                    {w.provider === "claude" ? "C" : "X"}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[12px] text-[var(--mx-text)]">
                    {w.id}
                  </span>
                  {/* busy 状态点 + 文案(按 tabId 反查注册表) */}
                  <span className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--mx-muted)]">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${k === "running" ? "animate-pulse" : ""}`}
                      style={{ background: statusColor(k) }}
                    />
                    {statusLabel(k)}
                  </span>
                  <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--mx-faint)]">
                    {t("fleet.panel.changed", { n: w.changedFiles })}
                  </span>
                </div>
                {/* 行 2:分支 + ±行数 + 操作 */}
                <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--mx-faint)]">
                  <span className="min-w-0 truncate font-mono" title={w.branch}>⎇ {w.branch}</span>
                  {w.changedFiles > 0 && (
                    <span className="shrink-0 tabular-nums">
                      <span className="text-[var(--mx-success-bright)]">+{w.addedLines}</span>
                      {" / "}
                      <span className="text-[var(--mx-danger)]">−{w.removedLines}</span>
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {w.tabId && onFocusFleetTab && (
                      <Button size="xs" variant="ghost" onClick={() => onFocusFleetTab(projectId, w.tabId!)}>
                        {t("fleet.panel.focus")}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyId === w.id}
                      onClick={() => startMerge(w)}
                    >
                      {t("fleet.panel.merge")}
                    </Button>
                    <Button
                      size="xs"
                      variant="danger"
                      disabled={busyId === w.id}
                      onClick={() => void handleRemove(w)}
                    >
                      {t("fleet.panel.remove")}
                    </Button>
                  </span>
                </div>
                {/* 孤儿警示:worktree 目录被外部删除,diff/合并都不可信 */}
                {!w.worktreeExists && (
                  <div className="mt-1 text-[10px] text-[var(--mx-danger)]">
                    {t("fleet.panel.orphan")}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 外部 worktree(`-fleet/` 目录下无记录的残留):只提供删除,不参与合并 */}
      {external && external.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--mx-faint)]">
            {t("fleet.panel.externalTitle")}
          </div>
          <div className="mt-1 flex flex-col gap-1.5">
            {external.map((w) => (
              <div
                key={w.worktreePath}
                className="rounded-[var(--mx-radius-md)] border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-[12px] text-[var(--mx-text)]">
                    {w.name}
                  </span>
                  <span className="shrink-0 rounded border border-[var(--mx-border)] px-1 text-[9px] text-[var(--mx-faint)]">
                    {t("fleet.panel.externalBadge")}
                  </span>
                  <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--mx-faint)]">
                    {t("fleet.panel.changed", { n: w.changedFiles })}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--mx-faint)]">
                  <span className="min-w-0 truncate font-mono" title={w.branch ?? undefined}>
                    ⎇ {w.branch ?? t("fleet.panel.detached")}
                  </span>
                  {w.changedFiles > 0 && (
                    <span className="shrink-0 tabular-nums">
                      <span className="text-[var(--mx-success-bright)]">+{w.addedLines}</span>
                      {" / "}
                      <span className="text-[var(--mx-danger)]">−{w.removedLines}</span>
                    </span>
                  )}
                  <span className="ml-auto shrink-0">
                    <Button
                      size="xs"
                      variant="danger"
                      disabled={removingExt === w.worktreePath}
                      onClick={() => void handleRemoveExt(w)}
                    >
                      {t("fleet.panel.remove")}
                    </Button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* 操作错误内联(合并/丢弃的 Err,含旧 git 不支持 merge-tree 的降级提示) */}
      {actionError && (
        <div className="mt-2 whitespace-pre-wrap break-words text-[11px] text-[var(--mx-danger)]">
          {actionError}
        </div>
      )}

      {/* 合并确认 Dialog(preview 拉取中先不弹,拿到结果再弹;Radix 一次只能一个 open) */}
      <Dialog open={mergeTarget !== null && mergePreview !== null} onOpenChange={(o) => !o && setMergeTarget(null)}>
        <DialogContent className="w-[440px] max-w-[90vw] px-5 py-4">
          <DialogTitle className="text-sm font-semibold text-[var(--mx-text)]">
            {t("fleet.panel.mergePreviewTitle")}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[11px] leading-relaxed text-[var(--mx-muted)]">
            {t("fleet.panel.mergePreviewDesc")}
          </DialogDescription>

          {/* 待合并对象 */}
          <div className="mt-3 rounded-[var(--mx-radius-md)] border border-[var(--mx-border-strong)] bg-[var(--mx-surface-2)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--mx-text)]">
            <div>⎇ {mergeTarget?.branch}</div>
            <div className="mt-0.5 text-[var(--mx-faint)]">
              {mergeTarget ? t("fleet.panel.changed", { n: mergeTarget.changedFiles }) : ""}
            </div>
          </div>

          {/* 主仓不干净:合并前须先处理 */}
          {mergePreview?.dirty && (
            <div className="mt-2 rounded-[var(--mx-radius-md)] border border-[var(--mx-danger-border)] bg-[var(--mx-danger-bg)] px-2.5 py-1.5 text-[11px] leading-relaxed text-[var(--mx-danger)]">
              {t("fleet.panel.dirtyWarning")}
            </div>
          )}

          {/* 冲突预判列表(空 = 可干净合并) */}
          {mergePreview && mergePreview.conflicts.length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] text-[var(--mx-muted)]">
                {t("fleet.panel.conflictsTitle", { n: mergePreview.conflicts.length })}
              </div>
              <div className="mt-1 max-h-[140px] overflow-auto rounded-[var(--mx-radius-md)] border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2.5 py-1.5">
                {mergePreview.conflicts.map((f) => (
                  <div key={f} className="truncate font-mono text-[11px] text-[var(--mx-danger)]">
                    {f}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={merging} onClick={() => setMergeTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="default" size="sm" disabled={merging} onClick={() => void confirmMerge()}>
              {merging ? t("fleet.create.creating") : t("fleet.panel.merge")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
