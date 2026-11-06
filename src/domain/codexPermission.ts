/**
 * Codex `/permissions` 的四个产品档位。
 *
 * 这不是单纯 approval_policy 枚举：TUI 把“审批策略 + 审批 reviewer + sandbox”组合成
 * permission profile。桌面端保持同一口径，并在下一轮 exec 时映射回 CLI 参数。
 */
export type CodexPermissionProfile = {
  id: "ask-for-approval" | "approve-for-me" | "full-access" | "read-only";
  shortLabelKey: string;
  labelKey: string;
  descKey: string;
  sandbox: "workspace-write" | "danger-full-access" | "read-only";
  approval: "untrusted" | "on-request" | "never";
};

export const CODEX_PERMISSION_PROFILES: CodexPermissionProfile[] = [
  {
    id: "ask-for-approval",
    shortLabelKey: "codexpane.permissionAskShort",
    labelKey: "codexpane.permissionAsk",
    descKey: "codexpane.permissionAskDesc",
    sandbox: "workspace-write",
    // untrusted:白名单命令免问,其余每步都问(2026-11-04 修正,此前与 auto 同参)。
    approval: "untrusted",
  },
  {
    id: "approve-for-me",
    shortLabelKey: "codexpane.permissionAutoShort",
    labelKey: "codexpane.permissionAuto",
    descKey: "codexpane.permissionAutoDesc",
    sandbox: "workspace-write",
    // on-request:工作区内自动,沙箱越界升级审批询问(此前误标/误映射 never,越界被静默拒)。
    approval: "on-request",
  },
  {
    id: "full-access",
    shortLabelKey: "codexpane.permissionFullShort",
    labelKey: "codexpane.permissionFull",
    descKey: "codexpane.permissionFullDesc",
    sandbox: "danger-full-access",
    approval: "never",
  },
  {
    id: "read-only",
    shortLabelKey: "codexpane.permissionReadShort",
    labelKey: "codexpane.permissionRead",
    descKey: "codexpane.permissionReadDesc",
    sandbox: "read-only",
    approval: "on-request",
  },
];

export const DEFAULT_CODEX_PERMISSION = "ask-for-approval";

export function codexPermissionProfile(id: string | undefined | null): CodexPermissionProfile {
  return CODEX_PERMISSION_PROFILES.find((p) => p.id === id) ?? CODEX_PERMISSION_PROFILES[0];
}
