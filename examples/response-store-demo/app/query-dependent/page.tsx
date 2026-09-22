// Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
export const revalidate = 60;

export default async function QueryDependentPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  return (
    <main>
      <output data-testid="query-dependent-value">{q || "(empty)"}</output>
      <output data-testid="query-dependent-id">{crypto.randomUUID()}</output>
    </main>
  );
}
