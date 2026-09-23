"use client";

// Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
import Link from "next/link";
import { useState } from "react";

export const revalidate = 60;

export default function QueryClientIndependentPage() {
  const [clicks, setClicks] = useState(0);

  return (
    <main>
      <output data-testid="query-client-independent-value">No searchParams used</output>
      <button onClick={() => setClicks(clicks + 1)}>Clicked {clicks} times</button>
      <Link prefetch={false} href="/query-client-dependent?q=from-navigation">
        Open query-dependent Client Page
      </Link>
    </main>
  );
}
