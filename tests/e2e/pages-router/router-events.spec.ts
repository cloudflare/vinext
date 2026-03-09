import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";
const STORAGE_KEY = "router-events-log";

test.describe("router.events (Pages Router)", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the page and clear any stored events
    await page.goto(`${BASE}/router-events-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);
    await page.click('[data-testid="clear-events"]');
  });

  test("routeChangeStart and routeChangeComplete fire on Link click", async ({ page }) => {
    // Click the Link to About
    await page.click('[data-testid="link-about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Read events from sessionStorage (persists across navigations)
    const events = await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    }, STORAGE_KEY);

    expect(events).toContain("start:/about");
    expect(events).toContain("complete:/about");
  });

  test("routeChangeStart fires before routeChangeComplete", async ({ page }) => {
    await page.click('[data-testid="push-ssr"]');
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered");

    const events: string[] = await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    }, STORAGE_KEY);

    const startIdx = events.findIndex((e) => e.startsWith("start:/ssr"));
    const completeIdx = events.findIndex((e) => e.startsWith("complete:/ssr"));
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(startIdx);
  });

  test("events fire on router.push()", async ({ page }) => {
    await page.click('[data-testid="push-about"]');
    await expect(page.locator("h1")).toHaveText("About");

    const events = await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    }, STORAGE_KEY);

    expect(events).toContain("start:/about");
    expect(events).toContain("complete:/about");
  });

  test("multiple navigations produce multiple event pairs", async ({ page }) => {
    // Navigate to about
    await page.click('[data-testid="push-about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Navigate back
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Router Events Test");

    // Navigate to ssr
    await page.click('[data-testid="push-ssr"]');
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered");

    const events: string[] = await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    }, STORAGE_KEY);

    // Should have start+complete for /about, and start+complete for /ssr
    // (back navigation events may also be present)
    const aboutStart = events.filter((e) => e === "start:/about").length;
    const aboutComplete = events.filter((e) => e === "complete:/about").length;
    const ssrStart = events.filter((e) => e === "start:/ssr").length;
    const ssrComplete = events.filter((e) => e === "complete:/ssr").length;

    expect(aboutStart).toBeGreaterThanOrEqual(1);
    expect(aboutComplete).toBeGreaterThanOrEqual(1);
    expect(ssrStart).toBeGreaterThanOrEqual(1);
    expect(ssrComplete).toBeGreaterThanOrEqual(1);
  });
});
