/**
 * ProjectPulsePanel —— 指挥台中栏「项目动态」面板(v2.5,设计 20261116-conductor-hub-redesign)。
 *
 * 每项目一张动态卡:项目名 + 头行活跃摘要,卡内会话节点按语义态发光——
 * running=accent 扩散环(雷达波)/ waiting_approval=琥珀双闪 / error=红慢闪 /
 * finished=绿常亮 / idle·offline=灰静态;未启动 tab=虚线暗节点(投递时后端自动启动)。
 * 项目内有活动会话时卡片左侧竖向流光条下扫 + 项目名前光点呼吸(Remotion 式
 * 状态光效,零依赖 keyframes,「演出型克制」:状态在动才有光,稳态低频呼吸)。
 * 节点点击 = onPick 加为派活目标(联动①不变);卡片入场 stagger 错峰。
 * 活动项目上浮(组内保持 projects 原序,稳定排序防刷新跳动)。
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConductorSession,
  ConductorSessionKind,
  ConductorSessionTab,
  InboxTarget,
  PlanRecord,
} from "../domain/conductor";
import { relativeTime } from "./ui";

/** 语义态 → 状态点色(等待=琥珀,错误=红,完成=绿,运行=accent,空闲/退出=灰)。 */
const KIND_COLOR: Record<ConductorSessionKind, string> = {
  idle: "var(--mx-muted)",
  running: "var(--mx-accent)",
  waiting_approval: "#f59e0b",
  finished: "#22c55e",
  error: "#ef4444",
  offline: "var(--mx-muted)",
};

/** 语义态 → 光效动画类(空串=常亮无动画;类定义见 app.css 指挥台·项目动效段)。 */
const KIND_FX: Record<ConductorSessionKind, string> = {
  running: "mx-pulse-live",
  waiting_approval: "mx-pulse-wait",
  error: "mx-pulse-error",
  idle: "",
  finished: "",
  offline: "",
};

/** 单项目分组:运行中会话(sessions)+ 未启动 tab(tabs 减去前者)。 */
type ProjectGroup = {
  projectId: string;
  projectName: string;
  live: ConductorSession[];
  dormant: ConductorSessionTab[];
};

/** 会话 → 进行中编排进度(P3b「编排中 x/N」):running/paused 计划按目标 tab 归属;
 * 同 tab 多计划取最新(后端 plans 本就新的在前)。键 = `projectId/tabId` 复合——
 * tabId 仅项目内唯一(各项目都有 ai-1),裸键会让别的项目同名 tab 也挂上小标
 * (2026-11-17 用户实测所有项目都显示拆步状态)。面板与窄条共用。 */
function buildPlanBadges(plans?: PlanRecord[]): Map<string, { done: number; total: number }> {
  const map = new Map<string, { done: number; total: number }>();
  for (const p of plans ?? []) {
    if (p.status !== "running" && p.status !== "paused") continue;
    const key = `${p.target.projectId}/${p.target.tabId}`;
    if (!map.has(key)) {
      map.set(key, {
        done: p.steps.filter((s) => s.status === "done").length,
        total: p.steps.length,
      });
    }
  }
  return map;
}

/** 项目分组组装(面板与窄条共用):活跃键 = `projectId/tabId` 复合——tabId 仅项目内
 * 唯一(各项目都有 ai-1),裸键会把别的项目同名 tab 误判成活跃/沉睡错位
 * (2026-11-17 用户:「还是错位」)。有 running/waiting/error 的项目上浮,活跃组内
 * 再按最近事件排——「有状态的放第一个」(2026-11-17 用户)。 */
