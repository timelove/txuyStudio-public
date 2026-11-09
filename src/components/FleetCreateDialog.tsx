import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SplitDirection } from "../domain/paneTree";
import type { FleetWorkerView } from "../domain/fleet";
import { Button } from "./ui/Button";
import { FleetIcon } from "./ui/FleetIcon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/Dialog";
import { ToggleGroup, ToggleGroupItem } from "./ui/ToggleGroup";

type FleetCreateDialogProps = {
  /**
   * 创建上下文(哪个项目的哪个 pane 建入口 tab);null 时不显示。
   * direction:入口来自分屏菜单时的用户所选方向(新 worker 独立成 pane);
   * 新建 tab 菜单入口为 undefined(worker tab 加入原 pane 的 tab 栈)。
   */
  target: { projectId: string; paneId: string; direction?: SplitDirection } | null;
  /** 已存在的 workers(重名校验预显 + 顶部「直接选现有」列表;后端为准)。 */
  existingWorkers: FleetWorkerView[];
  onClose: () => void;
  /**
   * 确认创建:后端 create_fleet_worker 成功后由 AppShell 建 tab(返回建好的 tabId)。
   * Err 由对话框内联显示(非 git 仓 / 重名 / git 失败)。
   */
  onCreate: (taskId: string, provider: "claude" | "codex") => Promise<string | undefined>;
  /**
   * 选现有 worker:不建新 worktree。已挂 tab 由 AppShell 直接聚焦;未挂按 target
   * 同新建动线建 tab + 绑定(transport 首启 autoResumeLatest 续接该 worktree 上次会话)。
   */
  onAttach: (worker: FleetWorkerView) => void;
};

/** taskId 合法字符(与后端 create_fleet_worker 校验一致):字母/数字/._- */
const TASK_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Fleet Worker 创建/挂载对话框。
 *
 * 顶部「现有 workers」列表:选一个直接复用(不建新 worktree)——已挂 tab 的聚焦,
 * 未挂的在目标 pane 建 tab 绑定并自动续接该 worktree 的上次会话。下方新建表单
 * (taskId + provider 二选一)不变:输入实时校验(空/非法字符/重名),Create 按钮
 * 随合法性启用;后端 Err(非 git 仓、worktree add 失败等)内联展示,不关对话框。
 * 成功 → onClose 由调用方关闭并聚焦新 tab。
 */
