import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { version } from "./package.json";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 注入 package.json 版本号为全局常量,SettingsModal 等处直接引用,
  // 版本号单一真相源在 package.json,发版无需再改前端代码。
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  clearScreen: false,
  server: {
    host: true, // 0.0.0.0 等价:Windows 上让「localhost」(IPv4/IPv6) 都能解析到 vite,vite 7 + node 22 在 Windows 上 host: "127.0.0.1" 不响应
    port: 1420,
    strictPort: true,
    watch: {
      // ── dev 冷启动卡死的根因(2026-10-19 实测定位)─────────────────────────────
      // chokidar 默认递归监听项目根。本项目 Rust 编译产物体量:
      //   src-tauri/target 42G + src-gpui/target 22G + gpui-lab/target 4.4G
      //   + crates/txuy-core/target 436M  ≈ 69G
      // 不排除 → 冷启遍历这 69G 的数十万文件,Windows 上 CPU 满载、阻塞事件循环,
      // dev server 端口虽 LISTENING 但收到请求**永不响应**(curl 5s 0 字节;
      // 浏览器表现为「加载工作区」永久转圈 / 黑屏)。
      //
      // 两条硬约束(踩过坑):
      // 1) 必须用 **RegExp**,不能用 glob 字符串 —— chokidar 走 anymatch,glob 里的
      //    `/` 与 Windows 路径的 `\` 不匹配,`"**/target/**"` 直接失效(实测仍扫全量)。
      //    RegExp 用 [\\/] 兼容两种分隔符。
      // 2) 必须匹配**目录路径本身**(`[\\/]target([\\/]|$)`)—— 只匹配其下文件的形式
      //    仍会进入目录做递归遍历,等于没排除。
      //
      // 用 `([\\/]|$)` 而非 `[\\/]` 是为了同时命中「目录自身」与「其下文件」两种路径形态。
      // node_modules/.git 是 vite 默认项,一旦显式声明 watch.ignored 就会**替换**默认值,
      // 故必须一并列出。
      ignored: [
        /[\\/]target([\\/]|$)/, // 所有 Rust target(src-tauri / src-gpui / gpui-lab / crates)
        /[\\/]gpui-lab([\\/]|$)/, // GPUI 实验目录整树(仅 gpui 分支跟踪)
        /[\\/]src-gpui([\\/]|$)/, // GPUI 分支源码 + 产物(Tauri 前端 HMR 用不到)
        /[\\/]node_modules([\\/]|$)/,
        /[\\/]\.git([\\/]|$)/,
      ],
    },
  },
  optimizeDeps: {
    // monaco-editor(4.2MB ESM 图,含几十个 basic-languages 包)不预打包。
    // 背景:FileTreePane 的动态 `import("../monacoSetup")` 会被 optimizeDeps scanning 扳到,
    // 把整个 monaco 图(abap/apex/.../editor 各语言 service)纳入预打包。exclude 后 monaco 运行时
    // 按需 ESM 加载(用户打开探针才加载,与懒加载一致)。仅影响 dev(build 走 rollup manualChunks)。
    exclude: ["monaco-editor"],
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // 手动分包:把大依赖拆出独立 chunk,主 bundle 不再超 500KB(Tauri 本地加载,分包
    // 主要收益是消警告 + 加快增量缓存命中;对终端用户加载延迟影响微乎其微)。
    // - xterm:终端库本身大,单独成包。
    // - react:框架运行时,稳定不变,独立 chunk 利于长缓存。
    // - tauri-api:后端桥接,独立 chunk。
    // - monaco:Monaco 主体 ~3MB,单独成包避免撑爆主 bundle(预览面板按需加载)。
    // 注:Vite 8 用 rolldown,manualChunks 须为函数(对象形式不支持)。
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@xterm/")) return "xterm";
          if (
            id.includes("node_modules/react") ||
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/scheduler")
          ) {
            return "react";
          }
          if (id.includes("@tauri-apps/api")) return "tauri-api";
          if (id.includes("monaco-editor") || id.includes("@monaco-editor/react")) {
            return "monaco";
          }
          // radix:浮层原语(Dialog/Popover/ContextMenu/Tooltip/Tabs),统一成包,
          // 避免散进主 bundle 影响首屏与增量缓存。
          if (id.includes("@radix-ui/")) return "radix";
          // md 渲染:marked + dompurify,探针 M2 md 预览用(MdPreview 动态 import 懒加载)。
          if (id.includes("node_modules/marked") || id.includes("node_modules/dompurify") || id.includes("node_modules/purify")) {
            return "md-render";
          }
        },
      },
    },
  },
});
