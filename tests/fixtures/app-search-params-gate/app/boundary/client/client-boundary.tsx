"use client";

import { Suspense } from "react";
import { SearchFallback } from "../../fixture-parts";
import { SearchValue } from "../../search-value";

export function ClientBoundary() {
  return (
    <Suspense fallback={<SearchFallback />}>
      <SearchValue />
    </Suspense>
  );
}
