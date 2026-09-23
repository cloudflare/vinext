"use client";

import { useSearchParams } from "next/navigation";

export default function ClientQuery() {
  return (
    <output data-testid="query-force-static-client-value">
      {useSearchParams().get("q") || "(empty)"}
    </output>
  );
}
