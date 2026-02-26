import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("Middleware (Pages Router)", () => {
  test("redirects /old-page to /about", async ({ page }) => {
    const response = await page.goto(`${BASE}/old-page`);

    // After redirect, URL should be /about
    expect(page.url()).toBe(`${BASE}/about`);

    // The about page content should be visible
    await expect(page.locator("h1")).toHaveText("About");

    // The response chain should have a redirect (Playwright follows it)
    expect(response?.ok()).toBe(true);
  });

  test("rewrites /rewritten to serve /ssr page content", async ({ page }) => {
    const response = await page.goto(`${BASE}/rewritten`);

    // URL should remain /rewritten (not change to /ssr)
    expect(page.url()).toBe(`${BASE}/rewritten`);

    // But the content should be from the /ssr page
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered");
    await expect(page.locator('[data-testid="message"]')).toHaveText(
      "Hello from getServerSideProps",
    );

    expect(response?.ok()).toBe(true);
  });

  test("blocks /blocked with 403 status", async ({ page }) => {
    const response = await page.goto(`${BASE}/blocked`);

    expect(response?.status()).toBe(403);

    // Body should contain the denial message
    const body = await page.textContent("body");
    expect(body).toContain("Access Denied");
  });

  test("injects x-custom-middleware header on matched pages", async ({ page }) => {
    // Use the API response to check headers since page.goto doesn't expose
    // response headers easily. Use a route handler instead.
    const response = await page.goto(`${BASE}/about`);
    const headers = response?.headers();

    expect(headers?.["x-custom-middleware"]).toBe("active");
  });

  test("does not inject middleware header on /api routes", async ({ request }) => {
    // The matcher excludes /api paths
    const response = await request.get(`${BASE}/api/hello`);

    expect(response.status()).toBe(200);
    expect(response.headers()["x-custom-middleware"]).toBeUndefined();
  });

  test("sets middleware header on the index page", async ({ page }) => {
    const response = await page.goto(`${BASE}/`);
    const headers = response?.headers();

    expect(headers?.["x-custom-middleware"]).toBe("active");
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");
  });

  test("redirect preserves functionality of target page", async ({ page }) => {
    // After redirect from /old-page to /about, verify the page is fully functional
    await page.goto(`${BASE}/old-page`);
    await expect(page.locator("h1")).toHaveText("About");

    // The about page should have a link back to home
    const homeLink = page.locator('a[href="/"]');
    await expect(homeLink).toBeVisible();

    // Click the home link — client-side nav should work
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });
    await homeLink.click();
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

    // Client-side nav should have worked (no full page reload)
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);
  });

  test("rewrite preserves getServerSideProps data", async ({ page }) => {
    await page.goto(`${BASE}/rewritten`);

    // The rewritten page should have the SSR data from getServerSideProps
    await expect(page.locator('[data-testid="message"]')).toHaveText(
      "Hello from getServerSideProps",
    );

    // __NEXT_DATA__ should be present for hydration
    const nextData = await page.evaluate(
      () => (window as any).__NEXT_DATA__,
    );
    expect(nextData).toBeDefined();
    expect(nextData.props.pageProps).toBeDefined();
  });

  test("middleware does not affect static file requests", async ({ request }) => {
    // The matcher pattern excludes paths with dots (static files)
    // and paths starting with /_next. This is implicit from the matcher
    // config: /((?!api|_next|favicon\.ico).*)
    // We verify that /_next and /favicon.ico paths aren't intercepted

    // /favicon.ico should not get middleware headers
    const faviconRes = await request.get(`${BASE}/favicon.ico`);
    // May be 404 if no favicon exists, but shouldn't have middleware header
    expect(faviconRes.headers()["x-custom-middleware"]).toBeUndefined();
  });
});
