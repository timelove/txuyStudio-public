/**
 * 前端性能采样器(设置 → 性能面板专用)。
 *
 * 指标全部浏览器原生、被动、亚毫秒开销:rAF 计帧(FPS)、PerformanceObserver
 * longtask(>50ms 主线程卡顿,卡顿定位最直接)、事件循环 ping 延迟、DOM 节点总数
 * (长会话 DOM 膨胀的直接指标)、performance.memory JS 堆(仅 Chromium/WebView2 有)。
 *
 * 每秒回调一次快照;面板卸载即停止(非常驻,监控本身不引入开销)。
 */

export type PerfSample = {
  /** 采样秒内的帧率(rAF 计数)。窗口最小化/隐藏时 rAF 暂停,值为 0 属正常。 */
  fps: number;
  /** 采样秒内 >50ms 长任务次数。 */
  longTasks: number;
  /** 采样秒内最长长任务耗时(ms)。 */
  longestTaskMs: number;
  /** 文档 DOM 节点总数。 */
  domNodes: number;
  /** JS 堆已用(MB)。WebView2 有 performance.memory;不可用为 null。 */
  jsHeapMb: number | null;
  /** JS 堆上限(MB)。 */
  heapLimitMb: number | null;
  /** 采样秒内事件循环最大延迟(ms)——setTimeout(200) 回调实际超时量。 */
  loopLagMs: number;
};

/** performance.memory 的 Chromium 私有类型(TS 标准库无)。 */
type PerfMemory = { usedJSHeapSize: number; jsHeapSizeLimit: number };

/**
 * 启动采样器,返回停止函数。每 ~1s 回调一次快照。
 * 实现细节:三路独立采集(rAF 计帧 / longtask observer / ping 延迟),汇总定时器统一收口。
 */
export function startPerfSampler(onSample: (s: PerfSample) => void): () => void {
  let frames = 0;
  let longTasks = 0;
  let longestTaskMs = 0;
  let loopLagMs = 0;
  let stopped = false;

  // 1) FPS:rAF 空转计数(每帧一个 ++,开销可忽略)。
  let rafId = 0;
  const tick = () => {
    if (stopped) return;
    frames++;
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  // 2) 长任务:PerformanceObserver 被动监听。
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks++;
        longestTaskMs = Math.max(longestTaskMs, entry.duration);
      }
    });
    observer.observe({ type: "longtask", buffered: false });
  } catch {
    observer = null; // 不支持则置空,指标归零显示。
  }

  // 3) 事件循环延迟:200ms ping,回调实际晚到量即 lag。
  const PING_MS = 200;
  let pingId = 0;
  const ping = () => {
    if (stopped) return;
    const scheduled = Date.now();
    pingId = window.setTimeout(() => {
      if (stopped) return;
      loopLagMs = Math.max(loopLagMs, Math.max(0, Date.now() - scheduled - PING_MS));
      ping();
    }, PING_MS);
  };
  ping();

  // 4) 每秒汇总 + 重置。
  const summaryId = window.setInterval(() => {
    if (stopped) return;
    const mem = (performance as unknown as { memory?: PerfMemory }).memory;
    onSample({
      fps: frames,
      longTasks,
      longestTaskMs,
      domNodes: document.getElementsByTagName("*").length,
      jsHeapMb: mem ? mem.usedJSHeapSize / 1048576 : null,
      heapLimitMb: mem ? mem.jsHeapSizeLimit / 1048576 : null,
      loopLagMs,
    });
    frames = 0;
    longTasks = 0;
    longestTaskMs = 0;
    loopLagMs = 0;
  }, 1000);

  return () => {
    stopped = true;
    cancelAnimationFrame(rafId);
    window.clearTimeout(pingId);
    window.clearInterval(summaryId);
    observer?.disconnect();
  };
}
