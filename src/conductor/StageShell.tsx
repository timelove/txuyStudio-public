/**
 * StageShell —— Agent 实况独立窗的根界面(label === "agent-stage" 的 webview 渲染,
 * 2026-11-19,用户:「agent 实况单独窗口打开,这样看起来比较爽,里面的内容也能更丰富」)。
 *
 * **引擎形态(同日第四轮,用户指定参考 cromma.ai/code#game-view:「中间是执行状态,
 * 像光点一样打进一个引擎,底部是 4 个图表」)**:整窗内容区 = 一台「游戏机」——
 * mx-px-frame 像素外框包一块屏幕(方格纸底铺满),不再切卡片:
 * - 上部主体:**引擎舞台**(StageConsole:光点飞进反应核 + 等级/XP/连击)居左,
 *   拍流列贴右(两行式行卡);中间一条竖 hairline——光点从拍流方向飞向引擎,
 *   空间叙事与数据流向一致;
 * - 底部:4 个图表并排(活动强度/装备统计/工具 Top/会话火力),标题行右侧挂
 *   对应大数(RATE/EDITS/CALLS/AGENTS 归位图表头)。
 * 区块分隔语言 = SectionLabel 标签行 + hairline,层级来自排版(标签/大数/正文
 * 三级字阶),不靠盒子套盒子。
 *
 * 数据流与 ConductorShell 同构:conductor_snapshot 冷启动基线(含 stageXp 总账)
 * + conductor-event 350ms 防抖 refetch(富化会话标题)+ conductor-tool-event 逐帧增量
 * (mergeToolBeats 按 seq 归并)。
 *
 * 窗口语义(封层管理):✕ 按钮 window.close() → 后端 CloseRequested → hide
 * (隐藏不销毁,顶栏入口随时重开);bounds 防抖落 conductor.json stage_bounds
 * (save_stage_window_bounds,后端 CloseRequested 再兜底补存)。
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type {
  ConductorEventPayload,
  ConductorSnapshot,
  ConductorToolEventPayload,
  ToolBeat,
} from "../domain/conductor";
import { mergeToolBeats } from "../domain/conductor";
import {
  ActivityPulse,
  BeatRow,
  HBarList,
  LoadoutStats,
  sessionColor,
  StageConsole,
  StageLevelBar,
  toolColor,
  useStageXp,
} from "./StagePanel";

/** conductor-event → refetch 的防抖(与指挥窗同口径)。 */
const REFETCH_DEBOUNCE_MS = 350;
/** bounds 防抖(与主窗口 350ms 同口径)。 */
const BOUNDS_DEBOUNCE_MS = 350;
/** 相对时间刷新间隔。 */
const TICK_MS = 30_000;

