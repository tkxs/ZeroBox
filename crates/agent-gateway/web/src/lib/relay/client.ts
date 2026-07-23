import { clearEmbeddedMobileGatewaySession, isEmbeddedMobileRuntime } from "../mobileRuntime";

export const RELAY_ORIGIN = "https://usa0.top";
export const RELAY_SESSION_CHANGED_EVENT = "zerobox:relay-session-changed";

const RELAY_PROXY_BASE = "/api/usa-zero";

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

export type RelayAuthResponse = RelaySessionTokens & { user: RelayUser };

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
  platform: string;
  rate_multiplier: number;
  subscription_type?: string;
  status: string;
};

export type RelayApiKey = {
  id: number;
  key: string;
  name: string;
  group_id: number | null;
  status: string;
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

export function clearRelaySession() {
  // Tokens remain server-side and are represented only by an HttpOnly cookie.
}

export function hasStoredRelaySession() {
  return true;
}

type RelayRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  authenticated?: boolean;
  retryAfterRefresh?: boolean;
};

async function requestRelay<T>(path: string, options: RelayRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  let response: Response;
  try {
    response = await fetch(`${RELAY_PROXY_BASE}${normalizedPath}`, {
      method: options.method ?? "GET",
      headers,
      credentials: "include",
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

export function getRelayPublicSettings() {
  return requestGatewayAccount<RelayPublicSettings>("/api/auth/settings");
}

export async function loginRelay(email: string, password: string) {
  const response = await requestGatewayAccount<
    { user: RelayUser } | { requires_2fa: true; temp_token: string; user_email_masked?: string }
  >("/api/auth/login", {
    method: "POST",
    body: { email: email.trim(), password },
  });
  if ("requires_2fa" in response) return response;
  return {
    access_token: "cookie-session",
    token_type: "Cookie",
    user: response.user,
  } satisfies RelayAuthResponse;
}

export async function verifyRelayPassword(email: string, password: string) {
  const response = await loginRelay(email, password);
  if (!("access_token" in response) && !response.requires_2fa) {
    throw new RelayApiError("密码验证失败", 401);
  }
}

export async function loginRelay2FA(tempToken: string, totpCode: string) {
  const response = await requestGatewayAccount<{ user: RelayUser }>("/api/auth/2fa", {
    method: "POST",
    body: { temp_token: tempToken, totp_code: totpCode.trim() },
  });
  return {
    access_token: "cookie-session",
    token_type: "Cookie",
    user: response.user,
  } satisfies RelayAuthResponse;
}

export async function registerRelay(input: {
  email: string;
  password: string;
  verifyCode?: string;
  invitationCode?: string;
}) {
  const response = await requestGatewayAccount<{ user: RelayUser }>("/api/auth/register", {
    method: "POST",
    body: {
      email: input.email.trim(),
      password: input.password,
      verify_code: input.verifyCode?.trim() ?? "",
      invitation_code: input.invitationCode?.trim() ?? "",
    },
  });
  return {
    access_token: "cookie-session",
    token_type: "Cookie",
    user: response.user,
  } satisfies RelayAuthResponse;
}

export function sendRelayVerifyCode(email: string) {
  return requestGatewayAccount<{ message: string; countdown: number }>(
    "/api/auth/send-verify-code",
    {
      method: "POST",
      body: { email: email.trim() },
    },
  );
}

export function getRelayCurrentUser() {
  return requestGatewayAccount<{ user: RelayUser }>("/api/auth/me").then(
    (response) => response.user,
  );
}

export function getRelayProfile() {
  return requestRelay<RelayUser>("/user/profile", { authenticated: true });
}

export function getRelayDashboardStats() {
  return requestRelay<RelayDashboardStats>("/usage/dashboard/stats", { authenticated: true });
}

export function updateRelayProfile(profile: { username?: string; avatar_url?: string | null }) {
  return requestRelay<RelayUser>("/user", {
    method: "PUT",
    authenticated: true,
    body: profile,
  });
}

export function sendRelayEmailBindingCode(email: string) {
  return requestRelay<{ message?: string }>("/user/account-bindings/email/send-code", {
    method: "POST",
    authenticated: true,
    body: { email: email.trim() },
  });
}

export function bindRelayEmail(email: string, verifyCode: string, password: string) {
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

export function changeRelayPassword(oldPassword: string, newPassword: string) {
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

export function listRelayGroups() {
  return requestRelay<RelayGroup[]>("/groups/available", { authenticated: true });
}

export function createRelayApiKey(name: string, groupId: number) {
  return requestRelay<RelayApiKey>("/keys", {
    method: "POST",
    authenticated: true,
    body: { name: name.trim(), group_id: groupId },
  });
}

export async function createRelayApiKeys(name: string, groupIds: number[], groups: RelayGroup[]) {
  const validIds = [...new Set(groupIds)].filter((id) =>
    groups.some((group) => group.id === id && group.status === "active"),
  );
  if (validIds.length === 0) throw new RelayApiError("请选择至少一个可用分组", 400);

  const created: RelayApiKey[] = [];
  for (const groupId of validIds) {
    const group = groups.find((item) => item.id === groupId);
    const keyName = validIds.length === 1 ? name : `${name} / ${group?.name ?? groupId}`;
    created.push(await createRelayApiKey(keyName, groupId));
  }
  return created;
}

export function getRelayProviderModels(keyId: number) {
  return requestGatewayAccount<{ models: unknown }>(
    `/api/web-chat/provider-keys/${encodeURIComponent(String(keyId))}/models`,
  ).then((response) => response.models);
}

async function requestGatewayAccount<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new RelayApiError(
      `无法连接账户服务：${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string; reason?: string })
    | null;
  if (!response.ok || !payload) {
    throw new RelayApiError(
      payload?.error || `请求失败 (HTTP ${response.status})`,
      response.status,
      undefined,
      payload?.reason,
    );
  }
  return payload;
}

export async function logoutRelay() {
  try {
    await requestGatewayAccount<void>("/api/auth/logout", { method: "POST" });
  } catch {
    // The UI session still clears when USA-Zero is temporarily unavailable.
  }
  if (isEmbeddedMobileRuntime()) {
    await clearEmbeddedMobileGatewaySession();
  }
  clearRelaySession();
  window.dispatchEvent(new Event(RELAY_SESSION_CHANGED_EVENT));
}
