// Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
import QueryPropClient from "./client";

export const revalidate = 60;

export default function QueryPropToClientPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  return (
    <main>
      <QueryPropClient searchParams={searchParams} />
      <output data-testid="query-prop-to-client-id">{crypto.randomUUID()}</output>
    </main>
  );
}
