"use client";

import { lazy } from "react";
import { recordRenderEvent } from "../../render-events";

// Rendered before the boundary, so it marks when SSR has started rendering.
export function RenderStarted() {
  recordRenderEvent("render-started");
  return null;
}

// SSR preloads every client reference before it renders, so a lazy import of
// one is already loaded. This loader only starts once SSR renders it, waits,
// then imports a module that isn't a client reference, so the module loads
// for the first time well after rendering started.
const Late = lazy(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const mod = await import("./late-module");
  recordRenderEvent("module-resolved");
  return { default: mod.LateModuleSearchValue };
});

export function LateSearchValue() {
  return <Late />;
}