export function StageShell() {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<ConductorSnapshot | null>(null);
  /** 拍流(seq 降序):快照基线 + conductor-tool-event 增量,按 seq 归并。 */
  const [beats, setBeats] = useState<ToolBeat[]>([]);
  // 相对时间「N 分钟前」的刷新心跳(纯触发重渲染,值不用)。
  const [, setTick] = useState(0);

  const fetchSnapshot = useCallback(async () => {
    try {
      const s = await invoke<ConductorSnapshot>("conductor_snapshot");
      setSnap(s);
      setBeats((prev) => mergeToolBeats(s.toolBeats ?? [], prev));
    } catch (err) {
      // 非 Tauri(浏览器直开)/命令不可用:静默,界面停在空态。
      console.warn("[stage] snapshot failed:", err);
    }
  }, []);

  // 挂载首拉 + conductor-event 防抖 refetch(会话标题随快照富化)。
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

  // 拍流增量订阅:感知链每帧新拍直推,不经快照;按 seq 归并防与快照竞态。
  // 自证日志(log 插件 Webview target 会把 console 落到日志文件):「引擎不动」时
  // 先看这里——有事件=前端收到,问题在渲染;无事件=拍没到 webview。
  useEffect(() => {
    console.info("[stage] shell booted");
    let unlisten: (() => void) | undefined;
    listen<ConductorToolEventPayload>("conductor-tool-event", (e) => {
      console.info("[stage] tool-event beats=", e.payload.beats?.length ?? 0);
      setBeats((prev) => mergeToolBeats(prev, e.payload.beats));
    })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  // 相对时间心跳。
  useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // 窗口 bounds 防抖持久化(镜像 ConductorShell;落 conductor.json stage_bounds)。
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
              await invoke("save_stage_window_bounds", {
                bounds: { x: 0, y: 0, width: 0, height: 0, maximized: true },
              });
              return;
            }
            const pos = await win.outerPosition();
            const size = await win.outerSize();
            await invoke("save_stage_window_bounds", {
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

  /** Agent 实况热度:最近 60 秒拍数(铭牌行徽标口径)。 */
  const hotBeats = beats.filter((b) => Date.now() - b.ms < 60_000).length;
  /** 拍流里出现过的会话数(图表头大数)。 */
  const agents = new Set(beats.slice(0, 48).map((b) => `${b.projectId}/${b.tabId}`)).size;
  // XP 总账(引擎与底部等级条共用;2026-11-19 等级条下沉整窗底)。
  const xp = useStageXp(beats, snap?.stageXp);

  // 会话标题 join:sessions(有会话态的)+ tabs(全量 AI tab 含未启动)两张表——
  // 只查 sessions 会漏「没启动过事件的 tab」;仍 miss(历史拍,tab 已删)回退
  // `claude · ai-1` 可读形态(裸 tabId 看不懂它是啥,2026-11-19 用户问「ai-1 干啥的」)。
  const tabTitle = new Map<string, string>();
  for (const s of snap?.sessions ?? []) {
    tabTitle.set(`${s.projectId}/${s.tabId}`, s.tabTitle || s.tabId);
  }
  for (const tab of snap?.tabs ?? []) {
    const key = `${tab.projectId}/${tab.id}`;
    if (!tabTitle.has(key)) tabTitle.set(key, tab.title || tab.id);
  }
  const titleOf = (b: ToolBeat) =>
    tabTitle.get(`${b.projectId}/${b.tabId}`) ?? `${b.provider} · ${b.tabId}`;

  // 底部图表数据(窗口口径,全部由 beats 派生):
  // 工具 Top:频次前 5(并列按名稳定);会话火力:按会话聚合前 5(标签随聚合
  // 首见拍取标题,miss 回退 provider·tabId)。
  const toolFreq = new Map<string, number>();
  const sessFreq = new Map<string, { n: number; label: string }>();
  for (const b of beats.slice(0, 80)) {
    toolFreq.set(b.tool, (toolFreq.get(b.tool) ?? 0) + 1);
    const key = `${b.projectId}/${b.tabId}`;
    const cur = sessFreq.get(key);
    if (cur) cur.n += 1;
    else sessFreq.set(key, { n: 1, label: titleOf(b) });
  }
  const toolTop = [...toolFreq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 4)
    .map(([tool, n]) => ({ key: tool, label: tool, color: toolColor(tool), n }));
  const sessionFire = [...sessFreq.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 4)
    .map(([key, v]) => ({ key, label: v.label, color: sessionColor(key), n: v.n }));

  return (
    // 标题栏高度独立(30px,指挥窗同款)。
    <div
      className="flex h-screen flex-col bg-[var(--mx-bg)] text-[var(--mx-text)]"
      style={{ "--mx-titlebar-h": "30px" } as CSSProperties}
    >
      {/* 铭牌行(自绘标题栏,decorations:false):设备顶部的「铭牌」——名称 + 热度 +
          副标题,右侧 ✕ = 隐藏(后端拦截 close 转 hide)。 */}
      <header
        data-tauri-drag-region
        className="flex h-[length:var(--mx-titlebar-h)] shrink-0 select-none items-center gap-2 px-3"
      >
        <span className="mx-px-font text-[13px] font-bold tracking-[0.04em] uppercase">
          {t("conductor.stage.title")}
        </span>
        {hotBeats > 0 && (
          <span
            title={t("conductor.stage.hotBadge", { n: hotBeats })}
            className="rounded-full bg-[var(--mx-accent-soft)] px-1.5 text-[10px] leading-4 tabular-nums text-[var(--mx-accent)]"
          >
            {hotBeats}
          </span>
        )}
        <span className="truncate text-[10px] opacity-60">{t("conductor.stage.subtitle")}</span>
        <div className="ml-auto flex items-center" onMouseDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            aria-label={t("conductor.hide")}
            title={t("conductor.hide")}
            onClick={() => {
              // close 走后端 CloseRequested → prevent_close + hide(语义集中在后端)。
              getCurrentWindow().close().catch(() => {});
            }}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>

      {/* 一台「游戏机」:像素外框包一块屏幕,方格纸底铺满——上部引擎舞台 + 拍流,
          底部 4 图表。 */}
      <main className="mx-px-frame mx-grid-paper mx-scroll-pretty m-2 flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--mx-card-bg)]">
        {beats.length === 0 ? (
          // 空态:静默期屏幕居中(纯文本回复不出拍,提示去开个会干点活)。
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
            <div className="text-xs text-[var(--mx-muted)]">{t("conductor.stage.empty")}</div>
            <div className="text-[11px] text-[var(--mx-muted)] opacity-70">{t("conductor.stage.emptyHint")}</div>
          </div>
        ) : (
          <>
            {/* 上部:引擎舞台居左(光点从拍流方向飞进反应核)+ 拍流贴右,竖 hairline。 */}
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
                <StageConsole
                  beats={beats}
                  xp={xp}
                  runningKeys={(snap?.sessions ?? [])
                    .filter((s) => s.kind === "running" || s.kind === "waiting_approval")
                    .map((s) => `${s.projectId}/${s.tabId}`)}
                />
              </div>
              <div aria-hidden className="hidden w-px shrink-0 bg-[var(--mx-border)] opacity-60 md:block" />
              <div className="flex min-h-[160px] w-full shrink-0 flex-col p-3 md:w-[300px]">
                <SectionLabel text={t("conductor.stage.feedTitle")} count={`${agents}`} />
                <ul className="mx-scroll-pretty flex min-h-0 flex-1 flex-col gap-px overflow-y-auto pr-1">
                  {beats.map((b) => (
                    <li key={b.seq}>
                      <BeatRow beat={b} showSession title={titleOf(b)} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* 底部仪表带:4 图表并排(活动强度/装备统计/工具 Top/会话火力),标题行
                右挂对应大数;再下一条整宽等级条(Lv/称号/进度/XP,2026-11-19 下沉)。
                2026-11-20 用户两改:①「4 个图表走卡片式,圆角风格」——裸排改圆角
                卡片(surface-soft 底+border+rounded-lg+内边距);②四块图表体统一
                58px 定高槽(各图行数随数据漂移 2~5 行忽高忽低;定 4 行口径+固定槽
                高,内容不足垂直居中,四块永远一样高)。 */}
            <div className="shrink-0 border-t border-[var(--mx-border)]">
              <div className="grid grid-cols-2 gap-2.5 p-2.5 md:grid-cols-4">
                <div className="flex min-w-0 flex-col rounded-lg border border-[var(--mx-border)] bg-[var(--mx-surface-soft)] p-2.5">
                  <ChartTitle label={t("conductor.stage.activity")} count={`${hotBeats}`} />
                  <div className="flex h-[58px] flex-col justify-center">
                    <ActivityPulse beats={beats} />
                  </div>
                </div>
                <div className="flex min-w-0 flex-col rounded-lg border border-[var(--mx-border)] bg-[var(--mx-surface-soft)] p-2.5">
                  <ChartTitle label={t("conductor.stage.loadout")} />
                  <div className="flex h-[58px] flex-col justify-center">
                    <LoadoutStats beats={beats} />
                  </div>
                </div>
                <div className="flex min-w-0 flex-col rounded-lg border border-[var(--mx-border)] bg-[var(--mx-surface-soft)] p-2.5">
                  <ChartTitle label={t("conductor.stage.topTools")} count={`${beats.length}`} />
                  <div className="flex h-[58px] flex-col justify-center">
                    <HBarList rows={toolTop} emptyText={t("conductor.stage.empty")} />
                  </div>
                </div>
                <div className="flex min-w-0 flex-col rounded-lg border border-[var(--mx-border)] bg-[var(--mx-surface-soft)] p-2.5">
                  <ChartTitle label={t("conductor.stage.sessionFire")} count={`${agents}`} />
                  <div className="flex h-[58px] flex-col justify-center">
                    <HBarList rows={sessionFire} emptyText={t("conductor.stage.empty")} />
                  </div>
                </div>
              </div>
              <div className="px-3 py-1.5">
                <StageLevelBar xp={xp} />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/** 区块标签行(单屏 HUD 的分隔语言,替代边框卡片的面板头):accent 方块 + 小型
 *  大写字距文字 + 可选计数;上下留白承担分组,不画盒子。 */
function SectionLabel({ text, count }: { text: string; count?: string }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 pb-1.5 text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--mx-muted)]">
      <span aria-hidden className="h-[6px] w-[6px] shrink-0 bg-[var(--mx-accent)]" />
      <span>{text}</span>
      {count && <span className="tabular-nums opacity-70">{count}</span>}
    </div>
  );
}

/** 图表标题行(底部 4 图表统一):标签 + 右侧像素字大数(RATE/EDITS/CALLS/AGENTS
 *  归位到各图表头,大数即仪表读数)。 */
function ChartTitle({ label, count }: { label: string; count?: string }) {
  return (
    <div className="flex shrink-0 items-baseline justify-between gap-2 pb-1.5 text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--mx-muted)]">
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden className="h-[6px] w-[6px] shrink-0 bg-[var(--mx-accent)]" />
        <span className="truncate">{label}</span>
      </span>
      {count && (
        <span className="mx-px-font shrink-0 text-[14px] font-bold tabular-nums text-[var(--mx-text)]">
          {count}
        </span>
      )}
    </div>
  );
}
