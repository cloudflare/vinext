import { Suspense } from "react";
import { unstable_noStore as noStore } from "next/cache";

let sequence = 0;

// Ported from Next.js: test/e2e/app-dir/cache-components/app/cases/dynamic_api_no_store/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components/app/cases/dynamic_api_no_store/page.tsx
// The "use cache" block gives the page a cache policy, so the page is stored
// unless unstable_noStore() makes it dynamic.
export default function UnstableNoStorePage() {
  return (
    <>
      <p>{`unstable-no-store-${++sequence}`}</p>
      <Suspense fallback="loading...">
        <ComponentThatCallsNoStore />
      </Suspense>
      <CachedBlock />
    </>
  );
}

async function ComponentThatCallsNoStore() {
  noStore();
  return <div>This component called unstable_noStore()</div>;
}

async function CachedBlock() {
  "use cache";
  return <div>cached block</div>;
}
