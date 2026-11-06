// 用量统计面板(设置 → 用量 tab),对齐 cc-switch UsageDashboard 的骨架(Sheet 体量裁剪):
//
// - 概览常驻卡片块(2026-10-21 用户定调:不再是 tab,置于下方 4 tab 之上):
//   Hero 汇总格(会话/请求/费用/缓存命中率 + tokens 组「总量/输入/输出」K/M 收紧,
//   缓存读并入总量不单列;精确数看趋势图 hover)+ 趋势图(自绘 SVG 堆叠柱,带 x/y 轴
//   刻度:y=tokens,单日范围 x 细化到小时、多日按日、>120 桶按月,不引 recharts)
// - 请求日志:逐请求明细(时间/app/模型/四段 tokens/费用,分页)
// - 供应商:按模型名前缀归并供应商品牌(vendorOf;cc-switch 的 provider 字段来自代理日志,
//   我们的数据源没有,前缀归并是等价近似),行 = 供应商 | 请求 | ↑⟳↓ | 费用 | 占比条
// - 模型:模型 | app | 请求 | ↑ | ⟳ | ↓ | 费用(cc-switch ModelStatsTable 核心列),
//   行内「编辑单价」写 override(domain/usage.ts 三级定价:override > models.dev > 内置)
// - 定价:同步 models.dev(1h 缓存)+ 手动 override 管理列表
// - 数据 = 后端扫会话 jsonl 聚合;时间筛选默认今天(2026-10-21 用户定调)。加载走模块级
//   SWR 缓存 + 窗口分级(默认 120 天,选「全部」才升 4000 全量),重开面板零等待。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  estimateCost,
  fetchRequestLog,
  fetchUsageSummary,
  formatTokens,
  formatUsd,
  loadPricingOverrides,
  lookupPricing,
  normalizeModelId,
  preloadModelsDevPricing,
  refreshModelsDevPricing,
  savePricingOverrides,
  type ModelPricing,
  type PricingSource,
  type RequestLogEntry,
  type UsageRollup,
  type UsageSummary,
} from "../domain/usage";
import { vendorOf } from "../domain/usage";
import { Button } from "./ui/Button";
import { SliderItem, SliderToggleGroup } from "./ui/SegmentSlider";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/Tabs";

/** 本地日期串(YYYY-MM-DD;与后端 local_date_from_ts 同口径)。 */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgoStr(n: number): string {
  const d = new Date();
  return localDateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n));
}

/** tokens 精确数(趋势图 hover tooltip 用完整千分位;Hero 格 K/M 收紧——2026-10-21
 *  用户两轮定调:常驻收紧看趋势,悬浮展开看精确)。 */
function fmtExact(n: number): string {
  return Math.round(n).toLocaleString();
}

/** 请求日志条目 → estimateCost 入参形状(四段照搬,requests=1)。 */
function logToRollupLike(r: RequestLogEntry): UsageRollup {
  return {
    date: r.ts.slice(0, 10),
    app: r.app,
    model: r.model,
    requests: 1,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    sessions: 1,
  };
}

// —— 模块级 SWR 缓存:面板随 TabsContent/设置弹窗卸载重挂,缓存让重开零等待(先渲染
// 旧数据,挂载后台静默刷一次);否则「每次点用量 tab」都触发后端全量 jsonl 扫描(秒级)。
// days 级联:只存已拉过的最大窗口,更小窗口直接复用。
type UsageCache = { summary: UsageSummary; log: RequestLogEntry[]; days: number };
let usageCache: UsageCache | null = null;
/** 初始窗口 120 天:覆盖全部预设(除「全部」)+ 本月/上月,且后端 mtime 预过滤生效
 *  (days=4000 时所有文件都「新」,预过滤失效退化为全量扫,首开明显更慢)。 */
const USAGE_INITIAL_DAYS = 120;
const USAGE_MAX_DAYS = 4000;

