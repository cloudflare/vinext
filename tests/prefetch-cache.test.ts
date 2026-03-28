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

type Navigation = typeof import("../packages/vinext/src/shims/navigation.js");
let storePrefetchResponse: Navigation["storePrefetchResponse"];
let getPrefetchCache: Navigation["getPrefetchCache"];
let getPrefetchedUrls: Navigation["getPrefetchedUrls"];
let MAX_PREFETCH_CACHE_SIZE: Navigation["MAX_PREFETCH_CACHE_SIZE"];
let PREFETCH_CACHE_TTL: Navigation["PREFETCH_CACHE_TTL"];

beforeEach(async () => {
  // Set window BEFORE importing so isServer evaluates to false
  (globalThis as any).window = {
    __VINEXT_RSC_PREFETCH_CACHE__: new Map(),
    __VINEXT_RSC_PREFETCHED_URLS__: new Set(),
    location: { pathname: "/", search: "", hash: "", href: "http://localhost/" },
    addEventListener: () => {},
    history: { pushState: () => {}, replaceState: () => {}, state: null },
    dispatchEvent: () => {},
  };
  vi.resetModules();
  const nav = await import("../packages/vinext/src/shims/navigation.js");
  storePrefetchResponse = nav.storePrefetchResponse;
  getPrefetchCache = nav.getPrefetchCache;
  getPrefetchedUrls = nav.getPrefetchedUrls;
  MAX_PREFETCH_CACHE_SIZE = nav.MAX_PREFETCH_CACHE_SIZE;
  PREFETCH_CACHE_TTL = nav.PREFETCH_CACHE_TTL;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
});

/** Helper: fill cache with `count` entries at a given timestamp. */
function fillCache(count: number, timestamp: number, keyPrefix = "/page-"): void {
  const cache = getPrefetchCache();
  const prefetched = getPrefetchedUrls();
  for (let i = 0; i < count; i++) {
    const key = `${keyPrefix}${i}.rsc`;
    cache.set(key, { response: new Response(`body-${i}`), timestamp });
    prefetched.add(key);
  }
}

describe("prefetch cache eviction", () => {
  it("sweeps all expired entries before FIFO", () => {
    // Use fixed arbitrary values to avoid any dependency on the real wall clock
    const now = 1_000_000;
    const expired = now - PREFETCH_CACHE_TTL - 1_000; // 31s before `now`

    fillCache(MAX_PREFETCH_CACHE_SIZE, expired);
    expect(getPrefetchCache().size).toBe(MAX_PREFETCH_CACHE_SIZE);
    expect(getPrefetchedUrls().size).toBe(MAX_PREFETCH_CACHE_SIZE);

    vi.spyOn(Date, "now").mockReturnValue(now);
    storePrefetchResponse("/new.rsc", new Response("new"));

    const cache = getPrefetchCache();
    expect(cache.size).toBe(1);
    expect(cache.has("/new.rsc")).toBe(true);
    // All evicted entries should be removed from prefetched URL set
    expect(getPrefetchedUrls().size).toBe(0);
  });

  it("falls back to FIFO when all entries are fresh", () => {
    // Use fixed arbitrary values to avoid any dependency on the real wall clock
    const now = 1_000_000;

    fillCache(MAX_PREFETCH_CACHE_SIZE, now);
    expect(getPrefetchCache().size).toBe(MAX_PREFETCH_CACHE_SIZE);
    expect(getPrefetchedUrls().size).toBe(MAX_PREFETCH_CACHE_SIZE);

    vi.spyOn(Date, "now").mockReturnValue(now);
    storePrefetchResponse("/new.rsc", new Response("new"));

    const cache = getPrefetchCache();
    // FIFO evicted one, new one added → still at capacity
    expect(cache.size).toBe(MAX_PREFETCH_CACHE_SIZE);
    expect(cache.has("/new.rsc")).toBe(true);
    // First inserted entry should be evicted
    expect(cache.has("/page-0.rsc")).toBe(false);
    // Second entry should survive
    expect(cache.has("/page-1.rsc")).toBe(true);
    // FIFO-evicted entry should be removed from prefetched URL set
    expect(getPrefetchedUrls().size).toBe(MAX_PREFETCH_CACHE_SIZE - 1);
    expect(getPrefetchedUrls().has("/page-0.rsc")).toBe(false);
  });

  it("sweeps only expired entries when cache has a mix", () => {
    // Use fixed arbitrary values to avoid any dependency on the real wall clock
    const now = 1_000_000;
    const expired = now - PREFETCH_CACHE_TTL - 1_000;

    const half = Math.floor(MAX_PREFETCH_CACHE_SIZE / 2);
    const rest = MAX_PREFETCH_CACHE_SIZE - half;

    fillCache(half, expired, "/expired-");
    fillCache(rest, now, "/fresh-");
    expect(getPrefetchCache().size).toBe(MAX_PREFETCH_CACHE_SIZE);
    expect(getPrefetchedUrls().size).toBe(MAX_PREFETCH_CACHE_SIZE);

    vi.spyOn(Date, "now").mockReturnValue(now);
    storePrefetchResponse("/new.rsc", new Response("new"));

    const cache = getPrefetchCache();
    // expired swept, fresh kept, 1 new added
    expect(cache.size).toBe(rest + 1);
    expect(cache.has("/new.rsc")).toBe(true);

    // All expired entries should be gone
    for (let i = 0; i < half; i++) {
      expect(cache.has(`/expired-${i}.rsc`)).toBe(false);
    }
    // All fresh entries should survive
    for (let i = 0; i < rest; i++) {
      expect(cache.has(`/fresh-${i}.rsc`)).toBe(true);
    }
    // Only fresh entries remain in prefetched URL set
    expect(getPrefetchedUrls().size).toBe(rest);
  });

  it("does not sweep when cache is below capacity", () => {
    // Use fixed arbitrary values to avoid any dependency on the real wall clock
    const now = 1_000_000;
    const expired = now - PREFETCH_CACHE_TTL - 1_000;

    const belowCapacity = MAX_PREFETCH_CACHE_SIZE - 1;
    fillCache(belowCapacity, expired);

    vi.spyOn(Date, "now").mockReturnValue(now);
    storePrefetchResponse("/new.rsc", new Response("new"));

    const cache = getPrefetchCache();
    // Below capacity — no eviction, all entries kept + 1 new
    expect(cache.size).toBe(belowCapacity + 1);
    // storePrefetchResponse only manages the prefetch cache — the caller
    // (router.prefetch()) is responsible for adding to prefetchedUrls. So
    // the new entry (/new.rsc) is NOT in prefetchedUrls here, and the count
    // stays at belowCapacity (no evictions triggered).
    expect(getPrefetchedUrls().size).toBe(belowCapacity);
  });
});
