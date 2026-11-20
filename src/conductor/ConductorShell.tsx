/**
 * ConductorShell —— 指挥独立窗口的根界面(label === "conductor" 的 webview 渲染)。
 *
 * v2(2026-11-16 重组,设计 20261116-conductor-hub-redesign):去平级 tab,改双栏工作台。
 * v2.4(2026-11-16 三轮美化):重排为**三栏面板**——驿站(采集框+任务列表,独占一列整高,
 * 解决「驿站高度很小」)/ 会话状态 / 决策流;每栏独立边框面板 + PanelHeader
 * (accent 图标+计数徽标),模块分割一眼可辨;窄窗(<lg)纵向堆叠滚动兜底。
 * v2.5(2026-11-16):中栏「会话状态」升级为**项目动态**(ProjectPulsePanel)——
 * 按项目分组的动态卡,会话节点按语义态发光(扩散环/双闪/流光,Remotion 式
 * 状态光效),活动项目上浮;全量项目+未启动 tab 都在(未启动=虚线暗节点)。
 * 三条联动:①会话节点「点」→ 目标 chips(未启动节点同样可选,投递时自动启动);
 * ②建议卡「采纳」→ 预填采集框(ack 关卡不代发);③徽标口径不变(attention 驱动主窗口徽标)。
 *
 * 数据流:挂载时 `conductor_snapshot` 拉全量(同时 ack 已读)→ 订阅 `conductor-event`
 * 防抖 refetch(kind: attention/inbox/decision 同一快照通道)。项目下拉数据源 =
 * snapshot.projects(后端全量口径):**不接 App.tsx 的 projects prop**——指挥窗 hydrate
 * 那条路对 conductor 窗返回空(owner_window 过滤),且是静态快照。
 *
 * 窗口语义(封层管理):✕ 按钮 `window.close()` → 后端 CloseRequested → hide(隐藏不销毁,
 * 顶栏入口随时重开);bounds 防抖落 `conductor.json`(后端 CloseRequested 再兜底补存)。
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type {
  ConductorAutoApproval,
  ConductorEventPayload,
  ConductorSnapshot,
  InboxTarget,
} from "../domain/conductor";
import { QuickDispatch, InboxList, type QuickDraft } from "./InboxPanel";
import { DecisionPanel } from "./DecisionPanel";
import { ProjectPulseStrip } from "./ProjectPulsePanel";
import { SettingsPanel } from "./SettingsPanel";
import { relativeTime, stampOf } from "./ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/Tooltip";

/** conductor-event → refetch 的防抖(事件可能连发,合并为一次快照)。 */
const REFETCH_DEBOUNCE_MS = 350;
/** bounds 防抖(与主窗口 350ms 同口径)。 */
const BOUNDS_DEBOUNCE_MS = 350;
/** 相对时间刷新间隔。 */
const TICK_MS = 30_000;

