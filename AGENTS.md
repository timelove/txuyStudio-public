# AGENTS.md

This file provides guidance to Codex agents when working with code in this repository.

请尽量使用简体中文与用户对话，并在回答时保持专业、简洁。

## 项目定位

**txuyStudio** 是面向 Windows 开发者的 AI CLI 终端工作台，用于并行管理 `claude`、`codex`、常规 shell、测试命令和项目任务。差异化在于「为 AI 编程 CLI 工作流设计」，不是通用终端替代品。背景与决策见 `.work/decisions/positioning-ai-cli-workspace.md`。

当前阶段为 **MVP（已接入真实 PTY + 多项目 + 持久化）**：Tauri + Rust 后端、React + TypeScript + xterm.js 前端已跑通；真实 PTY（`portable-pty`/ConPTY）、多项目工作区、Windows Terminal 式分屏、布局/窗口持久化均已实现。`mockWorkspace` 退居为**纯浏览器兜底数据源**（`bun run dev` 无 Tauri 运行时时使用），桌面运行时以 Rust 后端 `hydrate_window` 持久化状态为主。实现进度详见 `.work/plans/PROGRESS.md`。

## 本机环境

- **Java**：JDK 在 `D:\work\java\jdk\`，包含 `jdk21`、`jdk11`；如需安装其他 JDK，也安装到该目录下。
- **Maven**：Maven 配置在 `D:\work\java\maven\.m2\`，包含 `setting.json` 和 `repository`。
- **Node**：Node 使用 Volta 做全局设置。
- **Terminal**：优先使用 PowerShell。
- **Rust**：Rust 工具链通常在 `C:\Users\<user>\.cargo\bin`。当前 PowerShell 会话可能未自动加入 PATH，必要时先追加 `$env:Path += ";C:\Users\18061\.cargo\bin"`。

## 常用命令

包管理/脚本运行**统一使用 Bun，不使用 npm/yarn**。前端开发服务器固定监听 `:1420`（`strictPort`），Tauri dev 依赖该端口。

```powershell
bun install                  # 安装依赖
bun run dev                  # 仅前端：Vite dev server (http://localhost:1420)
bun run tauri dev            # 桌面开发：自动跑 bun run dev + 启动 Tauri 窗口
bun run build                # 前端生产构建：tsc 类型检查 + vite build
bun run tauri build          # 完整打包：前端构建 + Rust release 编译
```

`package.json` 的 `dev` 脚本用 `volta run --node 22.14.0 node node_modules/vite/bin/vite.js` 跑 Vite。不要直接改回 `bunx --bun vite`：Bun runtime 跑 Vite optimizeDeps scanning 明显变慢；系统 Node 版本也可能过低。仍统一使用 `bun run dev` / `bun run tauri dev` 作为入口。

Rust 端验证（在 `src-tauri/` 下）：

```powershell
cargo check                  # 快速类型/编译检查
cargo build                  # debug 构建
cargo test                   # 当前尚无测试
```

Tauri bundling 阶段需联网下载 WiX，国内网络可能出现 `Peer disconnected`，通常属于网络问题而非代码问题。

## 架构约定

### 双进程边界

前端（浏览器/WebView）与 Rust 后端之间的 terminal IO 通过 `TerminalTransport` 接口解耦，这是替换后端时的关键接缝：

- `src/domain/terminalTransport.ts`：定义 `TerminalTransport` interface（`start`/`write`/`resize`/`stop`/`onOutput`）。
- `MockTerminalTransport`：纯浏览器兜底，回放静态 transcript。
- `TauriPtyTransport`：真实 PTY。`start` 时先 `listen("pty-output")` 再 `invoke("spawn_pty")`，按 `sessionId` 路由输出，避免丢首批输出。
- `TerminalPane.tsx` 只依赖 `TerminalTransport` 接口，不直接耦合 Tauri/PTY API。
- `AppShell` 按 `paneId` 池化 transport，pane 存活期复用，移除时 `stop + delete`，避免重渲染反复 spawn。

改动终端相关代码时，保持这个边界：组件通过 transport 接收输出，不要在组件里直接 `invoke` PTY 命令。

### 前端结构（`src/`）

- `App.tsx`：根组件。启动 `invoke("hydrate_window")`（8s 超时兜底）从后端加载持久化项目列表，失败/非 Tauri 环境回退 `mockProjects`；`deriveProjects` 把 `BackendAppSnapshot` 派生为带运行时 `WorkspaceSnapshot` 的 `ProjectSnapshot` 供 UI 消费。
- `components/AppShell`：三段式布局 `TopProjectBar`（顶栏：项目切换/+ 添加）+ `ShellSidebar`（左栏：shell 列表）+ `PaneSurface`（中央：WT 式 pane tree 分屏）+ `StatusBar`（底栏）。每项目独立 pane tree（本地 `treesByProject` 状态 + `save_pane_tree` 落盘）；WT 默认快捷键在此注册。
- `components/TerminalPane`：xterm.js `Terminal` + `FitAddon`，`ResizeObserver` 触发 fit 并通知 transport resize，unmount 时 `dispose`。只依赖 `TerminalTransport` 接口。
- `domain/`：纯类型与领域模型。核心为 `paneTree.ts`（二叉分屏树纯函数）、`appState.ts`（后端 `AppSnapshot` 的前端镜像）、`tauriPtyTransport.ts`（真实 PTY transport）、`projectDeriver.ts`（快照派生）。新增类型优先放这里，不要散落在组件文件。
- `mock/mockProjects.ts`、`mock/mockWorkspace.ts`：纯浏览器兜底数据源，仅 `bun run dev` 无 Tauri 运行时使用。

### 后端结构（`src-tauri/`）

- `src/lib.rs`：`tauri::Builder` 入口。注册 `tauri-plugin-log`、`tauri-plugin-opener`、`tauri-plugin-dialog`；`setup` 中 `persistence::load` 从磁盘加载快照，失败回退空状态并 `manage(AppState)`；`PtyRegistry` 另作 managed state；`invoke_handler` 注册全部命令。
- `pty/`：PTY 会话领域。`mod.rs` 定义 `PtySession` 与全局 `PtyRegistry`；`commands.rs` 实现 `spawn_pty`/`write_pty`/`resize_pty`/`kill_pty`，输出经全局 `pty-output` 事件回推。当前 PTY 仍按全局 `sessionId` 归属，尚未按 `projectId` 隔离。
- `state/`：多项目持久化。`mod.rs` 定义 `AppState`、`ProjectRecord`、`PaneNode`、`WindowBounds`；`commands.rs` 实现 `hydrate_window`/`open_project`/`close_project`/`set_active_project`/`save_window_bounds`/`save_pane_tree`；`persistence.rs` 读写 `state.json`。
- 约束：`std::sync::Mutex` 严格遵守「持锁不跨 `.await`」；所有 command 在锁作用域内克隆/完成同步操作后立即释放锁。
- `main.rs` 仅调用 `txuy_studio_lib::run()`。

### Tauri 配置

- `tauri.conf.json`：`beforeDevCommand`/`beforeBuildCommand` 指向 `bun run dev`/`bun run build`，`devUrl` 为 `:1420`，`frontendDist` 为 `../dist`。
- Tauri 2.x 权限走 capabilities（`src-tauri/gen/schemas/` 为生成产物）。新增需暴露给前端的命令后，按需在 capabilities 中放行。

## Windows Terminal 式快捷键

| 键 | 动作 |
|---|---|
| `Alt+Shift+-` | 焦点 pane 向右分屏（horizontal） |
| `Alt+Shift++` | 焦点 pane 向下分屏（vertical） |
| `Alt+Shift+↑↓←→` | 焦点切到相邻 pane |
| `Alt+Shift+W` | 关闭焦点 pane（邻居回填） |
| `Ctrl+Shift+T` | 新建 PowerShell pane（作为焦点 pane 右分屏） |

## 工作规范

- 默认使用 PowerShell；搜索文本或文件优先使用 `rg` / `rg --files`。
- 修改文件前先查看现有实现和工作区状态，避免覆盖用户未提交改动。
- 不要回滚、删除或重置非本次修改产生的文件变更，除非用户明确要求。
- 手工编辑文件优先使用 `apply_patch`。
- 对开放式实现需求，优先沿用本项目现有模式、命名、边界和类型组织。
- 变更完成后按风险运行验证：前端改动优先 `bun run build`；Rust/Tauri 后端改动优先在 `src-tauri/` 下运行 `cargo check`，必要时再运行更完整命令。

## .work 文档与 Plan 规则

- 实现进度总览（单一真相源）：`.work/plans/PROGRESS.md`
- 工作规范与约定：`.work/CONVENTIONS.md`
- 设计/计划/调研/决策归档总索引：`.work/README.md`

每次形成新的执行 plan：

1. Plan 完成并批准后，将 plan 内容保存到 `.work/design/YYYYMMDD-<plan-name>/` 下，文件命名 `<plan-name>-design-v<版本号>.md`，文档头部标注日期、分支和状态。**这是强制步骤，不要遗漏。**
2. 同步在 `.work/plans/PLAN_LOG.md` 追加索引链接。
3. 如涉及设计、调研或决策，同步更新对应子目录。
4. 每个 plan 文档必须包含「验证方法」章节。
5. 完成一个里程碑或设计文档对应的功能后，更新 `.work/plans/PROGRESS.md` 中对应条目的状态。
