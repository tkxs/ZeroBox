import { fetchModelsFromApi } from "../../pages/settings/providerUtils";
import type { AppSettings, CustomProvider, ProviderId, ProviderModelConfig } from "../settings";
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

function buildRelayProvider(
  key: RelayApiKey,
  group: RelayGroup,
  existing?: CustomProvider,
  fetchedModels?: ProviderModelConfig[],
): CustomProvider | null {
  const type = relayProviderTypeForPlatform(group.platform);
  if (!type) return null;
  const models = fetchedModels ?? existing?.models ?? [];
  const activeModels = models.map((model) => model.id);

  return {
    id: relayProviderId(key.id),
    name: `${group.name} / ${key.name}`,
    type,
    baseUrl: relayProviderBaseUrl(type),
    apiKey: key.key,
    apiKeyConfigured: Boolean(key.key.trim()),
    customHeaders: [],
    models,
    activeModels,
    requestFormat: type === "codex" ? "openai-responses" : undefined,
    reasoning: existing?.reasoning ?? "high",
    promptCachingEnabled: type === "claude_code",
    nativeWebSearchEnabled: true,
    useSystemProxy: false,
  };
}

function resolveKeyGroup(key: RelayApiKey, groups: RelayGroup[]) {
  return key.group ?? groups.find((group) => group.id === key.group_id);
}

export function enforceRelayProviderConstraint(settings: AppSettings): AppSettings {
  const customProviders = settings.customProviders.filter(isRelayProvider).map((provider) => ({
    ...provider,
    baseUrl: relayProviderBaseUrl(provider.type),
  }));
  const selectedModel = settings.selectedModel;
  const selectedProvider = selectedModel
    ? customProviders.find((provider) => provider.id === selectedModel.customProviderId)
    : undefined;

  return {
    ...settings,
    customProviders,
    selectedModel:
      selectedModel && selectedProvider?.activeModels.includes(selectedModel.model)
        ? selectedModel
        : undefined,
  };
}

export async function buildRelayProviders(
  existingProviders: CustomProvider[],
  keys: RelayApiKey[],
  groups: RelayGroup[],
  forceModelRefresh = false,
) {
  const existingById = new Map(existingProviders.map((provider) => [provider.id, provider]));
  const activeKeys = keys.filter(
    (key) => key.status === "active" && key.group_id != null && key.key.trim().length > 0,
  );

  const providers = await Promise.all(
    activeKeys.map(async (key) => {
      const group = resolveKeyGroup(key, groups);
      if (!group || group.status !== "active") return null;
      const type = relayProviderTypeForPlatform(group.platform);
      if (!type) return null;
      const existing = existingById.get(relayProviderId(key.id));
      let models: ProviderModelConfig[] | undefined;
      if (forceModelRefresh || !existing?.models.length) {
        try {
          models = await fetchModelsFromApi(type, relayProviderBaseUrl(type), key.key);
        } catch {
          models = existing?.models ?? [];
        }
      }
      return buildRelayProvider(key, group, existing, models);
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
  const currentSelected = settings.selectedModel;
  const selectedStillAvailable = currentSelected
    ? customProviders.some(
        (provider) =>
          provider.id === currentSelected.customProviderId &&
          provider.activeModels.includes(currentSelected.model),
      )
    : false;
  const firstProvider = customProviders.find((provider) => provider.activeModels.length > 0);
  const selectedModel = selectedStillAvailable
    ? currentSelected
    : firstProvider
      ? { customProviderId: firstProvider.id, model: firstProvider.activeModels[0] }
      : undefined;

  return {
    ...settings,
    customProviders,
    selectedModel,
  };
}
