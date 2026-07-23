import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { GATEWAY_WEBUI_MARKER } from "./lib/runtimeEnv";
import "./index.css";
import "katex/dist/katex.min.css";
import "react-complex-tree/lib/style-modern.css";
import "streamdown/styles.css";
import "./styles.css";

// 渲染前写入 WebUI 运行时标记（isGatewayWebuiRuntime 的唯一权威写入点）。
document.documentElement.dataset.liveagentWebui = GATEWAY_WEBUI_MARKER;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
