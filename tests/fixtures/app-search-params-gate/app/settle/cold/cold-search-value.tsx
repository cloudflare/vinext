"use client";

import { useSearchParams } from "next/navigation";

// Only this route loads this module, so its first request loads it cold.
export function ColdSearchValue() {
  return <span data-testid="search-value">{useSearchParams().get("q") ?? "(none)"}</span>;
}
