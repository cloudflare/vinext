"use client";

import { use } from "react";

const neverResolves = new Promise<never>(() => {});

// Records every marker it renders, so the spec can tell when React has started
// rendering an HMR update that has not committed yet. With suspend set, that
// render stays suspended until something replaces it.
export function HmrSuspenseScrollRenderProbe({
  marker,
  suspend,
}: {
  marker: string;
  suspend: boolean;
}) {
  if (typeof window !== "undefined") {
    const probe = window as Window & { __hmrSuspenseScrollRenders?: string[] };
    (probe.__hmrSuspenseScrollRenders ??= []).push(marker);
    if (suspend) use(neverResolves);
  }
  return <p data-testid="hmr-suspense-scroll-marker">{marker}</p>;
}
