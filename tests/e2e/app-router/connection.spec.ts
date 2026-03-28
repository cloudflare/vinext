import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("connection() dynamic rendering", () => {
  test("connection() page returns no-store Cache-Control despite revalidate config", async ({
    request,
  }) => {
    // The fixture has `export const revalidate = 60` but also calls `connection()`.
    // connection() should override ISR and force dynamic rendering.
    const res = await request.get(`${BASE}/connection-test`);

    expect(res.status()).toBe(200);

    const cc = res.headers()["cache-control"];
    expect(cc).toBeDefined();
    expect(cc).toContain("no-store");
  });

  test("connection() page has no ISR cache header", async ({ request }) => {
    const res = await request.get(`${BASE}/connection-test`);

    // Should NOT have X-Vinext-Cache since it's fully dynamic
    const cacheHeader = res.headers()["x-vinext-cache"];
    expect(cacheHeader).toBeUndefined();
  });

  test("connection() page returns different timestamps on each request", async ({ request }) => {
    const res1 = await request.get(`${BASE}/connection-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    // Small wait to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));

    const res2 = await request.get(`${BASE}/connection-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    // Timestamps should differ — page is not cached
    expect(Number(ts2)).toBeGreaterThan(Number(ts1));
  });

  test("connection() page renders correctly in browser", async ({ page }) => {
    await page.goto(`${BASE}/connection-test`);

    await expect(page.getByTestId("connection-test-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Connection Test");
    await expect(page.getByTestId("message")).toContainText("connection()");
  });
});
