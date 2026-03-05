import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("App Router ISR", () => {
  // ISR cache lifecycle tests (MISS → HIT → STALE → regen) are skipped in the
  // dev server project because ISR caching is disabled in dev mode to match
  // Next.js behavior (every request re-renders fresh). These tests should run
  // against a production server E2E project instead.

  test("first request returns ISR page", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/isr-test`);

    expect(res.status()).toBe(200);

    const html = await res.text();
    expect(html).toContain("App Router ISR Test");
    expect(html).toContain("Hello from ISR");
  });

  test.skip("second request within TTL is a cache HIT with same timestamp", async ({
    request,
  }) => {
    // SKIP: ISR cache is disabled in dev mode — no HIT/MISS/STALE semantics.
    // This test should run against a production server.
    const res1 = await request.get(`${BASE}/isr-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    const res2 = await request.get(`${BASE}/isr-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    const cacheHeader = res2.headers()["x-vinext-cache"];
    expect(cacheHeader).toBe("HIT");
    expect(ts2).toBe(ts1);
  });

  test.skip("request after TTL expires returns STALE with same cached content", async ({
    request,
  }) => {
    // SKIP: ISR cache is disabled in dev mode.
    const res1 = await request.get(`${BASE}/isr-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    await new Promise((r) => setTimeout(r, 1500));

    const res2 = await request.get(`${BASE}/isr-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];
    const cacheHeader2 = res2.headers()["x-vinext-cache"];

    expect(cacheHeader2).toBe("STALE");
    expect(ts2).toBe(ts1);
  });

  test.skip("after STALE triggers regen, subsequent request is HIT", async ({
    request,
  }) => {
    // SKIP: ISR cache is disabled in dev mode.
    await request.get(`${BASE}/isr-test`);

    await new Promise((r) => setTimeout(r, 1500));

    const staleRes = await request.get(`${BASE}/isr-test`);
    expect(staleRes.headers()["x-vinext-cache"]).toBe("STALE");

    await new Promise((r) => setTimeout(r, 500));

    const hitRes = await request.get(`${BASE}/isr-test`);
    expect(hitRes.headers()["x-vinext-cache"]).toBe("HIT");
  });

  test("Cache-Control header includes s-maxage and stale-while-revalidate", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/isr-test`);
    const cc = res.headers()["cache-control"];

    expect(cc).toBeDefined();
    expect(cc).toContain("s-maxage=1");
    expect(cc).toContain("stale-while-revalidate");
  });

  test("non-ISR page does not have ISR cache headers", async ({ request }) => {
    const res = await request.get(`${BASE}/about`);

    // About page has no `export const revalidate`, so no ISR headers
    const cacheHeader = res.headers()["x-vinext-cache"];
    // May be undefined or not present — either way, should not be MISS/HIT/STALE
    if (cacheHeader) {
      expect(["MISS", "HIT", "STALE"]).not.toContain(cacheHeader);
    }
  });

  test("ISR page renders correctly in browser", async ({ page }) => {
    await page.goto(`${BASE}/isr-test`);

    await expect(page.getByTestId("isr-test-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("App Router ISR Test");
    await expect(page.getByTestId("message")).toHaveText("Hello from ISR");

    const tsText = await page.getByTestId("timestamp").textContent();
    expect(Number(tsText)).toBeGreaterThan(0);
  });

  test("existing revalidate-test page (60s TTL) has correct Cache-Control", async ({
    request,
  }) => {
    // The revalidate-test fixture uses revalidate=60
    const res = await request.get(`${BASE}/revalidate-test`);
    const cc = res.headers()["cache-control"];

    expect(cc).toBeDefined();
    expect(cc).toContain("s-maxage=60");
    expect(cc).toContain("stale-while-revalidate");
  });
});

/**
 * OpenNext Compat: ISR dynamicParams cache header tests
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/isr.test.ts
 *
 * OpenNext verifies that `dynamicParams=true` pages return HIT for prebuilt paths,
 * MISS for non-prebuilt, and 404 for notFound(). `dynamicParams=false` returns 404
 * for unknown params. These tests verify the same cache header semantics in vinext.
 */
test.describe("ISR dynamicParams cache headers", () => {
  test.describe("dynamicParams=false (products)", () => {
    // Ref: opennextjs-cloudflare isr.test.ts "dynamicParams set to false"
    test("should return 200 on a prebuilt path", async ({ request }) => {
      // Products fixture uses dynamicParams=false with generateStaticParams [1, 2, 3]
      // Note: products page has no `export const revalidate`, so ISR is not active
      // and x-vinext-cache may not be set. We verify the page renders correctly.
      const res = await request.get(`${BASE}/products/1`);
      expect(res.status()).toBe(200);

      const html = await res.text();
      // React SSR inserts <!-- --> comment nodes between text and expressions,
      // so "Product 1" may appear as "Product <!-- -->1" in raw HTML.
      // lgtm[js/redos] — applied to trusted SSR output, not user input
      expect(html).toMatch(/Product\s*(?:<!--.*?-->)*\s*1/);
    });

    test("should return 404 for a path not in generateStaticParams", async ({
      request,
    }) => {
      // Ref: opennextjs-cloudflare isr.test.ts "should 404 for a path that is not found"
      const res = await request.get(`${BASE}/products/999`);
      expect(res.status()).toBe(404);

      const cc = res.headers()["cache-control"];
      if (cc) {
        expect(cc).toContain("no-cache");
      }
    });
  });

  test.describe("force-dynamic page", () => {
    // Ref: opennextjs-cloudflare — force-dynamic pages should never have ISR cache headers
    test("should not have ISR cache header", async ({ request }) => {
      const res = await request.get(`${BASE}/dynamic-test`);
      expect(res.status()).toBe(200);

      const cacheHeader = res.headers()["x-vinext-cache"];
      expect(cacheHeader).toBeUndefined();

      const cc = res.headers()["cache-control"];
      if (cc) {
        expect(cc).toContain("no-store");
      }
    });

    test("should return different timestamps on each request", async ({
      request,
    }) => {
      const res1 = await request.get(`${BASE}/dynamic-test`);
      const html1 = await res1.text();
      const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
      expect(ts1).toBeDefined();

      await new Promise((r) => setTimeout(r, 10));

      const res2 = await request.get(`${BASE}/dynamic-test`);
      const html2 = await res2.text();
      const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

      expect(Number(ts2)).toBeGreaterThan(Number(ts1));
    });
  });

  test("404 response has private no-cache Cache-Control", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare isr.test.ts — 404 responses should have
    // "private, no-cache, no-store, max-age=0, must-revalidate"
    const res = await request.get(`${BASE}/products/999`);
    expect(res.status()).toBe(404);

    const cc = res.headers()["cache-control"];
    if (cc) {
      // Should not have s-maxage or stale-while-revalidate on 404
      expect(cc).not.toContain("s-maxage");
      expect(cc).not.toContain("stale-while-revalidate");
    }
  });
});

/**
 * OpenNext Compat: revalidateTag / revalidatePath E2E lifecycle tests.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/revalidateTag.test.ts
 * Tests: ON-2 in TRACKING.md
 *
 * OpenNext verifies the full tag-based cache invalidation lifecycle:
 * 1. Load tagged ISR page -> cached (HIT)
 * 2. Call /api/revalidate-tag -> tag invalidated
 * 3. Reload -> content changed (MISS)
 * 4. Subsequent request -> back to HIT
 * They also verify nested pages sharing the same tag are also invalidated.
 */
test.describe("revalidateTag / revalidatePath lifecycle (OpenNext compat)", () => {
  // SKIP: These tests depend on ISR caching (MISS/HIT/STALE semantics) which is
  // disabled in dev mode. They should run against a production server E2E project.
  test.skip("revalidateTag invalidates cached page and regenerates", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare revalidateTag.test.ts "Revalidate tag"
    test.setTimeout(30_000);

    // Load the tagged ISR page to populate cache
    const res1 = await request.get(`${BASE}/revalidate-tag-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    // React SSR may insert <!-- --> comment nodes between text and expressions,
    // so use a flexible regex that allows anything between the tag and content.
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId1 = html1.match(/data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/)?.[1]
      ?? html1.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    expect(reqId1).toBeDefined();

    // Load again to confirm it's cached (same request ID)
    const res2 = await request.get(`${BASE}/revalidate-tag-test`);
    const html2 = await res2.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId2 = html2.match(/data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/)?.[1]
      ?? html2.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    const cacheHeader = res2.headers()["x-vinext-cache"];
    if (cacheHeader) {
      expect(["HIT", "STALE"]).toContain(cacheHeader);
    }
    expect(reqId2).toBe(reqId1);

    // Call revalidateTag API
    const tagRes = await request.get(`${BASE}/api/revalidate-tag`);
    expect(tagRes.status()).toBe(200);
    const tagText = await tagRes.text();
    expect(tagText).toBe("ok");

    // Reload — content should be different (cache was invalidated)
    const res3 = await request.get(`${BASE}/revalidate-tag-test`);
    const html3 = await res3.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId3 = html3.match(/data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/)?.[1]
      ?? html3.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];

    // After invalidation, should get fresh content
    expect(reqId3).not.toBe(reqId1);

    // Cache header should be MISS after invalidation
    const cacheHeader3 = res3.headers()["x-vinext-cache"];
    if (cacheHeader3) {
      expect(cacheHeader3).toBe("MISS");
    }
  });

  test.skip("revalidatePath invalidates specific path", async ({ request }) => {
    // Ref: opennextjs-cloudflare revalidateTag.test.ts "Revalidate path"
    test.setTimeout(30_000);

    // Load the page to populate cache
    const res1 = await request.get(`${BASE}/revalidate-tag-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId1 = html1.match(/data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/)?.[1]
      ?? html1.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    expect(reqId1).toBeDefined();

    // Wait a moment, then call revalidatePath
    await new Promise((r) => setTimeout(r, 500));

    const pathRes = await request.get(`${BASE}/api/revalidate-path`);
    expect(pathRes.status()).toBe(200);
    expect(await pathRes.text()).toBe("ok");

    // Reload — content should be different
    const res2 = await request.get(`${BASE}/revalidate-tag-test`);
    const html2 = await res2.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId2 = html2.match(/data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/)?.[1]
      ?? html2.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];

    expect(reqId2).not.toBe(reqId1);
  });

  test.skip("after invalidation + regen, subsequent request is HIT", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare revalidateTag.test.ts — after MISS, next request should be HIT
    test.setTimeout(30_000);

    // Populate cache
    await request.get(`${BASE}/revalidate-tag-test`);

    // Invalidate
    await request.get(`${BASE}/api/revalidate-tag`);

    // First request after invalidation — MISS (regen)
    await request.get(`${BASE}/revalidate-tag-test`);

    // Second request — should be HIT now
    const hitRes = await request.get(`${BASE}/revalidate-tag-test`);
    const cacheHeader = hitRes.headers()["x-vinext-cache"];
    if (cacheHeader) {
      expect(cacheHeader).toBe("HIT");
    }
  });

  // Ref: opennextjs-cloudflare revalidateTag.test.ts — "nested page shares tag"
  // Tests: ON-2 #2 in TRACKING.md
  // Same blocker as parent: revalidateTag does not invalidate ISR cache in dev server.
  test.fixme(
    "nested page sharing same tag is also invalidated",
    async ({ request }) => {
      test.setTimeout(30_000);

      // Load nested page to populate cache
      const res1 = await request.get(`${BASE}/revalidate-tag-test/nested`);
      expect(res1.status()).toBe(200);
      const html1 = await res1.text();
      const ts1 = html1.match(/Fetched time:\s*(\d+)/)?.[1];
      expect(ts1).toBeDefined();

      // Invalidate "test-data" tag (shared between parent and nested pages)
      const tagRes = await request.get(`${BASE}/api/revalidate-tag`);
      expect(tagRes.status()).toBe(200);

      // Reload nested page — should get fresh content
      const res2 = await request.get(`${BASE}/revalidate-tag-test/nested`);
      const html2 = await res2.text();
      const ts2 = html2.match(/Fetched time:\s*(\d+)/)?.[1];

      expect(ts2).not.toBe(ts1);
    },
  );
});

/**
 * OpenNext Compat: ISR data cache (unstable_cache) separation from page cache.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/isr.test.ts
 * Tests: ON-1 #8 in TRACKING.md
 *
 * Verifies that unstable_cache (data cache) works alongside ISR page caching.
 */
test.describe("unstable_cache data cache (OpenNext compat)", () => {
  test("unstable_cache returns consistent data across requests", async ({
    request,
  }) => {
    // Ref: opennextjs-cloudflare isr.test.ts — data cache separate from page cache
    const res1 = await request.get(`${BASE}/unstable-cache-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    // React SSR inserts <!-- --> comment nodes between text and expressions
    const value1 = html1.match(
      /CachedValue:\s*(?:<!--[^>]*-->)*\s*([a-z0-9]{4,})/,
    )?.[1];
    expect(value1).toBeDefined();

    // Second request should return the same cached value
    const res2 = await request.get(`${BASE}/unstable-cache-test`);
    const html2 = await res2.text();
    const value2 = html2.match(
      /CachedValue:\s*(?:<!--[^>]*-->)*\s*([a-z0-9]{4,})/,
    )?.[1];

    expect(value2).toBe(value1);
  });
});
