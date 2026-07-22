import { prepareProxyRequest } from "../providers/proxy";

const RELAY_ORIGIN_KEY = "zerobox.usa-zero-origin";
const DEFAULT_RELAY_ORIGIN = "https://usa0.top";

function normalizeRelayOrigin(value: string) {
  const url = new URL(value.trim());
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error("USA-零服务地址必须是有效的 HTTP 或 HTTPS 地址");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function initialRelayOrigin() {
  const configured =
    typeof localStorage === "undefined" ? "" : localStorage.getItem(RELAY_ORIGIN_KEY)?.trim();
  const buildDefault =
    typeof __ZEROAGENT_USA_ZERO_ORIGIN__ === "string" ? __ZEROAGENT_USA_ZERO_ORIGIN__.trim() : "";
  try {
    return normalizeRelayOrigin(configured || buildDefault || DEFAULT_RELAY_ORIGIN);
  } catch {
    return DEFAULT_RELAY_ORIGIN;
  }
}

export let RELAY_ORIGIN = initialRelayOrigin();
export let RELAY_API_BASE_URL = `${RELAY_ORIGIN}/api/v1`;
export const RELAY_SESSION_CHANGED_EVENT = "liveagent:relay-session-changed";

const ACCESS_TOKEN_KEY = "liveagent.relay.access-token";
const REFRESH_TOKEN_KEY = "liveagent.relay.refresh-token";
const EXPIRES_AT_KEY = "liveagent.relay.expires-at";

type RelayEnvelope<T> = {
  code: number;
  message: string;
  reason?: string;
  data?: T;
};

export type RelayUser = {
  id: number;
  email: string;
  username?: string;
  role?: string;
  balance?: number;
  frozen_balance?: number;
  concurrency?: number;
  status?: string;
  created_at?: string;
  total_recharged?: number;
  avatar_url?: string;
  email_bound?: boolean;
};

export type RelayDashboardStats = {
  today_tokens: number;
  today_input_tokens?: number;
  today_output_tokens?: number;
  today_cache_creation_tokens?: number;
  today_cache_read_tokens?: number;
};

export function formatRelayBalance(balance?: number) {
  return Number.isFinite(balance) ? `$${Number(balance).toFixed(2)}` : "--";
}

export function formatRelayTokenCount(tokens?: number) {
  if (!Number.isFinite(tokens)) return "--";
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(tokens));
}

type RelaySessionTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

export type RelayAuthResponse = RelaySessionTokens & {
  user: RelayUser;
};

export type RelayLoginResponse =
  | RelayAuthResponse
  | {
      requires_2fa: true;
      temp_token: string;
      user_email_masked?: string;
    };

export type RelayPublicSettings = {
  registration_enabled: boolean;
  email_verify_enabled: boolean;
  invitation_code_enabled: boolean;
  turnstile_enabled: boolean;
  site_name?: string;
  site_subtitle?: string;
};

export type RelayGroup = {
  id: number;
  name: string;
  description?: string | null;
  platform: "anthropic" | "openai" | "gemini" | "antigravity" | "grok" | string;
  rate_multiplier: number;
  subscription_type?: "standard" | "subscription" | string;
  status: "active" | "inactive" | string;
};

export type RelayApiKey = {
  id: number;
  key: string;
  name: string;
  group_id: number | null;
  status: "active" | "inactive" | "disabled" | "quota_exhausted" | "expired" | string;
  quota: number;
  quota_used: number;
  created_at: string;
  group?: RelayGroup;
};

type RelayPaginated<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
};

export class RelayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = "RelayApiError";
  }
}

function readAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY)?.trim() ?? "";
}

export function getRelayAccessToken() {
  return readAccessToken();
}

function readRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY)?.trim() ?? "";
}

function saveSession(response: RelaySessionTokens) {
  localStorage.setItem(ACCESS_TOKEN_KEY, response.access_token.trim());
  if (response.refresh_token?.trim()) {
    localStorage.setItem(REFRESH_TOKEN_KEY, response.refresh_token.trim());
  }
  if (response.expires_in && response.expires_in > 0) {
    localStorage.setItem(EXPIRES_AT_KEY, String(Date.now() + response.expires_in * 1000));
  }
}

export function clearRelaySession() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
}

export function configureRelayOrigin(value: string) {
  const next = normalizeRelayOrigin(value);
  if (next === RELAY_ORIGIN) return next;
  clearRelaySession();
  localStorage.setItem(RELAY_ORIGIN_KEY, next);
  RELAY_ORIGIN = next;
  RELAY_API_BASE_URL = `${next}/api/v1`;
  window.dispatchEvent(new Event(RELAY_SESSION_CHANGED_EVENT));
  return next;
}

export function hasStoredRelaySession() {
  return Boolean(readAccessToken() || readRefreshToken());
}

type RelayRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  authenticated?: boolean;
  retryAfterRefresh?: boolean;
};

