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

test("Android workflow builds a signed arm64 APK and can publish it", () => {
  const workflow = readRepoFile(".github/workflows/android-release.yml");
  const cargoToml = readRepoFile("crates/agent-gui/src-tauri/Cargo.toml");

  assert.match(workflow, /java-version: "17"/);
  assert.match(workflow, /targets: aarch64-linux-android/);
  assert.match(workflow, /tauri android build --apk --target aarch64 --ci/);
  assert.match(workflow, /ANDROID_KEYSTORE_BASE64/);
  assert.match(workflow, /apksigner" sign/);
  assert.match(workflow, /apksigner" verify --verbose --print-certs/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /import xml\.etree\.ElementTree as ET/);
  assert.match(workflow, /application\.set\(f"\{\{\{android_namespace\}\}\}usesCleartextTraffic", "true"\)/);
  assert.doesNotMatch(workflow, /sed -i .*usesCleartextTraffic/);
  assert.match(workflow, /networkTimeout=120000/);
  assert.match(workflow, /\.\/gradlew --version --no-daemon/);
  assert.match(workflow, /for attempt in 1 2 3/);
  assert.match(
    cargoToml,
    /target\.'cfg\(not\(any\(target_os = "android", target_os = "ios"\)\)\)'\.dependencies/,
  );
});

test("Android install instructions preserve the fixed USA-Zero endpoint", () => {
  for (const filename of ["README.md", "README.zh-CN.md"]) {
    const readme = readRepoFile(filename);
    assert.match(readme, /Android-arm64\.apk/);
    assert.match(readme, /adb reverse tcp:8080 tcp:8080/);
    assert.match(readme, /127\.0\.0\.1:8080/);
  }
});
