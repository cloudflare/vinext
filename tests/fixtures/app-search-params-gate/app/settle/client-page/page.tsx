"use client";

import { Suspense, use } from "react";
import { SearchFallback } from "../../fixture-parts";
import { SearchValue } from "../../search-value";

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = use(searchParams);
  return (
    <main>
      <span data-testid="page-search-param">{String(q ?? "(none)")}</span>
      <Suspense fallback={<SearchFallback />}>
        <SearchValue />
      </Suspense>
    </main>
  );
}