async function requestRelay<T>(path: string, options: RelayRequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (options.authenticated) {
    const accessToken = readAccessToken();
    if (!accessToken) throw new RelayApiError("请先登录 USA-零", 401);
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const proxyRequest = await prepareProxyRequest("codex", RELAY_API_BASE_URL, headers);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  let response: Response;
  try {
    response = await fetch(`${proxyRequest.baseUrl}${normalizedPath}`, {
      method,
      headers: proxyRequest.headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new RelayApiError(
      `无法连接 USA-零：${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }

  let envelope: RelayEnvelope<T> | null = null;
  try {
    envelope = (await response.json()) as RelayEnvelope<T>;
  } catch {
    throw new RelayApiError(`USA-零返回了无效响应 (HTTP ${response.status})`, response.status);
  }

  if (response.status === 401 && options.authenticated && options.retryAfterRefresh !== false) {
    const refreshed = await refreshRelaySession();
    if (refreshed) {
      return requestRelay<T>(path, { ...options, retryAfterRefresh: false });
    }
  }

  if (!response.ok || envelope.code !== 0 || envelope.data === undefined) {
    throw new RelayApiError(
      envelope.message || `请求失败 (HTTP ${response.status})`,
      response.status,
      envelope.code,
      envelope.reason,
    );
  }
  return envelope.data;
}

async function refreshRelaySession() {
  const refreshToken = readRefreshToken();
  if (!refreshToken) {
    clearRelaySession();
    return false;
  }
  try {
    const response = await requestRelay<RelaySessionTokens>("/auth/refresh", {
      method: "POST",
      body: { refresh_token: refreshToken },
      retryAfterRefresh: false,
    });
    saveSession(response);
    return true;
  } catch {
    clearRelaySession();
    return false;
  }
}

function isFullAuthResponse(response: RelayLoginResponse): response is RelayAuthResponse {
  return "access_token" in response && typeof response.access_token === "string";
}

export async function getRelayPublicSettings() {
  return requestRelay<RelayPublicSettings>("/settings/public");
}

export async function loginRelay(email: string, password: string) {
  const response = await requestRelay<RelayLoginResponse>("/auth/login", {
    method: "POST",
    body: { email: email.trim(), password },
  });
  if (isFullAuthResponse(response)) saveSession(response);
  return response;
}

export async function verifyRelayPassword(email: string, password: string) {
  const response = await loginRelay(email, password);
  if (!("access_token" in response) && !response.requires_2fa) {
    throw new RelayApiError("密码验证失败", 401);
  }
}

export async function loginRelay2FA(tempToken: string, totpCode: string) {
  const response = await requestRelay<RelayAuthResponse>("/auth/login/2fa", {
    method: "POST",
    body: { temp_token: tempToken, totp_code: totpCode.trim() },
  });
  saveSession(response);
  return response;
}

export async function registerRelay(input: {
  email: string;
  password: string;
  verifyCode?: string;
  invitationCode?: string;
}) {
  const response = await requestRelay<RelayAuthResponse>("/auth/register", {
    method: "POST",
    body: {
      email: input.email.trim(),
      password: input.password,
      verify_code: input.verifyCode?.trim() ?? "",
      invitation_code: input.invitationCode?.trim() ?? "",
    },
  });
  saveSession(response);
  return response;
}

export async function sendRelayVerifyCode(email: string) {
  return requestRelay<{ message: string; countdown: number }>("/auth/send-verify-code", {
    method: "POST",
    body: { email: email.trim() },
  });
}

export async function getRelayCurrentUser() {
  return requestRelay<RelayUser>("/auth/me", { authenticated: true });
}

export async function getRelayProfile() {
  return requestRelay<RelayUser>("/user/profile", { authenticated: true });
}

export async function getRelayDashboardStats() {
  return requestRelay<RelayDashboardStats>("/usage/dashboard/stats", { authenticated: true });
}

export async function updateRelayProfile(profile: {
  username?: string;
  avatar_url?: string | null;
}) {
  return requestRelay<RelayUser>("/user", {
    method: "PUT",
    authenticated: true,
    body: profile,
  });
}

export async function sendRelayEmailBindingCode(email: string) {
  return requestRelay<{ message?: string }>("/user/account-bindings/email/send-code", {
    method: "POST",
    authenticated: true,
    body: { email: email.trim() },
  });
}

export async function bindRelayEmail(email: string, verifyCode: string, password: string) {
  return requestRelay<RelayUser>("/user/account-bindings/email", {
    method: "POST",
    authenticated: true,
    body: {
      email: email.trim(),
      verify_code: verifyCode.trim(),
      password,
    },
  });
}

export async function changeRelayPassword(oldPassword: string, newPassword: string) {
  return requestRelay<{ message?: string }>("/user/password", {
    method: "PUT",
    authenticated: true,
    body: { old_password: oldPassword, new_password: newPassword },
  });
}

export async function listRelayApiKeys() {
  const page = await requestRelay<RelayPaginated<RelayApiKey>>("/keys?page=1&page_size=1000", {
    authenticated: true,
  });
  return page.items;
}

export async function listRelayGroups() {
  return requestRelay<RelayGroup[]>("/groups/available", { authenticated: true });
}

export async function createRelayApiKey(name: string, groupId: number) {
  return requestRelay<RelayApiKey>("/keys", {
    method: "POST",
    authenticated: true,
    body: { name: name.trim(), group_id: groupId },
  });
}

export async function createRelayApiKeys(name: string, groupIds: number[], groups: RelayGroup[]) {
  const uniqueGroupIds = [...new Set(groupIds)].filter((groupId) =>
    groups.some((group) => group.id === groupId && group.status === "active"),
  );
  if (uniqueGroupIds.length === 0) {
    throw new RelayApiError("请选择至少一个可用分组", 400);
  }

  const created: RelayApiKey[] = [];
  for (const groupId of uniqueGroupIds) {
    const group = groups.find((item) => item.id === groupId);
    const keyName = uniqueGroupIds.length === 1 ? name : `${name} / ${group?.name ?? groupId}`;
    created.push(await createRelayApiKey(keyName, groupId));
  }
  return created;
}

export async function logoutRelay() {
  const refreshToken = readRefreshToken();
  if (refreshToken) {
    try {
      await requestRelay<{ message: string }>("/auth/logout", {
        method: "POST",
        body: { refresh_token: refreshToken },
        retryAfterRefresh: false,
      });
    } catch {
      // Local logout must still complete when the relay is temporarily unavailable.
    }
  }
  clearRelaySession();
  window.dispatchEvent(new Event(RELAY_SESSION_CHANGED_EVENT));
}
