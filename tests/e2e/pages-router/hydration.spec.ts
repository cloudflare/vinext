import { test, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4173";

test.describe("Hydration", () => {
  // The consoleErrors fixture automatically fails tests if any console errors occur.
  // This catches React hydration mismatches, runtime errors, etc.

  test("interactive counter works after hydration", async ({ page, consoleErrors }) => {
    await page.goto(`${BASE}/counter`);

    // SSR should render the initial count
    await expect(page.locator('[data-testid="count"]')).toContainText("Count:");

    await waitForHydration(page);

    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 1");

    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 2");

    await page.click('[data-testid="decrement"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 1");

    void consoleErrors;
  });

  test("SSR HTML is present before hydration (no flash)", async ({ page }) => {
    // Disable JavaScript to see the SSR-only HTML
    await page.route("**/*.js", (route) => route.abort());

    await page.goto(`${BASE}/`);

    // Even without JS, the page content should be there from SSR
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");
    await expect(page.locator("p")).toContainText("This is a Pages Router app running on Vite.");
  });

  test("_app.tsx wrapper persists across client navigations", async ({ page, consoleErrors }) => {
    await page.goto(`${BASE}/`);

    // App wrapper should be present
    await expect(page.locator('[data-testid="app-wrapper"]')).toBeVisible();
    await expect(page.locator('[data-testid="global-nav"]')).toContainText("My App");

    // Navigate to about
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // App wrapper should still be present
    await expect(page.locator('[data-testid="app-wrapper"]')).toBeVisible();
    await expect(page.locator('[data-testid="global-nav"]')).toContainText("My App");

    void consoleErrors;
  });

  test("state is preserved within client navigation", async ({ page, consoleErrors }) => {
    // Start at counter page, increment, then navigate away and back
    await page.goto(`${BASE}/counter`);
    await waitForHydration(page);
    await page.click('[data-testid="increment"]');
    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 2");

    // Navigate away (this fetches new page HTML)
    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

    // Navigate back — state resets because we re-mount the component
    // (this is expected behavior matching Next.js)
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Counter Page");

    void consoleErrors;
  });

  test("__NEXT_DATA__ is present in the page and contains route info", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto(`${BASE}/ssr`);

    const nextData = await page.evaluate(() => (window as any).__NEXT_DATA__);
    expect(nextData).toBeTruthy();
    expect(nextData.page).toBe("/ssr");
    expect(nextData.props.pageProps.message).toBe("Hello from getServerSideProps");

    void consoleErrors;
  });

  test("middleware-matched getServerSideProps does not refetch during hydration", async ({
    page,
    consoleErrors,
  }) => {
    const dataRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/_next/data/")) dataRequests.push(request.url());
    });

    await page.goto(`${BASE}/ssr?middleware=matched`);
    const initialTimestamp = await page.locator('[data-testid="timestamp"]').textContent();
    await waitForHydration(page);
    await page.waitForTimeout(100);

    expect(dataRequests).toEqual([]);
    await expect(page.locator('[data-testid="timestamp"]')).toHaveText(initialTimestamp!);

    void consoleErrors;
  });

  test("getStaticProps query matches SSR before hydration and URL after mount", async ({
    page,
    consoleErrors,
  }) => {
    await page.goto(`${BASE}/nav-compat-gsp/foobar?q=pages`);

    await expect(page.locator("#router-query")).toHaveText('{"slug":"foobar"}');
    await waitForHydration(page);
    await expect(page.locator("#router-query")).toHaveText('{"q":"pages","slug":"foobar"}');

    void consoleErrors;
  });

  test("middleware-rewritten getStaticProps preserves rewrite query after hydration", async ({
    page,
    consoleErrors,
  }) => {
    // Mirrors the dynamic rewrite/query coverage in Next.js:
    // test/e2e/middleware-general/test/index.test.ts
    await page.goto(`${BASE}/mw-rewrite-gsp-query?visible=search`);

    await expect(page.locator("#router-as-path")).toHaveText(
      "/mw-rewrite-gsp-query?visible=search",
    );
    await expect(page.locator("#router-query")).toHaveText('{"slug":"foobar"}');
    await waitForHydration(page);
    await expect(page.locator("#router-as-path")).toHaveText(
      "/mw-rewrite-gsp-query?visible=search",
    );
    await expect(page.locator("#router-query")).toHaveText(
      '{"visible":"search","some":"middleware","hello":"config","slug":"foobar"}',
    );
    await expect(page).toHaveURL(`${BASE}/mw-rewrite-gsp-query?visible=search`);

    void consoleErrors;
  });

  test("fallback page resolves after mount without search parameters", async ({
    page,
    consoleErrors,
  }) => {
    const pid = `fallback-${Date.now()}`;
    await page.goto(`${BASE}/products/${pid}`);

    await expect(page.getByText("Loading product...")).toBeVisible();
    await expect(page.locator('[data-testid="is-ready"]')).toHaveText("isReady: true");
    await expect(page.locator("h1")).toHaveText(`Product: Product ${pid}`);
    await expect(page.locator('[data-testid="is-fallback"]')).toHaveText("isFallback: false");
    await expect(page.locator('[data-testid="is-ready"]')).toHaveText("isReady: true");
    await expect(page.locator('[data-testid="query-pid"]')).toHaveText(`query.pid: ${pid}`);

    void consoleErrors;
  });

  test("fallback page merges visible search parameters after mount", async ({
    page,
    consoleErrors,
  }) => {
    const pid = `fallback-search-${Date.now()}`;
    await page.goto(`${BASE}/products/${pid}?ref=campaign&tag=one&tag=two`);

    await expect(page.getByText("Loading product...")).toBeVisible();
    await expect(page.locator("h1")).toHaveText(`Product: Product ${pid}`);
    await expect(page.locator('[data-testid="query-pid"]')).toHaveText(`query.pid: ${pid}`);
    await expect
      .poll(async () =>
        JSON.parse((await page.locator('[data-testid="router-query"]').textContent())!),
      )
      .toEqual({ pid, ref: "campaign", tag: ["one", "two"] });

    void consoleErrors;
  });

  test("fallback route params override conflicting visible search parameters", async ({
    page,
    consoleErrors,
  }) => {
    const pid = `fallback-conflict-${Date.now()}`;
    await page.goto(`${BASE}/products/${pid}?pid=wrong&ref=campaign`);

    await expect(page.getByText("Loading product...")).toBeVisible();
    await expect(page.locator("h1")).toHaveText(`Product: Product ${pid}`);
    await expect
      .poll(async () =>
        JSON.parse((await page.locator('[data-testid="router-query"]').textContent())!),
      )
      .toEqual({ pid, ref: "campaign" });

    void consoleErrors;
  });
});
