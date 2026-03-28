/**
 * Search query test page — displays searchParams from props and middleware.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/open-next/app/search-query/page.tsx
 * Tests: ON-14 in TRACKING.md
 */
import { headers } from "next/headers";

export default async function SearchQueryPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const headerStore = await headers();
  const mwSearchParams = headerStore.get("x-search-params") || "";

  const searchParamsValue = typeof params.searchParams === "string" ? params.searchParams : "";
  const multi = params.multi;
  const multiCount = Array.isArray(multi) ? multi.length : multi ? 1 : 0;

  return (
    <main>
      <h1>Search Query Test</h1>
      <p data-testid="props-params">Search Params via Props: {searchParamsValue}</p>
      <p data-testid="mw-params">Search Params via Middleware: {mwSearchParams}</p>
      <p data-testid="multi-count">Multi-value Params (key: multi): {multiCount}</p>
      {Array.isArray(multi) &&
        multi.map((v, i) => (
          <p key={i} data-testid={`multi-${i}`}>
            {v}
          </p>
        ))}
    </main>
  );
}
