/**
 * DecisionPanel —— 决策流(v2:决策卡时间线 + 代批流水;v2.3 加状态/类型删选 chips)。
 *
 * suggestion:采纳(ack 关卡 + 文本/目标预填左栏派活区,人按投递——2026-11-16 重组,
 *   「决策流不只是看」)/ 直接发送(accept 代发)/ 编辑后采纳 / 拒绝(触发纠偏提炼);
 * dispatch:taskId/provider 可编辑,「创建 worker 并派活」走 conductor_dispatch_accept
 *   (后端建 worktree + 广播 fleet-dispatch,主窗口自动挂 tab + 注入首条指令);
 * ask_human:选项按钮(所选答案记入卡文本)或直接已知悉;
 * memory_candidate:记住(确认条目 + 关卡)/ 丢弃(删条目 + 关卡);
 * verdict(验收回环,自动驾驶一期):验收结果信息卡,verdict 徽标一眼可辨
 *   (通过绿/失败红/返工琥珀/挂起灰);建议返工卡可「代发返工」(edit 分支
 *   发指令 + 重新登记验收),其余「知道了」关卡。
 * 发送经后端 send_to_session(claude 长进程 stdin 或 codex 每轮 spawn),失败报错保留卡。
 * 底部代批流水(原概览段并入):自动批了哪些、哪些转人了。
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type {
  ConductorSession,
  DecisionKind,
  DecisionRecord,
  DecisionSource,
  DecisionStatus,
  InboxItem,
  MemoryEntry,
  PendingVerdictView,
  PlanRecord,
  PlanStatus,
  PlanStepStatus,
} from "../domain/conductor";
import { relativeTime, stampOf } from "./ui";

/** 来源徽标色(brain=accent,降级=琥珀,manual=灰)。 */
const SOURCE_COLOR: Record<DecisionSource, string> = {
  brain: "var(--mx-accent)",
  inbox_downgrade: "#f59e0b",
  manual: "var(--mx-muted)",
};
/** 状态徽标色。 */
const STATUS_COLOR: Record<DecisionStatus, string> = {
  proposed: "#f59e0b",
  accepted: "#22c55e",
  rejected: "var(--mx-muted)",
  expired: "var(--mx-muted)",
};

/** 验收回环卡的 verdict 徽标色(自动驾驶一期):通过绿/失败红/返工琥珀/挂起灰。 */
const VERDICT_COLOR: Record<string, string> = {
  success: "#22c55e",
  failed: "#ef4444",
  rework: "#f59e0b",
  pending: "#8b8f98",
};

/** 卡类型徽标色(2026-11-16 用户:「标识建议等不够明显,没法一眼看出来」):
 *  建议金/派活蓝/提问琥珀/记忆紫/验收灰(verdict 卡另有按结果的彩色徽标)。 */
const KIND_COLOR: Record<DecisionKind, string> = {
  suggestion: "var(--mx-accent)",
  dispatch: "#3b82f6",
  ask_human: "#f59e0b",
  memory_candidate: "#a78bfa",
  verdict: "var(--mx-muted)",
};

/** 状态筛选项:全部 / 待处理(proposed)/ 已处理(accepted/rejected/expired)。 */
type StatusFilter = "all" | "proposed" | "handled";
/** 类型筛选下拉选项(多选;空集 = 全部)。 */
const KIND_OPTIONS: DecisionKind[] = [
  "suggestion",
  "dispatch",
  "ask_human",
  "memory_candidate",
  "verdict",
];

