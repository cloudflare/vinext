// Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
import ClientQueryAfterHydration from "./client-query";

export const revalidate = 60;

export default function QueryIndependentPage() {
  return (
    <main>
      <output data-testid="query-independent-id">{crypto.randomUUID()}</output>
      <ClientQueryAfterHydration />
    </main>
  );
}
