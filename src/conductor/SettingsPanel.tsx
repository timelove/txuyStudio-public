/**
 * SettingsPanel —— Conductor 设置分区(P1)。总闸 / 大脑(独立端点配置)/ 占用锁 /
 * token 预算 / 工具代批,统一「保存」走 conductor_config_set(patch);大脑健康态 +
 * 手动触发测试。v2(2026-11-16 重组):并入「长期记忆」折叠区(MemoryPanel 撤编,
 * 候选确认走右栏动态卡,这里只留低频管理:列表/确认/删除/手填/导入)。
 *
 * 大脑端点**独立配置**(2026-11-13 用户拍板,反转 2026-11-12 的「复用 claude 供应商」):
 * baseUrl + token 手填 →「拉取模型」调 conductor_brain_probe(未保存的 url/token 也能试)
 * → 模型目录多选,**勾选顺序即兜底链顺序**(第一个不支持/异常自动降级下一个,全挂才失败)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type {
  BrainProbeResult,
  ConductorConfigPatch,
  ConductorConfigView,
  MemoryEntry,
} from "../domain/conductor";
import { relativeTime } from "./ui";

/** 权限分级编辑器表单类型(P2b):与 ConductorConfigPatch.permissionRules 同构。 */
type RuleLevel = "auto" | "confirm" | "deny";
type PermissionRulesEdit = {
  tools: { tool: string; level: RuleLevel }[];
  bash: { pattern: string; level: RuleLevel }[];
};

