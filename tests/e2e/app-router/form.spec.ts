import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function disableViteErrorOverlay(page: import("@playwright/test").Page) {
  // Vite's dev error overlay can sometimes appear and intercept clicks.
  await page
    .addStyleTag({
      content: "vite-error-overlay{display:none !important; pointer-events:none !important;}",
    })
    .catch(() => {
      // best effort
    });
}

/**
 * Wait for RSC hydration.
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });

  await disableViteErrorOverlay(page);
}

test.describe("next/form GET interception", () => {
  test("search page renders with empty state on SSR", async ({ page }) => {
    await page.goto(`${BASE}/search`);
    await expect(page.locator("h1")).toHaveText("Search");
    await expect(page.locator("#search-empty")).toHaveText("Enter a search term");
    await expect(page.locator("#search-form")).toBeVisible();
    await expect(page.locator("#search-input")).toBeVisible();
  });

  test("search page renders with query param from SSR", async ({ page }) => {
    await page.goto(`${BASE}/search?q=hello`);
    await expect(page.locator("h1")).toHaveText("Search");
    await expect(page.locator("#search-result")).toHaveText("Results for: hello");
  });

  test("Form GET submission navigates without full page reload", async ({ page }) => {
    await page.goto(`${BASE}/search`);
    await expect(page.locator("h1")).toHaveText("Search");
    await waitForHydration(page);

    // Set marker to detect full page reload
    await page.evaluate(() => {
      (window as any).__FORM_MARKER__ = true;
    });

    // Type search term and submit
    await page.fill("#search-input", "vite");
    await expect(page.locator("#search-input")).toHaveValue("vite");
    await expect(page.locator("#search-button")).toBeEnabled();
    await page.locator("#search-button").click({ noWaitAfter: true });

    // Wait for search results to appear
    await expect(page.locator("#search-result")).toHaveText("Results for: vite", {
      timeout: 10_000,
    });

    // URL should include query parameter
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain("/search?q=vite");

    // Verify no full page reload (marker should survive)
    const marker = await page.evaluate(() => (window as any).__FORM_MARKER__);
    expect(marker).toBe(true);
  });

  test("Form GET submission updates URL query params", async ({ page }) => {
    await page.goto(`${BASE}/search`);
    await expect(page.locator("h1")).toHaveText("Search");
    await waitForHydration(page);

    await page.fill("#search-input", "react");
    await expect(page.locator("#search-input")).toHaveValue("react");
    await expect(page.locator("#search-button")).toBeEnabled();
    await page.locator("#search-button").click({ noWaitAfter: true });

    await expect(page.locator("#search-result")).toHaveText("Results for: react", {
      timeout: 10_000,
    });
    const url = new URL(page.url());
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("react");
  });

  test("multiple Form submissions work sequentially", async ({ page }) => {
    await page.goto(`${BASE}/search`);
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__FORM_MARKER__ = true;
    });

    // First search
    await page.fill("#search-input", "first");
    await expect(page.locator("#search-input")).toHaveValue("first");
    await expect(page.locator("#search-button")).toBeEnabled();
    await page.locator("#search-button").click({ noWaitAfter: true });
    await expect(page.locator("#search-result")).toHaveText("Results for: first", {
      timeout: 10_000,
    });
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain("/search?q=first");

    // Second search
    await page.fill("#search-input", "second");
    await expect(page.locator("#search-input")).toHaveValue("second");
    await expect(page.locator("#search-button")).toBeEnabled();
    await page.locator("#search-button").click({ noWaitAfter: true });
    await expect(page.locator("#search-result")).toHaveText("Results for: second", {
      timeout: 10_000,
    });
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain("/search?q=second");

    // No full page reload across both
    const marker = await page.evaluate(() => (window as any).__FORM_MARKER__);
    expect(marker).toBe(true);
  });
});
