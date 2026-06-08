import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";
import {
  Check,
  Clock3,
  Copy,
  Edit3,
  ExternalLink,
  Folder,
  Globe,
  Link2,
  Loader2,
  Save,
  Trash2,
  X,
} from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export type TunnelTtlSeconds = 0 | 900 | 3600 | 14400;

export type TunnelCreateInput = {
  targetUrl: string;
  name?: string;
  ttlSeconds: TunnelTtlSeconds;
  projectPathKey?: string;
};

export type TunnelUpdateInput = {
  id: string;
  targetUrl: string;
  name?: string;
  ttlSeconds: TunnelTtlSeconds;
  projectPathKey?: string;
};

export type TunnelSummary = {
  id: string;
  slug: string;
  name: string;
  targetUrl: string;
  publicUrl: string;
  createdAt: number;
  expiresAt: number;
  status: "active" | "expired" | "offline";
  projectPathKey?: string;
};

export type LocalTunnelClient = {
  listTunnels(): Promise<TunnelSummary[]>;
  createTunnel(input: TunnelCreateInput): Promise<TunnelSummary>;
  updateTunnel(input: TunnelUpdateInput): Promise<TunnelSummary>;
  closeTunnel(id: string): Promise<TunnelSummary>;
};

type LocalTunnelPanelProps = {
  client: LocalTunnelClient;
  enabled?: boolean;
  disabledMessage?: string;
  projectPathKey?: string;
  refreshToken?: number;
};

type TunnelScope = "project" | "global";

const TUNNEL_MANAGER_CHANGED_EVENT = "liveagent:tunnel-manager-changed";

const TUNNEL_SCOPE_OPTIONS: Array<{
  scope: TunnelScope;
  labelKey: string;
  titleKey: string;
}> = [
  {
    scope: "project",
    labelKey: "projectTools.tunnelScopeProject",
    titleKey: "projectTools.tunnelScopeProjectTitle",
  },
  {
    scope: "global",
    labelKey: "projectTools.tunnelScopeGlobal",
    titleKey: "projectTools.tunnelScopeGlobalTitle",
  },
];

const TTL_OPTIONS: Array<{ value: TunnelTtlSeconds; labelKey: string }> = [
  { value: 900, labelKey: "projectTools.tunnelTtl15m" },
  { value: 3600, labelKey: "projectTools.tunnelTtl1h" },
  { value: 14400, labelKey: "projectTools.tunnelTtl4h" },
  { value: 0, labelKey: "projectTools.tunnelTtlInfinite" },
];

function validateLocalHttpTarget(input: string) {
  const value = input.trim();
  if (!value) return "projectTools.tunnelTargetRequired";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") {
      return "projectTools.tunnelInvalidUrl";
    }
    const hostname = url.hostname.toLowerCase();
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
      return "projectTools.tunnelLocalhostOnly";
    }
    if (url.username || url.password || url.hash) {
      return "projectTools.tunnelInvalidUrl";
    }
  } catch {
    return "projectTools.tunnelInvalidUrl";
  }
  return null;
}

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatRemaining(seconds: number) {
  if (seconds <= 0) return "0m";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (hours <= 0) return `${minutes}m`;
  if (minutes >= 60) return `${hours + 1}h`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatDateTime(seconds: number) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString();
}

function writeTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackWriteTextToClipboard(text),
    );
  }
  return Promise.resolve(fallbackWriteTextToClipboard(text));
}

