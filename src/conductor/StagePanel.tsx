/**
 * StagePanel —— 「Agent 实况」演进游戏共享件(2026-11-19;当日四轮演化:指挥台内嵌
 * → 独立大屏 → 单屏 HUD → **引擎形态**,用户指定参考 cromma.ai/code#game-view:
 * 「中间是执行状态,像光点一样打进一个引擎,底部是 4 个图表」)。
 *
 * 数据流:感知链(events.rs collect_beats)环形缓冲 → 只读基线(conductor_snapshot
 * .toolBeats / conductor_tool_beats)+ `conductor-tool-event` 增量推送,消费侧按 seq
 * 归并后整列传入(新拍恒在顶部)。静音项目的帧在感知链入口就被丢,实况天然不播。
 *
 * 导出件:
 * - [`StageConsole`] 引擎舞台(大屏中央):每次工具调用 = 一枚光点从侧翼飞进反应核,
 *   命中即脉冲 + XP 入账;核下是等级/进度条/连击。XP 为运行期累加(冷启动取后端
 *   总账 baseXp,窗口关闭归零的不落盘部分仅限前端增量显示);
 * - [`BeatRow`] 拍流行(大屏两行式 / 窄栏单行,showSession 切换);
 * - [`ActivityPulse`]/[`LoadoutStats`]/[`HBarList`] 底部图表件(15 分钟像素柱 /
 *   四类装备条 / 通用横向条——工具 Top 与会话火力共用);
 * - [`toolColor`]/[`sessionColor`] 分色口径(底部微条/拍流/图表共用)。
 *
 * 美学:像素字(Pixelify Sans)上数字、crispEdges 方点刻度、阶梯描边仪表件;
 * 分隔语言是排版层级(标签行/大数/正文),不是盒子套盒子。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InboxTarget, ToolBeat } from "../domain/conductor";
import { relativeTime } from "./ui";
import {
  CAT_COLORS,
  beatWeight,
  sessionColor,
  toolCat,
  toolColor,
  type ToolCat,
} from "./stageColors";
import { EngineCore } from "./EngineCore";

// 分色/分类/XP 权重口径收在 stageColors.ts(2026-11-23,EngineCore 与本件共用,
// 防 StagePanel ↔ EngineCore 循环 import);此处转发导出保住既有消费面。
export { sessionColor, toolColor } from "./stageColors";

/** 连击窗口:相邻两拍间隔 ≤20s 算连招延续。 */
const COMBO_MS = 20_000;
/** 等级门槛(L1..L6 累计 XP);L6 之后每 +600 升一级,称号保持最高段。
 *  2026-11-20 重标:XP 记录化后是**终身总账**(每拍读1/写2/执行2/派生3,活跃干活
 *  ~2-6 XP/分钟),旧门槛(L2=30)十几拍就升二级,「还没怎么就2级了」——按终身口径
 *  重标:L2 ≈ 半小时活跃活,L4 ≈ 一天正常使用,L6 ≈ 一周积累。 */
const LEVEL_BASE = [0, 200, 500, 1000, 1800, 3000];
const LEVEL_SPAN = 600;
/** 游戏进度条格数(像素分段)。 */
const PROGRESS_SEGS = 12;

function levelOf(xp: number): { lv: number; into: number; span: number } {
  if (xp >= LEVEL_BASE[5]) {
    const over = xp - LEVEL_BASE[5];
    return { lv: 6 + Math.floor(over / LEVEL_SPAN), into: over % LEVEL_SPAN, span: LEVEL_SPAN };
  }
  let i = 0;
  while (i + 1 < LEVEL_BASE.length && xp >= LEVEL_BASE[i + 1]) i++;
  return { lv: i + 1, into: xp - LEVEL_BASE[i], span: LEVEL_BASE[i + 1] - LEVEL_BASE[i] };
}

