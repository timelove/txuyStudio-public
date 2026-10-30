/**
 * AI 工作轨迹图谱 pane(graph;plan: .work/design/20261021-graph-pane)。
 *
 * Connected Papers 式力导向星系图,数据 = 后端 list_ai_activity(会话 × 文件 × 模型):
 * - 三层节点:模型(大,品牌色,常显标签)— 会话(中,app 色)— 文件(小,读冷写暖,
 *   亮度 = touch 次数);模型节点由 sessions 按模型分组在前端派生。
 * - 渲染:Canvas 2D 手写 verlet 力导向(库仑斥力 + 边弹簧 + 向心,不引图库,延续自绘
 *   传统),节点辉光(radial gradient)+ 边流光(weight 越大越快)+ 星尘视差底。
 * - 交互:hover 一跳邻居高亮其余淡出 + tooltip;click 聚焦(镜头缓动居中);拖拽节点/
 *   空白平移;滚轮以指针为锚缩放。数据/位置全 ref(不触发 React 重渲),仅 tooltip/
 *   loading/days 走 state。
 * - 实时:30s 轮询(页面可见时)+ 手动刷新;刷新 rebuild 按 key 保留旧位置(平滑续排,
 *   新节点从 0 半径生长进场)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchAiActivity, type AiActivityGraph } from "../domain/aiActivity";
import { Button } from "./ui/Button";
import { Tabs, TabsList, TabsTrigger } from "./ui/Tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";
import { TabCloseIcon } from "./icons";

// —— 节点/边模型 ——

type NodeKind = "model" | "session" | "file";

type GNode = {
  key: string;
  kind: NodeKind;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 目标半径(rCur 缓动进场生长)。 */
  r: number;
  rCur: number;
  color: string;
  // tooltip 明细(按 kind 填)。
  sub?: string;
  detail?: string;
};

type GEdge = {
  a: number;
  b: number;
  weight: number;
  ideal: number;
  color: string;
  /** 流光相位偏移(每边稳定 hash,避免所有光点同步)。 */
  phase: number;
};

const APP_COLOR: Record<string, string> = { claude: "#7c3aed", codex: "#22d3ee" };
const MODEL_PALETTE = ["#e879f9", "#fbbf24", "#4ade80", "#f87171", "#a78bfa", "#38bdf8"];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function fmtAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return String(n);
}

/**
 * 后端图 → 渲染节点/边。模型节点按 sessions 分组派生;文件节点读冷写暖;半径 log 压缩
 * (tokens/touch 跨度大)。旧位置按 key 保留(轮询刷新平滑续排)。
 */
