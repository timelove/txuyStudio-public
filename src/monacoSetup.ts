/**
 * Monaco 离线 worker 配置(模块顶层副作用,被 main.tsx 首个 import 触发一次)。
 *
 * 背景:`@monaco-editor/react` 默认从 jsdelivr CDN 加载 monaco-editor,在 Tauri 桌面离线
 * 环境会卡在「Loading…」/ worker 加载失败。此处注入本地 `monaco-editor` 实例 +
 * `MonacoEnvironment.getWorker` 用 Vite `?worker` 后缀(原生支持,无需 plugin)。
 *
 * M2 编辑按语言返回对应 worker:TS/JS→ts.worker(补全/诊断/格式化)、JSON→json.worker(校验)、
 * CSS/SCSS/LESS→css.worker、HTML→html.worker,其余→editor.worker(纯高亮)。
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Vite 把 `?worker` 后缀的 import 编译成 Web Worker 构造器;挂到 MonacoEnvironment 供 Monaco 按需 spawn。
// M1 只读预览只需 editor.worker(语法高亮无需语言 worker);M2 编辑按语言 label 返回对应语言 worker
// (TS/JS→补全/诊断/格式化,JSON→校验,CSS/HTML→补全)。未命中 label 回退 editor.worker(纯高亮)。
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// 用本地 monaco-editor 实例,禁用 @monaco-editor/react 默认的 CDN loader。
loader.config({ monaco });

/**
 * 自定义主题「mx-dark」:对齐项目深蓝/cyan 主题(token 见 app.css :root)。
 * base=vs-dark + inherit=true 保留内置语法高亮质量,仅覆盖 chrome 层颜色,
 * 让编辑器无缝融入预览面板(FilePreview 容器背景同为 #0b1020,无接缝)。
 * 滚动条滑块用 #94a3b8@0.3/0.55/0.65,与 .mx-scroll-pretty 的 thumb 完全一致
 * (文件树 / 图片预览滚动条同款),8 位 hex 末两位为 alpha。
 */
monaco.editor.defineTheme("mx-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0b1020",
    "editor.foreground": "#cbd5e1",
    "editorGutter.background": "#0b1020",
    "editorLineNumber.foreground": "#475569",
    "editorLineNumber.activeForeground": "#94a3b8",
    "editor.lineHighlightBackground": "#00000000",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#22d3ee2e",
    "editor.inactiveSelectionBackground": "#22d3ee1a",
    "editor.selectionHighlightBackground": "#22d3ee1a",
    "editorCursor.foreground": "#22d3ee",
    "editorIndentGuide.background1": "#94a3b81f",
    "editorIndentGuide.activeBackground1": "#94a3b83d",
    "editorBracketMatch.background": "#22d3ee1f",
    "editorBracketMatch.border": "#22d3ee73",
    "editorWidget.background": "#0b1020",
    "editorWidget.border": "#94a3b824",
    "editorHoverWidget.background": "#0b1020",
    // 滚动条:容器宽度由 options verticalScrollbarSize:8 控制,
    // 滑块的收窄/展宽/颜色由 app.css 的 .monaco-scrollable-element 覆盖(对齐 xterm)。
    // 此处 scrollbarSlider 仅作 base 色(CSS hover 态单独覆盖),shadow 关掉匹配极简取向。
    "scrollbarSlider.background": "#94a3b847",
    "scrollbarSlider.hoverBackground": "#94a3b880",
    "scrollbarSlider.activeBackground": "#94a3b880",
    "scrollbar.shadow": "#00000000",
    "editorOverviewRuler.border": "#00000000",
  },
});

export {};
