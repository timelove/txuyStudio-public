/**
 * 中文字典 —— i18n 中文资源。
 *
 * namespace 按文件/功能模块切分,扁平点分 key 便于按文件定位。模板插值用
 * i18next 双花括号语法 `{{name}}`(escapeValue:false,React 已防 XSS)。
 * 品牌名(Claude/Codex/PowerShell 等)不入字典,i18next 缺失 key 回退到 key 本身即原样显示。
 */

const zh = {
  app: {
    loadingWorkspace: "正在加载工作区…",
  },
  common: {
    close: "关闭",
    loading: "加载中…",
    cancel: "取消",
    confirm: "确认",
    refresh: "刷新",
  },
  shell: {
    tab: {
      close: "关闭 tab",
      new: "新 tab",
    },
    pane: {
      split: "分屏(新 pane)",
      close: "关闭 pane",
      noActiveTab: "无活动 tab",
    },
  },
  project: {
    select: "选择项目",
    none: "无项目,点 + 添加。",
    add: "添加项目",
    delete: "删除项目",
    deleteConfirm: '删除项目 "{{name}}"?将关闭其所有 shell。',
    pin: "钉住(并排显示)",
    unpin: "取消钉住",
    detach: "在新窗口打开",
    focusDetached: "聚焦独立窗口",
    empty: "未选择项目。",
    emptyHint: "未选择项目。点击右上 + 添加。",
  },
  session: {
    all: "全部",
    current: "当前",
    empty: "暂无 Claude/Codex 会话记录",
    noMatch: "无匹配会话",
    loading: "加载中…",
    deleteGroup: "删除整组({{count}} 条)",
    deleteGroupConfirm: "删除整组 {{count}} 条?",
    noTitle: "(无标题){{id}}",
    unknownProject: "未知项目",
    unknownProjectPath: "(未知项目路径)",
    copyPath: "点击复制路径: {{cwd}}",
    copySessionId: "复制 session id",
    messageCount: "{{count}} 条",
    startedAt: "开始",
    lastAt: "最近",
    deleteConfirm: "删除?",
    deleteRecord: "删除该会话记录",
    deleteSession: "删除会话",
    tipSelect: "从左侧选择一个会话查看详情",
    loadingMessages: "加载消息流…",
    noMessages: "无消息记录",
    copy: "点击复制",
    copyToolUse: "点击复制工具调用",
    copyToolResult: "点击复制工具结果",
    refresh: "刷新",
    searchPlaceholder: "搜索 标题 / 路径 / session id",
    filterCount: "过滤数 / 总数",
    role: {
      user: "用户",
      assistant: "助手",
    },
  },
  install: {
    selectAllCopy: "点击全选后 Ctrl+C 复制",
    notDetected: "未检测到 {{name}},请先安装:",
    notDetectedGroup: "同样未检测到 {{name}},建议一并安装:",
    afterInstallHint: "安装完成后,重新打开对应的窗口即可。",
    pathHint: '若已安装仍提示未装,请确认其所在目录已加入用户 PATH,并<strong style="font-weight:600;color:var(--mx-text)">重启本应用</strong>使新 PATH 生效。',
    fileYaziDep: {
      title: "file(yazi 依赖)",
      note: "yazi 用它做文件 MIME 类型检测,缺失会报错且预览不准",
    },
    lazygitNote: "终端里的 git TUI 客户端",
    yaziNote: "终端文件管理器",
    freshNote: "终端文本编辑器(零配置,类 VS Code 体验)",
  },
  preview: {
    selectFile: "从左侧选择文件预览",
    loading: "加载中…",
    binary: "二进制文件不可预览",
    truncated: "已截断:仅显示前 512 KB(完整 {{size}})",
    readError: "读取失败: {{error}}",
    editorLoading: "加载编辑器…",
  },
  probe: {
    edit: "编辑",
    readonly: "只读",
    unsaved: "未保存(5s 自动落盘,关闭即存)",
    tooLarge: "文件过大(>512KB),仅预览不支持编辑",
    mdPreview: "预览",
  },
  filetree: {
    emptyDir: "空目录",
    noProjectPath: "无项目路径",
    loading: "加载中…",
  },
  settings: {
    title: "设置",
    tab: {
      general: "通用",
      shortcuts: "快捷键",
      about: "关于",
    },
    shortcut: {
      title: "快捷键",
    },
    language: {
      title: "语言",
      zh: "中文",
      en: "English",
    },
    fontSize: {
      title: "字体大小",
      hint: "终端 + 编辑器",
      decrease: "调小",
      increase: "调大",
      reset: "重置",
    },
  },
  about: {
    description: "面向 Windows 开发者的 AI CLI 终端工作台。并行管理 claude、codex、常规 shell、测试命令与项目任务。",
    version: "版本",
    viewOnGithub: "在 GitHub 查看",
  },
  statusbar: {
    settings: "设置",
    focusedProject: "聚焦项目",
    gitBranch: "git 分支:{{branch}}",
    memUsage: "内存占用 {{percent}}%",
    tipDone: "已完成,点击恢复显示;下一个 :00 / :30 自动轮换新提醒",
    tipActive: "每整点 / 半点(:00 / :30)轮换一次,点击标记为已完成",
  },
  window: {
    minimize: "最小化",
    maximize: "最大化",
    restore: "向下还原",
    close: "关闭",
  },
  topbar: {
    backToMain: "回到主窗口",
    backToMainBtn: "← 主窗口",
    project: "项目",
  },
  sidebar: {
    openShellsByProject: "按项目浏览 shell",
    closePane: "关闭 pane",
    newShell: "新建 shell",
  },
  paneSurface: {
    noSession: "无 session:pane {{id}}",
  },
  // 快捷键分组与描述(域常量 key 化后,SettingsModal 渲染时 t(item.title)/t(item.desc))
  shortcut: {
    split: {
      title: "分屏",
      down: "向下分屏(新 pane 单 PowerShell tab)",
      right: "向右分屏",
      close: "关闭焦点 pane",
    },
    focus: {
      title: "焦点",
      up: "焦点上移",
      down: "焦点下移",
      left: "焦点左移",
      right: "焦点右移",
    },
    tab: {
      title: "Tab",
      new: "新建 tab(复制当前活动 tab 类型)",
      close: "关闭当前 tab",
      next: "下一个 tab",
      prev: "上一个 tab",
    },
    project: {
      title: "项目",
      switchN: "切焦点到第 N 个项目(按可见顺序)",
    },
  },
  // Shell 类型 label(仅 sessionbrowser/filetree 需译,其余品牌名回退 key 本身)
  shellkind: {
    sessionbrowser: "会话列表",
    filetree: "探针",
  },
  // 新建菜单分组标题(Shell/AI CLI 为英文,回退 key 本身)
  shellgroup: {
    tui: "TUI 工具",
    session: "会话",
    browse: "探针",
  },
  // 健康 tip(StatusBar HEALTH_TIPS 数据驱动,emoji 保留)
  tip: {
    water: { tip: "💧 起来喝杯水", done: "💧 已喝水" },
    lift: { tip: "🍑 该提肛了", done: "🍑 已提肛" },
  },
} as const;

export default zh;
