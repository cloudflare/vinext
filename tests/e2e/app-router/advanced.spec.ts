import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function waitForAppRouterHydration(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => typeof window.__VINEXT_RSC_NAVIGATE__ === "function", null, {
    timeout: 10_000,
  });
}

test.describe("Parallel Routes", () => {
  test("dashboard renders all parallel slot content", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);

    // Dashboard layout
    await expect(page.locator("#dashboard-layout")).toBeVisible();
    await expect(page.locator("#dashboard-layout > nav span")).toHaveText("Dashboard Nav");

    // Main children
    await expect(page.locator("h1")).toHaveText("Dashboard");

    // @team parallel slot
    await expect(page.locator('[data-testid="team-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="team-slot"]')).toBeVisible();

    // @analytics parallel slot
    await expect(page.locator('[data-testid="analytics-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).toBeVisible();
  });

  test("child route renders default.tsx fallbacks for inherited slots", async ({ page }) => {
    await page.goto(`${BASE}/dashboard/settings`);

    // Dashboard layout should still be present
    await expect(page.locator("#dashboard-layout")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Settings");

    // Parallel slots should render their default.tsx components
    await expect(page.locator('[data-testid="team-default"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-default"]')).toBeVisible();

    // Should NOT contain the slot page.tsx content
    await expect(page.locator('[data-testid="team-slot"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).not.toBeVisible();
  });

  test("slot directories are not accessible as direct routes", async ({ page }) => {
    const response = await page.goto(`${BASE}/dashboard/team`);
    expect(response?.status()).toBe(404);
  });
});

test.describe("Intercepting Routes", () => {
  test("direct navigation to photo shows full page", async ({ page }) => {
    await page.goto(`${BASE}/photos/42`);

    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
    await expect(page.locator("h1")).toContainText("Photo");
    await expect(page.locator('[data-testid="photo-page"]')).toContainText("Full photo view");
    // Should NOT contain modal
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
  });

  test("direct payload cache does not override intercepted navigation", async ({ page }) => {
    await page.goto(`${BASE}/photos/42`);
    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();

    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");

    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  test("intercepted payload cache is reused for repeated source-page navigations", async ({
    page,
  }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();

    await page.goto(`${BASE}/about`);
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  test("chained intercepted navigations keep the original source context", async ({ page }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).toContainText("Viewing photo 42");

    await page.click("#modal-photo-43-link");

    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).toContainText("Viewing photo 43");
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  test("refresh on direct photo load preserves the full-page render", async ({ page }) => {
    await page.goto(`${BASE}/photos/42`);
    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();

    await page.reload();
    await waitForAppRouterHydration(page);

    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
  });

  test("hard reload after intercepted navigation renders the full page", async ({ page }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();

    await page.reload();
    await waitForAppRouterHydration(page);

    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).not.toBeVisible();
  });

  test("router.refresh preserves intercepted modal view", async ({ page }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();

    await page.click('[data-testid="photo-modal-refresh"]');

    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  test("server action from intercepted modal preserves modal tree", async ({ page }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();

    const likesLocator = page.locator('[data-testid="photo-likes"]');
    const baselineText = (await likesLocator.textContent()) ?? "";
    const baseline = Number.parseInt(baselineText, 10);
    expect(Number.isFinite(baseline)).toBe(true);

    await page.click('[data-testid="photo-like-btn"]');

    // Wait for the count to change before asserting — avoids a timing race
    // between action fetch and client state update.
    await expect.poll(async () => (await likesLocator.textContent()) ?? "").not.toBe(baselineText);

    const afterText = (await likesLocator.textContent()) ?? "";
    const after = Number.parseInt(afterText, 10);
    expect(after).toBe(baseline + 1);

    // Critical parity assertion: the server-action rerender must keep the
    // intercepted tree mounted — modal visible, source feed layout intact,
    // direct /photos/[id] page NOT rendered, URL unchanged.
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/photos/42");

    // Sanity: a hard refresh still routes to the direct page, mirroring the
    // final assertion in the Next.js reference test.
    await page.reload();
    await waitForAppRouterHydration(page);
    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
  });

  test("sibling (..) intercepted navigation mounts the modal slot", async ({ page }) => {
    // Ported from the sibling-interception behavior covered by Next.js:
    // test/e2e/app-dir/parallel-routes-and-interception/parallel-routes-and-interception.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-and-interception/parallel-routes-and-interception.test.ts
    await page.goto(`${BASE}/sibling-source`);
    await waitForAppRouterHydration(page);

    await page.click("#sibling-target-42-link");

    await page.waitForURL(`${BASE}/sibling-target/42`);
    await expect(page.locator('[data-testid="sibling-source-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="sibling-target-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="sibling-target-modal-id"]')).toContainText(
      "target-id:42",
    );
    await expect(page.locator('[data-testid="sibling-target-page"]')).not.toBeVisible();
  });

  test("top-level sibling (..) film navigation mounts the modal slot", async ({ page }) => {
    await page.goto(`${BASE}/top`);
    await waitForAppRouterHydration(page);

    await page.click("#godfather-film-link");

    await page.waitForURL(`${BASE}/film/tt0068646-the-godfather-1972`);
    await expect(page.locator('[data-testid="top-page"]')).toBeVisible();
    await expect(page.locator("h1")).toContainText("Top 1000");
    await expect(page.locator('[data-testid="film-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="film-panel-id"]')).toContainText(
      "tt0068646-the-godfather-1972",
    );
    await expect(page.locator('[data-testid="detail-page"]')).not.toBeVisible();
  });

  test("sibling (..) modal preserves source content in a parallel feed slot", async ({ page }) => {
    // Ported from Next.js: test/e2e/app-dir/parallel-routes-and-interception/app/(group)/intercepting-parallel-modal
    // https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/parallel-routes-and-interception/app/(group)/intercepting-parallel-modal
    await page.goto(`${BASE}/parallel-sibling-modal/vercel`);
    await waitForAppRouterHydration(page);

    await page.click("#parallel-photo-42-link");

    await page.waitForURL(`${BASE}/parallel-sibling-modal/photo/42`);
    await expect(page.locator('[data-testid="parallel-feed-page"]')).toContainText(
      "Feed for vercel",
    );
    await expect(page.locator('[data-testid="parallel-photo-modal"]')).toHaveText("Photo MODAL 42");
    await expect(page.locator('[data-testid="parallel-photo-page"]')).not.toBeVisible();
  });

  test("direct navigation to slot-only parallel source route renders feed slot", async ({
    page,
  }) => {
    await page.goto(`${BASE}/parallel-sibling-modal/vercel`);

    await expect(page.locator('[data-testid="parallel-sibling-layout"]')).toBeVisible();
    await expect(page.locator('[data-testid="parallel-feed-page"]')).toContainText(
      "Feed for vercel",
    );
    await expect(page.locator('[data-testid="parallel-modal-default"]')).toBeVisible();
    await expect(page.locator('[data-testid="parallel-photo-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="parallel-photo-page"]')).not.toBeVisible();
  });

  test("back then forward restores intercepted modal view", async ({ page }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);

    await page.click("#feed-photo-42-link");
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();

    await page.goBack();
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();

    await page.goForward();
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  });

  test("prefetches keep separate cache entries for feed and gallery interception contexts", async ({
    page,
  }) => {
    await page.goto(`${BASE}/feed`);
    await waitForAppRouterHydration(page);
    await expect
      .poll(async () =>
        page.evaluate(() =>
          Array.from(window.__VINEXT_RSC_PREFETCH_CACHE__?.keys() ?? []).filter((key) =>
            key.includes("/photos/42.rsc"),
          ),
        ),
      )
      .toEqual(["/photos/42.rsc\u0000/feed"]);

    await page.click("#gallery-link");
    await page.waitForURL(`${BASE}/gallery`);
    await waitForAppRouterHydration(page);
    await expect
      .poll(async () =>
        page.evaluate(() =>
          Array.from(window.__VINEXT_RSC_PREFETCH_CACHE__?.keys() ?? [])
            .filter((key) => key.includes("/photos/42.rsc"))
            .sort(),
        ),
      )
      .toEqual(["/photos/42.rsc\u0000/feed", "/photos/42.rsc\u0000/gallery"]);
  });
});

test.describe("Route Segment Config", () => {
  test("force-dynamic page returns no-store Cache-Control", async ({ page }) => {
    const response = await page.goto(`${BASE}/dynamic-test`);
    const headers = response?.headers();
    expect(headers?.["cache-control"]).toContain("no-store");
    await expect(page.locator('[data-testid="dynamic-test-page"]')).toBeVisible();
  });

  test("dynamicParams=false returns 404 for unknown params", async ({ page }) => {
    const response = await page.goto(`${BASE}/products/999`);
    expect(response?.status()).toBe(404);
  });

  test("dynamicParams=false allows known params", async ({ page }) => {
    await page.goto(`${BASE}/products/1`);
    await expect(page.locator('[data-testid="product-page"]')).toBeVisible();
  });
});

test.describe("Template", () => {
  test("root template wraps all pages", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator('[data-testid="root-template"]')).toBeVisible();
  });

  test("root template is present on sub-pages", async ({ page }) => {
    await page.goto(`${BASE}/about`);
    await expect(page.locator('[data-testid="root-template"]')).toBeVisible();
  });
});

test.describe("Viewport Metadata", () => {
  test("viewport exports render as meta tags", async ({ page }) => {
    await page.goto(`${BASE}/metadata-test`);

    // Theme color should be rendered
    const themeColor = page.locator('meta[name="theme-color"]');
    await expect(themeColor).toHaveAttribute("content", "#0070f3");

    // Color scheme should be rendered
    const colorScheme = page.locator('meta[name="color-scheme"]');
    await expect(colorScheme).toHaveAttribute("content", "light dark");
  });
});

test.describe("Shallow Routing (history.pushState/replaceState)", () => {
  test("pushState updates useSearchParams", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);

    // Wait for hydration
    await page.waitForFunction(
      () => typeof (window as any).__VINEXT_RSC_ROOT__ !== "undefined",
      null,
      { timeout: 10000 },
    );

    // Initially no search params
    await expect(page.locator('[data-testid="search"]')).toHaveText("search: ");

    // Click pushState button to set filter=active
    await page.locator('[data-testid="push-filter"]').click({ noWaitAfter: true });

    // useSearchParams should react to the URL change
    await expect(page.locator('[data-testid="search"]')).toHaveText("search: filter=active", {
      timeout: 10_000,
    });

    // URL should be updated
    await expect
      .poll(() => page.url(), { timeout: 10_000 })
      .toContain("/shallow-test?filter=active");
  });

  test("replaceState updates useSearchParams without adding history entry", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);

    await page.waitForFunction(
      () => typeof (window as any).__VINEXT_RSC_ROOT__ !== "undefined",
      null,
      { timeout: 10000 },
    );

    // Replace with sort=name
    await page.locator('[data-testid="replace-sort"]').click({ noWaitAfter: true });

    await expect(page.locator('[data-testid="search"]')).toHaveText("search: sort=name", {
      timeout: 10_000,
    });

    // Going back should go to the page before /shallow-test (not to /shallow-test without params)
    // because replaceState replaces the current entry
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain("/shallow-test?sort=name");
  });

  test("pushState updates usePathname", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);

    await page.waitForFunction(
      () => typeof (window as any).__VINEXT_RSC_ROOT__ !== "undefined",
      null,
      { timeout: 10000 },
    );

    // Initial pathname
    await expect(page.locator('[data-testid="pathname"]')).toHaveText("pathname: /shallow-test");

    // Push new path
    await page.locator('[data-testid="push-path"]').click({ noWaitAfter: true });

    // usePathname should update
    await expect(page.locator('[data-testid="pathname"]')).toHaveText(
      "pathname: /shallow-test/sub",
      { timeout: 10_000 },
    );
  });

  test.fixme("multiple pushState calls update search params correctly", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);

    await page.waitForFunction(
      () => typeof (window as any).__VINEXT_RSC_ROOT__ !== "undefined",
      null,
      { timeout: 10000 },
    );

    // Push filter, then combined
    await page.locator('[data-testid="push-filter"]').click({ noWaitAfter: true });
    await expect(page.locator('[data-testid="search"]')).toHaveText("search: filter=active", {
      timeout: 10_000,
    });

    await page.locator('[data-testid="push-combined"]').click({ noWaitAfter: true });
    await expect(page.locator('[data-testid="search"]')).toHaveText("search: a=1&b=2", {
      timeout: 10_000,
    });

    // Go back should restore previous state
    await page.goBack();
    await expect(page.locator('[data-testid="search"]')).toHaveText("search: filter=active", {
      timeout: 10_000,
    });
  });
});
