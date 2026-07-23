/**
 * Prefetch cache eviction tests.
 *
 * Verifies that storePrefetchResponse() sweeps expired entries before
 * falling back to FIFO eviction, preventing expired entries from wasting
 * cache slots on link-heavy pages.
 *
 * The navigation module computes `isServer = typeof window === "undefined"`
 * at load time, so we must set globalThis.window BEFORE importing it via
 * vi.resetModules() + dynamic import().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { AppElementsWire } from "../packages/vinext/src/server/app-elements.js";
import { VINEXT_RSC_COMPATIBILITY_ID_HEADER } from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import {
  VINEXT_DYNAMIC_STALE_TIME_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RENDERED_PATH_AND_SEARCH_HEADER,
} from "../packages/vinext/src/server/headers.js";

type Navigation = typeof import("../packages/vinext/src/shims/navigation.js");
let storePrefetchResponse: Navigation["storePrefetchResponse"];
let consumePrefetchResponse: Navigation["consumePrefetchResponse"];
let getPrefetchCache: Navigation["getPrefetchCache"];
let getPrefetchedUrls: Navigation["getPrefetchedUrls"];
let getCurrentInterceptionContext: Navigation["getCurrentInterceptionContext"];
let MAX_PREFETCH_CACHE_SIZE: Navigation["MAX_PREFETCH_CACHE_SIZE"];
let PREFETCH_CACHE_TTL: Navigation["PREFETCH_CACHE_TTL"];
let DYNAMIC_NAVIGATION_CACHE_TTL: Navigation["DYNAMIC_NAVIGATION_CACHE_TTL"];
let snapshotRscResponse: Navigation["snapshotRscResponse"];
let restoreRscResponse: Navigation["restoreRscResponse"];
let prefetchRscResponse: Navigation["prefetchRscResponse"];
let invalidatePrefetchCache: Navigation["invalidatePrefetchCache"];
let hasPrefetchCacheEntryForNavigation: Navigation["hasPrefetchCacheEntryForNavigation"];
let hasSearchAgnosticPrefetchShellForRoute: Navigation["hasSearchAgnosticPrefetchShellForRoute"];
let peekPrefetchResponseForNavigation: Navigation["peekPrefetchResponseForNavigation"];
let appRouterInstance: Navigation["appRouterInstance"];
let consumePrefetchResponseForNavigation: Navigation["consumePrefetchResponseForNavigation"];
let seedPrefetchResponseSnapshot: Navigation["seedPrefetchResponseSnapshot"];

beforeEach(async () => {
  // Set window BEFORE importing so isServer evaluates to false
  (globalThis as any).window = {
    __VINEXT_RSC_PREFETCH_CACHE__: new Map(),
    __VINEXT_RSC_PREFETCHED_URLS__: new Set(),
    location: {
      origin: "http://localhost",
      pathname: "/",
      search: "",
      hash: "",
      href: "http://localhost/",
    },
    navigator: { userAgent: "Mozilla/5.0" },
    addEventListener: () => {},
    history: { pushState: () => {}, replaceState: () => {}, state: null },
    dispatchEvent: () => {},
  };
  vi.resetModules();
  const nav = await import("../packages/vinext/src/shims/navigation.js");
  storePrefetchResponse = nav.storePrefetchResponse;
  consumePrefetchResponse = nav.consumePrefetchResponse;
  getPrefetchCache = nav.getPrefetchCache;
  getPrefetchedUrls = nav.getPrefetchedUrls;
  getCurrentInterceptionContext = nav.getCurrentInterceptionContext;
  MAX_PREFETCH_CACHE_SIZE = nav.MAX_PREFETCH_CACHE_SIZE;
  PREFETCH_CACHE_TTL = nav.PREFETCH_CACHE_TTL;
  DYNAMIC_NAVIGATION_CACHE_TTL = nav.DYNAMIC_NAVIGATION_CACHE_TTL;
  snapshotRscResponse = nav.snapshotRscResponse;
  restoreRscResponse = nav.restoreRscResponse;
  prefetchRscResponse = nav.prefetchRscResponse;
  invalidatePrefetchCache = nav.invalidatePrefetchCache;
  hasPrefetchCacheEntryForNavigation = nav.hasPrefetchCacheEntryForNavigation;
  hasSearchAgnosticPrefetchShellForRoute = nav.hasSearchAgnosticPrefetchShellForRoute;
  peekPrefetchResponseForNavigation = nav.peekPrefetchResponseForNavigation;
  appRouterInstance = nav.appRouterInstance;
  consumePrefetchResponseForNavigation = nav.consumePrefetchResponseForNavigation;
  seedPrefetchResponseSnapshot = nav.seedPrefetchResponseSnapshot;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
  delete (globalThis as any).fetch;
});

/** Helper: fill cache with `count` entries at a given timestamp. */
function fillCache(
  count: number,
  timestamp: number,
  keyPrefix = "/page-",
  bytesPerEntry = 1,
): void {
  const cache = getPrefetchCache();
  const prefetched = getPrefetchedUrls();
  for (let i = 0; i < count; i++) {
    const key = `${keyPrefix}${i}.rsc`;
    const buffer = new ArrayBuffer(bytesPerEntry);
    cache.set(key, {
      snapshot: {
        buffer,
        contentType: "text/x-component",
        paramsHeader: null,
        renderedPathAndSearch: null,
        url: key,
      },
      outcome: "cache-seeded",
      timestamp,
    });
    prefetched.add(key);
  }
}

function createDeferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve: (response: Response) => void = () => {
    throw new Error("Deferred response was not initialized");
  };
  const promise = new Promise<Response>((resolveInner) => {
    resolve = resolveInner;
  });
  return { promise, resolve };
}

