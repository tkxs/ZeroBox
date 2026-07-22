import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  rootDir: fileURLToPath(new URL("..", import.meta.url)),
});
const targets = loader.loadModule("src/lib/executionTargets.ts");

const environments = [
  {
    runtime_kind: "web_chat",
    name: "Web chat",
    online: true,
    workspaces: [{ id: "cloud", name: "Cloud" }],
    capabilities: ["chat"],
  },
  {
    runtime_kind: "device_agent",
    device_id: "device-a",
    name: "Office PC",
    online: true,
    workspaces: [
      { id: "workspace-a", name: "Alpha", path: "C:\\code\\alpha" },
      { id: "workspace-b", name: "Beta", path: "C:\\code\\beta" },
    ],
    capabilities: ["agent", "terminal"],
  },
];

test("execution target resolution matches both device and workspace", () => {
  const selection = {
    selection_lease: "lease-1",
    runtime_kind: "device_agent",
    device_id: "device-a",
    workspace_id: "workspace-b",
    target_fingerprint: "device_agent:device-a:workspace-b",
    conversation_id: "conversation-1",
    expires_at: "",
  };

  const resolved = targets.resolveExecutionTarget(environments, selection);
  assert.equal(resolved.environment.name, "Office PC");
  assert.deepEqual(resolved.workspace, {
    id: "workspace-b",
    name: "Beta",
    path: "C:\\code\\beta",
  });
});

test("selection credentials preserve the remote workspace binding", () => {
  const selection = {
    selection_lease: "lease-2",
    runtime_kind: "device_agent",
    device_id: "device-a",
    workspace_id: "workspace-a",
    target_fingerprint: "device_agent:device-a:workspace-a",
    conversation_id: "conversation-2",
    expires_at: "",
  };

  const credential = targets.encodeSelectionCredential(selection);
  assert.deepEqual(targets.decodeSelectionCredential(credential), {
    lease: "lease-2",
    runtimeKind: "device_agent",
    deviceId: "device-a",
    workspaceId: "workspace-a",
  });
});
