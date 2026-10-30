// BaoCode 借鉴 — 「一行步骤」组件
//
// 借鉴 baocode `step_header.dart` 的 StepHeader + StepBody:
// 一次工具调用 / 一段思考读作**一行**「动词 目标 细节」——动词用正文色,目标次之,
// 细节最淡;hover 或展开时才浮现 chevron,点击展开它自己的内容。
// 与旧结构的差别:不再是一个个带边框的「卡片」,消息流里是一列对齐的一行行步骤,
// 只有正文(assistant 文字)保持块状。这样一屏能读完更多步骤,视觉噪声低得多。
//
// 设计约束(见 memory「Tailwind v4 text-[var] 歧义」):
// 颜色一律用 `text-(color:--mx-*)` 写法,避免与同元素上的 `text-[13px]` 字号类冲突而不渲染。

import { useEffect, useRef, type ReactNode } from "react";

/** 一行步骤的 chevron(展开态旋转 90°)。 */
function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 transition-transform duration-150"
      style={{ transform: expanded ? "rotate(90deg)" : undefined }}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

/**
 * 一行步骤。
 *
 * - `verb`:动词(「读了」「运行了」…),正文色,可选 `verbColor` 覆盖(如 Bash 的绿)。
 * - `object`:目标(文件名 / 命令 / pattern),次色,超长省略。
 * - `detail`:行末细节(`L10-50`、`in src`),最淡。
 * - `running`:进行中——动词呼吸 + 右侧 spinner(替代旧的「执行中…」药丸)。
 * - `onToggle`:传了才可点,且 hover/展开时显示 chevron。
 */
export function StepRow({
  verb,
  object,
  detail,
  running = false,
  expanded = false,
  onToggle,
  icon,
  trailing,
  title,
  verbColor,
  testId,
}: {
  verb: string;
  object?: string;
  detail?: string | null;
  running?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  icon?: ReactNode;
  trailing?: ReactNode;
  title?: string;
  verbColor?: string;
  testId?: string;
}) {
  const clickable = !!onToggle;
  return (
    <div className="group/step flex min-w-0 items-center gap-1.5 py-0.5 text-[13px] leading-[1.5]">
      {icon ? (
        <span className="flex shrink-0 items-center" aria-hidden>
          {icon}
        </span>
      ) : null}
      <div
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={onToggle}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle?.();
                }
              }
            : undefined
        }
        title={title}
        data-testid={testId}
        data-expanded={clickable ? (expanded ? "1" : "0") : undefined}
        className={`flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none ${
          clickable
            ? "cursor-pointer rounded-sm focus-visible:ring-1 focus-visible:ring-[var(--mx-accent)]"
            : ""
        }`}
      >
        <span
          className={`shrink-0 font-medium ${running ? "animate-pulse" : ""}`}
          style={{ color: verbColor ?? "var(--mx-text)" }}
        >
          {verb}
        </span>
        {object ? (
          <span className="min-w-0 truncate text-(color:--mx-muted)">{object}</span>
        ) : null}
        {detail ? <span className="shrink-0 text-(color:--mx-faint)">{detail}</span> : null}
      </div>
      {trailing ? <span className="flex shrink-0 items-center gap-1.5">{trailing}</span> : null}
      {running ? (
        <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--mx-border-strong)] border-t-[var(--mx-accent)]" />
      ) : null}
      {clickable ? (
        // 进行中也常显 chevron:让「运行中也能点开看」这件事被看见,不用先 hover 才知道。
        // 它自身也是点击目标(用户反馈:点最右侧箭头也要能展开)——与整行同一动作,
        // 故 tabIndex=-1 + aria-hidden,键盘/读屏走整行那个按钮,不重复播报。
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => onToggle?.()}
          className={`shrink-0 cursor-pointer rounded-sm p-0.5 text-(color:--mx-faint) transition-opacity hover:text-[var(--mx-text)] ${
            expanded || running ? "opacity-100" : "opacity-0 group-hover/step:opacity-100"
          }`}
        >
          <Chevron expanded={expanded} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * 步骤卡片:把一行步骤(`StepRow`)装进「浅底 + 细边框」的卡片里,展开内容用 `StepBody`
 * 接在下面(带 `border-t` 分隔,读作同一张卡的两段)。
 *
 * 为什么要有卡片:气泡里若全是裸的一行行步骤,整体会像一块空荡的灰板 —— 每次工具调用
 * 套一层卡片,内容有边界、节奏统一。底色取 `--mx-surface-soft`(比气泡的 `--mx-card-bg`
 * 略亮,暗色下是半透明亮面),hover 时边框提亮一档。
 */
export function StepCard({
  children,
  className = "",
}: {
  /** 首个子元素是卡片首行(`<StepRow … />`),其余是展开内容(`<StepBody … />`)。 */
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      // 首行(StepRow)自带内边距;展开内容(StepBody)要通栏,故只给第一个子元素加 padding。
      // 底色用 --mx-card-inner(比气泡 --mx-card-bg 抬一档),卡片才从气泡里浮得出来。
      className={`overflow-hidden rounded-lg border border-[var(--mx-border)] bg-[var(--mx-card-inner)] transition-colors hover:border-[var(--mx-border-strong)] [&>*:first-child]:px-2.5 [&>*:first-child]:py-1 ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * 卡片展开后的内容框:与卡片首行以 `border-t` 相接,深底,超过 `maxHeight` 内部滚动。
 *
 * `followEnd`:内容增长时自动贴底(实时输出)。
 * 用户上翻(距底 >24px)即暂停贴底,滚回底部附近才恢复,读早期输出不被增量拽回底部。
 */
export function StepBody({
  children,
  maxHeight = 320,
  className = "",
  followEnd = false,
}: {
  children: ReactNode;
  maxHeight?: number;
  className?: string;
  followEnd?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (followEnd && el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [children, followEnd]);
  return (
    // 不设自己的底色:继承卡片底色,只用 border-t 分隔「首行 / 展开内容」两段。
    // (曾用 --mx-surface-2,但它在 intellij-light 下与 --mx-card-inner 同值 #f2f3f5,
    //  展开体会整个隐形;换成第三层颜色又平添一个 token,不如让卡片保持一个面。)
    <div className={`border-t border-[var(--mx-border)] ${className}`}>
      <div
        ref={ref}
        onScroll={() => {
          const el = ref.current;
          if (!el) return;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="mx-scroll-pretty overflow-auto px-2.5 py-2"
        style={{ maxHeight }}
      >
        {children}
      </div>
    </div>
  );
}
