/**
 * 远程中继(移动伴侣)设置面板:v4 纯账密体系。
 *
 * 桌面端唯一入口 = 账号登录(relay_login,client="desktop"):成功即落盘连接并顺手把
 * pairKey 密文包发布到中继 vault(手机端同账号登录即可解出配对凭证,无扫码)。
 * 传输层身份 = 账号 session;扫码/静态 token/本地直连/内置中继已在 v4 移除。
 * 协议与设计:.work/design/20261027-local-pairing-relay-auth/。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "./ui/Button";
import { CopyButton } from "./ui/CopyButton";

type RelayStatus = "online" | "connecting" | "offline";

type RelayStatusInfo = {
  enabled: boolean;
  status: RelayStatus;
  url: string;
  userId: string;
  deviceId: string;
  lastError: string | null;
  connectedSince: number | null;
  username: string;
  isAdmin: boolean;
  sessionExpiresAt: number | null;
};

const inputCls =
  "w-full rounded-[var(--mx-radius-md)] border border-[var(--mx-border-strong)] bg-[var(--mx-surface-2)] px-2 py-1 text-[12px] text-[var(--mx-text)] outline-none transition-colors placeholder:text-[var(--mx-faint)] focus-visible:border-[var(--mx-accent)] focus-visible:ring-1 focus-visible:ring-[var(--mx-accent)]";

/** 强密码口径(与中继 passwordOK 一致):8~128 位,且同时包含字母与数字。
 *  注册/改密提交前先本地拦,别等服务器 400。 */
const strongPassword = (s: string) =>
  s.length >= 8 && s.length <= 128 && /[A-Za-z]/.test(s) && /\d/.test(s);

/** 中继地址必填口径:ws(s):// 开头(注册/登录提交前本地拦,给出明确错误而非按钮静默灰)。 */
const urlInputOk = (s: string) => /^wss?:\/\/\S+$/i.test(s.trim());