function buildGroups(
  sessions: ConductorSession[],
  tabs: ConductorSessionTab[],
  projects: { id: string; name: string }[],
): ProjectGroup[] {
  const liveKeys = new Set(sessions.map((s) => `${s.projectId}/${s.tabId}`));
  const byProject = new Map<string, ProjectGroup>();
  for (const p of projects) {
    byProject.set(p.id, { projectId: p.id, projectName: p.name, live: [], dormant: [] });
  }
  for (const s of sessions) {
    byProject.get(s.projectId)?.live.push(s);
  }
  for (const tab of tabs) {
    if (!liveKeys.has(`${tab.projectId}/${tab.id}`)) byProject.get(tab.projectId)?.dormant.push(tab);
  }
  for (const g of byProject.values()) g.live.sort((a, b) => b.lastEventMs - a.lastEventMs);
  const active = (g: ProjectGroup) =>
    g.live.some((s) => s.kind === "running" || s.kind === "waiting_approval" || s.kind === "error");
  const lastMs = (g: ProjectGroup) => g.live.reduce((m, s) => Math.max(m, s.lastEventMs), 0);
  return [...byProject.values()].sort(
    (a, b) => Number(active(b)) - Number(active(a)) || lastMs(b) - lastMs(a),
  );
}

export function ProjectPulsePanel({
  sessions,
  tabs,
  projects,
  plans,
  onPick,
}: {
  sessions: ConductorSession[];
  tabs: ConductorSessionTab[];
  projects: { id: string; name: string }[];
  /** 编排计划(P3b 会话行小标;旧后端缺 = undefined,兜底 [])。 */
  plans?: PlanRecord[];
  onPick: (target: InboxTarget) => void;
}) {
  const { t } = useTranslation();
  const planBadgeByTab = useMemo(() => buildPlanBadges(plans), [plans]);
  const groups = useMemo(() => buildGroups(sessions, tabs, projects), [sessions, tabs, projects]);

  if (groups.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
        <div className="text-xs text-[var(--mx-muted)]">{t("conductor.empty")}</div>
        <div className="text-[11px] text-[var(--mx-muted)] opacity-70">{t("conductor.emptyHint")}</div>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {groups.map((g, i) => (
        <ProjectCard key={g.projectId} group={g} index={i} planBadgeByTab={planBadgeByTab} onPick={onPick} />
      ))}
    </ul>
  );
}

/**
 * 项目动态紧凑列(2026-11-19,用户:「左侧项目状态非常空,精简为孵化和涌现流腾空间」
 * → 首版 52px 纯状态点轨被判丑,回改为紧凑列):原 20% 卡片栏压成 168px 窄列——
 * 每项目一组(项目名小行 + 会话行),会话行 = 状态点(语义态色与光效同面板口径)+
 * tab 标题 +「编排 x/N」微标,未启动 tab = 虚线暗点行;hover 全信息,点击 = onPick
 * 加派活目标(联动语义不变)。列头由 ConductorShell 的 PanelHeader 统一(与驿站/
 * 决策流同语言)。数据口径与 ProjectPulsePanel 同源(buildGroups/buildPlanBadges)。
 */
