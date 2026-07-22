import { useEffect, useRef } from "react";

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

export function CodeFlowBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let streams: CodeStream[] = [];
    let frame = 0;
    let lastFrameTime = 0;
    let dark = document.documentElement.classList.contains("dark");

    const color = (alpha: number) =>
      dark ? `rgba(122, 162, 255, ${alpha})` : `rgba(37, 99, 235, ${alpha})`;

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
      const rowGap = rect.width < 640 ? 28 : 32;
      const count = Math.max(22, Math.ceil(rect.height / rowGap) + 8);
      streams = Array.from({ length: count }, (_, index) => {
        const direction: 1 | -1 = index % 2 === 0 ? 1 : -1;
        const size = rect.width < 640 ? 10.5 : 12 + Math.random() * 2;
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
    const themeObserver = new MutationObserver(() => {
      dark = document.documentElement.classList.contains("dark");
      render(0);
    });
    resizeObserver.observe(canvas);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    resize();
    if (!reducedMotion) frame = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--border) / 0.72) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border) / 0.72) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "linear-gradient(to bottom, transparent, black 10%, black 80%, transparent)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent, black 10%, black 80%, transparent)",
        }}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full opacity-[0.66] mix-blend-multiply dark:opacity-50 dark:mix-blend-screen"
        style={{
          maskImage:
            "linear-gradient(to bottom, transparent 1%, black 9%, black 86%, transparent 98%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 1%, black 9%, black 86%, transparent 98%)",
        }}
      />
    </div>
  );
}
