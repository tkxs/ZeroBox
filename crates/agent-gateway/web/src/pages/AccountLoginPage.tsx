import { type FormEvent, useEffect, useState } from "react";
import { CodeFlowBackground } from "../components/CodeFlowBackground";
import { ArrowRight, Eye, EyeOff, Loader2, Lock, User } from "../components/icons";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  getRelayPublicSettings,
  type RelayPublicSettings,
  sendRelayVerifyCode,
} from "../lib/relay/client";

type Props = {
  error: string | null;
  isSubmitting: boolean;
  twoFactorRequired: boolean;
  onSubmit: (email: string, password: string) => void;
  onRegister: (input: {
    email: string;
    password: string;
    verifyCode?: string;
    invitationCode?: string;
  }) => void;
  onSubmitTwoFactor: (code: string) => void;
  onClearError: () => void;
  onSetError: (message: string | null) => void;
};

type Mode = "login" | "register";

export function AccountLoginPage({
  error,
  isSubmitting,
  twoFactorRequired,
  onSubmit,
  onRegister,
  onSubmitTwoFactor,
  onClearError,
  onSetError,
}: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [invitationCode, setInvitationCode] = useState("");
  const [codeCountdown, setCodeCountdown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [publicSettings, setPublicSettings] = useState<RelayPublicSettings | null>(null);
  const [codeError, setCodeError] = useState("");
  const [codeMessage, setCodeMessage] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getRelayPublicSettings()
      .then((settings) => {
        if (!cancelled) setPublicSettings(settings);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (codeCountdown <= 0) return;
    const timer = window.setInterval(
      () => setCodeCountdown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [codeCountdown]);

  const registrationEnabled = publicSettings?.registration_enabled !== false;

  function submit(event: FormEvent) {
    event.preventDefault();
    onClearError();
    setCodeError("");
    if (twoFactorRequired) return onSubmitTwoFactor(verifyCode.trim());
    if (mode === "register") {
      if (password !== confirmPassword) {
        onSetError("两次输入的密码不一致");
        return;
      }
      onRegister({ email: email.trim(), password, verifyCode, invitationCode });
      return;
    }
    onSubmit(email.trim(), password);
  }

  async function sendCode() {
    if (!email.trim()) {
      onSetError("请先输入邮箱");
      return;
    }
    setSendingCode(true);
    setCodeError("");
    setCodeMessage("");
    try {
      const response = await sendRelayVerifyCode(email);
      setCodeCountdown(response.countdown || 60);
      setCodeMessage(response.message || "验证码已发送");
    } catch (cause) {
      setCodeError(cause instanceof Error ? cause.message : "验证码发送失败");
    } finally {
      setSendingCode(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    onClearError();
    setCodeError("");
    setCodeMessage("");
  }

  return (
    <main className="account-login-shell relative isolate flex min-h-dvh w-full items-center justify-center overflow-y-auto bg-background px-4 py-8 sm:px-6">
      <CodeFlowBackground />
      <form
        className="relative z-10 min-w-0 w-full max-w-[calc(100vw-2rem)] rounded-2xl border border-border/70 bg-card/95 p-6 shadow-lg shadow-black/[0.04] backdrop-blur-[2px] sm:max-w-[420px] sm:p-8 dark:shadow-black/20"
        onSubmit={submit}
      >
        <div className="mb-6 flex items-center gap-3">
          <img
            className="h-11 w-11 shrink-0 rounded-xl border border-border/60 bg-white object-contain p-1"
            src="/zeroagent-logo.png"
            alt="ZeroAgent"
          />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">ZeroAgent</h1>
            <p className="text-xs text-muted-foreground">登录 USA-零账户</p>
          </div>
        </div>
        {!twoFactorRequired && registrationEnabled && (
          <div className="mb-5 grid grid-cols-2 rounded-md bg-muted p-1">
            <button
              type="button"
              className={`h-8 rounded-sm text-xs font-medium ${mode === "login" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
              onClick={() => switchMode("login")}
            >
              登录
            </button>
            <button
              type="button"
              className={`h-8 rounded-sm text-xs font-medium ${mode === "register" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
              onClick={() => switchMode("register")}
            >
              注册
            </button>
          </div>
        )}
        {twoFactorRequired ? (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="totp-code">
              两步验证码
            </label>
            <Input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={verifyCode}
              onChange={(event) => setVerifyCode(event.target.value)}
              autoFocus
            />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="account-email">
                邮箱
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="account-email"
                  type="email"
                  autoComplete="email"
                  className="pl-9"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    onClearError();
                  }}
                  autoFocus
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="account-password">
                密码
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="account-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  className="px-9"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    onClearError();
                  }}
                />
                <button
                  type="button"
                  title={showPassword ? "隐藏密码" : "显示密码"}
                  className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-muted-foreground"
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            {mode === "register" && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="account-confirm-password">
                    确认密码
                  </label>
                  <Input
                    id="account-confirm-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </div>
                {publicSettings?.email_verify_enabled && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="account-verify-code">
                      邮箱验证码
                    </label>
                    <div className="flex gap-2">
                      <Input
                        id="account-verify-code"
                        inputMode="numeric"
                        value={verifyCode}
                        onChange={(event) => setVerifyCode(event.target.value)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0"
                        disabled={sendingCode || codeCountdown > 0}
                        onClick={() => void sendCode()}
                      >
                        {codeCountdown > 0 ? `${codeCountdown}s` : "发送验证码"}
                      </Button>
                    </div>
                    {codeMessage && <p className="text-xs text-muted-foreground">{codeMessage}</p>}
                    {codeError && <p className="text-xs text-destructive">{codeError}</p>}
                  </div>
                )}
                {publicSettings?.invitation_code_enabled && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="account-invitation-code">
                      邀请码
                    </label>
                    <Input
                      id="account-invitation-code"
                      value={invitationCode}
                      onChange={(event) => setInvitationCode(event.target.value)}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {error && (
          <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          className="mt-7 w-full"
          size="lg"
          disabled={
            isSubmitting || (twoFactorRequired ? !verifyCode.trim() : !email.trim() || !password)
          }
        >
          {isSubmitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowRight className="h-4 w-4" />
          )}
          {twoFactorRequired ? "验证并登录" : mode === "register" ? "创建账户" : "登录"}
        </Button>
      </form>
    </main>
  );
}