function buildGraph(data: AiActivityGraph, old: Map<string, GNode>, w: number, h: number): { nodes: GNode[]; edges: GEdge[] } {
  const radius = Math.max(120, Math.min(w, h) / 2.6);
  const spawn = (key: string): { x: number; y: number } => {
    const prev = old.get(key);
    if (prev) return { x: prev.x, y: prev.y };
    const ang = Math.random() * Math.PI * 2;
    const rr = radius * (0.25 + 0.75 * Math.random());
    return { x: Math.cos(ang) * rr, y: Math.sin(ang) * rr };
  };
  const mk = (key: string, kind: NodeKind, label: string, r: number, color: string): GNode => {
    const p = spawn(key);
    return { key, kind, label, x: p.x, y: p.y, vx: 0, vy: 0, r, rCur: old.get(key) ? r : 0.5, color };
  };

  const nodes: GNode[] = [];
  const idx = new Map<string, number>();
  const nodeIndex = (key: string): number => {
    let i = idx.get(key);
    if (i == null) {
      i = nodes.length;
      idx.set(key, i);
    }
    return i;
  };

  // 模型节点:会话按模型分组;半径 ∝ sqrt(会话数);色按模型名稳定取色。
  const byModel = new Map<string, { count: number; tokens: number }>();
  for (const s of data.sessions) {
    const g = byModel.get(s.model) ?? { count: 0, tokens: 0 };
    g.count += 1;
    g.tokens += s.tokens;
    byModel.set(s.model, g);
  }
  const modelColor = new Map<string, string>();
  let pi = 0;
  for (const m of byModel.keys()) modelColor.set(m, MODEL_PALETTE[pi++ % MODEL_PALETTE.length]);
  for (const [model, g] of byModel) {
    const i = nodeIndex(`model:${model}`);
    nodes[i] = mk(`model:${model}`, "model", model, 15 + 5 * Math.sqrt(g.count), modelColor.get(model) ?? "#e879f9");
    nodes[i].sub = `${g.count} sessions`;
    nodes[i].detail = `${fmtTokens(g.tokens)} tokens · ${g.count} sessions`;
  }

  // 会话节点:app 色,半径 log(tokens)。
  for (const s of data.sessions) {
    const i = nodeIndex(`session:${s.id}`);
    nodes[i] = mk(`session:${s.id}`, "session", s.id.slice(0, 8), 5 + 4 * Math.log10(1 + s.tokens / 1000), APP_COLOR[s.app] ?? "#94a3b8");
    nodes[i].sub = s.model;
    nodes[i].detail = `${s.app} · ${s.model} · ${s.requests} req · ${fmtTokens(s.tokens)} tk · ${fmtAgo(s.lastTs)} ago`;
  }

  // 文件节点:读冷写暖,亮度由前端渲染按 touch 归一。
  const touchOf = new Map<string, number>();
  for (const f of data.files) touchOf.set(f.path, f.reads + f.writes);
  const maxTouch = Math.max(1, ...[...touchOf.values()]);
  for (const f of data.files) {
    const i = nodeIndex(`file:${f.path}`);
    const n = mk(`file:${f.path}`, "file", basename(f.path).slice(0, 20), 3.5 + 5 * Math.log10(1 + (f.reads + f.writes)), f.writes > 0 ? "#f59e0b" : "#94a3b8");
    n.sub = f.path;
    n.detail = `R${f.reads} · W${f.writes} · ${f.sessions} sessions · ${((touchOf.get(f.path) ?? 0) / maxTouch).toFixed(2)} heat`;
    nodes[i] = n;
  }

  // 边:模型→会话(模型色,长弹簧)+ 会话→文件(灰,weight=touch)。
  const edges: GEdge[] = [];
  for (const s of data.sessions) {
    edges.push({
      a: nodeIndex(`model:${s.model}`),
      b: nodeIndex(`session:${s.id}`),
      weight: 1,
      ideal: 150,
      color: modelColor.get(s.model) ?? "#e879f9",
      phase: (hashStr(`m${s.id}`) % 100) / 100,
    });
  }
  for (const e of data.edges) {
    const s = data.sessions[e.session];
    const f = data.files[e.file];
    if (!s || !f) continue;
    edges.push({
      a: nodeIndex(`session:${s.id}`),
      b: nodeIndex(`file:${f.path}`),
      weight: e.reads + e.writes,
      ideal: 80,
      color: "#8b93a7",
      phase: (hashStr(`${s.id}${f.path}`) % 100) / 100,
    });
  }
  // nodeIndex 惰性插入保证 nodes 数组无洞(所有边端点先于使用注册;洞节点留 undefined 不可能——
  // 边端点都来自上面三组已建节点)。
  for (let i = 0; i < nodes.length; i++) if (!nodes[i]) nodes[i] = mk(`ghost:${i}`, "file", "", 2, "#64748b");
  return { nodes, edges };
}

/** 一跳邻居(含自身),hover/focus 高亮集。 */
function neighborSet(nodes: GNode[], edges: GEdge[], i: number | null): Set<number> | null {
  if (i == null) return null;
  const set = new Set<number>([i]);
  for (const e of edges) {
    if (e.a === i) set.add(e.b);
    else if (e.b === i) set.add(e.a);
  }
  return set;
}

type TooltipState = { sx: number; sy: number; node: GNode } | null;

