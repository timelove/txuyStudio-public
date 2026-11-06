// 用量统计 domain(设置 → 用量 tab)。后端聚合口径见 system/commands.rs「用量统计」注释
// (claude 按 message.id 去重、codex 取 last_token_usage 增量,按 (本地日期, app, model) 分桶)。
//
// 定价三级来源(参考 cc-switch 的定价体系,对齐 models.dev 公共数据):
// 1. 手动覆盖(localStorage `mx.modelPricingOverrides`,用户在模型表里编辑的优先)
// 2. models.dev 公共定价(https://models.dev/api.json,打开用量页拉一次,localStorage 缓存 1h)
// 3. 内置静态表(离线兜底,摘自各厂公开定价)
// 匹配前先归一 model id(`glm-5.3[1M]`→`glm-5.3`、`glm-5-3-flash`→`glm-5.3-flash`、去 effort 尾)。

import { invoke } from "@tauri-apps/api/core";

/** 后端 UsageRollup(serde camelCase 镜像)。 */
export type UsageRollup = {
  date: string;
  app: "claude" | "codex" | string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 桶内出现过数据的会话文件数(distinct)。 */
  sessions: number;
};

/** 后端 UsageSummary 镜像:rollups + 跨桶 distinct 会话数。 */
export type UsageSummary = {
  rollups: UsageRollup[];
  claudeSessions: number;
  codexSessions: number;
};

/** 拉取近 N 天用量(重 IO,后端 spawn_blocking;失败返回空汇总)。 */
export async function fetchUsageSummary(days: number): Promise<UsageSummary> {
  try {
    return await invoke<UsageSummary>("list_usage_rollups", { days });
  } catch (err) {
    console.warn("[usage] list_usage_rollups failed:", err);
    return { rollups: [], claudeSessions: 0, codexSessions: 0 };
  }
}

