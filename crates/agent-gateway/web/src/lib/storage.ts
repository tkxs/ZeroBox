const TOKEN_KEY = "liveagent.gateway.token";
let ephemeralCredential: string | null = null;

export function loadToken(): string {
  if (ephemeralCredential !== null) {
    return ephemeralCredential;
  }
  return window.localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setEphemeralCredential(token: string | null): void {
  ephemeralCredential = token;
}

export function saveToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}
