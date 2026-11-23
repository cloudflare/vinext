import type { ReactNode } from "react";

export function SiteFrame({ children }: { children: ReactNode }) {
  return <div data-marker="marker-site-frame">{children}</div>;
}
