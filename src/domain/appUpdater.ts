/**
 * 应用更新全局状态(单例 store):启动自动检查,结果供状态栏「新版本可用」提示与
 * 设置面板关于 tab 共享。检查失败静默(不打扰;面板手动检查会展示真实错误)。
 *
 * 检查时机:每次启动延迟 8s 检查一次(无跨启动节流——每次启动都查);窗口内
 * inFlight 防并发重入(主/独立窗口各查一次,latest.json 一次 GET,无害)。
 *
 * 2026-11-18 起走 Rust 侧 `check_for_updates` 命令(不再直接用插件 JS `check()`):
 * 自定义更新源(MinIO)需动态 endpoints,插件 JS API 不支持;Rust `Update` 对象
 * 不可序列化,故前端只持有这份可序列化摘要(下载/安装也全在 Rust 侧命令里)。
 */
import { invoke } from "@tauri-apps/api/core";

/** 检查结果摘要(与 Rust `updater::UpdateInfo` 对齐;available=false 时其余字段缺省)。 */
export interface UpdateInfo {
  available: boolean;
  version?: string;
  currentVersion?: string;
  /** 更新日志(latest.json notes,markdown 原文)。 */
  body?: string;
}

export type UpdaterSnapshot =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "upToDate" }
  | { phase: "available"; info: UpdateInfo }
  | { phase: "error"; message: string };

// store 挂 globalThis:Vite HMR 更新本模块时会生成新模块实例(旧 listeners 丢失、
// publish 与 subscribe 落在不同实例上,通知断链——「面板 available 但状态栏 chip 不出」
// 即此)。挂到全局保证热更后仍是同一个 store。
interface UpdaterStore {
  snapshot: UpdaterSnapshot;
  listeners: Set<(s: UpdaterSnapshot) => void>;
}
const g = globalThis as { __mxUpdaterStore?: UpdaterStore };
const store: UpdaterStore = (g.__mxUpdaterStore ??= {
  snapshot: { phase: "idle" },
  listeners: new Set(),
});
let snapshot = store.snapshot;
const listeners = store.listeners;

function publish(next: UpdaterSnapshot) {
  snapshot = next;
  store.snapshot = next;
  for (const l of listeners) l(snapshot);
}

/** 订阅快照(立即回调当前值),返回取消函数。 */
export function subscribeUpdater(cb: (s: UpdaterSnapshot) => void): () => void {
  listeners.add(cb);
  cb(snapshot);
  return () => {
    listeners.delete(cb);
  };
}

export function getUpdaterSnapshot(): UpdaterSnapshot {
  return snapshot;
}

/** 手动/安装完成后由面板调用,同步全局(如安装完成 → upToDate 让状态栏 chip 消失)。 */
export function publishUpdater(next: UpdaterSnapshot) {
  publish(next);
}

let inFlight = false;

/** 检查更新(Rust 命令;源 = 自定义 endpoint 或 GitHub 默认,见 updater.rs)。 */
export async function checkUpdate(): Promise<UpdaterSnapshot> {
  const info = await invoke<UpdateInfo>("check_for_updates");
  return info.available ? { phase: "available", info } : { phase: "upToDate" };
}

/** 启动自动检查(每次启动执行一次;网络/接口异常静默落 error 态,不弹任何 UI)。 */
export async function autoCheckUpdate(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  publish({ phase: "checking" });
  try {
    const next = await checkUpdate();
    console.info("[updater] autoCheck:", next.phase === "available" ? `available v${next.info.version}` : "up-to-date");
    publish(next);
  } catch (err) {
    console.warn("[updater] autoCheck failed:", err);
    publish({ phase: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    inFlight = false;
  }
}
