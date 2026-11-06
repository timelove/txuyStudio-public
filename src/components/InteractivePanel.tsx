// BaoCode P1.2 — InteractivePanel 统一驱动
//
// 借鉴:BaoCode interaction_panel.dart 中 QuestionRequest + ApprovalRequest
// 合并到同一组件,同一键盘行为。我们这里 ApprovalRequest 已存在(替换
// ClaudePane.PermissionConfirmCard),QuestionRequest 是未来预留(当前 stream-json
// 协议暂无该字段,组件已具备渲染路径)。
//
// 组件语义:接收 InteractiveRequest,内部 useReducer 推 state,键盘 / 鼠标
// 派发 InteractiveEvent,onAnswer 出口被调用方消化。
//
// 折叠态:点击 header 整体折叠,折叠态 Enter 展开,Esc 仍 dismiss(approval
// 拒绝无 reason,question 跳过)。
//
// approval 与 question 的交互差异(2026-10-27 收敛,替代旧「rows + 底部三按钮」重复布局):
// - approval:行即动作 —— 点击 / 数字键直接派发决策(拒绝行进 deny 模式,可填原因后提交),
//   Enter 按 highlighted 行派发,Esc 直接拒绝;底部条只留键位提示,不再重复一组按钮。
// - question:行是候选答案,先选(Space 多选 / 数字单选)后提交,底部保留 上一步 / 提交。

import { useEffect, useReducer, useRef, useState } from "react";
import {
  type InteractiveAnswer,
  type InteractiveEvent,
  type InteractiveRequest,
  type InteractiveRow,
  type InteractiveState,
  deriveAnswer,
  initInteractiveState,
  interactiveReducer,
} from "../domain/interactive";

/** i18n t 函数(本组件不直接 import i18n,接受 t 形参,便于单测 mock)。 */
type T = (k: string, params?: Record<string, unknown>) => string;

export interface InteractivePanelProps {
  request: InteractiveRequest;
  t: T;
  /** 唯一出口;answer 给定后组件保持挂载(调用方控制 onAnswer 后置空 request 卸载)。 */
  onAnswer: (answer: InteractiveAnswer) => void;
  /** approval 模式下 allowAlways 按钮的智能文案(由 caller 派生)。 */
  alwaysAllowLabel?: string;
  /** 0-based 当前 keyboard 活跃 highlight(由父级 hotkey 域计算后传入);
   *  不传则组件自己用内部 state.highlighted。 */
  externalHighlight?: number;
  /** 测试 / 调试用:disable 内部 useEffect 的 focus 行为。 */
  noAutoFocus?: boolean;
}

