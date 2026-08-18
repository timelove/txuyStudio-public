/**
 * codex sandbox 档位(codex exec -s)—— 单一真源。
 *
 * CodexPane 状态栏切换 / Shift+Tab 循环与设置面板(SettingsModal 全局默认档)共用此表,
 * 防两处漂移。与 claude 的 permission-mode 根本不同:codex exec 非交互无「停下来问用户」
 * 的审批,敏感操作直接被 sandbox 拦(前端显 denied 药丸),切策略下轮 spawn 生效。
 *
 * 纯常量 + 纯函数,零 React 依赖(与 shellKinds.ts 同风格 domain 层)。
 */

/** 档位 id 与 codex exec -s 参数值一致。label 沿用 codex TUI 风格短标签。desc 存 i18n key。 */
export const SANDBOX_MODES = [
  { id: "read-only", label: "ro", desc: "codexpane.sandbox.ro" },
  { id: "workspace-write", label: "auto", desc: "codexpane.sandbox.auto" },
  { id: "danger-full-access", label: "yolo", desc: "codexpane.sandbox.yolo" },
] as const;

export type CodexSandboxId = (typeof SANDBOX_MODES)[number]["id"];

/** 默认档:workspace-write(设计决策,见 .work 设计文档)。 */
export const DEFAULT_CODEX_SANDBOX: CodexSandboxId = "workspace-write";

/**
 * 把任意值(后端 state.json 的 codexSandbox / 旧数据 / 手改文件)归一到合法档位。
 * 非法/缺失返回默认档,供 hydrate 与 transport 初始化兜底。
 */
export function normalizeCodexSandbox(v: string | null | undefined): CodexSandboxId {
  return (SANDBOX_MODES.find((m) => m.id === v)?.id as CodexSandboxId) ?? DEFAULT_CODEX_SANDBOX;
}
