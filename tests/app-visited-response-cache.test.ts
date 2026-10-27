import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MAX_TRAVERSAL_CACHE_TTL,
  VISITED_RESPONSE_CACHE_TTL,
  createVisitedResponseCacheEntry,
  deleteAllVisitedResponseCacheEntries,
  deleteVisitedResponseCacheEntry,
  findVisitedResponseCacheEntry,
  findVisitedResponseForFullPrefetch,
  hasNavigationResponseHistoryLifetime,
  isVisitedResponseCacheEntryFresh,
  revokeHistoryRestoreNavigationReuse,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("visited response cache freshness", () => {
  it("deletes every cache-busting variant when a visible route response is replaced", () => {
    const entry = createVisitedResponseCacheEntry({
      now: 1_000_000,
      params: {},
      response: createCachedResponse(),
    });
    const cache = new Map([
      ["/dashboard?_rsc=initial", entry],
      ["/dashboard?_rsc=state-a", entry],
      ["/dashboard?_rsc=state-b\0/interception", entry],
      ["/other?_rsc=state-c", entry],
    ]);

    expect(deleteAllVisitedResponseCacheEntries(cache, "/dashboard?_rsc=latest", null)).toBe(2);
    expect([...cache.keys()]).toEqual([
      "/dashboard?_rsc=state-b\0/interception",
      "/other?_rsc=state-c",
    ]);
  });

  it("matches entries for // pathnames by their pathname on the app origin", () => {
    const entry = createVisitedResponseCacheEntry({
      now: 1_000_000,
      params: {},
      response: createCachedResponse(),
    });
    const cache = new Map([["//a//attacker.example/z?_rsc=one", entry]]);

    expect(findVisitedResponseCacheEntry(cache, "//b//attacker.example/z?_rsc=two", null)).toBe(
      null,
    );
    expect(
      findVisitedResponseCacheEntry(cache, "/.//a//attacker.example/z?_rsc=two", null)?.entry,
    ).toBe(entry);
  });

  it("recognizes positive server and dynamic history lifetimes", () => {
    expect(hasNavigationResponseHistoryLifetime(createCachedResponse())).toBe(false);
    expect(
      hasNavigationResponseHistoryLifetime(createCachedResponse({ dynamicStaleTimeSeconds: 0 })),
    ).toBe(false);
    expect(
      hasNavigationResponseHistoryLifetime(createCachedResponse({ dynamicStaleTimeSeconds: 30 })),
    ).toBe(true);
    expect(
      hasNavigationResponseHistoryLifetime(
        createCachedResponse({ serverStaleTime: { kind: "resolved", seconds: 120 } }),
      ),
    ).toBe(true);
  });

  it("retains history-restored entries only when segment-cache reuse is licensed", () => {
    const createEntry = (response: CachedRscResponse, reuseAfterHistoryRestore = false) =>
      createVisitedResponseCacheEntry({
        now: 1_000_000,
        params: {},
        response,
        reuseAfterHistoryRestore,
      });
    const cache = new Map([
      ["/unbounded.rsc", createEntry(createCachedResponse({ url: "/unbounded.rsc" }))],
      [
        "/static.rsc",
        createEntry(
          createCachedResponse({
            url: "/static.rsc",
          }),
          true,
        ),
      ],
      ["/dynamic.rsc", createEntry(createCachedResponse({ dynamicStaleTimeSeconds: 30 }), true)],
      [
        "/expired.rsc",
        createEntry(createCachedResponse({ dynamicStaleTimeSeconds: 0, url: "/expired.rsc" })),
      ],
      ["/intercepted.rsc\0/", createEntry(createCachedResponse({ url: "/intercepted.rsc" }), true)],
    ]);

    revokeHistoryRestoreNavigationReuse(cache);

    expect(
      [...cache].filter(([, entry]) => !entry.navigationReuseRevoked).map(([key]) => key),
    ).toEqual(["/static.rsc", "/dynamic.rsc", "/intercepted.rsc\0/"]);
    // A revoked entry remains the BFCache a full prefetch reads.
    expect(
      findVisitedResponseForFullPrefetch(cache, ["/expired.rsc?_rsc=prefetch"], null, null)
        ?.response,
    ).toBe(cache.get("/expired.rsc")?.response);
  });

  it("finds a full prefetch's visited response by any of its URLs, slot context, and interception", () => {
    const entry = createVisitedResponseCacheEntry({
      now: 1_000_000,
      mountedSlotsHeader: "slot:modal",
      params: {},
      response: createCachedResponse({ mountedSlotsHeader: "slot:modal" }),
    });
    const cache = new Map([["/dynamic.rsc?_rsc=navigation", entry]]);

    expect(
      findVisitedResponseForFullPrefetch(
        cache,
        ["/other.rsc?_rsc=a", "/dynamic.rsc?_rsc=b"],
        null,
        "slot:modal",
      ),
    ).toEqual({ navigatedAt: 1_000_000, navigationFreshUntil: null, response: entry.response });
    expect(findVisitedResponseForFullPrefetch(cache, ["/dynamic.rsc?_rsc=b"], null, null)).toBe(
      null,
    );
    expect(
      findVisitedResponseForFullPrefetch(cache, ["/dynamic.rsc?_rsc=b"], "/feed", "slot:modal"),
    ).toBe(null);
  });

  it("dates a full prefetch's visited response from when its payload arrived", () => {
    // A navigation that committed a payload prefetched at 1_000_000 does not
    // make that data fresh again for a later full prefetch.
    const response = createCachedResponse({ receivedAt: 1_000_000 });
    const entry = createVisitedResponseCacheEntry({
      now: 1_030_000,
      params: {},
      response,
    });
    const cache = new Map([["/dynamic.rsc?_rsc=navigation", entry]]);

    expect(findVisitedResponseForFullPrefetch(cache, ["/dynamic.rsc"], null, null)).toEqual({
      navigatedAt: 1_000_000,
      navigationFreshUntil: null,
      response,
    });
  });

  it("says until when a navigation would still reuse a full prefetch's visited response", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/optimistic-route-cache-keying-regression/optimistic-route-cache-keying-regression.test.ts
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      mountedSlotsHeader: "slot:modal",
      params: {},
      response: createCachedResponse({ dynamicStaleTimeSeconds: 180 }),
    });
    const cache = new Map([["/photo/1.rsc?_rsc=navigation", entry]]);
    const navigationFreshUntil = (mountedSlotsHeader: string | null = "slot:modal") =>
      findVisitedResponseForFullPrefetch(
        cache,
        ["/photo/1.rsc?_rsc=prefetch"],
        null,
        mountedSlotsHeader,
      )?.navigationFreshUntil;

    vi.spyOn(Date, "now").mockReturnValue(now + 179_999);
    expect(navigationFreshUntil()).toBe(now + 180_000);
    vi.spyOn(Date, "now").mockReturnValue(now + 180_000);
    expect(navigationFreshUntil()).toBe(null);

    // The navigation needs the slot context it was requested with, even when
    // the response declares the one asked for.
    vi.spyOn(Date, "now").mockReturnValue(now);
    entry.response = { ...entry.response, mountedSlotsHeader: null };
    expect(navigationFreshUntil(null)).toBe(null);
    expect(navigationFreshUntil()).toBe(now + 180_000);

    // A history restore revoked its navigation reuse.
    entry.navigationReuseRevoked = true;
    expect(navigationFreshUntil()).toBe(null);
  });

  it("never reports initial hydration's visited response as navigation-fresh", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/app-client-cache/client-cache.parallel-routes.test.ts
    // A visible Link to the page just loaded still prefetches it.
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const entry = createVisitedResponseCacheEntry({
      fromHydration: true,
      now,
      params: {},
      response: createCachedResponse({ dynamicStaleTimeSeconds: 180 }),
    });
    const cache = new Map([["/photo/1.rsc", entry]]);

    expect(
      findVisitedResponseForFullPrefetch(cache, ["/photo/1.rsc"], null, null)?.navigationFreshUntil,
    ).toBe(null);
  });

  it("replays a full prefetch's committed elements and matches the response-declared slots", () => {
    const elements = { "page:/dynamic": "committed" } as unknown as AppElements;
    const committed = createVisitedResponseCacheEntry({
      elements,
      now: 1_000_000,
      mountedSlotsHeader: "slot:old",
      params: {},
      response: createCachedResponse({ url: "/committed.rsc" }),
    });
    const declared = createVisitedResponseCacheEntry({
      now: 1_000_000,
      mountedSlotsHeader: "slot:request",
      params: {},
      response: createCachedResponse({ mountedSlotsHeader: "slot:modal", url: "/declared.rsc" }),
    });
    const cache = new Map([
      ["/committed.rsc", committed],
      ["/declared.rsc", declared],
    ]);

    // A possibly skip-pruned response replays its committed tree instead.
    expect(
      findVisitedResponseForFullPrefetch(cache, ["/committed.rsc"], null, "slot:modal")?.response,
    ).toEqual({ ...committed.response, preparedElements: elements });
    expect(
      findVisitedResponseForFullPrefetch(cache, ["/declared.rsc"], null, "slot:modal")?.response,
    ).toBe(declared.response);
    expect(findVisitedResponseForFullPrefetch(cache, ["/declared.rsc"], null, null)).toBe(null);
  });

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