export function InteractivePanel({
  request,
  t,
  onAnswer,
  alwaysAllowLabel,
  externalHighlight,
  noAutoFocus,
}: InteractivePanelProps) {
  // 关键:reducer 闭包必须绑到当前 step,所以每 render 重新构造;
  // React useReducer 接受 inline arrow 是允许的(dispatch 引用稳定)。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reducer = (s: InteractiveState, ev: InteractiveEvent) =>
    interactiveReducer(s, ev, currentStep);

  // step 由组件自管(state.step 来自 initInteractiveState 但我们不依赖,改用本地 step,
  // 简单且可预测;多 step question 时由 caller 切换 request 重挂载)。
  const [step, setStep] = useState(0);
  const currentStep = request.steps[step] ?? request.steps[0];
  const isLastStep = step >= request.steps.length - 1;
  const isQuestion = request.kind === "question";
  const isApproval = request.kind === "approval";
  const headerIcon = isQuestion ? "?" : "!";
  const headerLabel = isQuestion
    ? t("interactive.headerQuestion")
    : t("interactive.headerApproval");

  const [state, dispatch] = useReducer(reducer, request, (req) =>
    initInteractiveState(req),
  );
  const [collapsed, setCollapsed] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const highlighted = externalHighlight ?? state.highlighted;

  useEffect(() => {
    if (noAutoFocus) return;
    rootRef.current?.focus();
  }, [noAutoFocus]);

  function advance() {
    if (isLastStep) {
      onAnswer(deriveAnswer(request, state));
    } else {
      setStep(step + 1);
    }
  }

  function goBack() {
    if (step === 0) return;
    setStep(step - 1);
  }

  function submitAllowOnce() {
    onAnswer({ kind: "approval", decision: "allow" });
  }
  function submitAllowAlways() {
    onAnswer({ kind: "approval", decision: "allowAlways" });
  }
  function submitDeny() {
    onAnswer({
      kind: "approval",
      decision: "deny",
      message: state.denyText,
    });
  }
  function submitQuestion() {
    onAnswer(deriveAnswer(request, state));
  }

  // approval 行文案映射:哨兵标签(__allowAlways__ / __deny__,见 ClaudePane rows 约定)
  // 渲染时换成人类文案,其中 always-allow 行优先用调用方的智能文案(如「允许此项目的
  // Bash」);question 行无哨兵约定,原样渲染。
  function rowDisplay(row: InteractiveRow): { label: string; description?: string } {
    if (!isApproval) return row;
    if (row.label === "__allowAlways__")
      return { label: alwaysAllowLabel ?? t("interactive.alwaysAllow") };
    if (row.label === "__deny__") return { label: t("interactive.deny") };
    return row;
  }

  // approval 行即动作:点击 / 数字键 / Enter 三路共用同一派发 —— 非哨兵行 = allow(默认),
  // __allowAlways__ 行 = allowAlways,__deny__ 行进 deny 模式(展开原因输入,可留空提交)。
  // 「先选后提交」的选择语义只属于 question;approval 一行一个决策,点了就走。
  function executeApprovalRow(i: number) {
    const row = currentStep.rows[i];
    if (!row) return;
    dispatch({ type: "highlight", row: i });
    if (row.label === "__deny__") {
      dispatch({ type: "enterDenyMode" });
    } else if (row.label === "__allowAlways__") {
      submitAllowAlways();
    } else {
      submitAllowOnce();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (collapsed) {
      if (e.key === "Enter") {
        e.preventDefault();
        setCollapsed(false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (request.kind === "question") {
          onAnswer(deriveAnswer(request, state, { skipped: true }));
        } else {
          onAnswer({ kind: "approval", decision: "deny" });
        }
      }
      return;
    }
    if (state.denyMode) {
      if (e.key === "Escape") {
        e.preventDefault();
        dispatch({ type: "cancelDeny" });
      }
      return; // textarea 自身处理 Enter
    }
    if (/^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      if (idx < currentStep.rows.length) {
        e.preventDefault();
        if (isApproval) {
          // approval:数字键直接执行对应行(question 才是选中待提交)。
          executeApprovalRow(idx);
        } else {
          dispatch({ type: "select", row: idx });
        }
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const max = currentStep.rows.length - 1;
      const next =
        e.key === "ArrowDown" ? highlighted + 1 : highlighted - 1;
      dispatch({ type: "highlight", row: Math.max(0, Math.min(max, next)) });
      return;
    }
    if (e.key === " " && currentStep.multiple) {
      e.preventDefault();
      dispatch({ type: "select", row: highlighted });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (isQuestion) {
        advance();
      } else {
        // approval:Enter 按 highlighted 行派发(与点击行同一动作)。
        executeApprovalRow(highlighted);
      }
      return;
    }
    if (e.key === "ArrowLeft" && step > 0) {
      e.preventDefault();
      goBack();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (request.kind === "question") {
        onAnswer(deriveAnswer(request, state, { skipped: true }));
      } else {
        onAnswer({ kind: "approval", decision: "deny" });
      }
    }
  }

  function clickRow(idx: number) {
    if (isApproval) {
      // approval 行点击即执行;「先选后提交」只属于 question。
      executeApprovalRow(idx);
      return;
    }
    dispatch({ type: "highlight", row: idx });
    dispatch({ type: "select", row: idx });
  }

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      // min-w-0:面板挂在消息流 flex/grid 轨道内,内容(命令/路径长串)按 min-content 撑宽时
      // 会把父容器顶破 → 消息流出横向滚动条/卡宽超出内容列。min-w-0 让本卡可收缩,
      // 超宽内容交给内部 pre/detail 的 overflow-auto 兜底。
      className="my-1.5 min-w-0 overflow-hidden rounded-lg border border-[var(--mx-orange-border)] bg-[var(--mx-orange-soft)] shadow-[0_0_0_1px_var(--mx-orange-soft)] outline-none focus:ring-1 focus:ring-[var(--mx-accent-bright)]"
      data-testid="interactive-panel"
    >
      <div
        className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs cursor-pointer select-none"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--mx-warning-soft)] text-[10px] font-bold text-[var(--mx-warning-bright)]">
          {headerIcon}
        </span>
        <span className="font-semibold text-[var(--mx-warning)]">
          {headerLabel}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--mx-text)]" title={request.title}>
          {request.title}
        </span>
        {isQuestion && request.steps.length > 1 && (
          <span className="inline-flex items-center gap-1" aria-label="progress">
            {request.steps.map((_, i) => (
              <span
                key={i}
                className="rounded-full"
                style={{
                  width: i === step ? "8px" : "5px",
                  height: i === step ? "8px" : "5px",
                  background:
                    i < step
                      ? "var(--mx-success-bright)"
                      : i === step
                        ? "var(--mx-accent-bright)"
                        : "var(--mx-faint)",
                }}
              />
            ))}
            <span className="ml-1 text-[10px] text-[var(--mx-faint)]">
              {t("interactive.questionStepOf", {
                n: step + 1,
                total: request.steps.length,
              })}
            </span>
          </span>
        )}
        <span className="ml-auto text-[10px] text-[var(--mx-faint)]">
          {collapsed ? t("interactive.expand") : t("interactive.collapse")}
        </span>
      </div>

      {!collapsed && (
        <>
          {currentStep.detail && (
            <div className="min-w-0 border-t border-[var(--mx-orange-border)] px-3 py-1.5 text-[11px]">
              {currentStep.detail}
            </div>
          )}

          {!state.denyMode && (
            <div className="min-w-0 border-t border-[var(--mx-orange-border)] bg-[var(--mx-orange-soft)]">
              {currentStep.rows.map((row, i) => {
                const isHighlighted = i === highlighted;
                const isSelected = state.picks[step]?.has(i) ?? false;
                const display = rowDisplay(row);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => clickRow(i)}
                    data-testid={`row-${i}`}
                    className={
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors " +
                      (isHighlighted
                        ? "bg-[var(--mx-hover-bg)] text-[var(--mx-text)]"
                        : "text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]")
                    }
                  >
                    {isApproval ? (
                      /* approval 行即动作:左侧键帽数字对应 1-3 直选(question 才是复选框)。 */
                      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border border-[var(--mx-border-strong)] font-mono text-[9px] font-bold text-[var(--mx-faint)]">
                        {i + 1}
                      </span>
                    ) : (
                      <span
                        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border"
                        style={{
                          borderColor: isSelected
                            ? "var(--mx-accent-bright)"
                            : "var(--mx-border-strong)",
                          background: isSelected
                            ? "var(--mx-accent-bright)"
                            : "transparent",
                        }}
                      >
                        {isSelected && (
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="white"
                            strokeWidth="3"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                    )}
                    <span className="flex-1 truncate">{display.label}</span>
                    {display.description && (
                      <span className="truncate text-[10px] text-[var(--mx-faint)]">
                        {display.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {request.kind === "approval" && state.denyMode && (
            <div className="space-y-1.5 border-t border-[var(--mx-orange-border)] bg-[var(--mx-orange-soft)] px-3 py-2">
              <textarea
                autoFocus
                rows={2}
                value={state.denyText}
                onChange={(e) =>
                  dispatch({ type: "setDenyText", text: e.target.value })
                }
                placeholder={t("interactive.denyReasonPlaceholder")}
                className="block w-full resize-y rounded-md border border-[var(--mx-orange-border)] bg-transparent px-2 py-1.5 text-[11px] text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)] focus:border-[var(--mx-orange-border)] focus:ring-1 focus:ring-[var(--mx-orange-border)]"
                data-testid="deny-textarea"
              />
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => dispatch({ type: "cancelDeny" })}
                  className="inline-flex items-center rounded-md border border-[var(--mx-border-strong)] bg-transparent px-2.5 py-1 text-[11px] font-medium text-[var(--mx-muted)] transition-colors hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                >
                  {t("claudepane.denyCancel")}
                </button>
                <button
                  type="button"
                  onClick={submitDeny}
                  className="inline-flex items-center rounded-md bg-[var(--mx-accent-deep)] px-2.5 py-1 text-[11px] font-medium text-white"
                >
                  {t("claudepane.denySubmit")}
                </button>
              </div>
            </div>
          )}

          {!state.denyMode && (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-[var(--mx-orange-border)] bg-[var(--mx-orange-soft)] px-3 py-1.5 text-[10px] text-[var(--mx-faint)]">
              {isApproval ? (
                // approval:决策动作就是上方几行,底部只留键位提示(旧布局在此还重复一组
                // 「批准/总是允许/拒绝」按钮,观感冗余,已随「行即动作」收敛删除)。
                <span>{t("interactive.hintApproval")}</span>
              ) : (
                <>
                  <span>{t("interactive.hintChoose")}</span>
                  {step > 0 && <span>{t("interactive.hintBack")}</span>}
                  <span>{t("interactive.hintSkip")}</span>
                  <span>{t("interactive.hintContinue")}</span>
                </>
              )}
              {isQuestion && (
                <div className="ml-auto flex items-center gap-1.5">
                  {step > 0 && (
                    <button
                      type="button"
                      onClick={goBack}
                      className="inline-flex items-center rounded-md border border-[var(--mx-border-strong)] bg-transparent px-2.5 py-1 text-[11px] font-medium text-[var(--mx-muted)] hover:bg-[var(--mx-hover-bg)] hover:text-[var(--mx-text)]"
                    >
                      {t("interactive.back")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={submitQuestion}
                    className="inline-flex items-center rounded-md bg-[var(--mx-accent-deep)] px-2.5 py-1 text-[11px] font-medium text-white"
                    data-testid="submit"
                  >
                    {isLastStep ? t("interactive.submit") : t("interactive.next")}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
