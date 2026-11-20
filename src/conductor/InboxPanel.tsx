/**
 * InboxPanel —— 驿站(v2.3 拆分工:QuickDispatch 只负责「存入」,InboxList 负责「投递」)。
 *
 * QuickDispatch(左栏顶部,2026-11-16 三轮改):任务文本 + 目标 chips → **存入驿站**,
 * 不再一步直投——投递动作统一收口到下方驿站任务行(模块分割:发送框=采集,列表=投递)。
 * 目标 chips 随条目持久化(add 带 targets),驿站行打开即有目标可投。
 * draft 由 Shell 持有——会话行「选为目标」与决策卡「采纳」都向它预填,三处联动共享同一状态。
 * InboxList:驿站条目列表(多投/重复投递/定时循环/占用锁降级),与 v1 相同;
 * 拆步计划以分组行展示(2026-11-17「拆步任务也算孵化的一种」:展示层归一,
 * 左边框竖线 = 同链边界,活跃置顶/完结沉底,数据层仍在 orchestrate 计划状态机)。
 * 所有命令成功后经 onChanged 通知 Shell refetch。
 */
import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type {
  ConductorSession,
  ConductorSessionTab,
  InboxItem,
  InboxItemStatus,
  InboxTarget,
  PendingVerdictView,
  PlanRecord,
  PlanStatus,
  PlanStepStatus,
} from "../domain/conductor";
import { countdown, clockOf, relativeTime } from "./ui";

/** 驿站条目状态 → 颜色(pending=琥珀,queued=蓝(等会话空闲自动补投),dispatched=绿,其余灰)。 */
const STATUS_COLOR: Record<InboxItemStatus, string> = {
  pending: "#f59e0b",
  queued: "#3b82f6",
  dispatched: "#22c55e",
  done: "var(--mx-muted)",
  dismissed: "var(--mx-muted)",
};

/** 拆步计划/步状态色(与 DecisionPanel 编排卡同色板,两处展示保持一致)。 */
const PLAN_STATUS_COLOR: Record<PlanStatus, string> = {
  running: "#3b82f6",
  paused: "#f59e0b",
  halted: "#ef4444",
  finished: "#22c55e",
};
const STEP_COLOR: Record<PlanStepStatus, string> = {
  queued: "var(--mx-muted)",
  running: "#3b82f6",
  done: "#22c55e",
  failed: "#ef4444",
  skipped: "var(--mx-muted)",
};

/** 快速派活区草稿(Shell 持有,联动预填的共享状态)。 */
export type QuickDraft = { text: string; targets: InboxTarget[] };

