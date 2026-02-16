import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("App Router ISR", () => {
  // ISR fixture at /isr-test uses `export const revalidate = 1` (1 second TTL).
  // The full lifecycle: MISS -> HIT -> (wait for TTL) -> STALE -> HIT (regenerated)

  test("first request returns ISR page with cache header", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/isr-test`);

    expect(res.status()).toBe(200);

    const html = await res.text();
    expect(html).toContain("App Router ISR Test");
    expect(html).toContain("Hello from ISR");

    const cacheHeader = res.headers()["x-vinext-cache"];
    expect(cacheHeader).toBeDefined();
    expect(["MISS", "HIT", "STALE"]).toContain(cacheHeader);
  });

  test("second request within TTL is a cache HIT with same timestamp", async ({
    request,
  }) => {
    // First request: populate cache
    const res1 = await request.get(`${BASE}/isr-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    // Second request immediately: should be cached
    const res2 = await request.get(`${BASE}/isr-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    const cacheHeader = res2.headers()["x-vinext-cache"];
    expect(cacheHeader).toBe("HIT");
    expect(ts2).toBe(ts1);
  });

  test("request after TTL expires returns STALE with same cached content", async ({
    request,
  }) => {
    // Populate cache
    const res1 = await request.get(`${BASE}/isr-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1500));

    // Should get STALE content (same timestamp as cached version)
    const res2 = await request.get(`${BASE}/isr-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];
    const cacheHeader2 = res2.headers()["x-vinext-cache"];

    expect(cacheHeader2).toBe("STALE");
    expect(ts2).toBe(ts1);
  });

  test("after STALE triggers regen, subsequent request is HIT", async ({
    request,
  }) => {
    // Populate cache
    await request.get(`${BASE}/isr-test`);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1500));

    // Trigger STALE (starts background regen)
    const staleRes = await request.get(`${BASE}/isr-test`);
    expect(staleRes.headers()["x-vinext-cache"]).toBe("STALE");

    // Wait for background regen to complete
    await new Promise((r) => setTimeout(r, 500));

    // Next request should be HIT
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