export function ConductorShell() {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<ConductorSnapshot | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 快速派活草稿(联动中枢):会话行「选」与建议卡「采纳」都向它预填。 */
  const [quick, setQuick] = useState<QuickDraft>({ text: "", targets: [] });
  // 相对时间「N 分钟前」的刷新心跳(纯触发重渲染,值不用)。
  const [, setTick] = useState(0);

  const fetchSnapshot = useCallback(async () => {
    try {
      const s = await invoke<ConductorSnapshot>("conductor_snapshot");
      setSnap(s);
    } catch (err) {
      // 非 Tauri(浏览器直开)/命令不可用:静默,界面停在空态。
      console.warn("[conductor] snapshot failed:", err);
    }
  }, []);

  // 挂载首拉 + conductor-event 防抖 refetch。
  useEffect(() => {
    void fetchSnapshot();
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    listen<ConductorEventPayload>("conductor-event", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void fetchSnapshot(), REFETCH_DEBOUNCE_MS);
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {}); // 非 Tauri 环境:listen 抛错,静默
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [fetchSnapshot]);

  // 相对时间心跳。
  useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // 窗口 bounds 防抖持久化(镜像 App.tsx 主窗口做法;落 conductor.json)。
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: number | undefined;
    const flush = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void (async () => {
          try {
            if (await win.isMinimized()) return;
            const scale = await win.scaleFactor();
            if (await win.isMaximized()) {
              await invoke("save_conductor_window_bounds", {
                bounds: { x: 0, y: 0, width: 0, height: 0, maximized: true },
              });
              return;
            }
            const pos = await win.outerPosition();
            const size = await win.outerSize();
            await invoke("save_conductor_window_bounds", {
              bounds: {
                x: Math.round(pos.x / scale),
                y: Math.round(pos.y / scale),
                width: Math.round(size.width / scale),
                height: Math.round(size.height / scale),
                maximized: false,
              },
            });
          } catch {
            /* 非 Tauri / 失败:静默 */
          }
        })();
      }, BOUNDS_DEBOUNCE_MS);
    };
    let cancelled = false;
    let unresized: (() => void) | undefined;
    let unmoved: (() => void) | undefined;
    win.onResized(flush).then((u) => (cancelled ? u() : (unresized = u))).catch(() => {});
    win.onMoved(flush).then((u) => (cancelled ? u() : (unmoved = u))).catch(() => {});
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unresized?.();
      unmoved?.();
    };
  }, []);

  const attention = snap?.attentionCount ?? 0;
  /** 已处理卡数(非 proposed)——「清空已处理」按钮显隐条件。 */
  const handledCount = snap?.decisions.filter((d) => d.status !== "proposed").length ?? 0;
  /** 活动会话数(running/waiting_approval)——左栏「项目动态」徽标口径。 */
  const activeSessions =
    snap?.sessions.filter((s) => s.kind === "running" || s.kind === "waiting_approval").length ?? 0;
  /** 代批流水(左栏下块,2026-11-19 从决策流底部移来;全局审计口径不随项目筛选)。 */
  const approvals = snap?.autoApprovals ?? [];

  /** 联动①:会话行「选」→ 目标进派活区(已含同目标则跳过)。 */
  const pickTarget = (target: InboxTarget) => {
    setQuick((q) =>
      q.targets.some((x) => x.projectId === target.projectId && x.tabId === target.tabId)
        ? q
        : { ...q, targets: [...q.targets, target] },
    );
  };

  /** 联动②:建议卡「采纳」→ 文本+目标预填派活区(目标缺失时只填文本,chips 人手选)。 */
  const adoptSuggestion = (text: string, projectId: string | null, tabId: string | null) => {
    setQuick((q) => ({
      text,
      targets:
        projectId && tabId
          ? [{ projectId, tabId }]
          : q.targets, // 目标不全:保留已有 chips,人手补
    }));
  };

  /** 清空决策流里的已处理卡(id=null 语义;proposed 未决卡保留)。 */
  const clearHandled = async () => {
    try {
      await invoke("conductor_decision_remove", { id: null });
    } catch {
      /* 快照 refetch 兜底 */
    }
    void fetchSnapshot();
  };

  /** 清空决策流全部卡(2026-11-16 用户:「决策流加个清空所有」;连未决待办一起清,
   *  清空后大脑下次照常产新卡——纯历史清理,须二次确认防误触)。 */
  const clearAll = async () => {
    if (!window.confirm(t("conductor.feed.clearAllConfirm"))) return;
    try {
      await invoke("conductor_decision_remove", { id: null, all: true });
    } catch {
      /* 快照 refetch 兜底 */
    }
    void fetchSnapshot();
  };

  return (
    // 标题栏高度本窗独立(2026-11-18 用户:「title 高度变小」):根节点覆写
    // --mx-titlebar-h 36→30px,主窗口口径不受影响。
    <div
      className="flex h-screen flex-col bg-[var(--mx-bg)] text-[var(--mx-text)]"
      style={{ "--mx-titlebar-h": "30px" } as CSSProperties}
    >
      {/* 自绘标题栏(decorations:false):整行可拖;右侧 ⚙ 设置 + ✕ = 隐藏(后端拦截 close 转 hide)。 */}
      <header
        data-tauri-drag-region
        className="flex h-[length:var(--mx-titlebar-h)] shrink-0 select-none items-center gap-2 bg-[var(--mx-surface-soft)] px-3"
      >
        <span className="text-[length:var(--mx-ui-fs)] font-[760] tracking-[0.02em]">
          {t("conductor.title")}
        </span>
        {attention > 0 && (
          <span className="mx-chip bg-[var(--mx-accent-soft)] px-2 text-xs text-[var(--mx-accent)]">
            {t("conductor.attentionChip", { n: attention })}
          </span>
        )}
        {/* 概念简介(2026-11-18 二轮:ⓘ 图标悬浮出全文,提示加宽 560px;不放「不再
            显示」入口——简介常驻零状态)。 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-hidden
              onMouseDown={(e) => e.stopPropagation()}
              className="shrink-0 cursor-help text-[var(--mx-muted)] opacity-70 hover:text-[var(--mx-text)] hover:opacity-100"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4" />
                <path d="M12 8h.01" />
              </svg>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[560px]">{t("conductor.intro")}</TooltipContent>
        </Tooltip>
        <div className="ml-auto flex items-center" onMouseDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            aria-label={t("conductor.settings.openLabel")}
            title={t("conductor.settings.openLabel")}
            onClick={() => setSettingsOpen(true)}
            className="mx-chip flex h-[length:var(--mx-tab-h)] w-[length:var(--mx-tab-h)] cursor-pointer items-center justify-center bg-[var(--mx-surface-soft)] text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            type="button"
            aria-label={t("conductor.hide")}
            title={t("conductor.hide")}
            onClick={() => {
              // close 走后端 CloseRequested → prevent_close + hide(语义集中在后端)。
              getCurrentWindow().close().catch(() => {});
            }}
            className="mx-chip flex h-[length:var(--mx-tab-h)] w-[length:var(--mx-tab-h)] cursor-pointer items-center justify-center bg-[var(--mx-surface-soft)] text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>

      {/* 三栏面板(v2.4 布局;2026-11-19 三轮调整后定稿回卡片式,用户:「恢复到卡片
          设计」——轻编辑风试用一日被否):项目动态紧凑列(压缩自 20% 卡片栏,腾空间
          给驿站/决策流) | 驿站(采集+投递,整高) | 决策流。每栏独立边框卡片+面板头;
          窄窗(<lg)纵向堆叠滚动兜底(堆叠时驿站仍排第一)。 */}
      <div className="mx-scroll-pretty flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-2.5 lg:flex-row lg:overflow-hidden">
        {/* 左栏(上下两块,2026-11-19 定稿):上·项目动态紧凑列(原 20% 卡片栏压缩,
            腾空间给驿站/决策流)+ 下·代批流水(从决策流底部移来,占比 36%,用户:
            「放项目状态下面,这样感觉合理」)——决策流整栏让给卡片。 */}
        <div className="flex min-h-0 shrink-0 flex-col gap-2.5 max-lg:order-2 lg:w-[188px]">
          <section className="mx-chip flex min-h-[200px] flex-1 flex-col border border-[var(--mx-border)] bg-[var(--mx-card-bg)]">
            <PanelHeader
              icon={
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="2" />
                  <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49m8.49-3.51a10 10 0 0 1 0 14.14M7.76 4.24a10 10 0 0 0 0 14.14" />
                </svg>
              }
              title={t("conductor.pulse.title")}
              badge={
                activeSessions > 0 ? (
                  <span className="rounded-full bg-[var(--mx-accent-soft)] px-1.5 text-[10px] leading-4 tabular-nums text-[var(--mx-accent)]">
                    {activeSessions}
                  </span>
                ) : null
              }
            />
            <ProjectPulseStrip
              sessions={snap?.sessions ?? []}
              tabs={snap?.tabs ?? []}
              projects={snap?.projects ?? []}
              plans={snap?.plans}
              onPick={pickTarget}
            />
          </section>

          {/* 代批流水(autopilot):自动批了哪些、哪些转人了——全局审计口径
              (不随项目筛选),两行式行卡适配窄栏。**固定占左栏 45%**(2026-11-19
              用户:「高度还是一点点」——max-h 是封顶不是占位,条目少时卡片仍塌着;
              改 h-[45%] 定高,空了也留着,条目多内滚)。 */}
          {approvals.length > 0 && (
            <section className="mx-chip flex h-[45%] min-h-[120px] shrink-0 flex-col border border-[var(--mx-border)] bg-[var(--mx-card-bg)] max-lg:h-[260px]">
              <PanelHeader
                icon={
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                }
                title={t("conductor.autoApprove.title")}
                badge={
                  approvals.length > 0 ? (
                    <span className="rounded-full bg-[var(--mx-hover-bg)] px-1.5 text-[10px] leading-4 tabular-nums">
                      {approvals.length}
                    </span>
                  ) : null
                }
              />
              <ul className="mx-scroll-pretty flex min-h-0 flex-1 flex-col overflow-y-auto p-1">
                {approvals.map((a, i) => (
                  <ApprovalsRow key={`${a.tabId}-${a.ms}-${i}`} approval={a} />
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* 中栏·驿站:采集框 + 任务列表(投递唯一出口),整列高度(动态列压缩后放宽)。 */}
        <section className="mx-chip flex min-h-[300px] min-w-0 flex-1 flex-col border border-[var(--mx-border)] bg-[var(--mx-card-bg)] lg:max-w-[34%]">
          <PanelHeader
            icon={
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 12h-6l-2 3h-4l-2-3H2" />
                <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
              </svg>
            }
            title={t("conductor.inbox.title")}
            badge={
              (snap?.inbox.length ?? 0) > 0 ? (
                <span className="rounded-full bg-[var(--mx-hover-bg)] px-1.5 text-[10px] leading-4 tabular-nums">
                  {snap!.inbox.length}
                </span>
              ) : null
            }
            right={<span className="ml-auto truncate text-[10px] font-normal opacity-70">{t("conductor.quick.subtitle")}</span>}
          />
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
            <QuickDispatch
              draft={quick}
              onDraftChange={setQuick}
              sessions={snap?.sessions ?? []}
              tabs={snap?.tabs ?? []}
              projects={snap?.projects ?? []}
              onChanged={() => void fetchSnapshot()}
            />
            <div className="min-h-0 flex-1">
              <InboxList
                items={snap?.inbox ?? []}
                plans={snap?.plans ?? []}
                sessions={snap?.sessions ?? []}
                tabs={snap?.tabs ?? []}
                projects={snap?.projects ?? []}
                pendingVerdicts={snap?.pendingVerdicts ?? []}
                onChanged={() => void fetchSnapshot()}
              />
            </div>
          </div>
        </section>

        {/* 右栏·决策流:决策卡(建议/提问/派活/记忆候选)+ 代批流水。 */}
        <section className="mx-chip flex min-h-[300px] min-w-0 flex-1 flex-col border border-[var(--mx-border)] bg-[var(--mx-card-bg)]">
          <PanelHeader
            icon={
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            }
            title={t("conductor.feed.title")}
            badge={
              (snap?.decisions.length ?? 0) > 0 ? (
                <span className="rounded-full bg-[var(--mx-hover-bg)] px-1.5 text-[10px] leading-4 tabular-nums">
                  {snap!.decisions.filter((d) => d.status === "proposed").length}/{snap!.decisions.length}
                </span>
              ) : null
            }
            right={
              snap && snap.decisions.length > 0 ? (
                <div className="ml-auto flex items-center gap-1">
                  {handledCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void clearHandled()}
                      title={t("conductor.feed.clearHint")}
                      className="cursor-pointer rounded px-1.5 py-px text-[10px] font-normal text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                    >
                      {t("conductor.feed.clear")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void clearAll()}
                    title={t("conductor.feed.clearAllHint")}
                    className="cursor-pointer rounded px-1.5 py-px text-[10px] font-normal text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[#ef4444]"
                  >
                    {t("conductor.feed.clearAll")}
                  </button>
                </div>
              ) : null
            }
          />
          <div className="min-h-0 flex-1 p-2">
            <DecisionPanel
              decisions={snap?.decisions ?? []}
              memories={snap?.memories ?? []}
              brainError={snap?.lastBrainError ?? null}
              plans={snap?.plans}
              pendingVerdicts={snap?.pendingVerdicts ?? []}
              inbox={snap?.inbox ?? []}
              sessions={snap?.sessions ?? []}
              projects={snap?.projects ?? []}
              onChanged={() => void fetchSnapshot()}
              onAdopt={adoptSuggestion}
            />
          </div>
        </section>
      </div>

      {/* ⚙ 设置弹层(含长期记忆折叠区)。点背板/Esc 关;内层滚动。 */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-[#00000055] pt-[6vh]"
          onClick={() => setSettingsOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setSettingsOpen(false);
          }}
        >
          <div
            className="mx-chip flex max-h-[82vh] w-[min(680px,92vw)] flex-col overflow-hidden bg-[var(--mx-bg)] shadow-lg"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--mx-border)] px-3 py-2">
              <span className="text-xs font-medium">{t("conductor.settings.openLabel")}</span>
              <button
                type="button"
                aria-label={t("conductor.hide")}
                onClick={() => setSettingsOpen(false)}
                className="mx-chip flex h-6 w-6 cursor-pointer items-center justify-center text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="mx-scroll-pretty min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
              <SettingsPanel
                memories={snap?.memories ?? []}
                projects={snap?.projects ?? []}
                onChanged={() => void fetchSnapshot()}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 面板头(三栏统一,2026-11-19 定稿恢复卡片式):accent 图标 + 标题 + 计数徽标 +
 *  右侧动作区,底部 hairline 分割,底色 surface-soft。 */
function PanelHeader({
  icon,
  title,
  badge,
  right,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--mx-border)] bg-[var(--mx-surface-soft)] px-2.5 text-[11px] font-medium text-[var(--mx-muted)]">
      <span className="shrink-0 text-[var(--mx-accent)]" aria-hidden>
        {icon}
      </span>
      <span className="shrink-0 text-[var(--mx-text)]">{title}</span>
      {badge}
      {right}
    </div>
  );
}

/** 代批流水单行(左栏窄卡两行式,2026-11-19 从决策流移来):头行 = 级别色点 +
 *  工具名 + 级别徽标,副行 = 摘要 truncate(时间悬浮 title)——窄栏放不下单行
 *  全字段,两行换信息完整。P2a 三级着色:auto 绿 / confirm 琥珀 / deny 红
 *  (旧后端缺 level 按 verdict 兜底)。 */
function ApprovalsRow({ approval: a }: { approval: ConductorAutoApproval }) {
  const { t } = useTranslation();
  const level = a.level ?? (a.verdict === "allow" ? "auto" : "confirm");
  const color = level === "auto" ? "#22c55e" : level === "deny" ? "#ef4444" : "#f59e0b";
  const stamp = `${stampOf(a.ms)} · ${relativeTime(a.ms, t)}`;
  return (
    <li
      className="flex flex-col gap-0.5 rounded px-1 py-1 text-[10px] leading-none transition-colors hover:bg-[var(--mx-hover-bg)]"
      title={`${a.toolName} ${a.summary}\n${new Date(a.ms).toLocaleString()}`}
    >
      <span className="flex w-full items-center gap-1.5">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--mx-text)]">{a.toolName}</span>
        <span className="shrink-0 text-[9px]" style={{ color }}>
          {level === "auto"
            ? t("conductor.autoApprove.allowed")
            : t("conductor.autoApprove.escalated", { reason: a.reason ?? "" })}
        </span>
      </span>
      <span className="truncate pl-3 text-[var(--mx-muted)] opacity-85">{a.summary}</span>
      <span className="pl-3 tabular-nums text-[var(--mx-muted)] opacity-50">{stamp}</span>
    </li>
  );
}
