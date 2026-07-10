"use client";

import { useSearchParams } from "next/navigation";

export default function DynamicErrorQueryEcho() {
  const searchParams = useSearchParams();
  return (
    <p data-testid="dynamic-error-query-echo">
      Dynamic-error query: {searchParams.get("q") ?? "none"}
    </p>
  );
}
