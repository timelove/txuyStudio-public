import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ProjectSnapshot } from "../domain/projects";
import { SettingsModal } from "./SettingsModal";
import { Button } from "./ui/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";

type StatusBarProps = {
  /** 聚焦项目(选中 shell 所属项目);无聚焦项目时为 null。 */
  focusedProject: ProjectSnapshot | null;
  /** 聚焦项目的 git 分支(由 AppShell 按 rootPath 去重拉取)。null=非 git;undefined=未查。 */
  gitBranch?: string | null;
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
export function StatusBar({ focusedProject, gitBranch }: StatusBarProps) {
  const { t } = useTranslation();
  const [mem, setMem] = useState<{ usedBytes: number; totalBytes: number } | null>(null);
  const [tipIdx, setTipIdx] = useState(0);
  const [tipHighlight, setTipHighlight] = useState(false);
  /** 当前 tip 已被用户点击「完成」→ 隐藏;下一轮轮换时自动恢复显示新 tip。 */
  const [tipHidden, setTipHidden] = useState(false);
  /** 设置面板开关(齿轮点击触发)。 */
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  return (
    <>
    <footer className="flex h-[26px] shrink-0 items-center justify-between gap-3 px-3 text-[11px] text-[var(--mx-muted)] select-none">
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
        {focusedProject ? (
          <>
            <Tooltip>
            <TooltipTrigger asChild>
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: "var(--mx-accent)" }}
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
    <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
