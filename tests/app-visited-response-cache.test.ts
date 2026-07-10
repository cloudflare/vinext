import { describe, expect, it } from "vite-plus/test";
import {
  MAX_TRAVERSAL_CACHE_TTL,
  VISITED_RESPONSE_CACHE_TTL,
  createVisitedResponseCacheEntry,
  deleteVisitedResponseCacheEntry,
  findVisitedResponseCacheEntry,
  isVisitedResponseCacheEntryCompatibleForNavigation,
  isVisitedResponseCacheEntryCompatibleForPrefetch,
  isVisitedResponseCacheEntryFresh,
} from "../packages/vinext/src/server/app-visited-response-cache.js";
import { AppElementsWire } from "../packages/vinext/src/server/app-elements.js";
import { PREFETCH_CACHE_TTL } from "../packages/vinext/src/shims/navigation.js";
import type { CachedRscResponse } from "../packages/vinext/src/shims/navigation.js";
import type { AppElements } from "../packages/vinext/src/server/app-elements.js";

function createCachedResponse(overrides: Partial<CachedRscResponse> = {}): CachedRscResponse {
  return {
    buffer: new TextEncoder().encode("flight").buffer,
    contentType: "text/x-component",
    paramsHeader: null,
    renderedPathAndSearch: null,
    url: "/dynamic.rsc",
    ...overrides,
  };
}

