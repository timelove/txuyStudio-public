/**
 * slash 命令注册表类型与纯函数(#131 命令分发层)。
 *
 * ClaudePane 组装 `SlashCommandDef[]` 作为单一真相源,三入口共用:
 * - 输入分发(handleSend:以 / 开头查表,命中直达执行,未命中透传当普通消息);
 * - 命令面板(输入 "/xxx" 无空格时弹出,filterSlashCommands 过滤);
 * - ⋯ 工具菜单(按 group 生成分组)。
 *
 * 注册表不 memo(每渲染重建):闭包永远新鲜,规避「前文 useMemo 引用后文声明 handler」
 * 的 TDZ/deps 纠缠(闭包内引用运行时才求值)。CodexPane 后续接入共用本类型。
 */

/** direct=前端直达执行(不进消息流);stdin=写 claude 进程(local command,模型不可见)。 */
export type SlashCommandKind = "direct" | "stdin";

/** 分组沿用 ⋯ 菜单三组:资源/会话/定位。 */
export type SlashCommandGroup = "session" | "resources" | "locate";

/** 输入框 slash 命令注册表条目。 */
export type SlashCommandDef = {
  /** 命令名(含斜杠,全小写,如 "/compact")。 */
  name: string;
  /** i18n key:⋯ 菜单 label 与命令面板描述共用。 */
  labelKey: string;
  group: SlashCommandGroup;
  kind: SlashCommandKind;
  /** ⋯ 菜单 glyph(可选)。 */
  glyph?: string;
  /** 支持参数(如 /add-dir <path>);面板 Tab 补全后保留参数输入位。 */
  takesArg?: boolean;
  /** 执行(arg=参数原文,可空)。busy 语义:stdin 类由分发层统一先 interrupt,direct 类自理。 */
  run: (arg: string) => void | Promise<void>;
};

/**
 * 解析输入的命令首 token:`/compact --foo bar` → { token: "/compact", arg: "--foo bar" }。
 * 非 / 开头或首 token 不含斜杠后字符时返回 null。token 归一小写(输入 /Compact 亦命中)。
 */
export function parseSlashInput(text: string): { token: string; arg: string } | null {
  const m = text.match(/^(\/\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { token: m[1].toLowerCase(), arg: (m[2] ?? "").trim() };
}

/** 命令面板过滤:query 对命令名(去斜杠)做子串匹配;空 query 返回全量(保持注册顺序)。 */
export function filterSlashCommands(defs: SlashCommandDef[], query: string): SlashCommandDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return defs;
  return defs.filter((d) => d.name.slice(1).includes(q));
}
