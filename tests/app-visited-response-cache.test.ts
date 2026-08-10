import { describe, expect, it } from "vite-plus/test";
import {
  MAX_TRAVERSAL_CACHE_TTL,
  VISITED_RESPONSE_CACHE_TTL,
  cancelPendingCachedNavigationStageFill,
  canPublishCachedNavigationRuntimeStage,
  canStoreCachedNavigationStage,
  createCachedNavigationStageCacheKey,
  createVisitedResponseCacheEntry,
  deleteVisitedResponseCacheEntry,
  findVisitedResponseCacheEntry,
  isCachedNavigationStagePairFresh,
  isVisitedResponseCacheEntryFresh,
  scheduleCachedNavigationStageFills,
  startAuthoritativeCachedNavigationResponse,
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
  it("scopes cached-navigation fills to mounted parallel-slot topology", () => {
    const base = createCachedNavigationStageCacheKey("/target", null, null);
    const modal = createCachedNavigationStageCacheKey("/target", null, "slot:modal:/target");
    const modalAndSidebar = createCachedNavigationStageCacheKey(
      "/target",
      null,
      "slot:sidebar:/target slot:modal:/target",
    );

    expect(new Set([base, modal, modalAndSidebar])).toHaveLength(3);
    expect(modalAndSidebar).toBe(
      createCachedNavigationStageCacheKey(
        "/target",
        null,
        "slot:modal:/target slot:sidebar:/target",
      ),
    );
  });

  it("detaches an expired stage's hanging fill so a later generation can refill", () => {
    const cacheKey = createCachedNavigationStageCacheKey("/target", null, null);
    const staleController = new AbortController();
    const pending = new Map([[cacheKey, { abortController: staleController, generation: 1 }]]);

    expect(cancelPendingCachedNavigationStageFill(pending, cacheKey)).toBe(true);
    expect(staleController.signal.aborted).toBe(true);
    expect(pending.has(cacheKey)).toBe(false);

    const refillController = new AbortController();
    pending.set(cacheKey, { abortController: refillController, generation: 2 });
    expect(pending.get(cacheKey)?.generation).toBe(2);
    expect(refillController.signal.aborted).toBe(false);
  });

  it("rejects cached-navigation stage fills invalidated or version-skewed before storage", () => {
    expect(
      canStoreCachedNavigationStage({
        clientCompatibilityId: "build-a",
        currentGeneration: 2,
        expectedGeneration: 1,
        responseCompatibilityId: "build-a",
      }),
    ).toBe(false);
    expect(
      canStoreCachedNavigationStage({
        clientCompatibilityId: "build-a",
        currentGeneration: 1,
        expectedGeneration: 1,
        responseCompatibilityId: "build-b",
      }),
    ).toBe(false);
    expect(
      canStoreCachedNavigationStage({
        clientCompatibilityId: "build-a",
        currentGeneration: 1,
        expectedGeneration: 1,
        responseCompatibilityId: "build-a",
      }),
    ).toBe(true);
  });

  it("publishes the static stage without awaiting the runtime fill", async () => {
    let finishStatic!: (supportsRuntimeStage: boolean) => void;
    let finishRuntime!: (stored: boolean) => void;
    const requestedStages: string[] = [];
    const fills = scheduleCachedNavigationStageFills((stage) => {
      requestedStages.push(stage);
      return new Promise<boolean>((resolve) => {
        if (stage === "static") finishStatic = resolve;
        else finishRuntime = resolve;
      });
    });
    let staticPublished = false;
    let allComplete = false;
    void fills.staticStage.then(() => {
      staticPublished = true;
    });
    void fills.complete.then(() => {
      allComplete = true;
    });

    expect(requestedStages).toEqual(["static"]);
    finishStatic(true);
    await fills.staticStage;
    expect(staticPublished).toBe(true);
    expect(allComplete).toBe(false);
    expect(requestedStages).toEqual(["static", "runtime"]);

    finishRuntime(true);
    await fills.complete;
    expect(allComplete).toBe(true);
  });

  it("does not gate the authoritative response on hanging cached-stage work", async () => {
    const hangingRuntimeFill = new Promise<void>(() => {});
    const hangingDetachedShellCommit = new Promise<void>(() => {});

    await expect(
      startAuthoritativeCachedNavigationResponse(
        () => Promise.resolve("authoritative"),
        hangingRuntimeFill,
        hangingDetachedShellCommit,
      ),
    ).resolves.toBe("authoritative");
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

  it("keeps the cached-navigation static stage alive past the runtime stage", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts
    // The route's runtime-prefetchable content is stale after 30s, while its
    // public `use cache` subtree remains reusable for 120s. A static-stage
    // entry must not inherit the shorter completed-navigation bound.
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({
        dynamicStaleTimeSeconds: 30,
        serverStaleTime: { kind: "resolved", seconds: 120 },
      }),
      stage: "static",
      stageGeneration: 1,
    });

    expect(entry.expiresAt).toBe(now + 120_000);
    expect(
      isVisitedResponseCacheEntryFresh(entry, {
        navigationKind: "navigate",
        now: now + 60_000,
      }),
    ).toBe(true);
  });

  it("preserves the static stage lifetime while its runtime replacement is still pending", () => {
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({
        serverStaleTime: { kind: "resolved", seconds: 120 },
      }),
      stage: "static",
      stageGeneration: 1,
    });

    expect(entry.expiresAt).toBe(now + 120_000);
  });

  it("expires the published stage pair when its completed runtime refinement is stale", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts
    const now = 1_000_000;
    const staticStage = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({
        serverStaleTime: { kind: "resolved", seconds: 120 },
      }),
      stage: "static",
      stageGeneration: 1,
    });
    const runtimeStage = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({
        serverStaleTime: { kind: "resolved", seconds: 30 },
      }),
      stage: "runtime",
      stageGeneration: 1,
    });

    expect(
      isCachedNavigationStagePairFresh(staticStage, undefined, {
        navigationKind: "navigate",
        now: now + 60_000,
      }),
    ).toBe(true);
    expect(
      isCachedNavigationStagePairFresh(staticStage, runtimeStage, {
        navigationKind: "navigate",
        now: now + 60_000,
      }),
    ).toBe(false);
  });

  it("never pairs a runtime stage from another fill generation", () => {
    const now = 1_000_000;
    const staticStage = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({
        serverStaleTime: { kind: "resolved", seconds: 120 },
      }),
      stage: "static",
      stageGeneration: 2,
    });
    const staleRuntimeStage = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({
        serverStaleTime: { kind: "resolved", seconds: 30 },
      }),
      stage: "runtime",
      stageGeneration: 1,
    });

    expect(canPublishCachedNavigationRuntimeStage(staticStage, 1)).toBe(false);
    expect(canPublishCachedNavigationRuntimeStage(staticStage, 2)).toBe(true);
    expect(
      isCachedNavigationStagePairFresh(staticStage, staleRuntimeStage, {
        navigationKind: "navigate",
        now: now + 60_000,
      }),
    ).toBe(true);
  });

  it("uses the completed cacheLife claim for a runtime stage instead of dynamic stale time", () => {
    const now = 1_000_000;
    const entry = createVisitedResponseCacheEntry({
      now,
      params: {},
      response: createCachedResponse({
        dynamicStaleTimeSeconds: 0,
        serverStaleTime: { kind: "resolved", seconds: 30 },
      }),
      stage: "runtime",
    });

    expect(entry.expiresAt).toBe(now + 30_000);
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
