import type { RenderObservation } from "../server/cache-proof.js";
import {
  readCacheControlNumberField,
  readCacheControlRevalidateField,
} from "../utils/cache-control-metadata.js";

export type CacheHandlerValue = {
  lastModified: number;
  age?: number;
  cacheState?: string;
  cacheControl?: CacheControlMetadata;
  value: IncrementalCacheValue | null;
};

/**
 * Epoch timestamp with sub-millisecond ordering when the runtime exposes the
 * High Resolution Time API. Cache fills and tag invalidations must share this
 * clock so two operations in the same `Date.now()` millisecond remain ordered.
 * @internal
 */
export function getCacheTimestamp(): number {
  const wallTime = Date.now();
  if (
    typeof performance !== "undefined" &&
    Number.isFinite(performance.timeOrigin) &&
    performance.timeOrigin > 0
  ) {
    const highResolutionTime = performance.timeOrigin + performance.now();
    // Fake timers and wall-clock corrections can move Date.now() onto a
    // different epoch while the monotonic clock keeps its original origin.
    // Persist the wall clock in that case rather than comparing unrelated
    // timestamp domains across cache handlers or Worker isolates.
    if (Math.abs(highResolutionTime - wallTime) < 60_000) {
      return highResolutionTime;
    }
  }
  return wallTime;
}

/** Resolve a producer timestamp while retaining compatibility with legacy callers. */
export function getCacheTimestampFromContext(ctx: Record<string, unknown> | undefined): number {
  const value = ctx?.timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : getCacheTimestamp();
}

export type CacheControlMetadata = {
  revalidate: number | false;
  expire?: number;
  /**
   * Client-router reuse bound from the render's resolved `cacheLife`,
   * persisted so warm hits replay the producing render's claim. Independent
   * of `revalidate`/`expire`; absent means no claim was made.
   */
  stale?: number;
};

export type IncrementalCacheValue =
  | CachedFetchValue
  | CachedAppPageValue
  | CachedPagesValue
  | CachedRouteValue
  | CachedRedirectValue
  | CachedImageValue;

export type CachedFetchValue = {
  kind: "FETCH";
  data: {
    headers: Record<string, string>;
    body: string;
    url: string;
    status?: number;
  };
  tags?: string[];
  revalidate: number | false;
};

export type CachedAppPageValue = {
  kind: "APP_PAGE";
  html: string;
  rscData: ArrayBuffer | undefined;
  headers: Record<string, string | string[]> | undefined;
  postponed: string | undefined;
  renderObservation?: RenderObservation;
  status: number | undefined;
};

export type CachedPagesValue = {
  kind: "PAGES";
  html: string;
  pageData: object;
  generatedFromDataRequest?: boolean;
  headers: Record<string, string | string[]> | undefined;
  status: number | undefined;
};

export type CachedRouteValue = {
  kind: "APP_ROUTE";
  body: ArrayBuffer;
  status: number;
  headers: Record<string, string | string[]>;
};

export type CachedRedirectValue = {
  kind: "REDIRECT";
  props: object;
};

export type CachedImageValue = {
  kind: "IMAGE";
  etag: string;
  buffer: ArrayBuffer;
  extension: string;
  revalidate?: number;
};

export type CacheHandlerContext = {
  dev?: boolean;
  maxMemoryCacheSize?: number;
  revalidatedTags?: string[];
  /**
   * Causal timestamp captured by the producer before cache filling starts.
   * Handlers must persist it as `lastModified` and return it unchanged.
   */
  timestamp?: number;
  [key: string]: unknown;
};

export type CacheHandler = {
  get(key: string, ctx?: CacheHandlerContext): Promise<CacheHandlerValue | null>;
  set(key: string, data: IncrementalCacheValue | null, ctx?: CacheHandlerContext): Promise<void>;
  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
  resetRequestCache?(): void;
};

export class NoOpCacheHandler implements CacheHandler {
  async get(_key: string, _ctx?: CacheHandlerContext): Promise<CacheHandlerValue | null> {
    return null;
  }

  async set(
    _key: string,
    _data: IncrementalCacheValue | null,
    _ctx?: CacheHandlerContext,
  ): Promise<void> {}

  async revalidateTag(_tags: string | string[], _durations?: { expire?: number }): Promise<void> {}
}

type MemoryEntry = {
  value: IncrementalCacheValue | null;
  tags: string[];
  lastModified: number;
  /** Wall-clock write time used for duration-based cache policy. */
  writtenAt: number;
  revalidateAt: number | null;
  expireAt: number | null;
  cacheControl?: CacheControlMetadata;
};

const DEFAULT_MEMORY_CACHE_MAX_SIZE = 50 * 1024 * 1024;
const MAX_REVALIDATED_TAG_ENTRIES = 10_000;

