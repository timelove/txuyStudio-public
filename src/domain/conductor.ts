/**
 * Conductor(全局指挥)领域类型 —— 后端 `src-tauri/src/conductor/mod.rs` 的 camelCase 镜像。
 *
 * P0 规则层:会话语义态 + 全量快照(conductor_event / conductor_snapshot 命令)。
 * P1:驿站(InboxItem)+ 决策卡(DecisionRecord)+ 配置视图(ConductorConfigView)。
 * P2 在此追加记忆/常驻循环类型,不改动既有字段(serde default 零迁移)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 会话语义态(规则机输出,snake_case 与后端 `SessionKind` 对齐)。 */
export type ConductorSessionKind =
  | "idle"
  | "running"
  | "waiting_approval"
  | "finished"
  | "error"
  | "offline";

/** 单会话状态卡(projectName/tabTitle 由后端快照时富化)。 */
export type ConductorSession = {
  tabId: string;
  provider: "claude" | "codex";
  projectId: string;
  projectName: string;
  tabTitle: string;
  kind: ConductorSessionKind;
  /** 终态附言(出错原因 / 等待审批的工具名),常规态为 null。 */
  detail: string | null;
  lastEventMs: number;
};

/** 驿站条目状态(snake_case 与后端 `InboxStatus` 对齐;queued = 投递被占用全拦、
 * 排队等会话空闲终态自动补投)。 */
export type InboxItemStatus = "pending" | "queued" | "dispatched" | "done" | "dismissed";

/** 投递目标(多投:一条碎片可同时发给多个会话)。 */
export type InboxTarget = {
  projectId: string;
  tabId: string;
};

/** 碎片驿站条目(UI 名「驿站」;后端 `inbox::InboxItem`,序列化字段仍 `inbox`)。
 *  2026-11-12 起支持**重复投递**与**定时循环**(Pending/Dispatched/Done 都可再投);
 *  2026-11-13 起支持**多投**(targets 列表,巡检指令复用到多个项目)。 */
export type InboxItem = {
  id: string;
  text: string;
  /** 手选或 LLM 路由回填;null = 未路由(兼容字段,投递时同步为末位目标)。 */
  projectId: string | null;
  /** 路由可建议到具体会话(兼容字段,投递时同步为末位目标)。 */
  sessionId: string | null;
  createdMs: number;
  status: InboxItemStatus;
  /** 多投目标列表;重复投递与循环器都按它逐目标投。 */
  targets: InboxTarget[];
  /** 循环间隔(分钟);null = 一次性条目。循环到点按已选目标自动重投,文本原样。 */
  repeatMinutes: number | null;
  /** 循环开关(人可暂停/恢复)。 */
  repeatEnabled: boolean;
  /** 下次循环执行时间戳;0 = 未排程。 */
  nextRunMs: number;
  /** 累计投递次数(手动 + 循环)。 */
  dispatchCount: number;
  /** 最近一次成功投递时间戳;0 = 从未投出。 */
  lastDispatchMs: number;
  /** 连续失败轮数(≥3 后端自动停循环)。 */
  failStreak: number;
  /** 权限上限(P2c):任务期内派活目标代批判定不得超过此级;缺省/None = 不限制。
   *  随派活登记进 PendingVerdict,验收终态自动收回(旧后端缺字段)。 */
  permissionCeiling?: "confirm" | "deny" | null;
  /** 验收标准(可选):「做到什么才算完成」;随投递登记进 PendingVerdict,验收判定
   *  以标准命中为尺度、任务目标意图兜底;返工链原样保留;null = 只按目标意图判。 */
  acceptance?: string | null;
};

/** 决策卡类别(P1 主体 suggestion;dispatch/ask_human/memory_candidate P2 启用;
 *  verdict 验收回环卡 = 自动驾驶一期)。 */
export type DecisionKind =
  | "suggestion"
  | "dispatch"
  | "ask_human"
  | "memory_candidate"
  | "verdict";

/** 决策卡来源。 */
export type DecisionSource = "brain" | "inbox_downgrade" | "manual";

/** 决策卡状态。 */
export type DecisionStatus = "proposed" | "accepted" | "rejected" | "expired";

