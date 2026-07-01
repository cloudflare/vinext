import { describe, expect, it } from "vite-plus/test";
import {
  MAX_TRAVERSAL_CACHE_TTL,
  VISITED_RESPONSE_CACHE_TTL,
  createVisitedResponseCacheEntry,
  deleteVisitedResponseCacheEntry,
  findVisitedResponseCacheEntry,
  hasFreshVisitedResponseCacheEntryForNavigation,
  isVisitedResponseCacheEntryFresh,
} from "../packages/vinext/src/server/app-visited-response-cache.js";
import { AppElementsWire } from "../packages/vinext/src/server/app-elements.js";
import type { CachedRscResponse } from "../packages/vinext/src/shims/navigation.js";
import type { AppElements } from "../packages/vinext/src/server/app-elements.js";

function createCachedResponse(overrides: Partial<CachedRscResponse> = {}): CachedRscResponse {
  return {
    buffer: new TextEncoder().encode("flight").buffer,
    contentType: "text/x-component",
    paramsHeader: null,
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

  it("keeps traversal restores independent from dynamic stale expiry", () => {
    // Ported from Next.js: test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts
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

  it("finds equivalent RSC URL variants for BFCache restores", () => {
    // Ported from Next.js: test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts
    const cache = new Map();
    const entry = createVisitedResponseCacheEntry({
      elements: { "page:/per-page-config/dynamic-stale-60": "cached page" } satisfies AppElements,
      now: 1_000_000,
      params: {},
      response: createCachedResponse({
        dynamicStaleTimeSeconds: 60,
        url: "/per-page-config/dynamic-stale-60?_rsc=prefetched",
      }),
    });
    const cacheKey = AppElementsWire.encodeCacheKey(
      "/per-page-config/dynamic-stale-60?_rsc=prefetched",
      null,
    );
    cache.set(cacheKey, entry);

    expect(
      findVisitedResponseCacheEntry(
        cache,
        "/per-page-config/dynamic-stale-60?_rsc=navigation",
        null,
      ),
    ).toEqual({ cacheKey, entry });
  });

  it("keeps interception contexts distinct when matching RSC URL variants", () => {
    const cache = new Map();
    const feedEntry = createVisitedResponseCacheEntry({
      now: 1_000_000,
      params: {},
      response: createCachedResponse({ url: "/photos/1?_rsc=feed" }),
    });
    const galleryEntry = createVisitedResponseCacheEntry({
      now: 1_000_000,
      params: {},
      response: createCachedResponse({ url: "/photos/1?_rsc=gallery" }),
    });
    const feedKey = AppElementsWire.encodeCacheKey("/photos/1?_rsc=feed", "/feed");
    const galleryKey = AppElementsWire.encodeCacheKey("/photos/1?_rsc=gallery", "/gallery");
    cache.set(feedKey, feedEntry);
    cache.set(galleryKey, galleryEntry);

    expect(findVisitedResponseCacheEntry(cache, "/photos/1?_rsc=next", "/feed")).toEqual({
      cacheKey: feedKey,
      entry: feedEntry,
    });
    expect(deleteVisitedResponseCacheEntry(cache, "/photos/1?_rsc=next", "/feed")).toBe(true);
    expect(cache.has(feedKey)).toBe(false);
    expect(cache.has(galleryKey)).toBe(true);
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

  it("does not report stale visited responses as available for Link prefetch dedupe", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/staleness/segment-cache-stale-time.test.ts
    const now = 1_000_000;
    const cache = new Map();
    const rscUrl = "/stale-2-minutes?_rsc=old";
    const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, null);
    const entry = createVisitedResponseCacheEntry({
      now,
      mountedSlotsHeader: "slot:source",
      params: {},
      response: createCachedResponse({
        dynamicStaleTimeSeconds: 120,
        url: rscUrl,
      }),
    });
    cache.set(cacheKey, entry);

    expect(
      hasFreshVisitedResponseCacheEntryForNavigation(
        cache,
        "/stale-2-minutes?_rsc=new",
        null,
        "slot:source",
        now + 120_001,
      ),
    ).toBe(false);
    expect(cache.has(cacheKey)).toBe(false);
  });

  it("reports fresh visited responses as available for compatible Link prefetch dedupe", () => {
    const now = 1_000_000;
    const cache = new Map();
    const rscUrl = "/stale-4-minutes?_rsc=old";
    const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, null);
    const entry = createVisitedResponseCacheEntry({
      now,
      mountedSlotsHeader: "slot:source",
      params: {},
      response: createCachedResponse({
        dynamicStaleTimeSeconds: 240,
        url: rscUrl,
      }),
    });
    cache.set(cacheKey, entry);

    expect(
      hasFreshVisitedResponseCacheEntryForNavigation(
        cache,
        "/stale-4-minutes?_rsc=new",
        null,
        "slot:source",
        now + 120_001,
      ),
    ).toBe(true);
    expect(cache.get(cacheKey)).toBe(entry);
    expect(
      hasFreshVisitedResponseCacheEntryForNavigation(
        cache,
        "/stale-4-minutes?_rsc=new",
        null,
        "slot:other",
        now + 120_001,
      ),
    ).toBe(false);
    expect(cache.get(cacheKey)).toBe(entry);
  });
});
