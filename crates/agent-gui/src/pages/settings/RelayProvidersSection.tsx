import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Info,
  Key,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
} from "../../components/icons";
import { GroupMultiSelect } from "../../components/relay/GroupMultiSelect";
import { RelayKeyCopyDialog } from "../../components/relay/RelayKeyCopyDialog";
import { ZeroAgentLogo } from "../../components/relay/ZeroAgentLogo";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  createRelayApiKeys,
  getRelayCurrentUser,
  listRelayApiKeys,
  listRelayGroups,
  logoutRelay,
  RELAY_ORIGIN,
  type RelayApiKey,
  type RelayGroup,
  type RelayUser,
  verifyRelayPassword,
} from "../../lib/relay/client";
import { bindRelayKeysToSettings, relayProviderTypeForPlatform } from "../../lib/relay/providers";
import type { SettingsSectionProps } from "./types";

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return fallback;
}

function maskKey(value: string) {
  const key = value.trim();
  if (key.length <= 12) return `${key.slice(0, 3)}••••••`;
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}

function platformLabel(platform: string) {
  switch (relayProviderTypeForPlatform(platform)) {
    case "claude_code":
      return "Claude";
    case "codex":
      return "OpenAI / Codex";
    case "gemini":
      return "Gemini";
    default:
      return platform;
  }
}

