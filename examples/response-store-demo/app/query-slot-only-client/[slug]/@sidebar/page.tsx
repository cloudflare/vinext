"use client";

// A slot-only Client Page still serializes its query prop in direct Flight.
// Ported from Next.js: test/e2e/app-dir/parallel-routes-and-interception/
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/parallel-routes-and-interception
export default function Sidebar() {
  return <output data-testid="query-slot-only-client-value">No searchParams used</output>;
}