/** 拍流行(大屏 full 两行式 / 窄栏 compact 单行,由 `showSession` 切换):
 *  头行 = 会话色点 + 会话标题 + 工具名(分色) + 相对时间,副行 = 摘要全宽——
 *  大屏行高换信息密度,窄栏保持单行紧凑。 */
export function BeatRow({
  beat,
  title,
  showSession = false,
  onPick,
}: {
  beat: ToolBeat;
  /** 会话标题(tabTitle join;快照口径)。 */
  title: string;
  showSession?: boolean;
  /** 点拍联动(加派活目标);缺省 = 无动作(独立窗只读展示)。 */
  onPick?: (target: InboxTarget) => void;
}) {
  const { t } = useTranslation();
  const key = `${beat.projectId}/${beat.tabId}`;
  const hint = onPick ? `\n${t("conductor.stage.pickHint")}` : "";
  if (showSession) {
    // 大屏两行式:头行身份,副行摘要(不再挤一行);单屏语境无卡片——
    // hover 只变背景,新拍滑入保留。
    return (
      <button
        type="button"
        onClick={() => onPick?.({ projectId: beat.projectId, tabId: beat.tabId })}
        title={`${title} · ${beat.tool} ${beat.summary}\n${relativeTime(beat.ms, t)}${hint}`}
        className="mx-beat-in flex w-full cursor-pointer flex-col gap-0.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-[var(--mx-hover-bg)]"
      >
        <span className="flex w-full items-center gap-1.5 text-[11px] leading-none">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: sessionColor(key) }}
          />
          <span className="min-w-0 flex-1 truncate text-[var(--mx-text)]" title={title}>
            {title}
          </span>
          <span className="shrink-0 truncate font-semibold" style={{ color: toolColor(beat.tool) }}>
            {beat.tool}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--mx-muted)] opacity-70">
            {relativeTime(beat.ms, t)}
          </span>
        </span>
        <span className="truncate pl-3.5 text-[10px] leading-none text-[var(--mx-muted)] opacity-85">
          {beat.summary}
        </span>
      </button>
    );
  }
  // 窄栏单行式。
  return (
    <button
      type="button"
      onClick={() => onPick?.({ projectId: beat.projectId, tabId: beat.tabId })}
      title={`${title} · ${beat.tool} ${beat.summary}\n${relativeTime(beat.ms, t)}${hint}`}
      className="mx-beat-in mx-chip flex h-5 w-full cursor-pointer items-center gap-1.5 border border-transparent bg-transparent px-1 text-left text-[10px] transition-colors hover:border-[var(--mx-border)] hover:bg-[var(--mx-hover-bg)]"
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: sessionColor(key) }}
      />
      <span className="w-[68px] shrink-0 truncate font-semibold" style={{ color: toolColor(beat.tool) }}>
        {beat.tool}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--mx-text)] opacity-85">{beat.summary}</span>
      <span className="shrink-0 text-[9px] tabular-nums text-[var(--mx-muted)] opacity-70">
        {relativeTime(beat.ms, t)}
      </span>
    </button>
  );
}

/** XP 总账 hook(引擎与底部等级条共用,2026-11-19 等级条下沉到整窗底):ref 按
 *  seq 去重(拍列 80 条封顶,老拍出窗不回吐);冷启动 baseXp>0 = 后端总账起步
 *  (窗口内拍已含,只记 lastSeq 供增量起步),否则退回窗口内播种(旧后端/无记录
 *  过渡);ledger 一旦初始化不再接受 baseXp 变化(refetch 防回退闪烁)。附带升级
 *  演出状态(跨档瞬间 flash/burst 置位 900ms,一次性)。 */
export type StageXpState = {
  xp: number;
  lv: number;
  into: number;
  span: number;
  flash: boolean;
  burst: boolean;
};