export function QuickDispatch({
  draft,
  onDraftChange,
  sessions,
  tabs,
  projects,
  onChanged,
}: {
  draft: QuickDraft;
  onDraftChange: (d: QuickDraft) => void;
  sessions: ConductorSession[];
  /** 全量项目的 AI tab(含未启动):投递目标候选。 */
  tabs: ConductorSessionTab[];
  projects: { id: string; name: string }[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState("");
  const [tabId, setTabId] = useState("");
  /** 权限上限(P2c):任务期内目标会话的代批判定不得超过此级;"" = 不限制。 */
  const [ceiling, setCeiling] = useState<"" | "confirm" | "deny">("");
  /** 验收标准(可选):「做到什么才算完成」;随条目进验收判定,标准为尺度、意图兜底。 */
  const [acceptance, setAcceptance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tabOptions = useMemo(() => tabs.filter((x) => x.projectId === projectId), [tabs, projectId]);
  const liveOf = (id: string) => sessions.find((s) => s.projectId === projectId && s.tabId === id);

  /** 选择即加入 chips(与 InboxRow 同交互):选中一个目标立刻进列表,下拉回位等下一个。 */
  const addTarget = (pid: string, tid: string) => {
    if (!pid || !tid) return;
    if (!draft.targets.some((x) => x.projectId === pid && x.tabId === tid)) {
      onDraftChange({ ...draft, targets: [...draft.targets, { projectId: pid, tabId: tid }] });
    }
  };

  /** 存驿站(唯一出口):文本 + 预挂目标入列表;投递在下方任务行进行。 */
  const save = async () => {
    const text = draft.text.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await invoke<InboxItem>("conductor_inbox_add", {
        text,
        targets: draft.targets.length > 0 ? draft.targets : null,
        permissionCeiling: ceiling || null,
        acceptance: acceptance.trim() || null,
      });
      setNotice(t("conductor.quick.savedToList"));
      onDraftChange({ text: "", targets: [] });
      setProjectId("");
      setTabId("");
      setCeiling("");
      setAcceptance("");
      onChanged();
    } catch (e) {
      setError(String(e).replace(/^Error\b:?\s*/i, ""));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  /** 直发(2026-11-16 用户:「我本质就是直接发送这个消息就行了,不需要建议」):
   *  存入驿站 + 立即投递到选中目标,一次动作完成——用完即走的查询/指令类消息
   *  不用再去下方任务行点一遍。须先选目标;后端登记验收,终态只出验收结果不出建议。 */
  const saveAndSend = async () => {
    const text = draft.text.trim();
    if (!text || draft.targets.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const item = await invoke<InboxItem>("conductor_inbox_add", {
        text,
        targets: draft.targets,
        permissionCeiling: ceiling || null,
        acceptance: acceptance.trim() || null,
      });
      const r = await invoke<{ dispatched: boolean; downgraded: boolean; queued?: boolean; okCount: number; failCount: number }>(
        "conductor_inbox_dispatch",
        { id: item.id, targets: draft.targets },
      );
      if (r.queued && !r.dispatched) setNotice(t("conductor.inbox.queuedNotice"));
      else if (r.downgraded && !r.dispatched) setNotice(t("conductor.inbox.downgraded"));
      else if (r.failCount > 0) setNotice(t("conductor.inbox.partialFail", { ok: r.okCount, fail: r.failCount }));
      else setNotice(t("conductor.quick.sentOk", { ok: r.okCount }));
      onDraftChange({ text: "", targets: [] });
      setProjectId("");
      setTabId("");
      setCeiling("");
      setAcceptance("");
      onChanged();
    } catch (e) {
      setError(String(e).replace(/^Error\b:?\s*/i, ""));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // 拆步执行入口已收(2026-11-18 用户定调:「完全没必要,大段需求丢给 AI pane 它能
  // 自己拆解,我们同意就行」)——智核无项目上下文,盲拆不如有完整上下文的执行会话
  // 自拆;宽限代批成熟后「分段可控」价值也消失了。机制全留底:orchestrate 状态机/
  // 编排卡/孵化计划分组/验收/流水线/续段不动,已有计划照常跑完,DecisionPanel 的
  // 「发起续段」仍走 conductor_plan_create。

  return (
    <div className="mx-chip flex shrink-0 flex-col gap-2 border border-[var(--mx-border)] bg-[var(--mx-surface-soft)] px-2.5 py-2.5 text-xs">
      <textarea
        value={draft.text}
        onChange={(e) => onDraftChange({ ...draft, text: e.target.value })}
        onKeyDown={(e) => {
          // Enter 存驿站 / Ctrl+Enter 直发(Shift+Enter 换行);textarea 多行任务描述。
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) void saveAndSend();
            else void save();
          }
        }}
        rows={2}
        placeholder={t("conductor.quick.placeholder")}
        className="mx-chip min-h-[3rem] w-full resize-y bg-[var(--mx-hover-bg)] px-2.5 py-1.5 text-xs leading-5 outline-none placeholder:text-[var(--mx-muted)] focus:ring-1 focus:ring-[var(--mx-accent)]"
      />
      {/* 验收标准(可选,2026-11-18 用户「验收的时候有个尺度」):任务文本说「做什么」,
          标准说「做到什么才算数」;投递随 PendingVerdict 登记,验收以此为尺度、意图兜底。 */}
      <input
        value={acceptance}
        onChange={(e) => setAcceptance(e.target.value)}
        placeholder={t("conductor.quick.acceptancePlaceholder")}
        className="mx-chip h-7 w-full bg-[var(--mx-hover-bg)] px-2.5 text-[11px] leading-5 outline-none placeholder:text-[var(--mx-muted)] focus:ring-1 focus:ring-[var(--mx-accent)]"
      />
      {/* 目标选择行:项目 → 会话(选择即加入 chips);chips 可删。目标只预挂条目,不直接投。 */}
      <div className="flex items-center gap-1.5">
        <select
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setTabId("");
          }}
          className="mx-chip h-7 max-w-[38%] shrink cursor-pointer bg-[var(--mx-hover-bg)] px-1.5 text-[11px] text-[var(--mx-text)] outline-none"
          aria-label={t("conductor.inbox.pickProject")}
        >
          <option value="">{t("conductor.inbox.pickProject")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={tabId}
          onChange={(e) => {
            const tid = e.target.value;
            if (tid) addTarget(projectId, tid);
            setTabId("");
          }}
          disabled={!projectId || tabOptions.length === 0}
          className="mx-chip h-7 min-w-0 flex-1 cursor-pointer bg-[var(--mx-hover-bg)] px-1.5 text-[11px] text-[var(--mx-text)] outline-none disabled:cursor-default disabled:opacity-50"
          aria-label={t("conductor.inbox.pickSession")}
        >
          <option value="">
            {tabOptions.length === 0 && projectId
              ? t("conductor.inbox.noTabs")
              : t("conductor.inbox.pickSession")}
          </option>
          {tabOptions.map((x) => {
            const live = liveOf(x.id);
            const state = live
              ? t(`conductor.kind.${live.kind}`)
              : t(`conductor.shellKind.${x.shellKind}`, { defaultValue: x.shellKind });
            const label = `${x.title || x.id}(${state})`;
            return (
              <option key={x.id} value={x.id}>
                {live ? label : `${label} · ${t("conductor.inbox.sessionNotStarted")}`}
              </option>
            );
          })}
        </select>
      </div>
      {draft.targets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {draft.targets.map((x) => {
            // tab 查找带项目条件(tabId 仅项目内唯一,裸 id 撞名会拿错 pane 标题)。
            const label = `${projects.find((p) => p.id === x.projectId)?.name ?? x.projectId}/${
              tabs.find((tb) => tb.projectId === x.projectId && tb.id === x.tabId)?.title ?? x.tabId
            }`;
            return (
              <span
                key={`${x.projectId}/${x.tabId}`}
                className="mx-chip flex h-6 items-center gap-1 bg-[var(--mx-accent-soft)] px-1.5 text-[11px] text-[var(--mx-accent)]"
                title={label}
              >
                <span className="max-w-[220px] truncate">{label}</span>
                <button
                  type="button"
                  aria-label={t("conductor.inbox.removeTarget")}
                  onClick={() =>
                    onDraftChange({ ...draft, targets: draft.targets.filter((y) => y !== x) })
                  }
                  className="cursor-pointer opacity-70 hover:opacity-100"
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </span>
            );
          })}
        </div>
      )}
      {/* 权限上限(P2c):任务期内该派活目标的代批判定不得超过此级(confirm=只读也弹卡;
          deny=confirm 也带高危标);验收终态自动收回。 */}
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[11px] text-[var(--mx-muted)]">{t("conductor.quick.ceilingLabel")}</span>
        <select
          value={ceiling}
          onChange={(e) => setCeiling(e.target.value as "" | "confirm" | "deny")}
          className="mx-chip h-7 min-w-0 flex-1 cursor-pointer bg-[var(--mx-hover-bg)] px-1.5 text-[11px] text-[var(--mx-text)] outline-none"
          aria-label={t("conductor.quick.ceilingLabel")}
        >
          <option value="">{t("conductor.quick.ceilingNone")}</option>
          <option value="confirm">{t("conductor.quick.ceilingConfirm")}</option>
          <option value="deny">{t("conductor.quick.ceilingDeny")}</option>
        </select>
      </div>
      {/* 底行:错误/提示占左,主按钮钉右;无消息时显示流程 hint 占位,行高稳定。 */}
      <div className="flex items-center gap-2">
        {error || notice ? (
          <span className={`min-w-0 flex-1 truncate text-[11px] ${error ? "text-[#ef4444]" : "text-[var(--mx-accent)]"}`} title={error ?? notice ?? undefined}>
            {error ?? notice}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--mx-muted)] opacity-70">
            {t("conductor.quick.saveHint")}
          </span>
        )}
        {(error || notice) && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
            className="shrink-0 cursor-pointer text-[var(--mx-muted)] opacity-70 hover:opacity-100"
            aria-label="dismiss"
          >
            ✕
          </button>
        )}
        <button
          type="button"
          disabled={!draft.text.trim() || busy}
          title={t("conductor.quick.saveHint")}
          onClick={() => void save()}
          className="mx-chip h-8 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-3 text-xs text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
        >
          {t("conductor.quick.saveToList")}
        </button>
        <button
          type="button"
          disabled={!draft.text.trim() || draft.targets.length === 0 || busy}
          title={draft.targets.length === 0 ? t("conductor.quick.needTarget") : t("conductor.quick.saveAndSendHint")}
          onClick={() => void saveAndSend()}
          className="mx-chip h-8 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-3 text-xs font-medium text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
        >
          {busy ? t("conductor.quick.saving") : t("conductor.quick.saveAndSend")}
        </button>
      </div>
    </div>
  );
}

