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

/** 编辑表单投影(两 kind 字段并集;按 kind 决定哪些输入框渲染/保存哪些字段)。 */
type Draft = {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  model: string;
  /** codex: model_reasoning_effort(空 = 保留 config.toml 现值)。 */
  reasoningEffort: string;
  /** claude: 其余 env 键(编辑已有条目保住,新增为空)。 */
  extraEnv: Record<string, string>;
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

/** 端点探测结果(Rust probe_provider_endpoint 镜像)。 */
type ProbeResult = { latencyMs: number; status: number; models: string[]; error: string | null };

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

/** 与 claudeProviders.providerEnv 同拼装逻辑(配置预览用;空 token/模型省键的语义一致)。 */
function draftEnvJson(draft: Draft): string {
  const env: Record<string, string> = { ...draft.extraEnv };
  if (draft.baseUrl.trim()) env.ANTHROPIC_BASE_URL = draft.baseUrl.trim();
  if (draft.token.trim()) env.ANTHROPIC_AUTH_TOKEN = draft.token.trim();
  if (draft.model.trim()) env.ANTHROPIC_MODEL = draft.model.trim();
  return JSON.stringify(env, null, 2);
}

/** 与后端 apply_codex_provider 的段写法对齐(config.toml provider 段预览)。 */
function draftToml(draft: Draft): string {
  const name = draft.name.trim() || "(名称)";
  const lines = [
    `# ~/.codex/config.toml(provider 段;mcp_servers 等其余部分原样保留)`,
    `model_provider = "custom"`,
    draft.model.trim() ? `model = "${draft.model.trim()}"` : `# model = (保留现值)`,
    draft.reasoningEffort.trim() ? `model_reasoning_effort = "${draft.reasoningEffort.trim()}"` : `# model_reasoning_effort = (保留现值)`,
    ``,
    `[model_providers.custom]`,
    `name = "${name}"`,
    `base_url = "${draft.baseUrl.trim() || "(未填)"}"`,
    `wire_api = "responses"`,
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
    const draftFrom: Draft = { id: raw.id, name: raw.name, baseUrl: raw.baseUrl, token: raw.token, model: raw.model, reasoningEffort: "", extraEnv: {} };
    if (adapter.kind === "claude") {
      draftFrom.extraEnv = (raw as ClaudeProvider).extraEnv;
    } else {
      draftFrom.reasoningEffort = (raw as CodexProvider).reasoningEffort;
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
    const prev = providers.find((p) => p.id === draft.id);
    const base: Draft = { ...draft, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), token: draft.token.trim(), model: draft.model.trim(), reasoningEffort: draft.reasoningEffort.trim() };
    return adapter.kind === "claude"
      ? { id: draft.id || newProviderId(), name: base.name, baseUrl: base.baseUrl, token: base.token, model: base.model, extraEnv: draft.extraEnv }
      : { id: draft.id || newCodexProviderId(), name: base.name, baseUrl: base.baseUrl, token: base.token, model: base.model, reasoningEffort: draft.id && prev ? (prev as CodexProvider).reasoningEffort : base.reasoningEffort };
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

  /** 「应用」= 保存 + 立即生效:写盘 + 广播(活跃会话重启拾取新配置),表单保持打开
   *  (previous 只有列表 hover ▶ 能生效,用户得先保存再回列表找,多一步且易漏)。 */
  const handleApplyDraft = async () => {
    const next = draftToProvider();
    if (!next) return;
    upsertProvider(next);
    const ok = await applyOne(next);
    if (ok) setDraft({ ...draft!, id: next.id });
  };

  const emptyDraft = (): Draft => ({ id: "", name: "", baseUrl: "", token: "", model: "", reasoningEffort: "", extraEnv: {} });

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

  const inputCls =
    "w-full rounded-[var(--mx-radius-md)] border border-[var(--mx-border-strong)] bg-[var(--mx-surface-2)] px-2 py-1 text-[12px] text-[var(--mx-text)] outline-none transition-colors placeholder:text-[var(--mx-faint)] focus-visible:border-[var(--mx-accent)] focus-visible:ring-1 focus-visible:ring-[var(--mx-accent)]";

  /** 表单字段:label + 输入(label 化,比纯 placeholder 可扫读)。 */
  const Field = ({ label, children }: { label: string; children: ReactNode }) => (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">{label}</span>
      {children}
    </label>
  );

  const previewText = draft ? (kind === "claude" ? draftEnvJson(draft) : draftToml(draft)) : "";
  /** 拉取到的模型目录(没拉过/失败为空数组;下拉只在这个非空时可用)。 */
  const fetchedModels = probe.phase === "done" ? probe.result.models : [];

  return (
    <div className="grid max-h-[520px] grid-cols-[240px_1fr] gap-3">
      {/* 左栏:当前生效摘要 + 列表(master;点行选中进右栏编辑,hover 出现「启用」)。 */}
      <div className="flex min-h-0 flex-col">
        <div className="mb-2 rounded-[var(--mx-radius-md)] border border-[var(--mx-accent)]/30 bg-[var(--mx-card-inner)] px-2.5 py-1.5">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--mx-accent)] shadow-[0_0_4px_var(--mx-accent)]" />
            {t("settings.providers.currentTitle")}
          </div>
          {current ? (
            <div className="space-y-0.5 truncate font-mono text-[10px] text-[var(--mx-muted)]" title={`${summary.baseUrl}\n${summary.model}`}>
              <div className="truncate">{summary.baseUrl || "—"}</div>
              <div className="truncate">{summary.model || "—"}</div>
            </div>
          ) : (
            <div className="text-[10px] text-[var(--mx-faint)]">{t("settings.providers.currentUnknown")}</div>
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
            const selected = draft?.id === row.draft.id && (draft?.id !== "" || draft != null);
            return (
              <div
                key={row.draft.id}
                role="button"
                tabIndex={0}
                onClick={() => openDraft({ ...row.draft })}
                onKeyDown={(e) => e.key === "Enter" && openDraft({ ...row.draft })}
                className={`group cursor-pointer rounded-[var(--mx-radius-md)] border px-2.5 py-1.5 transition-colors ${
                  selected
                    ? "border-[var(--mx-accent)]/60 bg-[var(--mx-accent-soft)]/40"
                    : "border-[var(--mx-border)] bg-[var(--mx-card-inner)] hover:border-[var(--mx-border-strong)]"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {row.active && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mx-accent-bright)] shadow-[0_0_4px_var(--mx-accent)]" />}
                  <span className={`min-w-0 truncate text-[12px] font-medium ${row.active ? "text-[var(--mx-text)]" : "text-[var(--mx-text)]"}`}>{row.draft.name}</span>
                  {!row.active && (
                    <button
                      type="button"
                      title={t("settings.providers.apply")}
                      aria-label={t("settings.providers.apply")}
                      disabled={applyingId === row.draft.id}
                      className="ml-auto hidden shrink-0 rounded-[4px] px-1 py-0.5 text-[10px] text-[var(--mx-accent-bright)] hover:bg-[var(--mx-accent-soft)] group-hover:block"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleApply(row);
                      }}
                    >
                      {applyingId === row.draft.id ? "…" : "▶"}
                    </button>
                  )}
                  {row.active && (
                    <span className="ml-auto shrink-0 rounded-full bg-[var(--mx-accent-soft)] px-1.5 py-px text-[9px] font-medium text-[var(--mx-accent-bright)]">
                      {t("settings.providers.activeBadge")}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--mx-faint)]" title={`${row.draft.baseUrl}${row.draft.model ? ` · ${row.draft.model}` : ""}`}>
                  {row.draft.model || row.draft.baseUrl || "—"}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-2 text-[10px] leading-relaxed text-[var(--mx-faint)]">
          {t(kind === "claude" ? "settings.providers.hint" : "settings.providers.hintCodex")}
        </div>
      </div>

      {/* 右栏:详情(detail;选中项编辑表单或空态)。原「列表顶部插入卡片」改双栏,
          编辑不再把列表顶下去,点哪条看哪条(cc-switch 弹窗编辑的 IDE 化替代)。 */}
      <div className="min-h-0 overflow-y-auto pr-0.5">
        {draft ? (
          <div className="space-y-2 rounded-[var(--mx-radius-md)] border border-[var(--mx-accent)]/50 bg-[var(--mx-card-inner)] p-3 shadow-[0_0_12px_rgba(0,0,0,0.12)]">
            {/* 顶部行:名称回显 + 删除(编辑已有条目时)。 */}
            <div className="flex items-center gap-2 border-b border-[var(--mx-border)] pb-2">
              <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--mx-text)]">
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

            <Field label={t("settings.providers.presetLabel")}>
              <div className="flex items-center gap-1.5">
                <select
                  className={`${inputCls} flex-1`}
                  value=""
                  onChange={(e) => {
                    const preset = allPresets.find((p) => p.name === e.target.value);
                    if (preset) {
                      setDraft({
                        ...draft,
                        name: draft.name.trim() || preset.name,
                        baseUrl: preset.baseUrl,
                        model: draft.model.trim() || preset.model || "",
                      });
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

            <Field label={t("settings.providers.fldName")}>
              <input
                className={inputCls}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                autoFocus
              />
            </Field>

            <Field label={t("settings.providers.fldBaseUrl")}>
              <input
                className={`${inputCls} font-mono`}
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              />
            </Field>

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

            <Field label={t("settings.providers.fldModel")}>
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
            </Field>
            {probe.phase === "done" && (
              <div className="-mt-1 text-[10px] text-[var(--mx-faint)]">
                {probe.result.models.length > 0
                  ? t("settings.providers.probeSummary", { count: probe.result.models.length, ms: probe.result.latencyMs, status: probe.result.status })
                  : t("settings.providers.probeEmpty", { ms: probe.result.latencyMs })}
              </div>
            )}
            {probe.phase === "error" && (
              <div className="-mt-1 text-[10px] break-all text-[var(--mx-danger)]">{probe.message}</div>
            )}

            {kind === "codex" && (
              <Field label={t("settings.providers.fldEffort")}>
                <input
                  className={`${inputCls} font-mono`}
                  value={draft.reasoningEffort}
                  onChange={(e) => setDraft({ ...draft, reasoningEffort: e.target.value })}
                />
              </Field>
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
                  <div className="space-y-1.5 border-t border-[var(--mx-border)] px-2.5 py-2">
                    <div className="text-[10px] leading-relaxed text-[var(--mx-faint)]">
                      {t("settings.providers.advancedEnvHint")}
                    </div>
                    {/* 一键设置:把模型字段当前值铺到默认档 + Opus/Sonnet/Haiku/Fable 各档别名
                        (中转供应商通常要求全部指向同一模型,手敲 8~9 个键极易漏)。 */}
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="xs"
                        variant="accent"
                        disabled={!draft.model.trim()}
                        title={t("settings.providers.quickSetupHint")}
                        onClick={handleQuickSetup}
                      >
                        ⚡ {t("settings.providers.quickSetup")}
                      </Button>
                      <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--mx-faint)]">
                        {quickSetupMsg ?? t("settings.providers.quickSetupHint")}
                      </span>
                    </div>
                    <EnvRows
                      value={draft.extraEnv}
                      onChange={(extraEnv) => setDraft({ ...draft, extraEnv })}
                      addLabel={t("settings.providers.addEnvRow")}
                    />
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

            <div className="flex justify-end gap-1.5 border-t border-[var(--mx-border)] pt-2">
              <Button size="xs" variant="outline" onClick={closeDraft}>
                {t("common.cancel")}
              </Button>
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
        ) : (
          <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-1.5 rounded-[var(--mx-radius-md)] border border-dashed border-[var(--mx-border-strong)] text-center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--mx-faint)]" aria-hidden>
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M12 4v16" />
              <path d="M8 10h.01M8 14h.01" />
            </svg>
            <div className="text-[11px] text-[var(--mx-faint)]">{t("settings.providers.pickToEdit")}</div>
          </div>
        )}
      </div>
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
  const cellCls =
    "w-full min-w-0 rounded-[var(--mx-radius-sm)] border border-[var(--mx-border)] bg-[var(--mx-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--mx-text)] outline-none focus-visible:border-[var(--mx-accent)]";
  return (
    <div className="space-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1">
          <input
            className={`${cellCls} shrink-0 basis-[48%]`}
            value={k}
            spellCheck={false}
            onChange={(e) => {
              const next: Record<string, string> = {};
              for (const [ek, ev] of entries) next[ek === k ? e.target.value : ek] = ev;
              onChange(next);
            }}
          />
          <input
            className={`${cellCls} min-w-0 flex-1`}
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
