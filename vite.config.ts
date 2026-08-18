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
    port: 1420,
    strictPort: true,
    watch: {
      // 排除 Rust 编译产物(src-tauri/target 近 2 万 debug+release 文件)。vite 的 chokidar
      // watcher 默认递归监听项目根,target 不在默认 ignore 列表,冷启动初始化时要遍历全部
      // ~19386 个编译产物文件,在 Windows 上 CPU 满载、阻塞事件循环数分钟 → dev server 完全
      // 不响应(浏览器死卡在 splash「正在加载工作区」)。这是 dev 冷启动卡死的真正根因
      // (与 vite 版本/runtime/插件/依赖全无关——之前怀疑的 radix/tailwind/vite8 都是被它掩盖的)。
      // 排除后 watcher 初始化秒级,冷启动恢复正常;HMR 本就只该监听 src 前端代码。
      // 用正则匹配「目录路径本身」(而非 glob `.../target/**` 只匹配其下文件)——chokidar 遍历到
      // src-tauri/target 目录时即跳过整个子树,不递归读近 2 万个 Rust 编译产物文件。glob 形式
      // 只过滤文件、仍会进入目录遍历,等于没排除。同时显式带上 node_modules/.git(vite 默认项,
      // 覆盖 watch.ignored 时会替换默认,需一并声明)。
      ignored: [/node_modules/, /\.git/, /src-tauri[\\/]target/],
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
