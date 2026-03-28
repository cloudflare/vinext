import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe('"use cache" file-level directive', () => {
  test("use-cache page renders correctly", async ({ page }) => {
    await page.goto(`${BASE}/use-cache-test`);

    await expect(page.getByTestId("use-cache-test-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Use Cache Test");
    await expect(page.getByTestId("message")).toContainText("use cache");
  });

  // In dev mode, shared cache is bypassed so HMR changes are immediately
  // reflected (cache key is module path + export name, not file content).
  // Each request executes fresh, so timestamps differ between requests.
  test("use-cache page returns fresh data on each request in dev mode", async ({ request }) => {
    // First request
    const res1 = await request.get(`${BASE}/use-cache-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    // Small delay to ensure timestamp changes
    await new Promise((r) => setTimeout(r, 50));

    // Second request — should return fresh (different) timestamp in dev
    const res2 = await request.get(`${BASE}/use-cache-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    expect(Number(ts2)).toBeGreaterThan(Number(ts1));
  });

  // TTL expiry: the "seconds" cacheLife profile has revalidate: 1s, so after
  // ~1.5s the cached entry becomes stale and re-execution produces fresh data.
  test("use-cache page returns fresh data after TTL expires", async ({ request }) => {
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

  // In dev mode, shared cache is bypassed for HMR correctness.
  // Each request re-executes getData(), producing fresh values.
  test("function-level use-cache returns fresh data on each request in dev mode", async ({
    request,
  }) => {
    // First request
    const res1 = await request.get(`${BASE}/use-cache-fn-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    const dataValue1 = html1.match(/data-testid="data-value">(\d+)</)?.[1];
    expect(dataValue1).toBeDefined();

    // Wait a bit so timestamp changes
    await new Promise((r) => setTimeout(r, 50));

    // Second request — should return fresh (different) data in dev
    const res2 = await request.get(`${BASE}/use-cache-fn-test`);
    const html2 = await res2.text();
    const dataValue2 = html2.match(/data-testid="data-value">(\d+)</)?.[1];

    expect(Number(dataValue2)).toBeGreaterThan(Number(dataValue1));
  });
});
