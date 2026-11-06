// AI 供应商管理(设置 → 模型 tab,Claude 与 Codex 各一个独立实例)。数据与切换链路见
// domain/claudeProviders.ts / domain/codexProviders.ts——两侧机制不同(claude 改 settings.json
// env 段 + 活跃进程 kill+--resume;codex 保格式改 config.toml 的 provider 段,下一轮新进程
// 自动拾取),UI 结构共用本组件,经 kind 分流到各自 domain 适配器。
//
// 编辑表单(2026-10-20 对齐 cc-switch 全功能):
// - 「预设」下拉:供应商表(name/baseUrl/默认模型/官网/取 Key 链接)从 cc-switch(MIT)提取
//   生成(domain/providerPresets.ts),选中即回填免手敲;Token 恒手填。
// - 字段 label 化(预设/名称/Base URL/Token/模型/推理力度),Token 显隐切换。
// - 端点探测(参考 FetchedModelPicker/EndpointSpeedTest,拉模型+测速合一次请求,走 Rust
//   probe_provider_endpoint 避开 WebView CORS):「拉取模型」回填下方**完整滚动列表**(逐条
//   可点,不截断)且不再用原生 datalist——datalist 会与 WebView2 的 IME 组合态抢焦点,中文
//   打不出来。
// - 「高级配置」折叠:claude = extraEnv 键值编辑(ANTHROPIC_DEFAULT_* 等其余 env 键);顶部
//   「⚡ 一键设置」把模型字段铺到默认模型与四档别名,免手敲 8 个键。
// - 「配置预览」折叠:启用时将写入的 env JSON / config.toml provider 段(只读 + 复制)。
// - 两个出口:表单底部「应用并生效」= 保存 + 立即切换(与列表行 hover ▶ 共用 applyOne);
//   「保存」= 只落列表不切换。
//
// 布局:上方当前生效摘要(读盘实值),下方 provider 列表(卡片:名称 + 生效徽标 + mono 元信息,
// hover 浮现操作);「+ 新增」「从当前导入」进内联编辑表单。启用 = 写配置 + 广播事件。

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  PROVIDER_CHANGED_EVENT,
  applyProvider,
  isProviderActive,
  loadClaudeProviders,
  newProviderId,
  notifyProviderChanged,
  pickActiveProviderId,
  providerFromEnv,
  readCurrentEnv,
  saveClaudeProviders,
  type ClaudeProvider,
} from "../domain/claudeProviders";
import {
  CODEX_PROVIDER_CHANGED_EVENT,
  applyCodexProvider,
  codexProviderFromInfo,
  isCodexProviderActive,
  loadCodexProviders,
  newCodexProviderId,
  notifyCodexProviderChanged,
  readCurrentCodexInfo,
  saveCodexProviders,
  type CodexModelEntry,
  type CodexProvider,
  type CodexProviderInfo,
} from "../domain/codexProviders";
import { invoke } from "@tauri-apps/api/core";
import {
  claudeProviderPresets,
  codexProviderPresets,
  type ProviderPresetEntry,
} from "../domain/providerPresets";
import { Button } from "./ui/Button";
import { CopyButton } from "./ui/CopyButton";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover";

/** codex 模型条目默认上下文窗口(2026-11-04 用户定调:新增/导入/预设都给 272k;
 *  手动逐行可改,只是不用再手敲)。 */
const DEFAULT_CODEX_CTX = 272_000;

/** 编辑表单投影(两 kind 字段并集;按 kind 决定哪些输入框渲染/保存哪些字段)。 */
type Draft = {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  model: string;
  /** 上游接口格式。codex: wire_api(responses/chat;旧数据缺省 responses);claude:
   *  anthropic/openai(旧数据缺省 anthropic)。 */
  wireApi: string;
  apiFormat: string;
  /** claude: auth_token(Bearer 头)/ api_key(x-api-key 头);codex 无认证字段概念
   *  (恒 config 段 experimental_bearer_token,2026-11-04 用户定调)。 */
  authStyle: string;
  /** claude: 其余 env 键(编辑已有条目保住,新增为空)。 */
  extraEnv: Record<string, string>;
  /** codex: 供应商级模型列表(cc-switch modelCatalog 对齐;claude 不用)。 */
  models: CodexModelEntry[];
};

/** 列表条目的统一视图(provider 原始对象 + 展示字段提取;保存时原样回写原对象)。 */
type Row = {
  raw: ClaudeProvider | CodexProvider;
  draft: Draft;
  active: boolean;
};

type ProviderKind = "claude" | "codex";

/** 「一键设置」铺的档位:claude 的四个内置别名(与 env 里 ANTHROPIC_DEFAULT_* 对应)。 */
const MODEL_TIERS = ["OPUS", "SONNET", "HAIKU", "FABLE"] as const;

/** 四档映射占用的 8 个 env 键(模型映射区结构化编辑;其余 env 键仍走下方裸键值行)。 */
const TIER_ENV_KEYS = MODEL_TIERS.flatMap((t) => [
  `ANTHROPIC_DEFAULT_${t}_MODEL`,
  `ANTHROPIC_DEFAULT_${t}_MODEL_NAME`,
]);

/** extraEnv 拆两组:四档映射键(tier 键序稳定)与其余键(裸行区保序)。 */
function splitTierEnv(env: Record<string, string>): {
  tiers: Record<(typeof MODEL_TIERS)[number], { model: string; display: string }>;
  rest: Record<string, string>;
} {
  const tiers = {} as Record<(typeof MODEL_TIERS)[number], { model: string; display: string }>;
  for (const t of MODEL_TIERS) {
    tiers[t] = {
      model: env[`ANTHROPIC_DEFAULT_${t}_MODEL`] ?? "",
      display: env[`ANTHROPIC_DEFAULT_${t}_MODEL_NAME`] ?? "",
    };
  }
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!TIER_ENV_KEYS.includes(k)) rest[k] = v;
  }
  return { tiers, rest };
}

/** 把模型 m 铺到四档别名的 extraEnv(原表其余键保留):`_MODEL` 写原名、`_NAME` 写去方括号
 *  标记的显示名——本机 env 里 _MODEL 带 `[1M]`、_NAME 不带,claude CLI 用 _NAME 作界面
 *  显示名,两套键各按各自口径填。 */
function spreadModelToTiers(extraEnv: Record<string, string>, m: string): Record<string, string> {
  const display = m.replace(/\[[^\]]*\]/g, "").trim() || m;
  const next: Record<string, string> = { ...extraEnv };
  for (const tier of MODEL_TIERS) {
    next[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = m;
    next[`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`] = display;
  }
  return next;
}

/** 取出 extraEnv 里的四档映射键(与 splitTierEnv().rest 配对,裸行区写回时保住映射键)。 */
function pickTierEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of TIER_ENV_KEYS) {
    if (env[k] !== undefined) out[k] = env[k];
  }
  return out;
}

/** 端点探测结果(Rust probe_provider_endpoint 镜像)。 */
type ProbeResult = { latencyMs: number; status: number; models: string[]; error: string | null };

