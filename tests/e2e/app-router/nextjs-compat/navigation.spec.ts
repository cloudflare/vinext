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
import {
  isAppRouterRscRequestForPath,
  waitForAppRouterHydration,
  waitForHydration,
} from "../../helpers";

const BASE = "http://localhost:4174";

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
    await waitForAppRouterHydration(page);

    await page.click("#redirect-btn");
    await expect(page.locator("#result-page")).toHaveText("Result Page", {
      timeout: 10_000,
    });
    expect(page.url()).toContain("/nextjs-compat/nav-redirect-result");
  });

  // Ported from Next.js: test/e2e/app-dir/navigation/navigation.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
  test("client-side redirect() sentinel navigates and resets the boundary", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-client-redirect-sentinel`);
    await waitForAppRouterHydration(page);

    await page.click("#trigger-redirect");
    await expect(page.locator("#result-page")).toHaveText("Result Page", {
      timeout: 10_000,
    });
    expect(page.url()).toContain("/nextjs-compat/nav-redirect-result");
  });

  test("client-side redirect() guard navigates once and does not loop", async ({ page }) => {
    const loginRscRequests: string[] = [];
    page.on("request", (request) => {
      if (isAppRouterRscRequestForPath(request, "/nextjs-compat/nav-redirect-guard/login")) {
        loginRscRequests.push(request.url());
      }
    });

    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);

    await page.evaluate(() => {
      const router = window.next?.router;
      if (!router) {
        throw new Error("window.next.router is not installed");
      }
      void router.push("/nextjs-compat/nav-redirect-guard");
    });

    await expect(page.locator("#redirect-guard-login")).toHaveText("Login Page", {
      timeout: 10_000,
    });
    expect(new URL(page.url()).pathname).toBe("/nextjs-compat/nav-redirect-guard/login");
    await page.waitForLoadState("networkidle");
    expect(loginRscRequests).toHaveLength(1);
  });

  test("client-side navigation from App Router does not leak stale params into Pages Router", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/app-to-pages-params/alpha`);
    await waitForAppRouterHydration(page);

    await page.click("#go-to-pages-params");
    await waitForHydration(page);

    await expect(page.locator("#params")).toHaveText('{"foo":"foo"}', {
      timeout: 10_000,
    });
    await expect(page.locator("#params-change-count")).toHaveText("1");
  });

  // Next.js: 'should trigger not-found in a server component'
  // Source: navigation.test.ts#L136-L146
  test("server component notFound() renders not-found component", async ({ page }) => {
    const response = await page.goto(`${BASE}/nextjs-compat/nav-notfound-server`);
    expect(response?.status()).toBe(404);
    // Should render the root not-found.tsx content
    await expect(page.locator("body")).toContainText("404");
  });

  // Next.js: 'should trigger not-found client-side'
  // Source: navigation.test.ts#L155-L165
  test("client-side notFound() trigger renders not-found component", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-client-notfound`);
    await waitForAppRouterHydration(page);

    // Verify the page loaded correctly first
    await expect(page.locator("#notfound-trigger-page")).toHaveText("Not Found Trigger Page");

    // Click button to trigger notFound()
    await page.click("#trigger-notfound");

    // Should render the not-found component
    await expect(async () => {
      const text = await page.locator("body").textContent();
      expect(text).toContain("404");
    }).toPass({ timeout: 10_000 });

    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  });

  // Next.js: Link-based client-side navigation
  test("Link navigates client-side without full reload", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForAppRouterHydration(page);

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

  // Client-side navigation to a non-existent route should render not-found
  // This is the core bug from the issue: clicking a Link to a page that doesn't
  // exist should render the not-found.tsx boundary, not a blank white page.
  test("Link to non-existent route renders not-found via client navigation", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForAppRouterHydration(page);

    // Set marker to verify it's a client-side navigation (no full reload)
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Click Link to a non-existent page
    await page.click("#link-to-nonexistent");

    // Should render the not-found.tsx content (not a blank page)
    await expect(page.locator("body")).toContainText("404", {
      timeout: 10_000,
    });
    expect(page.url()).toContain("/this-route-does-not-exist");
  });

  // Client-side navigation to a page that calls notFound() should render not-found
  test("Link to page calling notFound() renders not-found via client navigation", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForAppRouterHydration(page);

    // Click Link to a page that calls notFound()
    await page.click("#link-to-notfound-page");

    // Should render the not-found.tsx content (not a blank page)
    await expect(page.locator("body")).toContainText("404", {
      timeout: 10_000,
    });
    expect(page.url()).toContain("/notfound-test");
  });

  // Back/forward navigation
  test("browser back button works after client navigation", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForAppRouterHydration(page);

    // Navigate to result page
    await page.click("#link-to-result");
    await expect(page.locator("#result-page")).toHaveText("Result Page", {
      timeout: 10_000,
    });

    // Go back
    await page.goBack();
    await expect(page.locator("#link-test-page")).toHaveText("Link Test Page", { timeout: 10_000 });
  });

  test("Link onNavigate reports the resolved URL for relative query hrefs", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForAppRouterHydration(page);
    await expect(async () => {
      const ready = await page.evaluate(() => !!(window as any).__APP_RELATIVE_QUERY_LINK_READY__);
      expect(ready).toBe(true);
    }).toPass({ timeout: 10_000 });

    await page.evaluate(() => {
      delete (window as any).__APP_RELATIVE_ONNAV_URL__;
    });

    await page.click("#link-relative-query");
    await expect(page.locator("#relative-query-page")).toHaveText("Current page param: 2", {
      timeout: 10_000,
    });
    expect(page.url()).toBe(`${BASE}/nextjs-compat/nav-link-test?page=2`);

    const reportedUrl = await page.evaluate(
      () => (window as any).__APP_RELATIVE_ONNAV_URL__ ?? null,
    );
    expect(reportedUrl).toBe("/nextjs-compat/nav-link-test?page=2");
  });

  // Ported from Next.js: test/e2e/app-dir/navigation/navigation.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
  test("router.push to an external URL keeps useTransition pending until unload", async ({
    page,
  }) => {
    const storageKey = `external-${Date.now()}`;
    await page.goto(`${BASE}/nextjs-compat/router-push-external-pending/${storageKey}`);
    await waitForAppRouterHydration(page);

    await page.click("#go");
    await page.waitForURL("https://example.vercel.sh/stuff?abc=123", { timeout: 10_000 });

    await page.goto(`${BASE}/nextjs-compat/router-push-external-pending/${storageKey}`);
    await expect(page.locator("#storage")).toContainText(
      `path-/nextjs-compat/router-push-external-pending/${storageKey}`,
    );
    const stored = JSON.parse((await page.locator("#storage").textContent()) ?? "{}");

    expect(stored).toMatchObject({
      [`path-/nextjs-compat/router-push-external-pending/${storageKey}`]: "true",
      lastIsPending: "true",
    });

    if (stored["navigation-supported"] === "true") {
      expect(stored["navigate-https://example.vercel.sh/stuff?abc=123"]).toBe("1");
    }
  });
});
