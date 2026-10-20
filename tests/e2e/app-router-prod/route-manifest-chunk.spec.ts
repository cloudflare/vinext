import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// The browser RouteManifest is not inlined in the entry chunk (#3957). It loads
// from its own chunk, and navigations and prefetches wait for it: without it,
// the client sends no interception context and the planner rejects intercepted
// payloads.
test("an intercepted navigation started before the route manifest loads waits for it", async ({
  page,
}) => {
  const manifestRequests: string[] = [];
  let releaseManifest!: () => void;
  const manifestReleased = new Promise<void>((resolve) => {
    releaseManifest = resolve;
  });
  await page.route(/vinext-app-route-manifest-[^/]*\.js$/, async (route) => {
    manifestRequests.push(route.request().url());
    await manifestReleased;
    await route.continue();
  });
  const photoRscRequests: { interceptionContext: string | null }[] = [];
  page.on("request", (request) => {
    const headers = request.headers();
    if (headers.rsc !== "1" || !new URL(request.url()).pathname.startsWith("/photos/42")) return;
    photoRscRequests.push({
      interceptionContext: headers["x-vinext-interception-context"] ?? null,
    });
  });

  await page.goto("/feed");
  await waitForAppRouterHydration(page);
  await expect.poll(() => manifestRequests.length).toBe(1);

  await page.click("#feed-photo-42-link");
  // Neither the Link prefetch nor the navigation request leaves before the
  // manifest that resolves its interception context.
  await page.waitForTimeout(300);
  expect(photoRscRequests).toEqual([]);
  await expect(page).toHaveURL(/\/feed$/);
  releaseManifest();

  await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible();
  await expect(page.locator('[data-testid="feed-page"]')).toBeVisible();
  await expect(page.locator('[data-testid="photo-page"]')).not.toBeVisible();
  await expect(page).toHaveURL(/\/photos\/42$/);
  expect(photoRscRequests.length).toBeGreaterThan(0);
  expect(photoRscRequests.every((request) => request.interceptionContext === "/feed")).toBe(true);
  expect(manifestRequests).toHaveLength(1);
});

test("a navigation falls back to a document navigation when the route manifest fails to load", async ({
  page,
}) => {
  await page.route(/vinext-app-route-manifest-[^/]*\.js$/, (route) => route.abort());

  await page.goto("/feed");
  await waitForAppRouterHydration(page);
  await page.evaluate(() => {
    (window as { __routeManifestDocumentMarker?: boolean }).__routeManifestDocumentMarker = true;
  });

  await page.click("#feed-photo-42-link");

  await expect(page).toHaveURL(/\/photos\/42$/);
  await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
  await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
  expect(
    await page.evaluate(
      () => (window as { __routeManifestDocumentMarker?: boolean }).__routeManifestDocumentMarker,
    ),
  ).toBeUndefined();
});
