export type ExecutionWorkspace = {
  id: string;
  name: string;
  path?: string;
};

export type ExecutionEnvironment = {
  runtime_kind: "web_chat" | "device_agent";
  device_id?: string;
  device_name?: string;
  name: string;
  online: boolean;
  platform?: string;
  version?: string;
  last_seen_at?: string;
  workspaces: ExecutionWorkspace[];
  target_fingerprint?: string;
  capabilities: string[];
};

export type ExecutionSelection = {
  selection_lease: string;
  runtime_kind: "web_chat" | "device_agent";
  device_id?: string;
  workspace_id: string;
  target_fingerprint: string;
  conversation_id: string;
  expires_at: string;
};

export function resolveExecutionTarget(
  environments: readonly ExecutionEnvironment[],
  selection: ExecutionSelection | null,
) {
  const environment = environments.find(
    (item) =>
      item.runtime_kind === selection?.runtime_kind &&
      (item.device_id ?? "") === (selection?.device_id ?? ""),
  );
  const workspace = environment?.workspaces.find((item) => item.id === selection?.workspace_id);
  return { environment, workspace };
}

async function accountRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...init?.headers },
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `请求失败 (HTTP ${response.status})`);
  }
  return payload;
}

export async function getExecutionEnvironments(
  surface: "web" | "desktop" = "web",
  localDeviceId = "",
) {
  const query = new URLSearchParams({ surface });
  if (localDeviceId) query.set("local_device_id", localDeviceId);
  const response = await accountRequest<{ environments: ExecutionEnvironment[] }>(
    `/api/environments?${query.toString()}`,
  );
  return response.environments;
}

export async function renameExecutionDevice(deviceId: string, name: string) {
  const response = await accountRequest<{ device: ExecutionEnvironment }>(
    `/api/devices/${encodeURIComponent(deviceId)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  return response.device;
}

export async function revokeExecutionDevice(deviceId: string) {
  await accountRequest<void>(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
}

export async function selectExecutionTarget(
  environment: ExecutionEnvironment,
  workspace: ExecutionWorkspace,
  password: string,
): Promise<ExecutionSelection> {
  const target = [environment.runtime_kind, environment.device_id ?? "", workspace.id].join(":");
  const stepUp = await accountRequest<{ proof: string }>("/api/execution-target/step-up", {
    method: "POST",
    body: JSON.stringify({ password, target_fingerprint: target }),
  });
  return accountRequest<ExecutionSelection>("/api/execution-target/select", {
    method: "POST",
    body: JSON.stringify({
      proof: stepUp.proof,
      runtime_kind: environment.runtime_kind,
      device_id: environment.device_id ?? "",
      workspace_id: workspace.id,
      target_fingerprint: target,
    }),
  });
}

export function encodeSelectionCredential(selection: ExecutionSelection) {
  const json = JSON.stringify({
    lease: selection.selection_lease,
    runtimeKind: selection.runtime_kind,
    deviceId: selection.device_id ?? "",
    workspaceId: selection.workspace_id,
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `selection.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export function decodeSelectionCredential(value: string): {
  lease: string;
  runtimeKind: string;
  deviceId: string;
  workspaceId: string;
} | null {
  if (!value.startsWith("selection.")) return null;
  try {
    const encoded = value.slice("selection.".length).replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as {
      lease: string;
      runtimeKind: string;
      deviceId: string;
      workspaceId: string;
    };
  } catch {
    return null;
  }
}
