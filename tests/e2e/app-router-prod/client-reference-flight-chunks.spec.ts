import { test, expect, type Page, type Route } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

// Chunk requests still in flight when a test ends must not fail it.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/**
 * The chunks that register the client references of the document at
 * `pathname`, which its Flight data names (see
 * shims/internal/client-reference-loader.ts).
 */
async function referenceModuleChunkUrls(page: Page, pathname: string): Promise<string[]> {
  const response = await page.request.get(pathname);
  const html = await response.text();
  const urls = [...html.matchAll(/\\?"m(\/[^"\\]+\.js)/g)].map(
    (match) => new URL(match[1]!, response.url()).href,
  );
  expect(urls.length, `${pathname} names no client reference chunks`).toBeGreaterThan(0);
  return [...new Set(urls)];
}

async function routeChunks(
  page: Page,
  urls: readonly string[],
  handle: (route: Route) => Promise<void>,
): Promise<void> {
  await page.route(/\/_next\/static\/chunks\/[^/]+\.js$/, async (route) => {
    if (urls.includes(route.request().url())) await handle(route);
    else await route.continue();
  });
}

// The App browser entry names no client reference chunk (#4179). As in
// Next.js, each client reference's Flight row names the chunks it loads, and
// hydration waits for them.
test("client components hydrate once the chunks their Flight rows name load", async ({ page }) => {
  const chunkUrls = await referenceModuleChunkUrls(page, "/actions");
  const requested = new Set<string>();
  let releaseChunks!: () => void;
  const chunksReleased = new Promise<void>((resolve) => {
    releaseChunks = resolve;
  });
  await routeChunks(page, chunkUrls, async (route) => {
    requested.add(route.request().url());
    const response = await route.fetch();
    await chunksReleased;
    await route.fulfill({ response });
  });

  await page.goto("/actions", { waitUntil: "domcontentloaded" });
  await expect.poll(() => requested.size).toBe(chunkUrls.length);
  // The entry has booted, and hydration waits for the client references.
  await expect.poll(() => page.evaluate(() => Boolean(window.__VINEXT_RSC_ROOT__))).toBe(true);
  expect(await page.evaluate(() => window.__VINEXT_HYDRATED_AT)).toBeUndefined();

  releaseChunks();
  await waitForAppRouterHydration(page);
  await page.click('[data-testid="like-btn"]');
  await expect(page.locator('[data-testid="likes"]')).not.toHaveText("Likes: 0");
});

test("a client navigation loads the chunks of the client references it renders", async ({
  page,
}) => {
  const homeChunks = new Set(await referenceModuleChunkUrls(page, "/"));
  const dashboardChunks = (await referenceModuleChunkUrls(page, "/dashboard")).filter(
    (url) => !homeChunks.has(url),
  );
  expect(dashboardChunks.length).toBeGreaterThan(0);
  const requested = new Set<string>();
  page.on("request", (request) => requested.add(request.url()));

  await page.goto("/");
  await waitForAppRouterHydration(page);
  await page.click('a[href="/dashboard"]');
  await expect(page).toHaveURL(/\/dashboard$/);
  const layoutCount = page.getByText("Layout count:");
  await expect(layoutCount).toHaveText("Layout count: 0");
  await layoutCount.locator("xpath=..").getByRole("button", { name: "+1" }).click();
  await expect(layoutCount).toHaveText("Layout count: 1");
  for (const url of dashboardChunks) expect(requested).toContain(url);
});

// Decoding a payload loads the chunks its rows name, so a prefetched payload
// from another deployment isn't decoded: its navigation hard-navigates.
for (const skewed of [false, true]) {
  test(`a prefetch ${skewed ? "from another deployment doesn't load" : "loads"} the chunks its rows name`, async ({
    page,
  }) => {
    const homeChunks = new Set(await referenceModuleChunkUrls(page, "/"));
    const dashboardChunks = (await referenceModuleChunkUrls(page, "/dashboard")).filter(
      (url) => !homeChunks.has(url),
    );
    expect(dashboardChunks.length).toBeGreaterThan(0);
    let prefetched!: () => void;
    const prefetchedPromise = new Promise<void>((resolve) => {
      prefetched = resolve;
    });
    // The home page's links prefetch other routes, whose rows can name the
    // same chunks.
    await page.route(
      (url) => url.searchParams.has("_rsc") && url.pathname !== "/dashboard",
      (route) => route.abort(),
    );
    await page.route(
      (url) => url.pathname === "/dashboard",
      async (route) => {
        if (!isAppRouterRscRequestForPath(route.request(), "/dashboard")) return route.continue();
        const response = await route.fetch();
        prefetched();
        return route.fulfill({
          response,
          headers: skewed
            ? { ...response.headers(), "x-vinext-rsc-compatibility-id": "another-deployment" }
            : response.headers(),
        });
      },
    );
    const requested = new Set<string>();
    page.on("request", (request) => requested.add(request.url()));

    await page.goto("/");
    await waitForAppRouterHydration(page);
    await page.evaluate(() => window.next?.router?.prefetch("/dashboard"));
    await prefetchedPromise;
    if (skewed) {
      // Give the prefetch time to settle before checking nothing loaded.
      await page.waitForTimeout(500);
      for (const url of dashboardChunks) expect(requested).not.toContain(url);
    } else {
      await expect.poll(() => dashboardChunks.every((url) => requested.has(url))).toBe(true);
    }
  });
}

// Refreshing an intercepted modal also refreshes its source page. A source
// page refresh from another deployment isn't decoded either: the refresh
// hard-navigates.
test("a refresh whose source page comes from another deployment hard-navigates", async ({
  page,
}) => {
  await page.goto("/feed");
  await waitForAppRouterHydration(page);
  await page.click("#feed-photo-42-link");
  await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();

  await page.route(
    (url) => url.pathname === "/feed",
    async (route) => {
      if (!isAppRouterRscRequestForPath(route.request(), "/feed")) return route.continue();
      const response = await route.fetch();
      return route.fulfill({
        response,
        headers: { ...response.headers(), "x-vinext-rsc-compatibility-id": "another-deployment" },
      });
    },
  );
  const documentRequest = page.waitForRequest(
    (request) => request.isNavigationRequest() && new URL(request.url()).pathname === "/photos/42",
  );
  await page.click('[data-testid="photo-modal-refresh"]');
  await documentRequest;
  await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
});

// A client reference fails with its chunk's load error, so the client
// components don't render.
test("a client reference chunk that fails to load fails hydration with its load error", async ({
  page,
}) => {
  const chunkUrls = await referenceModuleChunkUrls(page, "/actions");
  await routeChunks(page, chunkUrls, (route) => route.abort());
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/actions");
  await expect
    .poll(() => pageErrors.some((message) => chunkUrls.some((url) => message.includes(url))))
    .toBe(true);
  await expect(page.locator('[data-testid="like-btn"]')).toHaveCount(0);
});
