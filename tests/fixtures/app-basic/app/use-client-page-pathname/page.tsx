"use client";

import { usePathname, useSearchParams } from "next/navigation";

/**
 * Regression fixture for issue #688.
 *
 * The page component itself is "use client" and calls usePathname() /
 * useSearchParams(). This exercises a different import chain than a
 * Server Component page rendering a "use client" child — the page module
 * is resolved as a client reference by the RSC environment and rendered
 * entirely in the SSR environment.
 *
 * Without the fix, usePathname() returns "/" during SSR (instead of the
 * actual request pathname), causing a React hydration mismatch.
 */
export default function UseClientPagePathname() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <div id="client-page-info">
      <span id="client-page-pathname">{pathname}</span>
      <span id="client-page-search-q">{searchParams.get("q") ?? ""}</span>
      <span id="client-page-search-string">{searchParams.toString()}</span>
    </div>
  );
}
