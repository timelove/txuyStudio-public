import type { ShellKind } from "./paneTree";

/**
 * Shell 类型元数据 —— 单一真源。
 *
 * 此前 accent / glyph / label / 默认标题 散落在三处(ShellSidebar.KIND_META、
 * TerminalPane.SPLIT_KIND_META、projectDeriver.ACCENT_BY_KIND/TITLE_BY_KIND),易漂移。
 * 统一收敛到这里;纯常量、只依赖 ShellKind 类型,不引入任何 React/组件依赖(避免 import cycle)。
 *
 * **国际化**:`label`/`defaultTitle` 存 i18n key(如 `"shellkind.sessionbrowser"`),
 * 渲染层 `t(meta.label)` 翻译。品牌名(Claude/Codex/PowerShell 等)直接保留原字符串——
 * i18next 缺失 key 回退到 key 本身,品牌名天然原样显示,无需为每条造字典条目。
 * `defaultTitle` 会进 tab.title 持久化(存 key);渲染层 `t(s.name)` 翻译,语言切换后旧 tab 也跟随。
 */
export const SHELL_KIND_META: Record<
  ShellKind,
  { accent: string; glyph: string; label: string; defaultTitle: string }
> = {
  claude: { accent: "#7c3aed", glyph: "C", label: "Claude", defaultTitle: "Claude" },
  codex: { accent: "#22d3ee", glyph: "X", label: "Codex", defaultTitle: "Codex" },
  shell: { accent: "#94a3b8", glyph: ">", label: "PowerShell", defaultTitle: "PowerShell" },
  test: { accent: "#22c55e", glyph: "T", label: "Tests", defaultTitle: "Tests" },
  // TUI 工具:在 PTY 里启动对应 CLI,退出后回到 PowerShell(见 launch_command_for)。
  // 配色与既有 shell accent 拉开:lazygit 青、yazi 琥珀、fresh 紫。
  lazygit: { accent: "#22d3ee", glyph: "G", label: "lazygit", defaultTitle: "lazygit" },
  yazi: { accent: "#f59e0b", glyph: "Y", label: "yazi", defaultTitle: "yazi" },
  fresh: { accent: "#a78bfa", glyph: "F", label: "fresh", defaultTitle: "fresh" },
  // 会话列表:纯 UI 面板(不走 PTY),双栏浏览 claude/codex 历史会话。参考 cc-switch。
  sessionbrowser: { accent: "#a78bfa", glyph: "≡", label: "shellkind.sessionbrowser", defaultTitle: "shellkind.sessionbrowser" },
  // 文件树:纯 UI 面板(不走 PTY),react-arborist 懒加载 + notify 实时刷新,仅浏览(只读)。替代 yazi。
  filetree: { accent: "#34d399", glyph: "▤", label: "shellkind.filetree", defaultTitle: "shellkind.filetree" },
};

/**
 * 新建菜单 / 分屏菜单的分组结构(单一真源)。
 *
 * 菜单按组渲染,组间加分隔线 + 小标题(Shell / AI CLI / TUI 工具)。
 * `test` 仅运行期派生,不在新建入口。`NEW_SHELL_KINDS` 是其扁平投影,
 * 供需要遍历全量 kind 的地方使用(避免两处真源)。
 *
 * `title` 存 i18n key(中文需译的 "TUI 工具"/"会话"/"浏览"),英文标题(Shell/AI CLI)
 * 直接保留原字符串,i18next 回退 key 本身即原样显示。
 */
export const NEW_SHELL_GROUPS: { title: string; kinds: ShellKind[] }[] = [
  { title: "Shell", kinds: ["shell"] },
  { title: "AI CLI", kinds: ["claude", "codex"] },
  { title: "shellgroup.tui", kinds: ["lazygit", "yazi", "fresh"] },
  { title: "shellgroup.session", kinds: ["sessionbrowser"] },
  { title: "shellgroup.browse", kinds: ["filetree"] },
];

/** 新建菜单暴露的全部 shell 类型(NEW_SHELL_GROUPS 的扁平投影)。 */
export const NEW_SHELL_KINDS: ShellKind[] = NEW_SHELL_GROUPS.flatMap((g) => g.kinds);
