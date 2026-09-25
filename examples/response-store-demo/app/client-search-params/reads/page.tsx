"use client";

import { use } from "react";

// A client page that reads its searchParams prop. As in Next.js, the read
// makes the render dynamic, so the page server-renders the real query and is
// never stored, with or without a query.
export default function ClientSearchParamsReadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = use(searchParams);

  return (
    <>
      <h1>
        <code>/client-search-params/reads</code>
      </h1>
      <p>
        Query: <code data-testid="client-search-value">{typeof q === "string" ? q : "(none)"}</code>
      </p>
    </>
  );
}