function fallbackWriteTextToClipboard(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function displayTunnelName(tunnel: TunnelSummary) {
  return tunnel.name.trim() || tunnel.targetUrl;
}

function tunnelStatusKey(status: TunnelSummary["status"]) {
  if (status === "expired") return "projectTools.tunnelStatusExpired";
  if (status === "offline") return "projectTools.tunnelStatusOffline";
  return "projectTools.tunnelStatusActive";
}

function normalizeProjectPathKey(value: string | undefined) {
  return value?.trim() ?? "";
}

function ttlFromTunnel(tunnel: TunnelSummary, nowSeconds: number): TunnelTtlSeconds {
  if (!tunnel.expiresAt) return 0;
  const remaining = Math.max(0, tunnel.expiresAt - nowSeconds);
  if (remaining <= 900) return 900;
  if (remaining <= 3600) return 3600;
  return 14400;
}

export function LocalTunnelPanel({
  client,
  enabled = true,
  disabledMessage,
  projectPathKey,
  refreshToken,
}: LocalTunnelPanelProps) {
  const { t } = useLocale();
  const normalizedProjectPathKey = useMemo(
    () => normalizeProjectPathKey(projectPathKey),
    [projectPathKey],
  );
  const [scope, setScope] = useState<TunnelScope>(() =>
    normalizeProjectPathKey(projectPathKey) ? "project" : "global",
  );
  const [targetUrl, setTargetUrl] = useState("http://localhost:3000");
  const [name, setName] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState<TunnelTtlSeconds>(3600);
  const [editingId, setEditingId] = useState("");
  const [editTargetUrl, setEditTargetUrl] = useState("");
  const [editName, setEditName] = useState("");
  const [editTtlSeconds, setEditTtlSeconds] = useState<TunnelTtlSeconds>(3600);
  const [tunnels, setTunnels] = useState<TunnelSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [closingId, setClosingId] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const refreshTokenRef = useRef(refreshToken);
  const targetValidationKey = useMemo(() => validateLocalHttpTarget(targetUrl), [targetUrl]);
  const editTargetValidationKey = useMemo(
    () => (editingId ? validateLocalHttpTarget(editTargetUrl) : null),
    [editTargetUrl, editingId],
  );

  const refresh = useCallback(
    (options?: { showLoading?: boolean }) => {
      const showLoading = options?.showLoading ?? true;
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      return client
        .listTunnels()
        .then((items) => setTunnels(items))
        .catch((err) => setError(asErrorMessage(err)))
        .finally(() => {
          if (showLoading) {
            setLoading(false);
          }
        });
    },
    [client],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (refreshTokenRef.current === refreshToken) return;
    refreshTokenRef.current = refreshToken;
    void refresh({ showLoading: false });
  }, [refresh, refreshToken]);

  useEffect(() => {
    const handleTunnelManagerChanged = () => {
      void refresh({ showLoading: false });
    };
    window.addEventListener(TUNNEL_MANAGER_CHANGED_EVENT, handleTunnelManagerChanged);
    return () =>
      window.removeEventListener(TUNNEL_MANAGER_CHANGED_EVENT, handleTunnelManagerChanged);
  }, [refresh]);

  useEffect(() => {
    if (!normalizedProjectPathKey && scope === "project") {
      setScope("global");
      setError(null);
    }
  }, [normalizedProjectPathKey, scope]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!copiedId) return;
    const timer = window.setTimeout(() => setCopiedId(""), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

  const createTunnel = useCallback(() => {
    const validationKey = validateLocalHttpTarget(targetUrl);
    if (validationKey) {
      setError(t(validationKey));
      return;
    }
    if (!enabled || creating) return;
    const input: TunnelCreateInput = {
      targetUrl: targetUrl.trim(),
      name: name.trim() || undefined,
      ttlSeconds,
    };
    if (scope === "project" && normalizedProjectPathKey) {
      input.projectPathKey = normalizedProjectPathKey;
    }
    setCreating(true);
    setError(null);
    void client
      .createTunnel(input)
      .then((created) => {
        setTunnels((current) => [
          created,
          ...current.filter((item) => item.id !== created.id && item.slug !== created.slug),
        ]);
        setName("");
        void refresh({ showLoading: false });
      })
      .catch((err) => setError(asErrorMessage(err)))
      .finally(() => setCreating(false));
  }, [
    client,
    creating,
    enabled,
    name,
    normalizedProjectPathKey,
    refresh,
    scope,
    t,
    targetUrl,
    ttlSeconds,
  ]);

  const beginEdit = useCallback(
    (tunnel: TunnelSummary) => {
      setEditingId(tunnel.id);
      setEditTargetUrl(tunnel.targetUrl);
      setEditName(tunnel.name);
      setEditTtlSeconds(ttlFromTunnel(tunnel, nowSeconds));
      setError(null);
    },
    [nowSeconds],
  );

  const cancelEdit = useCallback(() => {
    setEditingId("");
    setEditTargetUrl("");
    setEditName("");
    setEditTtlSeconds(3600);
    setError(null);
  }, []);

  const updateTunnel = useCallback(
    (tunnel: TunnelSummary) => {
      const validationKey = validateLocalHttpTarget(editTargetUrl);
      if (validationKey) {
        setError(t(validationKey));
        return;
      }
      if (!enabled || savingId) return;
      const input: TunnelUpdateInput = {
        id: tunnel.id,
        targetUrl: editTargetUrl.trim(),
        name: editName.trim() || undefined,
        ttlSeconds: editTtlSeconds,
      };
      const tunnelProjectPathKey = normalizeProjectPathKey(tunnel.projectPathKey);
      if (tunnelProjectPathKey) {
        input.projectPathKey = tunnelProjectPathKey;
      }
      setSavingId(tunnel.id);
      setError(null);
      void client
        .updateTunnel(input)
        .then((updated) => {
          setTunnels((current) => current.map((item) => (item.id === updated.id ? updated : item)));
          cancelEdit();
        })
        .catch((err) => setError(asErrorMessage(err)))
        .finally(() => setSavingId((current) => (current === tunnel.id ? "" : current)));
    },
    [cancelEdit, client, editName, editTargetUrl, editTtlSeconds, enabled, savingId, t],
  );

  const closeTunnel = useCallback(
    (id: string) => {
      if (!enabled || closingId) return;
      setClosingId(id);
      setError(null);
      void client
        .closeTunnel(id)
        .then((closed) => {
          setTunnels((current) =>
            current
              .filter((item) => item.id !== id)
              .concat(closed.status === "active" ? [closed] : []),
          );
        })
        .catch((err) => setError(asErrorMessage(err)))
        .finally(() => setClosingId((current) => (current === id ? "" : current)));
    },
    [client, closingId, enabled],
  );

  const copyLink = useCallback((tunnel: TunnelSummary) => {
    if (!tunnel.publicUrl) return;
    void writeTextToClipboard(tunnel.publicUrl)
      .then((copied) => {
        if (copied) {
          setCopiedId(tunnel.id);
        }
      })
      .catch(() => {});
  }, []);

  const openLink = useCallback((tunnel: TunnelSummary) => {
    if (!tunnel.publicUrl) return;
    setError(null);
    void openUrl(tunnel.publicUrl).catch((err) => setError(asErrorMessage(err)));
  }, []);

  const scopedTunnels = useMemo(
    () =>
      tunnels.filter((tunnel) => {
        const tunnelProjectPathKey = normalizeProjectPathKey(tunnel.projectPathKey);
        if (scope === "project") {
          return (
            Boolean(normalizedProjectPathKey) && tunnelProjectPathKey === normalizedProjectPathKey
          );
        }
        return true;
      }),
    [normalizedProjectPathKey, scope, tunnels],
  );
  const sortedTunnels = useMemo(
    () => [...scopedTunnels].sort((a, b) => b.createdAt - a.createdAt),
    [scopedTunnels],
  );
  const canCreate =
    enabled &&
    !creating &&
    !targetValidationKey &&
    (scope !== "project" || Boolean(normalizedProjectPathKey));
  const showCreateForm = scope === "project" && Boolean(normalizedProjectPathKey);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Globe className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              {t("projectTools.tunnelTitle")}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {t("projectTools.tunnelDescription")}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="flex h-8 items-center rounded-md border border-border bg-background p-0.5">
              {TUNNEL_SCOPE_OPTIONS.map((option) => {
                const active = scope === option.scope;
                const disabled = option.scope === "project" && !normalizedProjectPathKey;
                const Icon = option.scope === "project" ? Folder : Globe;
                return (
                  <button
                    key={option.scope}
                    type="button"
                    aria-label={t(option.labelKey)}
                    aria-pressed={active}
                    title={t(option.titleKey)}
                    disabled={disabled}
                    onClick={() => {
                      setScope(option.scope);
                      setError(null);
                    }}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
                      active && "bg-muted text-foreground shadow-sm",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {disabledMessage || showCreateForm ? (
        <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-3">
          {disabledMessage ? (
            <div className="mb-3 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              {disabledMessage}
            </div>
          ) : null}
          {showCreateForm ? (
            <div className="grid min-w-0 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="local-tunnel-target" className="text-xs">
                  {t("projectTools.tunnelTargetUrl")}
                </Label>
                <Input
                  id="local-tunnel-target"
                  value={targetUrl}
                  onChange={(event) => setTargetUrl(event.target.value)}
                  placeholder={t("projectTools.tunnelTargetPlaceholder")}
                  disabled={!enabled || creating}
                  className="h-8 min-w-0 text-xs"
                />
                {targetValidationKey ? (
                  <div className="text-xs text-muted-foreground">{t(targetValidationKey)}</div>
                ) : null}
              </div>
              <div className="grid min-w-0 gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="local-tunnel-name" className="text-xs">
                    {t("projectTools.tunnelName")}
                  </Label>
                  <Input
                    id="local-tunnel-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t("projectTools.tunnelNamePlaceholder")}
                    disabled={!enabled || creating}
                    className="h-8 min-w-0 text-xs"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">{t("projectTools.tunnelTtl")}</Label>
                  <div className="grid h-8 min-w-0 grid-cols-4 overflow-hidden rounded-md border border-input bg-background">
                    {TTL_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setTtlSeconds(option.value)}
                        disabled={!enabled || creating}
                        className={cn(
                          "min-w-0 truncate border-r border-border px-1.5 text-xs text-muted-foreground last:border-r-0 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
                          ttlSeconds === option.value && "bg-muted text-foreground",
                        )}
                      >
                        {t(option.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                className="h-8 gap-2 text-xs"
                disabled={!canCreate}
                onClick={createTunnel}
                title={!enabled ? disabledMessage : undefined}
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Link2 className="h-3.5 w-3.5" />
                )}
                {creating ? t("projectTools.tunnelCreating") : t("projectTools.tunnelCreate")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error ? (
          <div className="mb-3 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}
        {loading && sortedTunnels.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("projectTools.tunnelLoading")}
          </div>
        ) : sortedTunnels.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center text-xs text-muted-foreground">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
              <Globe className="h-6 w-6" />
            </div>
            <div>{t("projectTools.tunnelEmpty")}</div>
          </div>
        ) : (
          <div className="grid gap-2">
            {sortedTunnels.map((tunnel) => {
              const hasExpiry = tunnel.expiresAt > 0;
              const remaining = hasExpiry ? tunnel.expiresAt - nowSeconds : 0;
              const expired = tunnel.status === "expired" || (hasExpiry && remaining <= 0);
              const isEditing = editingId === tunnel.id;
              const updating = savingId === tunnel.id;
              const tunnelProjectPathKey = normalizeProjectPathKey(tunnel.projectPathKey);
              return (
                <div
                  key={tunnel.id}
                  className="min-w-0 overflow-hidden rounded-lg border border-border bg-background px-3 py-2.5 shadow-sm"
                >
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Link2 className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-foreground">
                          {displayTunnelName(tunnel)}
                        </div>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                            tunnel.status === "offline"
                              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                              : expired
                                ? "bg-muted text-muted-foreground"
                                : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                          )}
                        >
                          {t(tunnelStatusKey(expired ? "expired" : tunnel.status))}
                        </span>
                      </div>
                      {isEditing ? (
                        <div className="mt-2 grid min-w-0 gap-2">
                          <Input
                            value={editTargetUrl}
                            onChange={(event) => setEditTargetUrl(event.target.value)}
                            disabled={!enabled || updating}
                            className="h-8 min-w-0 text-xs"
                            aria-label={t("projectTools.tunnelTargetUrl")}
                          />
                          {editTargetValidationKey ? (
                            <div className="text-xs text-muted-foreground">
                              {t(editTargetValidationKey)}
                            </div>
                          ) : null}
                          <div className="grid min-w-0 gap-2">
                            <Input
                              value={editName}
                              onChange={(event) => setEditName(event.target.value)}
                              placeholder={t("projectTools.tunnelNamePlaceholder")}
                              disabled={!enabled || updating}
                              className="h-8 min-w-0 text-xs"
                              aria-label={t("projectTools.tunnelName")}
                            />
                            <div className="grid gap-1.5">
                              <Label className="text-xs">{t("projectTools.tunnelTtl")}</Label>
                              <div className="grid h-8 min-w-0 grid-cols-4 overflow-hidden rounded-md border border-input bg-background">
                                {TTL_OPTIONS.map((option) => (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => setEditTtlSeconds(option.value)}
                                    disabled={!enabled || updating}
                                    className={cn(
                                      "min-w-0 truncate border-r border-border px-1.5 text-xs text-muted-foreground last:border-r-0 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
                                      editTtlSeconds === option.value && "bg-muted text-foreground",
                                    )}
                                  >
                                    {t(option.labelKey)}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="mt-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
                            {t("projectTools.tunnelTarget")}: {tunnel.targetUrl}
                          </div>
                          <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                            <Globe className="h-3.5 w-3.5 shrink-0" />
                            <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                              {tunnel.publicUrl}
                            </span>
                          </div>
                          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <span className="inline-flex min-w-0 items-center gap-1">
                              <Clock3 className="h-3.5 w-3.5 shrink-0" />
                              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                                {!hasExpiry
                                  ? t("projectTools.tunnelTtlInfinite")
                                  : expired
                                    ? t("projectTools.tunnelExpired")
                                    : t("projectTools.tunnelExpiresIn").replace(
                                        "{time}",
                                        formatRemaining(remaining),
                                      )}
                              </span>
                            </span>
                            {scope === "global" ? (
                              <span>
                                {t(
                                  tunnelProjectPathKey
                                    ? "projectTools.tunnelScopeProjectBadge"
                                    : "projectTools.tunnelScopeGlobalBadge",
                                )}
                              </span>
                            ) : null}
                            {hasExpiry ? <span>{formatDateTime(tunnel.expiresAt)}</span> : null}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-end gap-1.5">
                    {isEditing ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                          disabled={!enabled || updating || Boolean(editTargetValidationKey)}
                          onClick={() => updateTunnel(tunnel)}
                          title={
                            updating
                              ? t("projectTools.tunnelUpdating")
                              : t("projectTools.tunnelSave")
                          }
                        >
                          {updating ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Save className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                          disabled={updating}
                          onClick={cancelEdit}
                          title={t("projectTools.tunnelCancelEdit")}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                          disabled={!enabled || expired}
                          onClick={() => beginEdit(tunnel)}
                          title={!enabled ? disabledMessage : t("projectTools.tunnelEdit")}
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                          disabled={!tunnel.publicUrl}
                          onClick={() => copyLink(tunnel)}
                          title={
                            copiedId === tunnel.id
                              ? t("projectTools.tunnelCopied")
                              : t("projectTools.tunnelCopyLink")
                          }
                          aria-label={
                            copiedId === tunnel.id
                              ? t("projectTools.tunnelCopied")
                              : t("projectTools.tunnelCopyLink")
                          }
                        >
                          {copiedId === tunnel.id ? (
                            <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
                          disabled={!tunnel.publicUrl || expired}
                          onClick={() => openLink(tunnel)}
                          title={t("projectTools.tunnelOpenLink")}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          disabled={!enabled || closingId === tunnel.id}
                          onClick={() => closeTunnel(tunnel.id)}
                          title={!enabled ? disabledMessage : t("projectTools.tunnelClose")}
                        >
                          {closingId === tunnel.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
