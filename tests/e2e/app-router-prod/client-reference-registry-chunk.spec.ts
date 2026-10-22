import { test, expect, type Page, type Route } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Chunk requests still in flight when a test ends must not fail it.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** The client reference registry chunk the document at `pathname` names. */
async function registryChunkUrl(page: Page, pathname: string): Promise<string> {
  const response = await page.request.get(pathname);
  const match = (await response.text()).match(
    /self\["__VINEXT_CLIENT_REFERENCE_REGISTRY__"\]="([^"]+)"/,
  );
  expect(match, `${pathname} names no client reference registry chunk`).not.toBeNull();
  return new URL(match![1]!, response.url()).href;
}

async function routeRegistryChunk(
  page: Page,
  registryUrl: string,
  handle: (route: Route) => Promise<void>,
): Promise<void> {
  await page.route(/\/_next\/static\/chunks\/[^/]+\.js$/, async (route) => {
    if (route.request().url() === registryUrl) await handle(route);
    else await route.continue();
  });
}

// The client reference loaders are not part of the App browser entry (#4179).
// The document names and preloads their chunk, and hydration imports it for
// the first client reference it renders.
test("client components hydrate once the client reference registry chunk loads", async ({
  page,
}) => {
  const registryUrl = await registryChunkUrl(page, "/actions");
  const registryRequests: string[] = [];
  let releaseRegistry!: () => void;
  const registryReleased = new Promise<void>((resolve) => {
    releaseRegistry = resolve;
  });
  await routeRegistryChunk(page, registryUrl, async (route) => {
    registryRequests.push(route.request().url());
    const response = await route.fetch();
    await registryReleased;
    await route.fulfill({ response });
  });

  await page.goto("/actions", { waitUntil: "domcontentloaded" });
  await expect.poll(() => registryRequests.length).toBe(1);
  // The entry has booted, and hydration waits for the loaders.
  await expect.poll(() => page.evaluate(() => Boolean(window.__VINEXT_RSC_ROOT__))).toBe(true);
  expect(await page.evaluate(() => window.__VINEXT_HYDRATED_AT)).toBeUndefined();
  const preloads = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map(
      (link) => link.href,
    ),
  );
  expect(preloads).toContain(registryUrl);

  releaseRegistry();
  await waitForAppRouterHydration(page);
  await page.click('[data-testid="like-btn"]');
  await expect(page.locator('[data-testid="likes"]')).not.toHaveText("Likes: 0");
  expect(registryRequests).toHaveLength(1);
});

// Every client reference fails with the chunk's load error, as with a client
// component chunk that fails to load, so the client components don't render.
test("a failed client reference registry chunk fails hydration with its load error", async ({
  page,
}) => {
  const registryUrl = await registryChunkUrl(page, "/actions");
  await routeRegistryChunk(page, registryUrl, (route) => route.abort());
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/actions");
  await expect.poll(() => pageErrors.some((message) => message.includes(registryUrl))).toBe(true);
  await expect(page.locator('[data-testid="like-btn"]')).toHaveCount(0);
});
