/**
 * An unstable_cache miss whose data cache write rejects, as a KV put over the
 * value size limit does. Next.js's IncrementalCache.set catches cache handler
 * errors and only warns, so the page still renders the computed value.
 * Source: https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/lib/incremental-cache/index.ts
 */
import { unstable_cache } from "next/cache";
import {
  getCacheHandler,
  setCacheHandler,
  type CacheHandler,
  type CacheHandlerValue,
} from "vinext/shims/cache-handler";

export const dynamic = "force-dynamic";

const MARKER = "unstable-cache-write-failure:";

const getNonce = unstable_cache(
  async () => `${MARKER}${crypto.randomUUID()}`,
  ["unstable-cache-write-failure"],
  { revalidate: 3600 },
);

// Rejects only this page's entry, so requests running alongside it keep
// their cache writes.
class RejectingWriteCache implements CacheHandler {
  rejectedWrites = 0;

  constructor(private readonly delegate: CacheHandler) {}

  get(key: string, ctx?: Record<string, unknown>) {
    return this.delegate.get(key, ctx);
  }

  async set(key: string, value: CacheHandlerValue["value"], ctx?: Record<string, unknown>) {
    if (value?.kind === "FETCH" && value.data.body.includes(MARKER)) {
      this.rejectedWrites++;
      throw new Error("data cache write failed");
    }
    return this.delegate.set(key, value, ctx);
  }

  revalidateTag(tags: string | string[], durations?: { expire?: number }) {
    return this.delegate.revalidateTag(tags, durations);
  }

  resetRequestCache() {
    this.delegate.resetRequestCache?.();
  }
}

export default async function UnstableCacheWriteFailurePage() {
  const previous = getCacheHandler();
  const handler = new RejectingWriteCache(previous);
  setCacheHandler(handler);
  let nonce: string;
  try {
    nonce = await getNonce();
  } finally {
    setCacheHandler(previous);
  }

  return (
    <main>
      <p data-testid="nonce">{nonce.slice(MARKER.length)}</p>
      <p data-testid="rejected-writes">{handler.rejectedWrites}</p>
    </main>
  );
}
