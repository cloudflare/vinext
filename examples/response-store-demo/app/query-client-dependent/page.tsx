"use client";

// Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
import { use } from "react";

export const revalidate = 60;

export default function QueryClientDependentPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = use(searchParams);
  return <output data-testid="query-client-dependent-value">{q || "(empty)"}</output>;
}
