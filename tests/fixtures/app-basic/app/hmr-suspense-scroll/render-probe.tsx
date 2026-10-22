"use client";

import { use } from "react";

const delays = new Map<string, Promise<void>>();

// Records every marker it renders, so the spec can tell when React has started
// rendering an HMR update that has not committed yet. A positive suspendMs
// keeps that render suspended on the client for a fixed time.
export function HmrSuspenseScrollRenderProbe({
  marker,
  suspendMs,
}: {
  marker: string;
  suspendMs: number;
}) {
  if (typeof window !== "undefined") {
    const probe = window as Window & { __hmrSuspenseScrollRenders?: string[] };
    (probe.__hmrSuspenseScrollRenders ??= []).push(marker);
    if (suspendMs > 0) {
      let delay = delays.get(marker);
      if (!delay) {
        delay = new Promise((resolve) => setTimeout(resolve, suspendMs));
        delays.set(marker, delay);
      }
      use(delay);
    }
  }
  return <p data-testid="hmr-suspense-scroll-marker">{marker}</p>;
}
