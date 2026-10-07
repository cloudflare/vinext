"use client";

import { useSearchParams } from "next/navigation";

export function SearchValue() {
  const searchParams = useSearchParams();
  return <code data-testid="search-value">{searchParams.get("q") ?? "(none)"}</code>;
}
