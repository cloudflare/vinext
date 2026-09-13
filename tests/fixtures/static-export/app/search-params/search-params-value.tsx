"use client";

import { useSearchParams } from "next/navigation";

export function SearchParamsValue() {
  const searchParams = useSearchParams();
  return <p data-testid="query-value">{searchParams.get("value") ?? "missing"}</p>;
}
