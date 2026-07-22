import type { Context } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { CronPromptRunner } from "./components/cron/CronPromptRunner";
import { DesktopExecutionSwitcher } from "./components/DesktopExecutionSwitcher";
import { useNativeInputContextMenu } from "./components/input-context-menu/NativeInputContextMenu";
import { MemoryOrganizerHost } from "./components/memory/useMemoryOrganizer";
import { RelayAccessGate } from "./components/relay/RelayAccessGate";
import { WindowsTitleBar } from "./components/WindowsTitleBar";
import { LocaleContext, t as translate } from "./i18n";
import { useAppUpdateController } from "./lib/appUpdates";
import { initAutomation } from "./lib/automation";
import {
  getRelayDashboardStats,
  getRelayProfile,
  RELAY_SESSION_CHANGED_EVENT,
  type RelayDashboardStats,
  type RelayUser,
} from "./lib/relay/client";
import {
  createRemoteControllerURL,
  type DesktopEnvironment,
  getDesktopEnvironments,
  switchDesktopEnvironment,
} from "./lib/relay/desktopExecution";
import { registerDesktopDevice } from "./lib/relay/deviceRegistration";
import { enforceRelayProviderConstraint } from "./lib/relay/providers";
import {
  type AppSettings,
  getDefaultSettings,
  getNextTheme,
  normalizeSettings,
  resolveEffectiveTheme,
  resolveWorkspaceProjects,
  subscribeToSystemThemePreference,
} from "./lib/settings";
import {
  loadPersistedSettingsWithDefaults,
  persistSettings,
  publishGatewaySettingsSync,
  type SettingsSaveState,
} from "./lib/settings/storage";
import {
  applyGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncPayload,
  type GatewaySettingsSyncPayload,
} from "./lib/settings/sync";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { SectionId } from "./pages/settings/types";

function getDefaultContext(): Context {
  return {
    messages: [],
  };
}

function asErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error ?? "").trim();
  return text || fallback;
}

const GATEWAY_SETTINGS_SYNC_EVENT = "gateway:settings-sync";
const LOCAL_ONLY_DEVICE_ID = "zerobox-local";

function buildLocalOnlyEnvironment(settings: AppSettings): DesktopEnvironment[] {
  const activeWorkspace =
    settings.system.workspaceProjects.find(
      (project) => project.id === settings.system.activeWorkspaceProjectId,
    ) ?? settings.system.workspaceProjects[0];
  if (!activeWorkspace) return [];
  return [
    {
      runtime_kind: "device_agent",
      device_id: LOCAL_ONLY_DEVICE_ID,
      name: "此电脑",
      online: true,
      platform: navigator.platform || "desktop",
      workspaces: [
        {
          id: activeWorkspace.id,
          name: activeWorkspace.name,
          path: activeWorkspace.path,
        },
      ],
    },
  ];
}

function AppChrome(props: { children: ReactNode }) {
  // Plain inputs get a shared cut/copy/paste menu; everything else keeps the
  // suppressed native menu (surfaces with their own menus opt out upstream).
  const { onRootContextMenu, onRootMouseDownCapture, menu } = useNativeInputContextMenu();
  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden bg-background"
      onContextMenu={onRootContextMenu}
      onMouseDownCapture={onRootMouseDownCapture}
    >
      <WindowsTitleBar />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">{props.children}</div>
      {menu}
    </div>
  );
}

function hasSettingsSyncChanged(prev: AppSettings, next: AppSettings) {
  return (
    JSON.stringify(buildGatewaySettingsSyncPayload(prev)) !==
    JSON.stringify(buildGatewaySettingsSyncPayload(next))
  );
}

function hasSensitiveSettingsUpdates(settings: AppSettings) {
  return (
    settings.customProviders.some((provider) => provider.apiKey.trim().length > 0) ||
    settings.ssh.hosts.some(
      (host) => host.password.trim().length > 0 || host.privateKey.trim().length > 0,
    )
  );
}

