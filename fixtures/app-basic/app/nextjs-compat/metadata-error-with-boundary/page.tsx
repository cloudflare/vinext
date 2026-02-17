/**
 * Next.js compat: global-error/basic — page with generateMetadata that throws,
 * with a local error.tsx boundary to catch it.
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/app/metadata-error-with-boundary/page.js
 */
export const dynamic = "force-dynamic";

export function generateMetadata() {
  throw new Error("Metadata error");
}

export default function Page() {
  return <p>Metadata error</p>;
}
