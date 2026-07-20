import { test, expect, type APIRequestContext, type APIResponse } from "@playwright/test";

function baseUrl(): string {
  const url = test.info().project.use.baseURL;
  if (!url) {
    throw new Error("isr.spec.ts requires a Playwright project with a baseURL");
  }
  return url;
}

async function resetIsrPath(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.get(
    `${baseUrl()}/api/revalidate-isr?path=${encodeURIComponent(path)}`,
  );
  expect(response.status()).toBe(200);
}

async function waitForCacheHit(request: APIRequestContext, path: string): Promise<APIResponse> {
  let response: APIResponse | undefined;
  await expect
    .poll(
      async () => {
        response = await request.get(`${baseUrl()}${path}`);
        return response.headers()["x-vinext-cache"];
      },
      {
        message: `wait for ${path} to be written to the ISR cache`,
        timeout: 5_000,
        intervals: [50, 100, 250],
      },
    )
    .toBe("HIT");

  if (!response) {
    throw new Error(`No response received while waiting for an ISR cache HIT for ${path}`);
  }
  return response;
}

test.describe("App Router ISR", () => {
  // This suite runs against the dedicated app-router-isr-prod project because
  // ISR caching is intentionally disabled in development mode.

  test.beforeEach(async ({ request }) => {
    // The production server survives Playwright retries, so explicitly clear
    // shared entries to keep MISS/HIT assertions independent and retry-safe.
    for (const path of ["/isr-test", "/client-isr-test", "/revalidate-test"]) {
      await resetIsrPath(request, path);
    }
  });

  test("first unproven render is private while populating the ISR cache", async ({ request }) => {
    const res = await request.get(`${baseUrl()}/isr-test`);

    expect(res.status()).toBe(200);
    expect(res.headers()["x-vinext-cache"]).toBe("MISS");
    expect(res.headers()["cache-control"]).toContain("no-store");

    const html = await res.text();
    expect(html).toContain("App Router ISR Test");
    expect(html).toContain("Hello from ISR");
  });

  test("second request within TTL is a cache HIT with same timestamp", async ({ request }) => {
    const res1 = await request.get(`${baseUrl()}/isr-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    const res2 = await waitForCacheHit(request, "/isr-test");
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    const cacheHeader = res2.headers()["x-vinext-cache"];
    expect(cacheHeader).toBe("HIT");
    expect(ts2).toBe(ts1);
  });

  test("request after TTL expires returns STALE with same cached content", async ({ request }) => {
    await request.get(`${baseUrl()}/isr-test`);
    const cachedRes = await waitForCacheHit(request, "/isr-test");
    const html1 = await cachedRes.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    await new Promise((r) => setTimeout(r, 1500));

    const res2 = await request.get(`${baseUrl()}/isr-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];
    const cacheHeader2 = res2.headers()["x-vinext-cache"];

    expect(cacheHeader2).toBe("STALE");
    expect(ts2).toBe(ts1);
  });

  test("after STALE triggers regen, subsequent request is HIT", async ({ request }) => {
    await request.get(`${baseUrl()}/isr-test`);
    await waitForCacheHit(request, "/isr-test");

    await new Promise((r) => setTimeout(r, 1500));

    const staleRes = await request.get(`${baseUrl()}/isr-test`);
    expect(staleRes.headers()["x-vinext-cache"]).toBe("STALE");

    const hitRes = await waitForCacheHit(request, "/isr-test");
    expect(hitRes.headers()["x-vinext-cache"]).toBe("HIT");
  });

  test("Cache-Control header includes s-maxage and stale-while-revalidate", async ({ request }) => {
    const initial = await request.get(`${baseUrl()}/isr-test`);
    expect(initial.headers()["cache-control"]).toContain("no-store");

    const cached = await waitForCacheHit(request, "/isr-test");
    const cc = cached.headers()["cache-control"];

    expect(cached.headers()["x-vinext-cache"]).toBe("HIT");
    expect(cc).toBeDefined();
    expect(cc).toContain("s-maxage=1");
    expect(cc).toContain("stale-while-revalidate");
  });

  test("queryless client page becomes publicly cacheable after its initial render", async ({
    request,
  }) => {
    const initial = await request.get(`${baseUrl()}/client-isr-test`);

    expect(initial.status()).toBe(200);
    expect(await initial.text()).toContain("Client ISR page");
    expect(initial.headers()["cache-control"]).toContain("no-store");

    const cached = await waitForCacheHit(request, "/client-isr-test");
    const cc = cached.headers()["cache-control"];
    expect(cached.headers()["x-vinext-cache"]).toBe("HIT");
    expect(cc).toContain("s-maxage=1");
    expect(cc).toContain("stale-while-revalidate");
  });

  test("non-ISR page does not have ISR cache headers", async ({ request }) => {
    const res = await request.get(`${baseUrl()}/about`);

    // About page has no `export const revalidate`, so no ISR headers
    const cacheHeader = res.headers()["x-vinext-cache"];
    // May be undefined or not present — either way, should not be MISS/HIT/STALE
    if (cacheHeader) {
      expect(["MISS", "HIT", "STALE"]).not.toContain(cacheHeader);
    }
  });

  test("ISR page renders correctly in browser", async ({ page }) => {
    await page.goto(`${baseUrl()}/isr-test`);

    await expect(page.getByTestId("isr-test-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("App Router ISR Test");
    await expect(page.getByTestId("message")).toHaveText("Hello from ISR");

    const tsText = await page.getByTestId("timestamp").textContent();
    expect(Number(tsText)).toBeGreaterThan(0);
  });

  test("existing revalidate-test page exposes its 60s policy after population", async ({
    request,
  }) => {
    // The revalidate-test fixture uses revalidate=60
    const initial = await request.get(`${baseUrl()}/revalidate-test`);
    expect(initial.headers()["cache-control"]).toContain("no-store");

    const cached = await waitForCacheHit(request, "/revalidate-test");
    const cc = cached.headers()["cache-control"];

    expect(cached.headers()["x-vinext-cache"]).toBe("HIT");
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
      const res = await request.get(`${baseUrl()}/products/1`);
      expect(res.status()).toBe(200);

      const html = await res.text();
      // React SSR inserts <!-- --> comment nodes between text and expressions,
      // so "Product 1" may appear as "Product <!-- -->1" in raw HTML.
      // lgtm[js/redos] — applied to trusted SSR output, not user input
      expect(html).toMatch(/Product\s*(?:<!--.*?-->)*\s*1/);
    });

    test("should return 404 for a path not in generateStaticParams", async ({ request }) => {
      // Ref: opennextjs-cloudflare isr.test.ts "should 404 for a path that is not found"
      const res = await request.get(`${baseUrl()}/products/999`);
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
      const res = await request.get(`${baseUrl()}/dynamic-test`);
      expect(res.status()).toBe(200);

      const cacheHeader = res.headers()["x-vinext-cache"];
      expect(cacheHeader).toBeUndefined();

      const cc = res.headers()["cache-control"];
      if (cc) {
        expect(cc).toContain("no-store");
      }
    });

    test("should return different timestamps on each request", async ({ request }) => {
      const res1 = await request.get(`${baseUrl()}/dynamic-test`);
      const html1 = await res1.text();
      const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
      expect(ts1).toBeDefined();

      await new Promise((r) => setTimeout(r, 10));

      const res2 = await request.get(`${baseUrl()}/dynamic-test`);
      const html2 = await res2.text();
      const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

      expect(Number(ts2)).toBeGreaterThan(Number(ts1));
    });
  });

  test("404 response has private no-cache Cache-Control", async ({ request }) => {
    // Ref: opennextjs-cloudflare isr.test.ts — 404 responses should have
    // "private, no-cache, no-store, max-age=0, must-revalidate"
    const res = await request.get(`${baseUrl()}/products/999`);
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
  test.beforeEach(async ({ request }) => {
    for (const path of ["/revalidate-tag-test", "/revalidate-tag-test/nested"]) {
      await resetIsrPath(request, path);
    }
  });

  test("revalidateTag invalidates cached page and regenerates", async ({ request }) => {
    // Ref: opennextjs-cloudflare revalidateTag.test.ts "Revalidate tag"
    test.setTimeout(30_000);

    // Load the tagged ISR page to populate cache
    const res1 = await request.get(`${baseUrl()}/revalidate-tag-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    // React SSR may insert <!-- --> comment nodes between text and expressions,
    // so use a flexible regex that allows anything between the tag and content.
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId1 =
      html1.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html1.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    expect(reqId1).toBeDefined();

    // Load again to confirm it's cached (same request ID)
    const res2 = await waitForCacheHit(request, "/revalidate-tag-test");
    const html2 = await res2.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId2 =
      html2.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html2.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    expect(res2.headers()["x-vinext-cache"]).toBe("HIT");
    expect(reqId2).toBe(reqId1);

    // Call revalidateTag API
    const tagRes = await request.get(`${baseUrl()}/api/revalidate-tag`);
    expect(tagRes.status()).toBe(200);
    const tagText = await tagRes.text();
    expect(tagText).toBe("ok");

    // Reload — content should be different (cache was invalidated)
    const res3 = await request.get(`${baseUrl()}/revalidate-tag-test`);
    const html3 = await res3.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId3 =
      html3.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html3.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];

    // After invalidation, should get fresh content
    expect(reqId3).not.toBe(reqId1);

    // Cache header should be MISS after invalidation
    expect(res3.headers()["x-vinext-cache"]).toBe("MISS");
  });

  test("revalidatePath invalidates specific path", async ({ request }) => {
    // Ref: opennextjs-cloudflare revalidateTag.test.ts "Revalidate path"
    test.setTimeout(30_000);

    // Load the page to populate cache
    const res1 = await request.get(`${baseUrl()}/revalidate-tag-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId1 =
      html1.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html1.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    expect(reqId1).toBeDefined();

    // Wait a moment, then call revalidatePath
    await new Promise((r) => setTimeout(r, 500));

    const pathRes = await request.get(`${baseUrl()}/api/revalidate-path`);
    expect(pathRes.status()).toBe(200);
    expect(await pathRes.text()).toBe("ok");

    // Reload — content should be different
    const res2 = await request.get(`${baseUrl()}/revalidate-tag-test`);
    const html2 = await res2.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId2 =
      html2.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html2.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];

    expect(reqId2).not.toBe(reqId1);
  });

  test("after invalidation + regen, subsequent request is HIT", async ({ request }) => {
    // Ref: opennextjs-cloudflare revalidateTag.test.ts — after MISS, next request should be HIT
    test.setTimeout(30_000);

    // Populate cache
    await request.get(`${baseUrl()}/revalidate-tag-test`);

    // Invalidate
    await request.get(`${baseUrl()}/api/revalidate-tag`);

    // First request after invalidation — MISS (regen)
    await request.get(`${baseUrl()}/revalidate-tag-test`);

    // Second request — should be HIT now
    const hitRes = await waitForCacheHit(request, "/revalidate-tag-test");
    expect(hitRes.headers()["x-vinext-cache"]).toBe("HIT");
  });

  // Ref: opennextjs-cloudflare revalidateTag.test.ts — "nested page shares tag"
  // Tests: ON-2 #2 in TRACKING.md
  test("nested page sharing same tag is also invalidated", async ({ request }) => {
    test.setTimeout(30_000);

    // Load nested page to populate cache
    const res1 = await request.get(`${baseUrl()}/revalidate-tag-test/nested`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    const ts1 = html1.match(/Fetched time:\s*(?:<!--.*?-->)*\s*(\d+)/)?.[1];
    expect(ts1).toBeDefined();

    // Invalidate "test-data" tag (shared between parent and nested pages)
    const tagRes = await request.get(`${baseUrl()}/api/revalidate-tag`);
    expect(tagRes.status()).toBe(200);

    // Reload nested page — should get fresh content
    const res2 = await request.get(`${baseUrl()}/revalidate-tag-test/nested`);
    const html2 = await res2.text();
    const ts2 = html2.match(/Fetched time:\s*(?:<!--.*?-->)*\s*(\d+)/)?.[1];

    expect(ts2).not.toBe(ts1);
  });
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
  test("unstable_cache returns consistent data across requests", async ({ request }) => {
    // Ref: opennextjs-cloudflare isr.test.ts — data cache separate from page cache
    const res1 = await request.get(`${baseUrl()}/unstable-cache-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    // React SSR inserts <!-- --> comment nodes between text and expressions
    const value1 = html1.match(/CachedValue:\s*(?:<!--[^>]*-->)*\s*([a-z0-9]{4,})/)?.[1];
    expect(value1).toBeDefined();

    // Second request should return the same cached value
    const res2 = await request.get(`${baseUrl()}/unstable-cache-test`);
    const html2 = await res2.text();
    const value2 = html2.match(/CachedValue:\s*(?:<!--[^>]*-->)*\s*([a-z0-9]{4,})/)?.[1];

    expect(value2).toBe(value1);
  });

  // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-static/app-static.test.ts
  test("unstable_cache bypasses cache in draft mode", async ({ request }) => {
    const key = `bypass-${Date.now()}`;

    try {
      expect((await request.get(`${baseUrl()}/nextjs-compat/api/draft-enable`)).status()).toBe(200);

      const draft1 = await readDraftCachePage(request, key);
      const draft2 = await readDraftCachePage(request, key);

      expect(draft1.data).not.toBe(draft2.data);
    } finally {
      await request.get(`${baseUrl()}/nextjs-compat/api/draft-disable`);
    }
  });

  test("unstable_cache does not cache new results in draft mode", async ({ request }) => {
    const key = `write-${Date.now()}`;

    let draft;
    try {
      expect((await request.get(`${baseUrl()}/nextjs-compat/api/draft-enable`)).status()).toBe(200);
      draft = await readDraftCachePage(request, key);
    } finally {
      await request.get(`${baseUrl()}/nextjs-compat/api/draft-disable`);
    }

    const normal = await readDraftCachePage(request, key);

    expect(draft).toBeDefined();
    expect(draft.data).not.toBe(normal.data);
  });

  test("unstable_cache exposes draft mode status", async ({ request }) => {
    const key = `status-${Date.now()}`;

    const normal = await readDraftCachePage(request, key);
    expect(normal.draftMode).toBe("false");

    try {
      expect((await request.get(`${baseUrl()}/nextjs-compat/api/draft-enable`)).status()).toBe(200);
      const draft = await readDraftCachePage(request, key);
      expect(draft.draftMode).toBe("true");
    } finally {
      await request.get(`${baseUrl()}/nextjs-compat/api/draft-disable`);
    }
  });

  // Extended from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-static/app-static.test.ts
  test("dynamic error pages keep draft cache bypass separate from access errors", async ({
    request,
  }) => {
    const normal = await readDynamicErrorDraftCachePage(request);

    try {
      expect((await request.get(`${baseUrl()}/nextjs-compat/api/draft-enable`)).status()).toBe(200);
      const draft1 = await readDynamicErrorDraftCachePage(request);
      const draft2 = await readDynamicErrorDraftCachePage(request);

      expect(draft1.draftMode).toBe("true");
      expect(draft1.data).not.toBe(normal.data);
      expect(draft2.data).not.toBe(draft1.data);
    } finally {
      await request.get(`${baseUrl()}/nextjs-compat/api/draft-disable`);
    }

    expect((await readDynamicErrorDraftCachePage(request)).data).toBe(normal.data);
  });

  test("dynamic error route handlers keep draft cache bypass separate from access errors", async ({
    request,
  }) => {
    const normal = await readDraftCacheRoute(request);

    try {
      expect((await request.get(`${baseUrl()}/nextjs-compat/api/draft-enable`)).status()).toBe(200);
      const draft1 = await readDraftCacheRoute(request);
      const draft2 = await readDraftCacheRoute(request);

      expect(draft1.draftMode).toBe(true);
      expect(draft1.data).not.toBe(normal.data);
      expect(draft2.data).not.toBe(draft1.data);
    } finally {
      await request.get(`${baseUrl()}/nextjs-compat/api/draft-disable`);
    }

    expect((await readDraftCacheRoute(request)).data).toBe(normal.data);
  });
});

async function readDraftCachePage(request: APIRequestContext, key: string) {
  const response = await request.get(
    `${baseUrl()}/nextjs-compat/unstable-cache-draft?key=${encodeURIComponent(key)}`,
  );
  expect(response.status()).toBe(200);
  const html = await response.text();
  return {
    data: html.match(/id="cached-data">([^<]+)/)?.[1],
    draftMode: html.match(/id="draft-mode-enabled">([^<]+)/)?.[1],
  };
}

async function readDynamicErrorDraftCachePage(request: APIRequestContext) {
  const response = await request.get(
    `${baseUrl()}/nextjs-compat/unstable-cache-draft-dynamic-error`,
  );
  expect(response.status()).toBe(200);
  const html = await response.text();
  return {
    data: html.match(/id="cached-data">([^<]+)/)?.[1],
    draftMode: html.match(/id="draft-mode-enabled">([^<]+)/)?.[1],
  };
}

async function readDraftCacheRoute(request: APIRequestContext) {
  const response = await request.get(
    `${baseUrl()}/nextjs-compat/api/unstable-cache-draft-dynamic-error`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as { data: string; draftMode: boolean };
}
