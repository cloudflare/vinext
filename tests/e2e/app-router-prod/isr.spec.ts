import { test, expect } from "@playwright/test";

/**
 * Production build ISR E2E tests for App Router.
 *
 * These tests run against `vinext build` + `vinext start` output,
 * NOT the dev server. The production server is started on port 4180
 * via the webServer config in playwright.config.ts.
 *
 * Tests the full MISS → HIT → STALE → regen lifecycle, RSC request
 * caching, and revalidateTag / revalidatePath invalidation.
 *
 * Ported from skipped tests in: tests/e2e/app-router/isr.spec.ts
 * Ref (OpenNext compat): https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/isr.test.ts
 * Ref (OpenNext compat): https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/revalidateTag.test.ts
 */
const BASE = "http://localhost:4180";

test.describe("App Router ISR — production cache lifecycle", () => {
  test("first request is a cache MISS", async ({ request }) => {
    const res = await request.get(`${BASE}/isr-test`);
    expect(res.status()).toBe(200);

    const html = await res.text();
    expect(html).toContain("App Router ISR Test");
    expect(html).toContain("Hello from ISR");

    const cacheHeader = res.headers()["x-vinext-cache"];
    expect(cacheHeader).toBe("MISS");
  });

  test("second request within TTL is a cache HIT with same timestamp", async ({
    request,
  }) => {
    const res1 = await request.get(`${BASE}/isr-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    const res2 = await request.get(`${BASE}/isr-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    expect(res2.headers()["x-vinext-cache"]).toBe("HIT");
    expect(ts2).toBe(ts1);
  });

  test("request after TTL expires returns STALE with same cached content", async ({
    request,
  }) => {
    const res1 = await request.get(`${BASE}/isr-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    // isr-test page has revalidate=1 — wait past TTL
    await new Promise((r) => setTimeout(r, 1500));

    const res2 = await request.get(`${BASE}/isr-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    expect(res2.headers()["x-vinext-cache"]).toBe("STALE");
    expect(ts2).toBe(ts1);
  });

  test("after STALE triggers regen, subsequent request is HIT with fresh content", async ({
    request,
  }) => {
    // Warm the cache
    await request.get(`${BASE}/isr-test`);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1500));

    // This request gets STALE and triggers background regen
    const staleRes = await request.get(`${BASE}/isr-test`);
    expect(staleRes.headers()["x-vinext-cache"]).toBe("STALE");

    // Wait for background regen to complete
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

  test("force-dynamic page has no ISR cache header and uses no-store", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/dynamic-test`);
    expect(res.status()).toBe(200);

    expect(res.headers()["x-vinext-cache"]).toBeUndefined();

    const cc = res.headers()["cache-control"];
    if (cc) {
      expect(cc).toContain("no-store");
    }
  });
});

test.describe("App Router ISR — RSC request caching", () => {
  test("RSC request for ISR page is a MISS on first request", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/isr-test.rsc`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/x-component");
    expect(res.headers()["x-vinext-cache"]).toBe("MISS");
  });

  test("RSC request within TTL is a HIT", async ({ request }) => {
    // Warm the cache with an HTML request
    await request.get(`${BASE}/isr-test`);

    // RSC request should be a HIT (shared cache entry)
    const res = await request.get(`${BASE}/isr-test.rsc`);
    expect(res.status()).toBe(200);
    expect(res.headers()["x-vinext-cache"]).toBe("HIT");
  });

  test("RSC request after TTL expires returns STALE", async ({ request }) => {
    // Warm cache
    await request.get(`${BASE}/isr-test`);

    // Wait for TTL
    await new Promise((r) => setTimeout(r, 1500));

    const res = await request.get(`${BASE}/isr-test.rsc`);
    expect(res.headers()["x-vinext-cache"]).toBe("STALE");
  });
});

test.describe("revalidateTag / revalidatePath lifecycle (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare revalidateTag.test.ts "Revalidate tag"

  test("revalidateTag invalidates cached page and regenerates", async ({
    request,
  }) => {
    test.setTimeout(30_000);

    // Load the tagged ISR page to populate cache
    const res1 = await request.get(`${BASE}/revalidate-tag-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    // React SSR may insert <!-- --> comment nodes between text and expressions
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId1 =
      html1.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html1.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    expect(reqId1).toBeDefined();

    // Second request should be cached (same request ID)
    const res2 = await request.get(`${BASE}/revalidate-tag-test`);
    const html2 = await res2.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId2 =
      html2.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html2.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    expect(["HIT", "STALE"]).toContain(res2.headers()["x-vinext-cache"]);
    expect(reqId2).toBe(reqId1);

    // Invalidate the tag
    const tagRes = await request.get(`${BASE}/api/revalidate-tag`);
    expect(tagRes.status()).toBe(200);
    expect(await tagRes.text()).toBe("ok");

    // Reload — content should be different (cache was invalidated)
    const res3 = await request.get(`${BASE}/revalidate-tag-test`);
    const html3 = await res3.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId3 =
      html3.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html3.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];

    expect(reqId3).not.toBe(reqId1);
    expect(res3.headers()["x-vinext-cache"]).toBe("MISS");
  });

  test("revalidatePath invalidates specific path", async ({ request }) => {
    test.setTimeout(30_000);

    const res1 = await request.get(`${BASE}/revalidate-tag-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId1 =
      html1.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html1.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];
    expect(reqId1).toBeDefined();

    await new Promise((r) => setTimeout(r, 500));

    const pathRes = await request.get(`${BASE}/api/revalidate-path`);
    expect(pathRes.status()).toBe(200);
    expect(await pathRes.text()).toBe("ok");

    const res2 = await request.get(`${BASE}/revalidate-tag-test`);
    const html2 = await res2.text();
    // lgtm[js/redos] — applied to trusted SSR output, not user input
    const reqId2 =
      html2.match(
        /data-testid="request-id"[^>]*>(?:<!--.*?-->)*RequestID:\s*(?:<!--.*?-->)*([a-z0-9]+)/,
      )?.[1] ?? html2.match(/request-id[^>]*>[^<]*?([a-z0-9]{6,})/)?.[1];

    expect(reqId2).not.toBe(reqId1);
  });

  test("after invalidation + regen, subsequent request is HIT", async ({
    request,
  }) => {
    test.setTimeout(30_000);

    // Populate cache
    await request.get(`${BASE}/revalidate-tag-test`);

    // Invalidate
    await request.get(`${BASE}/api/revalidate-tag`);

    // First request after invalidation — MISS (regen)
    await request.get(`${BASE}/revalidate-tag-test`);

    // Second request — should be HIT now
    const hitRes = await request.get(`${BASE}/revalidate-tag-test`);
    expect(hitRes.headers()["x-vinext-cache"]).toBe("HIT");
  });
});
