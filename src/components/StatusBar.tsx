import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ProjectSnapshot } from "../domain/projects";
import { projectAccentColor } from "../domain/projects";
import type { ClaudeStatusEntry } from "../domain/claudeStatusRegistry";
import type { CodexStatusEntry } from "../domain/codexStatusRegistry";
import type { ClaudeSessionKind } from "../domain/claudeStream";
import { autoCheckUpdate, getUpdaterSnapshot, subscribeUpdater, type UpdaterSnapshot } from "../domain/appUpdater";
import { SettingsModal } from "./SettingsModal";
import { Button } from "./ui/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";

type StatusBarProps = {
  /** 聚焦项目(选中 shell 所属项目);无聚焦项目时为 null。 */
  focusedProject: ProjectSnapshot | null;
  /** 聚焦项目的 git 分支(由 AppShell 按 rootPath 去重拉取)。null=非 git;undefined=未查。 */
  gitBranch?: string | null;
  /** 全部 claude tab 的对外状态汇总(供跨 tab 显示运行/等待/出错计数)。 */
  claudeStatuses: ClaudeStatusEntry[];
  /** 全部 codex tab 的对外状态汇总(与 claude 并列合并计数;kind 是 ClaudeSessionKind 子集)。 */
  codexStatuses?: CodexStatusEntry[];
  /** 点击某 AI 状态药丸 -> 跳到该状态第一个 claude/codex tab。 */
  onFocusClaudeTab?: (projectId: string, tabId: string) => void;
};

/** 健康提醒的自然时间窗口长度(ms)。tip 按此时长对齐到墙上时钟轮换(默认 30min → :00 / :30 边界)。后续设置面板接入后改为从 settings 读取。 */
const HEALTH_TIP_INTERVAL_MS = 30 * 60 * 1000; // 30 min → 对齐到 :00 / :30
/** 内存占用轮询间隔(ms)。 */
const MEMORY_POLL_MS = 2500;
/** 新 tip 轮换到时的高亮提示时长(ms)。 */
const TIP_HIGHLIGHT_MS = 4000;

/** 健康 tip:i18n key(tip/done),StatusBar 渲染时 t() 翻译。emoji 保留在文案里。 */
const HEALTH_TIPS: { tip: string; done: string }[] = [
  { tip: "tip.water.tip", done: "tip.water.done" },
  { tip: "tip.lift.tip", done: "tip.lift.done" },
];

/**
 * 底部状态栏:左聚焦项目绝对路径 | 中/右 内存占用% | 最右 健康提醒 tip 轮播。
 *
 * - 路径仅聚焦项目一项(不并排全部可见项目),超长尾部省略,hover title 全路径。
 * - 内存 `invoke("get_system_memory")` 每 2.5s 轮询;失败(mock/非 Tauri)隐藏该区。
 * - 健康 tip 两条轮换,跟随自然时间——对齐到每个 :00 / :30 边界换下一条并短暂高亮;窗口长度为常量(为后续设置预留接缝)。
 *
 * 生命周期:所有 interval 在卸载时清除,避免后台空转 invoke。
 */
