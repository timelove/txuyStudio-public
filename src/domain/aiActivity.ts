/**
 * AI 工作轨迹图谱 domain(graph pane;plan: .work/design/20261021-graph-pane)。
 * 后端 `list_ai_activity` 扫会话 jsonl 提取「会话 × 文件 × 模型」关系,此处仅类型镜像 +
 * invoke 封装。模型节点由前端从 sessions 按模型分组派生(后端不单列)。
 */

import { invoke } from "@tauri-apps/api/core";

/** 后端 ActivitySession 镜像(serde camelCase)。 */
export type ActivitySession = {
  /** 会话 id(jsonl 文件名;uuid,显示截短 8 位)。 */
  id: string;
  app: string;
  model: string;
  requests: number;
  tokens: number;
  firstTs: string;
  lastTs: string;
};

/** 后端 ActivityFile 镜像。 */
export type ActivityFile = {
  path: string;
  reads: number;
  writes: number;
  sessions: number;
};

/** 后端 ActivityEdge 镜像(session/file 是 sessions/files 数组下标)。 */
export type ActivityEdge = {
  session: number;
  file: number;
  reads: number;
  writes: number;
};

/** 后端 AiActivityGraph 镜像。 */
export type AiActivityGraph = {
  sessions: ActivitySession[];
  files: ActivityFile[];
  edges: ActivityEdge[];
};

/** 拉取近 N 天 AI 工作轨迹(重 IO,后端 spawn_blocking;失败返回空图)。 */
export async function fetchAiActivity(days: number): Promise<AiActivityGraph> {
  try {
    return await invoke<AiActivityGraph>("list_ai_activity", { days });
  } catch (err) {
    console.warn("[graph] list_ai_activity failed:", err);
    return { sessions: [], files: [], edges: [] };
  }
}