/**
 * 表单字段:label + 输入(label 化,比纯 placeholder 可扫读)。
 *
 * **必须在模块顶层定义**(2026-11-02 教训,IME 丢字根因):曾定义在 ProviderManager
 * render 体内——每次输入(setDraft)重渲染时 Field 都是新的函数引用,React 视为不同
 * 组件类型,表单全部控件整体 remount。IME 提交(compositionend)瞬间正撞上 remount,
 * 中文文本丢失(实测模型输入框打不出中文);焦点随 remount 漂移,还出现「焦点自己
 * 跳到别的输入框」。探针证据:focus() FROM commitMount(react-dom)。
 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">{label}</span>
      {children}
    </label>
  );
}

/** 余额查询结果(Rust query_provider_balance 镜像;null = 供应商不在白名单,不显示)。 */
type BalanceEntry = { label: string; remaining: number; unit: string };
type QuotaTier = { name: string; usedPct: number; resetMs: number | null };
type QuotaInfo = { tiers: QuotaTier[]; level: string | null };
type BalanceResult = { entries: BalanceEntry[]; error: string | null; quota: QuotaInfo | null };

/** 重置时间(Unix 毫秒)→ 相对时长("2h31m" / "3d12h"(≥48h 转天)/ "18m";已过期给 "0m")。 */
function fmtReset(ms: number): string {
  const d = ms - Date.now();
  if (d <= 0) return "0m";
  const h = Math.floor(d / 3_600_000);
  const m = Math.floor((d % 3_600_000) / 60_000);
  if (h >= 48) return `${Math.floor(h / 24)}d${h % 24}h`;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

type ProbeState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; result: ProbeResult }
  | { phase: "error"; message: string };

/** kind → 数据层适配(load/save/apply/判定/导入/事件,类型经视图层收敛)。 */
function useAdapter(kind: ProviderKind) {
  return kind === "claude"
    ? {
        kind: "claude" as const,
        load: () => loadClaudeProviders(),
        save: (rows: ClaudeProvider[]) => saveClaudeProviders(rows),
        newId: () => newProviderId(),
        readCurrent: () => readCurrentEnv(),
        currentSummary: (cur: Record<string, string> | null) => ({
          baseUrl: cur?.ANTHROPIC_BASE_URL ?? "",
          model: cur?.ANTHROPIC_MODEL ?? "",
        }),
        isActive: (p: ClaudeProvider, cur: Record<string, string> | null) => isProviderActive(p, cur),
        apply: (p: ClaudeProvider) => applyProvider(p),
        notifyChanged: () => notifyProviderChanged(),
        fromCurrent: (name: string, cur: Record<string, string>) => providerFromEnv(name, cur),
      }
    : {
        kind: "codex" as const,
        load: () => loadCodexProviders(),
        save: (rows: CodexProvider[]) => saveCodexProviders(rows),
        newId: () => newCodexProviderId(),
        readCurrent: () => readCurrentCodexInfo(),
        currentSummary: (cur: CodexProviderInfo | null) => ({
          baseUrl: cur?.baseUrl ?? "",
          model: cur?.model ?? "",
        }),
        isActive: (p: CodexProvider, cur: CodexProviderInfo | null) => isCodexProviderActive(p, cur),
        apply: (p: CodexProvider) => applyCodexProvider(p),
        notifyChanged: () => notifyCodexProviderChanged(),
        fromCurrent: (name: string, cur: CodexProviderInfo) => codexProviderFromInfo(name, cur),
      };
}

/** 与 claudeProviders.providerEnv 同拼装逻辑(配置预览用;空 token/模型省键的语义一致;
 *  token 键按认证字段落 AUTH_TOKEN / API_KEY)。 */
function draftEnvJson(draft: Draft): string {
  const env: Record<string, string> = { ...draft.extraEnv };
  if (draft.baseUrl.trim()) env.ANTHROPIC_BASE_URL = draft.baseUrl.trim();
  if (draft.token.trim()) {
    if (draft.authStyle === "api_key") env.ANTHROPIC_API_KEY = draft.token.trim();
    else env.ANTHROPIC_AUTH_TOKEN = draft.token.trim();
  }
  if (draft.model.trim()) env.ANTHROPIC_MODEL = draft.model.trim();
  return JSON.stringify(env, null, 2);
}

/** 与后端 apply_codex_provider 的段写法对齐(config.toml provider 段预览)。 */
function draftToml(draft: Draft): string {
  const name = draft.name.trim() || "(名称)";
  // codex 无「默认模型」字段后,config.toml 的 model = 模型列表首项(claude 的 models
  // 恒空数组,自然回退 draft.model 的 ANTHROPIC 语义——本函数只服务 codex 预览)。
  const model = draft.models[0]?.id.trim() || draft.model.trim();
  const lines = [
    `# ~/.codex/config.toml(provider 段;mcp_servers 等其余部分原样保留)`,
    `model_provider = "custom"`,
    model ? `model = "${model}"` : `# model = (保留现值)`,
    `# model_reasoning_effort = (不进供应商配置,保留现值;会话内可按轮覆盖)`,
    ``,
    `[model_providers.custom]`,
    `name = "${name}"`,
    `base_url = "${draft.baseUrl.trim() || "(未填)"}"`,
    `wire_api = "${draft.wireApi || "responses"}"`,
    `requires_openai_auth = false`,
    draft.token.trim() ? `experimental_bearer_token = "${draft.token.trim()}"` : `# experimental_bearer_token = (未填)`,
  ];
  return lines.join("\n");
}

