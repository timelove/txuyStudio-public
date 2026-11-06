// 内置 codex 供应商配置(txuyStudio 自管理,与 claudeProviders 平行的 codex 侧)。
//
// codex 与 claude 的切换机制差异(调研 ~/.codex/config.toml + cc-switch codex providers):
// - claude:settings.json 的 env 段整体替换 + 活跃进程 kill+--resume 拾取。
// - codex:**每轮新进程自动读最新 config.toml**,切换后无需重启,下一轮即生效;前端仅刷新
//   模型目录/当前 model 显示(refreshIfConfigChanged)。token 走 provider 段的
//   experimental_bearer_token(与用户现行配置一致,不碰 auth.json)。
// - 后端 `apply_codex_provider` 用 toml_edit **保格式**只改 provider 相关部分(顶级
//   model_provider/model + [model_providers.custom] 段),mcp_servers/plugins 等本地配置不动
//  (cc-switch 是整份替换,会把本地 MCP 配置一起卷进 provider 副本——我们不做)。
//
// 存储:localStorage `mx.codexProviders`(与 claudeProviders 同级敏感)。

import { invoke } from "@tauri-apps/api/core";

/** 上游接口格式(config.toml provider 段 wire_api):responses(默认,OpenAI Responses
 *  API)/ chat(/v1/chat/completions,旧式 OpenAI 兼容端点)。 */
export type CodexWireApi = "responses" | "chat";

/** 一条 codex 供应商配置。推理力度不进供应商配置(2026-11-04 用户定调:删字段,力度完全
 *  交给 config.toml 现值 + 会话内每轮参数);wireApi 缺省 responses(旧 localStorage 数据
 *  兼容,可选字段)。认证不走 provider 配置:恒为 config.toml 段的
 *  experimental_bearer_token(2026-11-04 用户定调,codex 没有 cc-switch 式认证字段概念)。 */
export type CodexProvider = {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  model: string;
  wireApi?: CodexWireApi;
  /** 供应商级模型列表(对齐 cc-switch modelCatalog.models;可空 = 未配置,会话内模型
   *  菜单退全局 cc-switch-model-catalog.json)。主模型(model 字段)保存在 config.toml,
   *  与列表相互独立——列表只是会话内可选项。 */
  models?: CodexModelEntry[];
};

/** 一条供应商模型条目(cc-switch 口径:id/model slug、显示名、上下文窗口、思考档位)。 */
export type CodexModelEntry = {
  id: string;
  displayName?: string;
  contextWindow?: number;
  /** 思考程度档位(如 ["none","low","medium","high","xhigh","max"];空 = 用全局兜底)。 */
  reasoningLevels?: string[];
};

const PROVIDERS_KEY = "mx.codexProviders";

function isValidProvider(v: unknown): v is CodexProvider {
  if (!v || typeof v !== "object") return false;
  const p = v as Partial<CodexProvider>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.baseUrl === "string" &&
    typeof p.token === "string" &&
    typeof p.model === "string" &&
    (p.wireApi === undefined || p.wireApi === "responses" || p.wireApi === "chat") &&
    (p.models === undefined || Array.isArray(p.models))
  );
}

/** 条目脏数据清洗(编辑器手输难免空行/漏字段):只留有非空 id 的条目。 */
function sanitizeModels(models: unknown): CodexModelEntry[] {
  if (!Array.isArray(models)) return [];
  return models.filter(
    (m): m is CodexModelEntry => !!m && typeof m === "object" && typeof m.id === "string" && !!m.id.trim(),
  );
}

export function loadCodexProviders(): CodexProvider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidProvider).map((p) => ({ ...p, models: sanitizeModels(p.models) }));
  } catch {
    return [];
  }
}

export function saveCodexProviders(list: CodexProvider[]): void {
  try {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(list));
  } catch {
    /* localStorage 不可用 — 静默 */
  }
}

export function newCodexProviderId(): string {
  return `cx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 当前生效 provider 信息(读 config.toml 实值;非 Tauri / 失败返回 null)。 */
export type CodexProviderInfo = {
  baseUrl: string;
  token: string;
  model: string;
  reasoningEffort: string;
  /** provider 段 wire_api 实值(缺键 = codex CLI 默认 "responses")。 */
  wireApi: string;
};

export async function readCurrentCodexInfo(): Promise<CodexProviderInfo | null> {
  try {
    return await invoke<CodexProviderInfo>("read_codex_provider_info");
  } catch {
    return null;
  }
}

/** 生效判定:base_url + token + model 三键匹配,再加 wireApi(任一侧未知即跳过该键比对;
 *  reasoning_effort 不参与,空 = 保留现状语义)。 */
export function isCodexProviderActive(p: CodexProvider, info: CodexProviderInfo | null): boolean {
  if (!info) return false;
  return (
    (!p.baseUrl || info.baseUrl === p.baseUrl) &&
    (!p.token || info.token === p.token) &&
    (!p.model || info.model === p.model) &&
    (!p.wireApi || !info.wireApi || info.wireApi === p.wireApi)
  );
}

/** 「从当前配置导入」:config.toml 实值收敛成一条 provider(推理力度不进配置,
 *  info.reasoningEffort 只在会话 meta 显示用)。 */
export function codexProviderFromInfo(name: string, info: CodexProviderInfo): CodexProvider {
  return {
    id: newCodexProviderId(),
    name,
    baseUrl: info.baseUrl,
    token: info.token,
    model: info.model,
    wireApi: info.wireApi === "chat" ? "chat" : "responses",
  };
}

/** 切换到指定 provider(保格式改写 config.toml;下一轮 codex 进程自动拾取)。推理力度
 *  不传(后端参数可空,不写 = 保留 config.toml 现值)。 */
export async function applyCodexProvider(p: CodexProvider): Promise<boolean> {
  try {
    await invoke("apply_codex_provider", {
      name: p.name,
      baseUrl: p.baseUrl,
      token: p.token,
      model: p.model,
      wireApi: p.wireApi || "responses",
    });
    return true;
  } catch (err) {
    console.warn("[codexProviders] apply_codex_provider failed:", err);
    return false;
  }
}

/** 切换成功后的广播事件名:AppShell 监听并对池内全部 CodexTransport 调
 *  `refreshIfConfigChanged()`(刷新 meta.model 显示;无需重启进程)。 */
export const CODEX_PROVIDER_CHANGED_EVENT = "mx:codex-provider-changed";

export function notifyCodexProviderChanged(): void {
  window.dispatchEvent(new CustomEvent(CODEX_PROVIDER_CHANGED_EVENT));
}

/** 会话内模型菜单数据源:当前生效供应商的模型列表(active 判定读 config.toml 实值比对
 *  localStorage)。无生效供应商 / 列表未配置时返回 null(调用方退 list_codex_models 全局
 *  catalog)。 */
export async function readActiveCodexProviderModels(): Promise<CodexModelEntry[] | null> {
  const info = await readCurrentCodexInfo();
  if (!info) return null;
  const hit = loadCodexProviders().find((p) => isCodexProviderActive(p, info));
  const models = hit?.models;
  return models && models.length > 0 ? models : null;
}