/** 决策卡(后端 `inbox::DecisionRecord`;最近 100 条随快照下发)。 */
export type DecisionRecord = {
  id: string;
  cycleMs: number;
  kind: DecisionKind;
  /** 卡面摘要(目标会话行,人读)。 */
  summary: string;
  /** 建议正文:accept/edit 时将以用户消息发给目标会话;ask_human 是问题文本;
   *  memory_candidate 是候选内容。 */
  text: string;
  targetProjectId: string | null;
  targetSessionId: string | null;
  /** P2 卡型载荷:dispatch {taskId, provider} / ask_human {options} /
   *  memory_candidate {entryId, kind};suggestion 卡带 {auto:true} = 已自动执行;
   *  verdict 卡(验收回环):{verdict: success|failed|rework|pending, goal, reason,
   *  rework?, sendFailed?, tabId}——pending=挂起(大脑不可用,下次终态补判);
   *  P4b 续段卡:{planContinue:true, nextGoal}——计划 finished 后智核建议的下一段意图,
   *  主动作是建新接力计划而非直接发送。 */
  payload: {
    taskId?: string;
    provider?: string;
    options?: string[];
    entryId?: string;
    kind?: string;
    auto?: boolean;
    verdict?: string;
    goal?: string;
    /** verdict 卡:投递时登记的验收标准(有值时卡面已内嵌「标准:」行)。 */
    acceptance?: string | null;
    reason?: string;
    rework?: string;
    sendFailed?: boolean;
    tabId?: string;
    planContinue?: boolean;
    nextGoal?: string;
  } | null;
  /** 本卡依据的记忆条目 id(「依据」chips;accept 时命中条目 hits+1)。 */
  usedMemoryIds: string[];
  source: DecisionSource;
  status: DecisionStatus;
  createdMs: number;
};

/** 记忆条目(后端 `memory::MemoryEntry`;P2)。confirmed=false 是候选,不注入 prompt。
 *  scopes:空 = 全局;非空 = 命中项目 id 列表(2026-11-16 支持多项目)。 */
export type MemoryEntry = {
  id: string;
  /** rule | preference | habit */
  kind: string;
  /** 命中项目 id 列表(空 = 全局)。 */
  scopes: string[];
  /** [legacy] 旧单项目 scope(加载迁移后不再出现)。 */
  scope?: string | null;
  content: string;
  /** observed(纠偏提炼/remember 意图) | explicit(人手填) | imported(种子导入) */
  source: string;
  confirmed: boolean;
  hits: number;
  lastUsedMs: number | null;
  createdMs: number;
};

/** `conductor_config_get` 返回:配置视图 + 大脑健康状态。
 *  大脑端点不在此返回——复用 claude 供应商(前端下拉读 localStorage `mx.claudeProviders`),
 *  token 全程不经过 conductor(单一真源在模型设置)。 */
export type ConductorConfigView = {
  config: {
    allowOrchestrator: boolean;
    /** 大脑端点独立配置(2026-11-13 反转「复用 claude 供应商」)。 */
    brainBaseUrl: string;
    /** token 脱敏摘要(****abcd);原文不经过任何命令回显。 */
    brainApiKeyMasked: string;
    /** token 是否已配置(前端据此显示「已配置」而非空输入框)。 */
    brainApiKeySet: boolean;
    /** 模型兜底链(有序多选):第一个不支持/异常自动降级下一个。 */
    brainModels: string[];
    /** 协议:"anthropic"(/v1/messages)| "openai"(/chat/completions)。 */
    brainApiFormat: string;
    occupiedLockMinutes: number;
    perCycleTokenBudget: number;
    /** 工具调用代批(本地规则):白名单内自动批,危险/未知转人。默认 true。 */
    autoApproveTools: boolean;
    /** auto 级代批宽限毫秒(2026-11-17「先弹卡再自动选」):宽限内原生卡照常挂出,
     *  人可手动选;到期无人接管才自动放行。0 = 立即放行(不弹卡)。旧后端缺,兜底 0。 */
    autoApproveDelayMs?: number;
    /** 建议自动执行:大脑自主产出的建议卡直接代发到目标 tab(同目标 30min 冷静窗)。默认 true。 */
    autoExecuteSuggestions: boolean;
    /** 孵化流水线(P4a):计划 finished 自动领取孵化下一条 pending 投递(同会话串行,
     *  占用锁让位、失败停摆)。默认 false;旧后端缺,兜底 false。 */
    pipeline?: boolean;
    /** 投递占用排队:手动投递被占用锁全拦 → 条目转排队,会话空闲终态自动补投;
     *  false = 降级建议卡(旧行为)。默认 true;旧后端缺,兜底 true。 */
    queueWhenOccupied?: boolean;
    /** 项目建议白名单(2026-11-23 用户:「针对项目级别加开关,不要动不动就给建议」):
     *  空数组 = 全部项目安静不出常规建议(Brain 源),列内项目才允许;Manual 测试豁免。
     *  旧后端缺,兜底 [](全安静)。 */
    suggestProjects?: string[];
    /** 建议静默窗(分钟,2026-11-17 与占用锁拆分):人 N 分钟内手动碰过的会话,
     *  终态不出常规建议卡(人正在驾驶,插话是噪音)。0 = 不静默(终态一律出卡)。
     *  占用锁管自动塞话的硬闸,本值只管出卡噪音的软闸,故独立且默认更短;旧后端缺,兜底 3。 */
    suggestQuietMinutes?: number;
    /** 权限分级表(P2a/P2b):自定义覆盖(内置表之上)。旧后端可能缺,兜底空表。 */
    permissionRules?: {
      tools: { tool: string; level: "auto" | "confirm" | "deny" }[];
      bash: { pattern: string; level: "auto" | "confirm" | "deny" }[];
    };
  };
  brainDegraded: boolean;
  brainDegradedUntilMs: number;
  brainFailStreak: number;
  /** 最近一次大脑调用失败原因(运行期;null = 正常)。 */
  lastBrainError: string | null;
  maxTokens: number;
  /** 项目级指挥台开关·黑名单(2026-11-16):名单内项目的会话事件不进感知链
   *  (不出会话卡/不计徽标/不产建议/不验收/不代批);手动投递不受影响。 */
  mutedProjects: string[];
};

