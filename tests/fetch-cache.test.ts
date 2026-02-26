/**
 * Unit tests for fetch cache shim.
 *
 * Tests the patched fetch() with Next.js caching semantics:
 * - next.revalidate for TTL-based caching
 * - next.tags for tag-based invalidation
 * - cache: 'no-store' and cache: 'force-cache'
 * - Stale-while-revalidate behavior
 * - next property stripping
 * - Independent cache entries per URL
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We need to mock fetch at the module level BEFORE fetch-cache.ts captures
// `originalFetch`. Use vi.stubGlobal to intercept at import time.
let requestCount = 0;
const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
  requestCount++;
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return new Response(JSON.stringify({ url, count: requestCount }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

// Stub globalThis.fetch BEFORE importing modules that capture it
vi.stubGlobal("fetch", fetchMock);

// Now import — these will capture fetchMock as "originalFetch"
const { withFetchCache, runWithFetchCache, getCollectedFetchTags, getOriginalFetch } = await import("../packages/vinext/src/shims/fetch-cache.js");
const { getCacheHandler, revalidateTag, MemoryCacheHandler, setCacheHandler } = await import("../packages/vinext/src/shims/cache.js");

describe("fetch cache shim", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    // Reset state
    requestCount = 0;
    fetchMock.mockClear();
    // Reset the cache handler to a fresh instance for each test
    setCacheHandler(new MemoryCacheHandler());
    // Install the patched fetch
    cleanup = withFetchCache();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  // ── Basic caching with next.revalidate ──────────────────────────────

  it("caches fetch with next.revalidate and returns cached on second call", async () => {
    const res1 = await fetch("https://api.example.com/data", {
      next: { revalidate: 60 },
    });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    // Second call should return cached data (no new network request)
    const res2 = await fetch("https://api.example.com/data", {
      next: { revalidate: 60 },
    });
    const data2 = await res2.json();
    expect(data2.count).toBe(1); // Same count = cached
    expect(fetchMock).toHaveBeenCalledTimes(1); // Only one real fetch
  });

  it("cache: 'force-cache' caches indefinitely", async () => {
    const res1 = await fetch("https://api.example.com/force", {
      cache: "force-cache",
    });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    const res2 = await fetch("https://api.example.com/force", {
      cache: "force-cache",
    });
    const data2 = await res2.json();
    expect(data2.count).toBe(1); // Cached
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── No caching (no-store, revalidate: 0, revalidate: false) ─────────

  it("cache: 'no-store' bypasses cache entirely", async () => {
    const res1 = await fetch("https://api.example.com/nostore", {
      cache: "no-store",
    });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    const res2 = await fetch("https://api.example.com/nostore", {
      cache: "no-store",
    });
    const data2 = await res2.json();
    expect(data2.count).toBe(2); // Fresh fetch each time
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("next.revalidate: 0 skips caching", async () => {
    const res1 = await fetch("https://api.example.com/rev0", {
      next: { revalidate: 0 },
    });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    const res2 = await fetch("https://api.example.com/rev0", {
      next: { revalidate: 0 },
    });
    const data2 = await res2.json();
    expect(data2.count).toBe(2); // Not cached
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("next.revalidate: false skips caching", async () => {
    const res1 = await fetch("https://api.example.com/revfalse", {
      next: { revalidate: false },
    });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    const res2 = await fetch("https://api.example.com/revfalse", {
      next: { revalidate: false },
    });
    const data2 = await res2.json();
    expect(data2.count).toBe(2); // Not cached
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("no cache or next options passes through without caching", async () => {
    const res1 = await fetch("https://api.example.com/passthrough");
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    const res2 = await fetch("https://api.example.com/passthrough");
    const data2 = await res2.json();
    expect(data2.count).toBe(2); // Pass-through, no caching
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Tag-based invalidation ──────────────────────────────────────────

  it("next.tags caches and revalidateTag invalidates", async () => {
    const res1 = await fetch("https://api.example.com/posts", {
      next: { tags: ["posts"] },
    });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    // Cached
    const res2 = await fetch("https://api.example.com/posts", {
      next: { tags: ["posts"] },
    });
    const data2 = await res2.json();
    expect(data2.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Invalidate via tag
    await revalidateTag("posts");

    // Should re-fetch after tag invalidation
    const res3 = await fetch("https://api.example.com/posts", {
      next: { tags: ["posts"] },
    });
    const data3 = await res3.json();
    expect(data3.count).toBe(2); // Fresh fetch
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("revalidateTag only invalidates matching tags", async () => {
    // Cache two different tagged fetches
    await fetch("https://api.example.com/posts-tag", {
      next: { tags: ["posts"] },
    });
    await fetch("https://api.example.com/users-tag", {
      next: { tags: ["users"] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Invalidate only "posts"
    await revalidateTag("posts");

    // Posts should re-fetch
    const postRes = await fetch("https://api.example.com/posts-tag", {
      next: { tags: ["posts"] },
    });
    const postData = await postRes.json();
    expect(postData.count).toBe(3); // Fresh fetch (count continues from 2)

    // Users should still be cached
    const userRes = await fetch("https://api.example.com/users-tag", {
      next: { tags: ["users"] },
    });
    const userData = await userRes.json();
    expect(userData.count).toBe(2); // Still the cached version
    expect(fetchMock).toHaveBeenCalledTimes(3); // Only posts re-fetched
  });

  // ── TTL expiry (stale-while-revalidate) ─────────────────────────────

  it("returns stale data after TTL expires and triggers background refetch", async () => {
    const res1 = await fetch("https://api.example.com/stale-test", {
      next: { revalidate: 1 },
    });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    // Manually expire the cache entry (key is a SHA-256 hash, find it dynamically)
    const handler = getCacheHandler() as InstanceType<typeof MemoryCacheHandler>;
    const store = (handler as any).store as Map<string, any>;
    for (const [, entry] of store) {
      entry.revalidateAt = Date.now() - 1000; // Expired 1 second ago
    }

    // Should return stale data immediately
    const res2 = await fetch("https://api.example.com/stale-test", {
      next: { revalidate: 1 },
    });
    const data2 = await res2.json();
    expect(data2.count).toBe(1); // Stale data (same as first fetch)

    // Wait for background refetch
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(2); // Original + background refetch
  });

  // ── Independent cache entries per URL ───────────────────────────────

  it("different URLs get independent cache entries", async () => {
    const res1 = await fetch("https://api.example.com/url-a", {
      next: { revalidate: 60 },
    });
    const data1 = await res1.json();
    expect(data1.url).toBe("https://api.example.com/url-a");
    expect(data1.count).toBe(1);

    const res2 = await fetch("https://api.example.com/url-b", {
      next: { revalidate: 60 },
    });
    const data2 = await res2.json();
    expect(data2.url).toBe("https://api.example.com/url-b");
    expect(data2.count).toBe(2); // Different URL = different cache

    // Re-fetch url-a should be cached
    const res3 = await fetch("https://api.example.com/url-a", {
      next: { revalidate: 60 },
    });
    const data3 = await res3.json();
    expect(data3.count).toBe(1); // Cached
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("same URL with different methods get separate cache entries", async () => {
    const getRes = await fetch("https://api.example.com/method-test", {
      method: "GET",
      next: { revalidate: 60 },
    });
    const getData = await getRes.json();
    expect(getData.count).toBe(1);

    const postRes = await fetch("https://api.example.com/method-test", {
      method: "POST",
      body: "test",
      next: { revalidate: 60 },
    });
    const postData = await postRes.json();
    expect(postData.count).toBe(2); // Different method = different cache

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── next property stripping ─────────────────────────────────────────

  it("strips next property before passing to real fetch", async () => {
    await fetch("https://api.example.com/strip-test", {
      next: { revalidate: 60, tags: ["test"] },
      headers: { "X-Custom": "value" },
    });

    // Verify the mock was called with init that does NOT have `next`
    const call = fetchMock.mock.calls[0];
    const init = call[1] as RequestInit;
    expect(init).toBeDefined();
    expect((init as any).next).toBeUndefined();
    expect((init as any).headers).toEqual({ "X-Custom": "value" });
  });

  it("strips next property for no-store fetches too", async () => {
    await fetch("https://api.example.com/strip-nostore", {
      cache: "no-store",
      next: { tags: ["test"] },
    });

    const call = fetchMock.mock.calls[0];
    const init = call[1] as RequestInit;
    expect((init as any).next).toBeUndefined();
  });

  // ── Tag collection during rendering ─────────────────────────────────

  it("collects tags during render pass via getCollectedFetchTags", async () => {
    await fetch("https://api.example.com/tag-collect-a", {
      next: { tags: ["posts", "list"] },
    });
    await fetch("https://api.example.com/tag-collect-b", {
      next: { tags: ["users"] },
    });

    const tags = getCollectedFetchTags();
    expect(tags).toContain("posts");
    expect(tags).toContain("list");
    expect(tags).toContain("users");
    expect(tags).toHaveLength(3);
  });

  it("does not collect duplicate tags", async () => {
    await fetch("https://api.example.com/dup-tag-a", {
      next: { tags: ["data"] },
    });
    await fetch("https://api.example.com/dup-tag-b", {
      next: { tags: ["data"] },
    });

    const tags = getCollectedFetchTags();
    expect(tags.filter(t => t === "data")).toHaveLength(1);
  });

  // ── Only caches successful responses ────────────────────────────────

  it("does not cache non-2xx responses", async () => {
    // Override mock to return 404 once
    fetchMock.mockImplementationOnce(async () => {
      requestCount++;
      return new Response("Not found", { status: 404 });
    });

    const res1 = await fetch("https://api.example.com/missing-page", {
      next: { revalidate: 60 },
    });
    expect(res1.status).toBe(404);

    // Should re-fetch since 404 wasn't cached
    const res2 = await fetch("https://api.example.com/missing-page", {
      next: { revalidate: 60 },
    });
    expect(res2.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── URL and Request object inputs ───────────────────────────────────

  it("handles URL objects as input", async () => {
    const url = new URL("https://api.example.com/url-obj");
    const res = await fetch(url, { next: { revalidate: 60 } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(1);

    // Cached on second call
    const res2 = await fetch(url, { next: { revalidate: 60 } });
    const data2 = await res2.json();
    expect(data2.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles Request objects as input", async () => {
    const req = new Request("https://api.example.com/req-obj");
    const res = await fetch(req, { next: { revalidate: 60 } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(1);

    // Cached on second call with same URL
    const req2 = new Request("https://api.example.com/req-obj");
    const res2 = await fetch(req2, { next: { revalidate: 60 } });
    const data2 = await res2.json();
    expect(data2.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── force-cache with next.revalidate ────────────────────────────────

  it("cache: 'force-cache' with next.revalidate uses the specified TTL", async () => {
    const res1 = await fetch("https://api.example.com/force-ttl", {
      cache: "force-cache",
      next: { revalidate: 1 },
    });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    // Verify it's cached
    const res2 = await fetch("https://api.example.com/force-ttl", {
      cache: "force-cache",
      next: { revalidate: 1 },
    });
    const data2 = await res2.json();
    expect(data2.count).toBe(1);

    // Expire the cache manually (key is a SHA-256 hash, find it dynamically)
    const handler = getCacheHandler() as InstanceType<typeof MemoryCacheHandler>;
    const store = (handler as any).store as Map<string, any>;
    for (const [, entry] of store) {
      entry.revalidateAt = Date.now() - 1000;
    }

    // Should return stale
    const res3 = await fetch("https://api.example.com/force-ttl", {
      cache: "force-cache",
      next: { revalidate: 1 },
    });
    const data3 = await res3.json();
    expect(data3.count).toBe(1); // Stale data returned
    // Background refetch
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Cleanup clears per-request state ─────────────────────────────────

  it("cleanup function clears collected tags", async () => {
    // Collect some tags
    await fetch("https://api.example.com/cleanup-test", {
      next: { tags: ["cleanup-tag"] },
    });
    expect(getCollectedFetchTags()).toContain("cleanup-tag");

    // Cleanup should reset tag state
    cleanup!();
    cleanup = null;
    expect(getCollectedFetchTags()).toHaveLength(0);

    // Re-install for afterEach cleanup
    cleanup = withFetchCache();
  });

  // ── getOriginalFetch ────────────────────────────────────────────────

  it("getOriginalFetch returns the module-level original fetch", () => {
    const orig = getOriginalFetch();
    expect(typeof orig).toBe("function");
    // It should be fetchMock since that was the global fetch when the module loaded
    expect(orig).toBe(fetchMock);
  });

  // ── next: {} empty passes through ───────────────────────────────────

  it("next: {} with no revalidate or tags passes through", async () => {
    const res1 = await fetch("https://api.example.com/empty-next", { next: {} });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    const res2 = await fetch("https://api.example.com/empty-next", { next: {} });
    const data2 = await res2.json();
    expect(data2.count).toBe(2); // Not cached
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Concurrent request isolation via ALS ─────────────────────────────

  it("concurrent runWithFetchCache calls have isolated tags", async () => {
    // Clean up the withFetchCache() from beforeEach — runWithFetchCache
    // manages its own ALS scope.
    cleanup?.();
    cleanup = null;

    const [tags1, tags2] = await Promise.all([
      runWithFetchCache(async () => {
        await fetch("https://api.example.com/concurrent-a", {
          next: { tags: ["request-1"] },
        });
        return getCollectedFetchTags();
      }),
      runWithFetchCache(async () => {
        await fetch("https://api.example.com/concurrent-b", {
          next: { tags: ["request-2"] },
        });
        return getCollectedFetchTags();
      }),
    ]);

    expect(tags1).toEqual(["request-1"]);
    expect(tags2).toEqual(["request-2"]);

    // Re-install for afterEach
    cleanup = withFetchCache();
  });

  // ── Auth header isolation in cache keys ─────────────────────────────

  describe("auth header cache isolation", () => {
    it("different Authorization headers produce separate cache entries", async () => {
      // Alice fetches with her token — explicitly opt into caching
      const res1 = await fetch("https://api.example.com/me", {
        headers: { Authorization: "Bearer alice-token" },
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      // Bob fetches with his token — should NOT get Alice's cached response
      const res2 = await fetch("https://api.example.com/me", {
        headers: { Authorization: "Bearer bob-token" },
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different cache entry
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Alice fetches again — should get her cached response
      const res3 = await fetch("https://api.example.com/me", {
        headers: { Authorization: "Bearer alice-token" },
        next: { revalidate: 60 },
      });
      const data3 = await res3.json();
      expect(data3.count).toBe(1); // Cached from first request
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("different Cookie headers produce separate cache entries", async () => {
      const res1 = await fetch("https://api.example.com/profile", {
        headers: { Cookie: "session=alice" },
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      // Bob's cookie should get a separate cache entry
      const res2 = await fetch("https://api.example.com/profile", {
        headers: { Cookie: "session=bob" },
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Fresh fetch, not Alice's data
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("requests without auth headers share cache (public data)", async () => {
      const res1 = await fetch("https://api.example.com/public", {
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      // No auth headers → same cache entry
      const res2 = await fetch("https://api.example.com/public", {
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(1); // Cached
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("auth headers with force-cache still produce per-user cache entries", async () => {
      const res1 = await fetch("https://api.example.com/forced", {
        headers: { Authorization: "Bearer alice" },
        cache: "force-cache",
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/forced", {
        headers: { Authorization: "Bearer bob" },
        cache: "force-cache",
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Separate cache entry
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("auth headers with tags-only (no explicit revalidate) bypass cache", async () => {
      // When only tags are specified but no explicit revalidate or force-cache,
      // auth headers should cause a cache bypass
      const res1 = await fetch("https://api.example.com/tagged-auth", {
        headers: { Authorization: "Bearer alice" },
        next: { tags: ["user-data"] },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      // Same user, same tags — should still bypass (no explicit cache opt-in)
      const res2 = await fetch("https://api.example.com/tagged-auth", {
        headers: { Authorization: "Bearer alice" },
        next: { tags: ["user-data"] },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Not cached — safety bypass
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("X-API-Key header is included in cache key", async () => {
      const res1 = await fetch("https://api.example.com/api-key", {
        headers: { "X-API-Key": "key-alice" },
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/api-key", {
        headers: { "X-API-Key": "key-bob" },
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different key = different cache
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("auth headers from Request object are included in cache key", async () => {
      const req1 = new Request("https://api.example.com/req-auth", {
        headers: { Authorization: "Bearer alice" },
      });
      const res1 = await fetch(req1, { next: { revalidate: 60 } });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const req2 = new Request("https://api.example.com/req-auth", {
        headers: { Authorization: "Bearer bob" },
      });
      const res2 = await fetch(req2, { next: { revalidate: 60 } });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different auth = different cache
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── cache: 'no-cache' bypass ────────────────────────────────────────

  it("cache: 'no-cache' bypasses cache entirely", async () => {
    const res1 = await fetch("https://api.example.com/nocache", {
      cache: "no-cache" as RequestCache,
    });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    const res2 = await fetch("https://api.example.com/nocache", {
      cache: "no-cache" as RequestCache,
    });
    const data2 = await res2.json();
    expect(data2.count).toBe(2); // Fresh fetch each time
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cache: 'no-store' with auth headers bypasses cache", async () => {
    const res1 = await fetch("https://api.example.com/nostore-auth", {
      cache: "no-store",
      headers: { Authorization: "Bearer token" },
    });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    const res2 = await fetch("https://api.example.com/nostore-auth", {
      cache: "no-store",
      headers: { Authorization: "Bearer token" },
    });
    const data2 = await res2.json();
    expect(data2.count).toBe(2); // Always fresh
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cache: 'no-cache' with auth headers bypasses cache", async () => {
    const res1 = await fetch("https://api.example.com/nocache-auth", {
      cache: "no-cache" as RequestCache,
      headers: { Cookie: "session=alice" },
    });
    const data1 = await res1.json();
    expect(data1.count).toBe(1);

    const res2 = await fetch("https://api.example.com/nocache-auth", {
      cache: "no-cache" as RequestCache,
      headers: { Cookie: "session=bob" },
    });
    const data2 = await res2.json();
    expect(data2.count).toBe(2); // Always fresh
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Cache key: body type handling ─────────────────────────────────

  describe("cache key body type handling", () => {
    it("different string bodies produce separate cache entries", async () => {
      const res1 = await fetch("https://api.example.com/body-str", {
        method: "POST",
        body: '{"type":"a"}',
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/body-str", {
        method: "POST",
        body: '{"type":"b"}',
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different body = different cache
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("same string bodies hit the same cache entry", async () => {
      const res1 = await fetch("https://api.example.com/body-same", {
        method: "POST",
        body: '{"query":"test"}',
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/body-same", {
        method: "POST",
        body: '{"query":"test"}',
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(1); // Same body = same cache
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("Uint8Array bodies are included in cache key", async () => {
      const bodyA = new TextEncoder().encode("payload-a");
      const bodyB = new TextEncoder().encode("payload-b");

      const res1 = await fetch("https://api.example.com/body-uint8", {
        method: "POST",
        body: bodyA,
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/body-uint8", {
        method: "POST",
        body: bodyB,
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different binary body = different cache
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("same Uint8Array bodies hit the same cache entry", async () => {
      const body1 = new TextEncoder().encode("same-payload");
      const body2 = new TextEncoder().encode("same-payload");

      const res1 = await fetch("https://api.example.com/body-uint8-same", {
        method: "POST",
        body: body1,
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/body-uint8-same", {
        method: "POST",
        body: body2,
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(1); // Same payload = same cache
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("Blob bodies are included in cache key", async () => {
      const blobA = new Blob(["blob-content-a"], { type: "text/plain" });
      const blobB = new Blob(["blob-content-b"], { type: "text/plain" });

      const res1 = await fetch("https://api.example.com/body-blob", {
        method: "POST",
        body: blobA,
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/body-blob", {
        method: "POST",
        body: blobB,
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different blob = different cache
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("FormData bodies are included in cache key", async () => {
      const formA = new FormData();
      formA.append("name", "alice");

      const formB = new FormData();
      formB.append("name", "bob");

      const res1 = await fetch("https://api.example.com/body-form", {
        method: "POST",
        body: formA,
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/body-form", {
        method: "POST",
        body: formB,
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different form data = different cache
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("ReadableStream bodies are included in cache key", async () => {
      const streamA = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("stream-a"));
          controller.close();
        },
      });
      const streamB = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("stream-b"));
          controller.close();
        },
      });

      const res1 = await fetch("https://api.example.com/body-stream", {
        method: "POST",
        body: streamA,
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/body-stream", {
        method: "POST",
        body: streamB,
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different stream = different cache
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── Cache key: header inclusion (all headers minus blocklist) ──────

  describe("cache key header inclusion", () => {
    it("different Accept headers produce separate cache entries", async () => {
      const res1 = await fetch("https://api.example.com/accept-test", {
        headers: { Accept: "application/json" },
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/accept-test", {
        headers: { Accept: "text/html" },
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different Accept = different cache
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("different Accept-Language headers produce separate cache entries", async () => {
      const res1 = await fetch("https://api.example.com/lang-test", {
        headers: { "Accept-Language": "en-US" },
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/lang-test", {
        headers: { "Accept-Language": "fr-FR" },
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different language = different cache
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("custom headers are included in cache key", async () => {
      const res1 = await fetch("https://api.example.com/custom-hdr", {
        headers: { "X-Feature-Flag": "variant-a" },
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/custom-hdr", {
        headers: { "X-Feature-Flag": "variant-b" },
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different custom header = different cache
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("traceparent and tracestate headers are excluded from cache key", async () => {
      const res1 = await fetch("https://api.example.com/trace-test", {
        headers: {
          traceparent: "00-trace-id-1-01",
          tracestate: "vendor=value1",
          "X-Custom": "same",
        },
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      // Same request but different trace headers — should hit cache
      const res2 = await fetch("https://api.example.com/trace-test", {
        headers: {
          traceparent: "00-trace-id-2-01",
          tracestate: "vendor=value2",
          "X-Custom": "same",
        },
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(1); // Cached — trace headers excluded from key
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("same headers produce same cache entry regardless of order", async () => {
      const res1 = await fetch("https://api.example.com/hdr-order", {
        headers: new Headers([
          ["X-First", "1"],
          ["X-Second", "2"],
        ]),
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      // Headers in different construction order — Headers object normalizes
      const res2 = await fetch("https://api.example.com/hdr-order", {
        headers: new Headers([
          ["X-Second", "2"],
          ["X-First", "1"],
        ]),
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(1); // Same cache entry
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("requests with no headers vs with headers get separate cache entries", async () => {
      const res1 = await fetch("https://api.example.com/hdr-vs-none", {
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/hdr-vs-none", {
        headers: { "X-Extra": "present" },
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different cache entry
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── Body restoration after cache key generation ───────────────────

  describe("body restoration (_ogBody)", () => {
    it("ReadableStream body is correctly passed to real fetch after cache key generation", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("stream-body-content"));
          controller.close();
        },
      });

      await fetch("https://api.example.com/stream-restore", {
        method: "POST",
        body: stream,
        next: { revalidate: 60 },
      });

      // Verify the mock was called and the body was not a spent stream
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      const init = call[1] as RequestInit;
      // The body should be a Uint8Array (reconstructed from the consumed stream)
      expect(init.body).toBeInstanceOf(Uint8Array);
      const decoded = new TextDecoder().decode(init.body as Uint8Array);
      expect(decoded).toBe("stream-body-content");
    });

    it("Blob body is correctly passed to real fetch after cache key generation", async () => {
      const blob = new Blob(["blob-body-content"], { type: "text/plain" });

      await fetch("https://api.example.com/blob-restore", {
        method: "POST",
        body: blob,
        next: { revalidate: 60 },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      const init = call[1] as RequestInit;
      // The body should be a Blob (reconstructed)
      expect(init.body).toBeInstanceOf(Blob);
      const text = await (init.body as Blob).text();
      expect(text).toBe("blob-body-content");
    });

    it("Uint8Array body is correctly passed to real fetch after cache key generation", async () => {
      const body = new TextEncoder().encode("uint8-body-content");

      await fetch("https://api.example.com/uint8-restore", {
        method: "POST",
        body: body,
        next: { revalidate: 60 },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      const init = call[1] as RequestInit;
      expect(init.body).toBeInstanceOf(Uint8Array);
      const decoded = new TextDecoder().decode(init.body as Uint8Array);
      expect(decoded).toBe("uint8-body-content");
    });

    it("string body is correctly passed to real fetch after cache key generation", async () => {
      await fetch("https://api.example.com/string-restore", {
        method: "POST",
        body: '{"key":"value"}',
        next: { revalidate: 60 },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      const init = call[1] as RequestInit;
      expect(init.body).toBe('{"key":"value"}');
    });
  });

  // ── URLSearchParams body ──────────────────────────────────────────

  describe("URLSearchParams body", () => {
    it("different URLSearchParams bodies produce separate cache entries", async () => {
      const paramsA = new URLSearchParams({ q: "alpha" });
      const paramsB = new URLSearchParams({ q: "beta" });

      const res1 = await fetch("https://api.example.com/body-usp", {
        method: "POST",
        body: paramsA,
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/body-usp", {
        method: "POST",
        body: paramsB,
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(2); // Different params = different cache
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("same URLSearchParams bodies hit the same cache entry", async () => {
      const params1 = new URLSearchParams({ q: "same" });
      const params2 = new URLSearchParams({ q: "same" });

      const res1 = await fetch("https://api.example.com/body-usp-same", {
        method: "POST",
        body: params1,
        next: { revalidate: 60 },
      });
      const data1 = await res1.json();
      expect(data1.count).toBe(1);

      const res2 = await fetch("https://api.example.com/body-usp-same", {
        method: "POST",
        body: params2,
        next: { revalidate: 60 },
      });
      const data2 = await res2.json();
      expect(data2.count).toBe(1); // Same params = cached
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
