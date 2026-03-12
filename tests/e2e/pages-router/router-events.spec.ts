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

  test("beforeHistoryChange fires between routeChangeStart and routeChangeComplete", async ({
    page,
  }) => {
    await page.click('[data-testid="push-about"]');
    await expect(page.locator("h1")).toHaveText("About");

    const events: string[] = await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    }, STORAGE_KEY);

    const startIdx = events.findIndex((e) => e === "start:/about");
    const beforeIdx = events.findIndex((e) => e === "beforeHistoryChange:/about");
    const completeIdx = events.findIndex((e) => e === "complete:/about");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(beforeIdx).toBeGreaterThan(startIdx);
    expect(completeIdx).toBeGreaterThan(beforeIdx);
  });

  test("hashChangeStart and hashChangeComplete fire on hash-only push with full URL", async ({
    page,
  }) => {
    await page.click('[data-testid="push-hash"]');

    const events: string[] = await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    }, STORAGE_KEY);

    // Event URL should include pathname, not just the fragment
    expect(events).toContain("hashChangeStart:/router-events-test#section-1");
    expect(events).toContain("hashChangeComplete:/router-events-test#section-1");
    // Should NOT fire routeChange or beforeHistoryChange events for hash-only navigation
    expect(events.some((e) => e.startsWith("start:"))).toBe(false);
    expect(events.some((e) => e.startsWith("complete:"))).toBe(false);
    expect(events.some((e) => e.startsWith("beforeHistoryChange:"))).toBe(false);
  });

  test("hashChangeStart fires before hashChangeComplete on hash push", async ({ page }) => {
    await page.click('[data-testid="push-hash"]');

    const events: string[] = await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    }, STORAGE_KEY);

    const startIdx = events.findIndex((e) => e.startsWith("hashChangeStart:"));
    const completeIdx = events.findIndex((e) => e.startsWith("hashChangeComplete:"));
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(startIdx);
  });

  test("hashChangeStart and hashChangeComplete fire on hash-only replace with full URL", async ({
    page,
  }) => {
    await page.click('[data-testid="replace-hash"]');

    const events: string[] = await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    }, STORAGE_KEY);

    expect(events).toContain("hashChangeStart:/router-events-test#section-2");
    expect(events).toContain("hashChangeComplete:/router-events-test#section-2");
    expect(events.some((e) => e.startsWith("start:"))).toBe(false);
    expect(events.some((e) => e.startsWith("complete:"))).toBe(false);
    expect(events.some((e) => e.startsWith("beforeHistoryChange:"))).toBe(false);
  });

  test("hash-only back/forward emits hashChange events, not routeChange", async ({ page }) => {
    // Push a hash change, then go back — popstate should detect hash-only navigation
    await page.click('[data-testid="push-hash"]');
    await page.click('[data-testid="clear-events"]');
    await page.goBack();

    // Wait for popstate handler to record events
    await page.waitForFunction((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw).length > 0 : false;
    }, STORAGE_KEY);

    const events: string[] = await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    }, STORAGE_KEY);

    // Should emit hashChange events for hash-only back navigation
    expect(events.some((e) => e.startsWith("hashChangeStart:"))).toBe(true);
    expect(events.some((e) => e.startsWith("hashChangeComplete:"))).toBe(true);
    // Should NOT emit routeChange or beforeHistoryChange events
    expect(events.some((e) => e.startsWith("start:"))).toBe(false);
    expect(events.some((e) => e.startsWith("complete:"))).toBe(false);
    expect(events.some((e) => e.startsWith("beforeHistoryChange:"))).toBe(false);
  });

  test("hash-only forward emits hashChange events, not routeChange", async ({ page }) => {
    // Push a hash, go back, wait for popstate to settle, clear events, then go forward
    await page.click('[data-testid="push-hash"]');
    await page.goBack();
    await page.waitForFunction((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw).length > 0 : false;
    }, STORAGE_KEY);
    await page.click('[data-testid="clear-events"]');
    await page.goForward();

    await page.waitForFunction((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw).length > 0 : false;
    }, STORAGE_KEY);

    const events: string[] = await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    }, STORAGE_KEY);

    expect(events.some((e) => e.startsWith("hashChangeStart:"))).toBe(true);
    expect(events.some((e) => e.startsWith("hashChangeComplete:"))).toBe(true);
    expect(events.some((e) => e.startsWith("start:"))).toBe(false);
    expect(events.some((e) => e.startsWith("complete:"))).toBe(false);
    expect(events.some((e) => e.startsWith("beforeHistoryChange:"))).toBe(false);
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
