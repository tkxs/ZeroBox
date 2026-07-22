import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const state = loader.loadModule("src/lib/relay/remoteDeviceState.ts");

test("remote device project state is isolated by device", () => {
  assert.equal(state.remoteProjectStorageKey("device-a"), "zerobox.remote-project:device-a");
  assert.notEqual(
    state.remoteProjectStorageKey("device-a"),
    state.remoteProjectStorageKey("device-b"),
  );
});

test("remote conversation state is isolated by device and project", () => {
  const plainA = state.remoteConversationStorageKey("device-a", null);
  const plainB = state.remoteConversationStorageKey("device-b", null);
  const projectA = state.remoteConversationStorageKey("device-a", "project-a");
  const projectB = state.remoteConversationStorageKey("device-a", "project-b");

  assert.equal(plainA, "zerobox.remote-conversation:device-a:plain-chat");
  assert.notEqual(plainA, plainB);
  assert.notEqual(plainA, projectA);
  assert.notEqual(projectA, projectB);
});
