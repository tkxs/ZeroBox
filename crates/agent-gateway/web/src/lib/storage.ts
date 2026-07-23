let ephemeralCredential: string | null = null;
let legacyTokenCleared = false;

function clearLegacyPersistedToken(): void {
  if (legacyTokenCleared) return;
  legacyTokenCleared = true;
  try {
    window.localStorage.removeItem("liveagent.gateway.token");
  } catch {
    // Storage may be unavailable in hardened browser contexts.
  }
}

export function loadToken(): string {
  clearLegacyPersistedToken();
  return ephemeralCredential ?? "";
}

export function setEphemeralCredential(token: string | null): void {
  ephemeralCredential = token;
}
