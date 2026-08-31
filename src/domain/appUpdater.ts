/**
 * 应用更新全局状态(单例 store):启动自动检查(tauri-plugin-updater),结果供状态栏
 * 「新版本可用」提示与设置面板关于 tab 共享。检查失败静默(不打扰;面板手动检查
 * 会展示真实错误)。
 *
 * 检查时机:每次启动延迟 8s 检查一次(无跨启动节流——每次启动都查);窗口内
 * inFlight 防并发重入(主/独立窗口各查一次,latest.json 一次 GET,无害)。
 */
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdaterSnapshot =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "upToDate" }
  | { phase: "available"; update: Update }
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

/** 启动自动检查(每次启动执行一次;网络/接口异常静默落 error 态,不弹任何 UI)。 */
export async function autoCheckUpdate(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  publish({ phase: "checking" });
  try {
    const update = await check();
    console.info("[updater] autoCheck:", update ? `available v${update.version}` : "up-to-date(null)");
    publish(update ? { phase: "available", update } : { phase: "upToDate" });
  } catch (err) {
    console.warn("[updater] autoCheck failed:", err);
    publish({ phase: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    inFlight = false;
  }
}
