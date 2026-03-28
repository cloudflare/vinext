import { test, expect } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4173";

test.describe("Client-side navigation", () => {
  test("Link click navigates without full page reload", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");
    await waitForHydration(page);

    // Store a marker on the window to detect if page fully reloaded
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Click the Link to About
    await page.click('a[href="/about"]');

    // Wait for the About content to appear
    await expect(page.locator("h1")).toHaveText("About");

    // Verify no full reload happened (marker should still be there)
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);

    // URL should have changed
    expect(page.url()).toBe(`${BASE}/about`);
  });

  test("Link navigates back to home from about", async ({ page }) => {
    await page.goto(`${BASE}/about`);
    await expect(page.locator("h1")).toHaveText("About");
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);
    expect(page.url()).toBe(`${BASE}/`);
  });

  test("router.push navigates to a new page", async ({ page }) => {
    await page.goto(`${BASE}/nav-test`);
    await expect(page.locator("h1")).toHaveText("Navigation Test");
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    await page.click('[data-testid="push-about"]');
    await expect(page.locator("h1")).toHaveText("About");

    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);
    expect(page.url()).toBe(`${BASE}/about`);
  });

  test("router.push(url, as) uses the masked URL while resolving the real route", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nav-test`);
    await expect(page.locator("h1")).toHaveText("Navigation Test");
    await waitForHydration(page);

    await page.click('[data-testid="push-post-as-hook"]');
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 42");
    await expect(page.locator('[data-testid="query"]')).toHaveText("Query ID: 42");
    await expect(page.locator('[data-testid="as-path"]')).toHaveText(
      "As Path: /posts/42?from=hook",
    );
    await expect(page.locator('[data-testid="pathname"]')).toHaveText("Pathname: /posts/[id]");
    expect(page.url()).toBe(`${BASE}/posts/42?from=hook`);
  });

  test("router.replace navigates without adding history entry", async ({ page }) => {
    // Start at home, then go to nav-test, then replace to SSR
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

    // Navigate to nav-test via direct navigation
    await page.goto(`${BASE}/nav-test`);
    await expect(page.locator("h1")).toHaveText("Navigation Test");
    await waitForHydration(page);

    await page.click('[data-testid="replace-ssr"]');
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered");
    expect(page.url()).toBe(`${BASE}/ssr`);

    // Go back — should go to home (not nav-test, because replace replaced it)
    await page.goBack();
    await expect(page.locator("h1")).not.toHaveText("Navigation Test");
  });

  test("Router.replace(url, as) uses the masked URL for singleton navigation", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

    await page.goto(`${BASE}/nav-test`);
    await expect(page.locator("h1")).toHaveText("Navigation Test");
    await waitForHydration(page);

    await page.click('[data-testid="replace-post-as-singleton"]');
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 84");
    await expect(page.locator('[data-testid="query"]')).toHaveText("Query ID: 84");
    await expect(page.locator('[data-testid="as-path"]')).toHaveText(
      "As Path: /posts/84?from=singleton",
    );
    expect(page.url()).toBe(`${BASE}/posts/84?from=singleton`);

    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");
  });

  test("browser back/forward buttons work after client navigation", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");
    await waitForHydration(page);

    // Navigate: Home -> About via link
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Go back
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");
    expect(page.url()).toBe(`${BASE}/`);

    // Go forward
    await page.goForward();
    await expect(page.locator("h1")).toHaveText("About");
    expect(page.url()).toBe(`${BASE}/about`);
  });

  test("multiple sequential navigations work", async ({ page }) => {
    await page.goto(`${BASE}/nav-test`);
    await expect(page.locator("h1")).toHaveText("Navigation Test");
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Nav-test -> About
    await page.click('[data-testid="push-about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // About -> Home (via link on about page)
    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

    // Home -> About (via link on home page)
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // All without full reload
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);
  });

  test("navigating to SSR page fetches fresh server data", async ({ page }) => {
    await page.goto(`${BASE}/nav-test`);
    await expect(page.locator("h1")).toHaveText("Navigation Test");
    await waitForHydration(page);

    await page.click('[data-testid="link-ssr"]');
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered");

    // The SSR page should have data from getServerSideProps
    await expect(page.locator('[data-testid="message"]')).toHaveText(
      "Hello from getServerSideProps",
    );
  });
});
