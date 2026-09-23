"use client";

// Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
import { useState } from "react";

export const revalidate = 1;

export default function QueryStaleClientPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const [value, setValue] = useState("(unread)");

  return (
    <>
      <output data-testid="query-stale-client-value">{value}</output>
      <button onClick={async () => setValue((await searchParams).q ?? "(empty)")}>
        Read searchParams
      </button>
    </>
  );
}
