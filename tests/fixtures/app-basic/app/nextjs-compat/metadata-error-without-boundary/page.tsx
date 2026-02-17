/**
 * Next.js compat: global-error/basic — page with generateMetadata that throws,
 * without any local error.tsx — should escalate to global-error.tsx.
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/basic/app/metadata-error-without-boundary/page.js
 */
export const dynamic = "force-dynamic";

export function generateMetadata() {
  throw new Error("Metadata error");
}

export default function Page() {
  return <p>Metadata error</p>;
}
