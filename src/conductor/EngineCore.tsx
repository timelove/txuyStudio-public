/**
 * EngineCore —— Agent 实况中央引擎 v3「会话轨道」(canvas 2D + rAF,2026-11-23):
 * 用户二连评:反应炉版「一个圈去扫,看着不直观」——抽象隐喻全部退场,信息直给:
 * **一个会话一行,时间从右(now)往左流**:
 * - 左端:会话色点(运行中呼吸/静默空心)+会话名+项目小字;
 * - 轨道:工具拍=类别色脉冲块(读=青/写=金/执行=紫/派生=绿),高度=XP 权重,
 *   新拍入场闪一帧,45s 窗口内向左流动;
 * - 轨道顶:当前动作 chip(新拍的工具名,2.4s 淡出)——「在干嘛」直接读字;
 * - 轨道底:「密度山」——窗口内拍频的平滑包络面积图,节奏轮廓一眼可辨;
 * - 15s 竖网格线随真钟连续左移 + 右缘 now 线:即使无拍,时间参照系也在走,不死机;
 * - 行内新拍扫光(会话色 1.2s);静默会话(窗口无拍且未运行)整行降透明;
 * - 行序=最近活动降序,运行中无拍的会话保底入场,最多 7 行;
 * prefers-reduced-motion:不进 rAF,数据/尺寸变化才重绘静帧(位置全按真钟,不依赖相位)。
 *
 * 数据接缝:beats/active/runningKeys 经 dataRef 进渲染循环(不触发 React 重渲染),
 * 新拍检测按 seq——引擎是自走机器,React 只喂料。
 */
import { useEffect, useRef } from "react";
import type { ToolBeat } from "../domain/conductor";
import { sessionColor, toolCat, beatWeight } from "./stageColors";

type EngineProps = {
  beats: ToolBeat[];
  /** 引擎活跃(60s 内有拍或存在运行中会话)——网格/now 线亮度随之微调。 */
  active: boolean;
  runningKeys: string[];
};

/** 行内当前动作 chip(新拍触发,真钟计时淡出)。 */
type Flash = { tool: string; born: number };

type Sim = {
  t: number;
  lastSeq: number;
  flashes: Map<string, Flash>;
};

type RGB = [number, number, number];

/** CSS 颜色串(canvas 不认 var(--x))→ RGB 三元组。 */
function parseColor(raw: string, fallback: string): RGB {
  const s = raw.trim();
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m6) return [parseInt(m6[1], 16), parseInt(m6[2], 16), parseInt(m6[3], 16)];
  if (m3)
    return [
      parseInt(m3[1] + m3[1], 16),
      parseInt(m3[2] + m3[2], 16),
      parseInt(m3[3] + m3[3], 16),
    ];
  if (fn) {
    const p = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [p[0] || 0, p[1] || 0, p[2] || 0];
  }
  return parseColor(fallback, "#888888");
}

const rgba = (c: RGB, a: number) =>
  `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`;

function newSim(): Sim {
  return { t: 0, lastSeq: 0, flashes: new Map() };
}

