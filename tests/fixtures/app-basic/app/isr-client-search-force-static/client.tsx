"use client";

import { useSearchParams } from "next/navigation";

export default function ForceStaticQueryEcho() {
  const searchParams = useSearchParams();
  return (
    <p data-testid="force-static-query-echo">
      Force-static query: {searchParams.get("q") ?? "none"}
    </p>
  );
}
