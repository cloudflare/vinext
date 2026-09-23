"use client";

// Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
export default function QueryErrorClientPage() {
  return <output data-testid="query-error-client-value">No searchParams used</output>;
}
