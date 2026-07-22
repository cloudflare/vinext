/**
 * Next.js compat: viewport resolution errors use the same metadata outlet
 * boundary path as generateMetadata errors.
 * Source: https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/metadata.tsx
 */
"use client";

export default function ErrorBoundary() {
  return <p id="error">Local layout viewport error boundary</p>;
}