/** 分类 → 脉冲色(write/other 落到主题变量解析结果)。 */
function catRgb(tool: string, accent: RGB, muted: RGB): RGB {
  switch (toolCat(tool)) {
    case "read":
      return [6, 182, 212];
    case "write":
      return accent;
    case "exec":
      return [139, 92, 246];
    case "spawn":
      return [16, 185, 129];
    default:
      return muted;
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** 可视时间窗口(ms)与网格步长。 */
const WINDOW = 45_000;
const GRID_STEP = 15_000;
const MAX_ROWS = 7;
const LABEL_W = 96;

/** 一行=一个会话的轨道。 */
type Row = {
  key: string;
  tabId: string;
  projectId: string;
  lastMs: number;
  running: boolean;
  beats: ToolBeat[];
};

function collectRows(bs: ToolBeat[], running: string[]): Row[] {
  const m = new Map<string, Row>();
  for (const b of bs) {
    const k = `${b.projectId}/${b.tabId}`;
    let r = m.get(k);
    if (!r) {
      r = {
        key: k,
        tabId: b.tabId,
        projectId: b.projectId,
        lastMs: b.ms,
        running: false,
        beats: [],
      };
      m.set(k, r);
    }
    r.beats.push(b);
  }
  for (const k of running) {
    const r = m.get(k);
    if (r) {
      r.running = true;
    } else {
      const cut = k.lastIndexOf("/");
      m.set(k, {
        key: k,
        tabId: cut >= 0 ? k.slice(cut + 1) : k,
        projectId: cut >= 0 ? k.slice(0, cut) : "",
        lastMs: 0,
        running: true,
        beats: [],
      });
    }
  }
  const now = Date.now();
  return [...m.values()]
    .sort(
      (a, b) =>
        (b.lastMs || (b.running ? now - WINDOW : 0)) -
        (a.lastMs || (a.running ? now - WINDOW : 0)),
    )
    .slice(0, MAX_ROWS);
}

/** 会话名展示:projectId 取最后一段(路径也扛得住)。 */
function projectLabel(pid: string): string {
  const seg = pid.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return seg.length > 14 ? seg.slice(0, 13) + "…" : seg;
}

export function EngineCore({ beats, active, runningKeys }: EngineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef({ beats, active, runningKeys });
  dataRef.current = { beats, active, runningKeys };
  const simRef = useRef<Sim>(newSim());
  /** reduced 静帧模式的重绘脏标记。 */
  const dirtyRef = useRef(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 色板:主题 CSS 变量解析一次(换主题靠整窗重挂载,可接受)。
    const style = getComputedStyle(document.documentElement);
    const accent = parseColor(style.getPropertyValue("--mx-accent"), "#d9a03f");
    const border = parseColor(style.getPropertyValue("--mx-border"), "#888888");
    const text = parseColor(style.getPropertyValue("--mx-text"), "#333333");
    const muted = parseColor(style.getPropertyValue("--mx-muted"), "#999999");

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sim = simRef.current;

    let w = 0;
    let h = 0;
    const fit = () => {
      const r = box.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(() => {
      fit();
      if (reduced) draw(0, false);
    });
    ro.observe(box);

    /** 主绘制帧:t=呼吸相位秒(静帧传 0),motion=false 时只摆数据不呼吸。 */
    const draw = (t: number, motion: boolean) => {
      const { beats: bs, active: act, runningKeys: running } = dataRef.current;
      const now = Date.now();
      sim.t = t;

      ctx.clearRect(0, 0, w, h);

      // 新拍 → 行内当前动作 chip(born 用真钟,静帧模式也正确显示)。
      // lastSeq===0 = 首帧初始化:只对齐水位,不把冷启动历史拍全闪一遍。
      const latest = bs[0];
      if (sim.lastSeq === 0 && latest) sim.lastSeq = latest.seq;
      if (latest && latest.seq > sim.lastSeq) {
        for (const b of bs) {
          if (b.seq <= sim.lastSeq) break;
          sim.flashes.set(`${b.projectId}/${b.tabId}`, { tool: b.tool, born: now });
        }
        sim.lastSeq = latest.seq;
      }

      const rows = collectRows(bs, running);
      const padTop = 10;
      const padBottom = 10;
      const trackX = LABEL_W;
      const trackW = Math.max(40, w - trackX - 8);

      if (rows.length === 0) {
        ctx.font = `11px ${MONO}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = rgba(muted, 0.7);
        ctx.fillText("静默 · 等待工具调用", w / 2, h / 2 - 7);
        ctx.fillStyle = rgba(accent, motion ? 0.35 + 0.2 * Math.sin(t * 1.8) : 0.35);
        ctx.fillRect(trackX, h / 2 + 6, trackW, 1);
        ctx.textAlign = "left";
        return;
      }

      const rowH = clamp((h - padTop - padBottom) / rows.length, 32, 76);
      const gridTop = padTop;
      const gridBottom = Math.min(h - padBottom, padTop + rowH * rows.length);

      // 0) 时间网格:15s 一条,绝对刻度随真钟连续左移(时间参照系永走)。
      const firstTick = Math.ceil(now / GRID_STEP) * GRID_STEP;
      for (let tl = firstTick - GRID_STEP; now - tl < WINDOW; tl -= GRID_STEP) {
        const x = trackX + trackW * (1 - (now - tl) / WINDOW);
        if (x < trackX + 1) break;
        ctx.fillStyle = rgba(border, act ? 0.5 : 0.32);
        ctx.fillRect(x, gridTop, 1, gridBottom - gridTop);
      }

      // 1) now 线:右缘 accent,「现在」锚点。
      ctx.fillStyle = rgba(accent, act ? 0.55 : 0.35);
      ctx.fillRect(trackX + trackW, gridTop, 1, gridBottom - gridTop);

      rows.forEach((row, i) => {
        const top = padTop + rowH * i;
        const midY = top + rowH / 2;
        const baseY = top + rowH - 3;
        const hasBeatInWindow = row.beats.some((b) => now - b.ms < WINDOW);
        const silent = !row.running && !hasBeatInWindow;
        const sessRgb = parseColor(sessionColor(row.key), "#888888");

        // 行间分隔线(首行外)。
        if (i > 0) {
          ctx.fillStyle = rgba(border, 0.35);
          ctx.fillRect(trackX, top, trackW, 1);
        }

        if (silent) ctx.globalAlpha = 0.42;

        // 2) 左端标签:色点(运行呼吸/静默空心)+会话名+项目小字。
        const pulse = row.running && motion ? 0.55 + 0.45 * Math.sin(t * 3 + i) : 0.9;
        if (row.running || hasBeatInWindow) {
          ctx.fillStyle = rgba(sessRgb, pulse);
          ctx.fillRect(10, midY - 3.5, 7, 7);
        } else {
          ctx.strokeStyle = rgba(sessRgb, 0.7);
          ctx.lineWidth = 1;
          ctx.strokeRect(10.5, midY - 3, 6, 6);
        }
        ctx.font = `600 12px ${MONO}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = rgba(text, 0.9);
        ctx.fillText(row.tabId, 24, midY);
        const tabW = ctx.measureText(row.tabId).width;
        const proj = projectLabel(row.projectId);
        if (proj) {
          ctx.font = `9px ${MONO}`;
          ctx.fillStyle = rgba(muted, 0.85);
          ctx.fillText(proj, 24 + tabW + 8, midY + 0.5, Math.max(0, trackX - 34 - tabW));
        }

        // 3) 密度山:窗口内拍频的平滑包络(面积图)——节奏轮廓。
        const buckets = 48;
        const buf = new Float32Array(buckets);
        let any = false;
        for (const b of row.beats) {
          const pos = 1 - (now - b.ms) / WINDOW;
          if (pos < 0 || pos >= 1) continue;
          buf[Math.min(buckets - 1, Math.floor(pos * buckets))] += beatWeight(b.tool);
          any = true;
        }
        if (any) {
          const sm = new Float32Array(buckets);
          const kern = [0.15, 0.5, 1, 0.5, 0.15];
          for (let j = 0; j < buckets; j++) {
            let s = 0;
            let kw = 0;
            for (let d = -2; d <= 2; d++) {
              const jj = j + d;
              if (jj < 0 || jj >= buckets) continue;
              s += buf[jj] * kern[d + 2];
              kw += kern[d + 2];
            }
            sm[j] = s / kw;
          }
          let maxV = 0;
          for (let j = 0; j < buckets; j++) maxV = Math.max(maxV, sm[j]);
          if (maxV > 0) {
            const peak = Math.min(rowH * 0.5, 26);
            ctx.beginPath();
            ctx.moveTo(trackX, baseY);
            for (let j = 0; j < buckets; j++) {
              ctx.lineTo(
                trackX + ((j + 0.5) / buckets) * trackW,
                baseY - (sm[j] / maxV) * peak,
              );
            }
            ctx.lineTo(trackX + trackW, baseY);
            ctx.closePath();
            ctx.fillStyle = rgba(sessRgb, 0.1);
            ctx.fill();
            ctx.strokeStyle = rgba(sessRgb, 0.24);
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }

        // 4) 工具拍脉冲块:类别色,高度=权重,入场闪,向左流动。
        for (const b of row.beats) {
          const age = now - b.ms;
          const pos = 1 - age / WINDOW;
          if (pos < 0 || pos >= 1) continue;
          const x = trackX + pos * trackW;
          const rgb = catRgb(b.tool, accent, muted);
          const fresh = age < 450;
          const bw = fresh ? 4 : 3;
          const bh = Math.min(rowH * 0.5, 5 + beatWeight(b.tool) * 3) * (fresh ? 1.35 : 1);
          let a = fresh ? 0.95 : 0.55;
          if (pos < 0.06) a *= pos / 0.06; // 左缘流出渐隐
          ctx.fillStyle = rgba(rgb, a);
          ctx.fillRect(x - bw / 2, midY - bh / 2, bw, bh);
        }

        // 5) 行内新拍扫光:会话色从右淡入的横向洗光(1.2s)。
        const fl = sim.flashes.get(row.key);
        if (fl) {
          const fAge = (now - fl.born) / 1000;
          if (fAge > 2.4) {
            sim.flashes.delete(row.key);
          } else {
            if (fAge < 1.2) {
              const g = ctx.createLinearGradient(trackX, 0, trackX + trackW, 0);
              g.addColorStop(0, rgba(sessRgb, 0));
              g.addColorStop(1, rgba(sessRgb, 0.09 * (1 - fAge / 1.2)));
              ctx.fillStyle = g;
              ctx.fillRect(trackX, top + 1, trackW, rowH - 2);
            }
            // 6) 当前动作 chip:轨道顶右锚的工具名,2.4s 淡出。
            const chipA = fAge < 1.8 ? 1 : (2.4 - fAge) / 0.6;
            const label = fl.tool.length > 12 ? fl.tool.slice(0, 11) + "…" : fl.tool;
            ctx.font = `600 11px ${MONO}`;
            ctx.textAlign = "right";
            const rgb = catRgb(fl.tool, accent, muted);
            ctx.fillStyle = rgba(rgb, chipA);
            ctx.fillRect(trackX + trackW - 8, top + 8, 3, 3);
            ctx.fillText(label, trackX + trackW - 14, top + 9.5);
            ctx.textAlign = "left";
          }
        }

        ctx.globalAlpha = 1;
      });
    };

    if (reduced) {
      // 静帧模式:平时空转,数据变化(dirty flag)才真正重绘一帧。
      let raf = 0;
      const loop = () => {
        if (dirtyRef.current) {
          dirtyRef.current = false;
          draw(sim.t, false);
        }
        raf = requestAnimationFrame(loop);
      };
      draw(sim.t, false);
      raf = requestAnimationFrame(loop);
      return () => {
        ro.disconnect();
        cancelAnimationFrame(raf);
      };
    }

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      sim.t += dt;
      draw(sim.t, true);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // 数据变化(reduced 静帧模式)→ 置脏标记,循环下一帧重绘。
  useEffect(() => {
    dirtyRef.current = true;
  }, [beats]);

  return (
    <div ref={boxRef} className="relative h-full w-full">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
    </div>
  );
}
