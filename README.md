<p align="center">
  <img src="docs/images/zeroagent-logo.png" alt="ZeroAgent" width="160" />
</p>

<h1 align="center">ZeroAgent</h1>

<p align="center">
  <strong>A local-first AI agent for USA-Zero</strong><br/>
  Account login · Managed models · Local tools · Desktop, WebUI, and Android
</p>

<p align="center">
  <a href="https://usa0.top"><strong>Official Website: usa0.top</strong></a>
  &nbsp;·&nbsp;
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Android-2563EB" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-B7410E?logo=rust" />
  <img alt="Go" src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-16A34A" />
</p>

## About

ZeroAgent is the local AI agent client for [USA-Zero](https://usa0.top). It combines a native desktop runtime with a browser WebUI and Android wrapper, while keeping file access, terminal commands, Git operations, and other machine-level tools on the user's own computer.

USA-Zero provides account authentication, groups, managed API keys, and model access. ZeroAgent provides the agent workspace, tool execution, conversation management, remote control, and deployment stack.

## Core Features

- Claude, Codex, and Gemini protocol support through USA-Zero groups
- Local file reading, editing, search, shell commands, and managed processes
- Integrated terminal, SSH, SFTP, Git workflow, and project tools
- MCP servers, reusable Skills, subagents, memory, and scheduled automations
- Conversation history, branching, checkpoints, compaction, and sharing
- Remote browser chat and device control through the ZeroAgent Gateway
- One WebUI shared by browsers and the Android app
- English and Simplified Chinese interfaces

## Applications

| Component | Runs on | Purpose |
|---|---|---|
| Desktop app | macOS, Windows, Linux | Full local agent runtime and tool execution |
| Gateway + WebUI | Server | Account sessions, browser chat, WebSocket relay, history, and remote device access |
| Android app | Android arm64 | Opens the deployed ZeroAgent WebUI with the same browser chat experience |
| USA-Zero | [usa0.top](https://usa0.top) | Account, group, key, and model service |

## Architecture

```text
Browser / Android
        │ HTTPS
        ▼
ZeroAgent Gateway + embedded WebUI
        ├── PostgreSQL
        ├── Redis
        ├── USA-Zero API (usa0.top)
        └── WebSocket ── ZeroAgent desktop app ── local tools and workspace
```

The production Docker image builds the React WebUI and embeds it into the Go Gateway binary. The WebUI does not need a separate static-site deployment.

## Download

Download desktop installers and Android packages from [GitHub Releases](https://github.com/tkxs/ZeroAgent/releases/latest).

| Platform | Package |
|---|---|
| macOS | `.dmg` |
| Windows | `.msi` or Setup `.exe` |
| Linux | `.AppImage`, `.deb`, or `.rpm` |
| Android arm64 | `ZeroAgent-<version>-Android-arm64.apk` |

The desktop app can run locally without a Gateway. A Gateway deployment is required for browser WebUI access, Android chat, account-based device discovery, and remote execution.

## Deploy Gateway And WebUI

Deploy the root `Dockerfile` to Railway or another Docker platform. One container serves the WebUI, HTTP API, health check, and all WebSocket traffic.

```bash
docker pull ghcr.io/tkxs/zeroagent-gateway:latest

docker run -d \
  --name zeroagent-gateway \
  --restart unless-stopped \
  -p 3000:8080 \
  -e USA_ZERO_ORIGIN=https://usa0.top \
  -e DATABASE_URL=postgresql://user:password@host:5432/zeroagent \
  -e REDIS_URL=redis://host:6379/0 \
  ghcr.io/tkxs/zeroagent-gateway:latest
```

Production requirements:

- A public HTTPS domain for the Gateway
- PostgreSQL for accounts, devices, workspace metadata, and conversation history
- Redis for Web sessions, presence, and short-lived authentication state
- `USA_ZERO_ORIGIN=https://usa0.top`
- `LIVEAGENT_GATEWAY_COOKIE_SECURE=true` when HTTPS terminates before the container

After deployment, verify `https://your-domain.example/healthz`, then open the domain directly to use the WebUI. See [Deployment Operations](docs/operations/deployment.md) for Railway, reverse proxy, and release details.

## Android

The Android app loads the same deployed Gateway WebUI as the browser. Before publishing an Android release, configure this GitHub Repository Variable:

```text
ZEROAGENT_ANDROID_WEB_URL=https://your-domain.example
```

If the variable is omitted, the app asks for the Gateway WebUI URL on first launch. The Android package is built and uploaded by `.github/workflows/android-release.yml` whenever a `v*` release tag is pushed.

## Development

Requirements:

- Node.js 22 and pnpm
- Rust stable
- Go 1.25
- Protobuf compiler
- Platform-specific Tauri prerequisites

Common commands:

```bash
make dev                 # Desktop development
make dev-gateway         # Gateway development server
make dev-webui           # WebUI development server
make gateway-docker-smoke
make proto
```

Main directories:

```text
crates/agent-gui/          Desktop and Android Tauri application
crates/agent-gateway/      Go Gateway service
crates/agent-gateway/web/  React WebUI embedded into the Gateway
docs/                      Architecture, feature, and deployment documentation
```

For contribution setup and validation commands, see the [Development Guide](docs/operations/development.md).

## Official Service

USA-Zero official website: [https://usa0.top](https://usa0.top)

Use the official website to manage your account, groups, keys, and model services used by ZeroAgent.

## License

MIT License. See [LICENSE](LICENSE).
