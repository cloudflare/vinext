import { useSearchParams } from "next/navigation";
import { recordRenderEvent } from "./render-events";

// No "use client": only the lazy loader imports this, so nothing preloads it.
recordRenderEvent("module-evaluated");

export function LateModuleSearchValue() {
  return <span data-testid="search-value">{useSearchParams().get("q") ?? "(none)"}</span>;
}
