export function remoteProjectStorageKey(deviceId: string) {
  return `zerobox.remote-project:${deviceId}`;
}

export function remoteConversationStorageKey(deviceId: string, projectId: string | null) {
  return `zerobox.remote-conversation:${deviceId}:${projectId || "plain-chat"}`;
}