export function GraphPane({
  paneId,
  sessions,
  activeTabId,
  focused,
  onFocusPane,
  onCloseTab,
  onSetActiveTab,
  onClosePane,
}: {
  paneId: string;
  sessions: { id: string; name: string }[];
  activeTabId: string;
  focused?: boolean;
  onFocusPane?: (id: string) => void;
  onCloseTab?: (paneId: string, tabId: string) => void;
  onSetActiveTab?: (paneId: string, tabId: string) => void;
  onClosePane?: (paneId: string) => void;
}) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<GNode[]>([]);
  const edgesRef = useRef<GEdge[]>([]);
  const viewRef = useRef({ x: 0, y: 0, tx: 0, ty: 0, scale: 1 });
  const hoverRef = useRef<number | null>(null);
  const focusRef = useRef<number | null>(null);
  const dragRef = useRef<{ node: number; moved: boolean } | { panFrom: { x: number; y: number }; from: { x: number; y: number }; moved: boolean } | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  // 星尘底(世界坐标随机点,渲染时视差 0.25;模块级随机一次,重挂不变)。
  const dustRef = useRef(
    Array.from({ length: 130 }, () => ({
      x: (Math.random() - 0.5) * 3600,
      y: (Math.random() - 0.5) * 2400,
      r: 0.4 + Math.random() * 1.1,
      a: 0.15 + Math.random() * 0.5,
    })),
  );
  const [days, setDays] = useState<number>(7);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [hasData, setHasData] = useState(true);
  const [tooltip, setTooltip] = useState<TooltipState>(null);

  // —— 数据加载(手动 + 挂载 + 30s 轮询;可见性感知) ——
  const load = useCallback(async () => {
    setLoading(true);
    const g = await fetchAiActivity(days === 0 ? 4000 : days);
    const { w, h } = sizeRef.current;
    const old = new Map(nodesRef.current.map((n) => [n.key, n]));
    const { nodes, edges } = buildGraph(g, old, w, h);
    nodesRef.current = nodes;
    edgesRef.current = edges;
    hoverRef.current = null;
    focusRef.current = null;
    setTooltip(null);
    setHasData(nodes.length > 0);
    setLoading(false);
    setLoadedAt(Date.now());
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30000);
    return () => clearInterval(id);
  }, [load]);

  // —— 尺寸 + rAF 主循环(力模拟 + 渲染) ——
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let raf = 0;
    const step = (t: number) => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const { w, h, dpr } = sizeRef.current;
      const view = viewRef.current;

      // —— 力导向 verlet:n~130,O(n²) 每帧 ~8k 对,便宜 ——
      if (nodes.length) {
        const drag = dragRef.current;
        const dragged = drag && "node" in drag ? drag.node : -1;
        // 库仑斥力。
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1) {
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
              d2 = 1;
            }
            const d = Math.sqrt(d2);
            const f = Math.min(60, (a.r + b.r) * 90 / d2);
            const fx = (dx / d) * f;
            const fy = (dy / d) * f;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }
        // 边弹簧。
        for (const e of edges) {
          const a = nodes[e.a];
          const b = nodes[e.b];
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.max(1, Math.hypot(dx, dy));
          const f = (d - e.ideal) * 0.006;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
        // 向心(防漂散)+ 积分(阻尼 + 限速;模型节点重,移动慢一半)。
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (i === dragged) {
            n.vx = 0;
            n.vy = 0;
            continue;
          }
          n.vx -= n.x * 0.0006;
          n.vy -= n.y * 0.0006;
          n.vx *= 0.86;
          n.vy *= 0.86;
          const damp = n.kind === "model" ? 0.5 : 1;
          const sp = Math.hypot(n.vx, n.vy);
          if (sp > 5) {
            n.vx = (n.vx / sp) * 5 * damp;
            n.vy = (n.vy / sp) * 5 * damp;
          }
          n.x += n.vx;
          n.y += n.vy;
          // 进场生长。
          n.rCur += (n.r - n.rCur) * 0.08;
        }
        // 镜头缓动(聚焦时把目标节点带回中心)。
        view.x += (view.tx - view.x) * 0.08;
        view.y += (view.ty - view.y) * 0.08;
      }

      // —— 渲染 ——
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0b0e1a";
      ctx.fillRect(0, 0, w, h);

      const hi = neighborSet(nodes, edges, focusRef.current ?? hoverRef.current);
      const maxTouch = Math.max(
        1,
        ...edges.map((e) => e.weight),
      );

      const world = (sx: number, sy: number): { x: number; y: number } => ({
        x: (sx - w / 2 - view.x) / view.scale,
        y: (sy - h / 2 - view.y) / view.scale,
      });

      // 星尘(视差 0.25:星层移动慢于前景,纵深感)。
      ctx.save();
      for (const d of dustRef.current) {
        const sx = w / 2 + view.x * 0.25 + d.x * view.scale * 0.25;
        const sy = h / 2 + view.y * 0.25 + d.y * view.scale * 0.25;
        if (sx < -4 || sx > w + 4 || sy < -4 || sy > h + 4) continue;
        ctx.globalAlpha = d.a;
        ctx.fillStyle = "#9db4d8";
        ctx.beginPath();
        ctx.arc(sx, sy, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      ctx.translate(w / 2 + view.x, h / 2 + view.y);
      ctx.scale(view.scale, view.scale);

      // 边 + 流光。
      const sec = t / 1000;
      for (const e of edges) {
        const a = nodes[e.a];
        const b = nodes[e.b];
        if (!a || !b) continue;
        const dim = hi ? (hi.has(e.a) && hi.has(e.b) ? 1 : 0.06) : 0.8;
        ctx.globalAlpha = (0.14 + 0.3 * Math.min(1, e.weight / maxTouch)) * (hi ? dim * 1.2 : 1);
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 0.6 + 2 * Math.min(1, e.weight / maxTouch);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // 流光:weight 归一速度,相位每边稳定;仅亮边(hi 模式下只邻居边)。
        if (dim > 0.5) {
          const speed = 0.08 + 0.25 * Math.min(1, e.weight / maxTouch);
          const ph = (sec * speed + e.phase) % 1;
          const px = a.x + (b.x - a.x) * ph;
          const py = a.y + (b.y - a.y) * ph;
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = e.color;
          ctx.beginPath();
          ctx.arc(px, py, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // 节点:辉光 + 核心;hover/focus 邻接高亮,其余淡出。
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const dim = hi ? (hi.has(i) ? 1 : 0.1) : 1;
        const glow = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.rCur * 3.2);
        glow.addColorStop(0, n.color + "cc");
        glow.addColorStop(0.35, n.color + "55");
        glow.addColorStop(1, n.color + "00");
        ctx.globalAlpha = 0.55 * dim;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.rCur * 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = dim;
        ctx.fillStyle = n.color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.rCur, 0, Math.PI * 2);
        ctx.fill();
        if (i === (hoverRef.current ?? -1) || i === (focusRef.current ?? -1)) {
          ctx.strokeStyle = "#ffffffaa";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.rCur + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
        // 标签:模型常显;会话/文件 hover/focus 邻接显。字号随 scale 反缩(视觉常量)。
        const showLabel = n.kind === "model" || (hi != null && hi.has(i));
        if (showLabel && n.rCur > 1) {
          ctx.globalAlpha = dim;
          ctx.fillStyle = "#dbe4f5";
          ctx.font = `${n.kind === "model" ? 12 : 10}px ui-sans-serif, system-ui`;
          ctx.textAlign = "center";
          ctx.fillText(n.label, n.x, n.y + n.rCur + 12 / view.scale);
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    // wheel 原生注册(React onWheel 是 passive,preventDefault 需非 passive)。
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const view = viewRef.current;
      const rect = canvas.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      const wx = (sx - rect.width / 2 - view.x) / view.scale;
      const wy = (sy - rect.height / 2 - view.y) / view.scale;
      view.scale = Math.min(3, Math.max(0.25, view.scale * (ev.deltaY < 0 ? 1.12 : 0.89)));
      view.x = sx - rect.width / 2 - wx * view.scale;
      view.y = sy - rect.height / 2 - wy * view.scale;
      view.tx = view.x;
      view.ty = view.y;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  // —— 指针交互 ——
  const pick = (sx: number, sy: number): number | null => {
    const nodes = nodesRef.current;
    const { w, h } = sizeRef.current;
    const view = viewRef.current;
    const wx = (sx - w / 2 - view.x) / view.scale;
    const wy = (sy - h / 2 - view.y) / view.scale;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const d = Math.hypot(n.x - wx, n.y - wy);
      const hit = n.rCur + 6 / view.scale;
      if (d < hit && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? best : null;
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    onFocusPane?.(paneId);
    const rect = ev.currentTarget.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const hit = pick(sx, sy);
    ev.currentTarget.setPointerCapture(ev.pointerId);
    if (hit != null) {
      dragRef.current = { node: hit, moved: false };
    } else {
      const view = viewRef.current;
      dragRef.current = { panFrom: { x: view.x, y: view.y }, from: { x: sx, y: sy }, moved: false };
    }
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const drag = dragRef.current;
    if (drag) {
      drag.moved = true;
      if ("node" in drag) {
        const view = viewRef.current;
        const n = nodesRef.current[drag.node];
        if (n) {
          n.x = (sx - rect.width / 2 - view.x) / view.scale;
          n.y = (sy - rect.height / 2 - view.y) / view.scale;
        }
      } else {
        const view = viewRef.current;
        view.x = drag.panFrom.x + (sx - drag.from.x);
        view.y = drag.panFrom.y + (sy - drag.from.y);
        view.tx = view.x;
        view.ty = view.y;
      }
      return;
    }
    const hit = pick(sx, sy);
    if (hit !== hoverRef.current) {
      hoverRef.current = hit;
      const n = hit != null ? nodesRef.current[hit] : null;
      setTooltip(n ? { sx, sy, node: n } : null);
    } else if (hit != null) {
      setTooltip((tp) => (tp ? { ...tp, sx, sy } : tp));
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && !drag.moved) {
      // click:命中节点 → 聚焦(镜头缓动到中心);空白 → 清除聚焦。
      const hit = hoverRef.current;
      if (hit != null) {
        focusRef.current = focusRef.current === hit ? null : hit;
        const view = viewRef.current;
        const n = nodesRef.current[hit];
        if (n && focusRef.current != null) {
          view.tx = -n.x * view.scale;
          view.ty = -n.y * view.scale;
        } else {
          view.tx = view.x;
          view.ty = view.y;
        }
      } else {
        focusRef.current = null;
      }
    }
  };

  // —— 工具条 + 画布 ——
  const dayCls = (on: boolean) =>
    `rounded-full px-2 py-[3px] text-[10px] transition-colors ${
      on ? "bg-[var(--mx-accent-soft)] text-[var(--mx-accent-bright)]" : "text-(color:--mx-muted) hover:bg-[var(--mx-hover-bg)] hover:text-(color:--mx-text)"
    }`;

  return (
    <div
      className="grid h-full min-h-0 min-w-0 grid-rows-[length:var(--mx-paneheader-h)_1fr] overflow-hidden bg-[var(--mx-editor-bg)]"
      onMouseDown={() => onFocusPane?.(paneId)}
    >
      {/* 顶部 header:tab 条 + × 关 pane(与 TerminalPane/SessionBrowserPane 同构)。
          图谱 v1 漏了 tab 条 → 存量 graph tab 无法关闭;补齐标准结构。 */}
      <header
        className={`flex min-w-0 shrink-0 items-center justify-between gap-2 px-2 text-xs transition-colors ${"bg-[var(--mx-tabbar-bg)]"}`}
      >
        <Tabs value={activeTabId} onValueChange={(id) => onSetActiveTab?.(paneId, id)}>
          <TabsList className="mx-tabs-list flex min-w-0 items-center gap-0 overflow-x-auto [&::-webkit-scrollbar]:hidden">
            {sessions.map((s) => {
              const isActive = s.id === activeTabId;
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TabsTrigger asChild value={s.id}>
                      <div
                        key={s.id}
                        className={`mx-tab-item group/tab flex h-[length:var(--mx-tab-h)] min-w-0 shrink cursor-pointer items-center gap-1 px-2 transition-colors ${
                          isActive
                            ? "text-[var(--mx-text-bright)]"
                            : "text-[var(--mx-text-dim)] hover:text-[var(--mx-text)]"
                        }`}
                      >
                        <span className="min-w-0 max-w-[180px] truncate text-[length:var(--mx-ui-fs-sm)] font-[600]">{t(s.name)}</span>
                        {sessions.length > 1 && onCloseTab && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="h-3.5 w-3.5 text-[10px] text-[var(--mx-text-dim)] opacity-0 transition-opacity hover:text-[var(--mx-danger-bright)] group-hover/tab:opacity-100 hover:bg-transparent"
                                onMouseDown={(e) => {
                                  e.stopPropagation();
                                  onCloseTab(paneId, s.id);
                                }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <TabCloseIcon className="h-2 w-2" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t("shell.tab.close")}</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TabsTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t(s.name)}</TooltipContent>
                </Tooltip>
              );
            })}
          </TabsList>
        </Tabs>
        <div className="flex shrink-0 items-center gap-1 text-[var(--mx-muted)]">
          {onClosePane && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={`text-[13px] hover:bg-[var(--mx-border)] hover:text-[var(--mx-danger-bright)] ${focused ? "text-[var(--mx-text)]" : "text-[var(--mx-muted)]"}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => onClosePane(paneId)}
                  aria-label={t("shell.pane.close")}
                >
                  <TabCloseIcon className="h-2.5 w-2.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("shell.pane.close")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>
      <div
        ref={wrapRef}
        className="relative min-h-0 min-w-0 overflow-hidden bg-[#0b0e1a]"
      >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          hoverRef.current = null;
          setTooltip(null);
        }}
      />
      {/* 工具条(浮层,不占画布):天数段选 + 刷新 + 数据时间。 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 p-2">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-[#ffffff1a] bg-[#0b0e1acc] px-1.5 py-0.5 backdrop-blur-sm">
          {([7, 30, 0] as const).map((d) => (
            <button key={d} type="button" className={dayCls(days === d)} onClick={() => setDays(d)}>
              {d === 0 ? "ALL" : `${d}d`}
            </button>
          ))}
          <button
            type="button"
            className={`${dayCls(false)} ${loading ? "animate-pulse" : ""} ml-0.5`}
            aria-label={t("common.refresh")}
            onClick={() => void load()}
          >
            ↻
          </button>
        </div>
        {loadedAt != null && (
          <span className="rounded-full bg-[#0b0e1acc] px-2 py-0.5 text-[9px] text-[#7e8ba8] backdrop-blur-sm">
            {hasData ? `${nodesRef.current.length} nodes · ${new Date(loadedAt).toLocaleTimeString()}` : t("settings.usage.empty")}
          </span>
        )}
      </div>
      {/* 使用说明(右下角轻提示;有数据时不显——图本身就是内容)。 */}
      {!hasData && !loading && (
        <div className="absolute inset-0 grid place-items-center text-[11px] text-[#5b6784]">
          {t("graph.empty")}
        </div>
      )}
      {/* tooltip:hover 节点明细。 */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 max-w-[320px] rounded-[var(--mx-radius-md)] border border-[#ffffff22] bg-[#0b0e1ae6] px-2.5 py-1.5 text-[10px] shadow-lg backdrop-blur-sm"
          style={{ left: Math.min(tooltip.sx + 12, sizeRef.current.w - 240), top: tooltip.sy + 12 }}
        >
          <div className="font-mono text-[#dbe4f5]">
            {tooltip.node.kind === "file" ? tooltip.node.sub ?? tooltip.node.label : tooltip.node.label}
          </div>
          {tooltip.node.detail && <div className="mt-0.5 text-[#8fa0bf]">{tooltip.node.detail}</div>}
        </div>
      )}
      </div>
    </div>
  );
}
