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
  const launcherBackground = readRepoFile(
    "crates/agent-gui/src-tauri/icons/android/values/ic_launcher_background.xml",
  );

  assert.match(workflow, /java-version: "17"/);
  assert.match(workflow, /targets: aarch64-linux-android/);
  assert.match(workflow, /tauri android build --apk --target aarch64 --ci/);
  assert.match(workflow, /ANDROID_KEYSTORE_BASE64/);
  assert.match(workflow, /apksigner" sign/);
  assert.match(workflow, /apksigner" verify --verbose --print-certs/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /Install ZeroAgent Android launcher icons/);
  assert.match(workflow, /src-tauri\/icons\/android/);
  assert.match(workflow, /cp -R "\$source_dir"\/\. "\$target_dir"\//);
  assert.match(workflow, /cmp "\$source_dir\/mipmap-\$\{density\}\/\$\{icon\}\.png"/);
  assert.doesNotMatch(workflow, /usesCleartextTraffic/);
  assert.match(workflow, /ZEROAGENT_ANDROID_WEB_URL: \$\{\{ vars\.ZEROAGENT_ANDROID_WEB_URL \}\}/);
  assert.match(launcherBackground, /@android:color\/transparent/);
  assert.match(workflow, /networkTimeout=120000/);
  assert.match(workflow, /\.\/gradlew --version --no-daemon/);
  assert.match(workflow, /for attempt in 1 2 3/);
  assert.match(
    cargoToml,
    /target\.'cfg\(not\(any\(target_os = "android", target_os = "ios"\)\)\)'\.dependencies/,
  );
});

test("Android loads the ZeroAgent WebUI instead of the USA-Zero account site", () => {
  const androidConfig = readRepoFile("crates/agent-gui/src-tauri/tauri.android.conf.json");
  const tauriLib = readRepoFile("crates/agent-gui/src-tauri/src/lib.rs");
  const mobileHtml = readRepoFile("crates/agent-gui/mobile.html");
  const mobileEntry = readRepoFile("crates/agent-gui/src/mobile.ts");
  const viteConfig = readRepoFile("crates/agent-gui/vite.config.ts");

  assert.match(androidConfig, /"url": "mobile\.html"/);
  assert.doesNotMatch(androidConfig, /usa0\.top/);
  assert.match(tauriLib, /#\[cfg\(mobile\)\][\s\S]*ZeroAgent mobile WebView/);
  assert.match(tauriLib, /#\[cfg\(desktop\)\]\s*pub fn run\(\)/);
  assert.match(mobileHtml, /ZeroAgent WebUI URL/);
  assert.match(mobileEntry, /__ZEROAGENT_ANDROID_WEB_URL__/);
  assert.match(mobileEntry, /window\.location\.replace/);
  assert.doesNotMatch(mobileEntry, /usa0\.top/);
  assert.match(viteConfig, /ZEROAGENT_ANDROID_WEB_URL/);
  assert.match(viteConfig, /mobile: fileURLToPath\(new URL\("\.\/mobile\.html"/);
  for (const filename of ["README.md", "README.zh-CN.md"]) {
    const readme = readRepoFile(filename);
    assert.match(readme, /Android-arm64\.apk/);
    assert.match(readme, /ZEROAGENT_ANDROID_WEB_URL/);
    assert.doesNotMatch(readme, /https:\/\/usa0\.top\/login/);
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
