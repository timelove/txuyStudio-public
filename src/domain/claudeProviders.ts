// 内置 claude 供应商配置(txuyStudio 自管理,平移 cc-switch 的切换职责)
//
// 动机(用户 2026-10-20):把自定义三方模型配置内置进 txuyStudio,UI 里直接切换,不再
// 依赖 cc-switch。与 cc-switch 的关系:它改写的也是 `~/.claude/settings.json` 的 env 段,
// 我们存同构数据(name + baseUrl + token + model + 其余 env 键),切换 = 整体替换 env 段
// (后端 `write_claude_settings_env`,statusLine/theme 等其余字段不动),活跃会话随后经
// `refreshIfSettingsChanged`(kill + --resume)拾取新配置。
//
// 存储:localStorage `mx.claudeProviders`(含 token,与 cc-switch.db 同机同等级敏感;
// 跨设备不同步,按机器各自维护)。

import { invoke } from "@tauri-apps/api/core";

/** 认证字段(2026-11-04 对齐 cc-switch):同一 token 放哪个 env 键,决定 CLI 发哪种认证头——
 *  auth_token → `ANTHROPIC_AUTH_TOKEN`(Authorization: Bearer,三方中转通用,默认);
 *  api_key → `ANTHROPIC_API_KEY`(x-api-key 头,官方 API 风格)。 */
export type ClaudeAuthStyle = "auth_token" | "api_key";

/** 上游接口格式(2026-11-04 对齐 cc-switch 的 apiFormat):anthropic = claude CLI 原生协议
 *  (默认);openai = 供应商是 openai 兼容端点。**直连写法与 anthropic 完全相同**(settings.json
 *  env 段无差别)——claude CLI 只讲 anthropic 协议,openai 端点必须自身提供兼容层;此字段
 *  目前仅作标记与 UI 展示,为将来内置协议转换预留。 */
export type ClaudeApiFormat = "anthropic" | "openai";

/** 一条 claude 供应商配置。baseUrl/token/model 是核心三件,extraEnv 兜底平移其余 env 键
 *  (如 CLAUDE_CODE_AUTO_COMPACT_WINDOW / ANTHROPIC_DEFAULT_* 全家桶)——「从当前导入」时
 *  原样保留,切换时一并写回,保证与 cc-switch 手切行为一致。 */
export type ClaudeProvider = {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  /** 默认模型(写 env 的 ANTHROPIC_MODEL;空 = 不写该键,由上游 env 决定)。 */
  model: string;
  /** 其余 env 键值对(不含 BASE_URL/AUTH_TOKEN/API_KEY/ANTHROPIC_MODEL 四个已建模键)。 */
  extraEnv: Record<string, string>;
  /** 认证字段;缺省 = "auth_token"(旧 localStorage 数据兼容,可选字段)。 */
  authStyle?: ClaudeAuthStyle;
  /** 上游接口格式;缺省 = "anthropic"(可选字段)。 */
  apiFormat?: ClaudeApiFormat;
};

const PROVIDERS_KEY = "mx.claudeProviders";

function isValidProvider(v: unknown): v is ClaudeProvider {
  if (!v || typeof v !== "object") return false;
  const p = v as Partial<ClaudeProvider>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.baseUrl === "string" &&
    typeof p.token === "string" &&
    typeof p.model === "string" &&
    p.extraEnv != null &&
    typeof p.extraEnv === "object" &&
    Object.values(p.extraEnv).every((x) => typeof x === "string") &&
    (p.authStyle === undefined || p.authStyle === "auth_token" || p.authStyle === "api_key") &&
    (p.apiFormat === undefined || p.apiFormat === "anthropic" || p.apiFormat === "openai")
  );
}

/** 从 localStorage 读供应商列表(损坏条目静默丢弃;空/损坏回退空数组)。 */
export function loadClaudeProviders(): ClaudeProvider[] {
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

/** 持久化供应商列表(写失败静默:隐私模式等,内存态照常可用)。
 *  同时推一份镜像到 Rust(providers.json)——真源仍是 localStorage,镜像供手机端
 *  chat.models 分组 / chat.setProviderModel 使用(WebView localStorage Rust 读不到)。 */
export function saveClaudeProviders(list: ClaudeProvider[]): void {
  try {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(list));
  } catch {
    /* localStorage 不可用 — 静默 */
  }
  pushProvidersMirror(list);
}

/** providers 镜像推送(Rust 侧 providers.json)。失败静默:非 Tauri mock 环境/后端
 *  不可用,下次保存或启动再推,幂等。 */
function pushProvidersMirror(list: ClaudeProvider[]): void {
  void invoke("save_providers_snapshot", { providers: list }).catch(() => {});
}

/** App 启动推一次镜像:存量迁移(老配置第一次让手机端可见)+ 双端漂移自愈。 */
export function bootstrapProvidersMirror(): void {
  pushProvidersMirror(loadClaudeProviders());
}

/** 生成新 id(时间戳 + 随机后缀,localStorage 侧无需跨设备唯一)。 */
export function newProviderId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** provider → 完整 env 段(切换时整体写入)。建模键 + extraEnv 合并,键序无关
 *  (后端 BTreeMap 排序落盘,同配置多次写文件字节稳定)。token 按认证字段落
 *  AUTH_TOKEN / API_KEY 之一——整体替换语义下另一键不会残留。 */
