import { useCallback, useEffect, useState } from "react";

import {
  type ExecutionEnvironment,
  type ExecutionSelection,
  type ExecutionWorkspace,
  encodeSelectionCredential,
  getExecutionEnvironments,
  selectExecutionTarget,
} from "@/lib/executionTargets";
import { resetGatewayWebSocketClient } from "@/lib/gatewaySocket";
import {
  getRelayCurrentUser,
  loginRelay,
  loginRelay2FA,
  logoutRelay,
  type RelayUser,
  registerRelay,
} from "@/lib/relay/client";
import { setEphemeralCredential } from "@/lib/storage";

export function useGatewaySession(historyShareToken: string | null) {
  const [accountUser, setAccountUser] = useState<RelayUser | null>(null);
  const [environments, setEnvironments] = useState<ExecutionEnvironment[]>([]);
  const [selection, setSelection] = useState<ExecutionSelection | null>(null);
  const [token, setToken] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(!historyShareToken);
  const [authError, setAuthError] = useState<string | null>(null);
  const [twoFactorToken, setTwoFactorToken] = useState("");

  useEffect(() => {
    setEphemeralCredential(token);
    return () => setEphemeralCredential(null);
  }, [token]);

  const loadEnvironments = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    const desktopEmbedded = params.get("controller_surface") === "desktop_embed";
    const localDeviceId = params.get("local_device_id")?.trim() ?? "";
    const items = await getExecutionEnvironments(
      desktopEmbedded ? "desktop" : "web",
      localDeviceId,
    );
    setEnvironments(items);
    const handoffLease = params.get("selection_lease")?.trim() ?? "";
    const handoffRuntime = params.get("runtime_kind")?.trim() ?? "";
    const handoffWorkspace = params.get("workspace_id")?.trim() ?? "";
    if (handoffLease && handoffRuntime === "device_agent" && handoffWorkspace) {
      const next: ExecutionSelection = {
        selection_lease: handoffLease,
        runtime_kind: "device_agent",
        device_id: params.get("device_id")?.trim() ?? "",
        workspace_id: handoffWorkspace,
        target_fingerprint: [
          handoffRuntime,
          params.get("device_id")?.trim() ?? "",
          handoffWorkspace,
        ].join(":"),
        conversation_id: params.get("conversation_id")?.trim() || crypto.randomUUID(),
        expires_at: "",
      };
      setSelection(next);
      setToken(encodeSelectionCredential(next));
      const cleanURL = new URL(window.location.href);
      for (const key of [
        "selection_lease",
        "runtime_kind",
        "device_id",
        "workspace_id",
        "conversation_id",
      ]) {
        cleanURL.searchParams.delete(key);
      }
      window.history.replaceState(null, "", `${cleanURL.pathname}${cleanURL.search}`);
      return items;
    }
    setSelection((current) => {
      if (current) return current;
      const web = items.find((item) => item.runtime_kind === "web_chat");
      const workspace = web?.workspaces[0];
      return web && workspace
        ? {
            selection_lease: "",
            runtime_kind: "web_chat",
            workspace_id: workspace.id,
            target_fingerprint: web.target_fingerprint ?? "web_chat::cloud",
            conversation_id: crypto.randomUUID(),
            expires_at: "",
          }
        : null;
    });
    return items;
  }, []);

  useEffect(() => {
    if (historyShareToken) {
      setAuthSubmitting(false);
      return;
    }
    let cancelled = false;
    void getRelayCurrentUser()
      .then(async (user) => {
        if (cancelled) return;
        setAccountUser(user);
        await loadEnvironments();
      })
      .catch(() => {
        if (!cancelled) setAccountUser(null);
      })
      .finally(() => {
        if (!cancelled) setAuthSubmitting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [historyShareToken, loadEnvironments]);

  useEffect(() => {
    if (!accountUser || historyShareToken) return;
    const timer = window.setInterval(() => {
      void loadEnvironments().catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [accountUser, historyShareToken, loadEnvironments]);

  const login = useCallback(
    async (email: string, password: string) => {
      setAuthSubmitting(true);
      setAuthError(null);
      try {
        const response = await loginRelay(email, password);
        if ("requires_2fa" in response && response.requires_2fa) {
          setTwoFactorToken(response.temp_token);
          return "two-factor" as const;
        }
        if (!("user" in response)) return "failed" as const;
        setAccountUser(response.user);
        await loadEnvironments();
        return "authenticated" as const;
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "登录失败");
        return "failed" as const;
      } finally {
        setAuthSubmitting(false);
      }
    },
    [loadEnvironments],
  );

  const verifyTwoFactor = useCallback(
    async (code: string) => {
      setAuthSubmitting(true);
      setAuthError(null);
      try {
        const response = await loginRelay2FA(twoFactorToken, code);
        setAccountUser(response.user);
        setTwoFactorToken("");
        await loadEnvironments();
        return true;
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "两步验证码校验失败");
        return false;
      } finally {
        setAuthSubmitting(false);
      }
    },
    [loadEnvironments, twoFactorToken],
  );

  const register = useCallback(
    async (input: {
      email: string;
      password: string;
      verifyCode?: string;
      invitationCode?: string;
    }) => {
      setAuthSubmitting(true);
      setAuthError(null);
      try {
        const response = await registerRelay(input);
        setAccountUser(response.user);
        await loadEnvironments();
        return true;
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "注册失败");
        return false;
      } finally {
        setAuthSubmitting(false);
      }
    },
    [loadEnvironments],
  );

  const switchExecutionTarget = useCallback(
    async (environment: ExecutionEnvironment, workspace: ExecutionWorkspace, password: string) => {
      const next = await selectExecutionTarget(environment, workspace, password);
      resetGatewayWebSocketClient();
      setSelection(next);
      setToken(next.runtime_kind === "device_agent" ? encodeSelectionCredential(next) : "");
      return next;
    },
    [],
  );

  const clearSession = useCallback(() => {
    void logoutRelay();
    resetGatewayWebSocketClient();
    setAccountUser(null);
    setEnvironments([]);
    setSelection(null);
    setToken("");
    setTwoFactorToken("");
    setAuthError(null);
  }, []);

  return {
    token,
    accountUser,
    environments,
    selection,
    authSubmitting,
    authError,
    twoFactorRequired: Boolean(twoFactorToken),
    setAuthError,
    login,
    register,
    verifyTwoFactor,
    switchExecutionTarget,
    reloadEnvironments: loadEnvironments,
    clearSession,
  };
}
