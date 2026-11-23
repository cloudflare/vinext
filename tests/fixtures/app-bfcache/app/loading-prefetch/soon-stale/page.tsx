import { cacheLife } from "next/cache";
import { Suspense } from "react";

// About to go stale: like Next.js, a static shell leaves it out.
async function SoonStaleValue() {
  "use cache";
  cacheLife({ stale: 29, revalidate: 900, expire: 3600 });
  return <p id="soon-stale-value">soon-stale cache value</p>;
}

async function PrefetchableValue() {
  "use cache";
  cacheLife({ stale: 30, revalidate: 900, expire: 3600 });
  return <p id="prefetchable-value">prefetchable cache value</p>;
}

export default function SoonStalePage() {
  return (
    <main>
      <p id="route-content">soon-stale static part</p>
      <Suspense fallback={<p id="soon-stale-loading">Loading soon-stale…</p>}>
        <SoonStaleValue />
      </Suspense>
      <Suspense fallback={<p id="prefetchable-loading">Loading prefetchable…</p>}>
        <PrefetchableValue />
      </Suspense>
    </main>
  );
}
