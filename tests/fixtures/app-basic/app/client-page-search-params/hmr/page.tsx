"use client";

import { use, useEffect, useState } from "react";

// A cookie-gated rewrite can give an HMR re-render a query the URL doesn't have.
export default function HmrClientPageSearchParamsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = use(searchParams);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <p data-testid="hmr-client-page-q" data-hydrated={hydrated ? "true" : undefined}>
      {typeof q === "string" ? q : "(none)"}
    </p>
  );
}
