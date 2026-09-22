// Ported from Next.js: test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
export const dynamic = "force-dynamic";

export default async function QueryPublicPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  return (
    <main>
      <output data-testid="query-public-value">{q || "(empty)"}</output>
      <output data-testid="query-public-id">{crypto.randomUUID()}</output>
    </main>
  );
}
