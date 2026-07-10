"use client";

import { useSearchParams } from "next/navigation";

export default function QueryEcho() {
  const searchParams = useSearchParams();
  return <p data-testid="query-echo">Search query: {searchParams.get("q") ?? "none"}</p>;
}
