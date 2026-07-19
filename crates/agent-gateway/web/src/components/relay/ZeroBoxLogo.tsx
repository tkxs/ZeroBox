import type { ImgHTMLAttributes } from "react";

export function ZeroBoxLogo(props: ImgHTMLAttributes<HTMLImageElement>) {
  return <img src="/zerobox-logo.png" alt="ZeroBox" draggable={false} {...props} />;
}