export function RelayProvidersSection({ settings, setSettings }: SettingsSectionProps) {
  const [user, setUser] = useState<RelayUser | null>(null);
  const [keys, setKeys] = useState<RelayApiKey[]>([]);
  const [groups, setGroups] = useState<RelayGroup[]>([]);
  const [keyName, setKeyName] = useState("ZeroAgent");
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  const [copyTarget, setCopyTarget] = useState<RelayApiKey | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const usableGroups = useMemo(
    () =>
      groups.filter(
        (group) => group.status === "active" && relayProviderTypeForPlatform(group.platform),
      ),
    [groups],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [currentUser, currentKeys, availableGroups] = await Promise.all([
        getRelayCurrentUser(),
        listRelayApiKeys(),
        listRelayGroups(),
      ]);
      setUser(currentUser);
      setKeys(currentKeys);
      setGroups(availableGroups);
      setSelectedGroupIds((current) => {
        if (current.length > 0) return current;
        const firstSupported = availableGroups.find(
          (group) => group.status === "active" && relayProviderTypeForPlatform(group.platform),
        );
        return firstSupported ? [firstSupported.id] : [];
      });
    } catch (cause) {
      setError(errorMessage(cause, "加载 USA-零 账户失败。"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function syncProviders(forceModelRefresh: boolean, nextKeys = keys) {
    setSyncing(true);
    setError("");
    setSuccess("");
    try {
      const nextSettings = await bindRelayKeysToSettings(
        settings,
        nextKeys,
        groups,
        forceModelRefresh,
      );
      setSettings(() => nextSettings);
      setSuccess(forceModelRefresh ? "模型列表已从 USA-零 更新。" : "密钥配置已同步。");
    } catch (cause) {
      setError(errorMessage(cause, "同步 Key 配置失败。"));
    } finally {
      setSyncing(false);
    }
  }

  async function createKey() {
    if (!keyName.trim()) {
      setError("请输入密钥名称。");
      return;
    }
    if (selectedGroupIds.length === 0) {
      setError("请至少选择一个可用分组。");
      return;
    }
    setCreating(true);
    setError("");
    setSuccess("");
    try {
      await createRelayApiKeys(keyName, selectedGroupIds, groups);
      const currentKeys = await listRelayApiKeys();
      setKeys(currentKeys);
      await syncProviders(true, currentKeys);
      setSuccess(`已创建 ${selectedGroupIds.length} 个密钥并绑定到 ZeroAgent。`);
    } catch (cause) {
      setError(errorMessage(cause, "创建 Key 失败。"));
    } finally {
      setCreating(false);
    }
  }

  function groupForKey(key: RelayApiKey) {
    return key.group ?? groups.find((group) => group.id === key.group_id);
  }

  async function copyKeyAfterPassword(password: string) {
    if (!copyTarget || !user?.email) throw new Error("无法读取当前 USA-零 账户。");
    await verifyRelayPassword(user.email, password);
    await navigator.clipboard.writeText(copyTarget.key);
    setSuccess(`密钥“${copyTarget.name}”已复制到剪贴板。`);
  }

  return (
    <div className="min-h-0 w-full min-w-0 flex-1 space-y-6 overflow-y-auto pr-1">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-white">
            <ZeroAgentLogo className="h-full w-full object-contain" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">USA-零</h3>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              USA-零专属终端
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || syncing || creating}
            onClick={() => void syncProviders(true)}
          >
            {syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            从 USA-零 更新
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void logoutRelay()}>
            <LogOut className="h-3.5 w-3.5" />
            注销登录
          </Button>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">账户信息</h4>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-border/60 bg-card px-4 py-3">
            <p className="text-[11px] font-medium text-muted-foreground">邮箱</p>
            <p className="mt-1 truncate text-sm font-medium text-foreground">
              {loading ? "正在加载..." : user?.email || "-"}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-card px-4 py-3">
            <p className="text-[11px] font-medium text-muted-foreground">用户名 / ID</p>
            <p className="mt-1 truncate text-sm font-medium text-foreground">
              {user?.username || "未设置"}{" "}
              <span className="text-muted-foreground">#{user?.id ?? "-"}</span>
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-card px-4 py-3">
            <p className="text-[11px] font-medium text-muted-foreground">余额</p>
            <p className="mt-1 truncate text-sm font-medium tabular-nums text-foreground">
              ${Number(user?.balance ?? 0).toFixed(2)}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-card px-4 py-3">
            <p className="text-[11px] font-medium text-muted-foreground">固定服务地址</p>
            <p className="mt-1 truncate font-mono text-sm text-foreground">{RELAY_ORIGIN}</p>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold">密钥</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              密钥默认隐藏，复制前必须再次验证 USA-零 账户密码。
            </p>
          </div>
          <span className="rounded-md bg-muted px-2 py-1 text-xs tabular-nums text-muted-foreground">
            {keys.length}
          </span>
        </div>
        {loading ? (
          <div className="flex h-24 items-center justify-center rounded-lg border border-border/60">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : keys.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            当前账户还没有密钥
          </div>
        ) : (
          <div className="max-h-[min(22rem,34vh)] space-y-2 overflow-y-auto overscroll-contain rounded-xl border border-border/60 bg-muted/10 p-2 [scrollbar-gutter:stable]">
            {keys.map((key) => {
              const group = groupForKey(key);
              const active = key.status === "active";
              return (
                <div
                  key={key.id}
                  className="flex items-center gap-3 rounded-lg border border-border/60 bg-card px-4 py-3"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Key className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-medium">{key.name}</p>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                          active
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {active ? "可用" : key.status}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {maskKey(key.key)}
                    </p>
                  </div>
                  <div className="hidden shrink-0 text-right sm:block">
                    <p className="text-xs font-medium">{group?.name ?? "未分组"}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {group ? platformLabel(group.platform) : "不可绑定"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    title="验证密码后复制密钥"
                    onClick={() => setCopyTarget(key)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Plus className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold">创建密钥</h4>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              每个选中的分组会创建一条独立密钥，可用于对应的模型服务。
            </p>
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="space-y-2">
            <Label htmlFor="relay-key-name">密钥名称</Label>
            <Input
              id="relay-key-name"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              maxLength={80}
              placeholder="例如：ZeroAgent 客户端"
            />
            <p className="text-[11px] text-muted-foreground">用于在密钥列表中识别用途。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="relay-key-group">模型分组</Label>
            <GroupMultiSelect
              id="relay-key-group"
              groups={usableGroups}
              selectedIds={selectedGroupIds}
              onChange={setSelectedGroupIds}
              disabled={creating || syncing}
            />
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {selectedGroupIds.length > 0
              ? `将创建 ${selectedGroupIds.length} 条密钥`
              : "请选择至少一个模型分组"}
          </p>
          <Button
            type="button"
            className="w-full sm:w-auto"
            disabled={creating || syncing || selectedGroupIds.length === 0}
            onClick={() => void createKey()}
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {creating ? "创建中..." : "创建密钥"}
          </Button>
        </div>
      </section>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {success}
        </div>
      )}
      <RelayKeyCopyDialog
        key={copyTarget?.id ?? "closed"}
        keyName={copyTarget?.name ?? null}
        onClose={() => setCopyTarget(null)}
        onConfirm={copyKeyAfterPassword}
      />
    </div>
  );
}
