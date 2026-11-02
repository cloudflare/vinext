/**
 * Cache misses whose data cache writes are slow. Like Next.js, which queues
 * them on the work store, unstable_cache and "use cache" return without
 * waiting for the write, and the entries are stored once it finishes.
 * Source: https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/web/spec-extension/unstable-cache.ts
 * Source: https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/use-cache/use-cache-wrapper.ts
 */
import { cacheTag, unstable_cache } from "next/cache";
import {
  getCacheHandler,
  setCacheHandler,
  type CacheHandler,
  type CacheHandlerValue,
} from "vinext/shims/cache-handler";

export const dynamic = "force-dynamic";

const TAG = "data-cache-deferred-write";
const WRITE_DELAY_MS = 100;

type Writes = { started: number; settled: number };
const writesByRun = new Map<string, Writes>();

const getUnstableCacheNonce = unstable_cache(
  async (_run: string) => crypto.randomUUID(),
  ["data-cache-deferred-write"],
  { tags: [TAG] },
);

async function getUseCacheNonce(_run: string) {
  "use cache";
  cacheTag(TAG);
  return crypto.randomUUID();
}

// Delays only this page's entries, so requests running alongside it keep
// their cache writes.
class SlowWriteCache implements CacheHandler {
  constructor(
    private readonly delegate: CacheHandler,
    private readonly writes: Writes,
  ) {}

  get(key: string, ctx?: Record<string, unknown>) {
    return this.delegate.get(key, ctx);
  }

  async set(key: string, value: CacheHandlerValue["value"], ctx?: Record<string, unknown>) {
    if (value?.kind !== "FETCH" || !value.tags?.includes(TAG)) {
      return this.delegate.set(key, value, ctx);
    }
    this.writes.started++;
    await new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS));
    await this.delegate.set(key, value, ctx);
    this.writes.settled++;
  }

  revalidateTag(tags: string | string[], durations?: { expire?: number }) {
    return this.delegate.revalidateTag(tags, durations);
  }

  resetRequestCache() {
    this.delegate.resetRequestCache?.();
  }
}

export default async function DataCacheDeferredWritePage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; observe?: string }>;
}) {
  const { run, observe } = await searchParams;
  if (observe) {
    return <p data-testid="settled">{writesByRun.get(observe)?.settled ?? 0}</p>;
  }
  if (!run) return null;

  const writes: Writes = { started: 0, settled: 0 };
  writesByRun.set(run, writes);
  const previous = getCacheHandler();
  setCacheHandler(new SlowWriteCache(previous, writes));
  let nonces: [string, string];
  try {
    nonces = await Promise.all([getUnstableCacheNonce(run), getUseCacheNonce(run)]);
  } finally {
    setCacheHandler(previous);
  }

  return (
    <main>
      <p data-testid="unstable-cache">{nonces[0]}</p>
      <p data-testid="use-cache">{nonces[1]}</p>
      <p data-testid="writes">{`${writes.started}/${writes.settled}`}</p>
    </main>
  );
}
