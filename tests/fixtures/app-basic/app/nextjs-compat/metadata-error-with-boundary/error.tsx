/**
 * Next.js compat: global-error/basic — local error boundary for metadata errors
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/app/metadata-error-with-boundary/error.js
 */
"use client";

export default function ErrorBoundary() {
  return <p id="error">Local error boundary</p>;
}