export function useStageXp(beats: ToolBeat[], baseXp?: number): StageXpState {
  // XP 记账(同原 StageConsole 内嵌口径)。
  const ledgerRef = useRef<{ xp: number; lastSeq: number } | null>(null);
  const [stats, setStats] = useState({ xp: 0 });
  useEffect(() => {
    if (beats.length === 0) return;
    if (ledgerRef.current === null) {
      let seeded = 0;
      let lastSeq = 0;
      for (const b of beats) {
        seeded += beatWeight(b.tool);
        if (b.seq > lastSeq) lastSeq = b.seq;
      }
      const xp = baseXp && baseXp > 0 ? baseXp : seeded;
      ledgerRef.current = { xp, lastSeq };
      setStats({ xp });
      return;
    }
    const acc = ledgerRef.current;
    let dxp = 0;
    for (const b of beats) {
      if (b.seq > acc.lastSeq) dxp += beatWeight(b.tool);
    }
    if (dxp > 0) {
      acc.xp += dxp;
      acc.lastSeq = beats[0].seq;
      setStats({ xp: acc.xp });
    }
  }, [beats, baseXp]);

  // 升级演出:等级跨档瞬间置位(一次性,900ms 自清)。
  const lvRef = useRef(0);
  const [flash, setFlash] = useState(false);
  const [burst, setBurst] = useState(false);
  const { lv, into, span } = levelOf(stats.xp);
  useEffect(() => {
    if (lvRef.current > 0 && lv > lvRef.current) {
      setFlash(true);
      setBurst(true);
    }
    lvRef.current = lv;
  }, [lv]);
  useEffect(() => {
    if (!flash && !burst) return;
    const id = setTimeout(() => {
      setFlash(false);
      setBurst(false);
    }, 900);
    return () => clearTimeout(id);
  }, [flash, burst]);

  return { xp: stats.xp, lv, into, span, flash, burst };
}

/** 引擎舞台外壳(2026-11-23 重构:引擎本体移交 [`EngineCore`] canvas 组件——
 *  用户「中间的动态效果感觉很low,就一个圈里面几个点」,旧 SVG 逐拍才动、静默期
 *  整台死机;新引擎 rAF 连续运转,见 EngineCore.tsx 头注)。本件只保留:1s 心跳
 *  (combo 衰减/相对时间新鲜度)、最新拍 chip(引擎下方出料口)与连击挂件。 */
export function StageConsole({
  beats,
  xp,
  runningKeys,
}: {
  beats: ToolBeat[];
  /** XP 演出状态(useStageXp;升级横幅在核区爆发)。 */
  xp: StageXpState;
  /** 运行中会话键(`projectId/tabId`)。 */
  runningKeys?: string[];
}) {
  const { t } = useTranslation();

  // 1s 心跳:combo 衰减与相对时间的新鲜度(只在有拍时跑)。
  const [, setTick] = useState(0);
  const alive = beats.length > 0;
  useEffect(() => {
    if (!alive) return;
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [alive]);

  if (!alive) return null;

  const latest = beats[0];
  // 连击:从最新拍向过去数相邻间隔 ≤20s 的连续段;静默超窗直接断(1s tick 让它可见)。
  let combo = 0;
  if (Date.now() - latest.ms <= COMBO_MS) {
    combo = 1;
    for (let i = 0; i + 1 < beats.length && beats[i].ms - beats[i + 1].ms <= COMBO_MS; i++) combo += 1;
  }
  const active = Date.now() - latest.ms <= 60_000 || (runningKeys?.length ?? 0) > 0;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2.5">
      {/* 引擎本体:canvas 反应炉(EngineCore rAF 连续渲染——扫描扇/三层反向旋转环/
          环境粒子/燃料彗星坠核/冲击波,能量随会话活跃度呼吸);升级横幅仍覆在其上。 */}
      <div className="relative min-h-0 w-full flex-1">
        <EngineCore beats={beats} active={active} runningKeys={runningKeys ?? []} />
        {xp.burst && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div
              className="mx-level-burst mx-px-frame mx-px-font bg-[var(--mx-card-bg)] px-3 py-1 text-[22px] font-bold leading-tight"
              style={{ color: "var(--mx-accent)" }}
            >
              {t("conductor.stage.levelUp")}
            </div>
          </div>
        )}
      </div>

      {/* 最新拍 chip(prompt-chip):引擎的「出料口标签」,每拍 pop。宽度硬上限
          320px(2026-11-19 两轮:先发现 flex 子项无 min-w-0 不收缩,再发现
          max-w-full 上限=整列宽,窗口一宽长 PowerShell 命令照样横跨引擎区——
          限 320px 截断,全文 hover title)。 */}
      <div
        key={latest.seq}
        className="mx-px-chip mx-px-pop flex max-w-[320px] shrink-0 items-center gap-1 px-1.5 py-0.5 text-[11px] leading-none"
      >
        <span className="shrink-0 font-semibold" style={{ color: toolColor(latest.tool) }}>
          {latest.tool}
        </span>
        <span className="min-w-0 flex-1 truncate text-[var(--mx-text)] opacity-80" title={latest.summary}>
          {latest.summary}
        </span>
        <span className="shrink-0 tabular-nums text-[var(--mx-muted)]">{relativeTime(latest.ms, t)}</span>
      </div>

      {/* 连击(引擎右下角挂件):×N 跳数 pop——等级条已下沉整窗底,这里只留游戏
          打击感。 */}
      {combo >= 2 && (
        <span
          key={combo}
          className="mx-px-pop mx-px-font shrink-0 text-[16px] font-bold tabular-nums"
          style={{ color: "var(--mx-accent)" }}
          title={t("conductor.stage.comboHint")}
        >
          ×{combo}
        </span>
      )}
    </div>
  );
}

