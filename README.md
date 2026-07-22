<p align="center">
  <img src="docs/images/zeroagent-logo.png" alt="ZeroAgent" width="180" />
</p>

<h1 align="center">ZeroAgent</h1>

<p align="center">
  <strong>The local AI agent terminal for USA-Zero</strong><br/>
  Account login · Managed keys · Local tools · Desktop and WebUI
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blueviolet" />
  <img alt="Tauri" src="https://img.shields.io/badge/built%20with-Tauri%202-FFC131?logo=tauri&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-B7410E?logo=rust&logoColor=white" />
  <img alt="Go" src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green" />
</p>

<p align="center">
  <a href="#core-features">Core Features</a> •
  <a href="#download--deployment">Download & Deployment</a> •
  <a href="#faq">FAQ</a> •
  <a href="docs/">Docs</a>
</p>

---

## 🌟 Special Thanks

<p align="center">
  <a href="https://linux.do">
    <img src="docs/images/linuxdo.png" alt="LINUX DO" width="420" />
  </a>
</p>
<p align="center"><b>For all things AI, head to LINUX DO! Wishing the community ever greater success~</b></p>

---

## ❤️ Sponsor

<table>
<tr>
<td width="200" align="center" valign="middle"><a href="https://www.packyapi.com/register"><img src="docs/images/partners/packycode.png" alt="PackyCode" width="160"></a></td>
<td valign="middle">PackyCode is a reliable, efficient, and professional API relay service provider, offering relay services for Claude Code, Codex, Gemini, Chinese domestic models, and more — a long-established, top-tier relay. <b>The vast majority of the model resources used to develop this software were provided by PackyCode — thank you, Laonong!</b> Register <a href="https://www.packyapi.com/register">here</a> to get started!</td>
</tr>
<tr>
<td width="200" align="center" valign="middle"><a href="https://www.right.codes/register"><img src="docs/images/partners/rightcode.jpg" alt="RightCode" width="160"></a></td>
<td valign="middle">Right Code provides stable relay services for Claude Code, Codex, Gemini, Chinese domestic models, and more. Invoices are available upon top-up, and enterprise and team users receive dedicated one-on-one support. <b>The remaining model resources used to develop this software were provided by RightCode — thanks to the RC site owner and the support team!</b> Register <a href="https://www.right.codes/register">here</a> to get started!</td>
</tr>
<tr>
<td width="200" align="center" valign="middle"><a href="https://cubence.com/signup"><img src="docs/images/partners/cubence.png" alt="Cubence" width="160"></a></td>
<td valign="middle">Cubence is a reliable and efficient API relay service provider, offering relay services for Claude Code, Codex, Gemini, and more, with pay-as-you-go billing. <b>Thanks to Cubence for supporting this project!</b> Register <a href="https://cubence.com/signup">here</a> to get started!</td>
</tr>
</table>


---

## 🤝 Come Build With Us!

<p align="center">
  <img src="docs/images/QQ.png" alt="ZeroAgent QQ Group" width="300" />
</p>

<p align="center">
  Scan the QR code to join our QQ group and help drive ZeroAgent development!<br/>
  (Why a QQ group? It just packs a few more features than a WeChat group~)
</p>


---

## Why ZeroAgent?

ZeroAgent is a local-first AI agent client dedicated to **USA-Zero**. Accounts, groups, and API keys are managed by USA-Zero; arbitrary third-party provider URLs are intentionally rejected.

- Runtime-configurable USA-Zero backend (desktop login screen or `VITE_USA_ZERO_ORIGIN`; Gateway `USA_ZERO_ORIGIN`)
- Groups and models sync after login; users without a key are guided through multi-group creation
- Keys stay masked and require password verification before copying

- **An agent that actually gets things done** — beyond chat: read and write files, make precise edits, run Bash, and supervise long-running processes
- **A fully open ecosystem** — bridge any external tool via the MCP protocol, and load Skills packages on demand
- **Local and remote, both** — the desktop app works fully standalone; deploy the Gateway and control it from any browser

---

## Core Features

![](docs/images/product.webp)

### 🧠 Multi-Model & Chat

- **Multi-model routing** — Claude, Codex, and Gemini protocols through USA-Zero groups with fixed service endpoints
- **Rich rendering** — streaming Markdown with built-in KaTeX math, Mermaid diagrams, and Monaco code preview
- **History compaction** — dual-layer Segment + Summary Checkpoint persistence keeps long conversations from losing context
- **Internationalization** — built-in i18n multi-language framework

### 🔧 Local Tool Execution