/** `conductor_config_set` 的 patch 载荷(出现的字段才覆盖)。 */
export type ConductorConfigPatch = {
  allowOrchestrator?: boolean;
  brainBaseUrl?: string | null;
  /** 仅非空且非脱敏摘要时生效(后端拦 `****` 前缀)。 */
  brainApiKey?: string | null;
  /** 模型兜底链(有序);空数组 = 清空。 */
  brainModels?: string[];
  brainApiFormat?: string | null;
  occupiedLockMinutes?: number;
  perCycleTokenBudget?: number;
  autoApproveTools?: boolean;
  /** auto 级代批宽限毫秒(0 = 立即放行;后端 clamp 0..120000)。 */
  autoApproveDelayMs?: number;
  autoExecuteSuggestions?: boolean;
  /** 孵化流水线开关(P4a)。 */
  pipeline?: boolean;
  /** 投递占用排队开关(被占全拦 → 排队等空闲补投)。 */
  queueWhenOccupied?: boolean;
  /** 建议静默窗分钟(0 = 不静默;后端 clamp 0..240)。 */
  suggestQuietMinutes?: number;
  /** 权限分级表(P2b):整表替换。 */
  permissionRules?: {
    tools: { tool: string; level: "auto" | "confirm" | "deny" }[];
    bash: { pattern: string; level: "auto" | "confirm" | "deny" }[];
  };
};

/** `conductor_brain_probe` 返回:模型目录 + 延迟 + 错误。 */
export type BrainProbeResult = {
  latencyMs: number;
  status: number;
  models: string[];
  error: string | null;
};

/** 项目的 AI 会话 tab(pane tree 全量口径,**含未启动**):驿站投递的会话候选。
 *  shellKind ∈ claudepane/claude/codexpane/codex(与后端 AI_SHELL_KINDS 一致);
 *  命中的是「布局里存在的 tab」而非「在跑的会话」——投递时后端按需自动启动。 */
export type ConductorSessionTab = {
  id: string;
  title: string;
  shellKind: string;
  projectId: string;
};

/** 代批流水条目(autopilot:conductor 用本地规则代批 claude 工具调用)。
 *  P2a 三级分级:level=auto 已自动放行(CLI 自己执行,主窗口不弹卡);
 *  confirm/deny 转人(弹卡),deny 为高危档(只标注不自动拒绝)。
 *  verdict 是兼容字段(allow ⟺ level=auto)。 */
export type ConductorAutoApproval = {
  tabId: string;
  projectId: string;
  toolName: string;
  /** 人读摘要(Bash 取命令串,其余取路径/pattern,截断 120 字)。 */
  summary: string;
  verdict: "allow" | "escalate";
  /** 三级:"auto" | "confirm" | "deny"(旧后端可能缺,渲染处兜底)。 */
  level?: string;
  /** 命中来源:"default"(内置表) | "custom"(自定义规则;旧后端缺省)。 */
  source?: string;
  /** confirm/deny 的原因(命中哪条规则 / 危险模式);auto 为 null。 */
  reason: string | null;
  ms: number;
};

