"use client";

// Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
import { use } from "react";

export default function QueryErrorClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  // The on-demand generated path is intentionally absent at build time. A
  // static-error Client Page must reject this access even for an empty query.
  const slug = use(params).slug;
  if (slug === "reads") {
    return <output data-testid="query-error-client-value">{use(searchParams).q}</output>;
  }
  return <output data-testid="query-error-client-value">No searchParams used</output>;
}
