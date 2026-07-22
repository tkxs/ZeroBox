import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  child.kill("SIGTERM");
}

function runCargoTest(signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cargo",
      [
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--",
        "--test-threads=4",
      ],
      {
        cwd: guiRoot,
        env: {
          ...process.env,
          CARGO_TERM_COLOR: "never",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const onAbort = () => {
      terminateProcessTree(child);
      reject(signal.reason ?? new Error("cargo test aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}

test("Tauri backend cargo test suite passes", { timeout: 600_000 }, async (context) => {
  const result = await runCargoTest(context.signal);
  assert.equal(
    result.code,
    0,
    [
      "cargo test --manifest-path src-tauri/Cargo.toml failed",
      "--- stdout ---",
      result.stdout.slice(-6000),
      "--- stderr ---",
      result.stderr.slice(-6000),
    ].join("\n"),
  );
});
