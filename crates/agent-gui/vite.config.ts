import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };

// @ts-expect-error process is a nodejs global
const env = process.env as Record<string, string | undefined>;
const appVersion = env.LIVEAGENT_APP_VERSION?.trim() || packageJson.version || "0.0.0";
const usaZeroOrigin = env.VITE_USA_ZERO_ORIGIN?.trim() || "https://usa0.top";
const androidWebUrl = env.ZEROAGENT_ANDROID_WEB_URL?.trim() || "";
const host = env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" })],
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@bufbuild/protobuf",
      "@earendil-works/pi-ai",
      "@sinclair/typebox",
    ],
    alias: {
      "@bufbuild/protobuf/codegenv2": fileURLToPath(
        new URL("./node_modules/@bufbuild/protobuf/dist/esm/codegenv2/index.js", import.meta.url),
      ),
      "@bufbuild/protobuf": fileURLToPath(
        new URL("./node_modules/@bufbuild/protobuf/dist/esm/index.js", import.meta.url),
      ),
      "@sinclair/typebox": fileURLToPath(
        new URL("./node_modules/@sinclair/typebox/build/esm/index.mjs", import.meta.url),
      ),
      "@": fileURLToPath(new URL("../agent-gateway/web/src", import.meta.url)),
    },
  },
  define: {
    __LIVEAGENT_APP_VERSION__: JSON.stringify(appVersion),
    __ZEROAGENT_USA_ZERO_ORIGIN__: JSON.stringify(usaZeroOrigin),
    __ZEROAGENT_ANDROID_WEB_URL__: JSON.stringify(androidWebUrl),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        mobile: fileURLToPath(new URL("./mobile.html", import.meta.url)),
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 2120,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 2121,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
