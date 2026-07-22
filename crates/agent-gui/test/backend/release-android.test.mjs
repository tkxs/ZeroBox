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

test("Android uses the packaged Gateway WebUI wrapper", () => {
  const androidConfig = readRepoFile("crates/agent-gui/src-tauri/tauri.android.conf.json");
  const tauriLib = readRepoFile("crates/agent-gui/src-tauri/src/lib.rs");
  const mobileHtml = readRepoFile("crates/agent-gui/mobile.html");
  const mobileEntry = readRepoFile("crates/agent-gui/src/mobile.ts");
  const mobileStyles = readRepoFile("crates/agent-gui/src/mobile.css");
  const viteConfig = readRepoFile("crates/agent-gui/vite.config.ts");

  assert.match(androidConfig, /"url": "mobile\.html"/);
  assert.match(tauriLib, /#\[cfg\(mobile\)\][\s\S]*ZeroAgent mobile WebView/);
  assert.match(tauriLib, /#\[cfg\(desktop\)\]\s*pub fn run\(\)/);
  assert.match(mobileHtml, /Gateway 地址/);
  assert.match(mobileHtml, /id="code-flow"/);
  assert.match(mobileEntry, /window\.location\.assign\(gatewayUrl\)/);
  assert.match(mobileEntry, /function startCodeFlow/);
  assert.match(mobileEntry, /prefers-reduced-motion: reduce/);
  assert.match(mobileStyles, /\.mobile-background__code-flow/);
  assert.match(viteConfig, /mobile: fileURLToPath\(new URL\("\.\/mobile\.html"/);
  for (const filename of ["README.md", "README.zh-CN.md"]) {
    const readme = readRepoFile(filename);
    assert.match(readme, /Android-arm64\.apk/);
    assert.match(readme, /adb reverse tcp:3001 tcp:3001/);
    assert.match(readme, /127\.0\.0\.1:3001/);
  }
});

test("Android excludes desktop-only global shortcut commands", () => {
  const appCommands = readRepoFile(
    "crates/agent-gui/src-tauri/src/commands/app/app.rs",
  );

  assert.match(
    appCommands,
    /#\[cfg\(desktop\)\]\s*use tauri_plugin_global_shortcut/,
  );
  for (const command of [
    "app_window_pinned",
    "app_toggle_window_pin",
    "app_set_global_shortcuts",
  ]) {
    assert.match(
      appCommands,
      new RegExp(
        `#\\[tauri::command\\]\\s*#\\[cfg\\(desktop\\)\\]\\s*pub fn ${command}`,
      ),
    );
  }
});
