<p align="center">
  <img src="docs/images/zeroagent-logo.png" alt="ZeroAgent" width="160" />
</p>

<h1 align="center">ZeroAgent</h1>

<p align="center">
  <strong>USA-零专属、本地优先的 AI Agent</strong><br/>
  账户登录 · 模型管理 · 本地工具 · 桌面端、WebUI 与 Android
</p>

<p align="center">
  <a href="https://usa0.top"><strong>官方网站：usa0.top</strong></a>
  &nbsp;·&nbsp;
  <a href="README.md">English</a>
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Android-2563EB" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-B7410E?logo=rust" />
  <img alt="Go" src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-16A34A" />
</p>

## 项目简介

ZeroAgent 是面向 [USA-零](https://usa0.top) 的本地 AI Agent 客户端。项目由桌面运行时、浏览器 WebUI 和 Android 网页客户端组成；文件访问、终端命令、Git 操作等本机能力始终由用户电脑上的桌面端执行。

USA-零负责账户认证、分组、托管密钥与模型服务；ZeroAgent 负责 Agent 工作区、工具执行、对话管理、远程控制和 Gateway 部署能力。

## 核心能力

- 通过 USA-零分组使用 Claude、Codex 和 Gemini 协议
- 本地文件读取、编辑、搜索、Shell 命令和长驻进程管理
- 集成终端、SSH、SFTP、Git 工作流和项目工具
- 支持 MCP、Skills、子代理、记忆与定时自动化
- 支持对话历史、分支、检查点、压缩与分享
- 通过 ZeroAgent Gateway 进行浏览器聊天和远程设备控制
- 浏览器与 Android 共用同一套 WebUI 聊天功能
- 支持简体中文和英文界面

## 产品组成

| 组件 | 运行位置 | 用途 |
|---|---|---|
| 桌面端 | macOS、Windows、Linux | 完整的本地 Agent 运行时和工具执行能力 |
| Gateway + WebUI | 服务器 | 账户会话、网页聊天、WebSocket 中继、历史记录和远程设备访问 |
| Android 客户端 | Android arm64 | 打开已部署的 ZeroAgent WebUI，提供与浏览器一致的聊天体验 |
| USA-零 | [usa0.top](https://usa0.top) | 账户、分组、密钥和模型服务 |

## 系统架构

```text
浏览器 / Android
       │ HTTPS
       ▼
ZeroAgent Gateway + 内嵌 WebUI
       ├── PostgreSQL
       ├── Redis
       ├── USA-零 API（usa0.top）
       └── WebSocket ── ZeroAgent 桌面端 ── 本地工具与工作区
```

生产 Docker 镜像会先构建 React WebUI，再将静态资源嵌入 Go Gateway 二进制文件，因此 WebUI 不需要单独部署成静态网站。

## 下载

桌面安装包和 Android APK 可从 [GitHub Releases](https://github.com/tkxs/ZeroAgent/releases/latest) 下载。

| 平台 | 安装包 |
|---|---|
| macOS | `.dmg` |
| Windows | `.msi` 或安装版 `.exe` |
| Linux | `.AppImage`、`.deb` 或 `.rpm` |
| Android arm64 | `ZeroAgent-<版本>-Android-arm64.apk` |

仅在桌面端本地使用 Agent 时无需部署 Gateway。浏览器 WebUI、Android 聊天、账户设备发现和远程执行需要部署 Gateway。

## 部署 Gateway 与 WebUI

将仓库根目录的 `Dockerfile` 部署到 Railway 或其他 Docker 平台。一个容器会同时提供 WebUI、HTTP API、健康检查和全部 WebSocket 链路。

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

生产环境需要：

- 一个指向 Gateway 的公网 HTTPS 域名
- PostgreSQL，用于账户、设备、工作区元数据和对话历史
- Redis，用于 Web 会话、设备在线状态和短时认证状态
- `USA_ZERO_ORIGIN=https://usa0.top`
- HTTPS 在容器外终止时设置 `LIVEAGENT_GATEWAY_COOKIE_SECURE=true`

部署完成后访问 `https://你的域名/healthz` 检查服务，再直接打开该域名使用 WebUI。Railway、反向代理和发布说明见 [部署文档](docs/operations/deployment.md)。

## Android

Android 客户端加载的就是浏览器使用的同一个 Gateway WebUI。发布 Android 版本前，需要配置以下 GitHub Repository Variable：

```text
ZEROAGENT_ANDROID_WEB_URL=https://你的域名
```

未配置时，App 首次启动会要求填写 Gateway WebUI 地址。推送 `v*` 版本标签后，`.github/workflows/android-release.yml` 会自动构建并上传 Android APK。

## 本地开发

环境要求：

- Node.js 22 和 pnpm
- Rust stable
- Go 1.25
- Protobuf compiler
- 对应系统的 Tauri 开发依赖

常用命令：

```bash
make dev                 # 启动桌面端开发环境
make dev-gateway         # 启动 Gateway 开发服务
make dev-webui           # 启动 WebUI 开发服务
make gateway-docker-smoke
make proto
```

主要目录：

```text
crates/agent-gui/          桌面端与 Android Tauri 应用
crates/agent-gateway/      Go Gateway 服务
crates/agent-gateway/web/  嵌入 Gateway 的 React WebUI
docs/                      架构、功能与部署文档
```

贡献代码前请阅读 [开发指南](docs/operations/development.md)。

## 官方服务

USA-零官方网站：[https://usa0.top](https://usa0.top)

可在官网管理 ZeroAgent 使用的账户、分组、密钥和模型服务。

## 开源许可

本项目采用 MIT License，详见 [LICENSE](LICENSE)。
