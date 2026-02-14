import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("Client-side navigation", () => {
  test("Link click navigates without full page reload", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

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

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    await page.click('[data-testid="push-about"]');
    await expect(page.locator("h1")).toHaveText("About");

    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);
    expect(page.url()).toBe(`${BASE}/about`);
  });

  test("router.replace navigates without adding history entry", async ({ page }) => {
    // Start at home, then go to nav-test, then replace to SSR
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

    // Navigate to nav-test via direct navigation
    await page.goto(`${BASE}/nav-test`);
    await expect(page.locator("h1")).toHaveText("Navigation Test");

    await page.click('[data-testid="replace-ssr"]');
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered");
    expect(page.url()).toBe(`${BASE}/ssr`);

    // Go back — should go to home (not nav-test, because replace replaced it)
    await page.goBack();
    await expect(page.locator("h1")).not.toHaveText("Navigation Test");
  });

  test("browser back/forward buttons work after client navigation", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

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

    await page.click('[data-testid="link-ssr"]');
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered");

    // The SSR page should have data from getServerSideProps
    await expect(page.locator('[data-testid="message"]')).toHaveText(
      "Hello from getServerSideProps",
    );
  });
});