describe("visited response cache freshness", () => {
  it("uses per-response dynamic stale time for regular navigations", () => {
    // Ported from Next.js: test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      mountedSlotsHeader: "slot:source",
      params: {},
      response: createCachedResponse({ dynamicStaleTimeSeconds: 10 }),
    });

    expect(entry.expiresAt).toBe(now + 10_000);
    expect(entry.mountedSlotsHeader).toBe("slot:source");
    expect(
      isVisitedResponseCacheEntryFresh(entry, {
        navigationKind: "navigate",
        now: now + 9_999,
      }),
    ).toBe(true);
    expect(
      isVisitedResponseCacheEntryFresh(entry, {
        navigationKind: "navigate",
        now: now + 10_000,
      }),
    ).toBe(false);
  });

  it("falls back to the default visited response TTL without server metadata", () => {
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse(),
    });

    expect(entry.expiresAt).toBe(now + VISITED_RESPONSE_CACHE_TTL);
  });

  it("uses the configured dynamic fallback without server metadata", () => {
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      fallbackTtlMs: 0,
      now,
      params: {},
      response: createCachedResponse(),
    });

    expect(entry.expiresAt).toBe(now);
    expect(isVisitedResponseCacheEntryFresh(entry, { navigationKind: "navigate", now })).toBe(
      false,
    );
  });

  it("inherits the expiry carried by a consumed prefetch snapshot", () => {
    const now = 1_000_000;
    const prefetchedExpiresAt = now + 30_000;
    const entry = createVisitedResponseCacheEntry({
      fallbackTtlMs: 0,
      now,
      params: {},
      response: createCachedResponse({
        dynamicStaleTimeSeconds: 0,
        expiresAt: prefetchedExpiresAt,
      }),
    });

    expect(entry.expiresAt).toBe(prefetchedExpiresAt);
    expect(
      isVisitedResponseCacheEntryFresh(entry, {
        navigationKind: "navigate",
        now: now + 29_999,
      }),
    ).toBe(true);
  });

  it("retains decoded committed elements for partial Flight payload reuse", () => {
    // Ported from Next.js: test/e2e/app-dir/app-client-cache/client-cache.original.test.ts
    const elements = { "page:/dynamic": "cached page" } satisfies AppElements;
    const entry = createVisitedResponseCacheEntry({
      elements,
      now: 1_000_000,
      params: {},
      response: createCachedResponse(),
    });

    expect(entry.elements).toBe(elements);
  });

  it("keeps navigation mounted-slot matching strict for entries carrying decoded elements", () => {
    const elements = { "page:/dynamic": "cached page" } satisfies AppElements;
    const entry = createVisitedResponseCacheEntry({
      elements,
      now: 1_000_000,
      mountedSlotsHeader: null,
      params: {},
      response: createCachedResponse(),
    });

    // Entries with decoded elements may satisfy a future full-prefetch claim,
    // but a soft navigation must still respect its current mounted slot context.
    expect(isVisitedResponseCacheEntryCompatibleForNavigation(entry, "slot:modal")).toBe(false);
    expect(isVisitedResponseCacheEntryCompatibleForPrefetch(entry, "slot:modal")).toBe(true);
  });

  it("keeps traversal restores independent from dynamic stale expiry", () => {
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({ dynamicStaleTimeSeconds: 10 }),
    });

    expect(
      isVisitedResponseCacheEntryFresh(entry, {
        navigationKind: "traverse",
        now: now + 20_000,
      }),
    ).toBe(true);
    expect(
      isVisitedResponseCacheEntryFresh(entry, {
        navigationKind: "traverse",
        now: now + MAX_TRAVERSAL_CACHE_TTL,
      }),
    ).toBe(false);
  });

  it("uses static prefetch freshness for full-prefetch visited response reuse", () => {
    // Mirrors Next.js Segment Cache BFCache full-prefetch reuse:
    // packages/next/src/client/components/segment-cache/cache.ts
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      fallbackTtlMs: 0,
      now,
      params: {},
      response: createCachedResponse({ dynamicStaleTimeSeconds: 0 }),
    });

    expect(
      isVisitedResponseCacheEntryFresh(entry, {
        navigationKind: "prefetch",
        now: now + PREFETCH_CACHE_TTL,
      }),
    ).toBe(true);
    expect(
      isVisitedResponseCacheEntryFresh(entry, {
        navigationKind: "prefetch",
        now: now + PREFETCH_CACHE_TTL + 1,
      }),
    ).toBe(false);
  });

  it("never reuses visited responses for refresh navigations", () => {
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({ dynamicStaleTimeSeconds: 60 }),
    });

    expect(
      isVisitedResponseCacheEntryFresh(entry, {
        navigationKind: "refresh",
        now,
      }),
    ).toBe(false);
  });

  it("finds and deletes normalized _rsc variants", () => {
    const cache = new Map<string, ReturnType<typeof createVisitedResponseCacheEntry>>();
    const entry = createVisitedResponseCacheEntry({
      now: 1_000_000,
      params: {},
      response: createCachedResponse(),
    });
    const storedKey = AppElementsWire.encodeCacheKey("/dynamic?_rsc=old", null);
    cache.set(storedKey, entry);

    expect(findVisitedResponseCacheEntry(cache, "/dynamic?_rsc=new", null)).toEqual({
      cacheKey: storedKey,
      entry,
    });

    expect(deleteVisitedResponseCacheEntry(cache, "/dynamic?_rsc=new", null)).toBe(true);
    expect(cache.has(storedKey)).toBe(false);
    expect(findVisitedResponseCacheEntry(cache, "/dynamic?_rsc=new", null)).toBeNull();
  });

  it("keeps normalized _rsc lookup scoped to compatible mounted-slot variants", () => {
    const cache = new Map<string, ReturnType<typeof createVisitedResponseCacheEntry>>();
    const modalEntry = createVisitedResponseCacheEntry({
      now: 1_000_000,
      mountedSlotsHeader: "slot:modal:/",
      params: {},
      response: createCachedResponse(),
    });
    const drawerEntry = createVisitedResponseCacheEntry({
      now: 1_000_000,
      mountedSlotsHeader: "slot:drawer:/",
      params: {},
      response: createCachedResponse(),
    });
    const modalKey = AppElementsWire.encodeCacheKey("/dynamic?_rsc=modal", null);
    const drawerKey = AppElementsWire.encodeCacheKey("/dynamic?_rsc=drawer", null);
    cache.set(modalKey, modalEntry);
    cache.set(drawerKey, drawerEntry);

    expect(
      findVisitedResponseCacheEntry(cache, "/dynamic?_rsc=current", null, {
        mountedSlotsHeader: "slot:drawer:/",
        isEntryCompatible: isVisitedResponseCacheEntryCompatibleForNavigation,
      }),
    ).toEqual({ cacheKey: drawerKey, entry: drawerEntry });

    expect(
      deleteVisitedResponseCacheEntry(cache, "/dynamic?_rsc=current", null, {
        mountedSlotsHeader: "slot:sidebar:/",
        isEntryCompatible: isVisitedResponseCacheEntryCompatibleForNavigation,
      }),
    ).toBe(false);
    expect(cache.has(modalKey)).toBe(true);
    expect(cache.has(drawerKey)).toBe(true);
  });
});
