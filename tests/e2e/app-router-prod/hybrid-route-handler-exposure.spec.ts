/**
 * Issue #3624: a hybrid App/Pages client receives App route handler paths only
 * as hashed segments, which still let the Pages Router send a `<Link>` to a
 * handler that outranks a Pages route through a document navigation instead
 * of rendering the Pages route.
 *
 * Fixture:
 *   tests/fixtures/app-basic/pages/pages-to-app/[slug].tsx
 *   tests/fixtures/app-basic/app/pages-to-app/hidden-endpoint/route.ts
 */
import { expect, test } from "@playwright/test";
import { waitForHydration } from "../helpers";

type RouteGlobals = {
  __VINEXT_APP_ROUTE_HANDLERS__?: unknown[];
  __VINEXT_LINK_PREFETCH_ROUTES__?: unknown[];
};

test("a Pages Link to an App route handler that outranks the Pages route loads it as a document", async ({
  page,
}) => {
  const handlerRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/pages-to-app/hidden-endpoint") {
      handlerRequests.push(request.resourceType());
    }
  });
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
