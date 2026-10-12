"use client";

import { usePathname } from "next/navigation";
import { use, useEffect, useState } from "react";

// Renders behind the layout's delayed boundary, after the document head.
// usePathname() stays the public path under a rewrite.
export default function DelayedClientPageSearchParamsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = use(searchParams);
  const pathname = usePathname();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <>
      <p data-testid="delayed-client-page-q" data-hydrated={hydrated ? "true" : undefined}>
        {typeof q === "string" ? q : "(none)"}
      </p>
      <p data-testid="delayed-client-page-pathname">{pathname}</p>
    </>
  );
}
