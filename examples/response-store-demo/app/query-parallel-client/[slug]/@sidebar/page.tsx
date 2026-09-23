"use client";

// Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
import { useState } from "react";

export default function QueryParallelClientSidebar({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const [value, setValue] = useState("(unread)");

  return (
    <section>
      <output data-testid="query-parallel-client-value">No searchParams used during render</output>
      <output data-testid="query-parallel-client-late-value">{value}</output>
      <button onClick={async () => setValue((await searchParams).q ?? "(empty)")}>
        Read searchParams
      </button>
    </section>
  );
}