/** 驿站任务列表(v2:纯列表,顶部输入已上移为 QuickDispatch;拆步计划分组 2026-11-17)。 */
export function InboxList({
  items,
  plans,
  sessions,
  tabs,
  projects,
  pendingVerdicts,
  onChanged,
}: {
  items: InboxItem[];
  /** 拆步计划(snapshot.plans):活跃分组置顶展示,完结沉底留痕。 */
  plans: PlanRecord[];
  sessions: ConductorSession[];
  tabs: ConductorSessionTab[];
  projects: { id: string; name: string }[];
  /** 待验收记录(snapshot.pendingVerdicts):「验收中」判定原料(步已派发+会话终态)。 */
  pendingVerdicts: PendingVerdictView[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fail = (e: unknown) => {
    setError(String(e).replace(/^Error\b:?\s*/i, ""));
    onChanged();
  };

  // 活跃(running/paused)置顶——正在跑的链最先被看到;完结(finished/halted)沉底留痕。
  const activePlans = plans.filter((p) => p.status === "running" || p.status === "paused");
  const donePlans = plans.filter((p) => p.status === "finished" || p.status === "halted");

  // 会话表键 = `projectId/tabId` 复合(tabId 仅项目内唯一,各项目都有 ai-1)。
  const sessionByTab = useMemo(
    () => new Map(sessions.map((s) => [`${s.projectId}/${s.tabId}`, s])),
    [sessions],
  );
  // 验收中(2026-11-17):计划 running + 有该计划的待验收记录 + 目标会话已终态
  // = 智核验收 LLM 判定窗口(数秒到数十秒),此前一律显示「拆步中」像卡住。
  const verifyingOf = (plan: PlanRecord) =>
    plan.status === "running" &&
    pendingVerdicts.some((v) => v.planId === plan.id) &&
    ["finished", "error"].includes(
      sessionByTab.get(`${plan.target.projectId}/${plan.target.tabId}`)?.kind ?? "",
    );

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      {(error || notice) && (
        <div
          className={`mx-chip px-2.5 py-1.5 text-xs ${error ? "bg-[#ef44441a] text-[#ef4444]" : "bg-[var(--mx-accent-soft)] text-[var(--mx-accent)]"}`}
        >
          <span className="min-w-0 flex-1 break-all">{error ?? notice}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
            className="ml-2 shrink-0 cursor-pointer opacity-70 hover:opacity-100"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      )}
      <div className="mx-scroll-pretty min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && plans.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <div className="text-xs text-[var(--mx-muted)]">{t("conductor.inbox.empty")}</div>
            <div className="text-[11px] text-[var(--mx-muted)] opacity-70">{t("conductor.inbox.emptyHint")}</div>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {activePlans.map((plan) => (
              <PlanGroupRow
                key={plan.id}
                plan={plan}
                tabs={tabs}
                projects={projects}
                verifying={verifyingOf(plan)}
                onChanged={onChanged}
                onFail={fail}
              />
            ))}
            {items.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                sessions={sessions}
                tabs={tabs}
                projects={projects}
                onChanged={onChanged}
                onFail={fail}
                onNotice={(msg) => {
                  setNotice(msg);
                  setError(null);
                }}
              />
            ))}
            {donePlans.map((plan) => (
              <PlanGroupRow
                key={plan.id}
                plan={plan}
                tabs={tabs}
                projects={projects}
                verifying={false}
                onChanged={onChanged}
                onFail={fail}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 拆步计划分组行(2026-11-17 用户:「拆步任务也要在孵化列表展示,加边界表示
 *  同属一条链」):左边框状态色竖线 = 链边界,badge + 总意图 + 目标 + 步进度;
 *  步清单紧凑单行(与涌现流编排卡同信息同色板,无操作面——步顺序由计划状态机
 *  管,不提供单步投递/删除)。running/paused 可 ✕ 整链终止(conductor_plan_control
 *  abort,编排卡同命令,内部断当前步);finished/halted 纯留痕(后端上限 20 条滚动)。 */
function PlanGroupRow({
  plan,
  tabs,
  projects,
  verifying,
  onChanged,
  onFail,
}: {
  plan: PlanRecord;
  tabs: ConductorSessionTab[];
  projects: { id: string; name: string }[];
  /** 验收中(2026-11-17):步已派发+会话终态 = 智核验收窗口,状态字换琥珀「验收中」。 */
  verifying: boolean;
  onChanged: () => void;
  onFail: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const done = plan.steps.filter((s) => s.status === "done").length;
  const color = verifying ? "#f59e0b" : PLAN_STATUS_COLOR[plan.status];
  const active = plan.status === "running" || plan.status === "paused";
  // 目标富化(2026-11-17 用户:「拆步任务要显示项目、AI pane」):项目/AI pane 双
  // 徽标替代单个截断文本;tab 查找带项目条件(tabId 仅项目内唯一,裸 id 撞名拿错标题)。
  const projectName = projects.find((p) => p.id === plan.target.projectId)?.name ?? plan.target.projectId;
  const tabTitle =
    tabs.find((tb) => tb.projectId === plan.target.projectId && tb.id === plan.target.tabId)?.title ??
    plan.target.tabId;
  const abort = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("conductor_plan_control", { id: plan.id, action: "abort" });
      onChanged();
    } catch (e) {
      onFail(e);
    } finally {
      setBusy(false);
    }
  };
  /** 删除留痕(仅终态分组显示):纯记录清理,进行中须先终止(后端拦)。 */
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("conductor_plan_remove", { id: plan.id });
      onChanged();
    } catch (e) {
      onFail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      className={`mx-chip flex flex-col gap-1 border border-[var(--mx-border)] bg-[var(--mx-surface-soft)] px-2.5 py-2 text-xs ${
        active ? "" : "opacity-75"
      }`}
      style={{ borderLeft: `2px solid ${color}` }}
    >
      {/* 头行:拆步 badge + 总意图 + 目标 + 进度 + 状态 + 时间 + ✕(活跃可整链终止)。 */}
      <div className="flex items-center gap-2">
        <span
          className="shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4"
          style={{ color, background: "color-mix(in srgb, currentColor 12%, transparent)" }}
        >
          {t("conductor.plan.groupTag")}
        </span>
        <span className="min-w-0 flex-1 truncate text-[var(--mx-text)]" title={plan.goal}>
          {plan.goal}
        </span>
        <span
          className="max-w-28 shrink-0 truncate rounded-full bg-[var(--mx-hover-bg)] px-1.5 text-[10px] leading-4 text-[var(--mx-muted)]"
          title={projectName}
        >
          {projectName}
        </span>
        <span className="max-w-24 shrink-0 truncate text-[10px] text-[var(--mx-muted)]" title={tabTitle}>
          {tabTitle}
        </span>
        <span className="shrink-0 tabular-nums text-[var(--mx-muted)]" title={t("conductor.plan.progressHint")}>
          {done}/{plan.steps.length}
        </span>
        <span
          className="shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4"
          style={{ color, background: "color-mix(in srgb, currentColor 12%, transparent)" }}
        >
          {verifying ? t("conductor.plan.verifying") : t(`conductor.plan.status.${plan.status}`)}
        </span>
        <span className="w-14 shrink-0 text-right text-[var(--mx-muted)] tabular-nums opacity-80">
          {relativeTime(plan.updatedMs, t)}
        </span>
        {active ? (
          <button
            type="button"
            disabled={busy}
            aria-label={t("conductor.plan.abortFromList")}
            title={t("conductor.plan.abortFromList")}
            onClick={() => void abort()}
            className="shrink-0 cursor-pointer text-[var(--mx-muted)] hover:text-[#ef4444] disabled:cursor-default disabled:opacity-40"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            aria-label={t("conductor.plan.removeRecord")}
            title={t("conductor.plan.removeRecord")}
            onClick={() => void remove()}
            className="shrink-0 cursor-pointer text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>
      {/* 步骤清单:序号 + 状态色点(running 呼吸)+ 单行文本(悬停全文),编排卡同口径。 */}
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
    </li>
  );
}

/** 单条驿站行:文本 + 状态徽标 + (可投递时)路由/选目标/投递/循环设置 + 移除。
 *  2026-11-12:Pending / Dispatched / Done 都可再投(重复投递),并可设成定时循环任务。 */
function InboxRow({
  item,
  sessions,
  tabs,
  projects,
  onChanged,
  onFail,
  onNotice,
}: {
  item: InboxItem;
  sessions: ConductorSession[];
  tabs: ConductorSessionTab[];
  projects: { id: string; name: string }[];
  onChanged: () => void;
  onFail: (e: unknown) => void;
  onNotice: (msg: string) => void;
}) {
  const { t } = useTranslation();
  /** 投递目标列表(多投):条目 targets 优先,老数据回退兼容字段单目标。 */
  const [targets, setTargets] = useState<InboxTarget[]>(() =>
    item.targets.length > 0
      ? item.targets
      : item.projectId && item.sessionId
        ? [{ projectId: item.projectId, tabId: item.sessionId }]
        : [],
  );
  /** 下拾取器(项目/会话):选好后「+」加入 targets,chips 可删。 */
  const [projectId, setProjectId] = useState(item.projectId ?? "");
  const [tabId, setTabId] = useState(item.sessionId ?? "");
  const [routing, setRouting] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [requeuing, setRequeuing] = useState(false);
  /** 循环开关(条目已有 repeatMinutes 即视为曾设过,默认勾上让人看见现状)。 */
  const [repeatOn, setRepeatOn] = useState(item.repeatMinutes !== null);
  const [repeatMin, setRepeatMin] = useState(item.repeatMinutes ?? 30);

  // Dismissed 之外都能投(重复投递);循环控件同理。
  const dispatchable = item.status !== "dismissed";
  const pending = item.status === "pending";
  // 候选 = 该项目布局里的全部 AI tab(含未启动);sessions 只用来标注「在跑」。
  const tabOptions = useMemo(() => tabs.filter((x) => x.projectId === projectId), [tabs, projectId]);
  /** tabId → 运行中的会话(snapshot.sessions 命中即「已启动」)。 */
  const liveOf = (id: string) => sessions.find((s) => s.projectId === projectId && s.tabId === id);

  const autoRoute = async () => {
    if (routing) return;
    setRouting(true);
    try {
      const r = await invoke<{ projectId: string | null }>("conductor_inbox_route", { id: item.id });
      if (r.projectId) setProjectId(r.projectId);
      else onNotice(t("conductor.inbox.routeFailed"));
      onChanged();
    } catch (e) {
      onFail(e);
    } finally {
      setRouting(false);
    }
  };

  const dispatch = async () => {
    if (targets.length === 0 || dispatching) return;
    setDispatching(true);
    try {
      const r = await invoke<{
        dispatched: boolean;
        downgraded: boolean;
        queued?: boolean;
        okCount: number;
        failCount: number;
      }>("conductor_inbox_dispatch", { id: item.id, targets });
      if (r.queued && !r.dispatched) onNotice(t("conductor.inbox.queuedNotice"));
      else if (r.downgraded && !r.dispatched) onNotice(t("conductor.inbox.downgraded"));
      else if (r.failCount > 0)
        onNotice(t("conductor.inbox.partialFail", { ok: r.okCount, fail: r.failCount }));
      onChanged();
    } catch (e) {
      onFail(e);
    } finally {
      setDispatching(false);
    }
  };

  /** 重新入队(仅 dispatched/done 显示):回 pending 待流水线领,不立即投。 */
  const requeue = async () => {
    if (requeuing) return;
    setRequeuing(true);
    try {
      await invoke("conductor_inbox_requeue", { id: item.id });
      onNotice(t("conductor.inbox.requeued"));
      onChanged();
    } catch (e) {
      onFail(e);
    } finally {
      setRequeuing(false);
    }
  };

  /** 循环开关即时生效(不等「保存」):minutes = 当前输入值,enabled = 勾选态。 */
  const applyRepeat = async (on: boolean, minutes: number) => {
    try {
      await invoke("conductor_inbox_set_repeat", {
        id: item.id,
        minutes: on ? Math.max(1, Math.min(1440, Math.round(minutes) || 1)) : null,
        enabled: on,
      });
      onChanged();
    } catch (e) {
      onFail(e);
    }
  };

  const remove = async () => {
    try {
      await invoke("conductor_inbox_remove", { id: item.id });
      onChanged();
    } catch (e) {
      onFail(e);
    }
  };

  return (
    <li className="mx-chip flex flex-col gap-1.5 border border-[var(--mx-border)] bg-[var(--mx-surface-soft)] px-2.5 py-2 text-xs transition-opacity">
      {/* 首行:状态点 + 文本 + 时间 + 移除。 */}
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[item.status] }} />
        <span className="min-w-0 flex-1 break-all text-[var(--mx-text)]" title={item.text}>
          {item.text}
        </span>
        <span className="shrink-0 text-[var(--mx-muted)]">{t(`conductor.inbox.status.${item.status}`)}</span>
        {/* 权限上限徽标(P2c):任务期内目标会话代批不超过此级。 */}
        {item.permissionCeiling && (
          <span
            className="shrink-0"
            style={{ color: item.permissionCeiling === "deny" ? "#ef4444" : "#f59e0b" }}
          >
            {t(`conductor.quick.ceiling${item.permissionCeiling === "deny" ? "Deny" : "Confirm"}`)}
          </span>
        )}
        {/* 验收标准徽标:条目带尺子时可见,悬停看全文(详情行同款口径)。 */}
        {item.acceptance && (
          <span
            className="shrink-0 max-w-40 truncate text-[10px] text-[var(--mx-accent)] opacity-80"
            title={item.acceptance}
          >
            {t("conductor.quick.acceptanceTag")}: {item.acceptance}
          </span>
        )}
        <span className="w-14 shrink-0 text-right text-[var(--mx-muted)] tabular-nums opacity-80">
          {relativeTime(item.createdMs, t)}
        </span>
        <button
          type="button"
          aria-label={t("conductor.inbox.remove")}
          title={t("conductor.inbox.remove")}
          onClick={() => void remove()}
          className="shrink-0 cursor-pointer text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {/* 次行(可投递):路由 + 目标选择 + 投递。 */}
      {dispatchable && (
        <div className="flex items-center gap-1.5 pl-4">
          {pending && !item.projectId && (
            <button
              type="button"
              disabled={routing}
              onClick={() => void autoRoute()}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2 text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-50"
            >
              {routing ? t("conductor.inbox.routing") : t("conductor.inbox.autoRoute")}
            </button>
          )}
          <select
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setTabId("");
            }}
            className="mx-chip h-7 max-w-[36%] shrink cursor-pointer bg-[var(--mx-hover-bg)] px-1.5 text-[var(--mx-text)] outline-none"
          >
            <option value="">{t("conductor.inbox.pickProject")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={tabId}
            onChange={(e) => {
              // **选择即加入**(多投):选中一个会话立刻进目标列表,下拉回位等下一个。
              // 没有「+」按钮——点 + 后下拉清空像没生效,且与「投递」并排易点错。
              const tid = e.target.value;
              if (tid && !targets.some((x) => x.projectId === projectId && x.tabId === tid)) {
                setTargets((ts) => [...ts, { projectId, tabId: tid }]);
              }
              setTabId("");
            }}
            disabled={!projectId || tabOptions.length === 0}
            className="mx-chip h-7 min-w-0 flex-1 cursor-pointer bg-[var(--mx-hover-bg)] px-1.5 text-[var(--mx-text)] outline-none disabled:cursor-default disabled:opacity-50"
          >
            <option value="">
              {tabOptions.length === 0 && projectId
                ? t("conductor.inbox.noTabs")
                : t("conductor.inbox.pickSession")}
            </option>
            {tabOptions.map((x) => {
              const live = liveOf(x.id);
              // 已启动 → 会话语义态;未启动 → shell 类型(投递时后端按需拉起)。
              const state = live
                ? t(`conductor.kind.${live.kind}`)
                : t(`conductor.shellKind.${x.shellKind}`, { defaultValue: x.shellKind });
              const label = `${x.title || x.id}(${state})`;
              return (
                <option key={x.id} value={x.id}>
                  {live ? label : `${label} · ${t("conductor.inbox.sessionNotStarted")}`}
                </option>
              );
            })}
          </select>
          <button
            type="button"
            disabled={targets.length === 0 || dispatching}
            title={t("conductor.inbox.dispatchHint")}
            onClick={() => void dispatch()}
            className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-2.5 text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
          >
            {dispatching
              ? t("conductor.inbox.dispatching")
              : `${pending ? t("conductor.inbox.dispatch") : t("conductor.inbox.redispatch")}${
                  targets.length > 1 ? ` · ${targets.length}` : ""
                }`}
          </button>
          {/* 重新入队(已执行条目):回待处理队列,不立即投——与「再次执行」语义互补。 */}
          {(item.status === "dispatched" || item.status === "done") && (
            <button
              type="button"
              disabled={requeuing}
              title={t("conductor.inbox.requeueHint")}
              onClick={() => void requeue()}
              className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
            >
              {t("conductor.inbox.requeue")}
            </button>
          )}
        </div>
      )}
      {/* 目标 chips(多投):「投递」发给这里的全部;每片可删。空列表不能投。 */}
      {dispatchable && targets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pl-4">
          {targets.map((x) => {
            const label = `${projects.find((p) => p.id === x.projectId)?.name ?? x.projectId}/${
              tabs.find((tb) => tb.id === x.tabId)?.title ?? x.tabId
            }`;
            return (
              <span
                key={`${x.projectId}/${x.tabId}`}
                className="mx-chip flex h-6 items-center gap-1 bg-[var(--mx-hover-bg)] px-1.5 text-[11px] text-[var(--mx-text)]"
                title={label}
              >
                <span className="max-w-[220px] truncate">{label}</span>
                <button
                  type="button"
                  aria-label={t("conductor.inbox.removeTarget")}
                  onClick={() => setTargets((ts) => ts.filter((y) => y !== x))}
                  className="cursor-pointer text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <path d="M 6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </span>
            );
          })}
        </div>
      )}
      {/* 循环行:勾选即生效(后端即时排程),显示下次执行/已投次数/失败轮次。 */}
      {dispatchable && (
        <div className="flex flex-wrap items-center gap-1.5 pl-4 text-[11px] text-[var(--mx-muted)]">
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={repeatOn}
              onChange={(e) => {
                const on = e.target.checked;
                setRepeatOn(on);
                void applyRepeat(on, repeatMin);
              }}
              className="h-3 w-3 accent-[var(--mx-accent)]"
            />
            <span>{t("conductor.inbox.repeat")}</span>
          </label>
          {repeatOn && (
            <>
              <span>{t("conductor.inbox.repeatEvery")}</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={repeatMin}
                onChange={(e) => setRepeatMin(Math.max(1, Math.min(1440, Number(e.target.value) || 1)))}
                onBlur={() => void applyRepeat(true, repeatMin)}
                className="mx-chip h-6 w-14 bg-[var(--mx-hover-bg)] px-1.5 text-center tabular-nums outline-none focus:ring-1 focus:ring-[var(--mx-accent)]"
              />
              <span>{t("conductor.inbox.repeatMinutes")}</span>
            </>
          )}
          {item.repeatEnabled && item.nextRunMs > 0 && (
            <span className="text-[var(--mx-accent)]">
              {t("conductor.inbox.repeatNext", { time: clockOf(item.nextRunMs) })}
              {" · "}
              {countdown(item.nextRunMs, t)}
            </span>
          )}
          {item.dispatchCount > 0 && (
            <span>{t("conductor.inbox.repeatCount", { n: item.dispatchCount })}</span>
          )}
          {item.failStreak > 0 && (
            <span className="text-[#f59e0b]">
              {t("conductor.inbox.repeatFail", { n: item.failStreak })}
            </span>
          )}
        </div>
      )}
      {/* 该项目一个 AI tab 都没有:投递无从谈起,引导去主窗口新建。 */}
      {dispatchable && projectId && tabOptions.length === 0 && (
        <div className="pl-4 text-[11px] leading-4 text-[#f59e0b]">
          {t("conductor.inbox.noTabsHint")}
        </div>
      )}
    </li>
  );
}
