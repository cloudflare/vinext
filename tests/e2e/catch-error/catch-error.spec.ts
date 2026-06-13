// Ported from Next.js:
// test/e2e/app-dir/catch-error/catch-error.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/catch-error/catch-error.test.ts
import { expect, test } from "@playwright/test";
import { disableDevErrorOverlay, waitForAppRouterHydration, waitForHydration } from "../helpers";

const BASE = "http://localhost:4185";
const SERVER_COMPONENT_PROD_ERROR_MESSAGE =
  "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this error instance which may provide additional details about the nature of the error.";

test.describe("app-dir - unstable_catchError", () => {
  test("should recover Client Component error after reset", async ({ page }) => {
    await page.goto(`${BASE}/client-component`);
    await waitForAppRouterHydration(page);

    for (let i = 0; i < 5; i++) {
      await page.locator("#error-trigger-button").click();
      await expect(page.locator("#error-boundary-message")).toHaveText("this is a test");

      await disableDevErrorOverlay(page);
      await page.locator("#reset").click();
      await expect(page.locator("#error-trigger-button")).toHaveText("Trigger Error!");
    }
  });

  test("should recover Client Component error after unstable_retry", async ({ page }) => {
    await page.goto(`${BASE}/client-component`);
    await waitForAppRouterHydration(page);

    for (let i = 0; i < 5; i++) {
      await page.locator("#error-trigger-button").click();
      await expect(page.locator("#error-boundary-message")).toHaveText("this is a test");

      await disableDevErrorOverlay(page);
      await page.locator("#retry").click();
      await expect(page.locator("#error-trigger-button")).toHaveText("Trigger Error!");
    }
  });

  test("should recover Server Component error after unstable_retry", async ({ page }) => {
    await page.goto(`${BASE}/server-component`);
    await waitForAppRouterHydration(page);

    await expect(page.locator("#error-boundary-message")).toHaveText(
      SERVER_COMPONENT_PROD_ERROR_MESSAGE,
    );

    await page.locator("#retry").click();
    await expect(page.locator("#recover")).toHaveText("Recovered");
  });

  test("should recover after reset on Pages Router", async ({ page }) => {
    await page.goto(`${BASE}/pages-router`);
    await waitForHydration(page);

    await page.locator("#pages-trigger").click();
    await expect(page.locator("#pages-error-message")).toHaveText("this is a pages test");

    await disableDevErrorOverlay(page);
    await page.evaluate(() => document.getElementById("pages-reset")?.click());
    await expect(page.locator("#pages-trigger")).toHaveText("Trigger Error!");
  });

  test("should throw when unstable_retry is called on Pages Router", async ({ page }) => {
    await page.goto(`${BASE}/pages-router`);
    await waitForHydration(page);

    await page.locator("#pages-trigger").click();
    await expect(page.locator("#pages-error-message")).toHaveText("this is a pages test");

    await disableDevErrorOverlay(page);
    await page.evaluate(() => document.getElementById("pages-retry")?.click());
    await expect(page.locator("#pages-retry-error")).toHaveText(
      "`unstable_retry()` can only be used in the App Router. Use `reset()` in the Pages Router.",
    );
  });

  test("should preserve the original HTML stream for uncaught server errors and render global-error on the client", async ({
    page,
  }) => {
    // Next-parity test: an uncaught post-shell RSC error with no route/userland
    // boundary should preserve the original HTML stream rather than server-
    // rendering global-error. The client renders global-error during hydration.
    //
    // Ported from Next.js: test/e2e/app-dir/global-error/basic/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/global-error/basic/index.test.ts
    const response = await page.goto(`${BASE}/uncaught-error`);
    expect(response?.status()).toBe(200);

    // The initial HTML response must contain the root layout and loading
    // fallback, not the global-error document. The server preserves the
    // original stream and lets the client Flight/error path decide.
    const html = await response!.text();
    expect(html).toContain('lang="en"');
    expect(html).toContain('<div id="loading">Loading...</div>');
    expect(html).not.toContain("<h1>Global Error</h1>");

    // After hydration, the client renders global-error because the route has
    // no error.tsx and no userland boundary.
    await expect(page.locator("h1")).toHaveText("Global Error");
    await expect(page.locator("#error")).toHaveText(/^Global error: Error:/);
    await expect(page.locator("#digest")).toHaveText(/\w+/);
  });
});