async function waitForPrefetchSetup(isReady: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + 1_000;

  do {
    await Promise.resolve();
    if (isReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  } while (Date.now() < deadline);
}

describe("prefetch cache eviction", () => {
  it("router.prefetch does not fetch for a bot user agent", async () => {
    const fetch = vi.fn();
    (globalThis as any).fetch = fetch;
    (globalThis as any).window.navigator.userAgent =
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

    appRouterInstance.prefetch("/dashboard");
    await waitForPrefetchSetup();

    expect(fetch).not.toHaveBeenCalled();
    expect(getPrefetchedUrls().size).toBe(0);
  });

  it("router.prefetch ignores external absolute URLs", async () => {
    const fetch = vi.fn();
    (globalThis as any).fetch = fetch;

    appRouterInstance.prefetch("https://external.example/dashboard");
    await waitForPrefetchSetup();

    expect(fetch).not.toHaveBeenCalled();
    expect(getPrefetchedUrls().size).toBe(0);
  });

  it("router.prefetch normalizes same-origin absolute URLs before caching", async () => {
    let fetchedUrl: unknown;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      fetchedUrl = input;
      return new Response("flight", { headers: { "content-type": "text/x-component" } });
    });
    (globalThis as any).fetch = fetch;

    appRouterInstance.prefetch("http://localhost/dashboard?tab=1");
    await waitForPrefetchSetup(() => fetch.mock.calls.length > 0);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetchedUrl).toMatch(/^\/dashboard\?tab=1&_rsc(?:=.+)?$/);
    expect(getPrefetchedUrls().has(AppElementsWire.encodeCacheKey(String(fetchedUrl), null))).toBe(
      true,
    );
  });

  it("router.prefetch calls onInvalidate once when the prefetched response is invalidated", async () => {
    let fetchedUrl: unknown;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      fetchedUrl = input;
      return new Response("flight", { headers: { "content-type": "text/x-component" } });
    });
    const onInvalidate = vi.fn();
    (globalThis as any).fetch = fetch;

    appRouterInstance.prefetch("/dashboard", { onInvalidate });
    await waitForPrefetchSetup(() => getPrefetchCache().size > 0);

    const cacheKey = AppElementsWire.encodeCacheKey(String(fetchedUrl), null);
    expect(getPrefetchedUrls().has(cacheKey)).toBe(true);

    invalidatePrefetchCache();

    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(getPrefetchedUrls().has(cacheKey)).toBe(false);
    expect(getPrefetchCache().has(cacheKey)).toBe(false);

    invalidatePrefetchCache();
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it("router.prefetch preserves onInvalidate callbacks attached to an already-prefetched URL", async () => {
    const fetch = vi.fn(
      async () => new Response("flight", { headers: { "content-type": "text/x-component" } }),
    );
    const firstInvalidate = vi.fn();
    const secondInvalidate = vi.fn();
    (globalThis as any).fetch = fetch;

    appRouterInstance.prefetch("/dashboard", { onInvalidate: firstInvalidate });
    await waitForPrefetchSetup(() => getPrefetchCache().size > 0);
    appRouterInstance.prefetch("/dashboard", { onInvalidate: secondInvalidate });
    await waitForPrefetchSetup(() => {
      const entry = getPrefetchCache().values().next().value;
      return entry?.onInvalidateCallbacks?.size === 2;
    });

    expect(fetch).toHaveBeenCalledTimes(1);

    invalidatePrefetchCache();

    expect(firstInvalidate).toHaveBeenCalledTimes(1);
    expect(secondInvalidate).toHaveBeenCalledTimes(1);
  });

  it("reuses a prefetched response only when mounted-slot context matches", () => {
    const cache = getPrefetchCache();
    const prefetched = getPrefetchedUrls();
    const rscUrl = "/dashboard.rsc";
    const snapshot = {
      buffer: new TextEncoder().encode("flight").buffer,
      contentType: "text/x-component",
      mountedSlotsHeader: "slot:auth:/",
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: rscUrl,
    };

    cache.set(rscUrl, { outcome: "cache-seeded", snapshot, timestamp: Date.now() });
    prefetched.add(rscUrl);

    expect(consumePrefetchResponse(rscUrl, null, "slot:auth:/")).toEqual(snapshot);
    expect(cache.has(rscUrl)).toBe(false);
    expect(prefetched.has(rscUrl)).toBe(false);
  });

  it("rejects a prefetched response when mounted-slot context differs", () => {
    const cache = getPrefetchCache();
    const prefetched = getPrefetchedUrls();
    const rscUrl = "/dashboard.rsc";

    cache.set(rscUrl, {
      outcome: "cache-seeded",
      snapshot: {
        buffer: new TextEncoder().encode("flight").buffer,
        contentType: "text/x-component",
        mountedSlotsHeader: "slot:auth:/",
        paramsHeader: null,
        renderedPathAndSearch: null,
        url: rscUrl,
      },
      timestamp: Date.now(),
    });
    prefetched.add(rscUrl);

    expect(consumePrefetchResponse(rscUrl, null, "slot:nav:/")).toBeNull();
    expect(cache.has(rscUrl)).toBe(false);
    expect(prefetched.has(rscUrl)).toBe(false);
  });

  it("preserves server mounted-slot metadata separately from prefetch request context", async () => {
    const rscUrl = "/parallel-slots.rsc";
    const responseMountedSlotsHeader = "slot:slotA:/parallel-slots slot:slotB:/parallel-slots";

    prefetchRscResponse(
      rscUrl,
      Promise.resolve(
        new Response("flight", {
          headers: {
            "content-type": "text/x-component",
            [VINEXT_MOUNTED_SLOTS_HEADER]: responseMountedSlotsHeader,
          },
        }),
      ),
      null,
      null,
    );

    await waitForPrefetchSetup(() => getPrefetchCache().get(rscUrl)?.outcome === "cache-seeded");

    const entry = getPrefetchCache().get(rscUrl);
    expect(entry?.mountedSlotsHeader).toBeNull();

    const consumed = consumePrefetchResponse(rscUrl, null, null);
    expect(consumed?.mountedSlotsHeader).toBe(responseMountedSlotsHeader);
  });

  it("matches equivalent RSC cache variants by server-declared mounted slots", () => {
    const cache = getPrefetchCache();
    const prefetched = getPrefetchedUrls();
    const originalRscUrl = "/parallel-slots.rsc?_rsc";
    const mountedVariantRscUrl = "/parallel-slots.rsc?_rsc=mounted-slot-hash";
    const mountedSlotsHeader = "slot:slotA:/parallel-slots slot:slotB:/parallel-slots";
    const snapshot = {
      buffer: new TextEncoder().encode("parallel-flight").buffer,
      contentType: "text/x-component",
      mountedSlotsHeader,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: originalRscUrl,
    };

    cache.set(originalRscUrl, {
      mountedSlotsHeader: null,
      outcome: "cache-seeded",
      snapshot,
      timestamp: Date.now(),
    });
    prefetched.add(originalRscUrl);

    expect(hasPrefetchCacheEntryForNavigation(mountedVariantRscUrl, null, mountedSlotsHeader)).toBe(
      true,
    );
    expect(consumePrefetchResponse(mountedVariantRscUrl, null, mountedSlotsHeader)).toEqual(
      snapshot,
    );
    expect(cache.has(originalRscUrl)).toBe(false);
    expect(prefetched.has(originalRscUrl)).toBe(false);
  });

  it("keeps learning-only prefetch responses out of navigation consumption", () => {
    const cache = getPrefetchCache();
    const prefetched = getPrefetchedUrls();
    const rscUrl = "/blog/hello.rsc";

    cache.set(rscUrl, {
      cacheForNavigation: false,
      outcome: "cache-seeded",
      snapshot: {
        buffer: new TextEncoder().encode("flight").buffer,
        contentType: "text/x-component",
        mountedSlotsHeader: null,
        paramsHeader: null,
        renderedPathAndSearch: null,
        url: rscUrl,
      },
      timestamp: Date.now(),
    });
    prefetched.add(rscUrl);

    expect(consumePrefetchResponse(rscUrl, null, null)).toBeNull();
    expect(cache.has(rscUrl)).toBe(true);
    expect(prefetched.has(rscUrl)).toBe(true);
  });

  it("keeps route-tree prefetch responses out of navigation consumption", async () => {
    const routeTreeUrl = "/dashboard.rsc?_rsc=tree";
    const deferred = createDeferredResponse();

    prefetchRscResponse(routeTreeUrl, deferred.promise, null, null, undefined, {
      cacheForNavigation: false,
      prefetchKind: "route-tree",
    });

    deferred.resolve(new Response("tree", { headers: { "content-type": "text/x-component" } }));
    await waitForPrefetchSetup(
      () =>
        getPrefetchCache().get(routeTreeUrl)?.outcome === "cache-seeded" &&
        getPrefetchCache().get(routeTreeUrl)?.pending === undefined,
    );

    const entry = getPrefetchCache().get(routeTreeUrl);
    expect(entry?.prefetchKind).toBe("route-tree");
    expect(entry?.optimisticRouteShell).toBe(false);
    expect(hasPrefetchCacheEntryForNavigation("/dashboard.rsc", null, null)).toBe(false);
    expect(consumePrefetchResponse("/dashboard.rsc", null, null)).toBeNull();
    expect(getPrefetchCache().has(routeTreeUrl)).toBe(true);
  });

  it("derives the interception context from the current pathname", () => {
    (globalThis as any).window.location.pathname = "/feed";

    expect(getCurrentInterceptionContext()).toBe("/feed");
  });

  it("allows separate interception-context entries for the same RSC URL", () => {
    storePrefetchResponse("/photos/42.rsc", new Response("feed"), "/feed");
    storePrefetchResponse("/photos/42.rsc", new Response("gallery"), "/gallery");

    const feedKey = AppElementsWire.encodeCacheKey("/photos/42.rsc", "/feed");
    const galleryKey = AppElementsWire.encodeCacheKey("/photos/42.rsc", "/gallery");
    expect(feedKey).not.toBe(galleryKey);
    expect(getPrefetchCache().has(feedKey)).toBe(true);
    expect(getPrefetchCache().has(galleryKey)).toBe(true);
  });

  it("preserves RSC metadata when replaying cached responses", async () => {
    const response = new Response("flight", {
      headers: {
        "content-type": "text/x-component",
        [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "compat-a",
        [VINEXT_DYNAMIC_STALE_TIME_HEADER]: "60",
        "x-vinext-params": encodeURIComponent('{"id":"2"}'),
      },
    });

    const snapshot = await snapshotRscResponse(response);
    const restored = restoreRscResponse(snapshot);

    expect(snapshot.dynamicStaleTimeSeconds).toBe(60);
    expect(restored.headers.get("content-type")).toBe("text/x-component");
    expect(restored.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe("compat-a");
    expect(restored.headers.get(VINEXT_DYNAMIC_STALE_TIME_HEADER)).toBe("60");
    expect(restored.headers.get("x-vinext-params")).toBe(encodeURIComponent('{"id":"2"}'));
    await expect(restored.text()).resolves.toBe("flight");
  });

  it("releases queued App prefetch fetch slots after consuming the response body", async () => {
    let closeBody!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("flight"));
        closeBody = () => controller.close();
      },
    });
    const response = new Response(body, {
      headers: { "content-type": "text/x-component" },
    });
    const release = vi.fn();
    (response as Response & Record<symbol, (() => void) | undefined>)[
      Symbol.for("vinext.appPrefetchFetchSlotRelease")
    ] = release;

    const snapshotPromise = snapshotRscResponse(response);
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();

    closeBody();
    await expect(
      snapshotPromise.then((snapshot) => restoreRscResponse(snapshot).text()),
    ).resolves.toBe("flight");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("settles router.prefetch as a learning-only protocol response without visible navigation", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    let fetchedUrl: RequestInfo | URL | undefined;
    const fetch = vi.fn((input: RequestInfo | URL) => {
      fetchedUrl = input;
      return fetchPromise;
    });
    const navigate = vi.fn();
    (globalThis as any).fetch = fetch;
    (globalThis as any).window[Symbol.for("vinext.navigationRuntime")] = {
      bootstrap: {
        routeManifest: null,
        rsc: undefined,
      },
      functions: {
        navigate,
      },
    };

    appRouterInstance.prefetch("/dashboard");
    await waitForPrefetchSetup(() => fetch.mock.calls.length > 0);

    if (fetchedUrl === undefined) {
      throw new Error("Expected router.prefetch to fetch an RSC URL");
    }

    const rscUrl =
      typeof fetchedUrl === "string"
        ? fetchedUrl
        : fetchedUrl instanceof URL
          ? fetchedUrl.href
          : fetchedUrl.url;
    const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, null);

    expect(getPrefetchCache().get(cacheKey)?.outcome).toBe("pending");

    resolveResponse(new Response("flight", { headers: { "content-type": "text/x-component" } }));
    await waitForPrefetchSetup(
      () =>
        getPrefetchCache().get(cacheKey)?.outcome === "cache-seeded" &&
        getPrefetchCache().get(cacheKey)?.pending === undefined,
    );

    const entry = getPrefetchCache().get(cacheKey);
    expect(entry?.outcome).toBe("cache-seeded");
    expect(entry?.pending).toBeUndefined();
    expect(entry?.cacheForNavigation).toBe(false);
    expect(entry?.optimisticRouteShell).toBe(true);

    const consumed = consumePrefetchResponse(rscUrl, null, null);
    expect(consumed).toBeNull();
    expect(getPrefetchCache().has(cacheKey)).toBe(true);
    expect(getPrefetchedUrls().has(cacheKey)).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("limits low-priority router.prefetch requests until queued responses are snapshotted", async () => {
    const deferredResponses: Array<{
      resolve: (response: Response) => void;
      promise: Promise<Response>;
    }> = [];
    const fetch = vi.fn(() => {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((resolveInner) => {
        resolve = resolveInner;
      });
      deferredResponses.push({ promise, resolve });
      return promise;
    });
    (globalThis as any).fetch = fetch;

    for (let i = 0; i < 5; i++) {
      appRouterInstance.prefetch(`/dashboard-${i}`);
    }

    await waitForPrefetchSetup(() => fetch.mock.calls.length === 4);
    expect(fetch).toHaveBeenCalledTimes(4);

    deferredResponses[0].resolve(
      new Response("flight", { headers: { "content-type": "text/x-component" } }),
    );

    await waitForPrefetchSetup(() => fetch.mock.calls.length === 5);
    expect(fetch).toHaveBeenCalledTimes(5);

    for (const deferred of deferredResponses.slice(1)) {
      deferred.resolve(new Response("flight", { headers: { "content-type": "text/x-component" } }));
    }
  });

  it("awaits an in-flight prefetch instead of missing the navigation cache", async () => {
    const rscUrl = "/dashboard.rsc";
    const deferred = createDeferredResponse();
    let settled = false;

    prefetchRscResponse(rscUrl, deferred.promise, null, null);

    const consumedPromise = consumePrefetchResponseForNavigation(rscUrl, null, null).then(
      (snapshot) => {
        settled = true;
        return snapshot;
      },
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(getPrefetchCache().get(rscUrl)?.outcome).toBe("pending");

    deferred.resolve(new Response("flight", { headers: { "content-type": "text/x-component" } }));

    const consumed = await consumedPromise;
    expect(settled).toBe(true);
    expect(consumed).not.toBeNull();
    if (consumed === null) return;
    await expect(restoreRscResponse(consumed).text()).resolves.toBe("flight");
    expect(getPrefetchCache().has(rscUrl)).toBe(false);
    expect(getPrefetchedUrls().has(rscUrl)).toBe(false);
  });

  it("honors an explicit fallback stale window above the minimum for prefetched responses", async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const rscUrl = "/auto-full.rsc";

    prefetchRscResponse(
      rscUrl,
      Promise.resolve(new Response("flight", { headers: { "content-type": "text/x-component" } })),
      null,
      null,
      undefined,
      { fallbackTtlMs: 60_000 },
    );
    await getPrefetchCache().get(rscUrl)?.pending;

    expect(getPrefetchCache().get(rscUrl)?.expiresAt).toBe(now + 60_000);
  });

  it("floors explicit fallback stale windows for prefetched responses", async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const rscUrl = "/short-static-stale-prefetch.rsc";

    prefetchRscResponse(
      rscUrl,
      Promise.resolve(new Response("flight", { headers: { "content-type": "text/x-component" } })),
      null,
      null,
      undefined,
      { fallbackTtlMs: 5_000 },
    );
    await getPrefetchCache().get(rscUrl)?.pending;

    // Ported from Next.js segment-cache prefetch behavior:
    // packages/next/src/client/components/segment-cache/cache.ts:getStaleTimeMs
    // clamps all configured prefetch stale times to at least 30s.
    expect(getPrefetchCache().get(rscUrl)?.expiresAt).toBe(now + 30_000);
  });

  it("uses Next.js's minimum prefetch stale window for server stale time zero", async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const rscUrl = "/zero-stale-prefetch.rsc";

    prefetchRscResponse(
      rscUrl,
      Promise.resolve(
        new Response("flight", {
          headers: {
            "content-type": "text/x-component",
            [VINEXT_DYNAMIC_STALE_TIME_HEADER]: "0",
          },
        }),
      ),
      null,
      null,
      undefined,
      { fallbackTtlMs: PREFETCH_CACHE_TTL },
    );
    await getPrefetchCache().get(rscUrl)?.pending;

    // Ported from Next.js segment-cache prefetch behavior:
    // packages/next/src/client/components/segment-cache/cache.ts:getStaleTimeMs
    // clamps prefetch stale time to at least 30s so too-short server stale
    // times do not prevent prefetching from being useful.
    expect(getPrefetchCache().get(rscUrl)?.expiresAt).toBe(now + 30_000);

    const consumed = consumePrefetchResponse(rscUrl, null, null);
    expect(consumed?.expiresAt).toBe(now + 30_000);
  });

  it("leaves a resolved in-flight prefetch for a newer navigation when the old navigation is stale", async () => {
    const rscUrl = "/dashboard.rsc";
    const deferred = createDeferredResponse();
    let currentNavigation = true;

    prefetchRscResponse(rscUrl, deferred.promise, null, null);

    const staleNavigationConsume = consumePrefetchResponseForNavigation(rscUrl, null, null, {
      shouldConsume: () => currentNavigation,
    });

    await Promise.resolve();
    currentNavigation = false;
    deferred.resolve(new Response("flight", { headers: { "content-type": "text/x-component" } }));

    await expect(staleNavigationConsume).resolves.toBeNull();
    expect(getPrefetchCache().get(rscUrl)?.outcome).toBe("cache-seeded");

    const consumed = await consumePrefetchResponseForNavigation(rscUrl, null, null);
    expect(consumed).not.toBeNull();
    if (consumed === null) return;
    await expect(restoreRscResponse(consumed).text()).resolves.toBe("flight");
    expect(getPrefetchCache().has(rscUrl)).toBe(false);
    expect(getPrefetchedUrls().has(rscUrl)).toBe(false);
  });

  it("sweeps expired entries before applying the byte LRU", () => {
    // Use fixed arbitrary values to avoid any dependency on the real wall clock
    const now = 1_000_000;
    const expired = now - PREFETCH_CACHE_TTL - 1_000; // 31s before `now`

    fillCache(2, expired, "/expired-", MAX_PREFETCH_CACHE_SIZE / 2);
    expect(getPrefetchCache().size).toBe(2);
    expect(getPrefetchedUrls().size).toBe(2);

    vi.spyOn(Date, "now").mockReturnValue(now);
    seedPrefetchResponseSnapshot("/new.rsc", {
      buffer: new TextEncoder().encode("new").buffer,
      contentType: "text/x-component",
      mountedSlotsHeader: null,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: "/new.rsc",
    });

    const cache = getPrefetchCache();
    expect(cache.size).toBe(1);
    expect(cache.has("/new.rsc")).toBe(true);
    // Evicted entries should be removed; the newly seeded entry remains.
    expect(getPrefetchedUrls().size).toBe(1);
  });

  it("evicts least-recently-used prefetched payloads by buffered byte size", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/memory-pressure/segment-cache-memory-pressure.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/memory-pressure/segment-cache-memory-pressure.test.ts
    // Use fixed arbitrary values to avoid any dependency on the real wall clock
    const now = 1_000_000;

    const oneMiB = 1024 * 1024;
    fillCache(51, now, "/page-", oneMiB);
    expect(getPrefetchCache().size).toBe(51);
    expect(getPrefetchedUrls().size).toBe(51);

    vi.spyOn(Date, "now").mockReturnValue(now);
    seedPrefetchResponseSnapshot("/new.rsc", {
      buffer: new ArrayBuffer(oneMiB),
      contentType: "text/x-component",
      mountedSlotsHeader: null,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: "/new.rsc",
    });

    const cache = getPrefetchCache();
    // 52 MiB exceeds the 50 MiB limit, so cleanup trims back to 90% capacity.
    expect(cache.size).toBe(45);
    expect(cache.has("/new.rsc")).toBe(true);
    expect(cache.has("/page-0.rsc")).toBe(false);
    expect(cache.has("/page-6.rsc")).toBe(false);
    expect(cache.has("/page-7.rsc")).toBe(true);
    expect(getPrefetchedUrls().has("/page-0.rsc")).toBe(false);
  });

  it("keeps recently touched entries during byte LRU cleanup", () => {
    // Use fixed arbitrary values to avoid any dependency on the real wall clock
    const now = 1_000_000;
    const oneMiB = 1024 * 1024;

    fillCache(51, now, "/page-", oneMiB);
    expect(getPrefetchCache().size).toBe(51);

    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(hasPrefetchCacheEntryForNavigation("/page-1.rsc")).toBe(true);
    seedPrefetchResponseSnapshot("/new.rsc", {
      buffer: new ArrayBuffer(oneMiB),
      contentType: "text/x-component",
      mountedSlotsHeader: null,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: "/new.rsc",
    });

    const cache = getPrefetchCache();
    expect(cache.has("/page-0.rsc")).toBe(false);
    expect(cache.has("/page-1.rsc")).toBe(true);
    expect(getPrefetchedUrls().has("/page-0.rsc")).toBe(false);
    expect(getPrefetchedUrls().has("/page-1.rsc")).toBe(true);
  });

  it("skips pending prefetches when byte LRU cleanup needs to free memory", async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const pendingRscUrl = "/pending.rsc";
    const largeRscUrl = "/large.rsc";
    const pending = createDeferredResponse();

    prefetchRscResponse(pendingRscUrl, pending.promise, null, null);
    expect(getPrefetchCache().get(pendingRscUrl)?.outcome).toBe("pending");

    seedPrefetchResponseSnapshot(largeRscUrl, {
      buffer: new ArrayBuffer(MAX_PREFETCH_CACHE_SIZE + 1024 * 1024),
      contentType: "text/x-component",
      mountedSlotsHeader: null,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: largeRscUrl,
    });

    expect(getPrefetchCache().get(pendingRscUrl)?.outcome).toBe("pending");
    expect(getPrefetchCache().has(largeRscUrl)).toBe(false);

    pending.resolve(new Response("flight", { headers: { "content-type": "text/x-component" } }));
    await waitForPrefetchSetup(
      () => getPrefetchCache().get(pendingRscUrl)?.outcome === "cache-seeded",
    );
  });

  it("subtracts overwritten prefetch entries before applying the byte LRU", async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const largeRscUrl = "/large.rsc";

    seedPrefetchResponseSnapshot(largeRscUrl, {
      buffer: new ArrayBuffer(MAX_PREFETCH_CACHE_SIZE - 1024 * 1024),
      contentType: "text/x-component",
      mountedSlotsHeader: null,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: largeRscUrl,
    });

    storePrefetchResponse(largeRscUrl, new Response("x"));
    await waitForPrefetchSetup(
      () =>
        getPrefetchCache().get(largeRscUrl)?.outcome === "cache-seeded" &&
        getPrefetchCache().get(largeRscUrl)?.pending === undefined,
    );

    seedPrefetchResponseSnapshot("/small.rsc", {
      buffer: new ArrayBuffer(2 * 1024 * 1024),
      contentType: "text/x-component",
      mountedSlotsHeader: null,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: "/small.rsc",
    });

    expect(getPrefetchCache().has(largeRscUrl)).toBe(true);
    expect(getPrefetchCache().has("/small.rsc")).toBe(true);
  });

  // Regression for issue #1490: experimental.staleTimes.static should be
  // honored as the prefetch cache freshness window. The plugin injects
  // `process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME` (in seconds) at
  // build time; navigation.ts reads it when computing PREFETCH_CACHE_TTL.
  describe("staleTimes (#1490)", () => {
    const ORIGINAL_TTL_ENV = process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME;
    const ORIGINAL_DYNAMIC_TTL_ENV = process.env.__NEXT_CLIENT_ROUTER_DYNAMIC_STALETIME;

    afterEach(() => {
      if (ORIGINAL_TTL_ENV === undefined) {
        delete process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME;
      } else {
        process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME = ORIGINAL_TTL_ENV;
      }
      if (ORIGINAL_DYNAMIC_TTL_ENV === undefined) {
        delete process.env.__NEXT_CLIENT_ROUTER_DYNAMIC_STALETIME;
      } else {
        process.env.__NEXT_CLIENT_ROUTER_DYNAMIC_STALETIME = ORIGINAL_DYNAMIC_TTL_ENV;
      }
    });

    it("uses 30s when __NEXT_CLIENT_ROUTER_STATIC_STALETIME is unset", async () => {
      delete process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME;
      vi.resetModules();
      const nav = await import("../packages/vinext/src/shims/navigation.js");
      expect(nav.PREFETCH_CACHE_TTL).toBe(30_000);
    });

    it("converts seconds from __NEXT_CLIENT_ROUTER_STATIC_STALETIME into ms", async () => {
      process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME = "180";
      vi.resetModules();
      const nav = await import("../packages/vinext/src/shims/navigation.js");
      expect(nav.PREFETCH_CACHE_TTL).toBe(180_000);
    });

    it("uses the configured dynamic stale time for committed navigation snapshots", async () => {
      process.env.__NEXT_CLIENT_ROUTER_DYNAMIC_STALETIME = "30";
      process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME = "180";
      vi.resetModules();
      const nav = await import("../packages/vinext/src/shims/navigation.js");

      expect(nav.DYNAMIC_NAVIGATION_CACHE_TTL).toBe(30_000);
      expect(nav.PREFETCH_CACHE_TTL).toBe(180_000);
    });

    it("treats a freshly prefetched entry as reusable up to the configured TTL", async () => {
      process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME = "180";
      vi.resetModules();
      const nav = await import("../packages/vinext/src/shims/navigation.js");

      const cache = nav.getPrefetchCache();
      const prefetched = nav.getPrefetchedUrls();
      const rscUrl = "/dashboard.rsc";
      const now = 1_000_000;
      const snapshot = {
        buffer: new TextEncoder().encode("flight").buffer,
        contentType: "text/x-component",
        mountedSlotsHeader: null,
        paramsHeader: null,
        renderedPathAndSearch: null,
        url: rscUrl,
      };

      cache.set(rscUrl, { outcome: "cache-seeded", snapshot, timestamp: now });
      prefetched.add(rscUrl);

      // 150 seconds later — within the configured 180s window, must reuse
      vi.spyOn(Date, "now").mockReturnValue(now + 150_000);
      expect(nav.consumePrefetchResponse(rscUrl, null, null)).toEqual(snapshot);
    });

    it("treats a stale entry as expired once the configured TTL elapses", async () => {
      process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME = "180";
      vi.resetModules();
      const nav = await import("../packages/vinext/src/shims/navigation.js");

      const cache = nav.getPrefetchCache();
      const prefetched = nav.getPrefetchedUrls();
      const rscUrl = "/dashboard.rsc";
      const now = 1_000_000;
      const snapshot = {
        buffer: new TextEncoder().encode("flight").buffer,
        contentType: "text/x-component",
        mountedSlotsHeader: null,
        paramsHeader: null,
        renderedPathAndSearch: null,
        url: rscUrl,
      };

      cache.set(rscUrl, { outcome: "cache-seeded", snapshot, timestamp: now });
      prefetched.add(rscUrl);

      // 200 seconds later — past the 180s window, must NOT reuse
      vi.spyOn(Date, "now").mockReturnValue(now + 200_000);
      expect(nav.consumePrefetchResponse(rscUrl, null, null)).toBeNull();
    });

    it("allows automatic dynamic full prefetches to expire immediately", async () => {
      process.env.__NEXT_CLIENT_ROUTER_DYNAMIC_STALETIME = "0";
      vi.resetModules();
      const nav = await import("../packages/vinext/src/shims/navigation.js");

      const rscUrl = "/without-loading/1.rsc";
      const now = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      nav.prefetchRscResponse(
        rscUrl,
        Promise.resolve(
          new Response("flight", { headers: { "content-type": "text/x-component" } }),
        ),
        null,
        null,
        undefined,
        {
          cacheForNavigation: true,
          fallbackTtlMs: nav.DYNAMIC_NAVIGATION_CACHE_TTL,
          minimumTtlMs: 0,
        },
      );

      const entry = nav.getPrefetchCache().get(rscUrl);
      await entry?.pending;

      expect(entry?.expiresAt).toBe(now);
      expect(nav.hasPrefetchCacheEntryForNavigation(rscUrl, null, null)).toBe(false);
      expect(nav.consumePrefetchResponse(rscUrl, null, null)).toBeNull();
    });
  });

  it("matches only search-agnostic optimistic shells across page search params", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts
    const cache = getPrefetchCache();
    const firstRscUrl = "/search-params/target-page?searchParam=a_PPR&_rsc=first";
    const secondRscUrl = "/search-params/target-page?searchParam=c_PPR&_rsc=second";
    const ordinaryShellRscUrl = "/search-params/target-page?searchParam=b_full&_rsc=full";

    cache.set(AppElementsWire.encodeCacheKey(ordinaryShellRscUrl, null), {
      cacheForNavigation: false,
      mountedSlotsHeader: null,
      optimisticRouteShell: true,
      outcome: "pending",
      pending: Promise.resolve(),
      timestamp: Date.now(),
    });
    expect(hasSearchAgnosticPrefetchShellForRoute(secondRscUrl, null, null)).toBe(false);

    cache.set(AppElementsWire.encodeCacheKey(firstRscUrl, null), {
      cacheForNavigation: false,
      mountedSlotsHeader: null,
      optimisticRouteShell: true,
      outcome: "pending",
      pending: Promise.resolve(),
      searchAgnosticShell: true,
      timestamp: Date.now(),
    });

    expect(hasSearchAgnosticPrefetchShellForRoute(secondRscUrl, null, null)).toBe(true);
    expect(hasPrefetchCacheEntryForNavigation(secondRscUrl, null, null)).toBe(false);
  });

  it("aliases full prefetch responses by their server-rendered path and search", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts
    const originalRscUrl =
      "/search-params/target-page?searchParam=rewritesToANewSearchParam&_rsc=first";
    const renderedPathAndSearch = "/search-params/target-page?searchParam=rewrittenSearchParam";
    const renderedRscUrl = `${renderedPathAndSearch}&_rsc=second`;

    prefetchRscResponse(
      originalRscUrl,
      Promise.resolve(
        new Response("flight", {
          headers: {
            "content-type": "text/x-component",
            [VINEXT_RENDERED_PATH_AND_SEARCH_HEADER]: encodeURIComponent(renderedPathAndSearch),
          },
        }),
      ),
      null,
      null,
    );
    await getPrefetchCache().get(originalRscUrl)?.pending;

    expect(hasPrefetchCacheEntryForNavigation(renderedRscUrl, null, null)).toBe(true);
    const peeked = peekPrefetchResponseForNavigation(renderedRscUrl, null, null);
    expect(peeked?.renderedPathAndSearch).toBe(renderedPathAndSearch);
    expect(await restoreRscResponse(peeked!).text()).toBe("flight");

    const consumed = consumePrefetchResponse(renderedRscUrl, null, null);
    expect(consumed?.renderedPathAndSearch).toBe(renderedPathAndSearch);
    expect(getPrefetchCache().has(originalRscUrl)).toBe(false);
    expect(getPrefetchCache().has(renderedPathAndSearch)).toBe(false);
  });

  it("seeds a committed navigation snapshot with the dynamic stale window", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const rscUrl = "/dynamic.rsc";
    const snapshot = {
      buffer: new TextEncoder().encode("flight").buffer,
      contentType: "text/x-component",
      mountedSlotsHeader: null,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: rscUrl,
    };

    seedPrefetchResponseSnapshot(rscUrl, snapshot);

    expect(getPrefetchCache().get(rscUrl)).toMatchObject({
      cacheForNavigation: true,
      expiresAt: now + DYNAMIC_NAVIGATION_CACHE_TTL,
      outcome: "cache-seeded",
      snapshot,
      timestamp: now,
    });
    expect(getPrefetchedUrls().has(rscUrl)).toBe(true);
  });

  it("uses per-response dynamic stale windows when consuming prefetched responses", () => {
    // Ported from Next.js: test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts
    const cache = getPrefetchCache();
    const prefetched = getPrefetchedUrls();
    const now = 1_000_000;
    const snapshot60 = {
      buffer: new TextEncoder().encode("dynamic-60").buffer,
      contentType: "text/x-component",
      dynamicStaleTimeSeconds: 60,
      mountedSlotsHeader: null,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: "/dynamic-stale-60.rsc",
    };
    const snapshot10 = {
      buffer: new TextEncoder().encode("dynamic-10").buffer,
      contentType: "text/x-component",
      dynamicStaleTimeSeconds: 10,
      mountedSlotsHeader: null,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: "/dynamic-stale-10.rsc",
    };

    cache.set(snapshot60.url, { outcome: "cache-seeded", snapshot: snapshot60, timestamp: now });
    cache.set(snapshot10.url, { outcome: "cache-seeded", snapshot: snapshot10, timestamp: now });
    prefetched.add(snapshot60.url);
    prefetched.add(snapshot10.url);

    vi.spyOn(Date, "now").mockReturnValue(now + 15_000);

    expect(consumePrefetchResponse(snapshot60.url, null, null)).toEqual(snapshot60);
    expect(consumePrefetchResponse(snapshot10.url, null, null)).toBeNull();
  });

  it("does not report stale entries as available for Link prefetch dedupe", () => {
    const cache = getPrefetchCache();
    const prefetched = getPrefetchedUrls();
    const now = 1_000_000;
    const rscUrl = "/dynamic-stale-10.rsc";
    cache.set(rscUrl, {
      outcome: "cache-seeded",
      snapshot: {
        buffer: new TextEncoder().encode("dynamic-10").buffer,
        contentType: "text/x-component",
        dynamicStaleTimeSeconds: 10,
        mountedSlotsHeader: null,
        paramsHeader: null,
        renderedPathAndSearch: null,
        url: rscUrl,
      },
      timestamp: now,
    });
    prefetched.add(rscUrl);

    vi.spyOn(Date, "now").mockReturnValue(now + 10_000);

    expect(hasPrefetchCacheEntryForNavigation(rscUrl, null, null)).toBe(false);
    expect(getPrefetchCache().has(rscUrl)).toBe(false);
    expect(getPrefetchedUrls().has(rscUrl)).toBe(false);
  });

  it("can probe stale navigation candidates without notifying invalidation callbacks", () => {
    const cache = getPrefetchCache();
    const prefetched = getPrefetchedUrls();
    const onInvalidate = vi.fn();
    const now = 1_000_000;
    const rscUrl = "/dynamic-stale-navigation.rsc";
    cache.set(rscUrl, {
      onInvalidateCallbacks: new Set([onInvalidate]),
      outcome: "cache-seeded",
      snapshot: {
        buffer: new TextEncoder().encode("dynamic-navigation").buffer,
        contentType: "text/x-component",
        dynamicStaleTimeSeconds: 10,
        mountedSlotsHeader: null,
        paramsHeader: null,
        renderedPathAndSearch: null,
        url: rscUrl,
      },
      timestamp: now,
    });
    prefetched.add(rscUrl);

    vi.spyOn(Date, "now").mockReturnValue(now + 10_000);

    expect(
      hasPrefetchCacheEntryForNavigation(rscUrl, null, null, { notifyInvalidation: false }),
    ).toBe(false);
    expect(onInvalidate).not.toHaveBeenCalled();
    expect(getPrefetchCache().has(rscUrl)).toBe(false);
    expect(getPrefetchedUrls().has(rscUrl)).toBe(false);
  });

  it("reuses a prefetched response through an alternate rewritten RSC URL", async () => {
    const cache = getPrefetchCache();
    const prefetched = getPrefetchedUrls();
    const now = 1_000_000;
    const sourceRscUrl = "/segment-cache/page-with-dynamic-head?_rsc=source";
    const rewriteRscUrl = "/segment-cache/rewrite-to-page-with-dynamic-head?_rsc=rewrite";
    const sourceCacheKey = AppElementsWire.encodeCacheKey(sourceRscUrl, null);
    const snapshot = {
      buffer: new TextEncoder().encode("dynamic-title-flight").buffer,
      contentType: "text/x-component",
      mountedSlotsHeader: null,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: sourceRscUrl,
    };

    cache.set(sourceCacheKey, {
      expiresAt: now + PREFETCH_CACHE_TTL,
      outcome: "cache-seeded",
      snapshot,
      timestamp: now,
    });
    prefetched.add(sourceCacheKey);
    vi.spyOn(Date, "now").mockReturnValue(now);

    expect(
      hasPrefetchCacheEntryForNavigation(rewriteRscUrl, null, null, {
        additionalRscUrls: [sourceRscUrl],
      }),
    ).toBe(true);

    expect(
      consumePrefetchResponse(rewriteRscUrl, null, null, {
        additionalRscUrls: [sourceRscUrl],
      }),
    ).toEqual({
      ...snapshot,
      expiresAt: now + PREFETCH_CACHE_TTL,
    });
    expect(cache.has(sourceCacheKey)).toBe(false);
  });

  it("carries prepared elements into synchronous prefetch consumption", async () => {
    const rscUrl = "/prepared?_rsc=prepared";
    const preparedElements = { "route:/prepared": "prepared" } as never;

    prefetchRscResponse(
      rscUrl,
      Promise.resolve(
        new Response("flight", {
          headers: { "content-type": "text/x-component" },
        }),
      ),
      null,
      null,
      undefined,
      {
        prepareSnapshot: async () => preparedElements,
      },
    );
    await getPrefetchCache().get(rscUrl)?.pending;

    expect(consumePrefetchResponse("/prepared", null, null)?.preparedElements).toBe(
      preparedElements,
    );
  });

  it("preserves the original expiry when consuming a prefetched response", () => {
    const cache = getPrefetchCache();
    const prefetched = getPrefetchedUrls();
    const rscUrl = "/parallel-slots.rsc";
    const now = 1_000_000;
    const expiresAt = now + 15_000;
    const snapshot = {
      buffer: new TextEncoder().encode("parallel-flight").buffer,
      contentType: "text/x-component",
      dynamicStaleTimeSeconds: 15,
      mountedSlotsHeader: "slot:slotA:/parallel-slots slot:slotB:/parallel-slots",
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: rscUrl,
    };

    cache.set(rscUrl, {
      expiresAt,
      mountedSlotsHeader: snapshot.mountedSlotsHeader,
      outcome: "cache-seeded",
      snapshot,
      timestamp: now,
    });
    prefetched.add(rscUrl);

    vi.spyOn(Date, "now").mockReturnValue(now + 14_000);
    const consumed = consumePrefetchResponse(rscUrl, null, snapshot.mountedSlotsHeader);
    expect(consumed).not.toBeNull();
    if (consumed === null) {
      throw new Error("Expected prefetched response to be reusable before its expiry");
    }
    expect(consumed?.expiresAt).toBe(expiresAt);

    vi.spyOn(Date, "now").mockReturnValue(now + 16_000);
    expect(consumePrefetchResponse(rscUrl, null, snapshot.mountedSlotsHeader)).toBeNull();
  });

  it("does not sweep expired entries on under-budget cache writes", () => {
    // Use fixed arbitrary values to avoid any dependency on the real wall clock
    const now = 1_000_000;
    const expired = now - PREFETCH_CACHE_TTL - 1_000;

    const belowCapacity = 2;
    fillCache(belowCapacity, expired, "/expired-small-");

    vi.spyOn(Date, "now").mockReturnValue(now);
    seedPrefetchResponseSnapshot("/new.rsc", {
      buffer: new TextEncoder().encode("new").buffer,
      contentType: "text/x-component",
      mountedSlotsHeader: null,
      paramsHeader: null,
      renderedPathAndSearch: null,
      url: "/new.rsc",
    });

    const cache = getPrefetchCache();
    expect(cache.size).toBe(3);
    expect(cache.has("/expired-small-0.rsc")).toBe(true);
    expect(cache.has("/expired-small-1.rsc")).toBe(true);
    expect(cache.has("/new.rsc")).toBe(true);
    expect(getPrefetchedUrls().size).toBe(3);
  });
});
