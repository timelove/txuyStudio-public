import React from "react";
import ReactDOM from "react-dom/client";
// monacoSetup 不再在首屏静态 import:它顶层会拉满 monaco-editor(4.2MB)+5 worker,
// 是首屏加载过慢根因(dev 下 Vite 预扫描/编译整个 monaco ESM 图)。改为在 FileTreePane
// 首次挂载时动态 import("../monacoSetup") 触发(loader.config/defineTheme/getWorker 幂等),
// 让 monaco 只在用户真正打开「探针」pane 时才加载。详见 .work/.../首屏优化 plan。
import "./i18n"; // 顶层副作用:初始化 i18next(lng 取 localStorage 兜底),必须早于 App 渲染
import i18n from "./i18n";
import App from "./App";
import { TooltipProvider } from "./components/ui/Tooltip";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/app.css";
import "./styles/xterm.css";

// 启动 splash 文案覆写:index.html 的「正在加载工作区…」是静态中文,hydrate 前无法接入 React i18n。
// 按 i18next 当前 locale(hydrate 前用 localStorage 兜底)覆写 .bs-hint 文本,避免给中文用户闪一下英文。
// React 首帧 LoadingSurface 会接管 #root,splash 随之移除,此处仅覆盖极短的 JS 加载期。
try {
  const hint = document.querySelector("#boot-splash .bs-hint");
  if (hint) {
    hint.textContent = i18n.language === "en" ? "Loading workspace…" : "正在加载工作区…";
  }
} catch {
  // 非 Tauri/SSR 兜底,忽略。
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* ErrorBoundary 兜底:任何子树 render/生命周期抛错渲染错误态 + 重置,而非整窗黑屏
        (整个应用此前无错误边界,Monaco disposed model throw 等会致整窗黑屏无提示)。
        放最外层,连 TooltipProvider 一起兜。 */}
    <ErrorBoundary>
      {/* TooltipProvider 全局包裹:所有 Radix Tooltip 共享 ~400ms 延迟。
          放 StrictMode 内、App 外(独立于 App 的 loadState 早返回分支,provider 树始终在)。 */}
      <TooltipProvider delayDuration={400}>
        <App />
      </TooltipProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

// 消除打包后启动白屏:窗口默认 hidden(tauri.conf.json visible:false),
// 等到 React 首帧(App 的 LoadingSurface 或 #boot-splash)真正上屏后再通知后端 show 窗口,
// 用户看到的第一帧即深色 splash 而非 WebView2 冷启动白屏。
//
// 时机:两层 requestAnimationFrame——render() 调度首帧 commit,第一层 rAF 在该帧绘制前回调
// (此时 DOM 已 commit 但未绘制),第二层 rAF 确保浏览器已完成本次绘制,splash 已可见,
// 此时 show 窗口才不会闪白。非 Tauri 环境(纯浏览器 dev)invoke 抛错被吞,无副作用。
//
// 与后端 2.5s 兜底定时器配合:正常路径先于此触发;若 JS 崩溃调不到此处,后端兜底强制 show。
try {
  // 动态 import 避免非 Tauri 环境顶层引入 @tauri-apps/api/core 报错;亦使本逻辑不进首屏主 bundle。
  void import("@tauri-apps/api/core").then(({ invoke }) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        invoke("show_window").catch(() => {});
      }),
    ),
  );
} catch {
  // 非 Tauri 环境兜底,忽略。
}

// 链接一律走系统外部浏览器打开:消息流 markdown(marked)等生成的 `<a href>` 默认在 WebView
// 内导航,整个应用会被替换成目标网页(无地址栏/无返回),必须拦截。全局捕获阶段监听 click,
// 命中 http(s)/mailto 链接 -> preventDefault + opener(tauri-plugin-opener)外开;锚点(#)与
// 相对链接不拦(应用内行为)。HtmlPreviewPane 的 iframe(srcdoc)内点击不冒泡到主文档,不受影响。
// 动态 import 同上(非 Tauri 环境不引入;失败兜底 window.open)。
document.addEventListener(
  "click",
  (e) => {
    const anchor = (e.target as Element | null)?.closest?.("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:)/i.test(href)) return;
    e.preventDefault();
    void import("@tauri-apps/plugin-opener")
      .then(({ openUrl }) => openUrl(href))
      .catch(() => {
        try {
          window.open(href, "_blank", "noopener");
        } catch {
          // 非 Tauri 且弹窗被拦等极端情况,忽略。
        }
      });
  },
  true,
);