/** 编排单步状态(P3a)。queued=待发 / running=已派发等验收 / done=验收通过 /
 *  failed=验收失败 / skipped=失败步之后不再发。 */
export type PlanStepStatus = "queued" | "running" | "done" | "failed" | "skipped";

/** 编排计划状态:running=自动接力 / paused=人暂停(断点续跑)/ halted=失败即停或
 *  人工终止(可 retry 续跑)/ finished=全步验收通过。 */
export type PlanStatus = "running" | "paused" | "halted" | "finished";

/** 编排步(P3a)。 */
export type PlanStep = {
  id: string;
  /** 本步指令原文(发给目标会话)。 */
  text: string;
  status: PlanStepStatus;
  dispatchedMs: number;
  /** 终态判定回填;null = 未到终态。 */
  verdict: string | null;
};

/** 编排计划(P3a):大脑拆总意图为 ≤8 有序步,逐步派发复用一期验收回环。
 *  整计划同一目标会话 + 统一权限上限;终态保留供回看(上限 20 条)。 */
export type PlanRecord = {
  id: string;
  /** 用户总意图原文。 */
  goal: string;
  target: InboxTarget;
  /** 整计划统一权限上限("confirm"|"deny");null = 不限。 */
  permissionCeiling: "confirm" | "deny" | null;
  steps: PlanStep[];
  status: PlanStatus;
  /** halted 原因(第 N 步验收失败 / 发送失败 / 人工终止 / 静音暂停)。 */
  haltReason: string | null;
  createdMs: number;
  updatedMs: number;
};

/** 运行中任务(验收回环·待验收记录;每会话至多 1 条):已投出正在跑的活,
 *  决策流顶部「运行中」实时区数据源。 */
export type PendingVerdictView = {
  projectId: string;
  tabId: string;
  /** 任务目标(= 派活发送的文本原文)。 */
  goal: string;
  dispatchedMs: number;
  /** 该目标链上已自动返工次数。 */
  reworkCount: number;
  permissionCeiling: "confirm" | "deny" | null;
  /** 所属编排计划(null = 单步派活);接力徽标判据。 */
  planId: string | null;
  stepId: string | null;
};

/** `conductor_snapshot` 返回。attentionCount 是 **ack 前** 口径(见后端注释)。 */
export type ConductorSnapshot = {
  sessions: ConductorSession[];
  attentionCount: number;
  /** 全量项目(id/name,驿站投递下拉的数据源;全局口径,与窗口归属无关)。
   *  随每次快照刷新——主窗口增删项目后,指挥窗下次 refetch 即同步。 */
  projects: { id: string; name: string }[];
  /** 全量项目的 AI tab(含未启动):投递目标候选,替代原先「只有运行中会话」的口径。 */
  tabs: ConductorSessionTab[];
  inbox: InboxItem[];
  decisions: DecisionRecord[];
  /** 记忆条目(P2):候选+已确认都在,记忆分区分组渲染。 */
  memories: MemoryEntry[];
  /** 代批流水(最近 20 条,新的在前):指挥台自动批了哪些工具。 */
  autoApprovals: ConductorAutoApproval[];
  /** 编排计划(P3a,新的在前;旧后端可能缺,运行处兜底 [])。 */
  plans?: PlanRecord[];
  /** 运行中任务(待验收记录;旧后端缺,兜底 [])。 */
  pendingVerdicts?: PendingVerdictView[];
  /** Agent 实况拍(2026-11-19,新的在前;冷启动基线,增量走 conductor-tool-event;
   *  旧后端缺,兜底 [])。 */
  toolBeats?: ToolBeat[];
  /** 实况 XP 总账(2026-11-19 记录化:后端权威累计,跨重启不清零;旧后端缺,兜底 0
   *  → 前端退回窗口播种)。StageConsole 冷启动起步值。 */
  stageXp?: number;
  /** 最近一次大脑调用失败原因(运行期;null = 正常或从未失败)。决策流空态展示。 */
  lastBrainError: string | null;
  generatedMs: number;
};

