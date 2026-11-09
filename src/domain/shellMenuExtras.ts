import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { SplitDirection } from "./paneTree";

/**
 * ShellMenu「Fleet Worker」入口的注入接缝。
 *
 * Fleet Worker 不是一种 ShellKind(它是「先建 worktree 再开普通 AI tab」的组合动作),
 * 不能进 NEW_SHELL_GROUPS;而 ShellMenu 有 9 个消费组件(TerminalPane/ClaudePane/…
 * 各自持 Popover),沿 props 链逐个透传 onFleetWorker 回调会侵入全部 pane 组件。
 *
 * 与「跨组件开设置」(#131 /doctor 走 mx-open-settings CustomEvent)同思路的解耦:
 * AppShell 提供 context 值,ShellMenu useContext 消费——未 Provide 时(单测/mock 环境)
 * 不渲染该行。菜单点击时机,目标 pane 已因 pane body 的 onMouseDown → onFocusPane
 * 成为焦点,AppShell 侧从 focused state 即可取到 (projectId, paneId) 创建上下文,
 * 各 pane 组件零改动。
 */

/** ShellMenu 内渲染的附加菜单项(label 已含 i18n 翻译,icon 为 ReactNode)。 */
export type ShellMenuExtraItem = {
  /** i18n key(ShellMenu 内 t() 翻译)。 */
  label: string;
  /**
   * 图标:与 SHELL_KIND_META 的 glyph 同风格(Fleet 入口用 <FleetIcon/> git 分支
   * SVG,不用 ⛵ emoji——见 FleetIcon 注释;其余保留字符字形)。
   */
  icon: ReactNode;
  /** 图标 tile 底色(同 meta.accent)。 */
  accent: string;
  /**
   * 菜单项点击。direction 来自 ShellMenu 的 splitDirection prop:分屏菜单传入
   * (用户所选方向),新建 tab 菜单为 undefined(加入原 pane tab 栈)。
   */
  onClick: (direction?: SplitDirection) => void;
};

export const ShellMenuExtrasContext = createContext<ShellMenuExtraItem[] | null>(null);

/** 便捷读取:未 Provide 返回空数组(ShellMenu 不渲染任何附加行)。 */
export function useShellMenuExtras(): ShellMenuExtraItem[] {
  return useContext(ShellMenuExtrasContext) ?? [];
}
