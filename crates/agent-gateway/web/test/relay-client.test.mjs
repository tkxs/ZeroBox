import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

test("multi-group key creation is sequential and preserves group names", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map([["zerobox.relay.access-token", "relay-token"]]);
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const requests = [];

  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  globalThis.fetch = async (url, init) => {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    const body = JSON.parse(init.body);
    requests.push({ body, url: String(url) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeRequests -= 1;
    return new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: {
          id: body.group_id,
          key: `sk-${body.group_id}`,
          name: body.name,
          group_id: body.group_id,
          status: "active",
          quota: 0,
          quota_used: 0,
          created_at: "2026-07-20T00:00:00Z",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const loader = createTsModuleLoader({
      rootDir: fileURLToPath(new URL("..", import.meta.url)),
      mocks: {
        "@/lib/storage": { loadToken: () => "gateway-token" },
      },
    });
    const relay = loader.loadModule("src/lib/relay/client.ts");
    const groups = [
      { id: 1, name: "Claude 组", platform: "anthropic", rate_multiplier: 1, status: "active" },
      { id: 2, name: "Codex 组", platform: "openai", rate_multiplier: 1, status: "active" },
    ];

    const created = await relay.createRelayApiKeys("ZeroBox", [1, 2], groups);

    assert.equal(maximumActiveRequests, 1);
    assert.deepEqual(
      requests.map((request) => request.body),
      [
        { name: "ZeroBox / Claude 组", group_id: 1 },
        { name: "ZeroBox / Codex 组", group_id: 2 },
      ],
    );
    assert.deepEqual(
      Array.from(created, (key) => key.key),
      ["sk-1", "sk-2"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  }
});

test("account APIs use the Gateway relay proxy with authenticated payloads", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map([["zerobox.relay.access-token", "relay-token"]]);
  const requests = [];

  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      method: init.method,
      headers: init.headers,
      credentials: init.credentials,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: String(url).endsWith("/usage/dashboard/stats")
          ? { today_tokens: 12345 }
          : { id: 7, email: "new@example.com", username: "Zero", balance: 9.5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const loader = createTsModuleLoader({
      rootDir: fileURLToPath(new URL("..", import.meta.url)),
      mocks: {
        "@/lib/storage": { loadToken: () => "gateway-token" },
      },
    });
    const relay = loader.loadModule("src/lib/relay/client.ts");

    await relay.getRelayProfile();
    const stats = await relay.getRelayDashboardStats();
    await relay.updateRelayProfile({ username: "Zero" });
    await relay.sendRelayEmailBindingCode(" new@example.com ");
    await relay.bindRelayEmail(" new@example.com ", " 123456 ", "secret" );
    await relay.changeRelayPassword("old-secret", "new-secret");

    assert.equal(stats.today_tokens, 12345);
    assert.deepEqual(
      requests.map(({ url, method, body }) => ({ url, method, body })),
      [
        { url: "/api/usa-zero/user/profile", method: "GET", body: undefined },
        { url: "/api/usa-zero/usage/dashboard/stats", method: "GET", body: undefined },
        { url: "/api/usa-zero/user", method: "PUT", body: { username: "Zero" } },
        { url: "/api/usa-zero/user/account-bindings/email/send-code", method: "POST", body: { email: "new@example.com" } },
        { url: "/api/usa-zero/user/account-bindings/email", method: "POST", body: { email: "new@example.com", verify_code: "123456", password: "secret" } },
        { url: "/api/usa-zero/user/password", method: "PUT", body: { old_password: "old-secret", new_password: "new-secret" } },
      ],
    );
    for (const request of requests) {
      assert.equal(request.headers.Authorization, undefined);
      assert.equal(request.headers["X-USA-Zero-Authorization"], undefined);
      assert.equal(request.credentials, "include");
    }
    assert.equal(relay.formatRelayBalance(9.5), "$9.50");
    assert.equal(relay.formatRelayBalance(undefined), "--");
    assert.notEqual(relay.formatRelayTokenCount(12345), "--");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  }
});

test("provider model refresh uses the Gateway session and key ID without exposing the key", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ models: { data: [{ id: "gpt-5.2" }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const loader = createTsModuleLoader({
      rootDir: fileURLToPath(new URL("..", import.meta.url)),
      mocks: {
        "@/lib/storage": { loadToken: () => "" },
      },
    });
    const relay = loader.loadModule("src/lib/relay/client.ts");
    const models = await relay.getRelayProviderModels(41);

    assert.deepEqual(models, { data: [{ id: "gpt-5.2" }] });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/web-chat/provider-keys/41/models");
    assert.equal(requests[0].init.method, "GET");
    assert.equal(requests[0].init.credentials, "include");
    assert.equal(requests[0].init.headers.Authorization, undefined);
    assert.equal(requests[0].init.body, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
