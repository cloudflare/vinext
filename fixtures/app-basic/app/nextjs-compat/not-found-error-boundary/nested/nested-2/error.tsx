/**
 * Next.js compat: not-found/basic — error boundary at nested-2 level
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/app/error-boundary/nested/nested-2/error.js
 */
"use client";

export default function ErrorBoundary() {
  return <div>There was an error (nested-2, should NOT appear for notFound)</div>;
}
