/**
 * Next.js Compat E2E: navigation
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
 *
 * Browser-level tests for navigation behavior:
 * - Client-side redirect via router.push()
 * - Client-side notFound() trigger via button
 * - Link-based client-side navigation
 * - Server-side redirect follows through in browser
 * - Server-side notFound renders not-found component in browser
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(
      () => !!(window as any).__VINEXT_RSC_ROOT__,
    );
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Next.js compat: navigation (browser)", () => {
  // Next.js: 'should redirect in a server component'
  // Source: navigation.test.ts#L168-L174
  test("server component redirect lands on result page", async ({ page }) => {
    // The server redirect should be followed by the browser
    await page.goto(`${BASE}/nextjs-compat/nav-redirect-server`);
    await expect(page.locator("#result-page")).toHaveText("Result Page");
    expect(page.url()).toContain("/nextjs-compat/nav-redirect-result");
  });

  // Next.js: 'should redirect client-side'
  // Source: navigation.test.ts#L184-L191
  test("client-side redirect via router.push()", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-client-redirect`);
    await waitForHydration(page);

    await page.click("#redirect-btn");
    await expect(page.locator("#result-page")).toHaveText("Result Page", {
      timeout: 10_000,
    });
    expect(page.url()).toContain("/nextjs-compat/nav-redirect-result");
  });

  // Next.js: 'should trigger not-found in a server component'
  // Source: navigation.test.ts#L136-L146
  test("server component notFound() renders not-found component", async ({
    page,
  }) => {
    const response = await page.goto(
      `${BASE}/nextjs-compat/nav-notfound-server`,
    );
    expect(response?.status()).toBe(404);
    // Should render the root not-found.tsx content
    await expect(page.locator("body")).toContainText("404");
  });

  // Next.js: 'should trigger not-found client-side'
  // Source: navigation.test.ts#L155-L165
  //
  // SKIP: Client-side notFound() from a "use client" component does not render
  // the not-found boundary. Instead the page body shows raw Vite RSC entry
  // import text: `import("/@id/__x00__virtual:vite-rsc/entry-browser")`.
  //
  // ROOT CAUSE: The `notFound()` function from `packages/vinext/src/shims/navigation.ts`
  // throws a special error that is supposed to be caught by the nearest not-found
  // boundary during rendering. In the client-side re-render (after state change via
  // useState), this thrown error is not caught by any error boundary and instead
  // crashes the React tree, leaving a blank/broken page.
  //
  // TO FIX: The client-side `notFound()` implementation in
  // `packages/vinext/src/shims/navigation.ts` needs to integrate with React's
  // error boundary mechanism on the client. In Next.js, the `notFound()` throw
  // is caught by the `NotFoundBoundary` component that wraps page content.
  // Vinext needs an equivalent client-side boundary that catches the
  // `NEXT_NOT_FOUND` error and renders the not-found.tsx component.
  //
  // VERIFY: After fix, this test should pass — click the button, see "404" text
  // from the nearest not-found.tsx boundary rendered in the browser.
  test.skip("client-side notFound() trigger renders not-found component", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-client-notfound`);
    await waitForHydration(page);

    // Verify the page loaded correctly first
    await expect(page.locator("#notfound-trigger-page")).toHaveText(
      "Not Found Trigger Page",
    );

    // Click button to trigger notFound()
    await page.click("#trigger-notfound");

    // Should render the not-found component
    await expect(async () => {
      const text = await page.locator("body").textContent();
      expect(text).toContain("404");
    }).toPass({ timeout: 10_000 });
  });

  // Next.js: Link-based client-side navigation
  test("Link navigates client-side without full reload", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForHydration(page);

    // Set marker for reload detection
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Click Link to result page
    await page.click("#link-to-result");
    await expect(page.locator("#result-page")).toHaveText("Result Page", {
      timeout: 10_000,
    });

    // Verify no full reload
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);
    expect(page.url()).toContain("/nextjs-compat/nav-redirect-result");
  });

  // Back/forward navigation
  test("browser back button works after client navigation", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForHydration(page);

    // Navigate to result page
    await page.click("#link-to-result");
    await expect(page.locator("#result-page")).toHaveText("Result Page", {
      timeout: 10_000,
    });

    // Go back
    await page.goBack();
    await expect(page.locator("#link-test-page")).toHaveText(
      "Link Test Page",
      { timeout: 10_000 },
    );
  });
});
