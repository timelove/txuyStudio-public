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

/** 一条 codex 供应商配置。wireApi 固定 "responses"(现行配置全部如此,不进表单);
 *  reasoningEffort 可空(空 = 保留 config.toml 现值,切换不覆盖)。 */
export type CodexProvider = {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  model: string;
  reasoningEffort: string;
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
    typeof p.reasoningEffort === "string"
  );
}

export function loadCodexProviders(): CodexProvider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidProvider);
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
};

export async function readCurrentCodexInfo(): Promise<CodexProviderInfo | null> {
  try {
    return await invoke<CodexProviderInfo>("read_codex_provider_info");
  } catch {
    return null;
  }
}

/** 生效判定:base_url + token + model 三键匹配(reasoning_effort 不参与,空 = 保留现状语义)。 */
export function isCodexProviderActive(p: CodexProvider, info: CodexProviderInfo | null): boolean {
  if (!info) return false;
  return (
    (!p.baseUrl || info.baseUrl === p.baseUrl) &&
    (!p.token || info.token === p.token) &&
    (!p.model || info.model === p.model)
  );
}

/** 「从当前配置导入」:config.toml 实值收敛成一条 provider。 */
export function codexProviderFromInfo(name: string, info: CodexProviderInfo): CodexProvider {
  return {
    id: newCodexProviderId(),
    name,
    baseUrl: info.baseUrl,
    token: info.token,
    model: info.model,
    reasoningEffort: info.reasoningEffort,
  };
}

/** 切换到指定 provider(保格式改写 config.toml;下一轮 codex 进程自动拾取)。 */
export async function applyCodexProvider(p: CodexProvider): Promise<boolean> {
  try {
    await invoke("apply_codex_provider", {
      name: p.name,
      baseUrl: p.baseUrl,
      token: p.token,
      model: p.model,
      wireApi: "responses",
      reasoningEffort: p.reasoningEffort || null,
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
