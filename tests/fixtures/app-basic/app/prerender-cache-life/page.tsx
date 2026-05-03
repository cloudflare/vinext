"use cache";

import { cacheLife } from "next/cache";

export const revalidate = 1;

export default function PrerenderCacheLifePage() {
  cacheLife({ revalidate: 1, expire: 3 });

  return (
    <div data-testid="prerender-cache-life-page">
      <h1>Prerender Cache Life</h1>
    </div>
  );
}
