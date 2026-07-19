import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Eye, EyeOff, Key, Loader2, Lock, RefreshCw, User } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
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
} from "@/lib/relay/client";
import { bindRelayKeysToSettings, relayProviderTypeForPlatform } from "@/lib/relay/providers";
import type { AppSettings } from "@/lib/settings";
import { GroupMultiSelect } from "./GroupMultiSelect";
import { ZeroBoxLogo } from "./ZeroBoxLogo";

type Props = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  onReady: (user: RelayUser) => void;
};
type Mode = "login" | "register";
type Step = "checking" | "auth" | "two-factor" | "provision";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}

export function RelayAccessGate({ settings, setSettings, onReady }: Props) {
  const [step, setStep] = useState<Step>("checking");
  const [mode, setMode] = useState<Mode>("login");
  const [publicSettings, setPublicSettings] = useState<RelayPublicSettings | null>(null);
  const [user, setUser] = useState<RelayUser | null>(null);
  const [groups, setGroups] = useState<RelayGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [email, setEmail] = useState("");
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
        const first = availableGroups.find(
          (group) => group.status === "active" && relayProviderTypeForPlatform(group.platform),
        );
        setSelectedGroupIds(first ? [first.id] : []);
        setStep("provision");
        return;
      }
      const nextSettings = await bindRelayKeysToSettings(settings, keys, availableGroups);
      setSettings(() => nextSettings);
      onReady(currentUser);
    },
    [onReady, setSettings, settings],
  );

  const initialize = useCallback(async () => {
    setStep("checking");
    setError("");
    try {
      setPublicSettings(await getRelayPublicSettings());
      if (!hasStoredRelaySession()) return setStep("auth");
      await finishAuthentication();
    } catch (cause) {
      setStep("auth");
      setError(errorMessage(cause, "无法连接 USA-零，请确认服务已启动。"));
    }
  }, [finishAuthentication]);

  useEffect(() => void initialize(), [initialize]);

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) return setError("请输入邮箱和密码。");
    if (mode === "register" && password !== confirmPassword) {
      return setError("两次输入的密码不一致。");
    }
    setBusy(true);
    setError("");
    try {
      if (mode === "login") {
        const response = await loginRelay(email, password);
        if ("requires_2fa" in response && response.requires_2fa) {
          setTempToken(response.temp_token);
          setStep("two-factor");
        } else if ("access_token" in response) {
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
    if (!email.trim()) return setError("请先输入邮箱。");
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
    if (selectedGroupIds.length === 0) return setError("请至少选择一个可用分组。");
    setBusy(true);
    setError("");
    try {
      await createRelayApiKeys("ZeroBox", selectedGroupIds, groups);
      const keys = await listRelayApiKeys();
      const next = await bindRelayKeysToSettings(settings, keys, groups, true);
      setSettings(() => next);
      if (user) onReady(user);
    } catch (cause) {
      setError(errorMessage(cause, "创建 Key 失败。"));
    } finally {
      setBusy(false);
    }
  }

  if (step === "checking") {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在连接 USA-零
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-background px-5 py-8">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex items-center gap-3">
          <div className="h-11 w-11 overflow-hidden rounded-md border bg-white">
            <ZeroBoxLogo className="h-full w-full object-contain" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">ZeroBox</h1>
            <p className="text-xs text-muted-foreground">USA-零 {RELAY_ORIGIN}</p>
          </div>
        </div>
        {step === "provision" ? (
          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="mb-5 flex gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Key className="h-4 w-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">创建第一个 API Key</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  已登录{user?.email ? ` ${user.email}` : ""}，请选择一个或多个分组。
                </p>
              </div>
            </div>
            <Label htmlFor="relay-group">分组</Label>
            <div className="mt-2">
              <GroupMultiSelect
                id="relay-group"
                groups={usableGroups}
                selectedIds={selectedGroupIds}
                onChange={setSelectedGroupIds}
              />
            </div>
            {usableGroups.length === 0 && (
              <p className="mt-2 text-xs text-destructive">当前账号没有可用分组。</p>
            )}
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
          <div className="rounded-lg border bg-card p-5 shadow-sm">
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
                    className={`h-8 rounded-sm text-xs font-medium ${mode === item ? "bg-background shadow-sm" : "text-muted-foreground"}`}
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
                <Button className="w-full" disabled={busy || !totpCode.trim()}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}验证并登录
                </Button>
              </form>
            ) : (
              <form className="space-y-4" onSubmit={submitAuth}>
                <div className="space-y-2">
                  <Label htmlFor="relay-email">邮箱</Label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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
                      className="absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground"
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                {mode === "register" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="relay-confirm">确认密码</Label>
                      <Input
                        id="relay-confirm"
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                      />
                    </div>
                    {publicSettings?.email_verify_enabled && (
                      <div className="space-y-2">
                        <Label htmlFor="relay-code">邮箱验证码</Label>
                        <div className="flex gap-2">
                          <Input
                            id="relay-code"
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
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {error}
                  </div>
                )}
                <Button className="w-full" disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {mode === "login" ? "登录" : "创建账户"}
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
