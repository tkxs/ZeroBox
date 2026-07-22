import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  configureRelayOrigin,
  createRelayApiKeys,
  getRelayCurrentUser,
  getRelayPublicSettings,
  hasStoredRelaySession,
  listRelayApiKeys,
  listRelayGroups,
  loginRelay,
  loginRelay2FA,
  RELAY_ORIGIN,
  type RelayGroup,
  type RelayPublicSettings,
  type RelayUser,
  registerRelay,
  sendRelayVerifyCode,
} from "../../lib/relay/client";
import { registerDesktopDevice } from "../../lib/relay/deviceRegistration";
import { bindRelayKeysToSettings, relayProviderTypeForPlatform } from "../../lib/relay/providers";
import type { AppSettings } from "../../lib/settings";
import { CodeFlowBackground } from "../CodeFlowBackground";
import { CheckCircle2, Eye, EyeOff, Key, Loader2, Lock, Mail, RefreshCw } from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { GroupMultiSelect } from "./GroupMultiSelect";
import { ZeroBoxLogo } from "./ZeroBoxLogo";

type RelayAccessGateProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  onReady: (user: RelayUser) => void;
};

type Mode = "login" | "register";
type Step = "checking" | "auth" | "two-factor" | "provision";

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return fallback;
}

export function RelayAccessGate({ settings, setSettings, onReady }: RelayAccessGateProps) {
  const [step, setStep] = useState<Step>("checking");
  const [mode, setMode] = useState<Mode>("login");
  const [publicSettings, setPublicSettings] = useState<RelayPublicSettings | null>(null);
  const [user, setUser] = useState<RelayUser | null>(null);
  const [groups, setGroups] = useState<RelayGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [email, setEmail] = useState("");
  const [relayOriginDraft, setRelayOriginDraft] = useState(RELAY_ORIGIN);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [invitationCode, setInvitationCode] = useState("");
  const [tempToken, setTempToken] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [codeCountdown, setCodeCountdown] = useState(0);
  const [error, setError] = useState("");

  const registrationEnabled = publicSettings?.registration_enabled !== false;
  const usableGroups = useMemo(
    () =>
      groups.filter(
        (group) => group.status === "active" && relayProviderTypeForPlatform(group.platform),
      ),
    [groups],
  );

  useEffect(() => {
    if (codeCountdown <= 0) return;
    const timer = window.setInterval(
      () => setCodeCountdown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [codeCountdown]);

  const finishAuthentication = useCallback(
    async (authenticatedUser?: RelayUser) => {
      const [currentUser, keys, availableGroups] = await Promise.all([
        authenticatedUser ? Promise.resolve(authenticatedUser) : getRelayCurrentUser(),
        listRelayApiKeys(),
        listRelayGroups(),
      ]);
      setUser(currentUser);
      setGroups(availableGroups);
      if (keys.length === 0) {
        const firstSupported = availableGroups.find(
          (group) => group.status === "active" && relayProviderTypeForPlatform(group.platform),
        );
        setSelectedGroupIds(firstSupported ? [firstSupported.id] : []);
        setStep("provision");
        return;
      }
      const nextSettings = await bindRelayKeysToSettings(settings, keys, availableGroups);
      setSettings(() => nextSettings);
      await registerDesktopDevice(nextSettings).catch((error) => {
        console.warn("automatic ZeroBox device registration failed", error);
      });
      onReady(currentUser);
    },
    [onReady, setSettings, settings],
  );

  const initialize = useCallback(async () => {
    setStep("checking");
    setError("");
    try {
      const siteSettings = await getRelayPublicSettings();
      setPublicSettings(siteSettings);
      if (!hasStoredRelaySession()) {
        setStep("auth");
        return;
      }
      await finishAuthentication();
    } catch (cause) {
      setStep("auth");
      setError(errorMessage(cause, "无法连接 USA-零，请确认服务已启动。"));
    }
  }, [finishAuthentication]);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("请输入邮箱和密码。");
      return;
    }
    if (mode === "register" && password !== confirmPassword) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (mode === "login") {
        const response = await loginRelay(email, password);
        if ("requires_2fa" in response && response.requires_2fa) {
          setTempToken(response.temp_token);
          setStep("two-factor");
          return;
        }
        if ("access_token" in response) {
          await finishAuthentication(response.user);
        }
      } else {
        const response = await registerRelay({ email, password, verifyCode, invitationCode });
        await finishAuthentication(response.user);
      }
    } catch (cause) {
      setError(errorMessage(cause, mode === "login" ? "登录失败。" : "注册失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function submitTwoFactor(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await loginRelay2FA(tempToken, totpCode);
      await finishAuthentication(response.user);
    } catch (cause) {
      setError(errorMessage(cause, "两步验证码校验失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    if (!email.trim()) {
      setError("请先输入邮箱。");
      return;
    }
    setSendingCode(true);
    setError("");
    try {
      const response = await sendRelayVerifyCode(email);
      setCodeCountdown(response.countdown || 60);
    } catch (cause) {
      setError(errorMessage(cause, "验证码发送失败。"));
    } finally {
      setSendingCode(false);
    }
  }

  async function createFirstKey() {
    if (selectedGroupIds.length === 0) {
      setError("请至少选择一个可用分组。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createRelayApiKeys("ZeroBox", selectedGroupIds, groups);
      const keys = await listRelayApiKeys();
      const nextSettings = await bindRelayKeysToSettings(settings, keys, groups, true);
      setSettings(() => nextSettings);
      await registerDesktopDevice(nextSettings).catch((error) => {
        console.warn("automatic ZeroBox device registration failed", error);
      });
      if (user) onReady(user);
    } catch (cause) {
      setError(errorMessage(cause, "创建 Key 失败。"));
    } finally {
      setBusy(false);
    }
  }

  function applyRelayOrigin() {
    try {
      const next = configureRelayOrigin(relayOriginDraft);
      setRelayOriginDraft(next);
      setError("");
      void initialize();
    } catch (cause) {
      setError(errorMessage(cause, "USA-零服务地址无效。"));
    }
  }

  if (step === "checking") {
    return (
      <div className="relative isolate flex h-full items-center justify-center overflow-hidden bg-background">
        <CodeFlowBackground />
        <div className="relative z-10 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在连接 USA-零
        </div>
      </div>
    );
  }

  return (
    <div className="relative isolate flex h-full w-full items-center justify-center overflow-y-auto bg-background px-5 py-8">
      <CodeFlowBackground />
      <div className="relative z-10 w-full max-w-[420px]">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-white">
            <ZeroBoxLogo className="h-full w-full object-contain" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-foreground">ZeroBox</h1>
            <p className="truncate text-xs text-muted-foreground">USA-零账户服务</p>
          </div>
        </div>

        <div className="mb-4 space-y-1.5">
          <Label htmlFor="relay-origin">USA-零服务地址</Label>
          <Input
            id="relay-origin"
            type="url"
            inputMode="url"
            autoComplete="url"
            value={relayOriginDraft}
            onChange={(event) => setRelayOriginDraft(event.target.value)}
            onBlur={applyRelayOrigin}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyRelayOrigin();
              }
            }}
            placeholder="https://api.example.com"
            className="font-mono text-xs"
          />
        </div>

        {step === "provision" ? (
          <div className="rounded-lg border border-border bg-card/95 p-5 shadow-sm backdrop-blur-[2px]">
            <div className="mb-5 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Key className="h-4 w-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-card-foreground">创建第一个 API Key</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  已登录{user?.email ? ` ${user.email}` : ""}。可同时选择多个分组快速创建。
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="relay-group">分组</Label>
              <GroupMultiSelect
                id="relay-group"
                groups={usableGroups}
                selectedIds={selectedGroupIds}
                onChange={setSelectedGroupIds}
              />
              {usableGroups.length === 0 && (
                <p className="text-xs text-destructive">当前账号没有可创建 Key 的模型分组。</p>
              )}
            </div>
            {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
            <Button
              className="mt-5 w-full"
              disabled={busy || selectedGroupIds.length === 0}
              onClick={createFirstKey}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              创建并开始使用
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card/95 p-5 shadow-sm backdrop-blur-[2px]">
            {step === "auth" && registrationEnabled && (
              <div className="mb-5 grid grid-cols-2 rounded-md bg-muted p-1">
                {(["login", "register"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setMode(item);
                      setError("");
                    }}
                    className={`h-8 rounded-sm text-xs font-medium transition-colors ${
                      mode === item
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground"
                    }`}
                  >
                    {item === "login" ? "登录" : "注册"}
                  </button>
                ))}
              </div>
            )}

            {step === "two-factor" ? (
              <form className="space-y-4" onSubmit={submitTwoFactor}>
                <div>
                  <h2 className="text-sm font-semibold">两步验证</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    输入身份验证器中的 6 位验证码。
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="relay-totp">验证码</Label>
                  <Input
                    id="relay-totp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={totpCode}
                    onChange={(event) => setTotpCode(event.target.value)}
                    autoFocus
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button className="w-full" disabled={busy || !totpCode.trim()} type="submit">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  验证并登录
                </Button>
              </form>
            ) : (
              <form className="space-y-4" onSubmit={submitAuth}>
                <div className="space-y-2">
                  <Label htmlFor="relay-email">邮箱</Label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="relay-email"
                      type="email"
                      autoComplete="email"
                      className="pl-9"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoFocus
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="relay-password">密码</Label>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="relay-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      className="px-9"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                    <button
                      type="button"
                      title={showPassword ? "隐藏密码" : "显示密码"}
                      className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                {mode === "register" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="relay-confirm-password">确认密码</Label>
                      <Input
                        id="relay-confirm-password"
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                      />
                    </div>
                    {publicSettings?.email_verify_enabled && (
                      <div className="space-y-2">
                        <Label htmlFor="relay-verify-code">邮箱验证码</Label>
                        <div className="flex gap-2">
                          <Input
                            id="relay-verify-code"
                            inputMode="numeric"
                            value={verifyCode}
                            onChange={(event) => setVerifyCode(event.target.value)}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            className="shrink-0"
                            disabled={sendingCode || codeCountdown > 0}
                            onClick={sendCode}
                          >
                            {sendingCode && <Loader2 className="h-4 w-4 animate-spin" />}
                            {codeCountdown > 0 ? `${codeCountdown}s` : "发送验证码"}
                          </Button>
                        </div>
                      </div>
                    )}
                    {publicSettings?.invitation_code_enabled && (
                      <div className="space-y-2">
                        <Label htmlFor="relay-invitation">邀请码</Label>
                        <Input
                          id="relay-invitation"
                          value={invitationCode}
                          onChange={(event) => setInvitationCode(event.target.value)}
                        />
                      </div>
                    )}
                  </>
                )}
                {error && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
                    {error}
                  </div>
                )}
                <Button className="w-full" disabled={busy} type="submit">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {mode === "login" ? "登录" : "创建账号"}
                </Button>
                {error && (
                  <Button type="button" variant="ghost" className="w-full" onClick={initialize}>
                    <RefreshCw className="h-4 w-4" />
                    重新连接
                  </Button>
                )}
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
