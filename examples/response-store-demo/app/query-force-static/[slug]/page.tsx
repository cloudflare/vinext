// Next.js force-static supplies empty searchParams even on an on-demand route.
// See: test/e2e/app-dir/ppr-full/ppr-full.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/ppr-full/ppr-full.test.ts
import ClientQuery from "./client-query";

export const dynamic = "force-static";

export function generateStaticParams() {
  return [];
}

async function QueryForceStaticOnDemandPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  return (
    <main>
      <output data-testid="query-force-static-value">{q || "(empty)"}</output>
      <output data-testid="query-force-static-id">{crypto.randomUUID()}</output>
      <ClientQuery />
    </main>
  );
}

// Exercise a valid Server Page whose default export is not a function declaration.
export default QueryForceStaticOnDemandPage;
