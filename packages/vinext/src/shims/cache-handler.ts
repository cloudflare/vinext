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

  async get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    for (const tag of entry.tags) {
      const revalidatedAt = this.tagRevalidatedAt.get(tag);
      if (revalidatedAt && revalidatedAt >= entry.lastModified) {
        this.deleteEntry(key);
        return null;
      }
    }

    for (const tag of readStringArrayField(ctx, "softTags")) {
      const revalidatedAt = this.tagRevalidatedAt.get(tag);
      if (revalidatedAt && revalidatedAt >= entry.lastModified) {
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
      requestedRevalidate === undefined ? null : entry.lastModified + requestedRevalidate * 1000;
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
    ctx?: Record<string, unknown>,
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

    const now = Date.now();
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

    if (this.maxMemoryCacheSize === 0) return;

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
      return;
    }

    this.deleteEntry(key);
    this.store.set(key, entry);
    this.currentMemoryCacheSize += entrySize;
    this.evictLeastRecentlyUsed();
  }

  async revalidateTag(tags: string | string[]): Promise<void> {
    const tagList = Array.isArray(tags) ? tags : [tags];
    const now = Date.now();
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
const MEMORY_FALLBACK_KEY = Symbol.for("vinext.memoryCacheHandlerFallback");
const MEMORY_FALLBACK_SIZE_KEY = Symbol.for("vinext.memoryCacheHandlerFallbackSize");
const globalHandlers = globalThis as unknown as Record<PropertyKey, CacheHandler>;
const memoryFallbackState = globalThis as unknown as Record<PropertyKey, unknown>;
const CONFIGURED_HANDLER_KEY = Symbol.for("vinext.configuredCacheHandler");
type ConfiguredHandlerRegistration =
  | {
      env: unknown;
      handler: CacheHandler;
      id: string;
      kind: "generated";
    }
  | {
      handler: CacheHandler;
      kind: "manual";
    };
const configuredHandlerState = globalThis as unknown as Record<
  PropertyKey,
  ConfiguredHandlerRegistration | undefined
>;

function getActiveHandler(): CacheHandler {
  return globalHandlers[HANDLER_KEY] ?? (globalHandlers[HANDLER_KEY] = new MemoryCacheHandler());
}

export function configureMemoryCacheHandler(options?: MemoryCacheHandlerOptions): void {
  const fallbackSize = resolveMemoryCacheMaxSize(options);
  const current = globalHandlers[HANDLER_KEY];
  let fallback = globalHandlers[MEMORY_FALLBACK_KEY];
  if (
    !fallback ||
    fallback !== current ||
    memoryFallbackState[MEMORY_FALLBACK_SIZE_KEY] !== fallbackSize
  ) {
    fallback = new MemoryCacheHandler(options);
    globalHandlers[MEMORY_FALLBACK_KEY] = fallback;
    memoryFallbackState[MEMORY_FALLBACK_SIZE_KEY] = fallbackSize;
  }
  const registration = configuredHandlerState[CONFIGURED_HANDLER_KEY];
  if (registration && registration.handler === current) return;
  globalHandlers[HANDLER_KEY] = fallback;
}

export function setDataCacheHandler(handler: CacheHandler): void {
  globalHandlers[HANDLER_KEY] = handler;
  configuredHandlerState[CONFIGURED_HANDLER_KEY] = { handler, kind: "manual" };
}

/** @internal Install a generated adapter and retain its build/env identity across module graphs. */
export function setConfiguredDataCacheHandler(
  handler: CacheHandler,
  id: string,
  env: unknown,
): void {
  globalHandlers[HANDLER_KEY] = handler;
  configuredHandlerState[CONFIGURED_HANDLER_KEY] = { env, handler, id, kind: "generated" };
}

/** @internal Whether this generated adapter is already the active handler. */
export function isConfiguredDataCacheHandlerActive(id: string, env: unknown): boolean {
  const registration = configuredHandlerState[CONFIGURED_HANDLER_KEY];
  return (
    registration !== undefined &&
    registration.handler === globalHandlers[HANDLER_KEY] &&
    (registration.kind === "manual" || (registration.id === id && registration.env === env))
  );
}

export { deactivateGeneratedDataCacheHandler } from "./cache-adapter-registration.js";

const FAILED_HANDLER_REGISTRATIONS_KEY = Symbol.for("vinext.failedCacheHandlerRegistrations");
type FailedRegistrations = {
  objectEnvs: WeakMap<object, Set<string>>;
  otherEnvs: Map<unknown, Set<string>>;
};

function getFailedHandlerRegistrations(): FailedRegistrations {
  const state = globalThis as unknown as Record<PropertyKey, FailedRegistrations | undefined>;
  return (state[FAILED_HANDLER_REGISTRATIONS_KEY] ??= {
    objectEnvs: new WeakMap(),
    otherEnvs: new Map(),
  });
}

function failedRegistrationIds(state: FailedRegistrations, env: unknown): Set<string> {
  if ((typeof env === "object" && env !== null) || typeof env === "function") {
    const objectEnv = env as object;
    let ids = state.objectEnvs.get(objectEnv);
    if (!ids) state.objectEnvs.set(objectEnv, (ids = new Set()));
    return ids;
  }
  let ids = state.otherEnvs.get(env);
  if (!ids) state.otherEnvs.set(env, (ids = new Set()));
  return ids;
}

/** @internal Record a failed generated factory once per exact build/env identity. */
export function markDataCacheAdapterRegistrationFailed(id: string, env: unknown): void {
  failedRegistrationIds(getFailedHandlerRegistrations(), env).add(id);
}

/** @internal Whether the exact generated factory identity already failed. */
export function hasDataCacheAdapterRegistrationFailed(id: string, env: unknown): boolean {
  return failedRegistrationIds(getFailedHandlerRegistrations(), env).has(id);
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