/** 等级条(整窗底部横条,2026-11-19 下沉,用户:「L1 等级这种放到底部」;
 *  2026-11-20 用户:「经验条占比太重了,淡化下显示」——去像素粗边大数字,降为
 *  细条弱色:小号 muted 等级字 + 3px 细进度线(hover-bg 轨道/accent-soft 填充),
 *  XP 计数弱化,只在升级瞬间短暂亮起(flash 保留)。 */
export function StageLevelBar({ xp }: { xp: StageXpState }) {
  const { t } = useTranslation();
  const levelNames = [
    t("conductor.stage.level1"),
    t("conductor.stage.level2"),
    t("conductor.stage.level3"),
    t("conductor.stage.level4"),
    t("conductor.stage.level5"),
    t("conductor.stage.level6"),
  ];
  const title = levelNames[Math.min(xp.lv, 6) - 1];
  const pct = Math.min(100, Math.round((xp.into / xp.span) * 100));
  return (
    <div className="flex w-full items-center gap-2 px-1 text-[11px]">
      <span
        className="shrink-0 font-semibold leading-none tabular-nums text-[var(--mx-muted)]"
        style={xp.flash ? { color: "var(--mx-accent)" } : undefined}
      >
        Lv.{xp.lv}
      </span>
      <span className="shrink-0 truncate text-[var(--mx-muted)] opacity-80" title={title}>
        {title}
      </span>
      <div className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-sm bg-[var(--mx-hover-bg)]">
        <div
          key={xp.xp}
          className="h-full transition-[width] duration-300"
          style={{
            width: `${pct}%`,
            /* 2026-11-20 用户:「经验色值增强一丢」——accent-soft 太虚,升为 accent
               82% 透明度,可辨仍不抢戏。 */
            background: "var(--mx-accent)",
            opacity: 0.82,
            filter: xp.flash ? "brightness(1.8)" : undefined,
          }}
        />
      </div>
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--mx-muted)] opacity-70">
        {xp.xp} XP
      </span>
    </div>
  );
}

/** 活动强度图表:最近 15 分钟每分钟拍数像素柱——高度 4px 粒度步进(像素美学,
 *  不做平滑插值),当前分钟 accent 呼吸,无拍 2px 地线保持栅格连续。
 *  分钟分桶随父级重渲染(1s/30s tick)滚动重算。 */
