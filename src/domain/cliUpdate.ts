/**
 * AI CLI 新版本提示(2026-11-17 用户:「针对 ai pane,加个自动更新提示的功能」)。
 *
 * 后端 `check_cli_update` 实跑本机 `--version` 对比 npm registry 最新版;前端按
 * provider 消费:有新版且未被本次忽略时,AI pane 输入区上方出一条提示(给升级
 * 命令,不代跑)。检查全局节流 6h(localStorage 缓存),同会话多 pane 共享一次。
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type CliUpdateInfo = {
  provider: string;
  /** 本机版本;null = 未安装或取不到。 */
  current: string | null;
  /** npm 最新版;null = 查询失败(离线/慢网),不提示。 */
  latest: string | null;
  updateAvailable: boolean;
};

const CACHE_KEY = "mx.cliUpdateCheck";
const DISMISS_KEY = "mx.cliUpdateDismissed";
/** 检查节流:6h 一次(应用常驻,不必每次启动都打 registry)。 */
const CHECK_INTERVAL = 6 * 60 * 60_000;
/** 同窗广播:任一 pane 点「知道了」,其他 AI pane 的提示条同步消失
 *  (storage 事件只广播到其他 document,同窗内组件收不到,走 CustomEvent)。 */
const DISMISS_EVENT = "mx-cli-update-dismissed";

type DismissDetail = { provider: "claude" | "codex"; latest: string };

type Cache = { ts: number; claude?: CliUpdateInfo; codex?: CliUpdateInfo };

let inflight: Promise<Cache> | null = null;

function readCache(): Cache {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as Cache;
  } catch {
    return { ts: 0 };
  }
}

/** 全局单飞:首个 pane 挂载触发,并发调用共享同一 Promise;缓存新鲜直接回。 */
function ensureCheck(): Promise<Cache> {
  const cached = readCache();
  if (Date.now() - (cached.ts ?? 0) < CHECK_INTERVAL && cached.ts) return Promise.resolve(cached);
  if (!inflight) {
    inflight = (async () => {
      const next: Cache = { ts: Date.now() };
      for (const provider of ["claude", "codex"] as const) {
        try {
          next[provider] = await invoke<CliUpdateInfo>("check_cli_update", { provider });
        } catch {
          // 非 Tauri 运行时 / 离线:留空,写时间戳防本轮重复打。
        }
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(next));
      inflight = null;
      return next;
    })();
  }
  return inflight;
}

/** 该 pane 的更新提示(有新版且未忽略时非 null)+ 忽略动作(按版本记住,升级后新版本号自然重现)。 */
export function useCliUpdateHint(
  provider: "claude" | "codex",
): { info: CliUpdateInfo | null; dismiss: () => void } {
  const [info, setInfo] = useState<CliUpdateInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void ensureCheck().then((cache) => {
      const v = cache[provider];
      if (!alive || !v?.updateAvailable || !v.latest || !v.current) return;
      try {
        const dismissed = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "{}") as Record<string, string>;
        if (dismissed[provider] === v.latest) return;
      } catch {
        // ignore:坏数据当没忽略过
      }
      setInfo(v);
    });
    // 其他 pane 点了「知道了」→ 清掉同 provider 同版本的本地条目(函数式更新防 stale 闭包)。
    const onDismiss = (e: Event) => {
      if (!alive) return;
      const d = (e as CustomEvent<DismissDetail>).detail;
      if (d?.provider !== provider) return;
      setInfo((prev) => (prev && prev.latest === d.latest ? null : prev));
    };
    window.addEventListener(DISMISS_EVENT, onDismiss);
    return () => {
      alive = false;
      window.removeEventListener(DISMISS_EVENT, onDismiss);
    };
  }, [provider]);
  const dismiss = () => {
    const latest = info?.latest;
    setInfo(null);
    if (!latest) return;
    try {
      const dismissed = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "{}") as Record<string, string>;
      dismissed[provider] = latest;
      localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed));
    } catch {
      // ignore
    }
    // 广播给同窗其他 pane(挂载中/后挂载都会先读 localStorage,不会再亮)。
    window.dispatchEvent(
      new CustomEvent<DismissDetail>(DISMISS_EVENT, { detail: { provider, latest } }),
    );
  };
  return { info, dismiss };
}