/** Agent 实况单拍(后端 `conductor::ToolBeat`):一次工具调用 = 一拍
 *  (参考 CrommaCode Game View「每一次工具调用是一拍」)。seq 全局自增,
 *  快照与事件两路按 seq 归并防竞态丢拍。 */
export type ToolBeat = {
  seq: number;
  provider: string;
  projectId: string;
  tabId: string;
  /** 工具名:claude tool_use.name / codex "shell"·"mcp:server.tool"。 */
  tool: string;
  /** 目标一句话摘要(文件路径/命令/pattern,后端已截 120)。 */
  summary: string;
  ms: number;
};

/** `conductor-tool-event` 载荷:本帧新拍的数组(多数 1 条)。 */
export type ConductorToolEventPayload = { beats: ToolBeat[] };

/** `conductor_tool_beats` 只读命令返回(2026-11-19 记录化):最近 80 拍 + XP 总账。
 *  与快照的区别 = 无 ack 副作用(主窗口安全拉取)。 */
export type StageBeatsReadonly = { beats: ToolBeat[]; xp: number };

/** 实况拍归并(快照基线 + 事件增量两路汇聚):按 seq 去重,新的在前,截前 80 条。
 *  快照拉取期间又到的事件不会丢——后到的 seq 总能胜出重排。 */
export function mergeToolBeats(a: ToolBeat[], b: ToolBeat[]): ToolBeat[] {
  const m = new Map<number, ToolBeat>();
  for (const x of a) m.set(x.seq, x);
  for (const x of b) m.set(x.seq, x);
  return [...m.values()].sort((x, y) => y.seq - x.seq).slice(0, 80);
}

/** `conductor-event` 载荷:kind = attention 状态机 / inbox 驿站 / decision 决策卡 /
 *  memory 记忆变化(P2)。 */
export type ConductorEventPayload = {
  attentionCount: number;
  kind: "attention" | "inbox" | "decision" | "memory";
};

/** `fleet-dispatch` 事件载荷(P2):dispatch 卡确认后主窗口自动挂 worker tab。 */
export type FleetDispatchPayload = {
  projectId: string;
  worker: { id: string; provider: string; branch: string; worktreePath: string };
  /** worker tab 建好后的首条指令(意图的 taskText,人可在卡上改过)。 */
  firstMessage: string;
};

/**
 * 驿站循环 chip(2026-11-13):后端循环投递成功广播 `conductor-repeat-fired`,
 * ClaudePane/CodexPane 按 tabId 匹配亮「驿站循环中」chip 并提供一键关循环——
 * 此前 pane 被循环投递抢占成 running/waiting,但循环开关只在指挥窗驿站里,
 * pane 内无从停止。TTL = 间隔 + 30s:下一轮该来而没来(被停/删条目/连续失败
 * 自动停)chip 自动熄灭;循环仍在则下轮投递事件再亮。
 */
export function useConductorRepeatBadge(tabId: string | null | undefined): {
  active: boolean;
  stop: () => void;
} {
  const [itemId, setItemId] = useState<string | null>(null);
  useEffect(() => {
    if (!tabId) {
      setItemId(null);
      return;
    }
    let alive = true;
    let timer = 0;
    const un = listen<{ tabId: string; itemId: string; minutes: number }>(
      "conductor-repeat-fired",
      (e) => {
        if (!alive || e.payload.tabId !== tabId) return;
        setItemId(e.payload.itemId);
        window.clearTimeout(timer);
        timer = window.setTimeout(
          () => {
            if (alive) setItemId(null);
          },
          e.payload.minutes * 60_000 + 30_000,
        );
      },
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
      void un.then((f) => f());
    };
  }, [tabId]);
  const stop = useCallback(() => {
    const id = itemId;
    setItemId(null);
    if (id) {
      void invoke("conductor_inbox_set_repeat", { id, minutes: null, enabled: false }).catch(() => {});
    }
  }, [itemId]);
  return { active: itemId !== null, stop };
}

/** 指挥台代批判定级(P2b 审批卡强警示):后端 autopilot 广播 `conductor-verdict`,
 *  pane 按 requestId 匹配给审批卡加样式标——deny 红色高危、confirm 琥珀、
 *  auto 宽限倒计时(2026-11-17「先弹卡再自动选」,delayMs 到点后端自动放行;
 *  2026-11-18 倒计时改活秒递减:500ms 心跳驱动重渲染,卡上「N 秒后自动批准」实时走)。
 *  TTL:confirm/deny 10min 兜底;auto = delayMs + 3s(到点后端放行,倒计时条撤)。 */