export function ActivityPulse({ beats }: { beats: ToolBeat[] }) {
  const BUCKETS = 15;
  const nowBucket = Math.floor(Date.now() / 60_000);
  const counts = new Array<number>(BUCKETS).fill(0);
  for (const b of beats) {
    const age = nowBucket - Math.floor(b.ms / 60_000);
    if (age >= 0 && age < BUCKETS) counts[BUCKETS - 1 - age] += 1;
  }
  const max = Math.max(1, ...counts);
  return (
    <div className="flex h-[38px] items-end justify-between gap-[3px]">
      {counts.map((n, i) => {
        const current = i === BUCKETS - 1;
        const h = n === 0 ? 2 : Math.max(4, Math.round((n / max) * 8) * 4);
        return (
          <div
            key={i}
            className={`min-w-[4px] flex-1 ${current ? "animate-pulse" : ""}`}
            style={{
              height: `${h}px`,
              background: current ? "var(--mx-accent)" : n > 0 ? "var(--mx-text)" : "var(--mx-border)",
              opacity: n > 0 ? (current ? 1 : 0.75) : 0.5,
            }}
            title={`${n}`}
          />
        );
      })}
    </div>
  );
}

/** 装备统计图表:四类工具(读/写/执行/派生)拍数 + 12 段像素占比条,
 *  分类色与拍流工具名同源(「装备栏」语义)。 */
export function LoadoutStats({ beats }: { beats: ToolBeat[] }) {
  const { t } = useTranslation();
  const counts: Record<Exclude<ToolCat, "other">, number> = { read: 0, write: 0, exec: 0, spawn: 0 };
  for (const b of beats.slice(0, 80)) {
    const c = toolCat(b.tool);
    if (c !== "other") counts[c] += 1;
  }
  const max = Math.max(1, ...Object.values(counts));
  const rows: [Exclude<ToolCat, "other">, string][] = [
    ["read", t("conductor.stage.catRead")],
    ["write", t("conductor.stage.catWrite")],
    ["exec", t("conductor.stage.catExec")],
    ["spawn", t("conductor.stage.catSpawn")],
  ];
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([cat, label]) => {
        const n = counts[cat];
        const filled = Math.round((n / max) * 12);
        return (
          <div key={cat} className="flex items-center gap-1.5 text-[10px] leading-none">
            <span className="w-[28px] shrink-0 text-[var(--mx-muted)]">{label}</span>
            <span className="mx-px-font shrink-0 text-[12px] font-bold tabular-nums text-[var(--mx-text)]">
              {n}
            </span>
            <div className="flex min-w-0 flex-1 gap-[2px]">
              {Array.from({ length: 12 }, (_, i) => (
                <div
                  key={i}
                  className="min-w-[2px] flex-1"
                  style={{
                    height: "6px",
                    background: i < filled ? CAT_COLORS[cat] : "var(--mx-hover-bg)",
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 通用横向条图表(工具 Top / 会话火力共用):label 分色 + 像素字计数 +
 *  相对榜首的占比条(8px 高,无圆角)。空数据出占位文案。 */
export function HBarList({
  rows,
  emptyText,
}: {
  rows: { key: string; label: string; color: string; n: number }[];
  emptyText: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (rows.length === 0) {
    return <div className="py-2 text-[10px] text-[var(--mx-muted)] opacity-70">{emptyText}</div>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-1.5 text-[10px] leading-none">
          <span
            className="w-[70px] shrink-0 truncate font-[600]"
            style={{ color: r.color }}
            title={r.label}
          >
            {r.label}
          </span>
          <div className="min-w-0 flex-1" aria-hidden>
            <div
              className="h-2"
              style={{ width: `${Math.max(5, (r.n / max) * 100)}%`, background: r.color }}
            />
          </div>
          <span className="mx-px-font shrink-0 text-[12px] font-bold tabular-nums text-[var(--mx-text)]">
            {r.n}
          </span>
        </div>
      ))}
    </div>
  );
}
