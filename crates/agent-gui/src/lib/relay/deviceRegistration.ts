import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../settings";
import { getRelayAccessToken } from "./client";

type CredentialRecord = { deviceId: string; credential: string };

function registrationURL(settings: AppSettings) {
  const url = new URL(settings.remote.gatewayUrl.trim());
  if (settings.remote.grpcPort > 0) url.port = String(settings.remote.grpcPort);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/desktop/devices/register`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function installationID() {
  const key = "zerobox.installation-id";
  const current = localStorage.getItem(key)?.trim();
  if (current) return current;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

export async function registerDesktopDevice(settings: AppSettings) {
  const accessToken = getRelayAccessToken();
  if (!settings.remote.enabled || !settings.remote.gatewayUrl.trim() || !accessToken) return null;
  const existing = await invoke<CredentialRecord | null>("device_credential_get");
  const defaultName = await invoke<string>("device_default_name");
  const response = await fetch(registrationURL(settings), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      installation_id: installationID(),
      name: existing ? "" : defaultName,
      platform: navigator.platform || "desktop",
      version: await invoke<string>("zerobox_app_version"),
      device_id: existing?.deviceId ?? "",
      device_credential: existing?.credential ?? "",
      workspaces: settings.system.workspaceProjects.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
      })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    device?: { id: string };
    device_credential?: string;
    error?: string;
  } | null;
  if (!response.ok || !payload?.device?.id) {
    throw new Error(payload?.error || `设备注册失败 (HTTP ${response.status})`);
  }
  if (payload.device_credential) {
    await invoke("device_credential_set", {
      record: { deviceId: payload.device.id, credential: payload.device_credential },
    });
  }
  await invoke("gateway_nudge_connection", {
    reason: "device_registered",
    force_reconnect: true,
  });
  return payload.device;
}