export function providerEnv(p: ClaudeProvider): Record<string, string> {
  const env: Record<string, string> = { ...p.extraEnv };
  if (p.baseUrl) env.ANTHROPIC_BASE_URL = p.baseUrl;
  if (p.token) {
    if (p.authStyle === "api_key") env.ANTHROPIC_API_KEY = p.token;
    else env.ANTHROPIC_AUTH_TOKEN = p.token;
  }
  if (p.model) env.ANTHROPIC_MODEL = p.model;
  return env;
}

/** 该 provider **已配置**的模型(下拉组内优先展示的那几个,而非端点全目录):
 *  默认模型 `ANTHROPIC_MODEL` 打头,再加 extraEnv 里的 `*_MODEL`(排除 `*_NAME` 显示名
 *  键,与后端 `list_claude_models` 同口径)。去重保序。 */
export function configuredModelsOf(p: ClaudeProvider): string[] {
  const out: string[] = [];
  const push = (v: string | undefined) => {
    const t = (v ?? "").trim();
    if (t && !out.includes(t)) out.push(t);
  };
  push(p.model);
  for (const [k, v] of Object.entries(p.extraEnv)) {
    if (k.endsWith("_MODEL") && !k.endsWith("_NAME")) push(v);
  }
  return out;
}

/** 当前生效 env 与某 provider 是否同配置(建模键 BASE_URL + AUTH_TOKEN/API_KEY(按认证
 *  字段实际落的那个)+ ANTHROPIC_MODEL 逐一比对,空键跳过;extraEnv 的开关类键不参与
 *  判定,避免误报「未生效」)。 */
export function isProviderActive(p: ClaudeProvider, currentEnv: Record<string, string> | null): boolean {
  if (!currentEnv) return false;
  const env = providerEnv(p);
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]) {
    if (env[k] && currentEnv[k] !== env[k]) return false;
  }
  return true;
}

/** 多条配置同端点同密钥时都会通过 `isProviderActive`,取**配置最完整**的一条作生效家
 *  (baseUrl/token/model 填得最多的得分最高)——否则空 model 的兜底条目会让两家同时
 *  显示「生效中」。找不到匹配返回 null(全不生效)。 */
export function pickActiveProviderId(providers: ClaudeProvider[], currentEnv: Record<string, string> | null): string | null {
  let bestId: string | null = null;
  let bestScore = -1;
  for (const p of providers) {
    if (!isProviderActive(p, currentEnv)) continue;
    const score = (p.baseUrl ? 1 : 0) + (p.token ? 1 : 0) + (p.model ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestId = p.id;
    }
  }
  return bestId;
}

/** 读当前 `~/.claude/settings.json` 的 env 段(非 Tauri / 失败返回 null,前端按「未知」显示)。 */
export async function readCurrentEnv(): Promise<Record<string, string> | null> {
  try {
    return await invoke<Record<string, string>>("read_claude_settings_env");
  } catch {
    return null;
  }
}

/** 「从当前配置导入」:把当前生效 env 收敛成一条 provider(其余键进 extraEnv 原样保留)。
 *  认证字段按实值反推:env 里有 ANTHROPIC_API_KEY → api_key(优先取作 token),
 *  否则 auth_token。 */
export function providerFromEnv(name: string, env: Record<string, string>): ClaudeProvider {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (
      k === "ANTHROPIC_BASE_URL" ||
      k === "ANTHROPIC_AUTH_TOKEN" ||
      k === "ANTHROPIC_API_KEY" ||
      k === "ANTHROPIC_MODEL"
    ) {
      continue;
    }
    extra[k] = v;
  }
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  return {
    id: newProviderId(),
    name,
    baseUrl: env.ANTHROPIC_BASE_URL ?? "",
    token: apiKey || (env.ANTHROPIC_AUTH_TOKEN ?? ""),
    model: env.ANTHROPIC_MODEL ?? "",
    authStyle: apiKey ? "api_key" : "auth_token",
    extraEnv: extra,
  };
}

/** 切换到指定 provider:整体替换 settings.json env 段。返回是否成功(失败不落任何状态)。 */
export async function applyProvider(p: ClaudeProvider): Promise<boolean> {
  try {
    await invoke("write_claude_settings_env", { env: providerEnv(p) });
    return true;
  } catch (err) {
    console.warn("[claudeProviders] write_claude_settings_env failed:", err);
    return false;
  }
}

/** 切换成功后的广播事件名:AppShell 监听并对池内所有活跃 ClaudeTransport 调
 *  `refreshIfSettingsChanged()`(idle 的 kill + --resume 拾取新配置;busy 静默跳过,
 *  下轮 send 前 ensureStarted 不覆盖——由用户点模型选择器时再触发)。 */
export const PROVIDER_CHANGED_EVENT = "mx:claude-provider-changed";

// (2026-10-30 撤)供应商模型目录缓存 mx.providerCatalog.<id>:下拉曾展示端点全目录,
// 现组内只列已配置模型,不再 probe/缓存。遗留的 localStorage 键无害,不迁移。

/** 广播「供应商已切换」(AppShell 消费)。 */
export function notifyProviderChanged(): void {
  window.dispatchEvent(new CustomEvent(PROVIDER_CHANGED_EVENT));
}
