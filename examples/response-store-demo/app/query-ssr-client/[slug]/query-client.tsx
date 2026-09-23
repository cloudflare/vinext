"use client";

import { useSearchParams } from "next/navigation";

export default function QuerySsrClient() {
  return <output data-testid="query-ssr-client-value">{useSearchParams().get("q") || "(empty)"}</output>;
}