- **Full file-system capabilities** — precise `Read` / `Write` / `Edit` / `Delete`, plus `Glob` / `Grep` pattern and regex search
- **Bash & long-running processes** — non-interactive command execution (cwd / timeout), with `ManagedProcess` supervising dev servers and other resident tasks
- **Sub-agent delegation** — independent sub-agents execute in parallel with worktree isolation and automatic merging
- **Tunnel exposure** — `TunnelManager` exposes local services to the public internet in one click

### 🧩 MCP & Skills Ecosystem

- **MCP protocol bridging** — the Tauri side natively bridges any stdio / http MCP server for unlimited tool extension
- **Skills packages** — progressive disclosure and on-demand loading, with install / create / package support and the ClawHub ecosystem

### 💾 Memory & Automation

- **Persistent memory** — Markdown + SQLite FTS full-text search for cross-session knowledge management
- **Scheduled tasks** — bash / http / prompt cron job types, executed automatically in the background

### 🌐 Remote Gateway

- **Access from any browser** — Go gateway (WebSocket + Protobuf) with a WebUI for remotely controlling the local agent
- **Disconnect recovery** — a bounded seq window replays short outages, with desktop-side persistence as the safety net

---

## Download & Deployment

Installers are automatically built and published by GitHub Actions — grab the latest version from [**GitHub Releases**](https://github.com/tkxs/ZeroAgent/releases/latest).

### System Requirements

| Platform | Requirements |
|---|---|
| macOS | Both Intel (x64) and Apple Silicon (aarch64) architectures |
| Windows | x64; requires the WebView2 runtime (bundled with Windows 11) |
| Linux | x86_64; requires WebKitGTK 4.1 (Ubuntu 22.04+ / Debian 12+, etc.) |

### macOS

Download the DMG matching your chip from [Releases](https://github.com/tkxs/ZeroAgent/releases/latest), open it, and drag ZeroAgent into Applications:

- Apple Silicon (M-series): `ZeroAgent-<version>-macOS-aarch64.dmg`
- Intel: `ZeroAgent-<version>-macOS-x64.dmg`

> The installer is signed and notarized by Apple — no manual security override is needed on first launch.

### Windows

Pick an installation method from [Releases](https://github.com/tkxs/ZeroAgent/releases/latest):

| Method | File | Best for |
|---|---|---|
| Setup wizard | `ZeroAgent-<version>-Windows-x64-Setup.exe` | Most users |
| MSI package | `ZeroAgent-<version>-Windows-x64.msi` | Enterprise distribution / silent install |
| Portable | `ZeroAgent-<version>-Windows-x64-portable.zip` | No install — unzip and run |

### Linux

Choose by distribution from [Releases](https://github.com/tkxs/ZeroAgent/releases/latest):

| Format | Distributions | Install |
|---|---|---|
| AppImage | Any distribution | `chmod +x`, then run directly |
| DEB | Debian / Ubuntu family | `sudo dpkg -i ZeroAgent-<version>-Linux-x86_64.deb` |
| RPM | Fedora / openSUSE family | `sudo rpm -i ZeroAgent-<version>-Linux-x86_64.rpm` |

### Android (arm64)

Download `ZeroAgent-<version>-Android-arm64.apk` from [Releases](https://github.com/tkxs/ZeroAgent/releases/latest) and allow installation from your browser or file manager when Android prompts for permission.

The Android app opens the hosted ZeroAgent account sign-in at `https://usa0.top/login`. Sign in with your account email and password; the app no longer asks for a Gateway address.

### Need Remote Access? Deploy the Gateway

The desktop app connects directly to the USA-Zero address configured on its login screen. Deploy the Gateway when you want browser cloud chat or browser/desktop control of another registered device.

**Note: when deployed behind an Nginx reverse proxy, set the Gateway address on the Settings → Remote page to the HTTPS URL and use port 443.**

```bash
# Pull the image (built by GitHub Actions, multi-arch: amd64 / arm64)
docker pull ghcr.io/tkxs/zeroagent-gateway:latest

# Run in the background (HTTP/WebSocket → host 3000)
docker run -d \
  --name zeroagent-gateway \
  --restart unless-stopped \
  -p 3000:8080 \
  -e LIVEAGENT_GATEWAY_OPERATOR_TOKEN=your-operator-token \
  -e USA_ZERO_ORIGIN=https://usa0.top \
  ghcr.io/tkxs/zeroagent-gateway:latest
```

**One-command upgrade to the latest version** — pull the new image → remove the old container → recreate it with the same arguments (if you changed the port mappings or token, adjust the arguments below accordingly):

```bash
docker pull ghcr.io/tkxs/zeroagent-gateway:latest \
  && docker rm -f zeroagent-gateway \
  && docker run -d \
    --name zeroagent-gateway \
    --restart unless-stopped \
    -p 3000:8080 \
    -e LIVEAGENT_GATEWAY_OPERATOR_TOKEN=your-operator-token \
    -e USA_ZERO_ORIGIN=https://usa0.top \
    ghcr.io/tkxs/zeroagent-gateway:latest \
  && docker image prune -f
```

<details>
<summary><b>Nginx reverse proxy configuration</b> — reference for custom domains / TLS</summary>

> Since protocol v2, all traffic — the WebUI, the HTTP API, and the WebSocket links of both the browser and the desktop app — goes through the single HTTP port (default 3000).
>
> WebSocket upgrades happen on several paths (`/ws/v2`, `/ws/v2/agent`, `/ws/v2/terminal`, and tunnels under `/t/`), so the simplest correct setup enables the upgrade on the whole vhost:

```nginx
# WebUI SPA/static/API + every WebSocket link (browser and desktop)
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    # WebSocket upgrade
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Required: the Gateway's same-origin check compares the browser's
    # Origin header against X-Forwarded-Proto + Host
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # The Gateway pings every WebSocket connection every 15s,
    # so a generous-but-finite timeout is enough
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
}
```

> The upstream port maps to the host port from the `docker run` above: HTTP/WebSocket 3000 (inside the container, HTTP actually listens on `PORT=8080`). The server block needs `listen 443 ssl;` and a `client_max_body_size` large enough for attachment uploads (e.g. `100m`).

</details>





### Build from Source

Prerequisites: Node.js 22, pnpm 10, Rust stable, Go 1.25, and `protoc`. The default USA-Zero backend is `https://usa0.top`; use the login screen or environment variables to override it for local development.

```powershell
cd crates/agent-gui
pnpm install
pnpm tauri dev
```

Tauri loads the desktop development page from `http://localhost:2120`. Run Gateway with `PORT=3001` and `USA_ZERO_ORIGIN=https://usa0.top`, then open ZeroAgent WebUI at `http://127.0.0.1:3001`. Browser account requests use Gateway's BFF and HttpOnly session cookie.

Expand the Development Guide below for the full set of Make commands.

![](docs/images/architecture.webp)

<details>
<summary><b>Architecture Overview</b> — diagram & tech stack</summary>

```
┌──────────────────────────────────────────────────────────────┐
│                        Browser WebUI                          │
│              React + Vite + WebSocket + Gateway API           │
└────────────────────────────┬─────────────────────────────────┘
                             │ WebSocket / HTTP
┌────────────────────────────▼─────────────────────────────────┐
│                       Agent Gateway                           │
│    Go · WebSocket · HTTP · Session Manager · Event Store     │
│               (Railway / Docker / self-hosted)                │
└────────────────────────────┬─────────────────────────────────┘
                             │ WebSocket v2 (bidirectional stream)
┌────────────────────────────▼─────────────────────────────────┐
│                        Agent GUI                              │
│                   Tauri 2 · React 19 · Rust                  │
├──────────┬────────────┬───────────┬────────────┬─────────────┤
│ Models   │ Runtime    │ Tools     │ Skills     │ Memory/Cron │
│ pi-ai    │ multi-turn │ FS/Bash/  │ progressive│ SQLite+MD   │
│ + Codex  │ + SubAgent │ MCP bridge│ + Hub      │ FTS index   │
└──────────┴────────────┴───────────┴────────────┴─────────────┘
```

**Tech Stack**

| Component | Technology |
|---|---|
| **Agent GUI** · Framework | Tauri 2 + React 19 + TypeScript 6 |
| **Agent GUI** · Build | Vite 8 + pnpm |
| **Agent GUI** · Styling | Tailwind CSS 4 + Radix UI |
| **Agent GUI** · Rendering | streamdown + KaTeX + Mermaid + Monaco Editor |
| **Agent GUI** · Backend | Rust + Tokio + SQLite (rusqlite) + WebSocket (tokio-tungstenite) |
| **Agent GUI** · LLM | @earendil-works/pi-ai · @openai/codex-sdk · claude-agent-sdk |
| **Gateway** · Language | Go 1.25 |
| **Gateway** · Protocols | WebSocket + Protobuf + HTTP |
| **Gateway** · Web UI | React + Vite + Tailwind CSS (embedded) |
| **Gateway** · Deployment | Docker multi-stage · Railway CI/CD |

</details>

<details>
<summary><b>Development Guide</b> — common Make commands (run <code>make help</code> for the full list)</summary>

| Command | Description |
|---|---|
| `make dev` | Start the Tauri development environment |
| `make build` | Build the desktop app |
| `make dev-gateway` | Start the Gateway dev server |
| `make dev-webui` | Start the WebUI dev server |
| `make gateway-build` | Build the Gateway binary |
| `make gateway-docker-build` | Build the Docker image |
| `make gateway-docker-smoke` | Build + health check |
| `make desktop-build-macos-release` | macOS signed release build |
| `make build-linux` | Linux amd64 gateway |
| `make build-linux-arm` | Linux arm64 gateway |
| `make proto` | Regenerate Protobuf code |
| `make clean` | Clean build artifacts |

</details>

<details>
<summary><b>Project Structure</b> — directory tree</summary>

```
ZeroAgent/
├── crates/
│   ├── agent-gui/                # Desktop client
│   │   ├── src/                  # React frontend
│   │   │   ├── components/       #   UI components
│   │   │   ├── lib/              #   Core logic (chat, tools, skills, memory)
│   │   │   ├── pages/            #   Pages (Chat, Settings)
│   │   │   ├── i18n/             #   Internationalization
│   │   │   └── prompt/           #   System prompt templates
│   │   └── src-tauri/            # Rust backend (Tauri)
│   │
│   └── agent-gateway/            # Go gateway service
│       ├── cmd/gateway/          #   Entry point
│       ├── internal/             #   Core implementation
│       ├── proto/v1/             #   Protobuf definitions
│       └── web/                  #   Embedded WebUI
│
├── docs/                         # Project docs
│   ├── architecture/             #   Architecture design
│   ├── features/                 #   Feature guides
│   └── operations/               #   Operations & deployment
│
├── scripts/release/              # Release automation
├── .github/workflows/            # CI/CD (CI + Desktop Release + Gateway Docker)
├── Dockerfile                    # Gateway container image
├── Makefile                      # Build commands
└── Cargo.toml                    # Rust workspace
```

</details>

---

## FAQ

<details>
<summary><b>Does my API key ever leave my machine?</b></summary>

Provider keys are synced back to the desktop through the existing settings channel, while browser persistence is redacted. Gateway exposes only an authenticated proxy to its configured USA-Zero origin and does not accept a user-supplied upstream per request.

</details>

<details>
<summary><b>Do I have to deploy the Gateway?</b></summary>

Desktop-only local Agent use does not require Gateway. Gateway is required for WebUI cloud chat, account-based device discovery, and remote execution; both surfaces can use a deployed USA-Zero service.

</details>

<details>
<summary><b>Which models are supported?</b></summary>

Claude, Codex, and Gemini protocols are supported through active USA-Zero groups. Third-party Base URLs are not accepted.

</details>

<details>
<summary><b>Will long conversations / disconnects lose context?</b></summary>

No. The desktop app persists the full history with Segment + Summary Checkpoints; the Gateway replays short disconnects through a bounded seq window and converges automatically after reconnecting.

</details>

---

## Contributing

Issues and pull requests are welcome! See the [Development Guide](docs/operations/development.md) for setting up a dev environment.

Before submitting a PR, make sure all of the following checks pass (they match the CI gates):

**Desktop client · `crates/agent-gui`**

1. Type check & build pass: `pnpm build`
2. Lint passes: `pnpm lint`
3. Frontend unit tests pass: `pnpm test:frontend` (also run `pnpm test:release` when touching release scripts)
4. Rust backend check passes: `cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests` (run from the repo root)

**Gateway · `crates/agent-gateway` (if changed)**

1. Go unit tests pass: `go test ./...`
2. WebUI build / lint / tests pass: `pnpm build && pnpm lint && pnpm test` (run in `web/`)
3. Regenerate and commit artifacts after proto changes: `make proto`

**Cross-frontend consistency**

- Mirrored files between GUI and WebUI must be byte-identical: `node scripts/check-mirror.mjs`
- Keep the diff clean (no trailing whitespace): `git diff --check`

---

## 👥 Contributors

Thanks to everyone who has contributed to ZeroAgent!

<a href="https://github.com/tkxs/ZeroAgent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=tkxs/ZeroAgent" alt="Contributors" />
</a>

---

## Star History

<a href="https://www.star-history.com/?repos=tkxs%2FZeroAgent&type=date&legend=top-left">

 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="docs/images/star-history-dark.svg" />
   <source media="(prefers-color-scheme: light)" srcset="docs/images/star-history-light.svg" />
   <img alt="Star History Chart" src="docs/images/star-history-light.svg" />
 </picture>
</a>

---

## License

MIT © StackCairn
