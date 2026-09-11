import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/Button";

/** check_dev_environment 返回(camelCase 对齐 system::EnvCheck)。 */
type EnvCheckResult = {
  defenderAvailable: boolean;
  realTimeProtection: OptionBool;
  pnpmStoreExcluded: OptionBool;
  pnpmStorePath: string | null;
  nodeExcluded: OptionBool;
  txuyExcluded: OptionBool;
};
type OptionBool = boolean | null;

/**
 * 设置 → 通用「环境体检」分区:检测 Defender 是否会拦截 pnpm 等包管理器
 * (高并发小文件 + junction 是实时扫描重点,本机 EPERM/「unknown 权限」几乎都源于此)。
 * **只读检测**——修复命令拼好进剪贴板,用户到管理员 PowerShell 粘贴执行(应用不提权)。
 */
export function EnvCheckSection() {
  const { t } = useTranslation();
  const [check, setCheck] = useState<EnvCheckResult | null>(null);
  const [copied, setCopied] = useState(false);

  const run = useCallback(() => {
    invoke<EnvCheckResult>("check_dev_environment")
      .then(setCheck)
      .catch(() => setCheck(null));
  }, []);
  useEffect(run, [run]);

  // 风险判定:Defender 开着 + 任一关键项未排除 → 有拦截风险(琥珀)。
  const atRisk =
    check?.defenderAvailable === true &&
    (check.pnpmStoreExcluded === false || check.nodeExcluded === false || check.txuyExcluded === false);

  const copyFix = () => {
    const lines = [
      "# 在管理员 PowerShell 中执行(为 pnpm/node/txuyStudio 添加 Defender 排除,根治 install 时的权限报错):",
      `Add-MpPreference -ExclusionPath "${check?.pnpmStorePath ?? "$env:LOCALAPPDATA\\pnpm\\store"}"`,
      'Add-MpPreference -ExclusionProcess "node.exe"',
      'Add-MpPreference -ExclusionProcess "txuy-studio.exe"',
    ];
    navigator.clipboard.writeText(lines.join("\n")).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };

  if (!check) return null; // 非 Tauri 环境/查询失败:整区不渲染。

  return (
    <section className="mb-4">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-[var(--mx-faint)]">{t("settings.envCheck.title")}</span>
        <button
          type="button"
          onClick={run}
          className="cursor-pointer text-[10px] text-[var(--mx-muted)] transition-colors hover:text-(color:--mx-text)"
        >
          {t("settings.envCheck.rerun")}
        </button>
      </div>
      <div
        className={`rounded border px-2.5 py-2 text-[11px] leading-relaxed ${
          atRisk
            ? "border-[var(--mx-warning)]/40 bg-[var(--mx-warning)]/5"
            : "border-[var(--mx-border-soft)] bg-[var(--mx-surface)]"
        }`}
      >
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${atRisk ? "bg-[var(--mx-warning)]" : "bg-[var(--mx-success)]"}`}
          />
          <span className={atRisk ? "text-(color:--mx-warning)" : "text-(color:--mx-success)"}>
            {atRisk ? t("settings.envCheck.atRisk") : t("settings.envCheck.ok")}
          </span>
        </div>
        <div className="mt-1 space-y-0.5 text-[var(--mx-muted)]">
          <CheckRow label={t("settings.envCheck.realTime")} value={check.realTimeProtection} on={check.realTimeProtection === true} />
          <CheckRow label={t("settings.envCheck.pnpmStore")} value={check.pnpmStoreExcluded} on={check.pnpmStoreExcluded === true} />
          <CheckRow label={t("settings.envCheck.node")} value={check.nodeExcluded} on={check.nodeExcluded === true} />
          <CheckRow label={t("settings.envCheck.txuy")} value={check.txuyExcluded} on={check.txuyExcluded === true} />
        </div>
        {atRisk && (
          <div className="mt-2 flex items-start justify-between gap-2">
            <span className="min-w-0 flex-1 text-[var(--mx-faint)]">{t("settings.envCheck.fixHint")}</span>
            <Button variant="default" size="xs" onClick={copyFix} className="shrink-0">
              {copied ? t("settings.envCheck.copied") : t("settings.envCheck.copyFix")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** 单项行:✓/✕/—(未知) + 标签。 */
function CheckRow({ label, value, on }: { label: string; value: OptionBool; on: boolean }) {
  const mark = value === null ? "—" : on ? "✓" : "✕";
  const color = value === null ? "text-(color:--mx-faint)" : on ? "text-(color:--mx-success)" : "text-(color:--mx-warning)";
  return (
    <div className="flex items-center gap-2">
      <span className={`w-3 shrink-0 text-center font-mono ${color}`}>{mark}</span>
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}
