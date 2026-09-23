"use client";

// Next.js substitutes empty searchParams for Client Pages under force-static.
// See: packages/next/src/server/request/search-params.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/request/search-params.ts
import { use } from "react";

export default function QueryForceStaticClientPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = use(searchParams);
  return <output data-testid="query-force-static-client-page-value">{q || "(empty)"}</output>;
}
