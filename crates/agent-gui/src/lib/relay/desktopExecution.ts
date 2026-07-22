import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../settings";
import { getRelayAccessToken } from "./client";

export type DesktopWorkspace = {
  id: string;
  name: string;
  path?: string;
  kind?: "managed" | "folder" | "history";
  is_pinned?: boolean;
  pinned_at?: number;
  archived?: boolean;
  missing?: boolean;
  updated_at?: number;
};
export type DesktopEnvironment = {
  runtime_kind: "device_agent";
  device_id: string;
  device_name?: string;
  name: string;
  online: boolean;
  platform?: string;
  version?: string;
  last_seen_at?: string;
  workspaces: DesktopWorkspace[];
};

type CredentialRecord = { deviceId: string; credential: string };

function gatewayURL(settings: AppSettings, path: string) {
  const url = new URL(settings.remote.gatewayUrl.trim());
  if (settings.remote.grpcPort > 0) url.port = String(settings.remote.grpcPort);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

async function desktopRequest<T>(settings: AppSettings, path: string, init?: RequestInit) {
  const token = getRelayAccessToken();
  if (!token) throw new Error("USA-零登录已失效");
  const response = await fetch(gatewayURL(settings, path), {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !payload)
    throw new Error(payload?.error || `Gateway 请求失败 (HTTP ${response.status})`);
  return payload;
}

export async function getDesktopEnvironments(settings: AppSettings) {
  if (!settings.remote.enabled || !settings.remote.gatewayUrl.trim()) return null;
  const credential = await invoke<CredentialRecord | null>("device_credential_get");
  if (!credential?.deviceId) return null;
  const path = `/api/desktop/environments?local_device_id=${encodeURIComponent(credential.deviceId)}`;
  const response = await desktopRequest<{ environments: DesktopEnvironment[] }>(settings, path);
  return { environments: response.environments, localDeviceId: credential.deviceId };
}

export async function renameDesktopDevice(settings: AppSettings, deviceId: string, name: string) {
  const response = await desktopRequest<{ device: DesktopEnvironment }>(
    settings,
    `/api/desktop/devices/${encodeURIComponent(deviceId)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  return response.device;
}

export async function revokeDesktopDevice(settings: AppSettings, deviceId: string) {
  await desktopRequest<void>(settings, `/api/desktop/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
}
export async function switchDesktopEnvironment(
  settings: AppSettings,
  environment: DesktopEnvironment,
  workspace: DesktopWorkspace,
  password: string,
) {
  const target = `device_agent:${environment.device_id}:${workspace.id}`;
  const stepUp = await desktopRequest<{ proof: string }>(
    settings,
    "/api/desktop/execution-target/step-up",
    {
      method: "POST",
      body: JSON.stringify({ password, target_fingerprint: target }),
    },
  );
  const selection = await desktopRequest<{ selection_lease: string }>(
    settings,
    "/api/desktop/execution-target/select",
    {
      method: "POST",
      body: JSON.stringify({
        proof: stepUp.proof,
        runtime_kind: "device_agent",
        device_id: environment.device_id,
        workspace_id: workspace.id,
        target_fingerprint: target,
      }),
    },
  );
  return selection;
}

export function desktopGatewayOrigin(settings: AppSettings) {
  return gatewayURL(settings, "/").origin;
}

export function encodeDesktopSelectionCredential(
  lease: string,
  deviceId: string,
  workspaceId = "",
) {
  const json = JSON.stringify({
    lease,
    runtimeKind: "device_agent",
    deviceId,
    workspaceId,
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `selection.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export type DesktopConversationRoute = {
  conversation_id: string;
  device_id: string;
  workspace_id: string;
  title: string;
  summary: string;
  created_at: string;
  updated_at: string;
  device_name?: string;
  device_online: boolean;
};

export async function getDesktopConversationRoutes(settings: AppSettings, deviceId: string) {
  const response = await desktopRequest<{ conversations: DesktopConversationRoute[] }>(
    settings,
    `/api/desktop/conversation-routes?device_id=${encodeURIComponent(deviceId)}`,
  );
  return response.conversations;
}

export async function switchDesktopDevice(
  settings: AppSettings,
  environment: DesktopEnvironment,
  password: string,
) {
  const target = `device_agent:${environment.device_id}:`;
  const stepUp = await desktopRequest<{ proof: string }>(
    settings,
    "/api/desktop/execution-target/step-up",
    {
      method: "POST",
      body: JSON.stringify({ password, target_fingerprint: target }),
    },
  );
  return desktopRequest<{
    selection_lease: string;
    scope: "device";
    device_id: string;
    expires_at: string;
  }>(settings, "/api/desktop/execution-target/select", {
    method: "POST",
    body: JSON.stringify({
      proof: stepUp.proof,
      runtime_kind: "device_agent",
      device_id: environment.device_id,
      workspace_id: "",
      scope: "device",
      target_fingerprint: target,
    }),
  });
}
