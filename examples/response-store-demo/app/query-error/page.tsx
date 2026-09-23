// Ported from Next.js: test/e2e/app-dir/ppr-full/ppr-full.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/ppr-full/ppr-full.test.ts
export const dynamic = "error";

export default function QueryErrorPage() {
  return <output data-testid="query-error-id">{crypto.randomUUID()}</output>;
}
