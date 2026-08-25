# 主题扩展指南

新增一个主题需要改 4 处，其中**第 4 处（背景图玻璃化兼容）最容易漏**。

## 1. `src/domain/themes.ts`

- `ThemeId` 联合类型加新 id。
- `KNOWN_THEME_IDS` 数组加 id（hydrate 校验用）。
- `THEMES` 数组加 `{ id, labelKey }`（设置面板的单选按钮）。
- `TERMINAL_THEMES` 加 xterm ANSI 配色（16 色 + bg/fg/cursor/selection）。

> **硬约束**：`TERMINAL_THEMES[id].background` 必须与下面 app.css 里该主题的
> `--mx-editor-bg` **同值**。TerminalPane 容器用 `var(--mx-editor-bg)`，
> 与 xterm 画布同色，否则 pane 边缘/padding 区会出色差条。

## 2. `src/styles/app.css`

加 `[data-theme="<id>"] { ... }` 块，覆盖全套 `--mx-*` CSS 变量。
对照 midnight（`:root`）块的变量逐个给值，重点：

| 变量 | 用途 | 背景图兼容性要求 |
|---|---|---|
| `--mx-bg` | 主窗口底 | 任意；背景开时被覆写为 transparent |
| `--mx-editor-bg` | 内容区/终端/pane 底 | **必须是不透明色**（xterm 背景基准）；背景开时 transparent |
| `--mx-card-bg` | 输入框/卡片底 | 任意；背景开时被覆写为原色 @0.82（不透明度上限） |
| `--mx-tabbar-bg` | 顶栏/底栏/pane 头 tabs | **必须设值**（见下方坑）；背景开时 @0.72（不透明度上限） |
| `--mx-surface` / `--mx-surface-2` | 弹层/代码块底 | 保持不透明（弹层不玻璃化） |
| `--mx-border` / `--mx-border-strong` | 边框/分隔线 | 任意，建议不透明度 ≥0.14 |
| `--mx-text` / `--mx-muted` / `--mx-text-dim` / `--mx-faint` | 文字层级 | 在深色底上对比度足够即可 |

### ⚠️ `--mx-tabbar-bg` 必须显式设值

midnight 用了透明浅罩 `rgba(148,163,184,0.055)`，one-dark 用实色 `#21252b`，
**两者都行，但不能缺省**。背景玻璃化逻辑会读这个 token 做 @0.72 半透明；
缺省会导致 pane 头 tabs 在背景图下无底色。@0.72 是**不透明度上限**
（`colorWithAlpha` 与原 alpha 预乘）：实色被压到 0.72 玻璃，淡罩
（0.055）预乘后 ≈0.04 保持淡罩——不会把浅罩抬成实色块挡住背景。

## 3. `src/i18n/zh.ts` + `en.ts`

- `theme.<id>`：主题显示名（如 `theme.midnight`）。

## 4. 背景图玻璃化兼容（`src/components/AppShell.tsx`）

背景图功能在 `AppShell` 的一个 `useEffect` 里（搜「背景图玻璃化覆写」）。
**新增主题通常不需要改这段代码**——它通过 `getComputedStyle` 读当前主题的
CSS 变量原值再动态算半透明，对任何主题都生效。但要确认新主题满足：

1. `--mx-bg` / `--mx-editor-bg` / `--mx-card-bg` / `--mx-tabbar-bg` **四个变量都定义了**
   （effect 会 `removeProperty` 后逐个读，缺了对应表面就不玻璃化）。
2. 这四个变量的值能被 `colorWithAlpha()`（`src/domain/bg.ts`）解析：
   支持 `#rgb`/`#rrggbb`/`#rrggbbaa` 和 `rgb()/rgba()`。
   - ✅ `#1e2127`、`rgba(148,163,184,0.1)`、`#282c34`
   - ❌ 具名色（`red`/`transparent` 关键字）、`hsl()`、`color-mix()`
   - 如果用了不支持的格式，该 token 不会被覆写，对应区域保持实色（不崩，只是不玻璃）。
3. 想让某个表面**不参与玻璃化**（如弹层 `--mx-surface`），别把它加进 effect 的
   `TOKENS` 列表——当前只有上述 4 个表面被覆写，其余保持主题原色。

### 各 pane 的额外透明处理

`--mx-editor-bg` 被设 transparent 后，大部分 pane 自动透（它们用 `bg-[var(--mx-editor-bg)]`）。
但以下 pane 有**内联 style 兜底**，背景开时强制 transparent，防 webview 默认白底/叠层白雾，
新增 pane 若有自己的背景层，照此模式：

- `TerminalPane`：`allowTransparency` + xterm `theme.background` rgba(...,0) + article inline transparent。
- `NotesPane`：article/编辑区/预览区/textarea 三处 inline transparent，grid 容器去白雾。
- `HtmlPreviewPane`：article/编辑区/textarea/grid 容器 transparent；**预览 iframe 区保留 `bg-white`**
  （网页预览需白底看真实效果，不该透）。
- `ClaudePane`/`CodexPane`：消息流用 editor-bg 自动透；输入框卡片用 card-bg 自动玻璃化。

### 调玻璃化程度

effect 里的两个 alpha 是全局手感（均为不透明度**上限**，与原色 alpha 预乘）：
- card-bg `0.82`：输入框/卡片（越大越实）
- tabbar-bg `0.72`：工具栏（稍透，玻璃感更强；淡罩主题预乘后仍保持淡罩）

改这两个值对所有主题生效；不要在主题 CSS 里调（会被 inline 覆写）。

## 验证清单（新主题 + 背景图）

- [ ] 不开启背景图：新主题所有表面颜色正确，xterm 与 editor-bg 无色差条。
- [ ] 开启背景图：主内容区/终端透出背景，工具栏/输入框半透明可读。
- [ ] 切到新主题再切回：覆写被清除再重建，无残留脏值。
- [ ] pane tabs（顶/底栏 + 各 pane 头）有底色，文字清晰。
- [ ] 分隔线 1px 细线在新主题边框色下可见。