function hasSensitiveSettingsUpdatesPayload(payload: unknown) {
  const source =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { providerApiKeyUpdates?: unknown; sshSecretUpdates?: unknown })
      : {};
  const providerUpdates = source.providerApiKeyUpdates;
  if (
    providerUpdates &&
    typeof providerUpdates === "object" &&
    !Array.isArray(providerUpdates) &&
    Object.values(providerUpdates).some(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  ) {
    return true;
  }
  const sshUpdates = source.sshSecretUpdates;
  return Boolean(
    sshUpdates &&
      typeof sshUpdates === "object" &&
      !Array.isArray(sshUpdates) &&
      Object.values(sshUpdates).some((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const update = value as { password?: unknown; privateKey?: unknown };
        return (
          (typeof update.password === "string" && update.password.trim().length > 0) ||
          (typeof update.privateKey === "string" && update.privateKey.trim().length > 0)
        );
      }),
  );
}

function applyRuntimeSystemDefaults(settings: AppSettings, defaultWorkdir: string): AppSettings {
  const normalizedDefaultWorkdir = defaultWorkdir.trim();
  const system =
    !normalizedDefaultWorkdir || settings.system.workdir.trim()
      ? settings.system
      : {
          ...settings.system,
          workdir: normalizedDefaultWorkdir,
        };
  return enforceRelayProviderConstraint(
    normalizeSettings({
      ...settings,
      system: resolveWorkspaceProjects(system, normalizedDefaultWorkdir),
    }),
  );
}

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId>("system");
  const [settingsReady, setSettingsReady] = useState(false);
  const [relayReady, setRelayReady] = useState(false);
  const [relayUser, setRelayUser] = useState<RelayUser | null>(null);
  const [relayStats, setRelayStats] = useState<RelayDashboardStats | null>(null);
  const [desktopEnvironments, setDesktopEnvironments] = useState<DesktopEnvironment[]>([]);
  const [localDeviceId, setLocalDeviceId] = useState("");
  const [selectedExecutionDeviceId, setSelectedExecutionDeviceId] = useState("");
  const [selectedExecutionWorkspaceId, setSelectedExecutionWorkspaceId] = useState("");
  const [remoteControllerURL, setRemoteControllerURL] = useState("");
  const [executionBusy, setExecutionBusy] = useState(false);
  const [localConversationEpoch, setLocalConversationEpoch] = useState(0);
  const remoteControllerRef = useRef<HTMLIFrameElement>(null);
  const [settings, setSettingsState] = useState<AppSettings>(() => getDefaultSettings());
  const [settingsSaveState, setSettingsSaveState] = useState<SettingsSaveState>({
    status: "idle",
  });
  const [context, setContext] = useState<Context>(() => getDefaultContext());
  const [overlay, setOverlay] = useState<"closed" | "entering" | "open" | "leaving">("closed");

  useEffect(() => {
    const applyLocalOnly = () => {
      const environments = buildLocalOnlyEnvironment(settings);
      const workspaceId = environments[0]?.workspaces[0]?.id ?? "";
      setDesktopEnvironments(environments);
      setLocalDeviceId(LOCAL_ONLY_DEVICE_ID);
      setSelectedExecutionDeviceId(LOCAL_ONLY_DEVICE_ID);
      setSelectedExecutionWorkspaceId(workspaceId);
    };
    if (!relayReady || !settings.remote.enabled || !settings.remote.gatewayUrl.trim()) {
      applyLocalOnly();
      return;
    }
    let cancelled = false;
    const refresh = () =>
      getDesktopEnvironments(settings)
        .then((result) => {
          if (cancelled || !result) return;
          setDesktopEnvironments(result.environments);
          setLocalDeviceId(result.localDeviceId);
          setSelectedExecutionDeviceId((current) => current || result.localDeviceId);
          const local = result.environments.find((item) => item.device_id === result.localDeviceId);
          setSelectedExecutionWorkspaceId((current) => current || local?.workspaces[0]?.id || "");
        })
        .catch((error) => {
          console.warn("load desktop execution environments failed", error);
          if (!cancelled) applyLocalOnly();
        });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    relayReady,
    settings.remote.enabled,
    settings.remote.gatewayUrl,
    settings.remote.grpcPort,
    settings.system.activeWorkspaceProjectId,
    settings.system.workspaceProjects,
  ]);

  useEffect(() => {
    if (!relayReady || !settings.remote.enabled || !settings.remote.gatewayUrl.trim()) return;
    let cancelled = false;
    void registerDesktopDevice(settings)
      .then(() => getDesktopEnvironments(settings))
      .then((result) => {
        if (cancelled || !result) return;
        setDesktopEnvironments(result.environments);
        setLocalDeviceId(result.localDeviceId);
        setSelectedExecutionDeviceId((current) => current || result.localDeviceId);
        const local = result.environments.find((item) => item.device_id === result.localDeviceId);
        setSelectedExecutionWorkspaceId((current) => current || local?.workspaces[0]?.id || "");
      })
      .catch((error) => {
        console.warn("refresh ZeroAgent device registration failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [
    relayReady,
    settings.remote.enabled,
    settings.remote.gatewayUrl,
    settings.remote.grpcPort,
    settings.system.workspaceProjects,
  ]);

  useEffect(() => {
    if (!remoteControllerURL) {
      setExecutionBusy(false);
      return;
    }
    const expectedOrigin = new URL(remoteControllerURL).origin;
    const handleMessage = (event: MessageEvent) => {
      if (
        event.origin !== expectedOrigin ||
        event.source !== remoteControllerRef.current?.contentWindow ||
        !event.data ||
        typeof event.data !== "object" ||
        event.data.type !== "zeroagent:execution-busy" ||
        typeof event.data.busy !== "boolean"
      ) {
        return;
      }
      setExecutionBusy(event.data.busy);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [remoteControllerURL]);

  const saveSequenceRef = useRef(0);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const defaultWorkdirRef = useRef("");
  // Mirrors `settings` so setSettings/queueSettingsSave can read the latest value
  // synchronously without passing a (side-effecting) function into setSettingsState —
  // React 18 StrictMode double-invokes functional state updaters in development,
  // which would otherwise run those side effects (and any non-idempotent work like
  // crypto.randomUUID() inside caller updaters) twice per call.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [systemThemeVersion, setSystemThemeVersion] = useState(0);
  const effectiveTheme = useMemo(
    () => resolveEffectiveTheme(settings.theme),
    [settings.theme, systemThemeVersion],
  );

  useEffect(() => {
    if (settings.theme !== "system") return;
    return subscribeToSystemThemePreference(() => {
      setSystemThemeVersion((version) => version + 1);
    });
  }, [settings.theme]);

  // 同步主题 class 到 <html> 根节点
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", effectiveTheme === "dark");
  }, [effectiveTheme]);

  useEffect(() => {
    if (!settingsReady) return;
    void invoke("app_set_close_window_behavior", {
      behavior: settings.closeWindowBehavior,
    }).catch(() => {
      // Ignore non-Tauri and older desktop shells.
    });
  }, [settingsReady, settings.closeWindowBehavior]);

  useEffect(() => {
    const handleSessionChanged = () => {
      setRelayReady(false);
      setRelayUser(null);
      setRelayStats(null);
      setSettingsOpen(false);
      setOverlay("closed");
    };
    window.addEventListener(RELAY_SESSION_CHANGED_EVENT, handleSessionChanged);
    return () => window.removeEventListener(RELAY_SESSION_CHANGED_EVENT, handleSessionChanged);
  }, []);

  const relayUserId = relayUser?.id;
  useEffect(() => {
    if (!relayReady || !relayUserId) return;
    let cancelled = false;
    void Promise.all([getRelayProfile(), getRelayDashboardStats()])
      .then(([profile, stats]) => {
        if (cancelled) return;
        setRelayUser(profile);
        setRelayStats(stats);
      })
      .catch(() => {
        // Account details remain available from the authenticated session response.
      });
    return () => {
      cancelled = true;
    };
  }, [relayReady, relayUserId]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateSettings() {
      try {
        const { settings: loaded, defaultWorkdir } = await loadPersistedSettingsWithDefaults();
        if (!cancelled) {
          defaultWorkdirRef.current = defaultWorkdir;
          const loadedWithDefaults = applyRuntimeSystemDefaults(loaded, defaultWorkdir);
          settingsRef.current = loadedWithDefaults;
          setSettingsState(loadedWithDefaults);
          setSettingsSaveState({ status: "saved" });
          void publishGatewaySettingsSync(loadedWithDefaults).catch((error) => {
            console.error("publish gateway settings sync failed", error);
          });
        }
      } catch (error) {
        if (!cancelled) {
          const fallback = getDefaultSettings();
          settingsRef.current = fallback;
          setSettingsState(fallback);
          setSettingsSaveState({
            status: "error",
            message: asErrorMessage(error, "加载设置失败，已回退到默认配置。"),
          });
        }
      } finally {
        if (!cancelled) {
          setSettingsReady(true);
        }
      }
    }

    void hydrateSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  const queueSettingsSave = useCallback(
    (prev: AppSettings, next: AppSettings, fallback: string, publishSync: boolean) => {
      const saveSequence = ++saveSequenceRef.current;
      setSettingsSaveState({ status: "saving" });

      saveChainRef.current = saveChainRef.current
        .catch(() => undefined)
        .then(() => persistSettings(prev, next))
        .then(async (persistResult) => {
          const publishTarget = persistResult.ssh
            ? normalizeSettings({
                ...next,
                ssh: persistResult.ssh,
              })
            : next;
          if (persistResult.ssh && saveSequenceRef.current === saveSequence) {
            const merged = normalizeSettings({
              ...settingsRef.current,
              ssh: persistResult.ssh,
            });
            settingsRef.current = merged;
            setSettingsState(merged);
          }
          if (persistResult.conflict) {
            throw new Error(persistResult.conflict);
          }
          if (publishSync) {
            await publishGatewaySettingsSync(publishTarget);
          }
        })
        .then(() => {
          if (saveSequenceRef.current === saveSequence) {
            setSettingsSaveState({ status: "saved" });
          }
        })
        .catch((error) => {
          if (saveSequenceRef.current === saveSequence) {
            setSettingsSaveState({
              status: "error",
              message: asErrorMessage(error, fallback),
            });
          }
        });
    },
    [],
  );

  const setSettings = useCallback(
    (updater: (prev: AppSettings) => AppSettings) => {
      const prev = settingsRef.current;
      const updated = updater(prev);
      if (updated === prev) return;
      const next = applyRuntimeSystemDefaults(
        normalizeSettings(updated),
        defaultWorkdirRef.current,
      );
      settingsRef.current = next;
      setSettingsState(next);
      queueSettingsSave(
        prev,
        next,
        "保存设置失败。",
        hasSettingsSyncChanged(prev, next) || hasSensitiveSettingsUpdates(next),
      );
    },
    [queueSettingsSave],
  );

  // Authoritative live read for tool write paths: settingsRef is updated
  // synchronously by setSettings, so read-modify-write sequences that stay in
  // one synchronous segment can never observe a stale snapshot.
  const getMcpSettings = useCallback(() => settingsRef.current.mcp, []);

  const reloadPersistedSettings = useCallback(async () => {
    await saveChainRef.current.catch(() => undefined);
    const { settings: loaded, defaultWorkdir } = await loadPersistedSettingsWithDefaults();
    defaultWorkdirRef.current = defaultWorkdir;
    const loadedWithDefaults = applyRuntimeSystemDefaults(loaded, defaultWorkdir);
    settingsRef.current = loadedWithDefaults;
    setSettingsState(loadedWithDefaults);
    setSettingsSaveState({ status: "saved" });
  }, []);

  const toggleTheme = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      theme: getNextTheme(prev.theme),
    }));
  }, [setSettings]);

  const openSettings = useCallback(
    (section: SectionId = "system") => {
      setSettingsSection(section);
      setSettingsOpen(true);
      setOverlay("entering");
      requestAnimationFrame(() => requestAnimationFrame(() => setOverlay("open")));
      void reloadPersistedSettings().catch((error) => {
        setSettingsSaveState({
          status: "error",
          message: asErrorMessage(error, "重新加载设置失败，当前显示的是旧配置。"),
        });
      });
    },
    [reloadPersistedSettings],
  );

  const closeSettings = useCallback(() => {
    setOverlay("leaving");
  }, []);

  const handleTransitionEnd = useCallback(() => {
    if (overlay === "leaving") {
      setSettingsOpen(false);
      setOverlay("closed");
    }
  }, [overlay]);

  // 构建 locale context value，避免每次渲染重新创建
  const localeContextValue = useMemo(
    () => ({
      locale: settings.locale,
      t: (key: string) => translate(key, settings.locale),
    }),
    [settings.locale],
  );

  const appUpdateMessages = useMemo(
    () => ({
      checkFailed: translate("settings.aboutUpdateCheckFailed", settings.locale),
      installFailed: translate("settings.aboutUpdateInstallFailed", settings.locale),
      restartFailed: translate("settings.aboutRestartFailed", settings.locale),
    }),
    [settings.locale],
  );

  const appUpdate = useAppUpdateController({
    enabled: settingsReady,
    includePrereleases: settings.updates.includePrereleases,
    messages: appUpdateMessages,
  });

  useEffect(() => {
    if (!settingsReady) return;
    void initAutomation().catch((error) => {
      console.warn("Failed to initialize automation store", error);
    });
  }, [settingsReady]);

  useEffect(() => {
    if (!settingsReady) {
      return;
    }

    let cancelled = false;
    const unlistenPromise = listen<GatewaySettingsSyncPayload>(
      GATEWAY_SETTINGS_SYNC_EVENT,
      (event) => {
        if (cancelled) {
          return;
        }

        const prev = settingsRef.current;
        const next = applyRuntimeSystemDefaults(
          applyGatewaySettingsSyncPayload(prev, event.payload),
          defaultWorkdirRef.current,
        );
        const publicChanged = hasSettingsSyncChanged(prev, next);
        if (!publicChanged && !hasSensitiveSettingsUpdatesPayload(event.payload)) {
          return;
        }
        settingsRef.current = next;
        setSettingsState(next);
        queueSettingsSave(prev, next, "同步 WebUI 设置失败。", publicChanged);
      },
    );

    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [queueSettingsSave, settingsReady]);

  if (!settingsReady) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <AppChrome>
          <div className="flex h-full w-full items-center justify-center bg-background text-sm text-muted-foreground">
            {translate("chat.loading", settings.locale)}
          </div>
        </AppChrome>
      </LocaleContext.Provider>
    );
  }

  if (!relayReady || !relayUser) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <AppChrome>
          <RelayAccessGate
            settings={settings}
            setSettings={setSettings}
            onReady={(user) => {
              setRelayUser(user);
              setRelayReady(true);
            }}
          />
        </AppChrome>
      </LocaleContext.Provider>
    );
  }

  const visible = settingsOpen;
  const active = overlay === "open";

  async function handleExecutionSwitch(
    environment: DesktopEnvironment,
    workspace: DesktopEnvironment["workspaces"][number],
    password: string,
  ) {
    const selection = await switchDesktopEnvironment(settings, environment, workspace, password);
    const isLocal = environment.device_id === localDeviceId;
    const controllerURL = isLocal
      ? ""
      : await createRemoteControllerURL(settings, selection.selection_lease, localDeviceId);
    if (isLocal) {
      setSettings((prev) => {
        const target = prev.system.workspaceProjects.find(
          (project) =>
            project.id === workspace.id || (workspace.path && project.path === workspace.path),
        );
        if (!target) return prev;
        return {
          ...prev,
          system: {
            ...prev.system,
            activeWorkspaceProjectId: target.id,
            hiddenWorkspaceProjectPaths: prev.system.hiddenWorkspaceProjectPaths.filter(
              (path) => path !== target.path,
            ),
            missingWorkspaceProjectPaths: prev.system.missingWorkspaceProjectPaths.filter(
              (path) => path !== target.path,
            ),
            archivedWorkspaceProjectPaths: prev.system.archivedWorkspaceProjectPaths.filter(
              (path) => path !== target.path,
            ),
          },
        };
      });
    }
    setContext(getDefaultContext());
    setLocalConversationEpoch((value) => value + 1);
    setSelectedExecutionDeviceId(environment.device_id);
    setSelectedExecutionWorkspaceId(workspace.id);
    setExecutionBusy(false);
    setRemoteControllerURL(controllerURL);
  }

  return (
    <LocaleContext.Provider value={localeContextValue}>
      <AppChrome>
        <CronPromptRunner settings={settings} />
        <MemoryOrganizerHost settings={settings} setSettings={setSettings} />
        <AppErrorBoundary>
          {remoteControllerURL ? (
            <iframe
              ref={remoteControllerRef}
              className="h-full w-full border-0 bg-background"
              src={remoteControllerURL}
              title="ZeroAgent remote execution"
            />
          ) : (
            <ChatPage
              key={localConversationEpoch}
              relayUser={relayUser}
              relayStats={relayStats}
              settings={settings}
              setSettings={setSettings}
              getMcpSettings={getMcpSettings}
              context={context}
              setContext={setContext}
              onOpenSettings={openSettings}
              onToggleTheme={toggleTheme}
              headerLeadingActions={
                desktopEnvironments.length > 0 && !settingsOpen ? (
                  <DesktopExecutionSwitcher
                    environments={desktopEnvironments}
                    localDeviceId={localDeviceId}
                    selectedDeviceId={selectedExecutionDeviceId}
                    selectedWorkspaceId={selectedExecutionWorkspaceId}
                    disabled={executionBusy}
                    onSwitch={handleExecutionSwitch}
                  />
                ) : null
              }
              onExecutionBusyChange={setExecutionBusy}
              appUpdate={appUpdate}
            />
          )}
        </AppErrorBoundary>
        {remoteControllerURL && desktopEnvironments.length > 0 && !settingsOpen && (
          <div className="absolute left-1/2 top-2 z-40 -translate-x-1/2">
            <DesktopExecutionSwitcher
              environments={desktopEnvironments}
              localDeviceId={localDeviceId}
              selectedDeviceId={selectedExecutionDeviceId}
              selectedWorkspaceId={selectedExecutionWorkspaceId}
              disabled={executionBusy}
              onSwitch={handleExecutionSwitch}
            />
          </div>
        )}
        {visible && (
          <div
            className={`absolute inset-0 z-50 transition-all duration-300 ease-out ${
              active ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
            }`}
            onTransitionEnd={handleTransitionEnd}
          >
            <AppErrorBoundary>
              <SettingsPage
                settings={settings}
                setSettings={setSettings}
                saveState={settingsSaveState}
                onBack={closeSettings}
                initialSection={settingsSection}
                appUpdate={appUpdate}
                relayUser={relayUser}
                relayStats={relayStats}
                onRelayUserChange={setRelayUser}
                onRelayStatsChange={setRelayStats}
              />
            </AppErrorBoundary>
          </div>
        )}
      </AppChrome>
    </LocaleContext.Provider>
  );
}
