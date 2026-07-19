import type { AppSettings, CustomProvider, ProviderId, ProviderModelConfig } from "@/lib/settings";
import { fetchModelsFromApi } from "@/pages/settings/providerUtils";
import { RELAY_ORIGIN, type RelayApiKey, type RelayGroup } from "./client";

const RELAY_PROVIDER_PREFIX = "relay-key-";

export function relayProviderTypeForPlatform(platform: string): ProviderId | null {
  switch (platform.trim().toLowerCase()) {
    case "anthropic":
      return "claude_code";
    case "openai":
    case "grok":
      return "codex";
    case "gemini":
    case "antigravity":
      return "gemini";
    default:
      return null;
  }
}

export function relayProviderBaseUrl(type: ProviderId) {
  return type === "claude_code" ? `${RELAY_ORIGIN}/v1` : RELAY_ORIGIN;
}

export function relayProviderId(keyId: number) {
  return `${RELAY_PROVIDER_PREFIX}${keyId}`;
}

export function isRelayProvider(provider: Pick<CustomProvider, "id">) {
  return provider.id.startsWith(RELAY_PROVIDER_PREFIX);
}

function resolveKeyGroup(key: RelayApiKey, groups: RelayGroup[]) {
  return key.group ?? groups.find((group) => group.id === key.group_id);
}

export function enforceRelayProviderConstraint(settings: AppSettings): AppSettings {
  const customProviders = settings.customProviders.filter(isRelayProvider).map((provider) => ({
    ...provider,
    baseUrl: relayProviderBaseUrl(provider.type),
  }));
  const selected = settings.selectedModel;
  const selectedProvider = selected
    ? customProviders.find((provider) => provider.id === selected.customProviderId)
    : undefined;
  return {
    ...settings,
    customProviders,
    selectedModel:
      selected && selectedProvider?.activeModels.includes(selected.model) ? selected : undefined,
  };
}

export async function buildRelayProviders(
  existingProviders: CustomProvider[],
  keys: RelayApiKey[],
  groups: RelayGroup[],
  forceModelRefresh = false,
) {
  const existingById = new Map(existingProviders.map((provider) => [provider.id, provider]));
  const providers = await Promise.all(
    keys
      .filter((key) => key.status === "active" && key.group_id != null && key.key.trim())
      .map(async (key): Promise<CustomProvider | null> => {
        const group = resolveKeyGroup(key, groups);
        if (!group || group.status !== "active") return null;
        const type = relayProviderTypeForPlatform(group.platform);
        if (!type) return null;
        const existing = existingById.get(relayProviderId(key.id));
        let models: ProviderModelConfig[] = existing?.models ?? [];
        if (forceModelRefresh || models.length === 0) {
          try {
            models = await fetchModelsFromApi(type, relayProviderBaseUrl(type), key.key);
          } catch {
            models = existing?.models ?? [];
          }
        }
        return {
          id: relayProviderId(key.id),
          name: `${group.name} / ${key.name}`,
          type,
          baseUrl: relayProviderBaseUrl(type),
          apiKey: key.key,
          apiKeyConfigured: Boolean(key.key.trim()),
          customHeaders: [],
          models,
          activeModels: models.map((model) => model.id),
          requestFormat: type === "codex" ? "openai-responses" : undefined,
          reasoning: existing?.reasoning ?? "high",
          promptCachingEnabled: type === "claude_code",
          nativeWebSearchEnabled: true,
          useSystemProxy: false,
        };
      }),
  );
  return providers.filter((provider): provider is CustomProvider => provider !== null);
}

export async function bindRelayKeysToSettings(
  settings: AppSettings,
  keys: RelayApiKey[],
  groups: RelayGroup[],
  forceModelRefresh = false,
): Promise<AppSettings> {
  const customProviders = await buildRelayProviders(
    settings.customProviders,
    keys,
    groups,
    forceModelRefresh,
  );
  const current = settings.selectedModel;
  const currentAvailable = current
    ? customProviders.some(
        (provider) =>
          provider.id === current.customProviderId && provider.activeModels.includes(current.model),
      )
    : false;
  const first = customProviders.find((provider) => provider.activeModels.length > 0);
  return {
    ...settings,
    customProviders,
    selectedModel: currentAvailable
      ? current
      : first
        ? { customProviderId: first.id, model: first.activeModels[0] }
        : undefined,
  };
}
