import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { startPerfSampler, type PerfSample } from "../domain/perfMetrics";
import { Button } from "./ui/Button";

/** 后端 get_perf_stats 返回(camelCase 对齐 system::PerfStats)。 */
type PerfStats = {
  rustMemoryBytes: number;
  childProcesses: number;
  ptySessions: number;
  claudeSessions: number;
  codexSessions: number;
  shellSessions: number;
  fsWatchers: number;
};

/** 历史长度(点):前端 60 点 = 60s,后端 60 点 = 120s。 */
const HISTORY = 60;

/**
 * 设置 → 性能:应用内性能检测面板。
 *
 * 前端指标(挂载即采样,卸载即停——监控本身零常驻开销) + 后端快照(2s 轮询)。
 * 每指标带 sparkline 趋势;「复制诊断报告」把当前快照拼成文本进剪贴板,报障时直接贴。
 */
export function PerfPanel() {
  const { t } = useTranslation();
  const [sample, setSample] = useState<PerfSample | null>(null);
  const [stats, setStats] = useState<PerfStats | null>(null);
  const [copied, setCopied] = useState(false);

  // 前端采样(1s):setState 顺带记录 sparkline 历史(render 期不动 ref,StrictMode 安全)。
  const histRef = useRef<Record<string, number[]>>({});
  const push = (key: string, v: number) => {
    const arr = (histRef.current[key] ??= []);
    arr.push(v);
    if (arr.length > HISTORY) arr.shift();
  };
  useEffect(
    () =>
      startPerfSampler((s) => {
        setSample(s);
        push("fps", s.fps);
        push("longTasks", s.longTasks);
        push("domNodes", s.domNodes);
        push("loopLag", s.loopLagMs);
        if (s.jsHeapMb != null) push("jsHeap", s.jsHeapMb);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // 后端快照(2s 轮询;非 Tauri 环境静默)。
  useEffect(() => {
    let alive = true;
    const fetchStats = () => {
      invoke<PerfStats>("get_perf_stats")
        .then((s) => {
          if (!alive) return;
          setStats(s);
          push("rustMem", s.rustMemoryBytes / 1048576);
          push("children", s.childProcesses);
        })
        .catch(() => {});
    };
    fetchStats();
    const id = window.setInterval(fetchStats, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyReport = () => {
    const s = sample;
    const b = stats;
    const lines = [
      `txuyStudio performance report @ ${new Date().toISOString()}`,
      `version: ${__APP_VERSION__}`,
      s ? `fps: ${s.fps}` : "",
      s ? `longTasks(>50ms)/s: ${s.longTasks}, longest: ${s.longestTaskMs}ms` : "",
      s ? `eventLoopLag(max): ${s.loopLagMs}ms` : "",
      s ? `domNodes: ${s.domNodes}` : "",
      s && s.jsHeapMb != null ? `jsHeap: ${s.jsHeapMb.toFixed(1)}MB / ${s.heapLimitMb?.toFixed(0)}MB` : "",
      b ? `rustMemory: ${(b.rustMemoryBytes / 1048576).toFixed(1)}MB` : "",
      b ? `childProcesses: ${b.childProcesses}` : "",
      b ? `sessions: pty=${b.ptySessions} claude=${b.claudeSessions} codex=${b.codexSessions} shell=${b.shellSessions} watchers=${b.fsWatchers}` : "",
    ].filter(Boolean);
    navigator.clipboard.writeText(lines.join("\n")).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };

  const sessions = useMemo(() => {
    if (!stats) return null;
    return `pty ${stats.ptySessions} · claude ${stats.claudeSessions} · codex ${stats.codexSessions} · ! ${stats.shellSessions} · watch ${stats.fsWatchers}`;
  }, [stats]);

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-[var(--mx-muted)]">{t("settings.performance.hint")}</p>
      <div className="grid grid-cols-2 gap-2">
        <MetricCard
          label={t("settings.performance.fps")}
          value={sample ? String(sample.fps) : "—"}
          tone={sample ? (sample.fps >= 50 ? "ok" : sample.fps >= 30 ? "warn" : "bad") : undefined}
          series={histRef.current["fps"] ?? []}
        />
        <MetricCard
          label={t("settings.performance.longTasks")}
          value={sample ? `${sample.longTasks}/s${sample.longestTaskMs > 0 ? ` · ${sample.longestTaskMs}ms` : ""}` : "—"}
          tone={sample ? (sample.longTasks === 0 ? "ok" : sample.longTasks <= 2 ? "warn" : "bad") : undefined}
          series={histRef.current["longTasks"] ?? []}
        />
        <MetricCard
          label={t("settings.performance.loopLag")}
          value={sample ? `${sample.loopLagMs}ms` : "—"}
          tone={sample ? (sample.loopLagMs < 50 ? "ok" : sample.loopLagMs < 200 ? "warn" : "bad") : undefined}
          series={histRef.current["loopLag"] ?? []}
        />
        <MetricCard
          label={t("settings.performance.domNodes")}
          value={sample ? sample.domNodes.toLocaleString() : "—"}
          series={histRef.current["domNodes"] ?? []}
        />
        <MetricCard
          label={t("settings.performance.jsHeap")}
          value={sample?.jsHeapMb != null ? `${sample.jsHeapMb.toFixed(0)} MB` : "—"}
          sub={sample?.heapLimitMb != null ? `/ ${sample.heapLimitMb.toFixed(0)} MB` : undefined}
          series={histRef.current["jsHeap"] ?? []}
        />
        <MetricCard
          label={t("settings.performance.rustMemory")}
          value={stats ? `${(stats.rustMemoryBytes / 1048576).toFixed(0)} MB` : "—"}
          series={histRef.current["rustMem"] ?? []}
        />
        <MetricCard
          label={t("settings.performance.childProcesses")}
          value={stats ? String(stats.childProcesses) : "—"}
          tone={
            stats
              ? stats.childProcesses <= stats.ptySessions + stats.claudeSessions + stats.codexSessions + stats.shellSessions + 2
                ? "ok"
                : "warn"
              : undefined
          }
          series={histRef.current["children"] ?? []}
        />
        <MetricCard label={t("settings.performance.sessions")} value={sessions ?? "—"} />
      </div>
      <div className="flex justify-end">
        <Button variant="default" size="sm" onClick={copyReport}>
          {copied ? t("settings.performance.copied") : t("settings.performance.copyReport")}
        </Button>
      </div>
    </div>
  );
}

/** 单指标卡:当前值 + 60 点 sparkline 趋势。tone 只着色当前值文字。
 * value 可收缩截断(长组合串如会话数不全显,hover title 看全文)——固定 shrink-0 会
 * 撑破 grid 列,顶出设置面板横向滚动。 */
function MetricCard({
  label,
  value,
  sub,
  series,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  series?: number[];
  tone?: "ok" | "warn" | "bad";
}) {
  return (
    <div className="rounded border border-[var(--mx-border-soft)] bg-[var(--mx-surface)] px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-[10px] text-[var(--mx-faint)]">{label}</span>
        <span
          title={value}
          className={`min-w-0 truncate tabular-nums text-[var(--mx-text)] ${
            tone === "bad"
              ? "!text-[var(--mx-danger-bright)]"
              : tone === "warn"
                ? "!text-[var(--mx-warning)]"
                : tone === "ok"
                  ? "!text-[var(--mx-success)]"
                  : ""
          }`}
        >
          {value}
          {sub && <span className="ml-1 text-[var(--mx-faint)]">{sub}</span>}
        </span>
      </div>
      {series && series.length > 1 && <Sparkline series={series} />}
    </div>
  );
}

/** 迷你趋势线(自绘 SVG,无依赖):100×22,归一化到值域,首尾可读。 */
function Sparkline({ series }: { series: number[] }) {
  const w = 100;
  const h = 22;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const points = series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * w;
      const y = h - 2 - ((v - min) / span) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-1" aria-hidden>
      <polyline points={points} fill="none" stroke="var(--mx-accent)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