export function useConductorVerdicts(
  tabId: string | null | undefined,
): Map<
  string,
  { level: "auto" | "confirm" | "deny"; reason: string | null; delayMs?: number; receivedAt: number }
> {
  const [verdicts, setVerdicts] = useState<
    Map<string, { level: "auto" | "confirm" | "deny"; reason: string | null; delayMs?: number; receivedAt: number }>
  >(() => new Map());
  const verdictsRef = useRef(verdicts);
  verdictsRef.current = verdicts;
  useEffect(() => {
    if (!tabId) {
      setVerdicts(new Map());
      return;
    }
    let alive = true;
    const timers: number[] = [];
    const un = listen<{
      tabId: string;
      requestId: string;
      level: string;
      reason: string | null;
      delayMs?: number;
    }>("conductor-verdict", (e) => {
      if (!alive || e.payload.tabId !== tabId) return;
      const level = e.payload.level === "deny" ? "deny" : e.payload.level === "auto" ? "auto" : "confirm";
      const next = new Map(verdictsRef.current);
      next.set(e.payload.requestId, {
        level,
        reason: e.payload.reason,
        delayMs: e.payload.delayMs,
        receivedAt: Date.now(),
      });
      setVerdicts(next);
      // auto 级到点后端自动放行,倒计时条跟着撤(留 3s 缓冲防钟差闪红);
      // confirm/deny 转人,10min 兜底自然回归普通样式。
      const ttl = level === "auto" ? (e.payload.delayMs ?? 5_000) + 3_000 : 10 * 60_000;
      timers.push(
        window.setTimeout(() => {
          if (!alive) return;
          setVerdicts((m) => {
            const nm = new Map(m);
            nm.delete(e.payload.requestId);
            return nm;
          });
        }, ttl),
      );
    });
    return () => {
      alive = false;
      timers.forEach((id) => window.clearTimeout(id));
      void un.then((f) => f());
    };
    // verdictsRef 规避闭包旧值;tabId 切换即清空(判定随卡,不跨 tab)。
  }, [tabId]);
  // 倒计时心跳(2026-11-18 用户:「按理说你也要给我倒计时显示」):有未到点的 auto
  // 判定时 500ms 一跳驱动重渲染,ClaudePane 卡上读 Date.now() 算剩余秒;到点后
  // TTL 兜底移除触发本 effect 重跑即停跳,平时零开销。
  const [, setBeat] = useState(0);
  useEffect(() => {
    const counting = [...verdicts.values()].some(
      (v) => v.level === "auto" && (v.delayMs ?? 0) > 0 && Date.now() - v.receivedAt < v.delayMs!,
    );
    if (!counting) return;
    const id = window.setInterval(() => setBeat((x) => x + 1), 500);
    return () => window.clearInterval(id);
  }, [verdicts]);
  return verdicts;
}

/** 指挥台宽限代批落定留痕(2026-11-18 用户:「自动批准后消息流中的批准卡消失」):
 *  后端 delayed_auto_allow 代发成功即广播 `conductor-auto-approved`(带 toolName/
 *  summary),审批坞下方挂一条淡绿幽灵行——批了什么工具/命令一眼可查,60s 淡出,
 *  上限 5 条防堆积。人手批的不进来(那是人自己的选择,卡消失即闭环)。 */
export function useConductorAutoGhosts(
  tabId: string | null | undefined,
): { requestId: string; toolName: string; summary: string; ms: number }[] {
  const [ghosts, setGhosts] = useState<{ requestId: string; toolName: string; summary: string; ms: number }[]>([]);
  const ghostsRef = useRef(ghosts);
  ghostsRef.current = ghosts;
  useEffect(() => {
    if (!tabId) {
      setGhosts([]);
      return;
    }
    let alive = true;
    const un = listen<{ tabId: string; requestId: string; toolName: string; summary: string }>(
      "conductor-auto-approved",
      (e) => {
        if (!alive || e.payload.tabId !== tabId) return;
        const entry = { requestId: e.payload.requestId, toolName: e.payload.toolName, summary: e.payload.summary, ms: Date.now() };
        setGhosts((g) => [...g.slice(-4), entry]);
        window.setTimeout(() => {
          if (!alive) return;
          setGhosts((g) => g.filter((x) => x !== entry));
        }, 60_000);
      },
    );
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, [tabId]);
  return ghosts;
}
