import type { ShellKind } from "./paneTree";

/**
 * TUI 工具安装信息真源 —— 供 [[InstallPromptModal]] 读取安装命令与说明。
 *
 * 这些工具**不内置打包**(用户明确否决):前端在新建窗口前用后端
 * `check_commands_installed` 探测 `detect` 命令是否在 PATH 上,未安装则弹模态
 * 提示各安装方式命令,并提醒安装后重新打开窗口。
 *
 * `installs` 为数组:不同工具支持的安装方式不同(lazygit/yazi 有 winget+scoop,
 * fresh 有 winget+npm 无 scoop),模态遍历渲染。tag 是左侧标签(如 winget/scoop/npm)。
 *
 * key 与 [[SessionKind]] 的 TUI 子集对齐(lazygit/yazi/fresh)。
 */
export type ToolInstall = { detect: string; installs: { tag: string; cmd: string }[]; note: string };

export const TUI_TOOLS: Record<string, ToolInstall> = {
  lazygit: {
    detect: "lazygit",
    installs: [
      { tag: "winget", cmd: "winget install JesseDuffield.Lazygit" },
      { tag: "scoop", cmd: "scoop install lazygit" },
    ],
    // i18n key:渲染层(InstallPromptModal)t(note) 翻译。
    note: "install.lazygitNote",
  },
  yazi: {
    detect: "yazi",
    installs: [
      { tag: "winget", cmd: "winget install sxyazi.yazi" },
      { tag: "scoop", cmd: "scoop install yazi" },
    ],
    note: "install.yaziNote",
  },
  fresh: {
    detect: "fresh",
    installs: [
      { tag: "winget", cmd: "winget install fresh-editor" },
      { tag: "npm", cmd: "npm install -g @fresh-editor/fresh-editor" },
    ],
    note: "install.freshNote",
  },
};

/** 某个 ShellKind 是否为需要安装检测的 TUI 工具。非 TUI 工具(shell/claude/codex/test)直接放行。 */
export const isTuiTool = (kind: ShellKind | string): boolean => kind in TUI_TOOLS;

/**
 * 单组安装命令(主组与附加组共用此形状)。既用于「TUI 工具未安装」(lazygit/fresh/yazi),
 * 也用于「yazi 缺依赖」(如 file)。由调用方从 [[TUI_TOOLS]] 或 [[YAZI_DEPS]] 构造。
 */
export type InstallGroup = {
  /** 模态标题(工具名 / 依赖名)。 */
  title: string;
  /** 一句话说明。 */
  note: string;
  /** 安装命令块(tag + cmd),模态遍历渲染。 */
  installs: { tag: string; cmd: string }[];
};

/**
 * 安装提示模态内容:主组(本体)+ 可选附加组(依赖)。
 * 附加组用于 yazi 缺时连带其依赖 file 一并展示,避免「先弹工具、装完再弹依赖」的二次提示;
 * 形状同主组,可直接复用 [[YAZI_DEPS]].spec。
 */
export type PromptSpec = InstallGroup & {
  /** 可选附加命令组,模态在主组下以分隔线依次渲染。 */
  extras?: InstallGroup[];
};

/** 从 TUI 工具构造提示 spec(未安装提示)。 */
export const toolPromptSpec = (kind: ShellKind | string): PromptSpec => {
  const t = TUI_TOOLS[kind];
  return { title: kind, note: t.note, installs: t.installs };
};

/**
 * yazi 运行时依赖提示(装了 yazi 但缺这些依赖时弹,**不阻止**建 tab——yazi 仍能启动,仅功能降级)。
 *
 * 当前仅 `file`:Windows 上 yazi 用它做 MIME 类型检测,缺失会报 `Cannot find 'file' to detect the
 * file's MIME type`(yazi 官方 Windows 安装指南要求装)。其余依赖(7z/jq/fd/rg/ffmpeg/unar)为可选
 * 增强,缺了不报错,本轮不提示。
 */
export const YAZI_DEPS: { detect: string; spec: PromptSpec }[] = [
  {
    detect: "file",
    spec: {
      // i18n key:渲染层 t() 翻译。title 混了英文工具名 file + 中文描述,统一走 key。
      title: "install.fileYaziDep.title",
      note: "install.fileYaziDep.note",
      installs: [
        { tag: "winget", cmd: "winget install GnuWin32.File" },
        { tag: "scoop", cmd: "scoop install file" },
      ],
    },
  },
];
