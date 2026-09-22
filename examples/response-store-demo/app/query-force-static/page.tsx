// Ported from Next.js: test/e2e/app-dir/ppr-full/ppr-full.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/ppr-full/ppr-full.test.ts
export const dynamic = "force-static";

export default async function QueryForceStaticPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  return <output data-testid="query-force-static-value">{q || "(empty)"}</output>;
}