type MemoryCacheHandlerOptions = Pick<CacheHandlerContext, "maxMemoryCacheSize"> & {
  cacheMaxMemorySize?: number;
};

function estimateStringMapSize(map: Record<string, string | string[]> | undefined): number {
  if (!map) return 0;
  let size = 0;
  for (const [key, value] of Object.entries(map)) {
    size += key.length;
    if (Array.isArray(value)) {
      for (const item of value) size += item.length;
    } else {
      size += value.length;
    }
  }
  return size;
}

function estimateIncrementalCacheValueSize(value: IncrementalCacheValue | null): number {
  if (value === null) return 25;

  switch (value.kind) {
    case "FETCH":
      return JSON.stringify(value.data ?? "").length;
    case "PAGES":
      return (
        value.html.length +
        JSON.stringify(value.pageData ?? {}).length +
        estimateStringMapSize(value.headers)
      );
    case "APP_PAGE":
      return (
        value.html.length +
        (value.rscData?.byteLength ?? 0) +
        (value.postponed?.length ?? 0) +
        estimateStringMapSize(value.headers)
      );
    case "APP_ROUTE":
      return value.body.byteLength + estimateStringMapSize(value.headers);
    case "REDIRECT":
      return JSON.stringify(value.props ?? {}).length;
    case "IMAGE":
      return value.buffer.byteLength + value.extension.length + value.etag.length;
    default:
      return JSON.stringify(value).length;
  }
}

function resolveMemoryCacheMaxSize(options?: number | MemoryCacheHandlerOptions): number {
  if (typeof options === "number") return options;
  if (typeof options?.cacheMaxMemorySize === "number") return options.cacheMaxMemorySize;
  if (typeof options?.maxMemoryCacheSize === "number") return options.maxMemoryCacheSize;
  return DEFAULT_MEMORY_CACHE_MAX_SIZE;
}