export function SettingsPanel({
  memories,
  projects,
  onChanged,
}: {
  memories: MemoryEntry[];
  projects: { id: string; name: string }[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<ConductorConfigView | null>(null);
  const [gate, setGate] = useState(false);
  /** 大脑端点表单(url/token/协议):token 空串 = 不修改已保存值(后端同口径)。 */
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [apiFormat, setApiFormat] = useState("anthropic");
  /** 模型兜底链(勾选顺序有序)。 */
  const [models, setModels] = useState<string[]>([]);
  /** 探测拉回的模型目录(未保存的候选池)。 */
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [lockMinutes, setLockMinutes] = useState(10);
  /** 建议静默窗(分钟,2026-11-17 与占用锁拆分):触达在窗内的会话终态不出
   *  常规建议卡。占用锁管自动塞话(硬闸),本值只管出卡噪音(软闸),0 = 不静默。 */
  const [quietMinutes, setQuietMinutes] = useState(3);
  const [budget, setBudget] = useState(4000);
  const [autoApprove, setAutoApprove] = useState(true);
  /** auto 级代批宽限毫秒(2026-11-17「先弹卡再自动选」):0 = 立即放行不弹卡。 */
  const [autoApproveDelay, setAutoApproveDelay] = useState(5000);
  /** 权限分级自定义表(P2b):tools=工具名精确匹配,bash=命令小写 contains。
   *  判定顺序:bash 规则先于工具规则(自定义 → 内置),未命中回落 confirm。 */
  const [rules, setRules] = useState<PermissionRulesEdit>({ tools: [], bash: [] });
  /** 建议自动执行(大脑自主产出直接代发,30min/目标冷静窗)。 */
  const [autoExecute, setAutoExecute] = useState(true);
  /** 孵化流水线(P4a):计划 finished 自动领取孵化下一条(默认关)。 */
  const [pipeline, setPipeline] = useState(false);
  /** 投递占用排队(2026-11-17):被占用锁全拦 → 排队等空闲终态自动补投(默认开)。 */
  const [queueWhenOccupied, setQueueWhenOccupied] = useState(true);
  /** 项目建议白名单(2026-11-23):列内项目才出常规建议,默认空 = 全安静。 */
  const [suggestOn, setSuggestOn] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** 设置分页(2026-11-16 用户:「设置里面搞2个,一个通用,一个记忆」)。 */
  const [tab, setTab] = useState<"general" | "memory">("general");
  /** prompt 技艺文件路径(kind → 绝对路径;打开/重置后回填,悬浮展示方便自己找文件)。 */
  const [promptPaths, setPromptPaths] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const v = await invoke<ConductorConfigView>("conductor_config_get");
      setView(v);
      setGate(v.config.allowOrchestrator);
      setBaseUrl(v.config.brainBaseUrl);
      setToken(""); // 回显脱敏摘要占位,不写回
      setApiFormat(v.config.brainApiFormat);
      setModels(v.config.brainModels);
      setLockMinutes(v.config.occupiedLockMinutes);
      setQuietMinutes(v.config.suggestQuietMinutes ?? 3);
      setBudget(v.config.perCycleTokenBudget);
      setAutoApprove(v.config.autoApproveTools);
      setAutoApproveDelay(v.config.autoApproveDelayMs ?? 0);
      setRules(
        v.config.permissionRules ?? { tools: [], bash: [] },
      );
      setAutoExecute(v.config.autoExecuteSuggestions);
      setPipeline(v.config.pipeline ?? false);
      setQueueWhenOccupied(v.config.queueWhenOccupied ?? true);
      setSuggestOn(v.config.suggestProjects ?? []);
    } catch (e) {
      setMessage(String(e).replace(/^Error\b:?\s*/i, ""));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 拉取模型目录(url/token 取表单当前值——未保存也能试)。 */
  const probe = async () => {
    if (probing) return;
    setProbing(true);
    setProbeError(null);
    try {
      const r = await invoke<BrainProbeResult>("conductor_brain_probe", {
        baseUrl,
        token: token.trim() || null,
      });
      if (r.error) {
        setProbeError(`${t("conductor.settings.probeFailed")} ${r.error}`);
        setCatalog(null);
      } else {
        setCatalog(r.models);
        setProbeError(null);
      }
    } catch (e) {
      setProbeError(String(e).replace(/^Error\b:?\s*/i, ""));
      setCatalog(null);
    } finally {
      setProbing(false);
    }
  };

  /** 切换某模型的勾选:勾上追加到链尾,取消从链中移除(顺序=兜底优先级)。 */
  const toggleModel = (m: string) => {
    setModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  };
  /** 链内上移一位(提高兜底优先级)。 */
  const moveUp = (idx: number) => {
    if (idx <= 0) return;
    setModels((prev) => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  };

  /** 权限分级表行编辑(P2b):改值/改级;删行用行内 ✕。 */
  const setRuleTool = (i: number, patch: Partial<{ tool: string; level: RuleLevel }>) =>
    setRules((prev) => ({
      ...prev,
      tools: prev.tools.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));
  const setRuleBash = (i: number, patch: Partial<{ pattern: string; level: RuleLevel }>) =>
    setRules((prev) => ({
      ...prev,
      bash: prev.bash.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));

  /** 模型候选项:探测目录 ∪ 已选链(探测失败时保住已选项可见)。 */
  const modelOptions = useMemo(() => {
    const set = new Set<string>(catalog ?? []);
    for (const m of models) set.add(m);
    return [...set].sort();
  }, [catalog, models]);

  const dirty =
    view !== null &&
    (gate !== view.config.allowOrchestrator ||
      baseUrl !== view.config.brainBaseUrl ||
      token !== "" ||
      apiFormat !== view.config.brainApiFormat ||
      models.join(",") !== view.config.brainModels.join(",") ||
      lockMinutes !== view.config.occupiedLockMinutes ||
      quietMinutes !== (view.config.suggestQuietMinutes ?? 3) ||
      budget !== view.config.perCycleTokenBudget ||
      autoApprove !== view.config.autoApproveTools ||
      autoApproveDelay !== (view.config.autoApproveDelayMs ?? 0) ||
      pipeline !== (view.config.pipeline ?? false) ||
      queueWhenOccupied !== (view.config.queueWhenOccupied ?? true) ||
      JSON.stringify(rules) !== JSON.stringify(view.config.permissionRules ?? { tools: [], bash: [] }) ||
      autoExecute !== view.config.autoExecuteSuggestions);

  const save = async () => {
    if (saving || view === null) return;
    setSaving(true);
    setMessage(null);
    try {
      const patch: ConductorConfigPatch = {
        allowOrchestrator: gate,
        brainBaseUrl: baseUrl,
        // token 空串 = 不改已存值;非空才下发(后端拦脱敏摘要前缀)。
        brainApiKey: token.trim() || null,
        brainModels: models,
        brainApiFormat: apiFormat,
        occupiedLockMinutes: lockMinutes,
        // clamp 0..240 与后端口径一致(0 = 不静默)。
        suggestQuietMinutes: Math.max(0, Math.min(240, Math.round(quietMinutes) || 0)),
        perCycleTokenBudget: budget,
        autoApproveTools: autoApprove,
        // 毫秒数 clamp 0..120000 与后端口径一致(负数/非法输入归 0 = 立即放行)。
        autoApproveDelayMs: Math.max(0, Math.min(120_000, Math.round(autoApproveDelay) || 0)),
        permissionRules: rules,
        autoExecuteSuggestions: autoExecute,
        pipeline,
        queueWhenOccupied,
      };
      await invoke("conductor_config_set", { patch });
      setSavedAt(Date.now());
      await load();
      onChanged();
    } catch (e) {
      setMessage(String(e).replace(/^Error\b:?\s*/i, ""));
    } finally {
      setSaving(false);
    }
  };

  const testBrain = async () => {
    if (testing) return;
    setTesting(true);
    setMessage(null);
    try {
      // 后端同步等待 auto_suggest 的结果并回传真实 outcome(2026-11-16:修按钮假成功)。
      const r = await invoke<{ triggered: boolean; message?: string }>("conductor_suggest_now", {});
      setMessage(r.message || t("conductor.settings.triggered"));
      onChanged();
    } catch (e) {
      setMessage(String(e).replace(/^Error\b:?\s*/i, ""));
    } finally {
      setTesting(false);
    }
  };

  /** prompt 技艺文件(2026-11-18 用户:「拆步单独变成一个 skill,能按个人喜好编辑」):
   *  打开 = 系统默认编辑器(不存在先播种内置默认);重置 = 覆盖写回内置默认。
   *  改完保存下一次拆步/验收即生效(后端现场读取,不缓存)。 */
  const openPrompt = async (kind: "planSteps" | "verifyTask") => {
    try {
      const path = await invoke<string>("conductor_prompt_open", { kind });
      setPromptPaths((p) => ({ ...p, [kind]: path }));
    } catch (e) {
      setMessage(String(e).replace(/^Error\b:?\s*/i, ""));
    }
  };
  const resetPrompt = async (kind: "planSteps" | "verifyTask") => {
    try {
      const path = await invoke<string>("conductor_prompt_reset", { kind });
      setPromptPaths((p) => ({ ...p, [kind]: path }));
      setMessage(t("conductor.settings.promptResetDone"));
    } catch (e) {
      setMessage(String(e).replace(/^Error\b:?\s*/i, ""));
    }
  };

  /** 项目参与开关(2026-11-16):即点即生效(独立命令落盘,不走 dirty/save 流程)。
   *  enable = 勾上(参与);取消 = 静音,该项目的会话事件不再进感知链。 */
  const toggleMute = async (projectId: string, enable: boolean) => {
    try {
      await invoke("conductor_project_mute", { projectId, muted: !enable });
      await load();
      onChanged();
    } catch (e) {
      setMessage(String(e).replace(/^Error\b:?\s*/i, ""));
    }
  };

  /** 项目建议开关(2026-11-23 用户:「不要动不动就给建议」):白名单口径,即点即生效
   *  (config patch 落盘,不走 dirty/save)。enable = 加入白名单(该项目允许出常规
   *  建议);取消 = 安静(感知链照常,副官只是不说话)。 */
  const toggleSuggest = async (projectId: string, enable: boolean) => {
    const next = enable
      ? [...suggestOn, projectId]
      : suggestOn.filter((p) => p !== projectId);
    try {
      await invoke("conductor_config_set", { patch: { suggestProjects: next } });
      setSuggestOn(next);
      onChanged();
    } catch (e) {
      setMessage(String(e).replace(/^Error\b:?\s*/i, ""));
    }
  };

  const degraded = view?.brainDegraded ?? false;
  const selectCls =
    "mx-chip h-8 min-w-0 flex-1 cursor-pointer bg-[var(--mx-hover-bg)] px-1.5 text-xs text-[var(--mx-text)] outline-none focus:ring-1 focus:ring-[var(--mx-accent)]";
  const inputCls =
    "mx-chip h-8 min-w-0 flex-1 bg-[var(--mx-hover-bg)] px-2 text-xs text-[var(--mx-text)] outline-none focus:ring-1 focus:ring-[var(--mx-accent)]";

  return (
    <div className="h-full min-h-0 overflow-y-auto px-0.5">
      <div className="flex flex-col gap-3 pb-4">
        {/* 分页行(通用 / 记忆):消息条与保存按钮两页共用,留在 tab 外。 */}
        <div className="flex items-center gap-1">
          {(["general", "memory"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`mx-chip cursor-pointer px-3 py-1 text-xs ${
                tab === key
                  ? "bg-[var(--mx-accent-soft)] font-medium text-[var(--mx-accent)]"
                  : "bg-[var(--mx-hover-bg)] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
              }`}
            >
              {t(`conductor.settings.tab.${key}`)}
            </button>
          ))}
        </div>
        {tab === "general" ? (
          <>
        {/* 总闸。 */}
        <section className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--mx-text)]">
            <input
              type="checkbox"
              checked={gate}
              onChange={(e) => setGate(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--mx-accent)]"
            />
            <span className="font-medium">{t("conductor.settings.gate")}</span>
            <span className="text-[var(--mx-muted)]">{t("conductor.settings.gateHint")}</span>
          </label>
        </section>

        {/* 大脑:独立端点(url + key + 模型多选兜底链)。 */}
        <section className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-[var(--mx-text)]">{t("conductor.settings.brainSection")}</div>
          <div className="text-[11px] leading-snug text-[var(--mx-muted)]">
            {t("conductor.settings.independentHint")}
          </div>
          <Field label={t("conductor.settings.baseUrl")}>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className={inputCls}
            />
          </Field>
          <Field label={t("conductor.settings.token")}>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={view?.config.brainApiKeySet ? view.config.brainApiKeyMasked : "sk-..."}
              className={inputCls}
            />
          </Field>
          <Field label={t("conductor.settings.apiFormat")} hint={t("conductor.settings.apiFormatHint")}>
            <select
              value={apiFormat}
              onChange={(e) => setApiFormat(e.target.value)}
              className={`${selectCls} w-40`}
            >
              <option value="anthropic">{t("conductor.settings.apiFormatAnthropic")}</option>
              <option value="openai">{t("conductor.settings.apiFormatOpenai")}</option>
            </select>
          </Field>
          {/* 拉模型 + 多选(勾选顺序=兜底链顺序)。 */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={probing || !baseUrl.trim()}
              onClick={() => void probe()}
              className="mx-chip h-8 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-3 text-xs text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
            >
              {probing ? t("conductor.settings.probing") : t("conductor.settings.probeModels")}
            </button>
            {catalog && (
              <span className="text-[11px] text-[var(--mx-muted)]">
                {t("conductor.settings.probedCount", { n: catalog.length })}
              </span>
            )}
          </div>
          {probeError && (
            <div className="mx-chip bg-[#ef44441a] px-2.5 py-1.5 text-xs text-[#ef4444]">
              <span className="min-w-0 break-all">{probeError}</span>
            </div>
          )}
          <Field label={t("conductor.settings.models")} hint={t("conductor.settings.modelsHint")}>
            <div className="mx-scroll-pretty max-h-40 min-w-0 flex-1 overflow-y-auto rounded-[var(--mx-radius)] bg-[var(--mx-hover-bg)] p-1.5">
              {modelOptions.length === 0 ? (
                <div className="px-1 py-2 text-[11px] text-[var(--mx-muted)]">
                  {t("conductor.settings.modelsEmpty")}
                </div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {modelOptions.map((m) => {
                    const idx = models.indexOf(m);
                    const checked = idx >= 0;
                    return (
                      <label
                        key={m}
                        className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-[var(--mx-surface-soft)]"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleModel(m)}
                          className="h-3.5 w-3.5 shrink-0 accent-[var(--mx-accent)]"
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[var(--mx-text)]">{m}</span>
                        {checked && (
                          <span className="flex shrink-0 items-center gap-0.5">
                            <span className="w-5 text-center text-[10px] text-[var(--mx-muted)] tabular-nums">
                              {idx + 1}
                            </span>
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveUp(idx)}
                              className="cursor-pointer text-[10px] text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-30"
                              aria-label={t("conductor.settings.moveUp")}
                            >
                              ↑
                            </button>
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </Field>
          {models.length > 1 && (
            <div className="text-[11px] leading-snug text-[var(--mx-muted)]">
              {t("conductor.settings.fallbackChain", { chain: models.join(" → ") })}
            </div>
          )}
        </section>

        {/* Prompt 技艺(2026-11-18 用户:「拆步单独变成一个 skill,后续按个人喜好编辑」):
            拆步/验收 system prompt 外置 md 文件,打开即编、存盘即生效;重置 = 拉回内置默认。 */}
        <section className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-[var(--mx-text)]">{t("conductor.settings.promptSection")}</div>
          <div className="text-[11px] leading-snug text-[var(--mx-muted)]">
            {t("conductor.settings.promptHint")}
          </div>
          {(["planSteps", "verifyTask"] as const).map((kind) => (
            <div key={kind} className="flex items-center gap-1.5">
              <span className="w-28 shrink-0 text-xs text-[var(--mx-muted)]">
                {t(`conductor.settings.prompt.${kind}`)}
              </span>
              <button
                type="button"
                onClick={() => void openPrompt(kind)}
                className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[11px] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
              >
                {t("conductor.settings.promptOpen")}
              </button>
              <button
                type="button"
                onClick={() => void resetPrompt(kind)}
                className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[11px] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
              >
                {t("conductor.settings.promptReset")}
              </button>
              {promptPaths[kind] && (
                <span
                  className="min-w-0 flex-1 truncate text-[10px] text-[var(--mx-muted)] opacity-70"
                  title={promptPaths[kind]}
                >
                  {promptPaths[kind]}
                </span>
              )}
            </div>
          ))}
        </section>

        {/* 工具代批(本地规则)。 */}
        <section className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--mx-text)]">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--mx-accent)]"
            />
            <span className="font-medium">{t("conductor.settings.autoApprove")}</span>
            <span className="text-[var(--mx-muted)]">{t("conductor.settings.autoApproveHint")}</span>
          </label>
          <div className="text-[11px] leading-snug text-[var(--mx-muted)]">
            {t("conductor.settings.autoApproveDetail")}
          </div>
          {/* auto 级宽限(2026-11-17「先弹卡再自动选」):毫秒输入,0 = 立即放行不弹卡。 */}
          <label className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="font-medium">{t("conductor.settings.autoApproveDelay")}</span>
            <input
              type="number"
              min={0}
              max={120000}
              step={500}
              value={autoApproveDelay}
              onChange={(e) => setAutoApproveDelay(Number(e.target.value) || 0)}
              className="w-24 rounded border border-[var(--mx-border)] bg-[var(--mx-bg)] px-2 py-1 text-[11px] text-[var(--mx-text)]"
            />
            <span className="text-[var(--mx-muted)]">{t("conductor.settings.autoApproveDelayHint")}</span>
          </label>
          {/* 权限分级自定义表(P2b):工具名精确 / Bash 子串两类行,整表保存。
              判定顺序 bash 先于工具(自定义 → 内置),未命中回落 confirm。 */}
          <div className="mt-1 text-[11px] font-medium text-[var(--mx-text)]">
            {t("conductor.settings.rulesSection")}
          </div>
          <div className="text-[11px] leading-snug text-[var(--mx-muted)]">
            {t("conductor.settings.rulesHint")}
          </div>
          {rules.tools.map((r, i) => (
            <div key={`tool-${i}`} className="flex items-center gap-1.5">
              <input
                value={r.tool}
                onChange={(e) => setRuleTool(i, { tool: e.target.value })}
                placeholder="WebFetch"
                className={inputCls}
                aria-label={t("conductor.settings.rulesToolPlaceholder")}
              />
              <select
                value={r.level}
                onChange={(e) => setRuleTool(i, { level: e.target.value as RuleLevel })}
                className="mx-chip h-8 w-28 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-1 text-[11px] text-[var(--mx-text)] outline-none"
                aria-label="level"
              >
                {(["auto", "confirm", "deny"] as RuleLevel[]).map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {t(`conductor.settings.level.${lvl}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setRules((prev) => ({ ...prev, tools: prev.tools.filter((_, j) => j !== i) }))}
                className="shrink-0 cursor-pointer px-1 text-[var(--mx-muted)] hover:text-[#ef4444]"
                aria-label={t("conductor.memory.delete")}
              >
                ✕
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              onClick={() => setRules((prev) => ({ ...prev, tools: [...prev.tools, { tool: "", level: "confirm" }] }))}
              className="mx-chip h-7 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[11px] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
            >
              + {t("conductor.settings.rulesAddTool")}
            </button>
          </div>
          {rules.bash.map((r, i) => (
            <div key={`bash-${i}`} className="flex items-center gap-1.5">
              <input
                value={r.pattern}
                onChange={(e) => setRuleBash(i, { pattern: e.target.value })}
                placeholder="rm -rf"
                className={`${inputCls} font-mono`}
                aria-label={t("conductor.settings.rulesBashPlaceholder")}
              />
              <select
                value={r.level}
                onChange={(e) => setRuleBash(i, { level: e.target.value as RuleLevel })}
                className="mx-chip h-8 w-28 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-1 text-[11px] text-[var(--mx-text)] outline-none"
                aria-label="level"
              >
                {(["auto", "confirm", "deny"] as RuleLevel[]).map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {t(`conductor.settings.level.${lvl}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setRules((prev) => ({ ...prev, bash: prev.bash.filter((_, j) => j !== i) }))}
                className="shrink-0 cursor-pointer px-1 text-[var(--mx-muted)] hover:text-[#ef4444]"
                aria-label={t("conductor.memory.delete")}
              >
                ✕
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              onClick={() => setRules((prev) => ({ ...prev, bash: [...prev.bash, { pattern: "", level: "deny" }] }))}
              className="mx-chip h-7 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[11px] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
            >
              + {t("conductor.settings.rulesAddBash")}
            </button>
          </div>
        </section>

        {/* 建议自动执行(2026-11-16 用户:副官自主执行,不要每次手动)。 */}
        <section className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--mx-text)]">
            <input
              type="checkbox"
              checked={autoExecute}
              onChange={(e) => setAutoExecute(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--mx-accent)]"
            />
            <span className="font-medium">{t("conductor.settings.autoExecute")}</span>
            <span className="text-[var(--mx-muted)]">{t("conductor.settings.autoExecuteHint")}</span>
          </label>
          <div className="text-[11px] leading-snug text-[var(--mx-muted)]">
            {t("conductor.settings.autoExecuteDetail")}
          </div>
        </section>

        {/* 孵化流水线(P4a):接力跑完自动领下一条——「无人指挥的最后一环」。 */}
        <section className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--mx-text)]">
            <input
              type="checkbox"
              checked={pipeline}
              onChange={(e) => setPipeline(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--mx-accent)]"
            />
            <span className="font-medium">{t("conductor.settings.pipeline")}</span>
            <span className="text-[var(--mx-muted)]">{t("conductor.settings.pipelineHint")}</span>
          </label>
          <div className="text-[11px] leading-snug text-[var(--mx-muted)]">
            {t("conductor.settings.pipelineDetail")}
          </div>
        </section>

        {/* 投递占用排队(2026-11-17):被占全拦 → 排队等空闲终态自动补投。 */}
        <section className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--mx-text)]">
            <input
              type="checkbox"
              checked={queueWhenOccupied}
              onChange={(e) => setQueueWhenOccupied(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--mx-accent)]"
            />
            <span className="font-medium">{t("conductor.settings.queueWhenOccupied")}</span>
            <span className="text-[var(--mx-muted)]">{t("conductor.settings.queueWhenOccupiedHint")}</span>
          </label>
        </section>

        {/* 项目参与(2026-11-16 用户:「不是每个决策都会走指挥台,可以根据项目去配置」):
            黑名单口径——亮 = 参与(默认),暗 = 静音;flex 流式 chips,即点即生效不走保存。 */}
        <section className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-[var(--mx-text)]">{t("conductor.settings.projectsSection")}</div>
          <div className="text-[11px] leading-snug text-[var(--mx-muted)]">
            {t("conductor.settings.projectsHint")}
          </div>
          {projects.length === 0 ? (
            <div className="text-[11px] text-[var(--mx-muted)]">{t("conductor.settings.projectsEmpty")}</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {projects.map((p) => {
                const muted = view?.mutedProjects?.includes(p.id) ?? false;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => void toggleMute(p.id, muted)}
                    title={muted ? undefined : t("conductor.settings.projectMuteTitle")}
                    className={`mx-chip flex cursor-pointer items-center gap-1 px-2 py-1 text-[11px] ${
                      muted
                        ? "bg-[var(--mx-hover-bg)] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
                        : "bg-[var(--mx-accent-soft)] text-[var(--mx-accent)]"
                    }`}
                  >
                    <span className="max-w-40 truncate">{p.name}</span>
                    {muted && <span className="text-[10px] opacity-80">{t("conductor.settings.projectMuted")}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* 项目建议白名单(2026-11-23 用户:「对涌现的建议,针对项目级别加开关,不要
            动不动就给建议」):亮 = 该项目允许常规建议,暗 = 安静(默认;感知链照常,
            副官只是不说话);chips 即点即生效不走保存。 */}
        <section className="flex flex-col gap-1.5">
          <div className="text-xs font-medium text-[var(--mx-text)]">{t("conductor.settings.suggestSection")}</div>
          <div className="text-[11px] leading-snug text-[var(--mx-muted)]">
            {t("conductor.settings.suggestHint")}
          </div>
          {projects.length === 0 ? (
            <div className="text-[11px] text-[var(--mx-muted)]">{t("conductor.settings.projectsEmpty")}</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {projects.map((p) => {
                const on = suggestOn.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => void toggleSuggest(p.id, !on)}
                    title={on ? t("conductor.settings.suggestOffTitle") : t("conductor.settings.suggestOnTitle")}
                    className={`mx-chip flex cursor-pointer items-center gap-1 px-2 py-1 text-[11px] ${
                      on
                        ? "bg-[var(--mx-accent-soft)] text-[var(--mx-accent)]"
                        : "bg-[var(--mx-hover-bg)] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
                    }`}
                  >
                    <span className="max-w-40 truncate">{p.name}</span>
                    {!on && <span className="text-[10px] opacity-80">{t("conductor.settings.suggestOff")}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* 占用锁 + 预算。 */}
        <section className="flex flex-col gap-1.5">
          <Field label={t("conductor.settings.lockMinutes")} hint={t("conductor.settings.lockHint")}>
            <input
              type="number"
              min={1}
              max={240}
              value={lockMinutes}
              onChange={(e) => setLockMinutes(Math.max(1, Math.min(240, Number(e.target.value) || 1)))}
              className="mx-chip h-8 w-24 shrink-0 bg-[var(--mx-hover-bg)] px-2 text-xs tabular-nums outline-none focus:ring-1 focus:ring-[var(--mx-accent)]"
            />
          </Field>
          <Field label={t("conductor.settings.quietMinutes")} hint={t("conductor.settings.quietHint")}>
            <input
              type="number"
              min={0}
              max={240}
              value={quietMinutes}
              onChange={(e) => setQuietMinutes(Math.max(0, Math.min(240, Number(e.target.value) || 0)))}
              className="mx-chip h-8 w-24 shrink-0 bg-[var(--mx-hover-bg)] px-2 text-xs tabular-nums outline-none focus:ring-1 focus:ring-[var(--mx-accent)]"
            />
          </Field>
          <Field label={t("conductor.settings.budget")} hint={t("conductor.settings.budgetHint")}>
            <input
              type="number"
              min={100}
              max={100_000}
              step={100}
              value={budget}
              onChange={(e) => setBudget(Math.max(100, Math.min(100_000, Number(e.target.value) || 100)))}
              className="mx-chip h-8 w-28 shrink-0 bg-[var(--mx-hover-bg)] px-2 text-xs tabular-nums outline-none focus:ring-1 focus:ring-[var(--mx-accent)]"
            />
          </Field>
        </section>

        {/* 大脑健康 + 测试。 */}
        <section className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-[var(--mx-text)]">{t("conductor.settings.brainHealth")}</span>
            <span style={{ color: degraded ? "#ef4444" : "#22c55e" }}>
              {degraded ? t("conductor.settings.degraded") : t("conductor.settings.healthy")}
            </span>
            {degraded && view !== null && view.brainDegradedUntilMs > 0 && (
              <span className="text-[var(--mx-muted)]">
                {t("conductor.settings.degradedUntil", { time: relativeTime(view.brainDegradedUntilMs, t) })}
              </span>
            )}
            {view !== null && !degraded && view.brainFailStreak > 0 && (
              <span className="text-[var(--mx-muted)]">{t("conductor.settings.failStreak", { n: view.brainFailStreak })}</span>
            )}
            {view !== null && (
              <span className="text-[var(--mx-muted)] opacity-70">
                {t("conductor.settings.maxTokensNote", { n: view.maxTokens })}
              </span>
            )}
          </div>
          {/* 最近一次失败原因(决策流空态同源):有它在,404/欠费/断网一眼可见,不用翻日志。 */}
          {view?.lastBrainError && (
            <div className="mx-chip bg-[#f59e0b1a] px-2.5 py-1.5 text-xs text-[#f59e0b]">
              <span className="min-w-0 break-all">
                {t("conductor.settings.lastBrainError")} {view.lastBrainError}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={testing}
              onClick={() => void testBrain()}
              className="mx-chip h-8 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-3 text-xs text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
            >
              {testing ? t("conductor.settings.testing") : t("conductor.settings.test")}
            </button>
          </div>
        </section>

          </>
        ) : (
          /* 长期记忆独立分页(v3,2026-11-16 用户:「记忆单独弄个tab」):候选确认走右栏动态卡。 */
          <MemorySection memories={memories} projects={projects} onChanged={onChanged} />
        )}

        {/* 消息条 + 保存。 */}
        {message && (
          <div className="mx-chip bg-[var(--mx-accent-soft)] px-2.5 py-1.5 text-xs text-[var(--mx-accent)]">
            <span className="min-w-0 flex-1 break-all">{message}</span>
            <button
              type="button"
              onClick={() => setMessage(null)}
              className="ml-2 shrink-0 cursor-pointer opacity-70 hover:opacity-100"
              aria-label="dismiss"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => void save()}
            className="mx-chip h-8 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-4 text-xs text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
          >
            {saving ? t("conductor.settings.saving") : t("conductor.settings.save")}
          </button>
          {savedAt > 0 && !dirty && <span className="text-xs text-[#22c55e]">{t("conductor.settings.saved")}</span>}
        </div>
      </div>
    </div>
  );
}

/** 标签行小件:左标签 + 右控件(+ 可选提示)。 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-[var(--mx-muted)]" title={hint}>
        {label}
      </span>
      {children}
      {hint && <span className="sr-only">{hint}</span>}
    </div>
  );
}

/** 长期记忆管理(独立分页内容):手填(多项目范围)+ 导入种子 + 条目列表(候选确认/删除)。 */
function MemorySection({
  memories,
  projects,
  onChanged,
}: {
  memories: MemoryEntry[];
  projects: { id: string; name: string }[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState("preference");
  /** 多项目范围(2026-11-16 用户:「记忆也能选多个项目」):空 = 全局,非空 = 命中项目。 */
  const [scopes, setScopes] = useState<string[]>([]);
  const [content, setContent] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(String(e).replace(/^Error\b:?\s*/i, ""));
    } finally {
      setBusy(false);
    }
  };

  /** 切换范围 chip:点全局清空;点项目 toggle(全局与项目互斥)。 */
  const toggleScope = (pid: string) => {
    setScopes((prev) => (prev.includes(pid) ? prev.filter((x) => x !== pid) : [...prev, pid]));
  };

  const candidates = memories.filter((m) => !m.confirmed);
  const confirmed = memories.filter((m) => m.confirmed);

  return (
    <div className="flex flex-col gap-1.5">
      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-[#ef4444]">
          <span className="min-w-0 flex-1 break-all">{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 cursor-pointer opacity-70 hover:opacity-100" aria-label="dismiss">
            ✕
          </button>
        </div>
      )}
      {/* 手填:类别 + 范围 chips(全局/多项目,可多选)+ 导入种子。 */}
      <div className="flex items-center gap-1.5">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="mx-chip h-7 shrink-0 bg-[var(--mx-hover-bg)] px-1 text-[11px] text-[var(--mx-text)] outline-none"
          aria-label={t("conductor.memory.kindLabel")}
        >
          {(["rule", "preference", "habit"] as const).map((k) => (
            <option key={k} value={k}>
              {t(`conductor.memory.kind.${k}`)}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !content.trim()}
          onClick={() =>
            void run(async () => {
              await invoke("conductor_memory_add", { kind, projects: scopes, content: content.trim() });
              setContent("");
            })
          }
          className="mx-chip ml-auto h-7 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-2.5 text-[11px] text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
        >
          {t("conductor.memory.add")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => invoke("conductor_memory_import_seed"))}
          className="mx-chip h-7 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2.5 text-[11px] text-[var(--mx-muted)] hover:text-[var(--mx-text)] disabled:cursor-default disabled:opacity-40"
        >
          {t("conductor.memory.importSeed")}
        </button>
      </div>
      {/* 范围 chips:全局亮 = 全局;项目 chip 可多选(点亮即挂)。 */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="shrink-0 text-[11px] text-[var(--mx-muted)]">{t("conductor.memory.scopeLabel")}</span>
        <button
          type="button"
          onClick={() => setScopes([])}
          className={`mx-chip cursor-pointer px-2 py-0.5 text-[11px] ${
            scopes.length === 0
              ? "bg-[var(--mx-accent-soft)] text-[var(--mx-accent)]"
              : "bg-[var(--mx-hover-bg)] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
          }`}
        >
          {t("conductor.memory.scope.global")}
        </button>
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => toggleScope(p.id)}
            className={`mx-chip cursor-pointer px-2 py-0.5 text-[11px] ${
              scopes.includes(p.id)
                ? "bg-[var(--mx-accent-soft)] text-[var(--mx-accent)]"
                : "bg-[var(--mx-hover-bg)] text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
            }`}
          >
            {p.name}
          </button>
        ))}
        {scopes.length > 0 && (
          <span className="text-[10px] text-[var(--mx-muted)]">{t("conductor.memory.scopeHint")}</span>
        )}
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={2}
        placeholder={t("conductor.memory.addPlaceholder")}
        className="mx-chip w-full resize-y bg-[var(--mx-hover-bg)] px-2 py-1.5 text-[11px] text-[var(--mx-text)] outline-none focus:ring-1 focus:ring-[var(--mx-accent)]"
      />
      {memories.length === 0 ? (
        <div className="py-2 text-center text-[11px] text-[var(--mx-muted)] opacity-70">{t("conductor.memory.emptyHint")}</div>
      ) : (
        <ul className="mx-scroll-pretty max-h-56 overflow-y-auto">
          {candidates.length > 0 && (
            <li className="px-1 py-0.5 text-[11px] font-medium text-[#f59e0b]">
              {t("conductor.memory.candidates", { n: candidates.length })}
            </li>
          )}
          {candidates.map((m) => (
            <MemoryRow key={m.id} entry={m} projects={projects} busy={busy} onRun={run} />
          ))}
          {confirmed.length > 0 && (
            <li className="px-1 pt-1 text-[11px] font-medium text-[var(--mx-muted)]">
              {t("conductor.memory.confirmedTitle", { n: confirmed.length })}
            </li>
          )}
          {confirmed.map((m) => (
            <MemoryRow key={m.id} entry={m} projects={projects} busy={busy} onRun={run} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** 单条记忆(行式):内容 + 徽标(范围支持多项目显示「A/B」);候选带「确认」,全部带「删除」。 */
function MemoryRow({
  entry,
  projects,
  busy,
  onRun,
}: {
  entry: MemoryEntry;
  projects: { id: string; name: string }[];
  busy: boolean;
  onRun: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useTranslation();
  // 多项目显示项目名拼接(id 查名,查不到兜底显示 id);空 = 全局。
  const scopeName =
    entry.scopes.length === 0
      ? t("conductor.memory.scope.global")
      : t("conductor.memory.scope.project", {
          name: entry.scopes.map((id) => projects.find((p) => p.id === id)?.name ?? id).join("/"),
        });
  return (
    <li className="flex items-start gap-1.5 border-b border-[var(--mx-border)] py-1.5 text-[11px] last:border-b-0">
      <div className="flex shrink-0 flex-wrap items-center gap-1 pt-0.5 text-[var(--mx-muted)]">
        <span className="font-medium">{t(`conductor.memory.kind.${entry.kind}`)}</span>
        <span className="opacity-70">{scopeName}</span>
        {!entry.confirmed && <span className="text-[#f59e0b]">{t("conductor.memory.pendingBadge")}</span>}
        {entry.confirmed && entry.hits > 0 && (
          <span className="rounded-full bg-[var(--mx-accent-soft)] px-1.5 text-[10px] leading-4 text-[var(--mx-accent)]">
            {t("conductor.memory.hits", { n: entry.hits })}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1 break-all pl-1 text-[var(--mx-text)]">{entry.content}</div>
      {!entry.confirmed && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRun(() => invoke("conductor_memory_confirm", { id: entry.id }))}
          className="mx-chip h-6 shrink-0 cursor-pointer bg-[var(--mx-accent-soft)] px-2 text-[10px] text-[var(--mx-accent)] disabled:cursor-default disabled:opacity-40"
        >
          {t("conductor.memory.confirm")}
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void onRun(() => invoke("conductor_memory_delete", { id: entry.id }))}
        className="mx-chip h-6 shrink-0 cursor-pointer bg-[var(--mx-hover-bg)] px-2 text-[10px] text-[var(--mx-muted)] hover:text-[#ef4444] disabled:cursor-default disabled:opacity-40"
      >
        {t("conductor.memory.delete")}
      </button>
    </li>
  );
}