export function DecisionPanel({
  decisions,
  memories,
  brainError,
  plans,
  pendingVerdicts,
  inbox,
  sessions,
  projects,
  onChanged,
  onAdopt,
}: {
  decisions: DecisionRecord[];
  memories: MemoryEntry[];
  /** 大脑最近一次失败原因(快照下发;null = 正常)。决策流空着时直接展示,不再静默。 */
  brainError: string | null;
  /** 编排计划(P3b,新的在前;旧后端缺 = undefined,兜底 [])。 */
  plans?: PlanRecord[];
  /** 运行中任务(待验收记录):顶部「运行中」实时区数据源。 */
  pendingVerdicts: PendingVerdictView[];
  /** 孵化条目(只消费 queued 排队中的,与运行中同区展示)。 */
  inbox: InboxItem[];
  /** 会话状态表(项目名/pane 标题富化 + 运行态点色)。 */
  sessions: ConductorSession[];
  /** 全量项目(id/name;项目筛选 chips + 卡面项目徽标映射)。 */
  projects: { id: string; name: string }[];
  onChanged: () => void;
  /** 建议「采纳」:预填左栏派活区(text + 目标)。Shell 注入;卡走 ack 不代发。 */
  onAdopt: (text: string, projectId: string | null, tabId: string | null) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 删选(2026-11-18 用户:「筛选改下拉框、支持多选;标签行会滚」):状态=单选下拉,
  // 类型/项目=多选下拉(空集=全部)。只滤显示不动数据;项目维沿用 2026-11-17 语义
  // (「涌现流按项目分开——只有同一项目的同一个 AI pane 才需要排队执行」)。
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [kindSel, setKindSel] = useState<Set<DecisionKind>>(() => new Set());
  const [projectSel, setProjectSel] = useState<Set<string>>(() => new Set());

  // 项目名映射(projects 全量表;会话行的富化名兜底)与 tabId → 会话表。
  const projectNameOf = (projectId: string | null): string | null => {
    if (!projectId) return null;
    return projects.find((p) => p.id === projectId)?.name ?? projectId;
  };
  // 会话表键 = `projectId/tabId` 复合——tabId 仅项目内唯一(各项目都有 ai-1),
  // 裸键会拿到别的项目同名会话的状态(2026-11-17 tabId 撞名残留,前端侧修正)。
  const sessionByTab = new Map(sessions.map((s) => [`${s.projectId}/${s.tabId}`, s]));
  const hitProject = (projectId: string | null | undefined) =>
    projectSel.size === 0 || !projectId || projectSel.has(projectId);

  const filtered = decisions.filter((d) => {
    if (statusFilter === "proposed" && d.status !== "proposed") return false;
    if (statusFilter === "handled" && d.status === "proposed") return false;
    if (kindSel.size > 0 && !kindSel.has(d.kind)) return false;
    if (!hitProject(d.targetProjectId)) return false;
    return true;
  });
  // 运行中任务 / 排队条目 / 编排卡:同一项目维过滤(跨 pane 不互斥,切项目看
  // 「这条链跑到哪了」)。代批流水已移左栏(不再随项目筛选,全局审计口径)。
  const runningTasks = pendingVerdicts.filter((p) => hitProject(p.projectId));
  const queuedItems = inbox.filter(
    (i) => i.status === "queued" && i.targets.some((t) => hitProject(t.projectId)),
  );
  const visiblePlans = (plans ?? []).filter((p) => hitProject(p.target.projectId));

  const wrap = async (id: string, fn: () => Promise<unknown>) => {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(String(e).replace(/^Error\b:?\s*/i, ""));
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  /** 通用 respond(suggestion 的 accept/reject、ask_human 的 ack 与 verdict 卡的 edit 代发返工)。
   *  permissionCeiling(P2c):accept 时随派活登记权限上限,任务终态自动收回。 */
  const respond = (
    id: string,
    action: "accept" | "edit" | "reject" | "ack",
    editedText?: string,
    permissionCeiling?: "confirm" | "deny" | null,
  ) =>
    wrap(id, () =>
      invoke("conductor_decision_respond", {
        id,
        action,
        editedText: editedText ?? null,
        permissionCeiling: permissionCeiling ?? null,
      }),
    );

  /** dispatch 卡确认:创建 worker 并派活(失败如 taskId 重名 → 报错,卡保留可改)。 */
  const dispatchAccept = (id: string, taskId: string, provider: string, text: string) =>
    wrap(id, () =>
      invoke("conductor_dispatch_accept", {
        id,
        taskId: taskId.trim() || null,
        provider,
        editedText: text.trim() || null,
      }),
    );

  /** P4b 续段卡确认:按下一段意图建新接力计划 + ack 关卡(建计划即动作,
   *  不往会话直接发文本——续段要走验收回环,裸发送等于绕过接力)。 */
  const planAccept = (
    id: string,
    goal: string,
    projectId: string,
    tabId: string,
    ceiling: "confirm" | "deny" | null,
  ) =>
    wrap(id, async () => {
      await invoke("conductor_plan_create", {
        goal,
        projectId,
        tabId,
        permissionCeiling: ceiling,
      });
      await invoke("conductor_decision_respond", {
        id,
        action: "ack",
        editedText: null,
        permissionCeiling: null,
      });
    });

  /** memory_candidate:记住 = 确认条目 + ack 关卡。 */
  const memoryKeep = (id: string, entryId: string) =>
    wrap(id, async () => {
      await invoke("conductor_memory_confirm", { id: entryId });
      await invoke("conductor_decision_respond", { id, action: "ack", editedText: null });
    });

  /** memory_candidate:丢弃 = 删条目 + reject 关卡(候选不触发纠偏提炼)。 */
  const memoryDrop = (id: string, entryId: string) =>
    wrap(id, async () => {
      await invoke("conductor_memory_delete", { id: entryId });
      await invoke("conductor_decision_respond", { id, action: "reject", editedText: null });
    });

  /** 手动删卡(纯记录清理,无业务副作用;区别于 reject 的纠偏提炼)。 */
  const removeCard = (id: string) => wrap(id, () => invoke("conductor_decision_remove", { id }));

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {error && (
        <div className="mx-chip bg-[#ef44441a] px-2.5 py-1.5 text-xs text-[#ef4444]">
          <span className="min-w-0 flex-1 break-all">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 shrink-0 cursor-pointer opacity-70 hover:opacity-100"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {/* 删选行(2026-11-18 下拉化):状态(单选)/ 类型(多选)/ 项目(多选)三个下拉,
          替代原 chips 行——项目多了 chips 会横向滚动(用户实测),下拉固定三枚不涨。
          语义:多选空集=全部;「全部」行 = 清空该维。 */}
      <div className="flex shrink-0 flex-nowrap items-center gap-1.5">
        <FilterDropdown
          label={t("conductor.decision.filterStatus")}
          options={[
            { value: "proposed", label: t("conductor.decision.filterProposed") },
            { value: "handled", label: t("conductor.decision.filterHandled") },
          ]}
          selected={statusFilter === "all" ? new Set() : new Set([statusFilter])}
          onPick={(v) => setStatusFilter((v || "all") as StatusFilter)}
          closeOnPick
        />
        <FilterDropdown
          label={t("conductor.decision.filterKind")}
          options={KIND_OPTIONS.map((v) => ({ value: v, label: t(`conductor.decision.kind.${v}`) }))}
          selected={kindSel}
          onPick={(v) =>
            setKindSel((prev) => {
              const next = new Set(prev);
              if (next.has(v as DecisionKind)) next.delete(v as DecisionKind);
              else next.add(v as DecisionKind);
              return next;
            })
          }
        />
        {projects.length > 0 && (
          <FilterDropdown
            label={t("conductor.decision.filterProject")}
            options={projects.map((p) => ({ value: p.id, label: p.name || p.id }))}
            selected={projectSel}
            onPick={(v) =>
              setProjectSel((prev) => {
                const next = new Set(prev);
                if (next.has(v)) next.delete(v);
                else next.add(v);
                return next;
              })
            }
          />
        )}
      </div>
      <div className="mx-scroll-pretty min-h-0 flex-1 overflow-y-auto">
        {/* 运行中 + 排队实时区(2026-11-17 用户:「涌现流要展示运行中的任务,投递进来的
            任务也要展示」):投出待验收 = 运行中;占用排队 = 等空闲补投。置顶于一切卡之前。
            限高内滚(2026-11-19 用户:「不用这展示这么多」)——行多了不挤压决策卡。 */}
        {(runningTasks.length > 0 || queuedItems.length > 0) && (
          <div className="mx-scroll-pretty mb-2 flex max-h-[120px] flex-col gap-1 overflow-y-auto">
            {runningTasks.map((p) => {
              const s = sessionByTab.get(`${p.projectId}/${p.tabId}`);
              const running = s?.kind === "running" || s?.kind === "waiting_approval";
              // 验收中(2026-11-18 拆步入口收敛后补直投场景):会话终态 + 待验收未结算
              // = 智核 LLM 判定窗口期(数十秒)。此前 verifying 只有计划卡派生,直投
              // 任务这段空窗 UI 无提示,验收结果卡像凭空蹦出。i18n 复用 plan.verifying。
              const verifying = s?.kind === "finished" || s?.kind === "error";
              return (
                <div
                  key={`${p.tabId}-${p.dispatchedMs}`}
                  className="mx-chip flex items-center gap-2 border border-[var(--mx-border)] bg-[var(--mx-surface-soft)] px-2.5 py-1.5 text-xs"
                >
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full ${running ? "animate-pulse" : ""}`}
                    style={{ background: running ? "var(--mx-accent)" : "#f59e0b" }}
                  />
                  {verifying && (
                    <span className="shrink-0 text-[10px] text-[#f59e0b]">
                      {t("conductor.plan.verifying")}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[var(--mx-text)]" title={p.goal}>
                    {p.goal}
                  </span>
                  {p.planId && (
                    <span className="shrink-0 rounded-full bg-[var(--mx-accent-soft)] px-1.5 text-[10px] leading-4 text-[var(--mx-accent)]">
                      {t("conductor.feed.relayBadge")}
                    </span>
                  )}
                  {p.reworkCount > 0 && (
                    <span className="shrink-0 text-[10px] text-[#f59e0b]">
                      {t("conductor.feed.reworkCount", { n: p.reworkCount })}
                    </span>
                  )}
                  <span className="max-w-36 shrink-0 truncate text-[10px] text-[var(--mx-muted)]">
                    {projectNameOf(p.projectId) ?? p.projectId} · {s?.tabTitle || p.tabId}
                  </span>
                  <span
                    className="w-16 shrink-0 text-right tabular-nums text-[10px] text-[var(--mx-muted)] opacity-80"
                    title={new Date(p.dispatchedMs).toLocaleString()}
                  >
                    {t("conductor.feed.dispatchedAgo", { t: relativeTime(p.dispatchedMs, t) })}
                  </span>
                  {/* 撤销任务(2026-11-17:关掉 = 不再执行,在跑的中断)。 */}
                  <button
                    type="button"
                    aria-label={t("conductor.feed.stopTask")}
                    title={t("conductor.feed.stopTask")}
                    onClick={() =>
                      void (async () => {
                        try {
                          await invoke("conductor_task_cancel", { projectId: p.projectId, tabId: p.tabId });
                        } catch (e) {
                          console.error("task cancel failed", e);
                        }
                        onChanged();
                      })()
                    }
                    className="shrink-0 cursor-pointer text-[var(--mx-muted)] opacity-60 hover:text-[#ef4444] hover:opacity-100"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              );
            })}
            {queuedItems.map((i) => (
              <div
                key={i.id}
                className="mx-chip flex items-center gap-2 border border-[var(--mx-border)] bg-[var(--mx-surface-soft)] px-2.5 py-1.5 text-xs"
              >
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: "#3b82f6" }} />
                <span className="min-w-0 flex-1 truncate text-[var(--mx-text)]" title={i.text}>
                  {i.text}
                </span>
                <span className="shrink-0 text-[10px] text-[#3b82f6]">{t("conductor.inbox.status.queued")}</span>
                <span className="max-w-36 shrink-0 truncate text-[10px] text-[var(--mx-muted)]">
                  {i.targets
                    .map((x) => projectNameOf(x.projectId) ?? x.projectId)
                    .filter((v, idx, arr) => arr.indexOf(v) === idx)
                    .join(", ")}
                </span>
                <span
                  className="w-16 shrink-0 text-right tabular-nums text-[10px] text-[var(--mx-muted)] opacity-80"
                  title={new Date(i.createdMs).toLocaleString()}
                >
                  {relativeTime(i.createdMs, t)}
                </span>
                {/* 取消排队(2026-11-17:关掉 = 不再自动补投)。 */}
                <button
                  type="button"
                  aria-label={t("conductor.feed.queuedCancel")}
                  title={t("conductor.feed.queuedCancel")}
                  onClick={() =>
                    void (async () => {
                      try {
                        await invoke("conductor_inbox_remove", { id: i.id });
                      } catch (e) {
                        console.error("queued cancel failed", e);
                      }
                      onChanged();
                    })()
                  }
                  className="shrink-0 cursor-pointer text-[var(--mx-muted)] opacity-60 hover:text-[#ef4444] hover:opacity-100"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {/* 编排卡(P3b):多步接力计划,置顶于决策卡之前。 */}
        {visiblePlans.length > 0 && (
          <ul className="mb-2 flex flex-col gap-1.5">
            {visiblePlans.map((p) => (
              <PlanCard
                key={p.id}
                plan={p}
                projectNameOf={projectNameOf}
                onChanged={onChanged}
                verifying={
                  p.status === "running" &&
                  pendingVerdicts.some((v) => v.planId === p.id) &&
                  ["finished", "error"].includes(
                    sessionByTab.get(`${p.target.projectId}/${p.target.tabId}`)?.kind ?? "",
                  )
                }
              />
            ))}
          </ul>
        )}
        {decisions.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <div className="text-xs text-[var(--mx-muted)]">{t("conductor.decision.empty")}</div>
            <div className="text-[11px] text-[var(--mx-muted)] opacity-70">{t("conductor.decision.emptyHint")}</div>
            {brainError && (
              <div className="mx-chip mt-1 max-w-md bg-[#f59e0b1a] px-2.5 py-1.5 text-xs text-[#f59e0b]">
                <span className="min-w-0 break-all">{t("conductor.decision.brainError")}</span>
                <span className="break-all text-[var(--mx-muted)]">{brainError}</span>
              </div>
            )}
          </div>
        ) : filtered.length === 0 ? (
          // 有卡但被筛没:轻提示(区别于全空态)。
          <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-[var(--mx-muted)] opacity-70">
            {t("conductor.decision.filterEmpty")}
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {filtered.map((d) => (
              <DecisionCard
                key={d.id}
                card={d}
                memories={memories}
                busy={busyId === d.id}
                disabled={busyId !== null}
                projectNameOf={projectNameOf}
                onRespond={respond}
                onDispatchAccept={dispatchAccept}
                onPlanAccept={planAccept}
                onMemoryKeep={memoryKeep}
                onMemoryDrop={memoryDrop}
                onAdopt={onAdopt}
                onRemove={removeCard}
              />
            ))}
          </ul>
        )}
      </div>
      {/* 代批流水已移左栏项目动态下方(2026-11-19,用户:「放项目状态下面,占比 36%,
          这样感觉合理」)——决策流整栏让给卡片,流水不再挤占底部。 */}
    </div>
  );
}

type RespondFn = (
  id: string,
  action: "accept" | "edit" | "reject" | "ack",
  editedText?: string,
  permissionCeiling?: "confirm" | "deny" | null,
) => Promise<void>;

/** 单张决策卡:按 kind 分流动作区;suggestion/dispatch 共用编辑态(后者多 taskId/provider)。 */
function DecisionCard({
  card,
  memories,
  busy,
  disabled,
  projectNameOf,
  onRespond,
  onDispatchAccept,
  onPlanAccept,
  onMemoryKeep,
  onMemoryDrop,
  onAdopt,
  onRemove,
}: {
  card: DecisionRecord;
  memories: MemoryEntry[];
  busy: boolean;
  disabled: boolean;
  /** 项目名映射(2026-11-17 用户:「快速区分是哪个项目」):摘要行项目徽标。 */
  projectNameOf: (projectId: string | null) => string | null;
  onRespond: RespondFn;
  onDispatchAccept: (id: string, taskId: string, provider: string, text: string) => Promise<void>;
  onPlanAccept: (
    id: string,
    goal: string,
    projectId: string,
    tabId: string,
    ceiling: "confirm" | "deny" | null,
  ) => Promise<void>;
  onMemoryKeep: (id: string, entryId: string) => Promise<void>;
  onMemoryDrop: (id: string, entryId: string) => Promise<void>;
  onAdopt: (text: string, projectId: string | null, tabId: string | null) => void;
  onRemove: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(card.text);
  // dispatch 卡编辑态的 taskId / provider(payload 预填)。
  const [taskId, setTaskId] = useState(card.payload?.taskId ?? "");
  const [provider, setProvider] = useState(card.payload?.provider ?? "claude");
  // 权限上限(P2c):建议卡「直接发送」时随派活登记;"" = 不限制(默认)。
  const [ceiling, setCeiling] = useState<"" | "confirm" | "deny">("");
  // 正文限高(max-h-40)溢出检测(2026-11-16 用户:「继续决策下面的内容」):被截断时
  // 显示「展开全部」,点击不限高看完整内容——验收卡 goal+判定、长建议常触底。
  const bodyRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [card.text]);

  const startEdit = () => {
    setEditText(card.text);
    setEditing(true);
  };

  /** P4b 续段卡(payload.planContinue):主动作换成「发起接力」(建新计划),
   *  不给「直接发送」——续段必须走验收回环。 */
  const isPlanContinue = card.payload?.planContinue === true;

  /** 依据记忆 chips(id → content 摘要,悬停看全文)。 */
  const basis = card.usedMemoryIds
    .map((id) => memories.find((m) => m.id === id))
    .filter((m): m is MemoryEntry => Boolean(m));

  // 已处理卡(accepted/rejected/expired)整体淡化:proposed 待决的视觉优先,历史退后。
  const handled = card.status !== "proposed";
  return (
    <li
      className={`mx-chip group/card flex flex-col gap-1.5 border bg-[var(--mx-surface-soft)] px-2.5 py-2 text-xs transition-colors ${
        handled ? "border-transparent opacity-60 hover:opacity-100" : "border-[var(--mx-border)]"
      }`}
    >
      {/* 摘要行:状态点 + 摘要 + kind 标签 + 自动徽标 + 来源/状态 + 时间 + hover 删除。 */}
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[card.status] }} />
        <span className="min-w-0 flex-1 truncate text-[var(--mx-text-bright)]" title={card.summary}>
          {card.summary}
        </span>
        {/* 项目徽标(2026-11-17 用户:「快速区分是哪个项目」):目标会话所属项目;
            无目标(全局面包屑类卡)不显示。 */}
        {projectNameOf(card.targetProjectId) && (
          <span
            className="max-w-24 shrink-0 truncate rounded-full bg-[var(--mx-hover-bg)] px-1.5 text-[10px] leading-4 text-[var(--mx-muted)]"
            title={projectNameOf(card.targetProjectId) ?? ""}
          >
            {projectNameOf(card.targetProjectId)}
          </span>
        )}
        {/* 类型徽标(全 kind 带色,建议也显示——2026-11-16 用户「没法一眼看出来」)。 */}
        <span
          className="shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4"
          style={{
            color: KIND_COLOR[card.kind] ?? "var(--mx-muted)",
            background: "color-mix(in srgb, currentColor 12%, transparent)",
          }}
        >
          {t(`conductor.decision.kind.${card.kind}`)}
        </span>
        {card.kind === "verdict" && card.payload?.verdict && (
          <span
            className="shrink-0 rounded-full px-1.5 text-[10px] leading-4"
            style={{
              color: VERDICT_COLOR[card.payload.verdict] ?? "var(--mx-muted)",
              background: "color-mix(in srgb, currentColor 12%, transparent)",
            }}
          >
            {t(`conductor.decision.verdict.${card.payload.verdict}`)}
          </span>
        )}
        {card.payload?.auto && (
          <span
            className="shrink-0 rounded-full bg-[var(--mx-accent-soft)] px-1.5 text-[10px] leading-4 text-[var(--mx-accent)]"
            title={t("conductor.decision.autoBadgeHint")}
          >
            {t("conductor.decision.autoBadge")}
          </span>
        )}
        <span className="shrink-0 text-[var(--mx-muted)]" style={{ color: SOURCE_COLOR[card.source] }}>
          {t(`conductor.decision.source.${card.source}`)}
        </span>
        <span className="shrink-0 font-medium" style={{ color: STATUS_COLOR[card.status] }}>
          {t(`conductor.decision.status.${card.status}`)}
        </span>
        <span
          className="shrink-0 text-right text-[var(--mx-muted)] tabular-nums opacity-80"
          title={new Date(card.createdMs).toLocaleString()}
        >
          {stampOf(card.createdMs)} · {relativeTime(card.createdMs, t)}
        </span>
        {/* 手动删卡:hover 浮现,一键清记录(无业务副作用)。 */}
        <button
          type="button"
          aria-label={t("conductor.decision.remove")}
          title={t("conductor.decision.remove")}
          disabled={disabled || busy}
          onClick={() => void onRemove(card.id)}
          className="shrink-0 cursor-pointer text-[var(--mx-muted)] opacity-0 transition-opacity hover:text-[#ef4444] focus-visible:opacity-100 disabled:cursor-default disabled:opacity-30 group-hover/card:opacity-100"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {/* 正文(whitespace 保留;默认限高内部滚动防长文淹没列表,溢出时给「展开全部」)。 */}
      <div
        ref={bodyRef}
        className={`mx-scroll-pretty break-all whitespace-pre-wrap pl-4 text-[var(--mx-text)] ${
          expanded ? "" : "max-h-40 overflow-y-auto"
        }`}
        title={card.text}
      >
        {card.text}
      </div>
      {(clipped || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="cursor-pointer self-start pl-4 text-[10px] text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-accent)]"
        >
          {expanded ? t("conductor.decision.collapse") : t("conductor.decision.expand")}
        </button>
      )}
      {/* 依据记忆 chips(P2:可解释、可审计,错了知道删哪条)。 */}
      {basis.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pl-4">
          <span className="text-[10px] text-[var(--mx-muted)] opacity-70">{t("conductor.decision.basis")}</span>
          {basis.map((m) => (
            <span
              key={m.id}
              title={m.content}
              className="max-w-[16rem] truncate rounded-full bg-[var(--mx-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--mx-accent)]"
            >
              {m.content}
            </span>
          ))}
        </div>
      )}

      {/* ---- suggestion:采纳(预填派活区)/直接发送/编辑后采纳/拒绝。v2 主按钮改「采纳」:
       *    决策流不只是看——建议落到派活输入区,人确认目标按投递(人在回路保留)。
       *    P4b 续段卡(planContinue):主按钮换「发起接力」(按下一段意图建新计划),
       *    且不给「直接发送」——续段要走验收回环,裸发送绕过接力。 */}
      {card.status === "proposed" && card.kind === "suggestion" && !editing && (
        <div className="flex items-center gap-1.5 pl-4">
          {isPlanContinue ? (
            <button
              type="button"
              disabled={disabled || busy || !card.targetProjectId || !card.targetSessionId}
              title={t("conductor.decision.planAcceptHint")}
              onClick={() =>
                void onPlanAccept(
                  card.id,
                  card.payload?.nextGoal || card.text,
                  card.targetProjectId ?? "",
                  card.targetSessionId ?? "",
                  ceiling || null,
                )
              }
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-2.5 text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
            >
              {busy ? t("conductor.decision.creating") : t("conductor.decision.planAccept")}
            </button>
          ) : (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => {
                onAdopt(card.text, card.targetProjectId, card.targetSessionId);
                void onRespond(card.id, "ack", t("conductor.decision.adoptMark"));
              }}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-2.5 text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
            >
              {t("conductor.decision.adopt")}
            </button>
          )}
          <select
            value={ceiling}
            onChange={(e) => setCeiling(e.target.value as "" | "confirm" | "deny")}
            title={t("conductor.decision.ceilingHint")}
            className="mx-chip h-7 max-w-28 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-1 text-[11px] text-[var(--mx-text)] outline-none"
            aria-label={t("conductor.decision.ceilingHint")}
          >
            <option value="">{t("conductor.quick.ceilingNone")}</option>
            <option value="confirm">{t("conductor.quick.ceilingConfirm")}</option>
            <option value="deny">{t("conductor.quick.ceilingDeny")}</option>
          </select>
          {!isPlanContinue && (
            <button
              type="button"
              disabled={disabled || busy}
              title={t("conductor.decision.sendDirectHint")}
              onClick={() => void onRespond(card.id, "accept", undefined, ceiling || null)}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
            >
              {busy ? t("conductor.decision.sending") : t("conductor.decision.sendDirect")}
            </button>
          )}
          <button
            type="button"
            disabled={disabled || busy}
            onClick={startEdit}
            className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
          >
            {t("conductor.decision.edit")}
          </button>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => {
              if (window.confirm(t("conductor.decision.confirmReject"))) void onRespond(card.id, "reject");
            }}
            className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[#ef4444] disabled:cursor-default disabled:opacity-40"
          >
            {t("conductor.decision.reject")}
          </button>
        </div>
      )}

      {/* ---- dispatch:taskId/provider 可改,创建 worker 并派活 / 丢弃;编辑态展开指令。 */}
      {card.status === "proposed" && card.kind === "dispatch" && !editing && (
        <div className="flex flex-col gap-1.5 pl-4">
          <div className="flex items-center gap-1.5">
            <input
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              placeholder="task id"
              className="mx-chip h-7 w-36 shrink-0 bg-[var(--mx-hover-bg)] px-2 text-xs text-[var(--mx-text)] outline-none focus:ring-1 focus:ring-[var(--mx-accent)]"
              aria-label={t("conductor.decision.taskId")}
            />
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="mx-chip h-7 shrink-0 bg-[var(--mx-hover-bg)] px-1.5 text-xs text-[var(--mx-text)] outline-none"
              aria-label={t("conductor.decision.provider")}
            >
              <option value="claude">claude</option>
              <option value="codex">codex</option>
            </select>
            <button
              type="button"
              disabled={disabled || busy || !taskId.trim()}
              onClick={() => void onDispatchAccept(card.id, taskId, provider, card.text)}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-2.5 text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
            >
              {busy ? t("conductor.decision.creating") : t("conductor.decision.dispatchAccept")}
            </button>
            <button
              type="button"
              disabled={disabled || busy}
              onClick={startEdit}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
            >
              {t("conductor.decision.editTask")}
            </button>
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => void onRespond(card.id, "reject")}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[#ef4444] disabled:cursor-default disabled:opacity-40"
            >
              {t("conductor.decision.drop")}
            </button>
          </div>
        </div>
      )}

      {/* ---- ask_human:选项按钮(答案记入卡)/ 无选项已知悉。 */}
      {card.status === "proposed" && card.kind === "ask_human" && (
        <div className="flex flex-wrap items-center gap-1.5 pl-4">
          {(card.payload?.options ?? []).map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={disabled || busy}
              onClick={() => void onRespond(card.id, "ack", opt)}
              className="mx-chip h-7 cursor-pointer bg-[var(--mx-accent-soft)] px-2.5 text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
            >
              {opt}
            </button>
          ))}
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void onRespond(card.id, "ack")}
            className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
          >
            {t("conductor.decision.acknowledge")}
          </button>
        </div>
      )}

      {/* ---- verdict(验收回环,自动驾驶一期):信息性卡,failed/挂起「知道了」关卡;
       *      建议返工卡带 rework 指令时「代发返工」可一键补发——走 edit 分支把指令
       *      发给目标会话并重新登记验收(人手动返工 = 重置返工预算,允许再一轮自动返工)。 */}
      {card.status === "proposed" && card.kind === "verdict" && (
        <div className="flex items-center gap-1.5 pl-4">
          {card.payload?.rework?.trim() && (
            <button
              type="button"
              disabled={disabled || busy}
              title={t("conductor.decision.sendReworkHint")}
              onClick={() => void onRespond(card.id, "edit", card.payload!.rework)}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-2.5 text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
            >
              {busy ? t("conductor.decision.sending") : t("conductor.decision.sendRework")}
            </button>
          )}
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void onRespond(card.id, "ack")}
            className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
          >
            {t("conductor.decision.acknowledge")}
          </button>
        </div>
      )}

      {/* ---- memory_candidate:记住 / 丢弃。 */}
      {card.status === "proposed" && card.kind === "memory_candidate" && card.payload?.entryId && (
        <div className="flex items-center gap-1.5 pl-4">
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void onMemoryKeep(card.id, card.payload!.entryId!)}
            className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-2.5 text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
          >
            {t("conductor.decision.memoryKeep")}
          </button>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void onMemoryDrop(card.id, card.payload!.entryId!)}
            className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[#ef4444] disabled:cursor-default disabled:opacity-40"
          >
            {t("conductor.decision.memoryDrop")}
          </button>
        </div>
      )}

      {/* 编辑态:textarea + 保存(suggestion=改后采纳预填;dispatch=创建)+ 取消。 */}
      {editing && (
        <div className="flex flex-col gap-1.5 pl-4">
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={3}
            autoFocus
            className="mx-chip w-full resize-y bg-[var(--mx-hover-bg)] px-2 py-1.5 text-xs text-[var(--mx-text)] outline-none focus:ring-1 focus:ring-[var(--mx-accent)]"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!editText.trim() || busy || (card.kind === "dispatch" && !taskId.trim())}
              onClick={() => {
                setEditing(false);
                if (card.kind === "dispatch") {
                  void onDispatchAccept(card.id, taskId, provider, editText.trim());
                } else if (isPlanContinue) {
                  // P4b 续段卡改后确认:按改写的下一段意图直接建计划。
                  void onPlanAccept(
                    card.id,
                    editText.trim(),
                    card.targetProjectId ?? "",
                    card.targetSessionId ?? "",
                    ceiling || null,
                  );
                } else {
                  // suggestion 改后采纳:预填派活区(改写文本)+ ack 关卡,不代发。
                  onAdopt(editText.trim(), card.targetProjectId, card.targetSessionId);
                  void onRespond(card.id, "ack", t("conductor.decision.adoptMark"));
                }
              }}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-2.5 text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
            >
              {busy
                ? t("conductor.decision.sending")
                : card.kind === "dispatch"
                  ? t("conductor.decision.dispatchAccept")
                  : isPlanContinue
                    ? t("conductor.decision.planAccept")
                    : t("conductor.decision.adopt")}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
            >
              {t("conductor.decision.cancel")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** 编排计划状态徽标色(P3b):接力蓝/暂停琥珀/停止红/完成绿。 */
const PLAN_STATUS_COLOR: Record<PlanStatus, string> = {
  running: "#3b82f6",
  paused: "#f59e0b",
  halted: "#ef4444",
  finished: "#22c55e",
};
/** 编排步状态点色:待发灰/派发蓝呼吸/通过绿/失败红/跳过灰。 */
const STEP_COLOR: Record<PlanStepStatus, string> = {
  queued: "var(--mx-muted)",
  running: "#3b82f6",
  done: "#22c55e",
  failed: "#ef4444",
  skipped: "var(--mx-muted)",
};

/**
 * 编排卡(P3b,三期设计 §4):goal + 步骤清单(序号/状态色点/单行文本),
 * running 步呼吸光点,halted 红边 + haltReason。动作面:暂停/恢复/终止/
 * 改指令重发(halted/paused,预填失败步文本调 conductor_plan_retry)。
 */
function PlanCard({
  plan,
  projectNameOf,
  onChanged,
  verifying,
}: {
  plan: PlanRecord;
  projectNameOf: (projectId: string | null) => string | null;
  onChanged: () => void;
  /** 验收中(2026-11-17):步已派发且目标会话已终态 = 智核验收 LLM 判定窗口
   *  (实测数秒到数十秒)。此前该窗口一律显示「拆步中」,用户以为状态卡住。 */
  verifying?: boolean;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryText, setRetryText] = useState("");
  const done = plan.steps.filter((s) => s.status === "done").length;
  const color = PLAN_STATUS_COLOR[plan.status];
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(String(e).replace(/^Error\b:?\s*/i, ""));
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const control = (action: "pause" | "resume" | "abort") =>
    run(() => invoke("conductor_plan_control", { id: plan.id, action }));
  // 改指令重发目标:第一个 failed 步,否则当前步(与后端 retry 同口径);"" = 原样重试。
  const failedStep = plan.steps.find((s) => s.status === "failed");
  const current = plan.steps.find((s) => s.status === "running") ?? plan.steps.find((s) => s.status === "queued");
  const retryTarget = failedStep ?? current;
  const sendRetry = () =>
    run(async () => {
      await invoke("conductor_plan_retry", { id: plan.id, text: retryText.trim() || null });
      setRetrying(false);
      setRetryText("");
    });
  return (
    <li
      className={`mx-chip flex flex-col gap-1.5 border bg-[var(--mx-surface-soft)] px-2.5 py-2 text-xs ${
        plan.status === "halted" ? "border-[#ef444466]" : "border-[var(--mx-border)]"
      }`}
    >
      {/* 头行:状态点 + goal + 进度 x/N + 状态徽标 + 时间。 */}
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${plan.status === "running" ? "mx-pulse-breath" : ""}`}
          style={{ background: verifying ? "#f59e0b" : color }}
        />
        <span className="min-w-0 flex-1 truncate text-[var(--mx-text-bright)]" title={plan.goal}>
          {plan.goal}
        </span>
        {/* 项目徽标(2026-11-17):快速区分计划属于哪个项目。 */}
        {projectNameOf(plan.target.projectId) && (
          <span
            className="max-w-24 shrink-0 truncate rounded-full bg-[var(--mx-hover-bg)] px-1.5 text-[10px] leading-4 text-[var(--mx-muted)]"
            title={projectNameOf(plan.target.projectId) ?? ""}
          >
            {projectNameOf(plan.target.projectId)}
          </span>
        )}
        <span className="shrink-0 tabular-nums text-[var(--mx-muted)]" title={t("conductor.plan.progressHint")}>
          {done}/{plan.steps.length}
        </span>
        <span
          className="shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4"
          style={{
            color: verifying ? "#f59e0b" : color,
            background: "color-mix(in srgb, currentColor 12%, transparent)",
          }}
        >
          {verifying ? t("conductor.plan.verifying") : t(`conductor.plan.status.${plan.status}`)}
        </span>
        <span
          className="shrink-0 text-right tabular-nums text-[var(--mx-muted)] opacity-80"
          title={new Date(plan.updatedMs).toLocaleString()}
        >
          {stampOf(plan.updatedMs)} · {relativeTime(plan.updatedMs, t)}
        </span>
      </div>
      {/* 步骤清单:序号 + 状态色点(running 呼吸)+ 单行文本(悬停全文)。 */}
      <ol className="flex flex-col gap-0.5 pl-4">
        {plan.steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-1.5 text-[11px]">
            <span aria-hidden className="w-3 shrink-0 text-right text-[var(--mx-muted)] opacity-70">
              {i + 1}.
            </span>
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.status === "running" ? "mx-pulse-breath" : ""}`}
              style={{ background: STEP_COLOR[s.status] }}
            />
            <span
              className={`min-w-0 flex-1 truncate ${
                s.status === "skipped"
                  ? "text-[var(--mx-muted)] line-through opacity-60"
                  : s.status === "failed"
                    ? "text-[#ef4444]"
                    : "text-[var(--mx-text)]"
              }`}
              title={s.text}
            >
              {s.text}
            </span>
          </li>
        ))}
      </ol>
      {plan.haltReason && (
        <div className="pl-4 text-[11px] text-[#ef4444]" title={plan.haltReason}>
          {t("conductor.plan.haltReason")}:{plan.haltReason}
        </div>
      )}
      {error && <div className="pl-4 text-[11px] text-[#ef4444]">{error}</div>}
      {/* 动作面:running→暂停/终止;paused→恢复/终止;halted→改指令重发/原样重试。 */}
      {plan.status !== "finished" && !retrying && (
        <div className="flex flex-wrap items-center gap-1.5 pl-4">
          {plan.status === "running" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void control("pause")}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
            >
              {t("conductor.plan.pause")}
            </button>
          )}
          {plan.status === "paused" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void control("resume")}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-2.5 text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
            >
              {t("conductor.plan.resume")}
            </button>
          )}
          {retryTarget && (plan.status === "halted" || plan.status === "paused") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRetryText(retryTarget.text);
                setRetrying(true);
              }}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
            >
              {t("conductor.plan.retryEdit")}
            </button>
          )}
          {plan.status === "halted" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => invoke("conductor_plan_retry", { id: plan.id, text: null }))}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
            >
              {t("conductor.plan.retry")}
            </button>
          )}
          {(plan.status === "running" || plan.status === "paused") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("conductor.plan.confirmAbort"))) void control("abort");
              }}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[#ef4444] disabled:cursor-default disabled:opacity-40"
            >
              {t("conductor.plan.abort")}
            </button>
          )}
        </div>
      )}
      {/* 改指令重发编辑态:预填失败步文本,清空 = 原样重试。 */}
      {retrying && (
        <div className="flex flex-col gap-1.5 pl-4">
          <textarea
            value={retryText}
            onChange={(e) => setRetryText(e.target.value)}
            rows={3}
            autoFocus
            placeholder={t("conductor.plan.retryPlaceholder")}
            className="mx-chip w-full resize-y bg-[var(--mx-hover-bg)] px-2 py-1.5 text-xs text-[var(--mx-text)] outline-none focus:ring-1 focus:ring-[var(--mx-accent)]"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void sendRetry()}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-2.5 text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
            >
              {busy ? t("conductor.decision.sending") : t("conductor.plan.retrySend")}
            </button>
            <button
              type="button"
              onClick={() => setRetrying(false)}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
            >
              {t("conductor.decision.cancel")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** 筛选下拉(2026-11-18 用户:「筛选改下拉框、支持多选;标签行会滚」):按钮 =
 *  维度名 + 摘要(空集=全部)+ ▾;弹层选项行 + 「全部」清空项。onPick 抛给父层
 *  定语义(单选=set 值,多选=toggle;""=清空该维)。closeOnPick=单选选中即收起
 *  (多选要连续勾)。外点/Esc 收起。 */
function FilterDropdown({
  label,
  options,
  selected,
  onPick,
  closeOnPick,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onPick: (value: string) => void;
  closeOnPick?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const picked = options.filter((o) => selected.has(o.value));
  const summary =
    picked.length === 0
      ? t("conductor.decision.filterAll")
      : picked.length === 1
        ? picked[0].label
        : `${picked[0].label} ${t("conductor.decision.filterMore", { n: picked.length - 1 })}`;
  const pick = (v: string) => {
    onPick(v);
    // 「全部」= 清空即终态,收起;单选选中即收起。
    if (v === "" || closeOnPick) setOpen(false);
  };
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] leading-4 transition-colors ${
          picked.length > 0
            ? "bg-[var(--mx-accent-soft)] font-medium text-[var(--mx-accent)]"
            : "text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
        }`}
      >
        <span className="opacity-80">{label}</span>
        <span className="max-w-32 truncate">{summary}</span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="mx-scroll-pretty absolute left-0 top-[calc(100%+3px)] z-40 max-h-56 min-w-36 overflow-y-auto rounded-md border border-[var(--mx-border)] bg-[var(--mx-bg)] py-1 shadow-md">
          <FilterOptionRow
            active={selected.size === 0}
            label={t("conductor.decision.filterAll")}
            onClick={() => pick("")}
          />
          {options.map((o) => (
            <FilterOptionRow
              key={o.value}
              active={selected.has(o.value)}
              label={o.label}
              onClick={() => pick(o.value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 下拉选项行:小勾选框(实心=选中)+ 截断标签;hover 高亮。 */
function FilterOptionRow({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left text-[10px] leading-4 text-[var(--mx-text)] transition-colors hover:bg-[var(--mx-hover-bg)]"
    >
      <span
        aria-hidden
        className={`grid h-2.5 w-2.5 shrink-0 place-items-center rounded-[3px] border text-[8px] font-bold ${
          active
            ? "border-[var(--mx-accent)] bg-[var(--mx-accent)] text-[var(--mx-bg)]"
            : "border-[var(--mx-border-strong)]"
        }`}
      >
        {active ? "✓" : ""}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
