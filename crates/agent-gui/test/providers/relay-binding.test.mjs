import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const relay = loader.loadModule("src/lib/relay/providers.ts");
const settingsModule = loader.loadModule("src/lib/settings/index.ts");

test("relay platform mapping and endpoints are fixed", () => {
  assert.equal(relay.relayProviderTypeForPlatform("anthropic"), "claude_code");
  assert.equal(relay.relayProviderTypeForPlatform("openai"), "codex");
  assert.equal(relay.relayProviderTypeForPlatform("grok"), "codex");
  assert.equal(relay.relayProviderTypeForPlatform("gemini"), "gemini");
  assert.equal(relay.relayProviderTypeForPlatform("antigravity"), "gemini");
  assert.equal(relay.relayProviderTypeForPlatform("unsupported"), null);
  assert.equal(relay.relayProviderBaseUrl("claude_code"), "https://usa0.top/v1");
  assert.equal(relay.relayProviderBaseUrl("codex"), "https://usa0.top");
  assert.equal(relay.relayProviderBaseUrl("gemini"), "https://usa0.top");
});

test("built-in provider defaults cannot point to third-party endpoints", () => {
  const providers = settingsModule.getBuiltinCustomProviders();
  assert.deepEqual(
    Array.from(providers, (provider) => provider.baseUrl),
    [
      "https://usa0.top/v1",
      "https://usa0.top",
      "https://usa0.top",
    ],
  );
});

test("binding relay keys removes third-party providers and selects an available model", async () => {
  const relayProvider = {
    id: "relay-key-42",
    name: "Old relay name",
    type: "codex",
    baseUrl: "https://changed.invalid",
    apiKey: "old-key",
    customHeaders: [],
    models: [{ id: "gpt-5.4", name: "GPT 5.4" }],
    activeModels: ["gpt-5.4"],
    requestFormat: "openai-responses",
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: true,
    useSystemProxy: false,
  };
  const arbitraryProvider = {
    ...relayProvider,
    id: "third-party",
    baseUrl: "https://third-party.invalid/v1",
  };
  const appSettings = {
    customProviders: [arbitraryProvider, relayProvider],
    selectedModel: { customProviderId: "third-party", model: "gpt-5.4" },
  };
  const group = {
    id: 7,
    name: "Codex group",
    platform: "openai",
    rate_multiplier: 1,
    status: "active",
  };
  const key = {
    id: 42,
    key: "sk-relay-key",
    name: "ZeroAgent",
    group_id: 7,
    status: "active",
    quota: 0,
    quota_used: 0,
    created_at: "2026-07-20T00:00:00Z",
    group,
  };

  const bound = await relay.bindRelayKeysToSettings(appSettings, [key], [group]);

  assert.equal(bound.customProviders.length, 1);
  assert.equal(bound.customProviders[0].id, "relay-key-42");
  assert.equal(bound.customProviders[0].baseUrl, "https://usa0.top");
  assert.equal(bound.customProviders[0].apiKey, "sk-relay-key");
  assert.equal(bound.customProviders[0].requestFormat, "openai-responses");
  assert.equal(bound.selectedModel.customProviderId, "relay-key-42");
  assert.equal(bound.selectedModel.model, "gpt-5.4");
});

test("runtime constraint rejects injected providers and restores relay URLs", () => {
  const constrained = relay.enforceRelayProviderConstraint({
    customProviders: [
      {
        id: "third-party",
        type: "codex",
        baseUrl: "https://third-party.invalid",
        activeModels: ["gpt-5.4"],
      },
      {
        id: "relay-key-9",
        type: "claude_code",
        baseUrl: "https://changed.invalid",
        activeModels: ["claude-opus-4-8"],
      },
    ],
    selectedModel: { customProviderId: "third-party", model: "gpt-5.4" },
  });

  assert.equal(constrained.customProviders.length, 1);
  assert.equal(constrained.customProviders[0].id, "relay-key-9");
  assert.equal(constrained.customProviders[0].baseUrl, "https://usa0.top/v1");
  assert.equal(constrained.selectedModel, undefined);
});