export function ProviderManager({ kind }: { kind: ProviderKind }) {
  const { t } = useTranslation();
  const adapter = useAdapter(kind);
  const [providers, setProviders] = useState<(ClaudeProvider | CodexProvider)[]>(() => adapter.load());
  const [current, setCurrent] = useState<Record<string, string> | CodexProviderInfo | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  // 端点探测(编辑表单内;draft 关闭即重置)、Token 显隐、折叠区开关。
  const [probe, setProbe] = useState<ProbeState>({ phase: "idle" });
  // 余额行(cc-switch 口径:域名白名单,不支持/未填 token 不渲染)。sig = baseUrl|token,
  // 编辑保存后签名变了自动重查;同签名不重复查(effect 依赖 balances 但 sig 命中即跳过)。
  const [balances, setBalances] = useState<Record<string, { sig: string; state: BalanceResult | null }>>({});
  // 模型下拉(拉取到的目录收进下拉,点开才展示;换编辑对象即重置)。
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // 挂载即读当前生效配置(徽标判定 + 「从当前导入」源);打开面板即最新。
  useEffect(() => {
    void adapter.readCurrent().then(setCurrent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 别处(会话里的模型下拉)切了供应商/模型 → 顶部「当前生效」与生效徽标同步刷新,
  // 否则停在本面板上的摘要会一直是旧的。
  useEffect(() => {
    const reload = () => void adapter.readCurrent().then(setCurrent);
    window.addEventListener(PROVIDER_CHANGED_EVENT, reload);
    window.addEventListener(CODEX_PROVIDER_CHANGED_EVENT, reload);
    return () => {
      window.removeEventListener(PROVIDER_CHANGED_EVENT, reload);
      window.removeEventListener(CODEX_PROVIDER_CHANGED_EVENT, reload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  // 余额自动查询:providers 变化(挂载/保存)时对每条查一次;null(白名单外)记为
  // 「不支持」不再渲染;失败保留 error 文案(行内 title 展示,不弹窗)。静默并发,
  // 不阻塞列表渲染(余额行渐进出现)。
  useEffect(() => {
    for (const p of providers) {
      const sig = `${p.baseUrl.trim()}|${p.token.trim()}`;
      if (!p.baseUrl.trim() || balances[p.id]?.sig === sig) continue;
      setBalances((prev) => ({ ...prev, [p.id]: { sig, state: null } }));
      void invoke<BalanceResult | null>("query_provider_balance", {
        baseUrl: p.baseUrl.trim(),
        token: p.token.trim() || null,
      })
        .then((r) =>
          setBalances((prev) =>
            prev[p.id]?.sig === sig ? { ...prev, [p.id]: { sig, state: r ?? null } } : prev,
          ),
        )
        .catch(() => {
          /* 查询异常与不支持同形:不显示 */
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, balances]);

  const persist = (next: (ClaudeProvider | CodexProvider)[]) => {
    setProviders(next);
    // 适配器 save 的入参类型与 next 收敛后一致(同一 kind 的数组)。
    if (adapter.kind === "claude") saveClaudeProviders(next as ClaudeProvider[]);
    else saveCodexProviders(next as CodexProvider[]);
  };

  // claude 侧同理落单:同端点同密钥的多条配置只有「配置最完整」的那条亮徽标
  // (与 ClaudePane 模型下拉同一条判定,避免两处口径打架)。
  const claudeActiveId = adapter.kind === "claude" ? pickActiveProviderId(providers as ClaudeProvider[], current as Record<string, string> | null) : null;
  const rows: Row[] = providers.map((raw) => {
    const active =
      adapter.kind === "claude"
        ? raw.id === claudeActiveId
        : isCodexProviderActive(raw as CodexProvider, current as CodexProviderInfo | null);
    const draftFrom: Draft = {
      id: raw.id,
      name: raw.name,
      baseUrl: raw.baseUrl,
      token: raw.token,
      model: raw.model,
      wireApi: "responses",
      apiFormat: "anthropic",
      authStyle: "auth_token",
      extraEnv: {},
      models: [],
    };
    if (adapter.kind === "claude") {
      draftFrom.extraEnv = (raw as ClaudeProvider).extraEnv;
      draftFrom.authStyle = (raw as ClaudeProvider).authStyle ?? "auth_token";
      draftFrom.apiFormat = (raw as ClaudeProvider).apiFormat ?? "anthropic";
    } else {
      draftFrom.wireApi = (raw as CodexProvider).wireApi ?? "responses";
      draftFrom.models = (raw as CodexProvider).models ?? [];
    }
    return { raw, draft: draftFrom, active };
  });

  const summary = adapter.currentSummary(current as never);

  // 预设分组(按类别归并排序;kind 决定用哪张表)。
  const presetGroups = useMemo(() => {
    const presets = (adapter.kind === "claude" ? claudeProviderPresets : codexProviderPresets) as ProviderPresetEntry[];
    const order = ["cn_official", "cloud_provider", "third_party", "aggregator", "local", "other"] as const;
    const labelKey: Record<string, string> = {
      cn_official: "settings.providers.catCnOfficial",
      cloud_provider: "settings.providers.catCloud",
      third_party: "settings.providers.catThirdParty",
      aggregator: "settings.providers.catAggregator",
      local: "settings.providers.catLocal",
      other: "settings.providers.catOther",
    };
    const buckets = new Map<string, ProviderPresetEntry[]>();
    for (const p of presets) {
      const cat = p.category === "thirdparty" ? "third_party" : p.category ?? "other";
      const key = order.includes(cat as (typeof order)[number]) ? cat : "other";
      const list = buckets.get(key) ?? [];
      list.push(p);
      buckets.set(key, list);
    }
    return order
      .filter((k) => buckets.has(k))
      .map((k) => ({ key: k, label: labelKey[k], items: buckets.get(k)! }));
  }, [adapter.kind]);
  const allPresets = presetGroups.flatMap((g) => g.items);
  // 当前 baseUrl 匹配到的预设(用于「官网/获取 Key」链接;不匹配则无)。
  const matchedPreset = draft ? allPresets.find((p) => p.baseUrl === draft.baseUrl.trim()) : undefined;

  /** 列表行 hover ▶:直接启用该行(不动表单)。 */
  const handleApply = async (row: Row) => {
    await applyOne(row.raw);
  };

  /** 启用某条配置(列表 hover ▶ 与表单底部「应用」共用):写盘 + 广播 + 回读生效摘要。 */
  const applyOne = async (p: ClaudeProvider | CodexProvider) => {
    setApplyingId(p.id);
    setApplyError(null);
    const ok = await adapter.apply(p as never);
    setApplyingId(null);
    if (!ok) {
      setApplyError(t("settings.providers.applyFailed"));
      return false;
    }
    adapter.notifyChanged();
    setCurrent(await adapter.readCurrent());
    return true;
  };

  const handleImport = async () => {
    const cur = current ?? (await adapter.readCurrent());
    if (!cur) return;
    const s = adapter.currentSummary(cur as never);
    if (!s.baseUrl) return;
    // 重名自动加序号,避免连续导入多条「当前配置」混在一起。
    const base = t("settings.providers.importedName");
    let name = base;
    let n = 2;
    while (providers.some((p) => p.name === name)) name = `${base} ${n++}`;
    persist([...providers, adapter.fromCurrent(name, cur as never)]);
  };

  // 拉模型列表 + 测速(GET {base}/v1/models 计时,一次请求两用)。
  const handleFetchModels = async () => {
    if (!draft?.baseUrl.trim()) return;
    setProbe({ phase: "loading" });
    try {
      const r = await invoke<ProbeResult>("probe_provider_endpoint", {
        baseUrl: draft.baseUrl.trim(),
        token: draft.token.trim() || null,
      });
      setProbe(r.error ? { phase: "error", message: r.error } : { phase: "done", result: r });
    } catch (e) {
      setProbe({ phase: "error", message: String(e) });
    }
  };

  /** 表单 → provider 对象(保存与「应用」共用;未改名返回 null)。 */
  const draftToProvider = (): ClaudeProvider | CodexProvider | null => {
    if (!draft || !draft.name.trim()) return null;
    const base: Draft = { ...draft, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), token: draft.token.trim(), model: draft.model.trim() };
    return adapter.kind === "claude"
      ? {
          id: draft.id || newProviderId(),
          name: base.name,
          baseUrl: base.baseUrl,
          token: base.token,
          model: base.model,
          apiFormat: base.apiFormat === "openai" ? "openai" : "anthropic",
          authStyle: base.authStyle === "api_key" ? "api_key" : "auth_token",
          extraEnv: draft.extraEnv,
        }
      : (() => {
          // codex 无「默认模型」字段(2026-11-04 对齐 cc-switch):config.toml 的 model =
          // 模型列表首项(空列表 = 不覆盖 config 现值);列表为模型的唯一配置入口。
          const models = (draft.models ?? [])
            .filter((m) => m.id.trim())
            .map((m) => ({ ...m, id: m.id.trim() }));
          return {
            id: draft.id || newCodexProviderId(),
            name: base.name,
            baseUrl: base.baseUrl,
            token: base.token,
            model: models[0]?.id ?? "",
            wireApi: base.wireApi === "chat" ? "chat" : "responses",
            models,
          };
        })();
  };

  /** 保存并落列表(不切换生效)。 */
  const upsertProvider = (next: ClaudeProvider | CodexProvider) => {
    const idx = providers.findIndex((p) => p.id === next.id);
    persist(idx >= 0 ? providers.map((p) => (p.id === next.id ? next : p)) : [...providers, next]);
  };

  const handleSaveDraft = () => {
    const next = draftToProvider();
    if (!next) return;
    upsertProvider(next);
    closeDraft();
  };

  /** 「应用并生效」= 保存 + 立即生效:写盘 + 广播(活跃会话重启拾取新配置)。成功后
   *  返回列表页(active 徽章挪到该行即结果反馈);失败留在表单,底部就地报错。 */
  const handleApplyDraft = async () => {
    const next = draftToProvider();
    if (!next) return;
    upsertProvider(next);
    if (await applyOne(next)) closeDraft();
  };

  const emptyDraft = (): Draft => ({ id: "", name: "", baseUrl: "", token: "", model: "", wireApi: "responses", apiFormat: "anthropic", authStyle: "auth_token", extraEnv: {}, models: [] });

  const [quickSetupMsg, setQuickSetupMsg] = useState<string | null>(null);

  /** 高级区「一键设置」:把模型输入框里选中的模型铺到四档别名(默认模型 = 表单的模型字段本身,
   *  已映射 ANTHROPIC_MODEL,无需重复)。
   *
   * 供应商(尤其三方中转)通常要求 ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL 全部指向
   * 同一个上游模型,手敲 8 个 env 键极易漏;这里一次写全。**_NAME 写去掉方括号标记的显示名**
   * (`deepseek-v4.1-flash-new[1M]` → `deepseek-v4.1-flash-new`)——本机 env 里 _MODEL 带 `[1M]`、
   * _NAME 不带,claude CLI 用 _NAME 作界面显示名,故两套键各按各自口径填。 */
  const handleQuickSetup = () => {
    const m = draft?.model.trim();
    if (!draft || !m) return;
    setDraft({ ...draft, extraEnv: spreadModelToTiers(draft.extraEnv, m) });
    setQuickSetupMsg(t("settings.providers.quickSetupDone", { count: MODEL_TIERS.length * 2 }));
  };

  /** 下拉选中某个模型 = 一键设置:填模型字段 + 铺四档别名(claude 独有;codex 只填字段)。 */
  const pickModel = (m: string) => {
    if (!draft) return;
    setModelMenuOpen(false);
    if (kind !== "claude") {
      setDraft({ ...draft, model: m });
      return;
    }
    setDraft({ ...draft, model: m, extraEnv: spreadModelToTiers(draft.extraEnv, m) });
    setQuickSetupMsg(t("settings.providers.quickSetupDone", { count: MODEL_TIERS.length * 2 }));
  };

  /** codex 供应商级模型列表行编辑(cc-switch modelCatalog 对齐;slug 必填其余可空,
   *  空行保存时剔除)。 */
  const setModelEntry = (idx: number, patch: Partial<CodexModelEntry>) => {
    if (!draft) return;
    setDraft({ ...draft, models: draft.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  };
  const addModelEntry = () => {
    if (!draft) return;
    setDraft({ ...draft, models: [...draft.models, { id: "", contextWindow: DEFAULT_CODEX_CTX }] });
  };
  const removeModelEntry = (idx: number) => {
    if (!draft) return;
    setDraft({ ...draft, models: draft.models.filter((_, i) => i !== idx) });
  };
  /** 探测结果一键铺进列表(已有 id 跳过;显示名暂用 slug;ctx 给 codex 默认 272k)。 */
  const importProbedModels = () => {
    if (!draft) return;
    const kept = draft.models.filter((m) => m.id.trim());
    const known = new Set(kept.map((m) => m.id.trim()));
    const fresh = fetchedModels.filter((id) => !known.has(id)).map((id) => ({ id, displayName: id, contextWindow: DEFAULT_CODEX_CTX }));
    setDraft({ ...draft, models: [...kept, ...fresh] });
  };

  /** 模型映射行写回:值清空 = 删键(不落空值键);仅映射区(高级区)渲染期间被调用。 */
  const setTierEnv = (tier: string, part: "model" | "display", value: string) => {
    if (!draft) return;
    const key = part === "model" ? `ANTHROPIC_DEFAULT_${tier}_MODEL` : `ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`;
    const v = value.trim();
    const next = { ...draft.extraEnv };
    if (!v) delete next[key];
    else next[key] = v;
    setDraft({ ...draft, extraEnv: next });
  };

  /** 「支持 1M」开关:切换模型名尾部 `[1M]` 标记并同步铺别名。约定 `_MODEL` 带标记、
   *  `_NAME` 显示名不带(spreadModelToTiers 已按此口径剥),勾选状态由模型名反推——
   *  手输/下拉选中带 [1M] 的条目会自动亮。 */
  const toggle1M = () => {
    const m = draft?.model.trim() ?? "";
    if (!draft || !m) return;
    const next = /\[1M\]$/i.test(m) ? m.replace(/\[1M\]$/i, "").trim() : `${m}[1M]`;
    setDraft({ ...draft, model: next, extraEnv: spreadModelToTiers(draft.extraEnv, next) });
  };

  const closeDraft = () => {
    setDraft(null);
    setQuickSetupMsg(null);
    setProbe({ phase: "idle" });
    setModelMenuOpen(false);
    setModelQuery("");
    setShowToken(false);
    setShowAdvanced(false);
    setShowPreview(false);
  };

  /** 打开某条草稿编辑(新建 / 点列表行共用):「一键设置」反馈与拉取到的模型列表都只属于当次
   *  编辑,换对象即清(否则会看到上一条 baseUrl 探测回来的模型列表)。 */
  const openDraft = (next: Draft) => {
    setQuickSetupMsg(null);
    setProbe({ phase: "idle" });
    setModelMenuOpen(false);
    setModelQuery("");
    setDraft(next);
  };

  /** 卡片额度(编程套餐的 5 小时/周窗口已用百分比 + 重置倒计时;按量账户/不支持为 null
   *  不渲染)。渲染在名称行右侧**上下两行**(用户 2026-11-04:5h/7d 竖排,横排太长挤名称),
   *  右对齐;已用 ≥85% 红、≥60% 金,提醒离限还剩多少。 */
  const quotaLine = (id: string) => {
    const q = balances[id]?.state?.quota;
    if (!q || q.tiers.length === 0) return null;
    return (
      <div className="flex shrink-0 flex-col items-end gap-px font-mono text-[10px] leading-tight">
        {q.tiers.map((tier) => {
          const label = tier.name === "fiveHour" ? t("settings.providers.quota5h") : t("settings.providers.quotaWeekly");
          const rel = tier.resetMs != null ? fmtReset(tier.resetMs) : null;
          return (
            <span
              key={tier.name}
              className={tier.usedPct >= 85
                ? "text-[var(--mx-danger)]"
                : tier.usedPct >= 60
                  ? "text-[var(--mx-warning)]"
                  : "text-[var(--mx-success)]"}
            >
              {label} {tier.usedPct.toFixed(0)}%{rel ? ` · ${rel}` : ""}
            </span>
          );
        })}
        {q.level && (
          <span className="max-w-[140px] truncate text-[var(--mx-faint)]" title={q.level}>{q.level}</span>
        )}
      </div>
    );
  };

  const inputCls =
    "w-full rounded-[var(--mx-radius-md)] border border-[var(--mx-border-strong)] bg-[var(--mx-surface-2)] px-2 py-1 text-[12px] text-[var(--mx-text)] outline-none transition-colors placeholder:text-[var(--mx-faint)] focus-visible:border-[var(--mx-accent)] focus-visible:ring-1 focus-visible:ring-[var(--mx-accent)]";

  const previewText = draft ? (kind === "claude" ? draftEnvJson(draft) : draftToml(draft)) : "";
  /** 拉取到的模型目录(没拉过/失败为空数组;下拉只在这个非空时可用)。 */
  const fetchedModels = probe.phase === "done" ? probe.result.models : [];

  // 二级页面:列表页(全宽,点行进入编辑)↔ 编辑页(占满 tab 内容区,保存/应用后返回)。
  // 原 240px 左栏 + 右栏表单的双栏把编辑框挤得很小(用户 2026-11-02),改互斥两页后
  // 表单拿到全部宽度,长 baseUrl/token/model 不再在小列里受罪。
  if (!draft) {
    return (
      <div className="flex max-h-[520px] min-h-[380px] flex-col">
        {/* 当前生效摘要:全宽列表页里改单行横排(圆点 + 标题 + baseUrl · model)。 */}
        <div className="mb-2 flex items-center gap-2 rounded-[var(--mx-radius-md)] border border-[var(--mx-accent)]/30 bg-[var(--mx-card-inner)] px-2.5 py-1.5">
          <span className="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--mx-accent)] shadow-[0_0_4px_var(--mx-accent)]" />
            {t("settings.providers.currentTitle")}
          </span>
          {current ? (
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--mx-muted)]" title={`${summary.baseUrl}\n${summary.model}`}>
              {summary.baseUrl || "—"} · {summary.model || "—"}
            </span>
          ) : (
            <span className="text-[10px] text-[var(--mx-faint)]">{t("settings.providers.currentUnknown")}</span>
          )}
        </div>

        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">
            {t("settings.providers.listTitle")}
          </span>
          <div className="flex items-center gap-1">
            <Button size="xs" variant="outline" onClick={handleImport}>
              {t("settings.providers.importCurrent")}
            </Button>
            <Button size="xs" title={t("settings.providers.add")} onClick={() => openDraft(emptyDraft())}>
              +
            </Button>
          </div>
        </div>
        {applyError && <div className="mb-1.5 text-[10px] text-[var(--mx-danger)]">{applyError}</div>}

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
          {rows.length === 0 && (
            <div className="py-4 text-center text-[11px] text-[var(--mx-faint)]">
              {t("settings.providers.empty")}
            </div>
          )}
          {rows.map((row) => {
            return (
              <div
                key={row.draft.id}
                role="button"
                tabIndex={0}
                onClick={() => openDraft({ ...row.draft })}
                onKeyDown={(e) => e.key === "Enter" && openDraft({ ...row.draft })}
                className="flex cursor-pointer items-center gap-1.5 rounded-[var(--mx-radius-md)] border border-[var(--mx-border)] bg-[var(--mx-card-inner)] px-2.5 py-1.5 transition-colors hover:border-[var(--mx-border-strong)] hover:bg-[var(--mx-hover-bg)]"
              >
                {/* 左列(名称 + meta)flex-1;额度/操作挂在卡片级右侧,随整卡垂直居中
                    (用户 2026-11-04:额度竖排三行后仍要垂直居中)。 */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {row.active && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mx-accent-bright)] shadow-[0_0_4px_var(--mx-accent)]" />}
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--mx-text)]">{row.draft.name}</span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--mx-faint)]" title={`${row.draft.baseUrl}${row.draft.model ? ` · ${row.draft.model}` : ""}`}>
                    {row.draft.model || row.draft.baseUrl || "—"}
                  </div>
                </div>
                {quotaLine(row.draft.id)}
                {/* 删除(2026-11-04 用户:列表页此前无删除入口,只能进编辑页删):就地删
                    + 落盘;活跃条目也可删——删的只是配置记录,config.toml/settings.json
                    现值不动,下一轮进程照常读现配置。 */}
                <button
                  type="button"
                  title={t("common.delete")}
                  aria-label={t("common.delete")}
                  className="shrink-0 rounded-[4px] p-0.5 text-[var(--mx-faint)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-danger)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    persist(providers.filter((x) => x.id !== row.draft.id));
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 6h18" />
                    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  </svg>
                </button>
                {/* 显式编辑入口:整行本就可点进编辑,但常显铅笔让「能编辑」一眼可见
                    (用户 2026-11-02:只靠点行发现不了)。 */}
                <button
                  type="button"
                  title={t("common.edit")}
                  aria-label={t("common.edit")}
                  className="shrink-0 rounded-[4px] p-0.5 text-[var(--mx-faint)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    openDraft({ ...row.draft });
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                  </svg>
                </button>
                {/* 启用按钮常显(用户 2026-11-04:别藏在 hover 里)。 */}
                {!row.active && (
                  <button
                    type="button"
                    title={t("settings.providers.apply")}
                    aria-label={t("settings.providers.apply")}
                    disabled={applyingId === row.draft.id}
                    className="shrink-0 rounded-[4px] px-1 py-0.5 text-[10px] text-[var(--mx-accent-bright)] hover:bg-[var(--mx-accent-soft)]"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleApply(row);
                    }}
                  >
                    {applyingId === row.draft.id ? "…" : "▶"}
                  </button>
                )}
                {row.active && (
                  <span className="shrink-0 rounded-full bg-[var(--mx-accent-soft)] px-1.5 py-px text-[9px] font-medium text-[var(--mx-accent-bright)]">
                    {t("settings.providers.activeBadge")}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-2 text-[10px] leading-relaxed text-[var(--mx-faint)]">
          {t(kind === "claude" ? "settings.providers.hint" : "settings.providers.hintCodex")}
        </div>
      </div>
    );
  }

  // 编辑页:顶部「← 返回」+ 名称回显 + 删除;中部滚动表单;底部固定操作行。
  // 「保存」「应用并生效」成功后都返回列表页(active 徽章挪到该行即结果反馈)。
  return (
    <div className="flex max-h-[520px] min-h-[420px] flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--mx-border)] pb-2">
        <button
          type="button"
          title={t("settings.providers.backToList")}
          aria-label={t("settings.providers.backToList")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--mx-radius-sm)] text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
          onClick={closeDraft}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--mx-text)]">
          {draft.name || t("settings.providers.fldName")}
        </span>
        {draft.id && (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto shrink-0 text-[var(--mx-danger)]"
            onClick={() => {
              persist(providers.filter((x) => x.id !== draft.id));
              closeDraft();
            }}
          >
            {t("common.delete")}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto py-2.5 pr-0.5">
            <Field label={t("settings.providers.presetLabel")}>
              <div className="flex items-center gap-1.5">
                <select
                  className={`${inputCls} flex-1`}
                  value=""
                  onChange={(e) => {
                    const preset = allPresets.find((p) => p.name === e.target.value);
                    if (preset) {
                      if (kind === "codex") {
                        // codex 无「默认模型」字段(2026-11-04 对齐 cc-switch):预设模型进列表
                        // 首项(主模型);列表已有内容不覆盖。
                        setDraft({
                          ...draft,
                          name: draft.name.trim() || preset.name,
                          baseUrl: preset.baseUrl,
                          models:
                            draft.models.length > 0 || !preset.model
                              ? draft.models
                              : [{ id: preset.model, contextWindow: DEFAULT_CODEX_CTX }],
                        });
                      } else {
                        setDraft({
                          ...draft,
                          name: draft.name.trim() || preset.name,
                          baseUrl: preset.baseUrl,
                          model: draft.model.trim() || preset.model || "",
                        });
                      }
                    }
                  }}
                >
                  <option value="">{t("settings.providers.presetPlaceholder")}</option>
                  {presetGroups.map((g) => (
                    <optgroup key={g.key} label={t(g.label)}>
                      {g.items.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {matchedPreset?.websiteUrl && (
                  <a
                    href={matchedPreset.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-[10px] text-[var(--mx-accent-bright)] hover:underline"
                  >
                    {t("settings.providers.websiteLink")}
                  </a>
                )}
                {matchedPreset?.apiKeyUrl && (
                  <a
                    href={matchedPreset.apiKeyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-[10px] text-[var(--mx-accent-bright)] hover:underline"
                  >
                    {t("settings.providers.apiKeyLink")}
                  </a>
                )}
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-2.5">
              <Field label={t(kind === "claude" ? "settings.providers.fldName" : "settings.providers.fldNameCodex")}>
                <input
                  className={inputCls}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  autoFocus
                />
              </Field>
              <Field label={t(kind === "claude" ? "settings.providers.fldBaseUrl" : "settings.providers.fldBaseUrlCodex")}>
                <input
                  className={`${inputCls} font-mono`}
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                />
              </Field>
            </div>

            {/* Token 全宽(推理力度不进供应商配置:2026-11-04 删字段,力度完全交给
                config.toml 现值 + 会话内每轮参数)。 */}
            <Field label={t("settings.providers.fldToken")}>
              <div className="relative">
                <input
                  className={`${inputCls} font-mono pr-7`}
                  type={showToken ? "text" : "password"}
                  value={draft.token}
                  onChange={(e) => setDraft({ ...draft, token: e.target.value })}
                  autoComplete="off"
                />
                <button
                  type="button"
                  aria-label={showToken ? "hide token" : "show token"}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--mx-faint)] hover:text-[var(--mx-text)]"
                  onClick={() => setShowToken(!showToken)}
                >
                  {showToken ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </Field>

            {/* 不用 `<Field>`(它是 <label>):这里内部还有「1M」checkbox 的 label 与多个
                控件,label 嵌 label + 多 labelable 是非法 HTML,点击命中与焦点行为在
                WebView2 上有怪异(含 IME 态),改普通 div + span 手写同款样式。 */}
            {/* claude 专属:默认模型(ANTHROPIC_MODEL)+ 下拉 + 1M + 拉取。codex 无默认模型
                字段(2026-11-04 对齐 cc-switch):下方模型列表是唯一配置入口(config.toml 的
                model = 列表首项),拉取按钮挪列表区。 */}
            {kind === "claude" && (
            <div>
              <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">
                {t("settings.providers.fldModel")}
              </span>
              <div className="flex gap-1.5">
                {/* 不用 `<input list>`(原生 datalist):WebView2/Chromium 的下拉建议会抢 compose
                    输入,中文候选框打不出字(用户实测「模型名只能输入英文」)。自带建议列表走
                    Popover 下拉,点开才展示(用户 2026-10-30:不要一直摊在表单里)。 */}
                <input
                  className={`${inputCls} min-w-0 flex-1 font-mono`}
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  spellCheck={false}
                />
                <Popover open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      disabled={fetchedModels.length === 0}
                      title={t("settings.providers.modelPickHint")}
                      className="shrink-0 rounded-[var(--mx-radius-md)] border border-[var(--mx-border-strong)] bg-[var(--mx-surface-2)] px-1.5 text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
                      onClick={() => setModelQuery("")}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    sideOffset={4}
                    onOpenAutoFocus={(e) => e.preventDefault()}
                    className="mx-menu w-[300px] max-w-[calc(100vw-2rem)] border border-[var(--mx-border)] bg-[var(--mx-surface)] p-1 shadow-xl"
                  >
                    <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">
                      <span>{t("settings.providers.modelListTitle")}</span>
                      <span className="tabular-nums">{fetchedModels.length}</span>
                    </div>
                    {fetchedModels.length > 8 && (
                      <input
                        autoFocus
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                        spellCheck={false}
                        className="mb-1 w-full rounded-[var(--mx-radius-sm)] border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-2 py-1 font-mono text-[11px] text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)] focus-visible:border-[var(--mx-accent)]"
                      />
                    )}
                    {(() => {
                      const q = modelQuery.trim().toLowerCase();
                      const list = q ? fetchedModels.filter((m) => m.toLowerCase().includes(q)) : fetchedModels;
                      if (list.length === 0) {
                        return <div className="px-2 py-1.5 text-[10px] text-[var(--mx-faint)]">{t("settings.providers.modelNoMatch")}</div>;
                      }
                      return (
                        <div className="mx-scroll-pretty max-h-[min(50vh,280px)] overflow-y-auto">
                          {list.map((m) => (
                            <button
                              key={m}
                              type="button"
                              title={m}
                              className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left font-mono text-[10px] transition-colors ${
                                draft.model === m
                                  ? "bg-[var(--mx-selected-bg)] text-[var(--mx-text)]"
                                  : "text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                              }`}
                              onClick={() => pickModel(m)}
                            >
                              <span className="min-w-0 flex-1 truncate">{m}</span>
                              {draft.model === m && <span aria-hidden className="shrink-0 text-[var(--mx-accent)]">✓</span>}
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                    {kind === "claude" && (
                      <div className="mt-1 border-t border-[var(--mx-border)] px-1 pt-1 text-[10px] leading-relaxed text-[var(--mx-faint)]">
                        {t("settings.providers.modelPickSyncNote")}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
                {kind === "claude" && (
                  <label
                    className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-[10px] text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)]"
                    title={t("settings.providers.model1MHint")}
                  >
                    <input
                      type="checkbox"
                      checked={/\[1M\]$/i.test(draft.model.trim())}
                      disabled={!draft.model.trim()}
                      onChange={toggle1M}
                      className="h-3 w-3 accent-[var(--mx-accent)]"
                    />
                    1M
                  </label>
                )}
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  disabled={!draft.baseUrl.trim() || probe.phase === "loading"}
                  onClick={() => void handleFetchModels()}
                >
                  {probe.phase === "loading" ? t("settings.providers.fetching") : t("settings.providers.fetchModels")}
                </Button>
              </div>
            </div>
            )}
            {kind === "claude" && probe.phase === "done" && (
              <div className="-mt-1 text-[10px] text-[var(--mx-faint)]">
                {probe.result.models.length > 0
                  ? t("settings.providers.probeSummary", { count: probe.result.models.length, ms: probe.result.latencyMs, status: probe.result.status })
                  : t("settings.providers.probeEmpty", { ms: probe.result.latencyMs })}
              </div>
            )}
            {kind === "claude" && probe.phase === "error" && (
              <div className="-mt-1 text-[10px] break-all text-[var(--mx-danger)]">{probe.message}</div>
            )}

            {/* codex 供应商级模型列表(cc-switch modelCatalog 对齐,2026-11-04 起为模型的
                唯一配置入口——「默认模型」字段已删,config.toml 的 model = 列表首项):
                获取(探测 /v1/models 一键导入)/手动添加/逐行配置(显示名/思考档位/上下文),
                空行保存时剔除;会话内模型菜单以该列表为数据源(未配置退全局 catalog)。 */}
            {kind === "codex" && (
              <div className="rounded-[var(--mx-radius-md)] border border-[var(--mx-border)] p-2">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">
                    {t("settings.providers.modelsTitle")}
                  </span>
                  <span className="tabular-nums text-[10px] text-[var(--mx-faint)]">{draft.models.length}</span>
                  <span className="min-w-0 flex-1" />
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!draft.baseUrl.trim() || probe.phase === "loading"}
                    onClick={() => void handleFetchModels()}
                  >
                    {probe.phase === "loading" ? t("settings.providers.fetching") : t("settings.providers.fetchModels")}
                  </Button>
                  {fetchedModels.length > 0 && (
                    <Button size="xs" variant="outline" onClick={importProbedModels}>
                      {t("settings.providers.modelsImportProbe")}
                    </Button>
                  )}
                  <Button size="xs" variant="outline" onClick={addModelEntry}>
                    {t("settings.providers.modelsAdd")}
                  </Button>
                </div>
                {draft.models.length === 0 ? (
                  <p className="px-1 text-[10px] leading-relaxed text-[var(--mx-faint)]">
                    {t("settings.providers.modelsEmptyHint")}
                  </p>
                ) : (
                  <div className="space-y-1">
                    <div className="grid grid-cols-[1.1fr_0.9fr_1.1fr_56px_18px] items-center gap-1 px-0.5 text-[9px] uppercase tracking-wide text-[var(--mx-faint)]">
                      <span>{t("settings.providers.modelsHeadSlug")}</span>
                      <span>{t("settings.providers.modelsHeadDisplay")}</span>
                      <span>{t("settings.providers.modelsHeadLevels")}</span>
                      <span className="text-right">{t("settings.providers.modelsHeadCtx")}</span>
                      <span />
                    </div>
                    {draft.models.map((m, idx) => {
                      // 首项即主模型(应用后写 config.toml 的 model);slug 空的行不标。
                      const primary = idx === 0 && !!m.id.trim();
                      return (
                        <div
                          key={idx}
                          className={`grid grid-cols-[1.1fr_0.9fr_1.1fr_56px_18px] items-center gap-1 rounded-l border-l-2 pr-0.5 ${
                            primary ? "border-[var(--mx-accent)]" : "border-transparent"
                          }`}
                        >
                          <input
                            className={`${inputCls} px-1.5 py-0.5 font-mono text-[11px]`}
                            value={m.id}
                            onChange={(e) => setModelEntry(idx, { id: e.target.value })}
                            placeholder="gpt-5.6"
                            spellCheck={false}
                            title={primary ? t("settings.providers.modelsPrimaryTitle") : undefined}
                          />
                          <input
                            className={`${inputCls} px-1.5 py-0.5 text-[11px]`}
                            value={m.displayName ?? ""}
                            onChange={(e) => setModelEntry(idx, { displayName: e.target.value || undefined })}
                            placeholder={t("settings.providers.modelsPhDisplay")}
                            spellCheck={false}
                          />
                          <input
                            className={`${inputCls} px-1.5 py-0.5 font-mono text-[11px]`}
                            value={m.reasoningLevels?.join(",") ?? ""}
                            onChange={(e) =>
                              setModelEntry(idx, {
                                reasoningLevels: e.target.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
                              })
                            }
                            placeholder="none,low,medium,high"
                            spellCheck={false}
                          />
                          <input
                            className={`${inputCls} px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums`}
                            value={m.contextWindow ?? ""}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              setModelEntry(idx, { contextWindow: e.target.value && Number.isFinite(n) && n > 0 ? n : undefined });
                            }}
                            placeholder="272000"
                            inputMode="numeric"
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            aria-label="remove model"
                            className="flex h-5 w-5 items-center justify-center rounded text-[var(--mx-faint)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-danger)]"
                            onClick={() => removeModelEntry(idx)}
                          >
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                              <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {probe.phase === "done" && (
                  <div className="mt-1.5 text-[10px] text-[var(--mx-faint)]">
                    {probe.result.models.length > 0
                      ? t("settings.providers.probeSummary", { count: probe.result.models.length, ms: probe.result.latencyMs, status: probe.result.status })
                      : t("settings.providers.probeEmpty", { ms: probe.result.latencyMs })}
                  </div>
                )}
                {probe.phase === "error" && (
                  <div className="mt-1.5 text-[10px] break-all text-[var(--mx-danger)]">{probe.message}</div>
                )}
              </div>
            )}

            {kind === "claude" && (
              <div className="rounded-[var(--mx-radius-md)] border border-[var(--mx-border)]">
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wide text-[var(--mx-faint)] hover:text-[var(--mx-muted)]"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  <span aria-hidden>{showAdvanced ? "▾" : "▸"}</span>
                  {t("settings.providers.advancedSection")}
                </button>
                {showAdvanced && (
                  <div className="space-y-2.5 border-t border-[var(--mx-border)] px-2.5 py-2">
                    {/* 上游格式 + 认证字段(cc-switch 口径):上游格式 anthropic 是 claude CLI
                        原生协议,openai 选项仅作标记(直连写法相同,需端点自身兼容);认证
                        字段决定 token 放 AUTH_TOKEN(Bearer 头)还是 API_KEY(x-api-key),
                        写 settings.json 时只落选中的一个键,另一键不残留。 */}
                    <div className="grid grid-cols-2 gap-2.5">
                      <Field label={t("settings.providers.fldApiFormat")}>
                        <select
                          className={inputCls}
                          value={draft.apiFormat}
                          onChange={(e) => setDraft({ ...draft, apiFormat: e.target.value })}
                        >
                          <option value="anthropic">{t("settings.providers.apiAnthropic")}</option>
                          <option value="openai">{t("settings.providers.apiOpenai")}</option>
                        </select>
                      </Field>
                      <Field label={t("settings.providers.fldAuthStyle")}>
                        <select
                          className={inputCls}
                          value={draft.authStyle}
                          onChange={(e) => setDraft({ ...draft, authStyle: e.target.value })}
                        >
                          <option value="auth_token">{t("settings.providers.authAuthToken")}</option>
                          <option value="api_key">{t("settings.providers.authApiKey")}</option>
                        </select>
                      </Field>
                    </div>
                    <div className="text-[10px] leading-relaxed text-[var(--mx-faint)]">
                      {t("settings.providers.claudeApiFormatHint")}
                    </div>
                    {/* 模型映射(结构化四档,对齐 cc-switch):上游模型(_MODEL)+ 界面显示名
                        (_NAME)逐档可配;值与 extraEnv 同源(存储 schema 不变,与「从当前
                        导入」/cc-switch 手改 settings.json 的数据互通)。 */}
                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">
                          {t("settings.providers.mappingSection")}
                        </span>
                        {/* 一键设置:把模型字段当前值铺到四档(中转供应商通常要求全部指向
                            同一模型,手敲 8 个键极易漏)。 */}
                        <Button
                          size="xs"
                          variant="accent"
                          disabled={!draft.model.trim()}
                          title={t("settings.providers.quickSetupHint")}
                          onClick={handleQuickSetup}
                        >
                          ⚡ {t("settings.providers.quickSetup")}
                        </Button>
                      </div>
                      <div className="space-y-1">
                        {MODEL_TIERS.map((tier) => (
                          <MappingRow
                            key={tier}
                            tier={tier}
                            model={draft.extraEnv[`ANTHROPIC_DEFAULT_${tier}_MODEL`] ?? ""}
                            display={draft.extraEnv[`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`] ?? ""}
                            onModel={(v) => setTierEnv(tier, "model", v)}
                            onDisplay={(v) => setTierEnv(tier, "display", v)}
                          />
                        ))}
                      </div>
                      <div className="mt-1 truncate text-[10px] text-[var(--mx-faint)]">
                        {quickSetupMsg ?? t("settings.providers.quickSetupHint")}
                      </div>
                    </div>
                    {/* 其余 env(四档映射键已上收进映射区,裸行区不再重复出现)。 */}
                    <div className="text-[10px] leading-relaxed text-[var(--mx-faint)]">
                      {t("settings.providers.advancedEnvHint")}
                    </div>
                    <EnvRows
                      value={splitTierEnv(draft.extraEnv).rest}
                      onChange={(rest) => setDraft({ ...draft, extraEnv: { ...pickTierEnv(draft.extraEnv), ...rest } })}
                      addLabel={t("settings.providers.addEnvRow")}
                    />
                  </div>
                )}
              </div>
            )}

            {kind === "codex" && (
              <div className="rounded-[var(--mx-radius-md)] border border-[var(--mx-border)]">
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wide text-[var(--mx-faint)] hover:text-[var(--mx-muted)]"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  <span aria-hidden>{showAdvanced ? "▾" : "▸"}</span>
                  {t("settings.providers.advancedSection")}
                </button>
                {showAdvanced && (
                  <div className="space-y-1.5 border-t border-[var(--mx-border)] px-2.5 py-2">
                    {/* 上游接口格式(wire_api):responses 是 OpenAI Responses API(现主流中转
                        支持);chat 走 /v1/chat/completions(旧式 OpenAI 兼容端点)。认证无
                        字段概念:恒为 config.toml 段 experimental_bearer_token(2026-11-04
                        用户定调,cc-switch 式 auth.json 形态不在 UI 暴露)。 */}
                    <div className="grid grid-cols-2 gap-2.5">
                      <Field label={t("settings.providers.fldWireApi")}>
                        <select
                          className={inputCls}
                          value={draft.wireApi}
                          onChange={(e) => setDraft({ ...draft, wireApi: e.target.value })}
                        >
                          <option value="responses">{t("settings.providers.wireResponses")}</option>
                          <option value="chat">{t("settings.providers.wireChat")}</option>
                        </select>
                      </Field>
                    </div>
                    <div className="text-[10px] leading-relaxed text-[var(--mx-faint)]">
                      {t("settings.providers.advancedCodexHint")}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="rounded-[var(--mx-radius-md)] border border-[var(--mx-border)]">
              <button
                type="button"
                className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wide text-[var(--mx-faint)] hover:text-[var(--mx-muted)]"
                onClick={() => setShowPreview(!showPreview)}
              >
                <span aria-hidden>{showPreview ? "▾" : "▸"}</span>
                {t("settings.providers.previewSection")}
              </button>
              {showPreview && (
                <div className="border-t border-[var(--mx-border)] px-2.5 py-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] leading-relaxed text-[var(--mx-faint)]">
                      {t("settings.providers.previewHint")}
                    </span>
                    <CopyButton text={previewText} t={t} />
                  </div>
                  <pre className="max-h-44 overflow-auto rounded-[var(--mx-radius-sm)] bg-[var(--mx-surface-2)] p-2 font-mono text-[10px] leading-relaxed text-[var(--mx-muted)]">
                    {previewText}
                  </pre>
                </div>
              )}
            </div>

          </div>

      {/* 底部固定操作行:应用失败就地报错(留在表单可改),保存/应用成功都返回列表。 */}
      <div className="flex items-center gap-1.5 border-t border-[var(--mx-border)] pt-2">
        <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--mx-danger)]" title={applyError ?? undefined}>
          {applyError}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={!draft.name.trim() || applyingId != null}
          title={t("settings.providers.applyNowHint")}
          onClick={() => void handleApplyDraft()}
        >
          {applyingId ? t("settings.providers.applying") : t("settings.providers.applyNow")}
        </Button>
        <Button size="xs" disabled={!draft.name.trim()} onClick={handleSaveDraft}>
          {t("common.save")}
        </Button>
      </div>
    </div>
  );

}

/** 高级区窄输入(键值行 / 模型映射行共用)。 */
const envCellCls =
  "w-full min-w-0 rounded-[var(--mx-radius-sm)] border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--mx-text)] outline-none focus-visible:border-[var(--mx-accent)]";

/** 模型映射行(cc-switch 形态,模块顶层定义——IME 教训同 Field):档位 + 上游模型
 *  (ANTHROPIC_DEFAULT_*_MODEL,带 1M 开关)+ 界面显示名(*_MODEL_NAME)。 */
function MappingRow({
  tier,
  model,
  display,
  onModel,
  onDisplay,
}: {
  tier: string;
  model: string;
  display: string;
  onModel: (v: string) => void;
  onDisplay: (v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1">
      <span className="w-11 shrink-0 text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">{tier}</span>
      <input
        className={`${envCellCls} min-w-0 flex-1`}
        value={model}
        placeholder={t("settings.providers.mappingModel")}
        spellCheck={false}
        onChange={(e) => onModel(e.target.value)}
      />
      <label
        className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-[10px] text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)]"
        title={t("settings.providers.model1MHint")}
      >
        <input
          type="checkbox"
          checked={/\[1M\]$/i.test(model)}
          disabled={!model.trim()}
          onChange={() => onModel(/\[1M\]$/i.test(model) ? model.replace(/\[1M\]$/i, "").trim() : `${model}[1M]`)}
          className="h-3 w-3 accent-[var(--mx-accent)]"
        />
        1M
      </label>
      <input
        className={`${envCellCls} min-w-0 flex-1`}
        value={display}
        placeholder={t("settings.providers.mappingDisplay")}
        spellCheck={false}
        onChange={(e) => onDisplay(e.target.value)}
      />
    </div>
  );
}

/** extraEnv 键值行编辑(高级配置):每行 key/value + 删除,底部「+ 添加变量」。 */
function EnvRows({
  value,
  onChange,
  addLabel,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  addLabel: string;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(value);
  return (
    <div className="space-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1">
          <input
            className={`${envCellCls} shrink-0 basis-[48%]`}
            value={k}
            spellCheck={false}
            onChange={(e) => {
              const next: Record<string, string> = {};
              for (const [ek, ev] of entries) next[ek === k ? e.target.value : ek] = ev;
              onChange(next);
            }}
          />
          <input
            className={`${envCellCls} min-w-0 flex-1`}
            value={v}
            spellCheck={false}
            onChange={(e) => onChange({ ...value, [k]: e.target.value })}
          />
          {/* 每行都带 1M 开关(用户 2026-10-30:高级模型设置里每个都要能勾):追加/去掉该行
              值尾部 [1M] 标记;非模型键勾不勾由用户自己定,值空置灰。 */}
          <label
            className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-[10px] text-[var(--mx-muted)] transition-colors hover:text-[var(--mx-text)]"
            title={t("settings.providers.model1MHint")}
          >
            <input
              type="checkbox"
              checked={/\[1M\]$/i.test(v)}
              disabled={!v.trim()}
              onChange={() =>
                onChange({ ...value, [k]: /\[1M\]$/i.test(v) ? v.replace(/\[1M\]$/i, "").trim() : `${v}[1M]` })
              }
              className="h-3 w-3 accent-[var(--mx-accent)]"
            />
            1M
          </label>
          <button
            type="button"
            aria-label={`remove ${k}`}
            className="shrink-0 px-1 text-[11px] text-[var(--mx-faint)] hover:text-[var(--mx-danger)]"
            onClick={() => {
              const next = { ...value };
              delete next[k];
              onChange(next);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-[10px] text-[var(--mx-accent-bright)] hover:underline"
        onClick={() => onChange({ ...value, "": "" })}
      >
        + {addLabel}
      </button>
    </div>
  );
}
