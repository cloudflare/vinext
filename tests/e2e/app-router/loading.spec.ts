import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("Loading boundaries (loading.tsx)", () => {
  test("slow page eventually renders content", async ({ page }) => {
    await page.goto(`${BASE}/slow`);
    // The page should render — loading.tsx should resolve to the actual page
    await expect(page.locator("h1")).toHaveText("Slow Page", {
      timeout: 10_000,
    });
    await expect(page.locator("main > p")).toHaveText("This page has a loading boundary.");
  });

  test("slow page serves HTML response", async ({ page }) => {
    const response = await page.goto(`${BASE}/slow`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-type"]).toContain("text/html");
  });

  /**
   * OpenNext Compat: loading.tsx Suspense visibility timing
   *
   * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/ssr.test.ts
   *
   * OpenNext verifies that loading.tsx boundary is visible BEFORE the page content
   * resolves. This confirms Suspense streaming works correctly — the loading state
   * is sent immediately in the initial HTML shell, then replaced by the resolved content.
   *
   * The slow page has a 2s async delay. The loading.tsx fallback should appear in
   * the initial streamed HTML shell before the page component resolves.
   */
  test("loading boundary is visible before content resolves", async ({ page }) => {
    // Ref: opennextjs-cloudflare ssr.test.ts "Server Side Render and loading.tsx"

    // Navigate to slow page — loading.tsx should show first due to 2s server delay
    void page.goto(`${BASE}/slow`);

    // loading.tsx fallback should appear quickly in the streamed shell
    const loading = page.locator("#loading-fallback");
    await expect(loading).toBeVisible({ timeout: 5_000 });

    // Then the actual page content should resolve
    await expect(page.locator("h1")).toHaveText("Slow Page", {
      timeout: 10_000,
    });
  });

  test("parent loading boundary is included in initial HTML for a slow nested layout", async ({
    request,
  }) => {
    // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app/index.test.ts
    const response = await request.get(`${BASE}/slow-layout-with-loading/slow`);
    expect(response.status()).toBe(200);

    const html = await response.text();
    expect(html).toContain('<p id="loading-layout">Loading layout...</p>');
  });

  test("parent loading boundary streams before an ordinary async nested layout", async ({
    page,
  }) => {
    void page.goto(`${BASE}/slow-layout-with-loading/slow`);

    await expect(page.locator("#loading-layout")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#slow-layout-message")).toHaveText("Slow layout loaded", {
      timeout: 10_000,
    });
  });

  test("client prefetch and navigation use an inherited loading boundary", async ({ page }) => {
    await page.goto(`${BASE}/loading-prefetch-nav`);
    await waitForAppRouterHydration(page);
    expect(
      await page.evaluate(() =>
        window.__VINEXT_LINK_PREFETCH_ROUTES__?.find(
          (route) => route.patternParts.join("/") === "slow-layout-with-loading/slow",
        ),
      ),
    ).toMatchObject({ canPrefetchLoadingShell: true });

    await page.hover("#inherited-loading-link");
    await page.click("#inherited-loading-link");
    await expect(page.locator("#loading-layout")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#slow-layout-message")).toHaveText("Slow layout loaded", {
      timeout: 10_000,
    });
  });

  test("parameterized navigation does not reuse a skipped descendant layout", async ({ page }) => {
    await page.goto(`${BASE}/loading-param-reuse/first`);
    await waitForAppRouterHydration(page);

    await expect(page.getByTestId("loading-param-layout-slug")).toHaveText("Layout slug: first");
    await page.getByTestId("loading-param-second-link").hover();
    await page.getByTestId("loading-param-second-link").click();

    await expect(page.getByTestId("loading-param-page-slug")).toHaveText("Page slug: second");
    await expect(page.getByTestId("loading-param-layout-slug")).toHaveText("Layout slug: second");
  });

  test("segment loading boundary wraps a slow parallel slot", async ({ page }) => {
    void page.goto(`${BASE}/parallel-slot-loading`);

    await expect(page.locator("#parallel-slot-page")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#parallel-slot-loading")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#slow-parallel-slot")).toHaveText("Slow parallel slot loaded", {
      timeout: 10_000,
    });
  });

  test("parent and leaf loading boundaries are included for a slow layout and page", async ({
    request,
  }) => {
    // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app/index.test.ts
    const response = await request.get(`${BASE}/slow-layout-and-page-with-loading/slow`);
    expect(response.status()).toBe(200);

    const html = await response.text();
    expect(html).toContain('<p id="loading-layout">Loading layout...</p>');
    expect(html).toContain('<p id="loading-page">Loading page...</p>');
  });
});
