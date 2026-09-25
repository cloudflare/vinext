"use client";

import Link from "next/link";
import { use } from "react";

// A force-static client page reads an empty query in SSR and the browser alike.
export default function ForceStaticClientPageSearchParamsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = use(searchParams);

  return (
    <main>
      <p data-testid="force-static-client-page-q">{typeof q === "string" ? q : "(none)"}</p>
      <Link
        href="/client-page-search-params/force-static?q=world"
        data-testid="force-static-client-page-link"
      >
        world
      </Link>
    </main>
  );
}
