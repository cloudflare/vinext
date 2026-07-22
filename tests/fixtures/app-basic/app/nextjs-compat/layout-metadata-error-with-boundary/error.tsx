/**
 * Next.js compat: global-error/basic — local error boundary for layout metadata errors.
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/index.test.ts
 */
"use client";

export default function ErrorBoundary() {
  return <p id="error">Local layout metadata error boundary</p>;
}
