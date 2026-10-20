/**
 * Issue #3624: a hybrid App/Pages client receives App route handler paths only
 * as hashed segments, which still let the Pages Router send a `<Link>` to a
 * handler that outranks a Pages route through a document navigation instead
 * of rendering the Pages route. It receives no Pages API route paths at all.
 *
 * Fixture:
 *   tests/fixtures/app-basic/pages/pages-to-app/[slug].tsx
 *   tests/fixtures/app-basic/app/pages-to-app/hidden-endpoint/route.ts
 *   tests/fixtures/app-basic/pages/api/pages-hidden-endpoint.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "../helpers";

type RouteGlobals = {
  __VINEXT_APP_ROUTE_HANDLERS__?: unknown[];
  __VINEXT_LINK_PREFETCH_ROUTES__?: unknown[];
  __VINEXT_PAGES_LINK_PREFETCH_ROUTES__?: unknown[];
};

function recordRequests(page: Page, pathname: string): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === pathname) requests.push(request.resourceType());
  });
  return requests;
}

test("a Pages Link to an App route handler that outranks the Pages route loads it as a document", async ({
  page,
}) => {
  const handlerRequests = recordRequests(page, "/pages-to-app/hidden-endpoint");
  await page.goto("/pages-to-app/abc");
  await waitForHydration(page);

  const routes = await page.evaluate(() => {
    const globals = window as RouteGlobals;
    return {
      handlers: globals.__VINEXT_APP_ROUTE_HANDLERS__ ?? [],
      serialized: JSON.stringify([
        globals.__VINEXT_LINK_PREFETCH_ROUTES__,
        globals.__VINEXT_APP_ROUTE_HANDLERS__,
      ]),
    };
  });
  expect(routes.handlers.length).toBeGreaterThan(0);
  expect(routes.serialized).not.toContain("hidden-endpoint");

  await page.click("#to-route-handler-link");

  await expect(page).toHaveURL(/\/pages-to-app\/hidden-endpoint$/);
  await expect(page.locator("body")).toContainText('"endpoint":"hidden"');
  expect(handlerRequests).toEqual(["document"]);
});

test("a Pages Link to a Pages API route loads it as a document", async ({ page }) => {
  const apiRequests = recordRequests(page, "/api/pages-hidden-endpoint");
  await page.goto("/pages-to-app/abc");
  await waitForHydration(page);

  expect(
    await page.evaluate(() =>
      JSON.stringify((window as RouteGlobals).__VINEXT_PAGES_LINK_PREFETCH_ROUTES__),
    ),
  ).not.toContain("pages-hidden-endpoint");

  await page.click("#to-pages-api-link");

  await expect(page).toHaveURL(/\/api\/pages-hidden-endpoint$/);
  await expect(page.locator("body")).toContainText('"endpoint":"pages-hidden"');
  expect(apiRequests.filter((type) => type === "document")).toEqual(["document"]);
});
