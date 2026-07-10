import QueryEcho from "./client";

export const dynamic = "error";
export const revalidate = 60;

// Ported from Next.js: test/e2e/app-dir/missing-suspense-with-csr-bailout/
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/missing-suspense-with-csr-bailout
export default function QueryDynamicErrorUnboundedPage() {
  return (
    <main>
      <QueryEcho />
    </main>
  );
}
