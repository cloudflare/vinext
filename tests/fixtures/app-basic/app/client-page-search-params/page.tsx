"use client";

import Link from "next/link";
import { use } from "react";

// The searchParams prop of a client page is built where the page renders: from
// the request in SSR, and in the browser from the query the server rendered,
// which a rewrite may change.
export default function ClientPageSearchParamsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = use(searchParams);

  return (
    <main>
      <p data-testid="client-page-search-params-q">{typeof q === "string" ? q : "(none)"}</p>
      <Link href="/client-page-search-params?q=world" data-testid="client-page-search-params-link">
        world
      </Link>
      <Link
        href="/client-page-search-params/rewritten/bar"
        data-testid="client-page-search-params-rewrite-link"
      >
        rewritten
      </Link>
    </main>
  );
}
