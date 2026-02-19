import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe('"use cache" file-level directive', () => {
  test("use-cache page renders correctly", async ({ page }) => {
    await page.goto(`${BASE}/use-cache-test`);

    await expect(page.getByTestId("use-cache-test-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Use Cache Test");
    await expect(page.getByTestId("message")).toContainText("use cache");
  });

  // SKIP: ISR page cache is disabled in dev mode (PR #234). File-level "use cache"
  // relies on the ISR page cache to serve identical HTML across requests. This test
  // should run against a production server E2E project.
  test.skip("use-cache page returns same timestamp on repeated requests (cached)", async ({
    request,
  }) => {
    // First request — populates cache
    const res1 = await request.get(`${BASE}/use-cache-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    // Second request immediately — should return same cached timestamp
    const res2 = await request.get(`${BASE}/use-cache-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    expect(ts1).toBe(ts2);
  });

  // SKIP: ISR page cache is disabled in dev mode (PR #234). TTL expiry and
  // stale-while-revalidate are ISR page cache behaviors. This test should run
  // against a production server E2E project.
  test.skip("use-cache page returns fresh data after TTL expires", async ({
    request,
  }) => {
    // First request
    const res1 = await request.get(`${BASE}/use-cache-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    // Wait for the "seconds" profile TTL to expire (revalidate: 1s)
    await new Promise((r) => setTimeout(r, 1500));

    // Third request — should have new data (stale entry triggers re-execution)
    // We may need two requests: one to get stale + trigger regen, one for fresh
    const res2 = await request.get(`${BASE}/use-cache-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    // After revalidation, the timestamp should be different
    // (might need another request if the first returned stale)
    if (ts1 === ts2) {
      // Stale response — try again to get the revalidated one
      await new Promise((r) => setTimeout(r, 100));
      const res3 = await request.get(`${BASE}/use-cache-test`);
      const html3 = await res3.text();
      const ts3 = html3.match(/data-testid="timestamp">(\d+)</)?.[1];
      expect(Number(ts3)).toBeGreaterThan(Number(ts1));
    } else {
      expect(Number(ts2)).toBeGreaterThan(Number(ts1));
    }
  });
});

test.describe('"use cache" function-level directive', () => {
  test("function-level use-cache page renders correctly", async ({ page }) => {
    await page.goto(`${BASE}/use-cache-fn-test`);

    await expect(page.getByTestId("use-cache-fn-test-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Use Cache Function Test");
    await expect(page.getByTestId("message")).toContainText("function-level");
  });

  test("function-level use-cache caches getData return value", async ({
    request,
  }) => {
    // First request
    const res1 = await request.get(`${BASE}/use-cache-fn-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    const dataValue1 = html1.match(/data-testid="data-value">(\d+)</)?.[1];
    expect(dataValue1).toBeDefined();

    // Wait a bit, then make a second request
    await new Promise((r) => setTimeout(r, 100));

    // Second request
    const res2 = await request.get(`${BASE}/use-cache-fn-test`);
    const html2 = await res2.text();
    const dataValue2 = html2.match(/data-testid="data-value">(\d+)</)?.[1];

    // getData() is cached — data-value should be the same
    // (the "seconds" profile caches for 1s, so within 100ms it should still be cached)
    expect(dataValue1).toBe(dataValue2);
  });
});
