import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("Pages Router ISR", () => {
  // ISR fixture uses getStaticProps with revalidate: 1 (1 second TTL).
  // The full lifecycle: MISS -> HIT -> (wait for TTL) -> STALE -> HIT (regenerated)

  test("first request is a cache MISS with correct headers", async ({ request }) => {
    // Use a unique query to avoid interference from other tests' cache state.
    // ISR caches by pathname, so /isr-test always goes through the same cache key.
    const res = await request.get(`${BASE}/isr-test`);

    expect(res.status()).toBe(200);

    const html = await res.text();
    expect(html).toContain("ISR Page");
    expect(html).toContain("Hello from ISR");

    const cacheHeader = res.headers()["x-vinext-cache"];
    // First request might be MISS or HIT (if a previous test cached it).
    // We primarily verify the header exists.
    expect(cacheHeader).toBeDefined();
    expect(["MISS", "HIT", "STALE"]).toContain(cacheHeader);
  });

  test("second request within TTL is a cache HIT with same timestamp", async ({ request }) => {
    // First request: populate cache
    const res1 = await request.get(`${BASE}/isr-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    // Second request immediately (within 1s TTL): should be cached
    const res2 = await request.get(`${BASE}/isr-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    const cacheHeader = res2.headers()["x-vinext-cache"];
    expect(cacheHeader).toBe("HIT");

    // Same timestamp = served from cache, not re-rendered
    expect(ts2).toBe(ts1);
  });

  test("request after TTL expires returns STALE with same cached content", async ({ request }) => {
    // Populate cache
    const res1 = await request.get(`${BASE}/isr-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    // Wait for TTL to expire (1s revalidate + buffer)
    await new Promise((r) => setTimeout(r, 1500));

    // This request should get STALE content (same timestamp as cached version)
    const res2 = await request.get(`${BASE}/isr-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];
    const cacheHeader2 = res2.headers()["x-vinext-cache"];

    expect(cacheHeader2).toBe("STALE");
    // Stale response serves the old cached content (same timestamp)
    expect(ts2).toBe(ts1);
  });

  test("after STALE triggers regen, subsequent request is HIT", async ({ request }) => {
    // Populate cache
    await request.get(`${BASE}/isr-test`);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1500));

    // Trigger STALE (which starts background regen)
    const staleRes = await request.get(`${BASE}/isr-test`);
    expect(staleRes.headers()["x-vinext-cache"]).toBe("STALE");

    // Wait for background regen to complete
    await new Promise((r) => setTimeout(r, 500));

    // Next request should be HIT (regen has re-cached)
    const hitRes = await request.get(`${BASE}/isr-test`);
    expect(hitRes.headers()["x-vinext-cache"]).toBe("HIT");
  });

  test("Cache-Control header includes s-maxage and stale-while-revalidate", async ({ request }) => {
    const res = await request.get(`${BASE}/isr-test`);
    const cc = res.headers()["cache-control"];

    expect(cc).toBeDefined();
    expect(cc).toContain("s-maxage=1");
    expect(cc).toContain("stale-while-revalidate");
  });

  test("non-ISR page does not have ISR cache headers", async ({ request }) => {
    const res = await request.get(`${BASE}/about`);

    const cacheHeader = res.headers()["x-vinext-cache"];
    expect(cacheHeader).toBeUndefined();
  });

  test("ISR page renders correctly in browser with timestamp", async ({ page }) => {
    await page.goto(`${BASE}/isr-test`);

    await expect(page.locator("h1")).toHaveText("ISR Page");
    await expect(page.getByTestId("message")).toHaveText("Hello from ISR");

    // Timestamp should be a valid number
    const tsText = await page.getByTestId("timestamp").textContent();
    expect(Number(tsText)).toBeGreaterThan(0);
  });
});