export function RelayPanel() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<RelayStatusInfo | null>(null);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  // 注册与登录(2026-10-30 用户定调:注册成功即自动登录)。
  const [regMode, setRegMode] = useState(false);
  const [regBusy, setRegBusy] = useState(false);
  // 邀请码(registerMode=invite 的中继必填;off/open 模式服务端忽略该字段)。
  const [inviteCode, setInviteCode] = useState("");
  // 改密(内联折叠面板:旧密码 + 新密码 + 确认)。
  const [pwdOpen, setPwdOpen] = useState(false);
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdMsg, setPwdMsg] = useState<string | null>(null);
  // 登出二次确认(手机端同会话凭证会一起断开,值得 arm 确认)。
  const [logoutArmed, setLogoutArmed] = useState(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const st = await invoke<RelayStatusInfo>("get_relay_status");
      if (!aliveRef.current) return;
      setInfo(st);
      // 表单只在首次加载时播种(用户编辑中不被轮询覆盖)。
      setUrl((u) => (u ? u : st.url));
    } catch {
      /* 非桌面环境(mock)无命令,保持空态即可 */
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const timer = setInterval(refresh, 3000); // 连接异步建立,轮询让状态点实时翻转
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  /** 账号登录:POST /login(client=desktop)拿 session token,成功即落盘并连上。
   *  登录同时把 pairKey 密文包发布到中继 vault(手机端同账号登录即可配对)。 */
  const login = async () => {
    // 注册/登录都先过这道:中继地址是必填(2026-10-30 用户定调),格式不对照样拦。
    if (!urlInputOk(url)) {
      setLoggingIn(false);
      setLoginErr(t("settings.relay.urlRequired"));
      return;
    }
    setLoggingIn(true);
    setLoginErr(null);
    setLoginNote(null);
    const uname = username.trim();
    try {
      const r = await invoke<{
        userId: string; token: string; expiresAt: number;
        isAdmin: boolean; vaultPublished: boolean; vaultError: string | null;
      }>("relay_login", {
        url: url.trim(),
        username: uname,
        password,
      });
      const st = await invoke<RelayStatusInfo>("save_relay_config", {
        url: url.trim(),
        userId: r.userId,
        token: r.token,
        username: uname,
        expiresAt: r.expiresAt,
      });
      if (aliveRef.current) {
        setInfo(st);
        setPassword(""); // 密码用完即弃,不驻内存
        setLoginNote(r.vaultPublished
          ? t("settings.relay.vaultOk")
          : t("settings.relay.vaultFail", { err: r.vaultError ?? "" }));
      }
    } catch (e) {
      if (aliveRef.current) setLoginErr(String(e));
    } finally {
      if (aliveRef.current) setLoggingIn(false);
    }
  };

  /** 自助注册:POST /register(准入看中继 registerMode)。注册成功**即自动登录**
   *  (2026-10-30 用户定调;原先注册后清密码切回登录表单,登录按钮因密码为空被禁用,
   *  表现就是「点了没反应」)。密码留在框里交给 login,成功后由它清;登录失败可重试。 */
  const register = async () => {
    if (!urlInputOk(url)) {
      setLoginErr(t("settings.relay.urlRequired"));
      return;
    }
    setRegBusy(true);
    setLoginErr(null);
    setLoginNote(null);
    // 强密码先本地拦一道(与中继 passwordOK 同口径),别等服务器 400。
    if (!strongPassword(password)) {
      setLoginErr(t("settings.relay.weakPassword"));
      setRegBusy(false);
      return;
    }
    try {
      await invoke("relay_register", {
        url: url.trim(),
        username: username.trim(),
        password,
        inviteCode: inviteCode.trim() || null,
      });
      if (!aliveRef.current) return;
      setInviteCode("");
      setRegMode(false);
      await login();
    } catch (e) {
      if (aliveRef.current) setLoginErr(String(e));
    } finally {
      if (aliveRef.current) setRegBusy(false);
    }
  };

  /** 自助改密:成功后后端用新密码重发布 vault(手机端新密码仍可自动配对)。 */
  const changePwd = async () => {
    setLoginErr(null);
    if (!strongPassword(newPwd)) { setPwdMsg(t("settings.relay.weakPassword")); return; }
    if (newPwd !== newPwd2) { setPwdMsg(t("settings.relay.pwdMismatch")); return; }
    setPwdBusy(true);
    setPwdMsg(null);
    try {
      const r = await invoke<{ vaultRepublished: boolean; vaultError: string | null }>(
        "relay_change_password", { oldPassword: oldPwd, newPassword: newPwd },
      );
      if (!aliveRef.current) return;
      setOldPwd(""); setNewPwd(""); setNewPwd2("");
      setPwdOpen(false);
      setPwdMsg(null);
      setLoginNote(r.vaultRepublished
        ? t("settings.relay.changePwdOk")
        : t("settings.relay.changePwdOkNoVault", { err: r.vaultError ?? "" }));
    } catch (e) {
      if (aliveRef.current) setPwdMsg(String(e));
    } finally {
      if (aliveRef.current) setPwdBusy(false);
    }
  };

  /** 登出:吊销会话(手机端同会话凭证一并失效)+ 清配置停任务;arm 两次点击防误触。 */
  const logout = async () => {
    if (!logoutArmed) {
      setLogoutArmed(true);
      setTimeout(() => aliveRef.current && setLogoutArmed(false), 4000);
      return;
    }
    setLogoutArmed(false);
    setLoginNote(null);
    try {
      const st = await invoke<RelayStatusInfo>("relay_logout");
      if (aliveRef.current) {
        setInfo(st);
        setUsername("");
        setPassword("");
        setPwdOpen(false);
      }
    } catch (e) {
      console.error("relay_logout:", e);
    }
  };

  const statusMeta = (() => {
    if (!info?.enabled) return { color: "var(--mx-faint)", label: t("settings.relay.statusDisabled") };
    switch (info.status) {
      case "online": return { color: "#22c55e", label: t("settings.relay.statusOnline") };
      case "connecting": return { color: "#f59e0b", label: t("settings.relay.statusConnecting") };
      default: return { color: "#ef4444", label: t("settings.relay.statusOffline") };
    }
  })();

  return (
    <div className="flex flex-col gap-5 pb-6">
      {/* 中继连接状态 */}
      <section>
        <div className="mb-1.5 text-[12px] font-medium text-[var(--mx-text)]">{t("settings.relay.title")}</div>
        <p className="mb-2.5 text-[11px] leading-relaxed text-[var(--mx-muted)]">{t("settings.relay.desc")}</p>
        <div className="flex items-center gap-2 rounded-[var(--mx-radius-md)] border border-[var(--mx-border)] bg-[var(--mx-card-inner)] px-3 py-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusMeta.color }} />
          <span className="text-[12px] text-[var(--mx-text)]">{statusMeta.label}</span>
          {info?.username && (
            <span className="text-[11px] text-[var(--mx-muted)]">{info.username}</span>
          )}
          {info?.deviceId && (
            <span className="ml-auto font-mono text-[10px] text-[var(--mx-faint)]">{info.deviceId}</span>
          )}
        </div>
        {info?.lastError && (
          <p className="mt-1.5 text-[11px] text-[var(--mx-danger-bright)]">{info.lastError}</p>
        )}
      </section>

      {/* 账号:登录 | 注册(v4 唯一认证入口) */}
      <section>
        <div className="mb-1.5 text-[12px] font-medium text-[var(--mx-text)]">{t("settings.relay.cfgTitle")}</div>
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--mx-muted)]">
              {/* 空 = 还没配过,标「必填」引导(与手机端登录页同口径);已有值显示普通标签。 */}
              {url.trim() ? t("settings.relay.fldUrl") : t("settings.relay.fldUrlRequired")}
            </span>
            <input className={`${inputCls} font-mono`} value={url} placeholder="wss://relay.example.com/ws"
              onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
            {!url.trim() && (
              <span className="text-[10px] text-[var(--mx-faint)]">{t("settings.relay.urlHint")}</span>
            )}
          </label>
          {/* 已登录态(用户名非空):只显示账号卡(改密/登出)——登录/注册入口
              收起,退出登录后表单回来(切换账号 = 登出再登录,会话吊销语义更干净)。 */}
          {info?.username ? (
            <div className="flex flex-col gap-2 rounded-[var(--mx-radius-md)] border border-[var(--mx-border)] bg-[var(--mx-card-inner)] px-2.5 py-2">
              <div className="flex items-center gap-2 text-[12px]">
                <span className="text-[var(--mx-text-bright)]">{info.username}</span>
                {info.isAdmin && (
                  <span className="rounded-sm bg-[var(--mx-warning-soft)] px-1 py-px text-[10px] text-[var(--mx-warning)]">
                    {t("settings.relay.adminBadge")}
                  </span>
                )}
                {info.sessionExpiresAt != null && (
                  <span className="ml-auto text-[10px] text-[var(--mx-faint)]">
                    {t("settings.relay.sessionUntil", {
                      date: new Date(info.sessionExpiresAt * 1000).toLocaleDateString(),
                    })}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setPwdOpen((v) => !v); setPwdMsg(null); }}>
                  {t("settings.relay.changePwdBtn")}
                </Button>
                <Button variant="ghost" size="sm" className={logoutArmed ? "!text-[var(--mx-danger-bright)]" : ""}
                  onClick={logout}>
                  {logoutArmed ? t("settings.relay.logoutArmed") : t("settings.relay.logoutBtn")}
                </Button>
              </div>
              {pwdOpen && (
                <div className="flex flex-col gap-1.5 border-t border-[var(--mx-border)] pt-2">
                  <input className={inputCls} type="password" value={oldPwd} placeholder={t("settings.relay.fldOldPassword")}
                    onChange={(e) => setOldPwd(e.target.value)} autoComplete="off" />
                  <input className={inputCls} type="password" value={newPwd} placeholder={t("settings.relay.fldNewPassword")}
                    onChange={(e) => setNewPwd(e.target.value)} autoComplete="new-password" />
                  <input className={inputCls} type="password" value={newPwd2} placeholder={t("settings.relay.fldNewPassword2")}
                    onChange={(e) => setNewPwd2(e.target.value)} autoComplete="new-password"
                    onKeyDown={(e) => { if (e.key === "Enter" && oldPwd && newPwd) void changePwd(); }} />
                  {pwdMsg && <p className="text-[11px] text-[var(--mx-danger-bright)]">{pwdMsg}</p>}
                  <div className="flex items-center gap-2">
                    <Button variant="accent" size="sm" disabled={pwdBusy || !oldPwd || !newPwd} onClick={changePwd}>
                      {pwdBusy ? t("settings.relay.pwdBusy") : t("settings.relay.pwdConfirm")}
                    </Button>
                    <span className="text-[10px] text-[var(--mx-faint)]">{t("settings.relay.pwdHint")}</span>
                  </div>
                </div>
              )}
            </div>
          ) : null}
          {info?.username ? (
            <>
              {loginNote && <p className="text-[11px] leading-relaxed text-[var(--mx-success)]">{loginNote}</p>}
              {/* 手机端配对指引:登录 + vault 发布成功后,手机同账号登录即自动配对。 */}
              <div className="flex items-center gap-1.5">
                <CopyButton text={info.url} t={t} className="opacity-80" />
                <span className="text-[10px] text-[var(--mx-faint)]">{t("settings.relay.copyUrl")}</span>
              </div>
            </>
          ) : (
          <>
          {/* 登录 | 注册 切换(注册成功即自动登录)。 */}
          <div className="flex items-center gap-1">
            {(["login", "register"] as const).map((m) => (
              <button key={m} type="button"
                className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                  (m === "register") === regMode
                    ? "bg-[var(--mx-accent-soft)] text-[var(--mx-accent-bright)] font-semibold"
                    : "text-[var(--mx-muted)] hover:text-[var(--mx-text)]"
                }`}
                onClick={() => { setRegMode(m === "register"); setLoginErr(null); setLoginNote(null); }}>
                {m === "login" ? t("settings.relay.loginTab") : t("settings.relay.regTab")}
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--mx-faint)]">
            {regMode ? t("settings.relay.regDesc") : t("settings.relay.accountDesc")}
          </p>
          {regMode && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--mx-muted)]">{t("settings.relay.fldInviteCode")}</span>
              <input className={`${inputCls} font-mono uppercase`} value={inviteCode}
                placeholder="XXXX-XXXX" spellCheck={false} autoComplete="off"
                onChange={(e) => setInviteCode(e.target.value)} />
            </label>
          )}
          <div className="flex gap-2.5">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[11px] text-[var(--mx-muted)]">{t("settings.relay.fldUsername")}</span>
              <input className={inputCls} value={username} placeholder="alice"
                onChange={(e) => setUsername(e.target.value)} spellCheck={false} autoComplete="off" />
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[11px] text-[var(--mx-muted)]">{t("settings.relay.fldPassword")}</span>
              <input className={inputCls} type="password" value={password} placeholder="••••••••"
                onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
                onKeyDown={(e) => {
                  // 地址不在这里拦(交给 register/login 统一报「请填写中继地址」)。
                  if (e.key === "Enter" && username && password) void (regMode ? register() : login());
                }} />
            </label>
          </div>
          {loginErr && <p className="text-[11px] text-[var(--mx-danger-bright)]">{loginErr}</p>}
          {loginNote && <p className="text-[11px] leading-relaxed text-[var(--mx-success)]">{loginNote}</p>}
          <div className="flex items-center gap-2">
            {regMode ? (
              <Button variant="accent" size="sm" onClick={register}
                disabled={regBusy || !username || !password}>
                {regBusy ? t("settings.relay.regBusy") : t("settings.relay.registerBtn")}
              </Button>
            ) : (
              <Button variant="accent" size="sm" onClick={login}
                disabled={loggingIn || !username || !password}>
                {loggingIn ? t("settings.relay.loggingIn") : t("settings.relay.loginBtn")}
              </Button>
            )}
            <span className="text-[10px] text-[var(--mx-faint)]">
              {regMode ? t("settings.relay.regHint") : t("settings.relay.loginHint")}
            </span>
          </div>
          </>
          )}
        </div>
      </section>
    </div>
  );
}
