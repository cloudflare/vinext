"use client";

import { useSearchParams } from "next/navigation";
import { recordRenderEvent } from "./render-events";

// `hookReadEvent` is recorded right before the hook, so a test can tell that
// the render reached it.
export function SearchValue({ hookReadEvent }: { hookReadEvent?: string }) {
  if (hookReadEvent) recordRenderEvent(hookReadEvent);
  return <span data-testid="search-value">{useSearchParams().get("q") ?? "(none)"}</span>;
}
