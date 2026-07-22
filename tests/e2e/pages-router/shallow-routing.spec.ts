import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

/**
 * Wait for the Pages Router to hydrate (the __VINEXT_ROOT__ is set).
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Shallow routing (Pages Router)", () => {
  test("shallow push updates URL without refetching GSSP", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    // Record the initial GSSP call ID
    const initialCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
    expect(initialCallId).toMatch(/^gssp:\d+$/);

    // Set marker to detect full page reload
    await page.evaluate(() => {
      (window as any).__SHALLOW_MARKER__ = true;
    });

    // Click the shallow push button
    await page.click('[data-testid="shallow-push"]');

    // URL should update
    await expect(page).toHaveURL(`${BASE}/shallow-test?tab=settings`);

    // GSSP call ID should NOT change (no server re-fetch)
    const afterCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
    expect(afterCallId).toBe(initialCallId);

    // router.query should reflect the new query params
    const routerQuery = await page.locator('[data-testid="router-query"]').textContent();
    expect(JSON.parse(routerQuery!)).toEqual({ tab: "settings" });

    // No full page reload
    const marker = await page.evaluate(() => (window as any).__SHALLOW_MARKER__);
    expect(marker).toBe(true);
  });

  test("deep push (non-shallow) refetches GSSP", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    const initialCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();

    // Click the deep push button (no shallow option)
    await page.click('[data-testid="deep-push"]');

    // URL should update
    await expect(page).toHaveURL(`${BASE}/shallow-test?tab=profile`);

    // GSSP call ID SHOULD change (server re-fetch occurred)
    await expect(async () => {
      const afterCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
      expect(afterCallId).not.toBe(initialCallId);
    }).toPass({ timeout: 5_000 });
  });

  test("shallow replace updates URL without adding history entry", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    const initialCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();

    await page.evaluate(() => {
      (window as any).__SHALLOW_MARKER__ = true;
    });

    // Click shallow replace
    await page.click('[data-testid="shallow-replace"]');

    // URL should update
    await expect(page).toHaveURL(`${BASE}/shallow-test?view=grid`);

    // GSSP call ID should NOT change
    const afterCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
    expect(afterCallId).toBe(initialCallId);

    // router.query should update
    const routerQuery = await page.locator('[data-testid="router-query"]').textContent();
    expect(JSON.parse(routerQuery!)).toEqual({ view: "grid" });

    // No full page reload
    const marker = await page.evaluate(() => (window as any).__SHALLOW_MARKER__);
    expect(marker).toBe(true);

    // Going back should go to the page BEFORE shallow-test (not the pre-replace state)
    // because replaceState doesn't add a history entry
    await page.goBack();
    // Should have left shallow-test entirely
    await expect(page).not.toHaveURL(/shallow-test/);
  });

  test("shallow push followed by deep push re-fetches with current query", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    const initialCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();

    // Shallow push first
    await page.click('[data-testid="shallow-push"]');
    await expect(page).toHaveURL(`${BASE}/shallow-test?tab=settings`);

    // GSSP unchanged after shallow
    const afterShallowCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
    expect(afterShallowCallId).toBe(initialCallId);

    // Now do a deep push
    await page.click('[data-testid="deep-push"]');
    await expect(page).toHaveURL(`${BASE}/shallow-test?tab=profile`);

    // GSSP should now have been called again
    await expect(async () => {
      const afterDeepCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
      expect(afterDeepCallId).not.toBe(initialCallId);
    }).toPass({ timeout: 5_000 });
  });

  test("router.asPath updates on shallow push", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    // Initial asPath
    const initialAsPath = await page.locator('[data-testid="router-asPath"]').textContent();
    expect(initialAsPath).toBe("/shallow-test");

    // Shallow push
    await page.click('[data-testid="shallow-push"]');

    // asPath should update to include query
    await expect(page.locator('[data-testid="router-asPath"]')).toHaveText(
      "/shallow-test?tab=settings",
    );
  });

  test("dynamic route params update on shallow push across the same route template", async ({
    page,
  }) => {
    // Ported from Next.js: test/e2e/middleware-rewrites/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-rewrites/test/index.test.ts
    await page.goto(`${BASE}/posts/42`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 42");
    await waitForHydration(page);

    await page.evaluate(() =>
      (window as any).next.router.push("/posts/43", undefined, {
        shallow: true,
      }),
    );

    await expect(page).toHaveURL(`${BASE}/posts/43`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 42");
    await expect(page.locator('[data-testid="query"]')).toHaveText("Query ID: 43");
    await expect(page.locator('[data-testid="pathname"]')).toHaveText("Pathname: /posts/[id]");
    await expect(page.locator('[data-testid="as-path"]')).toHaveText("As Path: /posts/43");
  });

  test("router.query preserves repeated search params and router.asPath preserves hash", async ({
    page,
  }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    await page.evaluate(() => {
      window.history.pushState({}, "", "/shallow-test?tag=a&tag=b#frag");
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
    });

    await expect(page.locator('[data-testid="router-query"]')).toHaveText('{"tag":["a","b"]}');
    await expect(page.locator('[data-testid="router-asPath"]')).toHaveText(
      "/shallow-test?tag=a&tag=b#frag",
    );
  });

  test("<Link shallow> click skips GSSP refetch (issue #1332 sub-problem 3)", async ({ page }) => {
    // Mirrors Next.js test/e2e/middleware-trailing-slash 'allows shallow linking
    // with middleware' — clicking <Link href="..." shallow> should update the
    // URL and router.query without triggering a /_next/data fetch.
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    const initialCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();

    const dataRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/_next/data/")) dataRequests.push(url);
    });

    await page.click('[data-testid="shallow-link"]');

    await expect(page).toHaveURL(`${BASE}/shallow-test?via=link`);

    // GSSP call ID stays the same — server was not re-hit
    const afterCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
    expect(afterCallId).toBe(initialCallId);

    // router.query reflects the new query
    const routerQuery = await page.locator('[data-testid="router-query"]').textContent();
    expect(JSON.parse(routerQuery!)).toEqual({ via: "link" });

    // No _next/data requests fired by the shallow click.
    expect(dataRequests).toEqual([]);
  });

  test("<Link> without shallow click triggers GSSP refetch", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    const initialCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();

    await page.click('[data-testid="deep-link"]');

    await expect(page).toHaveURL(`${BASE}/shallow-test?via=deep-link`);

    await expect(async () => {
      const afterCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
      expect(afterCallId).not.toBe(initialCallId);
    }).toPass({ timeout: 5_000 });
  });

  test("router.query preserves catch-all route params as arrays", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__NEXT_DATA__.page = "/docs/[...slug]";
      (window as any).__NEXT_DATA__.query = { slug: ["a", "b"] };
      window.history.pushState({}, "", "/docs/a/b#section");
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
    });

    await expect(page.locator('[data-testid="router-query"]')).toHaveText('{"slug":["a","b"]}');
    await expect(page.locator('[data-testid="router-asPath"]')).toHaveText("/docs/a/b#section");
  });

  test("router.query prefers catch-all route params over same-key search params", async ({
    page,
  }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__NEXT_DATA__.page = "/docs/[...slug]";
      (window as any).__NEXT_DATA__.query = { slug: ["a", "b"] };
      window.history.pushState({}, "", "/docs/a/b?slug=c");
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
    });

    await expect(page.locator('[data-testid="router-query"]')).toHaveText('{"slug":["a","b"]}');
    await expect(page.locator('[data-testid="router-asPath"]')).toHaveText("/docs/a/b?slug=c");
  });
});