export function UsagePanel() {
  const { t } = useTranslation();
  // 数据源:rollups + 逐请求日志按窗口拉取(ensureDays 分级),时间/供应商/模型筛选全部
  // 在前端做(切时间零网络往返)。重 IO 由后端 spawn_blocking。
  const [summaryData, setSummaryData] = useState<UsageSummary | null>(usageCache?.summary ?? null);
  const [requestLog, setRequestLog] = useState<RequestLogEntry[] | null>(usageCache?.log ?? null);
  const [modelsDev, setModelsDev] = useState<Record<string, ModelPricing> | null>(null);
  const [syncingPricing, setSyncingPricing] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, ModelPricing>>(() => loadPricingOverrides());
  const [editingModel, setEditingModel] = useState<string | null>(null);
  // 「更多指标」展开态(会话/输入/输出/模型数第二行 Hero;2026-10-21 用户定调默认收起)。
  const [moreMetrics, setMoreMetrics] = useState(false);
  // 已拉窗口(天)。与模块缓存同步:重开面板时从缓存窗口续,不倒退。
  const loadedDaysRef = useRef(usageCache?.days ?? 0);

  // 筛选态(cc-switch UsageDashboard 布局:顶部左 app 段选,右 供应商/模型/时间)。
  // 默认今天(2026-10-21 用户定调):打开即今日小时粒度趋势。
  const [appFilter, setAppFilter] = useState<"all" | "claude" | "codex">("all");
  const [vendorFilter, setVendorFilter] = useState(""); // ""=全部;"other"=未识别
  const [modelFilter, setModelFilter] = useState("");
  const [dateFrom, setDateFrom] = useState(localDateStr(new Date()));
  const [dateTo, setDateTo] = useState(localDateStr(new Date()));
  // 趋势图指标(受控,2026-11-04 用户定调:点击顶部 Hero 格切换,图表内不再自带 pill)。
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("tokens");

  // 窗口不够时拉取(rollups+log 并发);force 绕过窗口判定(SWR 重开刷新)。
  // 结果写模块缓存(卸载后完成也不丢,下次直接可用);setState 对已卸载组件是 no-op(React 18)。
  const ensureDays = useCallback((days: number, force = false) => {
    const want = Math.min(days, USAGE_MAX_DAYS);
    if (!force && want <= loadedDaysRef.current) return;
    loadedDaysRef.current = Math.max(loadedDaysRef.current, want);
    void Promise.all([fetchUsageSummary(want), fetchRequestLog(want)]).then(([s, l]) => {
      usageCache = { summary: s, log: l, days: want };
      setSummaryData(s);
      setRequestLog(l);
    });
  }, []);

  // SWR:重开面板先渲染缓存,后台同窗口静默刷一次(带出新会话数据);首开无缓存走下方。
  useEffect(() => {
    if (usageCache) ensureDays(Math.max(USAGE_INITIAL_DAYS, usageCache.days), true);
  }, [ensureDays]);
  // 范围变化:超出已拉窗口(「全部」/选到窗口外旧日期)才升级拉取。
  useEffect(() => {
    const need = dateFrom
      ? Math.ceil((Date.now() - new Date(`${dateFrom}T00:00:00`).getTime()) / 86400000) + 2
      : USAGE_MAX_DAYS; // 空 = 「全部」
    ensureDays(Math.max(USAGE_INITIAL_DAYS, need));
  }, [dateFrom, ensureDays]);

  useEffect(() => {
    let alive = true;
    void preloadModelsDevPricing().then((p) => {
      if (alive && p) setModelsDev(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleSyncPricing = async () => {
    setSyncingPricing(true);
    const p = await refreshModelsDevPricing();
    if (p) setModelsDev(p);
    setSyncingPricing(false);
  };

  const saveOverride = (model: string, pricing: ModelPricing | null) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (pricing) next[normalizeModelId(model)] = pricing;
      else delete next[normalizeModelId(model)];
      savePricingOverrides(next);
      return next;
    });
  };

  // 同日聚合 + 连字符变体归并(glm-5.3 / glm-5-3 归一后同名)。
  const merged = useMemo(() => {
    const map = new Map<string, UsageRollup>();
    for (const r of summaryData?.rollups ?? []) {
      const key = `${r.date}|${r.app}|${normalizeModelId(r.model)}`;
      const cur = map.get(key) ?? { ...r, model: normalizeModelId(r.model) };
      if (cur === r) {
        map.set(key, cur);
        continue;
      }
      cur.requests += r.requests;
      cur.inputTokens += r.inputTokens;
      cur.outputTokens += r.outputTokens;
      cur.cacheReadTokens += r.cacheReadTokens;
      cur.cacheCreationTokens += r.cacheCreationTokens;
      cur.sessions += r.sessions;
      map.set(key, cur);
    }
    return [...map.values()];
  }, [summaryData]);

  // 筛选管道:app + 供应商(模型名前缀归并)+ 模型 + 日期区间,对 rollups 与日志同口径。
  const passFilter = useCallback(
    (app: string, model: string, date: string): boolean =>
      (appFilter === "all" || app === appFilter) &&
      (!vendorFilter || (vendorOf(model) ?? "other") === vendorFilter) &&
      (!modelFilter || normalizeModelId(model) === modelFilter) &&
      (!dateFrom || date >= dateFrom) &&
      (!dateTo || date <= dateTo),
    [appFilter, vendorFilter, modelFilter, dateFrom, dateTo],
  );

  const filtered = useMemo(
    () => merged.filter((r) => passFilter(r.app, r.model, r.date)),
    [merged, passFilter],
  );
  const logFiltered = useMemo(
    // 日志日期口径:ts 是 UTC ISO,直接 slice(0,10) 会把本地今天 0~8 点(UTC 昨天)漏在
    // 「今天」筛选外;转本地日期串再筛。条数 ≤3000,逐条 new Date 可接受。
    () => (requestLog ?? []).filter((r) => passFilter(r.app, r.model, localDateStr(new Date(r.ts)))),
    [requestLog, passFilter],
  );

  // 供应商/模型筛选项(全量 merged 的 distinct,按用量降序;供应商含「其他」)。
  const vendorOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of merged) {
      const v = vendorOf(r.model) ?? "other";
      counts.set(v, (counts.get(v) ?? 0) + r.requests);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  }, [merged]);
  const modelOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of merged) counts.set(r.model, (counts.get(r.model) ?? 0) + r.requests);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  }, [merged]);

  // Hero 汇总(筛选后窗口叠加;会话 = 筛选后日志 distinct(app,sessionId))。
  const grand = useMemo(() => {
    let requests = 0, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, cost = 0, known = false;
    for (const r of filtered) {
      requests += r.requests;
      input += r.inputTokens;
      output += r.outputTokens;
      cacheRead += r.cacheReadTokens;
      cacheCreation += r.cacheCreationTokens;
      const c = estimateCost(r, overrides, modelsDev);
      if (c != null) {
        cost += c;
        known = true;
      }
    }
    const sessions = new Set(logFiltered.map((r) => `${r.app}|${r.sessionId}`)).size;
    const cacheable = input + cacheRead + cacheCreation;
    return { requests, input, output, cacheRead, cacheCreation, cost, known, sessions, cacheHitRate: cacheable > 0 ? cacheRead / cacheable : 0 };
  }, [filtered, logFiltered, overrides, modelsDev]);

  // 按模型聚合表(筛选后,按总 tokens 降序)。
  const modelRows = useMemo(() => {
    const map = new Map<string, UsageRollup>();
    for (const r of filtered) {
      const key = `${r.app}|${r.model}`;
      const cur = map.get(key) ?? { ...r };
      if (cur !== r) {
        cur.requests += r.requests;
        cur.inputTokens += r.inputTokens;
        cur.outputTokens += r.outputTokens;
        cur.cacheReadTokens += r.cacheReadTokens;
        cur.cacheCreationTokens += r.cacheCreationTokens;
        cur.sessions += r.sessions;
      }
      map.set(key, cur);
    }
    return [...map.values()].sort(
      (a, b) => b.inputTokens + b.cacheReadTokens + b.outputTokens - (a.inputTokens + a.cacheReadTokens + a.outputTokens),
    );
  }, [filtered]);

  // 按供应商聚合(筛选后;按请求数降序)。
  const vendorRows = useMemo(() => {
    type VRow = { vendor: string; requests: number; input: number; cacheRead: number; output: number; cost: number };
    const map = new Map<string, VRow>();
    for (const r of filtered) {
      const v = vendorOf(r.model) ?? "";
      const cur = map.get(v) ?? { vendor: v, requests: 0, input: 0, cacheRead: 0, output: 0, cost: 0 };
      cur.requests += r.requests;
      cur.input += r.inputTokens + r.cacheCreationTokens;
      cur.cacheRead += r.cacheReadTokens;
      cur.output += r.outputTokens;
      cur.cost += estimateCost(r, overrides, modelsDev) ?? 0;
      map.set(v, cur);
    }
    return [...map.values()].sort((a, b) => b.requests - a.requests);
  }, [filtered, overrides, modelsDev]);

  // 预设快捷(cc-switch today/yesterday/7d/14d/30d/all):写入起止日期;高亮 = 恰好匹配。
  const presets = useMemo(() => buildRangePresets(), []);
  const resetFilters = () => {
    setAppFilter("all");
    setVendorFilter("");
    setModelFilter("");
    setDateFrom(localDateStr(new Date()));
    setDateTo(localDateStr(new Date()));
  };
  const filterCls =
    // h-[24px]:原生 select 的内部行盒与 button 不同高,固定高度让供应商/模型/日期三控件像素级齐平。
    "h-[24px] rounded-[var(--mx-radius-md)] border border-[var(--mx-border-strong)] bg-[var(--mx-surface-2)] px-1.5 py-1 text-[11px] text-[var(--mx-text)] outline-none transition-colors focus-visible:border-[var(--mx-accent)]";

  return (
    <div>
      {/* 筛选带(cc-switch 布局):左 app 段选;右 供应商/模型/起止日期/重置。sticky 固定
          在设置弹窗内容区顶部不随滚动(用户 2026-11-04)。Chromium 的 sticky 阈值相对滚动
          容器 content box(容器 py-4=14px):top:0 会粘在 padding 之下、上缘露 14px 内容
          (探针实测)。-top-3.5(-14px)把粘着点提到 padding box 顶;pt-[22px](14+8)让
          粘住前后带内内容位置恒等(153.75+8 = 139.75+22),不跳动。-mx-5/px-5 让不透明
          背景横贯内容区全宽(容器 px-5 的负外延)。 */}
      <div className="sticky -top-[14px] z-10 -mx-5 flex flex-wrap items-center gap-2 bg-[var(--mx-card-inner)] px-5 pb-2.5 pt-[22px]">
        <SliderToggleGroup
          value={appFilter}
          onValueChange={(v) => {
            if (v) setAppFilter(v as "all" | "claude" | "codex");
          }}
        >
          <SliderItem value="all">{t("settings.usage.appAll")}</SliderItem>
          <SliderItem value="claude">Claude</SliderItem>
          <SliderItem value="codex">Codex</SliderItem>
        </SliderToggleGroup>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <select className={filterCls} value={vendorFilter} aria-label={t("settings.usage.byVendor")} onChange={(e) => setVendorFilter(e.target.value)}>
            <option value="">{t("settings.usage.allVendors")}</option>
            {vendorOptions.map((v) => (
              <option key={v} value={v}>
                {v === "other" ? t("settings.usage.vendorUnknown") : v}
              </option>
            ))}
          </select>
          <select className={`${filterCls} max-w-[180px]`} value={modelFilter} aria-label={t("settings.usage.byModel")} onChange={(e) => setModelFilter(e.target.value)}>
            <option value="">{t("settings.usage.allModels")}</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <UsageRangePicker presets={presets} from={dateFrom} to={dateTo} onChange={(f, to) => { setDateFrom(f); setDateTo(to); }} />
          <Button size="xs" variant="ghost" onClick={resetFilters}>
            {t("settings.usage.resetFilters")}
          </Button>
        </div>
      </div>

      {/* loading / 空态 */}
      {summaryData == null && <div className="py-8 text-center text-[11px] text-[var(--mx-faint)]">{t("settings.usage.loading")}</div>}
      {summaryData != null && merged.length === 0 && (
        <div className="py-8 text-center text-[11px] text-[var(--mx-faint)]">{t("settings.usage.empty")}</div>
      )}

      {summaryData != null && merged.length > 0 && (
        <>
          {/* 概览常驻卡片块(2026-10-21 用户定调:不再是 tab,放请求日志/供应商/模型/定价
              4 个 tab 之上,一眼见汇总+趋势):Hero 格 + 趋势图,全吃筛选。 */}
          <div className="mb-3 px-3 py-2.5">
            {/* 常驻 4 格(用户点名的核心指标);点击切趋势图视角(2026-11-04 定调,
                取代图表右上角 pill)。命中率格归 tokens 视角(看 cacheRead 堆叠段)。 */}
            <div className="mb-1.5 grid grid-cols-4 gap-1.5">
              <HeroCell
                icon={IconZap}
                label={t("settings.usage.requests")}
                numeric={{ value: grand.requests, format: (n) => Math.round(n).toLocaleString() }}
                onClick={() => setTrendMetric("requests")}
                active={trendMetric === "requests"}
              />
              {/* tokens 组(2026-10-29 对齐 cc-switch):「真实消耗」= 四段全和
                  (新增输入+输出+缓存写入+缓存命中)——缓存命中虽按折扣计价,但 token
                  层面真实发生过;「更多指标」展开四段分解,与该格互相印证。 */}
              <HeroCell
                icon={IconLayers}
                label={t("settings.usage.total")}
                numeric={{ value: grand.input + grand.output + grand.cacheRead + grand.cacheCreation, format: (n) => formatTokens(n) }}
                title={t("settings.usage.totalHint")}
                onClick={() => setTrendMetric("tokens")}
                active={trendMetric === "tokens"}
              />
              <HeroCell
                icon={IconTarget}
                label={t("settings.usage.cacheHit")}
                numeric={{ value: grand.cacheHitRate * 100, format: (n) => `${Math.round(n)}%` }}
                onClick={() => setTrendMetric("tokens")}
                active={trendMetric === "tokens"}
              />
              <HeroCell
                icon={IconCost}
                label={t("settings.usage.cost")}
                numeric={{ value: grand.cost, format: (n) => (grand.known ? `≈${formatUsd(n)}` : "—") }}
                accent
                onClick={() => setTrendMetric("cost")}
                active={trendMetric === "cost"}
              />
            </div>
            {moreMetrics && (
              /* cc-switch 同款四段分解(2026-10-29):与 Hero「真实消耗」格构成
                 加法关系——四格相加 = 真实消耗;会话/模型数不再占格(模型数在
                 「模型」tab 天然可见)。 */
              <div className="mb-1.5 grid grid-cols-4 gap-1.5">
                <HeroCell
                  icon={IconIn}
                  label={t("settings.usage.newInput")}
                  numeric={{ value: grand.input, format: (n) => formatTokens(n) }}
                  onClick={() => setTrendMetric("tokens")}
                  active={trendMetric === "tokens"}
                />
                <HeroCell
                  icon={IconOut}
                  label={t("settings.usage.output")}
                  numeric={{ value: grand.output, format: (n) => formatTokens(n) }}
                  onClick={() => setTrendMetric("tokens")}
                  active={trendMetric === "tokens"}
                />
                <HeroCell
                  icon={IconLayers}
                  label={t("settings.usage.cacheWrite")}
                  numeric={{ value: grand.cacheCreation, format: (n) => formatTokens(n) }}
                  onClick={() => setTrendMetric("tokens")}
                  active={trendMetric === "tokens"}
                />
                <HeroCell
                  icon={IconTarget}
                  label={t("settings.usage.cacheHitTokens")}
                  numeric={{ value: grand.cacheRead, format: (n) => formatTokens(n) }}
                  onClick={() => setTrendMetric("tokens")}
                  active={trendMetric === "tokens"}
                />
              </div>
            )}
            <button
              type="button"
              onClick={() => setMoreMetrics((v) => !v)}
              aria-expanded={moreMetrics}
              className="mb-1.5 flex items-center gap-1 text-[10px] text-(color:--mx-faint) transition-colors hover:text-(color:--mx-text)"
            >
              {t("settings.usage.moreMetrics")}
              <span aria-hidden>{moreMetrics ? "▴" : "▾"}</span>
            </button>
            <UsageTrendChart rows={filtered} log={logFiltered} dateFrom={dateFrom} dateTo={dateTo} overrides={overrides} modelsDev={modelsDev} metric={trendMetric} />
          </div>

          <Tabs defaultValue="logs" className="flex flex-col">
          <TabsList className="mb-3 flex shrink-0 gap-4 border-b border-[var(--mx-border)]">
            {(["logs", "providers", "models", "pricing"] as const).map((v) => (
              <TabsTrigger
                key={v}
                value={v}
                className="border-b-2 border-transparent pb-1.5 text-[11px] text-[var(--mx-muted)] data-[state=active]:border-[var(--mx-accent)] data-[state=active]:text-[var(--mx-text)]"
              >
                {t(`settings.usage.tab${v[0].toUpperCase()}${v.slice(1)}`)}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* 请求日志:逐请求明细(筛选同口径;分页)。 */}
          <TabsContent value="logs" className="mx-rise-in flex flex-col">
            <RequestLogTable rows={logFiltered} overrides={overrides} modelsDev={modelsDev} />
          </TabsContent>

          {/* 供应商:模型名前缀归并的统计行(费用占比条)。 */}
          <TabsContent value="providers" className="mx-rise-in flex flex-col">
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">
              {t("settings.usage.byVendor")}
            </div>
            <div className="space-y-1">
              {vendorRows.map((v) => (
                <VendorRow
                  key={v.vendor || "unknown"}
                  row={v}
                  maxCost={vendorRows[0]?.cost || 1}
                  unknownLabel={t("settings.usage.vendorUnknown")}
                />
              ))}
            </div>
          </TabsContent>

          {/* 模型统计表 + 行内单价编辑。 */}
          <TabsContent value="models" className="mx-rise-in flex flex-col">
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">
              {t("settings.usage.byModel")}
            </div>
            <div className="space-y-1">
              {modelRows.map((m) => (
                <ModelRow
                  key={`${m.app}:${m.model}`}
                  row={m}
                  overrides={overrides}
                  modelsDev={modelsDev}
                  editing={editingModel === `${m.app}:${m.model}`}
                  onToggleEdit={() =>
                    setEditingModel(editingModel === `${m.app}:${m.model}` ? null : `${m.app}:${m.model}`)
                  }
                  onSaveOverride={(p) => saveOverride(m.model, p)}
                />
              ))}
            </div>
          </TabsContent>

          {/* 定价:同步 models.dev + 手动 override 管理。 */}
          <TabsContent value="pricing" className="mx-rise-in flex flex-col">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">
                {t("settings.usage.syncPricing")}
              </span>
              <Button size="xs" variant="outline" disabled={syncingPricing} onClick={() => void handleSyncPricing()}>
                {syncingPricing ? t("settings.usage.syncing") : t("settings.usage.syncPricing")}
              </Button>
            </div>
            {Object.keys(overrides).length === 0 ? (
              <div className="py-4 text-center text-[11px] text-[var(--mx-faint)]">
                {t("settings.usage.overrideEmpty")}
              </div>
            ) : (
              <div className="space-y-1">
                {Object.entries(overrides)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([model, pricing]) => (
                    <OverrideRow key={model} model={model} pricing={pricing} onSave={(p) => saveOverride(model, p)} />
                  ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
        </>
      )}

      <div className="mt-3 text-[10px] leading-relaxed text-[var(--mx-faint)]">{t("settings.usage.hint")}</div>
    </div>
  );
}

/** 时间预设(今日/昨日/7/14/30/全部;from/to 为本地日期串,空 = 不限)。 */
function buildRangePresets(): Array<{ key: string; from: string; to: string }> {
  const today = localDateStr(new Date());
  return [
    { key: "today", from: today, to: today },
    { key: "yesterday", from: daysAgoStr(1), to: daysAgoStr(1) },
    { key: "7", from: daysAgoStr(6), to: today },
    { key: "14", from: daysAgoStr(13), to: today },
    { key: "30", from: daysAgoStr(29), to: today },
    { key: "all", from: "", to: "" },
  ];
}

/**
 * 时间范围选择器(顶栏右上,供应商/模型筛选之后):点开下拉列预设(今日/昨日/7/14/30/全部),
 * 尾部自带「自定义范围」起止 date 输入(改动即生效,不关浮层);trigger 显示当前范围。
 */
function UsageRangePicker({
  presets,
  from,
  to,
  onChange,
}: {
  presets: Array<{ key: string; from: string; to: string }>;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  // 展示月(1 号);打开浮层时重置——优先跳到当前筛选起点所在月(自定义范围常在过去),
  // 无起点回当月。
  const [viewMonth, setViewMonth] = useState(() => monthOf(from));
  // 范围选择:第一击锚点(ISO 日期);null = 未开始新选择,日历显示现有 from/to。
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const presetLabel = (key: string) =>
    key === "today"
      ? t("settings.usage.rangeToday")
      : key === "yesterday"
        ? t("settings.usage.rangeYesterday")
        : key === "all"
          ? t("settings.usage.rangeAll")
          : t("settings.usage.rangeDays", { n: key });

  // 快捷区 = 时间预设 + 本月/上月(用户 2026-10-21:下拉直接展示当月日历 + 范围选,
  // 不再让人点开原生 date input 的第二层系统日历;「本月」止于今天,未来无数据)。
  const now = new Date();
  const quickRanges = [
    ...presets.map((p) => ({ label: presetLabel(p.key), from: p.from, to: p.to })),
    { label: t("settings.usage.rangeThisMonth"), from: localDateStr(new Date(now.getFullYear(), now.getMonth(), 1)), to: localDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate())) },
    { label: t("settings.usage.rangeLastMonth"), from: localDateStr(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: localDateStr(new Date(now.getFullYear(), now.getMonth(), 0)) },
  ];
  const active = quickRanges.find((q) => q.from === from && q.to === to);
  const label = active ? active.label : `${from.slice(5) || "…"} ~ ${to.slice(5) || "…"}`;

  // 选择中显示 anchor..hover 预览(排序),否则显示当前筛选范围。
  const [selFrom, selTo] = anchor
    ? hover && hover !== anchor
      ? anchor < hover
        ? [anchor, hover]
        : [hover, anchor]
      : [anchor, anchor]
    : [from, to];

  const pickDay = (iso: string) => {
    if (!anchor) {
      setAnchor(iso);
      return;
    }
    // 第二击:成范围即生效并收起(快速选择);点同一天 = 单日范围。
    const [f, t2] = iso >= anchor ? [anchor, iso] : [iso, anchor];
    setAnchor(null);
    setHover(null);
    onChange(f, t2);
    setOpen(false);
  };

  const todayIso = localDateStr(new Date());
  const weekdays = t("settings.usage.rangeWeekdays").split(",");
  const y = viewMonth.getFullYear();
  const m = viewMonth.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // 周一 = 0
  const monthTitle = new Intl.DateTimeFormat(i18n.language || "zh", {
    year: "numeric",
    month: "long",
  }).format(viewMonth);
  const chipCls = (on: boolean) =>
    `rounded-full px-2 py-[3px] text-[10px] transition-colors ${
      on
        ? "bg-[var(--mx-accent-soft)] text-[var(--mx-accent-bright)]"
        : "text-(color:--mx-muted) hover:bg-[var(--mx-hover-bg)] hover:text-(color:--mx-text)"
    }`;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          // 重开回到当前范围所在月 + 清掉上次未完成的选择。
          setViewMonth(monthOf(from));
          setAnchor(null);
          setHover(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        {/* 与筛选带 select 同款样式/同高(px-1.5 py-1 text-[11px]),三个筛选控件齐平。 */}
        <button
          type="button"
          className="flex h-[24px] items-center gap-1.5 rounded-[var(--mx-radius-md)] border border-[var(--mx-border-strong)] bg-[var(--mx-surface-2)] px-1.5 py-1 text-[11px] text-[var(--mx-text)] outline-none transition-colors hover:bg-[var(--mx-hover-bg)]"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[252px] px-2 py-2">
        {/* 快捷 chips(横排省高度):预设 + 本月/上月,点击即生效收起。 */}
        <div className="mb-2 flex flex-wrap gap-1">
          {quickRanges.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => {
                onChange(q.from, q.to);
                setOpen(false);
              }}
              className={chipCls(q.from === from && q.to === to)}
            >
              {q.label}
            </button>
          ))}
        </div>
        {/* 月历:两次点击选范围,hover 实时预览;‹ › 切月。 */}
        <div onMouseLeave={() => setHover(null)}>
          <div className="mb-1 flex items-center justify-between">
            <Button variant="ghost" size="icon-sm" aria-label="prev-month" onClick={() => setViewMonth(new Date(y, m - 1, 1))}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </Button>
            <div className="text-[11px] font-medium text-(color:--mx-text)">{monthTitle}</div>
            <Button variant="ghost" size="icon-sm" aria-label="next-month" onClick={() => setViewMonth(new Date(y, m + 1, 1))}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </Button>
          </div>
          <div className="mb-1 grid grid-cols-7">
            {weekdays.map((w) => (
              <div key={w} className="grid h-4 place-items-center text-[9px] text-(color:--mx-faint)">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-[2px]">
            {Array.from({ length: firstDow }, (_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const day = i + 1;
              const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const isEdge = iso === selFrom || iso === selTo;
              const inRange = iso >= selFrom && iso <= selTo;
              const isToday = iso === todayIso;
              const future = iso > todayIso;
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={future}
                  onMouseEnter={() => anchor && setHover(iso)}
                  onClick={() => pickDay(iso)}
                  className={`grid h-[26px] place-items-center rounded-[var(--mx-radius-sm)] text-[11px] tabular-nums transition-colors ${
                    isEdge
                      ? "bg-[var(--mx-accent)] font-semibold text-(color:--mx-accent-contrast)"
                      : inRange
                        ? "bg-[var(--mx-accent-soft)] text-(color:--mx-text)"
                        : future
                          ? "cursor-not-allowed text-(color:--mx-faint) opacity-40"
                          : "text-(color:--mx-text) hover:bg-[var(--mx-hover-bg)]"
                  } ${isToday && !isEdge ? "ring-1 ring-inset ring-[var(--mx-accent)]" : ""}`}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 text-center text-[9px] text-(color:--mx-faint)">{t("settings.usage.rangeHint")}</div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** ISO 日期串 → 该月 1 号的 Date(本地时区;空串回当月)。 */
function monthOf(iso: string): Date {
  const d = new Date();
  if (!iso) return new Date(d.getFullYear(), d.getMonth(), 1);
  const [y, m] = iso.split("-").map(Number);
  return Number.isFinite(y) && Number.isFinite(m) ? new Date(y, m - 1, 1) : new Date(d.getFullYear(), d.getMonth(), 1);
}

/** 请求日志表:时间 | 应用 | 模型 | ↑ | ⟳ | ↓ | 费用;每页 20 条,筛选变化重置页码。 */
function RequestLogTable({
  rows,
  overrides,
  modelsDev,
}: {
  rows: RequestLogEntry[];
  overrides: Record<string, ModelPricing>;
  modelsDev: Record<string, ModelPricing> | null;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const PAGE = 20;
  useEffect(() => setPage(0), [rows]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const slice = rows.slice(current * PAGE, (current + 1) * PAGE);

  return (
    <div>
      {/* 表头 */}
      <div className="mb-1 grid grid-cols-[86px_52px_1fr_repeat(4,minmax(52px,auto))] items-baseline gap-x-2 border-b border-[var(--mx-border)] px-2 pb-1 text-[9px] uppercase tracking-wide text-[var(--mx-faint)]">
        <span>{t("settings.usage.logTime")}</span>
        <span>{t("settings.usage.logApp")}</span>
        <span className="truncate">{t("settings.usage.byModel")}</span>
        <span className="text-right">{t("settings.usage.input")}</span>
        <span className="text-right">{t("settings.usage.cacheRead")}</span>
        <span className="text-right">{t("settings.usage.output")}</span>
        <span className="text-right">{t("settings.usage.cost")}</span>
      </div>
      {slice.length === 0 && (
        <div className="py-6 text-center text-[11px] text-[var(--mx-faint)]">{t("settings.usage.noMatch")}</div>
      )}
      <div className="space-y-px">
        {slice.map((r, i) => (
          <div
            key={`${r.ts}|${r.app}|${i}`}
            title={`${r.sessionId.slice(0, 8)}${r.model}`}
            className="grid grid-cols-[86px_52px_1fr_repeat(4,minmax(52px,auto))] items-baseline gap-x-2 rounded-[var(--mx-radius-sm)] px-2 py-1 text-[11px] transition-colors hover:bg-[var(--mx-hover-bg)]"
          >
            <span className="truncate font-mono text-[10px] text-[var(--mx-faint)]">{r.ts.slice(5, 16).replace("T", " ")}</span>
            <span className="shrink-0 rounded bg-[var(--mx-surface-2)] px-1 py-px text-[9px] uppercase text-[var(--mx-muted)]">{r.app}</span>
            <span className="truncate font-mono text-[var(--mx-text)]">{r.model}</span>
            <span className="text-right tabular-nums text-[var(--mx-muted)]">{formatTokens(r.inputTokens + r.cacheCreationTokens)}</span>
            <span className="text-right tabular-nums text-[var(--mx-muted)]">{formatTokens(r.cacheReadTokens)}</span>
            <span className="text-right tabular-nums text-[var(--mx-muted)]">{formatTokens(r.outputTokens)}</span>
            <span className="text-right tabular-nums text-[var(--mx-accent-bright)]">≈{formatUsd(estimateCost(logToRollupLike(r), overrides, modelsDev))}</span>
          </div>
        ))}
      </div>
      {/* 分页 */}
      {rows.length > PAGE && (
        <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--mx-faint)]">
          <span>{t("settings.usage.totalN", { n: rows.length.toLocaleString() })}</span>
          <span className="flex items-center gap-1.5">
            <Button size="xs" variant="outline" disabled={current === 0} onClick={() => setPage(current - 1)}>
              ‹
            </Button>
            <span className="tabular-nums">
              {current + 1} / {pages}
            </span>
            <Button size="xs" variant="outline" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              ›
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}

/** 供应商统计行:品牌 | 请求 | ↑⟳↓ | 费用 + 费用占比条(相对窗口内最大)。 */
function VendorRow({
  row,
  maxCost,
  unknownLabel,
}: {
  row: { vendor: string; requests: number; input: number; cacheRead: number; output: number; cost: number };
  maxCost: number;
  unknownLabel: string;
}) {
  const { t } = useTranslation();
  const share = row.cost > 0 ? Math.max(0.03, row.cost / maxCost) : 0;
  return (
    <div className="relative overflow-hidden rounded-[var(--mx-radius-md)] border border-[var(--mx-border)] bg-[var(--mx-card-inner)] px-3 py-1.5 transition-colors hover:border-[var(--mx-border-strong)]">
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 bg-[var(--mx-accent)] opacity-[0.08]"
        style={{ width: `${share * 100}%` }}
      />
      <div className="relative flex flex-wrap items-baseline gap-x-2 text-[11px]">
        <span className="shrink-0 font-medium text-[var(--mx-text)]">{row.vendor || unknownLabel}</span>
        <span className="shrink-0 text-[var(--mx-faint)]">
          {row.requests} {t("settings.usage.requests")}
        </span>
        <span className="ml-auto flex shrink-0 items-baseline gap-2 tabular-nums text-[var(--mx-muted)]">
          <span title={t("settings.usage.input")}>↑{formatTokens(row.input)}</span>
          <span title={t("settings.usage.cacheRead")}>⟳{formatTokens(row.cacheRead)}</span>
          <span title={t("settings.usage.output")}>↓{formatTokens(row.output)}</span>
          <span className="text-[var(--mx-accent-bright)]">≈{formatUsd(row.cost)}</span>
        </span>
      </div>
    </div>
  );
}

/** 定价页的手动 override 管理行(模型 + 四单价只读展示 + 编辑/删除)。 */
function OverrideRow({
  model,
  pricing,
  onSave,
}: {
  model: string;
  pricing: ModelPricing;
  onSave: (pricing: ModelPricing | null) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  return (
    <div className="rounded-[var(--mx-radius-md)] border border-[var(--mx-border)] bg-[var(--mx-card-inner)] transition-colors hover:border-[var(--mx-border-strong)]">
      <button
        type="button"
        onClick={() => setEditing(!editing)}
        className="flex w-full flex-wrap items-baseline gap-x-2 px-3 py-1.5 text-left text-[11px]"
      >
        <span className="shrink-0 font-mono text-[var(--mx-text)]">{model}</span>
        <span className="ml-auto shrink-0 tabular-nums text-[var(--mx-muted)]">
          ↑{pricing.in} ↓{pricing.out} ⟳{pricing.cacheRead} ✎{pricing.cacheWrite}
        </span>
        <span className="shrink-0 text-[9px] text-[var(--mx-faint)]">{t("settings.usage.srcOverride")}</span>
        <span aria-hidden className="text-[var(--mx-faint)]">
          {editing ? "▾" : "▸"}
        </span>
      </button>
      {editing && (
        <div className="border-t border-[var(--mx-border)] px-3 py-2">
          <PricingEditor model={model} hit={{ pricing, source: "override" }} onSave={onSave} />
        </div>
      )}
    </div>
  );
}

/** 数字滚动(anime.js number tween 的 rAF 版):value 变化时从旧值 easeOutCubic
 * 滚到新值(420ms),筛选切换时 Hero 数字有「翻牌」动感而非瞬跳。 */
function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 420);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = from + (value - from) * eased;
      fromRef.current = v;
      setDisplay(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(display)}</>;
}

/** Hero 单格卡(cc-switch UsageHero 的紧凑版)。numeric 优先于 value 字符串(数字滚动
 * 渲染)。2026-11-04 用户定调:去掉格子背景(border+bg 太重),纯文字排布;onClick 时
 * 成为趋势图指标切换入口,active 格 label 行亮 accent 指示当前图表视角。 */
function HeroCell({
  icon: Icon,
  label,
  value,
  numeric,
  accent,
  title,
  onClick,
  active,
}: {
  icon: (props: { className?: string }) => ReactNode;
  label: string;
  value?: string;
  numeric?: { value: number; format: (n: number) => string };
  accent?: boolean;
  title?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const headCls = `flex items-center gap-1 text-[9px] uppercase tracking-wide transition-colors ${
    active ? "text-[var(--mx-accent-bright)]" : onClick ? "text-[var(--mx-faint)] group-hover:text-[var(--mx-text)]" : "text-[var(--mx-faint)]"
  }`;
  const head = (
    <div className={headCls}>
      <Icon className="h-[11px] w-[11px] shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
  const body = (
    <div className={`text-[14px] font-semibold tabular-nums ${accent ? "text-[var(--mx-accent-bright)]" : "text-[var(--mx-text)]"}`}>
      {numeric ? <AnimatedNumber value={numeric.value} format={numeric.format} /> : value}
    </div>
  );
  if (!onClick) {
    return (
      <div title={title} className="px-2.5 py-1.5">
        {head}
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={active}
      className="group px-2.5 py-1.5 text-left"
    >
      {head}
      {body}
    </button>
  );
}

// —— Hero 小图标(lucide 风 12px stroke;组件级常量避免重渲染) ——

const iconSvg = (paths: ReactNode) =>
  function Icon({ className }: { className?: string }) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
        {paths}
      </svg>
    );
  };
const IconZap = iconSvg(<><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></>);
const IconCost = iconSvg(<><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>);
const IconTarget = iconSvg(<><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></>);
const IconIn = iconSvg(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>);
const IconOut = iconSvg(<><path d="M12 21V9" /><path d="m7 14 5-5 5 5" /><path d="M5 3h14" /></>);
const IconLayers = iconSvg(<><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></>);

/** 趋势图视角(受控于顶部 Hero 格点击,2026-11-04 定调)。 */
type TrendMetric = "tokens" | "requests" | "cost";

/** 趋势行数据(桶 key + 四段合计)。 */
type TrendPoint = {
  key: string; // 显示标签(日 YYYY-MM-DD 或月 YYYY-MM)
  sortKey: string; // 排序/连续填充键
  input: number;
  cacheRead: number;
  output: number;
  requests: number;
  cost: number;
};

/**
 * 趋势图:自绘 SVG 堆叠柱,**带 x/y 轴刻度**(2026-10-21 用户定调:y=token 使用趋势,
 * x 单日范围细化到小时、多日按日,>120 桶自动按月聚合)。单日粒度数据源 = 请求日志
 * (rollup 只有 date 没小时;ts 是 UTC ISO,聚合时转本地小时)。hover:桶高亮 + tooltip
 * (完整 tokens 数 + 费用)。不引图表库,viewBox 固定按容器宽拉伸。
 */
function UsageTrendChart({
  rows,
  log,
  dateFrom,
  dateTo,
  overrides,
  modelsDev,
  metric,
}: {
  rows: UsageRollup[];
  log: RequestLogEntry[];
  dateFrom: string;
  dateTo: string;
  overrides: Record<string, ModelPricing>;
  modelsDev: Record<string, ModelPricing> | null;
  metric: TrendMetric;
}) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  // 指标视角由顶部 Hero 格受控(props.metric),组件内不再自带切换 pill。

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 单日范围(from==to,默认今天即此形态)→ 24 小时固定桶;否则按日聚合。
  const hourly = !!dateFrom && dateFrom === dateTo;

  const points = useMemo<TrendPoint[]>(() => {
    if (hourly) {
      const buckets: TrendPoint[] = Array.from({ length: 24 }, (_, h) => ({
        key: `${String(h).padStart(2, "0")}:00`,
        sortKey: String(h).padStart(2, "0"),
        input: 0,
        cacheRead: 0,
        output: 0,
        requests: 0,
        cost: 0,
      }));
      for (const r of log) {
        const d = new Date(r.ts); // UTC ISO → 本地
        if (localDateStr(d) !== dateFrom) continue; // 保险:UTC 边界行不属于该本地日
        const p = buckets[d.getHours()];
        p.input += r.inputTokens + r.cacheCreationTokens;
        p.cacheRead += r.cacheReadTokens;
        p.output += r.outputTokens;
        p.requests += 1;
        p.cost += estimateCost(logToRollupLike(r), overrides, modelsDev) ?? 0;
      }
      return buckets;
    }
    const daily = new Map<string, TrendPoint>();
    for (const r of rows) {
      const p = daily.get(r.date) ?? { key: r.date, sortKey: r.date, input: 0, cacheRead: 0, output: 0, requests: 0, cost: 0 };
      p.input += r.inputTokens + r.cacheCreationTokens;
      p.cacheRead += r.cacheReadTokens;
      p.output += r.outputTokens;
      p.requests += r.requests;
      p.cost += estimateCost(r, overrides, modelsDev) ?? 0;
      daily.set(r.date, p);
    }
    let list = [...daily.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    if (list.length > 120) {
      const monthly = new Map<string, TrendPoint>();
      for (const p of list) {
        const mk = p.sortKey.slice(0, 7);
        const m = monthly.get(mk) ?? { key: mk, sortKey: mk, input: 0, cacheRead: 0, output: 0, requests: 0, cost: 0 };
        m.input += p.input;
        m.cacheRead += p.cacheRead;
        m.output += p.output;
        m.requests += p.requests;
        m.cost += p.cost;
        monthly.set(mk, m);
      }
      list = [...monthly.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    }
    return list;
  }, [hourly, dateFrom, log, rows, overrides, modelsDev]);

  // 轴布局:左侧 y 刻度 + 底部 x 标签;plot 区不含轴。
  const H = 128;
  const PAD_L = 42;
  const PAD_R = 8;
  // PAD_T 22:顶部留「tokens」单位标签独占一行,与最高档刻度值拉开间距(用户 2026-10-21:
  // 单位贴着图表与 y 轴刻度重叠)。tokens 标签在 y=8,max 刻度在 PAD_T+3=25,竖向错开。
  const PAD_T = 22;
  const PAD_B = 20;
  const plotH = H - PAD_T - PAD_B;
  // 当前指标取值与轴格式化:tokens=三段和 / requests / cost。
  const metricVal = (p: TrendPoint) => (metric === "tokens" ? p.input + p.cacheRead + p.output : metric === "requests" ? p.requests : p.cost);
  const fmtMetric = (n: number) => (metric === "tokens" ? formatTokens(n) : metric === "requests" ? Math.round(n).toLocaleString() : formatUsd(n));
  const max = Math.max(1, ...points.map(metricVal));
  const innerW = Math.max(1, width - PAD_L - PAD_R);
  const barW = Math.max(1, Math.min(18, (innerW / Math.max(1, points.length)) * 0.7));
  const step = innerW / Math.max(1, points.length);
  const hoverPoint = hover != null ? points[hover] : null;

  // x 轴标签:小时取整 4 小时间隔(+末桶 23);日/月桶等间隔抽 ≤7 个(取 MM-DD / YYYY-MM)。
  const xTicks = useMemo(() => {
    if (points.length === 0) return [] as Array<{ pos: number; label: string }>;
    const tickAt = (i: number) => ({ pos: PAD_L + i * step + step / 2, label: points[i].key });
    if (hourly) {
      return [0, 4, 8, 12, 16, 20, 23].filter((h) => h < points.length).map((h) => tickAt(h));
    }
    const want = Math.min(7, points.length);
    const stride = points.length / want;
    return Array.from({ length: want }, (_, i) => {
      const idx = Math.min(points.length - 1, Math.round(i * stride));
      const k = points[idx].key;
      return { pos: tickAt(idx).pos, label: k.length === 7 ? k : k.slice(5) }; // 月桶 YYYY-MM 全显,日桶 MM-DD
    });
  }, [points, step, hourly, PAD_L]);

  return (
    <div ref={wrapRef} className="relative">
      <svg
        width="100%"
        height={H}
        className="block"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const x = e.clientX - rect.left - PAD_L;
          const idx = Math.floor(x / step);
          setHover(idx >= 0 && idx < points.length ? idx : null);
        }}
      >
        {/* y 轴:刻度值(max/半/0)+ 格线 + 左轴线;轴顶单位。 */}
        {[1, 0.5, 0].map((f) => {
          const y = PAD_T + plotH - plotH * f;
          return (
            <g key={f}>
              <line x1={PAD_L} x2="100%" y1={y} y2={y} stroke="var(--mx-border)" strokeDasharray={f === 0 ? undefined : "2 3"} />
              <text x={PAD_L - 6} y={y + 3} fontSize={9} fill="var(--mx-faint)" textAnchor="end">
                {f === 0 ? "0" : fmtMetric(max * f)}
              </text>
            </g>
          );
        })}
        <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={PAD_T + plotH} stroke="var(--mx-border-strong)" />
        <text x={PAD_L - 6} y={9} fontSize={9} fill="var(--mx-faint)" textAnchor="end">
          {metric === "tokens" ? "tokens" : metric === "requests" ? "reqs" : "USD"}
        </text>
        {/* x 轴:底线 + 刻度标签。 */}
        {xTicks.map((tk, i) => (
          <text key={`${tk.label}-${i}`} x={Math.min(Math.max(tk.pos, PAD_L + 12), width - PAD_R - 12)} y={H - 6} fontSize={9} fill="var(--mx-faint)" textAnchor="middle">
            {tk.label}
          </text>
        ))}
        {points.map((p, i) => {
          const x = PAD_L + i * step + (step - barW) / 2;
          const active = hover == null || hover === i;
          if (metric !== "tokens") {
            // 请求/成本视角:单色柱(cost 用 accent 呼应 Hero 费用格)。
            const h = (metricVal(p) / max) * plotH;
            return (
              <g key={p.key} opacity={active ? 1 : 0.45}>
                <rect x={x} y={PAD_T + plotH - h} width={barW} height={h} fill={metric === "cost" ? "var(--mx-accent)" : "var(--mx-text)"} opacity={0.75} rx={1} />
              </g>
            );
          }
          const hIn = (p.input / max) * plotH;
          const hCr = (p.cacheRead / max) * plotH;
          const hOut = (p.output / max) * plotH;
          let y = PAD_T + plotH;
          const seg = (h: number) => {
            y -= h;
            return y;
          };
          return (
            <g key={p.key} opacity={active ? 1 : 0.45}>
              <rect x={x} y={seg(hOut)} width={barW} height={hOut} fill="var(--mx-accent)" rx={1} />
              <rect x={x} y={seg(hCr)} width={barW} height={hCr} fill="var(--mx-text)" opacity={0.3} rx={1} />
              <rect x={x} y={seg(hIn)} width={barW} height={hIn} fill="var(--mx-text)" opacity={0.75} rx={1} />
            </g>
          );
        })}
        {/* hover 竖线。 */}
        {hover != null && (
          <line
            x1={PAD_L + hover * step + step / 2}
            x2={PAD_L + hover * step + step / 2}
            y1={PAD_T}
            y2={PAD_T + plotH}
            stroke="var(--mx-border-strong)"
          />
        )}
      </svg>
      {/* tooltip:跟随 hover 桶(右侧溢出时翻到左侧);tokens 用完整千分位数。 */}
      {hoverPoint && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-[var(--mx-radius-md)] border border-[var(--mx-border-strong)] bg-[var(--mx-surface)] px-2 py-1.5 text-[10px] shadow-lg"
          style={{
            left: Math.min(Math.max(0, PAD_L + (hover ?? 0) * step + step / 2 + 8), Math.max(0, width - 170)),
          }}
        >
          <div className="mb-0.5 font-mono text-[var(--mx-text)]">{hourly ? `${dateFrom} ${hoverPoint.key}` : hoverPoint.key}</div>
          <div className="space-y-0.5 tabular-nums text-[var(--mx-muted)]">
            <div>
              {t("settings.usage.trendRequests")} {fmtExact(hoverPoint.requests)}
            </div>
            <div>
              <span className="inline-block w-2 rounded-sm bg-[var(--mx-text)] opacity-75" /> {t("settings.usage.input")}{" "}
              {fmtExact(hoverPoint.input)}
            </div>
            <div>
              <span className="inline-block w-2 rounded-sm bg-[var(--mx-text)] opacity-30" /> {t("settings.usage.cacheRead")}{" "}
              {fmtExact(hoverPoint.cacheRead)}
            </div>
            <div>
              <span className="inline-block w-2 rounded-sm bg-[var(--mx-accent)]" /> {t("settings.usage.output")}{" "}
              {fmtExact(hoverPoint.output)}
            </div>
            <div className="text-[var(--mx-accent-bright)]">
              {t("settings.usage.cost")} ≈{formatUsd(hoverPoint.cost)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 模型统计行 + 展开的单价编辑(cc-switch ModelStatsTable + PricingEditModal 的行内版)。 */
function ModelRow({
  row,
  overrides,
  modelsDev,
  editing,
  onToggleEdit,
  onSaveOverride,
}: {
  row: UsageRollup;
  overrides: Record<string, ModelPricing>;
  modelsDev: Record<string, ModelPricing> | null;
  editing: boolean;
  onToggleEdit: () => void;
  onSaveOverride: (pricing: ModelPricing | null) => void;
}) {
  const { t } = useTranslation();
  const hit = lookupPricing(row.model, overrides, modelsDev);
  const cost = estimateCost(row, overrides, modelsDev);
  const srcLabel =
    hit?.source === "override"
      ? t("settings.usage.srcOverride")
      : hit?.source === "modelsdev"
        ? "models.dev"
        : hit?.source === "builtin"
          ? t("settings.usage.srcBuiltin")
          : t("settings.usage.srcNone");

  return (
    <div className="rounded-[var(--mx-radius-md)] border border-[var(--mx-border)] bg-[var(--mx-card-inner)] transition-colors hover:border-[var(--mx-border-strong)]">
      <button type="button" onClick={onToggleEdit} className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 text-left text-[11px]">
        <span className="shrink-0 rounded bg-[var(--mx-surface-2)] px-1 py-px text-[9px] uppercase text-[var(--mx-muted)]">
          {row.app}
        </span>
        <span className="shrink-0 font-mono text-[var(--mx-text)]">{row.model}</span>
        <span className="shrink-0 text-[var(--mx-faint)]">
          {row.requests} {t("settings.usage.requests")}
        </span>
        <span className="ml-auto flex shrink-0 items-baseline gap-2 tabular-nums text-[var(--mx-muted)]">
          <span title={t("settings.usage.input")}>↑{formatTokens(row.inputTokens + row.cacheCreationTokens)}</span>
          <span title={t("settings.usage.cacheRead")}>⟳{formatTokens(row.cacheReadTokens)}</span>
          <span title={t("settings.usage.output")}>↓{formatTokens(row.outputTokens)}</span>
          <span className="text-[var(--mx-accent-bright)]">≈{formatUsd(cost)}</span>
          <span className="text-[9px] text-[var(--mx-faint)]">{srcLabel}</span>
          <span aria-hidden className="text-[var(--mx-faint)]">
            {editing ? "▾" : "▸"}
          </span>
        </span>
      </button>
      {editing && (
        <div className="border-t border-[var(--mx-border)] px-3 py-2">
          <PricingEditor model={row.model} hit={hit} onSave={onSaveOverride} />
        </div>
      )}
    </div>
  );
}

/** 单价编辑器:四字段(USD / 1M tokens)+ 重置。空串按 0。 */
function PricingEditor({
  model,
  hit,
  onSave,
}: {
  model: string;
  hit: { pricing: ModelPricing; source: PricingSource } | null;
  onSave: (pricing: ModelPricing | null) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ModelPricing>(() =>
    hit ? { ...hit.pricing } : { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const numCls =
    "w-[64px] rounded-[var(--mx-radius-sm)] border border-[var(--mx-border-strong)] bg-[var(--mx-surface-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--mx-text)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--mx-accent)]";
  const field = (k: keyof ModelPricing, label: string) => (
    <label className="flex items-center gap-1 text-[10px] text-[var(--mx-muted)]">
      {label}
      <input
        className={numCls}
        type="number"
        step="0.01"
        min="0"
        value={form[k]}
        onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) || 0 })}
      />
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {field("in", t("settings.usage.fldIn"))}
      {field("out", t("settings.usage.fldOut"))}
      {field("cacheRead", t("settings.usage.fldCacheRead"))}
      {field("cacheWrite", t("settings.usage.fldCacheWrite"))}
      <span className="ml-auto flex items-center gap-1.5">
        {hit?.source === "override" && (
          <Button size="xs" variant="outline" onClick={() => onSave(null)}>
            {t("settings.usage.resetPrice")}
          </Button>
        )}
        <Button size="xs" onClick={() => onSave({ ...form })}>
          {t("common.save")}
        </Button>
      </span>
    </div>
  );
}
