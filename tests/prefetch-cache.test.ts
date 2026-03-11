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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Navigation = typeof import("../packages/vinext/src/shims/navigation.js");
let storePrefetchResponse: Navigation["storePrefetchResponse"];
let getPrefetchCache: Navigation["getPrefetchCache"];
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
  for (let i = 0; i < count; i++) {
    cache.set(`${keyPrefix}${i}.rsc`, {
      response: new Response(`body-${i}`),
      timestamp,
    });
  }
}

describe("prefetch cache eviction", () => {
  it("sweeps all expired entries before FIFO", () => {
    const now = Date.now();
    const expired = now - PREFETCH_CACHE_TTL - 1_000; // 31s ago

    fillCache(MAX_PREFETCH_CACHE_SIZE, expired);
    expect(getPrefetchCache().size).toBe(MAX_PREFETCH_CACHE_SIZE);

    vi.spyOn(Date, "now").mockReturnValue(now);
    storePrefetchResponse("/new.rsc", new Response("new"));

    const cache = getPrefetchCache();
    expect(cache.size).toBe(1);
    expect(cache.has("/new.rsc")).toBe(true);
  });

  it("falls back to FIFO when all entries are fresh", () => {
    const now = Date.now();

    fillCache(MAX_PREFETCH_CACHE_SIZE, now);
    expect(getPrefetchCache().size).toBe(MAX_PREFETCH_CACHE_SIZE);

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
  });

  it("sweeps only expired entries when cache has a mix", () => {
    const now = Date.now();
    const expired = now - PREFETCH_CACHE_TTL - 1_000;

    // 25 expired + 25 fresh = at capacity
    fillCache(25, expired, "/expired-");
    fillCache(25, now, "/fresh-");
    expect(getPrefetchCache().size).toBe(MAX_PREFETCH_CACHE_SIZE);

    vi.spyOn(Date, "now").mockReturnValue(now);
    storePrefetchResponse("/new.rsc", new Response("new"));

    const cache = getPrefetchCache();
    // 25 expired swept, 25 fresh kept, 1 new added
    expect(cache.size).toBe(26);
    expect(cache.has("/new.rsc")).toBe(true);

    // All expired entries should be gone
    for (let i = 0; i < 25; i++) {
      expect(cache.has(`/expired-${i}.rsc`)).toBe(false);
    }
    // All fresh entries should survive
    for (let i = 0; i < 25; i++) {
      expect(cache.has(`/fresh-${i}.rsc`)).toBe(true);
    }
  });

  it("does not sweep when cache is below capacity", () => {
    const now = Date.now();
    const expired = now - PREFETCH_CACHE_TTL - 1_000;

    // Below capacity — even expired entries should not be swept
    fillCache(10, expired);

    vi.spyOn(Date, "now").mockReturnValue(now);
    storePrefetchResponse("/new.rsc", new Response("new"));

    const cache = getPrefetchCache();
    // 10 expired still there + 1 new = 11
    expect(cache.size).toBe(11);
  });
});