export function ProjectPulseStrip({
  sessions,
  tabs,
  projects,
  plans,
  onPick,
}: {
  sessions: ConductorSession[];
  tabs: ConductorSessionTab[];
  projects: { id: string; name: string }[];
  plans?: PlanRecord[];
  onPick: (target: InboxTarget) => void;
}) {
  const { t } = useTranslation();
  const planBadgeByTab = useMemo(() => buildPlanBadges(plans), [plans]);
  const groups = useMemo(() => buildGroups(sessions, tabs, projects), [sessions, tabs, projects]);

  if (groups.length === 0) {
    return <div className="py-2 text-center text-[10px] text-[var(--mx-muted)] opacity-70">—</div>;
  }
  return (
    <div className="mx-scroll-pretty flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-1.5">
      {groups.map((g) => {
        const energized = g.live.some(
          (s) => s.kind === "running" || s.kind === "waiting_approval" || s.kind === "error",
        );
        return (
          <div key={g.projectId} className="flex min-w-0 flex-col">
            {/* 项目名行:活跃项目光点呼吸,沉睡灰;会话行统一缩进到项目名文字下方,
                「项目 → 会话」两级层级一眼分明(排列修正,2026-11-19)。 */}
            <div className="flex items-center gap-1.5 px-0.5 pb-1 text-[11px] font-medium text-[var(--mx-text-bright)]">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${energized ? "mx-pulse-breath" : ""}`}
                style={{ background: energized ? "var(--mx-accent)" : "var(--mx-muted)" }}
              />
              <span className="truncate" title={g.projectName}>
                {g.projectName}
              </span>
            </div>
            {g.live.map((s) => {
              const plan = planBadgeByTab.get(`${s.projectId}/${s.tabId}`);
              const detail = [
                t(`conductor.kind.${s.kind}`),
                s.detail ?? "",
                relativeTime(s.lastEventMs, t),
                t("conductor.sessions.pickHint"),
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <button
                  key={s.tabId}
                  type="button"
                  onClick={() => onPick({ projectId: s.projectId, tabId: s.tabId })}
                  title={`${s.tabTitle || s.tabId} · ${detail}`}
                  className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded py-0.5 pl-4 pr-1 text-left text-[11px] transition-colors hover:bg-[var(--mx-hover-bg)]"
                >
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full ${KIND_FX[s.kind]}`}
                    style={{ background: KIND_COLOR[s.kind] }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[var(--mx-text)]">
                    {s.tabTitle || s.tabId}
                  </span>
                  {plan && (
                    <span
                      className="shrink-0 rounded-full bg-[var(--mx-accent-soft)] px-1 text-[9px] leading-3.5 tabular-nums text-[var(--mx-accent)]"
                      title={t("conductor.pulse.planBadgeHint")}
                    >
                      {t("conductor.pulse.planBadge", { done: plan.done, total: plan.total })}
                    </span>
                  )}
                </button>
              );
            })}
            {g.dormant.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onPick({ projectId: tab.projectId, tabId: tab.id })}
                title={`${tab.title} · ${t("conductor.pulse.dormantHint")}\n${t("conductor.sessions.pickHint")}`}
                className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded py-0.5 pl-4 pr-1 text-left text-[11px] text-[var(--mx-muted)] opacity-75 transition-colors hover:bg-[var(--mx-hover-bg)] hover:opacity-100"
              >
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full border border-dashed border-[var(--mx-muted)]"
                />
                <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** 项目动态卡:流光条(有活动)+ 头行(项目名/摘要)+ 会话节点 flex-wrap 网格。 */
function ProjectCard({
  group,
  index,
  planBadgeByTab,
  onPick,
}: {
  group: ProjectGroup;
  index: number;
  planBadgeByTab: Map<string, { done: number; total: number }>;
  onPick: (target: InboxTarget) => void;
}) {
  const { t } = useTranslation();
  const running = group.live.filter((s) => s.kind === "running").length;
  const waiting = group.live.filter((s) => s.kind === "waiting_approval").length;
  const errors = group.live.filter((s) => s.kind === "error").length;
  const energized = running + waiting + errors > 0;

  return (
    <li
      className="mx-chip mx-rise-in relative flex flex-col gap-1 border border-[var(--mx-border)] bg-[var(--mx-surface-soft)] px-2 py-1.5"
      style={{ animationDelay: `${index * 45}ms` }}
    >
      {energized && (
        <span aria-hidden className="mx-pulse-flow absolute inset-y-1.5 left-0 w-[2px] rounded-full" />
      )}
      <div className="flex items-center gap-1.5 text-[11px]">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${energized ? "mx-pulse-breath" : ""}`}
          style={{ background: energized ? "var(--mx-accent)" : "var(--mx-muted)" }}
        />
        <span className="min-w-0 truncate font-medium text-[var(--mx-text-bright)]">{group.projectName}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-[var(--mx-muted)] tabular-nums">
          {running > 0 && (
            <span className="text-[var(--mx-accent)]">{t("conductor.pulse.running", { n: running })}</span>
          )}
          {waiting > 0 && <span className="text-[#f59e0b]">{t("conductor.pulse.waiting", { n: waiting })}</span>}
          {errors > 0 && <span className="text-[#ef4444]">{t("conductor.pulse.errors", { n: errors })}</span>}
          {running + waiting + errors === 0 &&
            (group.live.length > 0 ? (
              <span>{t("conductor.pulse.liveQuiet", { n: group.live.length })}</span>
            ) : (
              group.dormant.length > 0 && <span>{t("conductor.pulse.dormant", { n: group.dormant.length })}</span>
            ))}
        </span>
      </div>
      {(group.live.length > 0 || group.dormant.length > 0) && (
        <div className="flex flex-wrap gap-0.5">
          {group.live.map((s) => (
            <LiveNode
              key={s.tabId}
              session={s}
              planBadge={planBadgeByTab.get(`${s.projectId}/${s.tabId}`)}
              onPick={onPick}
            />
          ))}
          {group.dormant.map((tab) => (
            <DormantNode
              key={tab.id}
              tab={tab}
              planBadge={planBadgeByTab.get(`${tab.projectId}/${tab.id}`)}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </li>
  );
}

/** 运行中会话节点:光点(语义态光效)+ tab 名 + provider 微标 +「编排 x/N」小标;点击加为派活目标。 */
function LiveNode({
  session,
  planBadge,
  onPick,
}: {
  session: ConductorSession;
  planBadge?: { done: number; total: number };
  onPick: (target: InboxTarget) => void;
}) {
  const { t } = useTranslation();
  const color = KIND_COLOR[session.kind];
  const fx = KIND_FX[session.kind];
  const detail = [
    session.tabTitle || session.tabId,
    t(`conductor.kind.${session.kind}`),
    session.waitingChoice ?? "",
    session.detail ?? "",
    relativeTime(session.lastEventMs, t),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={() => onPick({ projectId: session.projectId, tabId: session.tabId })}
      title={`${detail}\n${t("conductor.sessions.pickHint")}`}
      className="mx-chip flex h-5 max-w-full cursor-pointer items-center gap-1 border border-[var(--mx-border)] bg-[var(--mx-card-bg)] px-1 text-[10px] transition-colors hover:border-[var(--mx-border-strong)]"
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${fx}`}
        style={{ background: color }}
      />
      <span className="truncate text-[var(--mx-text)]">{session.tabTitle || session.tabId}</span>
      {session.waitingChoice && (
        <span
          className="shrink-0 rounded-full bg-[var(--mx-accent-soft)] px-1 text-[9px] font-semibold leading-3.5 text-[var(--mx-accent)]"
          title={`${t("conductor.pulse.waitingChoiceHint")}: ${session.waitingChoice}`}
        >
          ？
        </span>
      )}
      {planBadge && (
        <span
          className="shrink-0 rounded-full bg-[var(--mx-accent-soft)] px-1 text-[9px] leading-3.5 tabular-nums text-[var(--mx-accent)]"
          title={t("conductor.pulse.planBadgeHint")}
        >
          {t("conductor.pulse.planBadge", { done: planBadge.done, total: planBadge.total })}
        </span>
      )}
      <span className="shrink-0 text-[9px] font-semibold uppercase text-[var(--mx-muted)] opacity-80">
        {session.provider === "claude" ? "CL" : "CX"}
      </span>
    </button>
  );
}

/** 未启动 tab 节点:虚线暗节点(投递时后端自动启动,同驿站目标下拉口径)。 */
function DormantNode({
  tab,
  planBadge,
  onPick,
}: {
  tab: ConductorSessionTab;
  planBadge?: { done: number; total: number };
  onPick: (target: InboxTarget) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => onPick({ projectId: tab.projectId, tabId: tab.id })}
      title={`${tab.title} · ${t("conductor.pulse.dormantHint")}\n${t("conductor.sessions.pickHint")}`}
      className="flex h-5 max-w-full cursor-pointer items-center gap-1 rounded border border-dashed border-[var(--mx-border)] px-1 text-[10px] text-[var(--mx-muted)] opacity-75 transition-colors hover:border-[var(--mx-border-strong)] hover:opacity-100"
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full border border-[var(--mx-muted)] opacity-60" />
      <span className="truncate">{tab.title}</span>
      {planBadge && (
        <span
          className="shrink-0 rounded-full bg-[var(--mx-accent-soft)] px-1 text-[9px] leading-3.5 tabular-nums text-[var(--mx-accent)]"
          title={t("conductor.pulse.planBadgeHint")}
        >
          {t("conductor.pulse.planBadge", { done: planBadge.done, total: planBadge.total })}
        </span>
      )}
    </button>
  );
}
