// Based on Next.js: test/e2e/app-dir/app/app/dynamic-client/[category]/[id]/page.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/app/dynamic-client/%5Bcategory%5D/%5Bid%5D/page.js
import QuerySsrClient from "./query-client";

export const revalidate = 60;

export default function QuerySsrClientPage() {
  return (
    <main>
      <QuerySsrClient />
      <output data-testid="query-ssr-client-id">{crypto.randomUUID()}</output>
    </main>
  );
}
