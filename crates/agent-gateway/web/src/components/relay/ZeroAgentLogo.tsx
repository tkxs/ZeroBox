import type { ImgHTMLAttributes } from "react";

export function ZeroAgentLogo(props: ImgHTMLAttributes<HTMLImageElement>) {
  return <img src="/zeroagent-logo.png" alt="ZeroAgent" draggable={false} {...props} />;
}
