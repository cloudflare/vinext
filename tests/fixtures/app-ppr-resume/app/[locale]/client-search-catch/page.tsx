"use client";

import { use } from "react";

type SearchParams = Promise<{ q?: string }>;

const caught = new WeakMap<SearchParams, SearchParams>();

// A client page that catches its searchParams' rejection. Like Next.js's
// prerender, a static render never settles them, so the catch branch never
// reaches the stored HTML.
export default function ClientSearchCatchPage({ searchParams }: { searchParams: SearchParams }) {
  let query = caught.get(searchParams);
  if (!query) {
    query = searchParams.catch(() => ({ q: "caught" }));
    caught.set(searchParams, query);
  }
  return (
    <main>
      <p id="client-catch-query">client catch query {use(query).q ?? "none"}</p>
    </main>
  );
}
