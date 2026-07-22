import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { Loader2, Lock, RefreshCw, Shield, Upload, Wallet } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  bindRelayEmail,
  changeRelayPassword,
  formatRelayBalance,
  getRelayDashboardStats,
  getRelayProfile,
  logoutRelay,
  type RelayDashboardStats,
  type RelayUser,
  sendRelayEmailBindingCode,
  updateRelayProfile,
} from "../../lib/relay/client";
import type { AppSettings } from "../../lib/settings";
import { DevicesSection } from "./DevicesSection";

type AccountSectionProps = {
  settings: AppSettings;
  user: RelayUser;
  stats: RelayDashboardStats | null;
  onUserChange: (user: RelayUser) => void;
  onStatsChange: (stats: RelayDashboardStats) => void;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function formatNumber(value?: number) {
  return Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(Number(value)) : "--";
}

function formatDate(value?: string) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "--"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function readAvatar(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("请选择图片文件。"));
      return;
    }
    if (file.size > 100 * 1024) {
      reject(new Error("头像文件不能超过 100 KB，请压缩后重试。"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取头像失败。"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

export function AccountSection({
  settings,
  user,
  stats,
  onUserChange,
  onStatsChange,
}: AccountSectionProps) {
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState(user.username ?? "");
  const [email, setEmail] = useState(user.email);
  const [verifyCode, setVerifyCode] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setUsername(user.username ?? "");
    setEmail(user.email);
  }, [user.email, user.username]);

  async function refreshAccount() {
    setBusy("refresh");
    setNotice(null);
    try {
      const [profile, dashboard] = await Promise.all([getRelayProfile(), getRelayDashboardStats()]);
      onUserChange(profile);
      onStatsChange(dashboard);
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, "刷新账户信息失败。") });
    } finally {
      setBusy("");
    }
  }

  async function saveUsername(event: FormEvent) {
    event.preventDefault();
    if (!username.trim()) return setNotice({ kind: "error", text: "用户名不能为空。" });
    setBusy("username");
    setNotice(null);
    try {
      onUserChange(await updateRelayProfile({ username: username.trim() }));
      setNotice({ kind: "success", text: "用户名已更新。" });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, "更新用户名失败。") });
    } finally {
      setBusy("");
    }
  }

  async function changeAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy("avatar");
    setNotice(null);
    try {
      const avatarUrl = await readAvatar(file);
      onUserChange(await updateRelayProfile({ avatar_url: avatarUrl }));
      setNotice({ kind: "success", text: "头像已更新。" });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, "更新头像失败。") });
    } finally {
      setBusy("");
    }
  }

  async function sendCode() {
    if (!email.trim()) return setNotice({ kind: "error", text: "请输入新邮箱。" });
    setBusy("code");
    setNotice(null);
    try {
      await sendRelayEmailBindingCode(email);
      setNotice({ kind: "success", text: "验证码已发送，请检查新邮箱。" });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, "发送验证码失败。") });
    } finally {
      setBusy("");
    }
  }

  async function saveEmail(event: FormEvent) {
    event.preventDefault();
    if (!verifyCode.trim() || !emailPassword) {
      return setNotice({ kind: "error", text: "请输入验证码和密码。" });
    }
    if (user.email_bound === false && emailPassword.length < 6) {
      return setNotice({ kind: "error", text: "登录密码至少 6 位。" });
    }
    setBusy("email");
    setNotice(null);
    try {
      onUserChange(await bindRelayEmail(email, verifyCode, emailPassword));
      setVerifyCode("");
      setEmailPassword("");
      setNotice({ kind: "success", text: "绑定邮箱已更新。" });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, "更新邮箱失败。") });
    } finally {
      setBusy("");
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword.length < 6) return setNotice({ kind: "error", text: "新密码至少 6 位。" });
    if (newPassword !== confirmPassword) {
      return setNotice({ kind: "error", text: "两次输入的新密码不一致。" });
    }
    setBusy("password");
    setNotice(null);
    try {
      await changeRelayPassword(oldPassword, newPassword);
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice({ kind: "success", text: "密码已更新，请重新登录。" });
      await logoutRelay();
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, "修改密码失败。") });
    } finally {
      setBusy("");
    }
  }

  const displayName = user.username?.trim() || user.email.split("@")[0] || "用户";

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 pb-8">
      <section>
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 pb-5">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-foreground text-xl font-semibold text-background">
              {user.avatar_url ? (
                <img src={user.avatar_url} alt="账户头像" className="h-full w-full object-cover" />
              ) : (
                displayName.slice(0, 1).toUpperCase()
              )}
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{displayName}</h2>
              <p className="truncate text-sm text-muted-foreground">{user.email}</p>
              <button
                type="button"
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline disabled:opacity-50"
                disabled={Boolean(busy)}
                onClick={() => avatarInputRef.current?.click()}
              >
                {busy === "avatar" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                修改头像
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={changeAvatar}
              />
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={Boolean(busy)}
            onClick={refreshAccount}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy === "refresh" ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-5 py-5 sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted-foreground">余额</div>
            <div className="mt-1 font-semibold">{formatRelayBalance(user.balance)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">今日 Token</div>
            <div className="mt-1 font-semibold">{formatNumber(stats?.today_tokens)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">并发限制</div>
            <div className="mt-1 font-semibold">
              {user.concurrency ? `${user.concurrency} 路` : "不限制"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">注册时间</div>
            <div className="mt-1 text-sm font-medium">{formatDate(user.created_at)}</div>
          </div>
        </div>
      </section>

      {notice ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${notice.kind === "error" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"}`}
        >
          {notice.text}
        </div>
      ) : null}

      <section className="space-y-4 border-t border-border/70 pt-6">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold">基本资料</h3>
        </div>
        <form
          onSubmit={saveUsername}
          className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end"
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="account-username">用户名</Label>
            <Input
              id="account-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={64}
            />
          </div>
          <Button type="submit" disabled={Boolean(busy)}>
            {busy === "username" && <Loader2 className="h-4 w-4 animate-spin" />}保存用户名
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          头像支持常见图片格式，文件大小不超过 100 KB。
        </p>
      </section>

      <section className="space-y-4 border-t border-border/70 pt-6">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold">绑定邮箱</h3>
        </div>
        <form onSubmit={saveEmail} className="grid max-w-xl gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="account-email">新邮箱</Label>
            <div className="flex gap-2">
              <Input
                id="account-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={sendCode}>
                {busy === "code" ? "发送中" : "发送验证码"}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="account-code">邮箱验证码</Label>
            <Input
              id="account-code"
              inputMode="numeric"
              value={verifyCode}
              onChange={(event) => setVerifyCode(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="account-email-password">
              {user.email_bound === false ? "设置登录密码" : "当前密码"}
            </Label>
            <Input
              id="account-email-password"
              type="password"
              value={emailPassword}
              onChange={(event) => setEmailPassword(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={Boolean(busy)} className="sm:col-span-2 sm:w-fit">
            {busy === "email" && <Loader2 className="h-4 w-4 animate-spin" />}更新邮箱
          </Button>
        </form>
      </section>

      <DevicesSection settings={settings} />

      <section className="space-y-4 border-t border-border/70 pt-6">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold">修改密码</h3>
        </div>
        <form onSubmit={savePassword} className="grid max-w-xl gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="account-old-password">当前密码</Label>
            <Input
              id="account-old-password"
              type="password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="account-new-password">新密码</Label>
            <Input
              id="account-new-password"
              type="password"
              minLength={6}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="account-confirm-password">确认新密码</Label>
            <Input
              id="account-confirm-password"
              type="password"
              minLength={6}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={Boolean(busy)} className="sm:col-span-2 sm:w-fit">
            {busy === "password" && <Loader2 className="h-4 w-4 animate-spin" />}修改密码
          </Button>
        </form>
      </section>
    </div>
  );
}
