// BaoCode P2.1 / P2.2 — 折叠行组件(steps / work 两种)
//
// 借鉴 baocode `fold_line.dart`:
// - StepsFoldLine:一串快速步骤折叠成一行语义小结「读了 3 个文件,运行了 2 条命令 · 思考 45s」
//   (数字加粗,与 StepRow 同构的一行,hover 浮 chevron,点击展开)
// - WorkFoldLine:已结束的一轮工作折成一行「已处理 4m 32s · 读取了 3 个文件、搜索了 2 次 ·
//   5 个文件 +120 -8」。渲染在**答案卡片内部**(消息气泡里第一个块,替代原外部独立行——
//   用户反馈外部行与气泡不协调;卡片内轮末「已思考」标签即被它替代)
//
// open 态受控(open/onToggle 由 caller 给,caller 侧 localStorage 持久化)。

import type { ClaudeMessage } from "../domain/claudeStream";
import type { StepFold } from "../domain/stepFolds";
import { classifyCommand } from "../lib/commandClassifier";
import { formatDuration } from "../lib/turnMetrics";
import { StepRow } from "./StepRow";

/** steps fold 语义计数(baocode StepTally 同构):按动作分类数 + 思考秒数。 */
export type StepTally = {
  read: number;
  search: number;
  list: number;
  fetch: number;
  run: number;
  use: number;
  thoughtSeconds: number;
};

/** 段内消息 → 语义计数(导出供测试)。 */
export function tallySteps(messages: ClaudeMessage[], start: number, end: number): StepTally {
  const t: StepTally = { read: 0, search: 0, list: 0, fetch: 0, run: 0, use: 0, thoughtSeconds: 0 };
  for (let i = start; i <= end; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (const b of m.blocks) {
      if (b.type === "thinking") {
        // 思考时长无独立计时,用字符数 /40 粗估(≈中文 1 字 1 token 的阅读量级),
        // 只为折叠行里的「思考 Ns」提示,不值得为此接精确计时。
        t.thoughtSeconds += Math.round(b.text.length / 40);
        continue;
      }
      if (b.type !== "tool_use") continue;
      switch (b.name) {
        case "Read":
        case "NotebookRead":
          t.read++;
          break;
        case "Grep":
        case "Glob":
          t.search++;
          break;
        case "LS":
          t.list++;
          break;
        case "WebFetch":
        case "WebSearch":
          t.fetch++;
          break;
        case "Bash":
        case "PowerShell":
        case "BashOutput":
        case "KillShell": {
          const cmd =
            typeof b.input === "object" && b.input && "command" in b.input
              ? String((b.input as { command: unknown }).command ?? "")
              : "";
          switch (classifyCommand(cmd)) {
            case "read":
              t.read++;
              break;
            case "search":
              t.search++;
              break;
            case "list":
              t.list++;
              break;
            default:
              t.run++;
          }
          break;
        }
        default:
          t.use++;
      }
    }
  }
  return t;
}

/** tally → 有计数的动作短语(固定顺序,zh:「读取了 3 个文件、搜索了 2 次」)。steps / work 两行共用。 */
function tallyPhrases(tally: StepTally, t: (k: string, params?: Record<string, unknown>) => string): string[] {
  const phrases: string[] = [];
  if (tally.read > 0) phrases.push(t("fold.read", { n: tally.read }));
  if (tally.search > 0) phrases.push(t("fold.search", { n: tally.search }));
  if (tally.list > 0) phrases.push(t("fold.list", { n: tally.list }));
  if (tally.fetch > 0) phrases.push(t("fold.fetch", { n: tally.fetch }));
  if (tally.run > 0) phrases.push(t("fold.run", { n: tally.run }));
  if (tally.use > 0) phrases.push(t("fold.use", { n: tally.use }));
  return phrases;
}

/** steps 折叠行:语义小结 + 数字加粗。 */
export function StepFoldRow({
  fold,
  messages,
  open,
  onToggle,
  t,
}: {
  fold: StepFold;
  messages: ClaudeMessage[];
  open: boolean;
  onToggle: () => void;
  t: (k: string, params?: Record<string, unknown>) => string;
}) {
  const tally = tallySteps(messages, fold.start, fold.end);
  const phrases = tallyPhrases(tally, t);
  const thought =
    tally.thoughtSeconds >= 1 ? t("fold.thought", { d: formatDuration(tally.thoughtSeconds * 1000) }) : null;
  const verb = phrases.length > 0 ? phrases.join(t("fold.separator")) : t("toolStep.stepsFold", { n: fold.end - fold.start + 1 });
  const detail = thought ?? undefined;
  return (
    <StepRow
      verb={verb}
      detail={detail}
      expanded={open}
      onToggle={onToggle}
      testId="step-fold-row"
      trailing={
        <span className="text-[10px] text-(color:--mx-faint)">
          {open ? t("toolStep.collapse") : t("toolStep.expand")}
        </span>
      }
    />
  );
}

/** work 折叠行:「已处理 4m 32s · 读取了 3 个文件、搜索了 2 次 · 5 个文件 +120 -8」。
 *  渲染在答案卡片内部(第一个块,替代原外部独立行 —— 用户反馈外部行与气泡不协调);
 *  messages 供段内步骤语义计数,点击 toggle 所属 work fold。 */
export function WorkFoldRow({
  fold,
  messages,
  open,
  onToggle,
  t,
}: {
  fold: StepFold;
  /** 段内消息(供 tallySteps 步骤语义计数;缺省则只显时长 + edits)。 */
  messages?: ClaudeMessage[];
  open: boolean;
  onToggle: () => void;
  t: (k: string, params?: Record<string, unknown>) => string;
}) {
  const worked = formatDuration(fold.workedMs ?? 0);
  const edits = fold.edits;
  const tally = messages ? tallySteps(messages, fold.start, fold.end) : null;
  const phrases = tally ? tallyPhrases(tally, t) : [];
  const editsStr =
    edits && edits.files > 0
      ? [
          t("fold.files", { n: edits.files }),
          edits.added > 0 ? `+${edits.added}` : null,
          edits.removed > 0 ? `-${edits.removed}` : null,
        ]
        .filter(Boolean)
        .join(" ")
      : null;
  const detail = [phrases.join(t("fold.separator")), editsStr].filter(Boolean).join(" · ") || undefined;
  return (
    <StepRow
      verb={t("fold.worked", { d: worked })}
      detail={detail}
      expanded={open}
      onToggle={onToggle}
      testId="work-fold-row"
    />
  );
}
