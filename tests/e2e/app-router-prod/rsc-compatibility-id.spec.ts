import { expect, test, type Page } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

// The browser reads the RSC compatibility ID from the server-rendered page, not
// from its bundle, and compares each RSC response against it. Mirrors Next.js'
// navigation build ID check (fetch-server-response.ts), which takes the ID from
// the initial RSC payload.
const DOCUMENT_MARKER = "__VINEXT_RSC_COMPATIBILITY_DOCUMENT__";

async function navigateToAbout(page: Page): Promise<void> {
  await page.goto("/");
  await waitForAppRouterHydration(page);
  await page.evaluate((marker) => {
    Reflect.set(window, marker, true);
    const router = window.next?.router;
    if (!router) throw new Error("window.next.router is not installed");
    void router.push("/about");
  }, DOCUMENT_MARKER);
  await expect(page.locator("h1")).toHaveText("About");
}

function readDocumentMarker(page: Page): Promise<unknown> {
  return page.evaluate((marker) => Reflect.get(window, marker), DOCUMENT_MARKER);
}

test("soft-navigates when RSC responses match the page's compatibility ID", async ({ page }) => {
  await navigateToAbout(page);
  await expect(readDocumentMarker(page)).resolves.toBe(true);
});

test("hard-navigates when an RSC response carries another compatibility ID", async ({ page }) => {
  let skewedResponses = 0;
  await page.route(
    (url) => url.pathname === "/about",
    async (route) => {
      if (!isAppRouterRscRequestForPath(route.request(), "/about")) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      skewedResponses++;
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "x-vinext-rsc-compatibility-id": "another-deployment",
        },
      });
    },
  );

  await navigateToAbout(page);
  expect(skewedResponses).toBeGreaterThan(0);
  // A fresh document means the router fell back to a full page load.
  await expect(readDocumentMarker(page)).resolves.toBeUndefined();
});
