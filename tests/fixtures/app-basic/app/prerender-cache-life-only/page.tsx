"use cache";

import { cacheLife } from "next/cache";

export default function PrerenderCacheLifeOnlyPage() {
  cacheLife({ revalidate: 1, expire: 3 });

  return (
    <div data-testid="prerender-cache-life-only-page">
      <h1>Prerender Cache Life Only</h1>
    </div>
  );
}