/** 请求日志单条(后端 RequestLogEntry 镜像)。 */
export type RequestLogEntry = {
  ts: string;
  app: string;
  model: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/** 拉取近 N 天逐请求明细(倒序,后端 3000 条上限;失败返回 [])。 */
export async function fetchRequestLog(days: number): Promise<RequestLogEntry[]> {
  try {
    return await invoke<RequestLogEntry[]>("list_request_log", { days });
  } catch (err) {
    console.warn("[usage] list_request_log failed:", err);
    return [];
  }
}

// —— 定价体系 ————————————————————————————————————————————

/** 四段单价(USD / 1M tokens)。 */
export type ModelPricing = { in: number; out: number; cacheRead: number; cacheWrite: number };

/** 内置静态表(离线兜底;USD / 1M tokens)。 */
const BUILTIN_PRICING: Array<{ match: string } & ModelPricing> = [
  { match: "glm-5.3-flash", in: 0.15, out: 0.5, cacheRead: 0.03, cacheWrite: 0 },
  { match: "glm-5.3-flashx", in: 0.37, out: 1.25, cacheRead: 0.075, cacheWrite: 0 },
  { match: "glm-5.3", in: 1.4, out: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  { match: "glm-5.2", in: 1.4, out: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  { match: "glm-5.1", in: 1.4, out: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  { match: "glm-5-turbo", in: 1.2, out: 4, cacheRead: 0.24, cacheWrite: 0 },
  { match: "glm-5", in: 1, out: 3.2, cacheRead: 0.2, cacheWrite: 0 },
  { match: "glm-4.7", in: 0.6, out: 2.2, cacheRead: 0.11, cacheWrite: 0 },
  { match: "glm-4.6", in: 0.6, out: 2.2, cacheRead: 0.11, cacheWrite: 0 },
  { match: "deepseek-v4-pro", in: 1.32, out: 3.96, cacheRead: 0.044, cacheWrite: 0 },
  { match: "deepseek-v4-flash", in: 0.3, out: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  { match: "deepseek-v3.2", in: 0.28, out: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  { match: "deepseek-v3", in: 0.28, out: 1.11, cacheRead: 0.028, cacheWrite: 0 },
  { match: "deepseek-chat", in: 0.44, out: 1.32, cacheRead: 0.014, cacheWrite: 0 },
  { match: "gpt-5.4-mini", in: 0.75, out: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  { match: "gpt-5.4", in: 2.5, out: 15, cacheRead: 0.25, cacheWrite: 0 },
  { match: "gpt-5.2", in: 1.75, out: 14, cacheRead: 0.175, cacheWrite: 0 },
  { match: "claude-opus-4", in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: "claude-sonnet-4", in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: "claude-haiku-4", in: 0.8, out: 4, cacheRead: 0.08, cacheWrite: 1 },
  { match: "minimax-m3", in: 0.35, out: 1.4, cacheRead: 0.035, cacheWrite: 0 },
];

/** 定价来源(模型表展示与编辑入口用)。 */
export type PricingSource = "override" | "modelsdev" | "builtin" | null;

/** model id 归一:小写、去 `[...]` 容量后缀、`-`→`.`(glm-5-3 与 glm-5.3 互通)、
 *  去 effort/变体尾(low/medium/high/xhigh/codex)。 */
export function normalizeModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, "")
    .replace(/-/g, ".")
    .replace(/\.(low|medium|high|xhigh|codex)$/g, "")
    .replace(/\.+$/, "")
    .trim();
}

// —— 手动覆盖(localStorage) ——

const OVERRIDES_KEY = "mx.modelPricingOverrides";

export function loadPricingOverrides(): Record<string, ModelPricing> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ModelPricing>;
    const out: Record<string, ModelPricing> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v === "object" && [v.in, v.out, v.cacheRead, v.cacheWrite].every((x) => typeof x === "number")) {
        out[normalizeModelId(k)] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function savePricingOverrides(map: Record<string, ModelPricing>): void {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(map));
  } catch {
    /* 静默 */
  }
}

// —— models.dev 公共定价(拉取 + 1h localStorage 缓存) ——

/** models.dev 条目里我们关心的形状(cost 单位 USD / 1M tokens)。 */
type ModelsDevModel = {
  id?: string;
  name?: string;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  canonical_model_id?: string;
};

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE_KEY = "mx.modelsDevPricing";
const MODELS_DEV_TTL_MS = 60 * 60 * 1000;

type ModelsDevCache = { fetchedAt: number; pricing: Record<string, ModelPricing> };

function readModelsDevCache(): ModelsDevCache | null {
  try {
    const raw = localStorage.getItem(MODELS_DEV_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelsDevCache;
    if (typeof parsed.fetchedAt !== "number" || typeof parsed.pricing !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 拉取 models.dev 全量定价 → 归一索引(id 归一 → 四段单价)。解析失败返回 null。
 *  数据形态:`{ <providerId>: { models: { <modelId>: { cost: {...} } } } }`;转售条目带
 *  canonical_model_id 指回原厂——直接用条目自身 cost(缺段当 0),不追链。 */
async function fetchModelsDevPricing(force: boolean): Promise<Record<string, ModelPricing> | null> {
  if (!force) {
    const cached = readModelsDevCache();
    if (cached && Date.now() - cached.fetchedAt < MODELS_DEV_TTL_MS) return cached.pricing;
  }
  try {
    const res = await fetch(MODELS_DEV_URL);
    if (!res.ok) return readModelsDevCache()?.pricing ?? null;
    const data = (await res.json()) as Record<string, { models?: Record<string, ModelsDevModel> }>;
    const pricing: Record<string, ModelPricing> = {};
    for (const provider of Object.values(data)) {
      for (const model of Object.values(provider.models ?? {})) {
        const id = model.canonical_model_id || model.id;
        if (!id || !model.cost) continue;
        const key = normalizeModelId(id.split("/").pop() ?? id);
        // 同名条目保留信息更全的一个(四段和更大者;reseller 常只给 input/output)。
        const cur = pricing[key];
        const next = {
          in: model.cost.input ?? 0,
          out: model.cost.output ?? 0,
          cacheRead: model.cost.cache_read ?? 0,
          cacheWrite: model.cost.cache_write ?? 0,
        };
        if (!cur || next.in + next.out + next.cacheRead + next.cacheWrite > cur.in + cur.out + cur.cacheRead + cur.cacheWrite) {
          pricing[key] = next;
        }
      }
    }
    try {
      localStorage.setItem(MODELS_DEV_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), pricing }));
    } catch {
      /* 静默 */
    }
    return pricing;
  } catch {
    // 网络失败(CORS/断网):回落缓存(可能过期)或 null。
    return readModelsDevCache()?.pricing ?? null;
  }
}

/** 三级查找:override > models.dev > builtin。返回单价 + 来源标记。 */
export function lookupPricing(
  model: string,
  overrides: Record<string, ModelPricing>,
  modelsDev: Record<string, ModelPricing> | null,
): { pricing: ModelPricing; source: PricingSource } | null {
  const id = normalizeModelId(model);
  if (overrides[id]) return { pricing: overrides[id], source: "override" };
  if (modelsDev) {
    const exact = modelsDev[id];
    if (exact && exact.in + exact.out > 0) return { pricing: exact, source: "modelsdev" };
  }
  const builtin = BUILTIN_PRICING.map((p) => ({ ...p, m: normalizeModelId(p.match) }));
  const hit = builtin.find((p) => p.m === id) ?? builtin.find((p) => id.startsWith(p.m));
  if (hit) return { pricing: { in: hit.in, out: hit.out, cacheRead: hit.cacheRead, cacheWrite: hit.cacheWrite }, source: "builtin" };
  return null;
}

/** 四段 tokens → 估算费用(USD);无定价返回 null。 */
export function estimateCost(
  r: Pick<UsageRollup, "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens">,
  overrides: Record<string, ModelPricing>,
  modelsDev: Record<string, ModelPricing> | null,
): number | null {
  const hit = lookupPricing(r.model, overrides, modelsDev);
  if (!hit) return null;
  const p = hit.pricing;
  return (
    (r.inputTokens / 1e6) * p.in +
    (r.outputTokens / 1e6) * p.out +
    (r.cacheReadTokens / 1e6) * p.cacheRead +
    (r.cacheCreationTokens / 1e6) * p.cacheWrite
  );
}

/** 预取 models.dev 定价(用量面板挂载时调;用缓存不发请求)。 */
export async function preloadModelsDevPricing(): Promise<Record<string, ModelPricing> | null> {
  return fetchModelsDevPricing(false);
}

/** 强制刷新 models.dev 定价(面板「同步定价」按钮)。 */
export async function refreshModelsDevPricing(): Promise<Record<string, ModelPricing> | null> {
  return fetchModelsDevPricing(true);
}

// —— 格式化 ——

/** tokens 人读格式:1.2M / 354K / 812。 */
/**
 * 模型名 → 供应商品牌(用量「按供应商」页的分组维度;cc-switch 的 provider 字段来自代理日志,
 * 我们的数据源是会话 jsonl 聚合没有 provider 字段,按模型名前缀归并是等价近似)。
 * 返回 null = 未识别,UI 层显示「其他」。
 */
export function vendorOf(model: string): string | null {
  const m = normalizeModelId(model).toLowerCase();
  if (m.startsWith("glm") || m.startsWith("zhipu")) return "Z.ai (GLM)";
  if (m.startsWith("deepseek")) return "DeepSeek";
  if (/^(gpt|o1|o3|o4|chatgpt|codex)/.test(m)) return "OpenAI";
  if (m.startsWith("claude")) return "Anthropic";
  if (m.startsWith("minimax")) return "MiniMax";
  if (m.startsWith("qwen") || m.startsWith("qwq")) return "Alibaba (Qwen)";
  if (m.startsWith("gemini") || m.startsWith("gemma")) return "Google";
  if (m.startsWith("kimi") || m.startsWith("moonshot")) return "Moonshot";
  if (m.startsWith("doubao")) return "ByteDance";
  if (m.startsWith("grok")) return "xAI";
  if (m.startsWith("mistral") || m.startsWith("mixtral")) return "Mistral";
  if (m.startsWith("llama")) return "Meta";
  return null;
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return String(n);
}

/** USD 人读格式:$12.34 / $0.05 / —(null)。 */
export function formatUsd(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}
