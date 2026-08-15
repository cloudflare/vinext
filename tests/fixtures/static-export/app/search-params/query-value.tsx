"use client";

import { useSearchParams } from "next/navigation";

export function QueryValue() {
  const searchParams = useSearchParams();

  return <p data-testid="query-value">{searchParams.get("value") ?? "missing"}</p>;
}
