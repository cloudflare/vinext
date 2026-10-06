"use client";

import { lazy } from "react";
import { recordRenderEvent } from "../../render-events";

const Lazy = lazy(async () => {
  const mod = await import("../../search-value");
  recordRenderEvent("lazy-resolved");
  return { default: mod.SearchValue };
});

export function LazySearchValue() {
  return <Lazy hookReadEvent="lazy-hook-read" />;
}