function readStringArrayField(ctx: Record<string, unknown> | undefined, field: string): string[] {
  const value = ctx?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readPositiveNumberField(
  ctx: Record<string, unknown> | undefined,
  field: string,
): number | undefined {
  const value = ctx?.[field];
  return typeof value === "number" && value > 0 ? value : undefined;
}

export class MemoryCacheHandler implements CacheHandler {
  private store = new Map<string, MemoryEntry>();
  private tagRevalidatedAt = new Map<string, number>();
  private readonly maxMemoryCacheSize: number;
  private currentMemoryCacheSize = 0;

  constructor(options?: number | MemoryCacheHandlerOptions) {
    this.maxMemoryCacheSize = resolveMemoryCacheMaxSize(options);
  }

  private estimateEntrySize(entry: MemoryEntry): number {
    return (
      estimateIncrementalCacheValueSize(entry.value) +
      entry.tags.reduce((sum, tag) => sum + tag.length, 0) +
      64
    );
  }

  private deleteEntry(key: string): void {
    const existing = this.store.get(key);
    if (!existing) return;
    this.currentMemoryCacheSize -= this.estimateEntrySize(existing);
    this.store.delete(key);
  }

  private touchEntry(key: string, entry: MemoryEntry): void {
    this.store.delete(key);
    this.store.set(key, entry);
  }

  private evictLeastRecentlyUsed(): void {
    while (this.maxMemoryCacheSize > 0 && this.currentMemoryCacheSize > this.maxMemoryCacheSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) return;
      this.deleteEntry(oldestKey);
    }
  }

  async get(key: string, ctx?: CacheHandlerContext): Promise<CacheHandlerValue | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    for (const tag of entry.tags) {
      const revalidatedAt = this.tagRevalidatedAt.get(tag);
      if (revalidatedAt && revalidatedAt > entry.lastModified) {
        this.deleteEntry(key);
        return null;
      }
    }

    for (const tag of readStringArrayField(ctx, "softTags")) {
      const revalidatedAt = this.tagRevalidatedAt.get(tag);
      if (revalidatedAt && revalidatedAt > entry.lastModified) {
        return null;
      }
    }

    this.touchEntry(key, entry);

    const now = Date.now();
    if (entry.expireAt !== null && now > entry.expireAt) {
      return {
        lastModified: entry.lastModified,
        value: entry.value,
        cacheState: "expired",
        cacheControl: entry.cacheControl,
      };
    }

    const requestedRevalidate = readPositiveNumberField(ctx, "revalidate");
    const requestedRevalidateAt =
      requestedRevalidate === undefined ? null : entry.writtenAt + requestedRevalidate * 1000;
    const isStale =
      (entry.revalidateAt !== null && now > entry.revalidateAt) ||
      (requestedRevalidateAt !== null && now > requestedRevalidateAt);

    if (isStale) {
      return {
        lastModified: entry.lastModified,
        value: entry.value,
        cacheState: "stale",
        cacheControl: entry.cacheControl,
      };
    }

    return {
      lastModified: entry.lastModified,
      value: entry.value,
      cacheControl: entry.cacheControl,
    };
  }

  async set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: CacheHandlerContext,
  ): Promise<void> {
    const tagSet = new Set<string>();
    if (data && "tags" in data && Array.isArray(data.tags)) {
      for (const tag of data.tags) tagSet.add(tag);
    }
    for (const tag of readStringArrayField(ctx, "tags")) {
      tagSet.add(tag);
    }
    const tags = [...tagSet];

    let effectiveRevalidate = readCacheControlRevalidateField(ctx);
    const effectiveExpire = readCacheControlNumberField(ctx, "expire");
    const effectiveStale = readCacheControlNumberField(ctx, "stale");
    if (data && "revalidate" in data && typeof data.revalidate === "number") {
      effectiveRevalidate = data.revalidate;
    } else if (data && "revalidate" in data && data.revalidate === false) {
      // Preserve a non-expiring value when no context policy was supplied,
      // but never let it override an explicit `ctx.revalidate: 0` no-store.
      effectiveRevalidate ??= false;
    }
    if (effectiveRevalidate === 0) return;

    // Framework producers capture this before running user work, matching
    // Next.js CacheEntry.timestamp. The fallback keeps direct and legacy calls
    // backward compatible without letting adapters replace a supplied value.
    const lastModified = getCacheTimestampFromContext(ctx);
    const writtenAt = Date.now();
    const revalidateAt =
      typeof effectiveRevalidate === "number" && effectiveRevalidate > 0
        ? writtenAt + effectiveRevalidate * 1000
        : null;
    const expireAt =
      typeof effectiveExpire === "number" && effectiveExpire > 0
        ? writtenAt + effectiveExpire * 1000
        : null;
    // Absent fields stay absent rather than becoming explicit `undefined`, so a
    // round trip through a serializing cache adapter cannot turn "no claim"
    // into a key that later reads as present.
    const cacheControl: CacheControlMetadata | undefined =
      typeof effectiveRevalidate === "number" || effectiveRevalidate === false
        ? {
            revalidate: effectiveRevalidate,
            ...(effectiveExpire === undefined ? {} : { expire: effectiveExpire }),
            ...(effectiveStale === undefined ? {} : { stale: effectiveStale }),
          }
        : undefined;

    if (this.maxMemoryCacheSize === 0) return;

    const entry = {
      value: data,
      tags,
      lastModified,
      writtenAt,
      revalidateAt,
      expireAt,
      cacheControl,
    };
    const entrySize = this.estimateEntrySize(entry);
    if (entrySize > this.maxMemoryCacheSize) {
      this.deleteEntry(key);
      return;
    }

    this.deleteEntry(key);
    this.store.set(key, entry);
    this.currentMemoryCacheSize += entrySize;
    this.evictLeastRecentlyUsed();
  }

  async revalidateTag(tags: string | string[]): Promise<void> {
    const tagList = Array.isArray(tags) ? tags : [tags];
    const now = getCacheTimestamp();
    for (const tag of tagList) {
      this.tagRevalidatedAt.set(tag, now);
      while (this.tagRevalidatedAt.size > MAX_REVALIDATED_TAG_ENTRIES) {
        const oldest = this.tagRevalidatedAt.keys().next().value;
        if (oldest === undefined) break;
        this.tagRevalidatedAt.delete(oldest);
      }
    }
  }

  resetRequestCache(): void {}
}

const HANDLER_KEY = Symbol.for("vinext.cacheHandler");
const globalHandlers = globalThis as unknown as Record<PropertyKey, CacheHandler>;

function getActiveHandler(): CacheHandler {
  return globalHandlers[HANDLER_KEY] ?? (globalHandlers[HANDLER_KEY] = new MemoryCacheHandler());
}

export function configureMemoryCacheHandler(options?: MemoryCacheHandlerOptions): void {
  const current = globalHandlers[HANDLER_KEY];
  if (current && !(current instanceof MemoryCacheHandler)) return;
  globalHandlers[HANDLER_KEY] = new MemoryCacheHandler(options);
}

export function setDataCacheHandler(handler: CacheHandler): void {
  globalHandlers[HANDLER_KEY] = handler;
}

export function getDataCacheHandler(): CacheHandler {
  return getActiveHandler();
}

export function setCacheHandler(handler: CacheHandler): void {
  setDataCacheHandler(handler);
}

export function getCacheHandler(): CacheHandler {
  return getDataCacheHandler();
}
