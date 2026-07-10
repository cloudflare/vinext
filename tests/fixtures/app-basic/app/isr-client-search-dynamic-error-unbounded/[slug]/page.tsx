import UnboundedDynamicErrorQuery from "./client";

export const dynamic = "error";
export const revalidate = 60;

// Ported from Next.js: test/e2e/app-dir/missing-suspense-with-csr-bailout/
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/missing-suspense-with-csr-bailout
export default function UnboundedDynamicErrorPage() {
  return (
    <main>
      <h1>Unbounded dynamic-error query</h1>
      <UnboundedDynamicErrorQuery />
    </main>
  );
}
