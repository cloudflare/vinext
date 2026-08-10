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
  [key: string]: unknown;
};

export type CacheHandler = {
  get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null>;
  set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: Record<string, unknown>,
  ): Promise<void>;
  /** Build/runtime hand-off that preserves the original cache-entry timestamp. */
  seed?(
    key: string,
    data: IncrementalCacheValue | null,
    ctx: Record<string, unknown> | undefined,
    metadata: { lastModified: number },
  ): Promise<boolean>;
  /** Release build-only single-flight ownership when a cache fill produced no entry. */
  releasePendingSet?(key: string): Promise<void>;
  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
  resetRequestCache?(): void;
};

export class NoOpCacheHandler implements CacheHandler {
  async get(_key: string, _ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    return null;
  }

  async set(
    _key: string,
    _data: IncrementalCacheValue | null,
    _ctx?: Record<string, unknown>,
  ): Promise<void> {}

  async revalidateTag(_tags: string | string[], _durations?: { expire?: number }): Promise<void> {}
}

type MemoryEntry = {
  value: IncrementalCacheValue | null;
  tags: string[];
  lastModified: number;
  revalidateAt: number | null;
  expireAt: number | null;
  cacheControl?: CacheControlMetadata;
};

type TagRevalidation = {
  /** Hard invalidation generation (updateTag / one-argument revalidateTag). */
  expiredAt?: number;
  /** Deadline for entries older than staleAt after a profiled revalidation. */
  expireAt?: number;
  /** Profiled invalidation generation. */
  staleAt?: number;
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
  private tagRevalidations = new Map<string, TagRevalidation>();
  private readonly maxMemoryCacheSize: number;
  private currentMemoryCacheSize = 0;
  private lastTimestamp = 0;

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

  private nextTimestamp(): number {
    return (this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1));
  }

  private currentTimestamp(): number {
    return Math.max(Date.now(), this.lastTimestamp);
  }

  async get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    const now = this.currentTimestamp();

    if (entry.value?.kind === "FETCH") {
      const requestedTags = readStringArrayField(ctx, "tags");
      if (requestedTags.some((tag) => !entry.tags.includes(tag))) {
        const previousSize = this.estimateEntrySize(entry);
        const tags = [...new Set([...entry.tags, ...requestedTags])];
        entry.tags = tags;
        entry.value = { ...entry.value, tags };
        this.currentMemoryCacheSize += this.estimateEntrySize(entry) - previousSize;
      }
    }

    for (const tag of entry.tags) {
      const revalidation = this.tagRevalidations.get(tag);
      if (revalidation && this.tagIsExpired(revalidation, entry.lastModified, now)) {
        this.deleteEntry(key);
        return null;
      }
    }

    for (const tag of readStringArrayField(ctx, "softTags")) {
      const revalidation = this.tagRevalidations.get(tag);
      if (revalidation && this.tagIsExpired(revalidation, entry.lastModified, now)) {
        return null;
      }
    }

    this.touchEntry(key, entry);
    this.evictLeastRecentlyUsed();

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
      requestedRevalidate === undefined ? null : entry.lastModified + requestedRevalidate * 1000;
    const invalidatedAsStale = [...entry.tags, ...readStringArrayField(ctx, "softTags")].some(
      (tag) => {
        const staleAt = this.tagRevalidations.get(tag)?.staleAt;
        return staleAt !== undefined && staleAt >= entry.lastModified;
      },
    );
    const isStale =
      invalidatedAsStale ||
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

  private tagIsExpired(revalidation: TagRevalidation, lastModified: number, now: number): boolean {
    if (
      revalidation.expiredAt !== undefined &&
      (Number.isNaN(revalidation.expiredAt) || revalidation.expiredAt >= lastModified)
    ) {
      return true;
    }
    return (
      revalidation.staleAt !== undefined &&
      revalidation.expireAt !== undefined &&
      revalidation.expireAt <= now &&
      revalidation.staleAt >= lastModified
    );
  }

  async set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: Record<string, unknown>,
  ): Promise<void> {
    this.writeEntry(key, data, ctx, this.nextTimestamp());
  }

  async seed(
    key: string,
    data: IncrementalCacheValue | null,
    ctx: Record<string, unknown> | undefined,
    metadata: { lastModified: number },
  ): Promise<boolean> {
    const existing = this.store.get(key);
    if (existing && existing.lastModified >= metadata.lastModified) return false;
    this.lastTimestamp = Math.max(this.lastTimestamp, metadata.lastModified);
    return this.writeEntry(key, data, ctx, metadata.lastModified);
  }

  private writeEntry(
    key: string,
    data: IncrementalCacheValue | null,
    ctx: Record<string, unknown> | undefined,
    now: number,
  ): boolean {
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
    if (effectiveRevalidate === 0) return false;

    const revalidateAt =
      typeof effectiveRevalidate === "number" && effectiveRevalidate > 0
        ? now + effectiveRevalidate * 1000
        : null;
    const expireAt =
      typeof effectiveExpire === "number" && effectiveExpire > 0
        ? now + effectiveExpire * 1000
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

    if (this.maxMemoryCacheSize === 0) return false;

    const entry = {
      value: data,
      tags,
      lastModified: now,
      revalidateAt,
      expireAt,
      cacheControl,
    };
    const entrySize = this.estimateEntrySize(entry);
    if (entrySize > this.maxMemoryCacheSize) {
      this.deleteEntry(key);
      return false;
    }

    this.deleteEntry(key);
    this.store.set(key, entry);
    this.currentMemoryCacheSize += entrySize;
    this.evictLeastRecentlyUsed();
    return this.store.has(key);
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    const tagList = Array.isArray(tags) ? tags : [tags];
    const now = this.nextTimestamp();
    for (const tag of tagList) {
      const existing = this.tagRevalidations.get(tag) ?? {};
      this.tagRevalidations.delete(tag);
      this.tagRevalidations.set(
        tag,
        durations
          ? {
              ...existing,
              staleAt: now,
              expireAt: durations.expire === undefined ? undefined : now + durations.expire * 1000,
            }
          : { ...existing, expiredAt: now },
      );
      while (this.tagRevalidations.size > MAX_REVALIDATED_TAG_ENTRIES) {
        const oldest = this.tagRevalidations.keys().next().value;
        if (oldest === undefined) break;
        this.tagRevalidations.delete(oldest);
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
