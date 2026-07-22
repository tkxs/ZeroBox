import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(guiRoot, "../..");

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("release and Gateway documentation use the ZeroAgent repository and image", () => {
  const workflow = readRepoFile(".github/workflows/gateway-docker.yml");
  const readmes = [readRepoFile("README.md"), readRepoFile("README.zh-CN.md")];

  assert.match(workflow, /IMAGE_NAME: ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/zeroagent-gateway/);
  for (const readme of readmes) {
    assert.match(readme, /https:\/\/github\.com\/tkxs\/ZeroAgent\/releases\/latest/);
    assert.match(readme, /ghcr\.io\/tkxs\/zeroagent-gateway:latest/);
    assert.doesNotMatch(readme, /Stack-Cairn|stack-cairn|LiveAgent-Updater/);
  }
});