export function StatusBar({ focusedProject, gitBranch, claudeStatuses, codexStatuses, onFocusClaudeTab }: StatusBarProps) {
  const { t } = useTranslation();
  const [mem, setMem] = useState<{ usedBytes: number; totalBytes: number } | null>(null);
  const [tipIdx, setTipIdx] = useState(0);
  const [tipHighlight, setTipHighlight] = useState(false);
  /** 当前 tip 已被用户点击「完成」→ 隐藏;下一轮轮换时自动恢复显示新 tip。 */
  const [tipHidden, setTipHidden] = useState(false);
  /** 设置面板开关(齿轮点击触发)。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 设置面板初始 tab:「新版本可用」chip 点击 → about(更新器在那);齿轮打开不指定。 */
  const [settingsTab, setSettingsTab] = useState<"general" | "shortcuts" | "about">("general");
  /** 全局更新快照(启动自动检查驱动;见 domain/appUpdater)。 */
  const [updaterSnap, setUpdaterSnap] = useState<UpdaterSnapshot>(() => getUpdaterSnapshot());

  // 启动自动检查更新:延迟 8s(避开首屏 hydrate/PTY 启动高峰),24h 节流在 store 内。
  // 订阅快照供「新版本可用」chip;检查失败静默(error 态不显示任何 UI)。
  useEffect(() => {
    const timer = window.setTimeout(() => void autoCheckUpdate().catch(() => {}), 8000);
    const unsub = subscribeUpdater(setUpdaterSnap);
    return () => {
      window.clearTimeout(timer);
      unsub();
    };
  }, []);

  // 内存轮询。invoke 失败(非 Tauri 环境)→ 置 null,该区隐藏。
  useEffect(() => {
    let alive = true;
    const fetchMem = () => {
      invoke<{ usedBytes: number; totalBytes: number }>("get_system_memory")
        .then((m) => {
          if (alive) setMem({ usedBytes: m.usedBytes, totalBytes: m.totalBytes });
        })
        .catch(() => {
          if (alive) setMem(null);
        });
    };
    fetchMem();
    const id = window.setInterval(fetchMem, MEMORY_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // 健康 tip 轮播:跟随自然时间——对齐到每个 :00 / :30 边界轮换。
  // 基于 Date.now() 的递归 setTimeout:每次到边界按真实时刻重算 tip,
  // 既对齐墙上时钟、又能在 webview 后台节流后自我修正漂移(不盲 setInterval 累加)。
  useEffect(() => {
    const WINDOW = HEALTH_TIP_INTERVAL_MS;
    // 当前自然窗口对应的 tip 索引(Unix 毫秒 / 窗口长度 % tip 数;窗口正好落在 :00/:30)。
    const indexFor = (now: number) =>
      Math.floor(now / WINDOW) % HEALTH_TIPS.length;
    // 到下一个 :00 / :30 边界的毫秒数。
    const msUntilNext = (now: number) =>
      (Math.floor(now / WINDOW) + 1) * WINDOW - now;

    let timer: number | undefined;
    // 到边界:轮换 tip + 高亮 + 清「已完成」;再安排下一次。
    const tick = () => {
      const now = Date.now();
      setTipIdx(indexFor(now));
      setTipHighlight(true);
      setTipHidden(false);
      timer = window.setTimeout(tick, msUntilNext(now));
    };
    // 挂载:立即按当前自然时间定位 tip(不高亮,非「新轮换」),再安排到下一个边界。
    setTipIdx(indexFor(Date.now()));
    timer = window.setTimeout(tick, msUntilNext(Date.now()));
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // 高亮定时清除。
  useEffect(() => {
    if (!tipHighlight) return;
    const id = window.setTimeout(() => setTipHighlight(false), TIP_HIGHLIGHT_MS);
    return () => window.clearTimeout(id);
  }, [tipHighlight]);

  const path = focusedProject?.rootPath ?? "";
  const entry = HEALTH_TIPS[tipIdx];

  // AI 会话计数:按语义态分组(running/retrying/waiting/error/bg/idle)。claude + codex 合并
  // (codex 的 kind 是 ClaudeSessionKind 子集)。只显活跃态;全 idle 时不显(避免噪声)。
  // 点击某态药丸 -> 跳该态第一个 tab。
  const allAiStatuses = [...claudeStatuses, ...(codexStatuses ?? [])];
  const aiCounts: Record<ClaudeSessionKind, number> = { error: 0, retrying: 0, waiting: 0, running: 0, bg: 0, idle: 0 };
  for (const e of allAiStatuses) aiCounts[e.summary.kind]++;
  // 活跃态药丸列表(显示顺序:error > retrying > waiting > running > bg;idle 不显)。每态:label/颜色/计数。
  const aiPills: { kind: ClaudeSessionKind; label: string; color: string }[] = [
    { kind: "error", label: t("statusbar.aiError", { n: aiCounts.error }), color: "#f87171" },
    { kind: "retrying", label: t("statusbar.aiRetrying", { n: aiCounts.retrying }), color: "#fb923c" },
    { kind: "waiting", label: t("statusbar.aiWaiting", { n: aiCounts.waiting }), color: "#a78bfa" },
    { kind: "running", label: t("statusbar.aiRunning", { n: aiCounts.running }), color: "#22d3ee" },
    { kind: "bg", label: t("statusbar.aiBg", { n: aiCounts.bg }), color: "#fbbf24" },
  ];
  const aiActive = aiCounts.running + aiCounts.retrying + aiCounts.waiting + aiCounts.error + aiCounts.bg;

  return (
    <>
    <footer className="flex h-[length:var(--mx-statusbar-h)] shrink-0 items-center justify-between gap-3 px-3 text-[length:var(--mx-ui-fs-sm)] text-[var(--mx-muted)] select-none">
      {/* 左:设置齿轮 + 聚焦项目绝对路径(截断 + title 全路径)+ git 分支。 */}
      <div className="flex min-w-0 items-center gap-2">
        <Tooltip>
        <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setSettingsOpen(true)}
          aria-label={t("statusbar.settings")}
        >
          {/* 齿轮 SVG(16px,stroke 跟随 currentColor)。 */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Button>
        </TooltipTrigger>
        <TooltipContent>{t("statusbar.settings")}</TooltipContent>
        </Tooltip>
        {/* 新版本可用 chip:启动自动检查发现更新时出现,点击直达设置→关于(更新器)。
            绿点呼吸引人注意;安装完成后 store 转 upToDate,chip 自动消失。 */}
        {updaterSnap.phase === "available" && (
          <button
            type="button"
            onClick={() => {
              setSettingsTab("about");
              setSettingsOpen(true);
            }}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--mx-radius-md)] px-1.5 py-0.5 text-[11px] text-[#86efac] transition-colors hover:bg-[var(--mx-hover-bg)]"
            title={t("statusbar.updateAvailable")}
          >
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#86efac]" />
            <span className="tabular-nums">{t("statusbar.updateAvailable")}</span>
            <span className="font-[600] tabular-nums">v{updaterSnap.update.version}</span>
          </button>
        )}
        {focusedProject ? (
          <>
            <Tooltip>
            <TooltipTrigger asChild>
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: focusedProject ? projectAccentColor(focusedProject.id) : "var(--mx-accent)" }}
            />
            </TooltipTrigger>
            <TooltipContent>{t("statusbar.focusedProject")}</TooltipContent>
            </Tooltip>
            <Tooltip>
            <TooltipTrigger asChild>
            <span className="truncate" dir="ltr">
              {path}
            </span>
            </TooltipTrigger>
            <TooltipContent>{path}</TooltipContent>
            </Tooltip>
            {gitBranch && (
              <Tooltip>
              <TooltipTrigger asChild>
              <span
                className="flex shrink-0 items-center gap-[3px] text-[var(--mx-muted)]"
              >
                <span aria-hidden>⎇</span>
                <span className="max-w-[160px] truncate">{gitBranch}</span>
              </span>
              </TooltipTrigger>
              <TooltipContent>{t("statusbar.gitBranch", { branch: gitBranch })}</TooltipContent>
              </Tooltip>
            )}
          </>
        ) : (
          <span className="text-[var(--mx-faint)]">—</span>
        )}
      </div>

      {/* 右:内存 已用/总量(GB) + 健康 tip。 */}
      {/* 中:AI 会话状态汇总(所有 claude tab)。有活跃态(running/retrying/waiting/error)才显;
          点击某态药丸跳该态第一个 claude tab。全 idle / 无 claude tab 不显。 */}
      {aiActive > 0 && (
        <div className="flex shrink-0 items-center gap-1.5">
          {aiActive > 0 && (
            <>
              <span className="text-[var(--mx-faint)]">{t("statusbar.aiSessions")}</span>
              {aiPills.filter((p) => aiCounts[p.kind] > 0).map((p) => {
                const first = allAiStatuses.find((e) => e.summary.kind === p.kind);
                return (
                  <Tooltip key={p.kind}>
                  <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={!onFocusClaudeTab || !first}
                    onClick={() => {
                      if (first && onFocusClaudeTab) onFocusClaudeTab(first.projectId, first.tabId);
                    }}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 tabular-nums transition-colors hover:bg-[var(--mx-border)] disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color }} />
                    <span className="text-[var(--mx-text)]">{p.label}</span>
                  </button>
                  </TooltipTrigger>
                  <TooltipContent>{t("statusbar.aiSessions")}</TooltipContent>
                  </Tooltip>
                );
              })}
            </>
          )}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-4">
        {mem !== null && mem.totalBytes > 0 && (
          <Tooltip>
          <TooltipTrigger asChild>
          <span
            className="tabular-nums"
          >
            MEM {Math.round(mem.usedBytes / 1e9)}/{Math.round(mem.totalBytes / 1e9)}G
          </span>
          </TooltipTrigger>
          <TooltipContent>{t("statusbar.memUsage", {
            percent: ((mem.usedBytes / mem.totalBytes) * 100).toFixed(1),
          })}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
        <TooltipTrigger asChild>
        <span
          className={[
            "transition-colors cursor-pointer select-none",
            tipHidden
              ? "text-[var(--mx-faint)] hover:text-[var(--mx-muted)]"
              : tipHighlight
                ? "text-[var(--mx-accent)]"
                : "text-[var(--mx-muted)] hover:text-[var(--mx-text)]",
          ].join(" ")}
          onClick={() => setTipHidden((h) => !h)}
        >
          {tipHidden ? t(entry.done) : t(entry.tip)}
        </span>
        </TooltipTrigger>
        <TooltipContent>{tipHidden ? t("statusbar.tipDone") : t("statusbar.tipActive")}</TooltipContent>
        </Tooltip>
      </div>
    </footer>
    <SettingsModal open={settingsOpen} initialTab={settingsTab} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
