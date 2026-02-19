/**
 * Tests unstable_cache data cache alongside ISR page cache.
 *
 * Ported from: OpenNext ISR data cache separation pattern
 * Tests: ON-1 #8 in TRACKING.md
 *
 * Demonstrates that unstable_cache (data cache) and page ISR (page cache)
 * operate independently — you can invalidate the data cache via revalidateTag
 * without invalidating the page cache, and vice versa.
 */
import { unstable_cache } from "next/cache";

const getCachedData = unstable_cache(
  async () => {
    return {
      value: Math.random().toString(36).slice(2, 10),
      fetchedAt: Date.now(),
    };
  },
  ["unstable-cache-test"],
  { tags: ["unstable-data"], revalidate: 3600 },
);

export const revalidate = 3600;

export default async function UnstableCacheTestPage() {
  const data = await getCachedData();

  return (
    <main data-testid="unstable-cache-page">
      <h1>Unstable Cache Test</h1>
      <p data-testid="cached-value">CachedValue: {data.value}</p>
      <p data-testid="fetched-at">FetchedAt: {data.fetchedAt}</p>
      <p data-testid="render-time">RenderTime: {Date.now()}</p>
    </main>
  );
}
