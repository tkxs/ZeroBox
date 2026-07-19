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
