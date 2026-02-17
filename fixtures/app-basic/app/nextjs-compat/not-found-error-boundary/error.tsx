/**
 * Next.js compat: not-found/basic — error boundary at the error-boundary route
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/app/error-boundary/error.js
 *
 * Key test: notFound() should propagate PAST this error boundary.
 * Error boundaries do NOT catch notFound(). Only not-found.tsx boundaries do.
 */
"use client";

export default function ErrorBoundary() {
  return <div>There was an error (should NOT appear for notFound)</div>;
}
