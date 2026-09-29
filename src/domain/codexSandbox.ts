/**
 * codex sandbox 档位(codex exec -s)—— 单一真源。
 *
 * CodexPane 状态栏切换 / Shift+Tab 循环用此表(曾与设置面板的全局默认档共用,该设置
 * 2026-09-29 移除——每 tab 状态栏切换已足够)。与 claude 的 permission-mode 根本不同:
 * codex exec 非交互无「停下来问用户」
 * 的审批,敏感操作直接被 sandbox 拦(前端显 denied 药丸),切策略下轮 spawn 生效。
 *
 * 纯常量 + 纯函数,零 React 依赖(与 shellKinds.ts 同风格 domain 层)。
 */

/** 档位 id 与 codex exec -s 参数值一致。label 一并显示 CLI 原值(防误解:自创短标签如
 *  ro/auto/yolo 会与 claude 侧 permission-mode 的 auto/yolo 混淆,且不是 CLI 里的真实名字)。
 *  desc 存 i18n key(key 名 ro/auto/yolo 为历史命名,与现 label 无对应关系)。 */
export const SANDBOX_MODES = [
  { id: "read-only", label: "read-only", desc: "codexpane.sandbox.ro" },
  { id: "workspace-write", label: "workspace-write", desc: "codexpane.sandbox.auto" },
  { id: "danger-full-access", label: "danger-full-access", desc: "codexpane.sandbox.yolo" },
] as const;

export type CodexSandboxId = (typeof SANDBOX_MODES)[number]["id"];

/** 默认档:workspace-write(新会话初始档;全局默认档设置已移除,每 tab 状态栏切)。 */
export const DEFAULT_CODEX_SANDBOX: CodexSandboxId = "workspace-write";
