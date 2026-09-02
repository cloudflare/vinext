export type ResponseSnapshot = {
  body: ArrayBuffer;
  headers: Array<[string, string]>;
  status: number;
  statusText: string;
};

type HostCacheEntry = {
  snapshot: Promise<ResponseSnapshot | null>;
  tags: Set<string>;
};

const HTTP_STAGE_HOST_CACHE = Symbol.for("vinext.fixture.httpStageHostCache");
export const HTTP_STAGE_HOST_CACHE_PURGE = Symbol.for("vinext.fixture.httpStageHostCachePurge");
const globals = globalThis as unknown as Record<PropertyKey, unknown>;
const cache = (globals[HTTP_STAGE_HOST_CACHE] ??= new Map<string, HostCacheEntry>()) as Map<
  string,
  HostCacheEntry
>;

export function getHostCacheEntry(key: string): Promise<ResponseSnapshot | null> | undefined {
  return cache.get(key)?.snapshot;
}

export function setHostCacheEntry(
  key: string,
  snapshot: Promise<ResponseSnapshot | null>,
  tags: readonly string[],
): void {
  cache.set(key, { snapshot, tags: new Set(tags) });
}

export function purgeHostCacheTags(tags: readonly string[]): void {
  if (tags.length === 0) return;
  const invalidated = new Set(tags);
  for (const [key, entry] of cache) {
    if ([...entry.tags].some((tag) => invalidated.has(tag))) cache.delete(key);
  }
}

globals[HTTP_STAGE_HOST_CACHE_PURGE] = purgeHostCacheTags;
