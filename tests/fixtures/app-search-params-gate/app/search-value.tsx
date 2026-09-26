"use client";

import { useSearchParams } from "next/navigation";

export function SearchValue() {
  return <span data-testid="search-value">{useSearchParams().get("q") ?? "(none)"}</span>;
}
