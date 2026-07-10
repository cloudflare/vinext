"use client";

import { useSearchParams } from "next/navigation";

export default function UnboundedDynamicErrorQuery() {
  const searchParams = useSearchParams();
  return <p data-testid="unbounded-query">Unbounded query: {searchParams.get("q") ?? "none"}</p>;
}