export function FleetCreateDialog({ target, existingWorkers, onClose, onCreate, onAttach }: FleetCreateDialogProps) {
  const { t } = useTranslation();
  const [taskId, setTaskId] = useState("");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时清状态 + 聚焦输入框(每次打开都是全新会话)。
  useEffect(() => {
    if (target) {
      setTaskId("");
      setProvider("claude");
      setCreating(false);
      setError(null);
      // Dialog 挂载动画后再聚焦(Radix 自动聚焦第一个可聚焦元素通常已够,显式兜底)。
      const id = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
  }, [target]);

  if (!target) return null;

  const trimmed = taskId.trim();
  const idError = !trimmed
    ? null
    : !TASK_ID_RE.test(trimmed)
      ? t("fleet.create.idInvalid")
      : existingWorkers.some((w) => w.id === trimmed)
        ? t("fleet.create.idExists")
        : null;
  const canCreate = trimmed.length > 0 && !idError && !creating;

  const submit = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(trimmed, provider);
      onClose(); // 成功才关(AppShell 已建 tab 并聚焦)。
    } catch (e) {
      setError(String(e));
      setCreating(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[420px] max-w-[88vw] px-5 py-4">
        <DialogTitle className="sr-only">{t("fleet.create.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("fleet.create.desc")}</DialogDescription>

        {/* 标题行:git 分支图标(FleetIcon)+ 名称 + 一句话说明 */}
        <div className="flex items-center gap-2.5">
          <span
            className="mx-icon-tile grid h-6 w-6 shrink-0 place-items-center"
            style={{ background: "#f59e0b", color: "#0b1020" }}
          >
            <FleetIcon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--mx-text)]">{t("fleet.create.title")}</div>
            <div className="truncate text-[11px] text-[var(--mx-muted)]">{t("fleet.create.desc")}</div>
          </div>
        </div>

        {/* 现有 workers:选一个直接复用(已挂聚焦/未挂建 tab 续接),不建新 worktree */}
        {existingWorkers.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] text-[var(--mx-muted)]">{t("fleet.create.existingTitle")}</div>
            <div className="mt-1 max-h-[150px] overflow-auto rounded-[var(--mx-radius-md)] border border-[var(--mx-border)] bg-[var(--mx-surface-2)]">
              {existingWorkers.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  disabled={creating}
                  className="flex w-full items-center gap-2 border-b border-[var(--mx-border-soft)] px-2.5 py-1.5 text-left last:border-b-0 hover:bg-[var(--mx-hover-bg)] cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    onAttach(w);
                    onClose();
                  }}
                >
                  <span
                    className="mx-icon-tile grid h-4 w-4 shrink-0 place-items-center text-[9px] font-bold"
                    style={{
                      background: w.provider === "claude" ? "#7c3aed" : "#22d3ee",
                      color: "#0b1020",
                    }}
                  >
                    {w.provider === "claude" ? "C" : "X"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--mx-text)]">{w.id}</span>
                  {w.tabId ? (
                    <span className="shrink-0 text-[10px] text-[var(--mx-faint)]">{t("fleet.create.attached")}</span>
                  ) : (
                    <span className="shrink-0 text-[10px] text-[var(--mx-faint)]">
                      {t("fleet.create.changed", { n: w.changedFiles })}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 新建分隔:下方表单是建全新 worktree */}
        {existingWorkers.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <div className="h-px flex-1 bg-[var(--mx-border-strong)]" />
            <span className="text-[10px] text-[var(--mx-faint)]">{t("fleet.create.orNew")}</span>
            <div className="h-px flex-1 bg-[var(--mx-border-strong)]" />
          </div>
        )}

        {/* taskId:分支名/目录名组成部分,实时校验 */}
        <div className="mt-3">
          <label className="block text-[11px] text-[var(--mx-muted)]" htmlFor="fleet-task-id">
            {t("fleet.create.taskIdLabel")}
          </label>
          <input
            id="fleet-task-id"
            ref={inputRef}
            value={taskId}
            disabled={creating}
            onChange={(e) => setTaskId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="fix-login"
            spellCheck={false}
            autoComplete="off"
            data-1p-ignore
            className="mt-1 w-full rounded-[var(--mx-radius-md)] border border-[var(--mx-border-strong)] bg-[var(--mx-surface-2)] px-2.5 py-1.5 font-mono text-xs text-[var(--mx-text)] outline-none placeholder:text-[var(--mx-faint)] focus:border-[var(--mx-accent)]"
          />
          {/* 校验错误内联显示(输入即校验,不等提交) */}
          {idError && <div className="mt-1 text-[11px] text-[var(--mx-danger)]">{idError}</div>}
        </div>

        {/* provider 二选一:创建的 AI 会话引擎 */}
        <div className="mt-3">
          <span className="block text-[11px] text-[var(--mx-muted)]">{t("fleet.create.providerLabel")}</span>
          <ToggleGroup
            type="single"
            value={provider}
            onValueChange={(v) => v && setProvider(v as "claude" | "codex")}
            className="mt-1"
          >
            <ToggleGroupItem value="claude">Claude</ToggleGroupItem>
            <ToggleGroupItem value="codex">Codex</ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* 分支/路径预览:让用户知道会建什么 */}
        <div className="mt-3 rounded-[var(--mx-radius-md)] border border-[var(--mx-border-strong)] bg-[var(--mx-surface-2)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--mx-muted)]">
          <div>⎇ fleet/{trimmed || "…"}</div>
        </div>

        {/* 后端 Err(非 git 仓 / worktree add 失败)内联展示,不关对话框 */}
        {error && (
          <div className="mt-2 whitespace-pre-wrap break-words text-[11px] text-[var(--mx-danger)]">{error}</div>
        )}

        {/* 底部按钮 */}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={creating}>
            {t("common.cancel")}
          </Button>
          <Button variant="default" size="sm" disabled={!canCreate} onClick={() => void submit()}>
            {creating ? t("fleet.create.creating") : t("fleet.create.confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
