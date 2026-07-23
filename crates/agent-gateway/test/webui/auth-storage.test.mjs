import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const storage = loader.loadModule("src/lib/storage.ts");

function installWindow(overrides = {}) {
  const store = new Map();
  globalThis.window = {
    location: { origin: "https://gateway.example" },
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
    },
    ...overrides,
  };
  return store;
}

test("execution credential remains ephemeral and clears the legacy token", () => {
  const store = installWindow();
  store.set("liveagent.gateway.token", "legacy-token");

  storage.setEphemeralCredential("selection-credential");
  assert.equal(storage.loadToken(), "selection-credential");
  assert.equal(store.has("liveagent.gateway.token"), false);

  storage.setEphemeralCredential("");
  assert.equal(storage.loadToken(), "");
  storage.setEphemeralCredential(null);
  assert.equal(storage.loadToken(), "");
});
