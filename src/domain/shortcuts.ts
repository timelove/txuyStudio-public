/**
 * 快捷键提示真源 —— 供 [[SettingsModal]] 渲染,集中管理避免文案散落。
 *
 * **国际化**:`title`/`desc` 存 i18n key(如 `"shortcut.split.down"`),由 SettingsModal
 * 渲染时 `t(key)` 翻译。常量本身不含任何用户可见文案,语言切换时由 i18next 动态翻译。
 *
 * 键位与 `AppShell.tsx` 的 window keydown effect 实际拦截的一致;若改键位,同步更新此处与 effect。
 * Windows Terminal 风格,应用聚焦时生效(capture 阶段抢在 xterm 之前)。
 */
export type ShortcutGroup = {
  /** 分区标题的 i18n key(如「分屏」「焦点」「Tab」「项目」)。 */
  title: string;
  /** 该分区的快捷键项。 */
  items: { keys: string; /** 描述的 i18n key */ desc: string }[];
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "shortcut.split.title",
    items: [
      { keys: "Alt + Shift + -", desc: "shortcut.split.down" },
      { keys: "Alt + Shift + +", desc: "shortcut.split.right" },
      { keys: "Alt + Shift + W", desc: "shortcut.split.close" },
    ],
  },
  {
    title: "shortcut.focus.title",
    items: [
      { keys: "Alt + Shift + ↑", desc: "shortcut.focus.up" },
      { keys: "Alt + Shift + ↓", desc: "shortcut.focus.down" },
      { keys: "Alt + Shift + ←", desc: "shortcut.focus.left" },
      { keys: "Alt + Shift + →", desc: "shortcut.focus.right" },
    ],
  },
  {
    title: "shortcut.tab.title",
    items: [
      { keys: "Ctrl + Shift + T", desc: "shortcut.tab.new" },
      { keys: "Ctrl + Shift + W", desc: "shortcut.tab.close" },
      { keys: "Ctrl + Tab", desc: "shortcut.tab.next" },
      { keys: "Ctrl + Shift + Tab", desc: "shortcut.tab.prev" },
    ],
  },
  {
    title: "shortcut.project.title",
    items: [
      { keys: "Ctrl + Alt + 1…9", desc: "shortcut.project.switchN" },
    ],
  },
];
