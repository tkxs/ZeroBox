import "./mobile.css";

const GATEWAY_URL_STORAGE_KEY = "zerobox.mobile.gatewayUrl";

const form = document.querySelector<HTMLFormElement>("#gateway-form");
const input = document.querySelector<HTMLInputElement>("#gateway-url");
const status = document.querySelector<HTMLElement>("#gateway-status");
const submit = document.querySelector<HTMLButtonElement>("#gateway-submit");
const codeFlow = document.querySelector<HTMLCanvasElement>("#code-flow");

if (!form || !input || !status || !submit) {
  throw new Error("ZeroBox mobile shell failed to initialize");
}

type CodeStream = {
  x: number;
  y: number;
  direction: 1 | -1;
  repeatWidth: number;
  speed: number;
  alpha: number;
  size: number;
  text: string;
};

const CODE_SNIPPETS = [
  "POST /v1/chat/completions",
  "model: auto:reasoning",
  "route.policy = latency-first",
  "provider.openai -> ready",
  "provider.claude -> warm",
  "provider.gemini -> vision",
  "normalize(messages)",
  "meter(tokens.input)",
  "fallback.on_error = true",
  "stream: true",
  "key.scope = project",
  "usage.rolling_24h += 1",
];

function startCodeFlow(canvas: HTMLCanvasElement | null) {
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return () => undefined;

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const darkMode = window.matchMedia?.("(prefers-color-scheme: dark)");
  let streams: CodeStream[] = [];
  let frame = 0;
  let lastFrameTime = 0;

  const color = (alpha: number) =>
    darkMode?.matches ? `rgba(122, 162, 255, ${alpha})` : `rgba(37, 99, 235, ${alpha})`;

  const render = (deltaSeconds = 0) => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    context.clearRect(0, 0, width, height);
    context.textBaseline = "top";

    for (const stream of streams) {
      if (stream.y < -36 || stream.y > height + 24) continue;
      context.font = `${stream.size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      const rowFade = Math.min(
        1,
        Math.max(0, stream.y / 120),
        Math.max(0, (height - stream.y) / 140),
      );
      const copies = Math.ceil(width / stream.repeatWidth) + 3;
      for (let copy = -1; copy < copies; copy += 1) {
        const x = stream.x + copy * stream.repeatWidth;
        context.fillStyle = color(stream.alpha * rowFade);
        context.fillText(stream.text, x, stream.y);
        context.fillStyle = color(stream.alpha * rowFade * 0.48);
        context.fillText(
          "{ normalized: true, billable: tokens }",
          x + stream.repeatWidth * 0.42,
          stream.y,
        );
      }
      if (!reducedMotion) stream.x += stream.speed * deltaSeconds * stream.direction;
      if (stream.direction === 1 && stream.x > stream.repeatWidth) {
        stream.x -= stream.repeatWidth;
      }
      if (stream.direction === -1 && stream.x < -stream.repeatWidth) {
        stream.x += stream.repeatWidth;
      }
    }
  };

  const draw = (time: number) => {
    const deltaSeconds = lastFrameTime ? Math.min((time - lastFrameTime) / 1000, 0.05) : 0;
    lastFrameTime = time;
    render(deltaSeconds);
    if (!reducedMotion) frame = window.requestAnimationFrame(draw);
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const rowGap = 28;
    const count = Math.max(22, Math.ceil(rect.height / rowGap) + 8);
    streams = Array.from({ length: count }, (_, index) => {
      const direction: 1 | -1 = index % 2 === 0 ? 1 : -1;
      const size = 10.5;
      const text = CODE_SNIPPETS[index % CODE_SNIPPETS.length];
      const repeatWidth = Math.max(260, text.length * size * 0.68 + 90);
      return {
        x:
          direction === 1
            ? -repeatWidth + Math.random() * repeatWidth
            : Math.random() * repeatWidth,
        y: -rowGap * 2 + index * rowGap + Math.random() * 8,
        direction,
        repeatWidth,
        speed: 11 + Math.random() * 25,
        alpha: 0.08 + Math.random() * 0.17,
        size,
        text,
      };
    });
    render(0);
  };

  const resizeObserver = new ResizeObserver(resize);
  const handleThemeChange = () => render(0);
  resizeObserver.observe(canvas);
  darkMode?.addEventListener("change", handleThemeChange);
  resize();
  if (!reducedMotion) frame = window.requestAnimationFrame(draw);

  return () => {
    window.cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    darkMode?.removeEventListener("change", handleThemeChange);
  };
}

const stopCodeFlow = startCodeFlow(codeFlow);
window.addEventListener("pagehide", stopCodeFlow, { once: true });

function normalizeGatewayUrl(rawValue: string): string {
  let value = rawValue.trim();
  if (!value) {
    throw new Error("请输入 Gateway 地址");
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Gateway 地址格式不正确");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) {
    throw new Error("Gateway 地址必须使用 HTTP 或 HTTPS");
  }

  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

try {
  input.value = localStorage.getItem(GATEWAY_URL_STORAGE_KEY) ?? "";
} catch {
  // Storage may be unavailable in a hardened WebView; the form still works.
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  status.textContent = "";

  try {
    const gatewayUrl = normalizeGatewayUrl(input.value);
    input.value = gatewayUrl;
    try {
      localStorage.setItem(GATEWAY_URL_STORAGE_KEY, gatewayUrl);
    } catch {
      // Navigation is still valid when persistence is unavailable.
    }
    submit.disabled = true;
    submit.textContent = "正在打开...";
    window.location.assign(gatewayUrl);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "无法打开 Gateway";
    input.focus();
  }
});

window.addEventListener("pageshow", () => {
  submit.disabled = false;
  submit.textContent = "打开 WebUI";
});
