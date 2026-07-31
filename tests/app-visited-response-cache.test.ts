import { describe, expect, it } from "vite-plus/test";
import {
  MAX_TRAVERSAL_CACHE_TTL,
  VISITED_RESPONSE_CACHE_TTL,
  createVisitedResponseCacheEntry,
  deleteVisitedResponseCacheEntry,
  findVisitedResponseCacheEntry,
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

  it("bounds reuse by the resolved cacheLife stale time from the server", () => {
    // A `use cache` subtree declaring cacheLife("seconds") resolves stale: 30.
    // Without honoring it the browser would hold this response for the full
    // 5-minute visited-response TTL — 10x too long.
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({ serverStaleTime: { kind: "resolved", seconds: 30 } }),
    });

    expect(entry.expiresAt).toBe(now + 30_000);
    expect(
      isVisitedResponseCacheEntryFresh(entry, { navigationKind: "navigate", now: now + 29_999 }),
    ).toBe(true);
    expect(
      isVisitedResponseCacheEntryFresh(entry, { navigationKind: "navigate", now: now + 30_000 }),
    ).toBe(false);
  });

  it("bounds a pending-stale cold navigation at the floor instead of the visited TTL", () => {
    // A pending claim floors to at least 30s, so 30s is the conservative bound.
    // The server always pairs the marker with a dynamic bound (next test);
    // marker-only is the defensive fallback.
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({ serverStaleTime: { kind: "pending" } }),
    });

    expect(entry.expiresAt).toBe(now + 30_000);
  });

  it("applies the dynamic bound over the pending cap when both signals are present", () => {
    // Resolver contract: the min always wins, including a dynamic bound of 0.
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({
        dynamicStaleTimeSeconds: 0,
        serverStaleTime: { kind: "pending" },
      }),
    });

    expect(entry.expiresAt).toBe(now);
    expect(isVisitedResponseCacheEntryFresh(entry, { navigationKind: "navigate", now })).toBe(
      false,
    );
  });

  it("floors a shorter-than-minimum cacheLife stale time like the prefetch cache does", () => {
    // One rule for both client caches, mirroring Next.js's getStaleTimeMs
    // (max(stale, 30s) across the whole segment cache): cacheLife({ stale: 5 })
    // is held 30s whether the route arrived via a prefetch snapshot or a cold
    // navigation. Without the shared floor the same declaration produced two
    // behaviors keyed on whether a prefetch happened to fire first.
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({ serverStaleTime: { kind: "resolved", seconds: 5 } }),
    });

    expect(entry.expiresAt).toBe(now + 30_000);
  });

  it("takes the minimum of the staleTimes config and the resolved cacheLife stale time", () => {
    // Two independent min-wins lattices: experimental.staleTimes (reduced across
    // segments by unstable_dynamicStaleTime) and cacheLife (reduced across
    // `use cache` scopes). Neither may override the other, in either direction.
    const now = 1_000_000;

    expect(
      createVisitedResponseCacheEntry({
        now,
        params: {},
        response: createCachedResponse({
          dynamicStaleTimeSeconds: 120,
          serverStaleTime: { kind: "resolved", seconds: 30 },
        }),
      }).expiresAt,
    ).toBe(now + 30_000);

    expect(
      createVisitedResponseCacheEntry({
        now,
        params: {},
        response: createCachedResponse({
          dynamicStaleTimeSeconds: 10,
          serverStaleTime: { kind: "resolved", seconds: 300 },
        }),
      }).expiresAt,
    ).toBe(now + 10_000);
  });

  it("keeps the configured fallback when the resolved cacheLife declares no stale time", () => {
    // The `default` cacheLife profile has no `stale` and an `expire` of
    // ~136 years. The server advertises nothing in that case, so the entry must
    // stay on the configured visited-response TTL rather than being extended
    // toward revalidate/expire.
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse(),
    });

    expect(entry.expiresAt).toBe(now + VISITED_RESPONSE_CACHE_TTL);
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

  it("deletes a normalized _rsc variant after failed visited reuse so navigation can fall through", () => {
    const cache = new Map<string, ReturnType<typeof createVisitedResponseCacheEntry>>();
    const entry = createVisitedResponseCacheEntry({
      now: 1_000_000,
      params: {},
      response: createCachedResponse(),
    });
    const storedKey = AppElementsWire.encodeCacheKey(
      "/nextjs-compat/client-cache/1?tab=latest&_rsc=old",
      null,
    );
    cache.set(storedKey, entry);

    expect(
      findVisitedResponseCacheEntry(
        cache,
        "/nextjs-compat/client-cache/1?tab=latest&_rsc=new",
        null,
      ),
    ).toEqual({ cacheKey: storedKey, entry });

    expect(
      deleteVisitedResponseCacheEntry(
        cache,
        "/nextjs-compat/client-cache/1?tab=latest&_rsc=new",
        null,
      ),
    ).toBe(true);
    expect(cache.has(storedKey)).toBe(false);
    expect(
      findVisitedResponseCacheEntry(
        cache,
        "/nextjs-compat/client-cache/1?tab=latest&_rsc=new",
        null,
      ),
    ).toBeNull();
  });
});
