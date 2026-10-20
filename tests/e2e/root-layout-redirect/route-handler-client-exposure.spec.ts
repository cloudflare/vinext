/**
 * Issue #3624: an App Router-only client only gets the route handler paths it
 * needs to tell a handler apart from a page route it outranks for some URL.
 * Like Next.js, it learns any other handler URL from the non-Flight response:
 * a prefetch miss, then a document navigation. Link prefetching and optimistic
 * route shells are production-only, and a hybrid app keeps every handler for
 * App/Pages ownership, so this runs against this App Router-only production
 * server.
 */

import { expect, test, type Page } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const ROOT = "/route-handler-links";
// Client chunk names are hash-only, so find the route manifest chunk by its
// serialized graph instead of its file name.
const ROUTE_MANIFEST_MARKER = '"graphVersion":"graph:';

async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as { __routeHandlerLinksDocument?: boolean }).__routeHandlerLinksDocument = true;
  });
}

async function isSameDocument(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as { __routeHandlerLinksDocument?: boolean }).__routeHandlerLinksDocument === true,
  );
}

test("the client only receives route handler paths that outrank a page route", async ({ page }) => {
  const scripts: string[] = [];
  page.on("response", async (response) => {
    if (!(response.headers()["content-type"] ?? "").includes("javascript")) return;
    scripts.push(await response.text().catch(() => ""));
  });

  await page.goto(ROOT);
  await waitForAppRouterHydration(page);
  await expect
    .poll(() => scripts.some((script) => script.includes(ROUTE_MANIFEST_MARKER)))
    .toBe(true);

  expect(
    await page.evaluate(() =>
      (window.__VINEXT_LINK_PREFETCH_ROUTES__ ?? []).filter((route) => route.documentOnly),
    ),
  ).toEqual([]);
  expect(scripts.filter((script) => script.includes("internal-status"))).toEqual([]);
  // The optimistic route matcher needs this one so it never predicts the
  // catch-all docs page for the handler's URL.
  const routeManifest = scripts.find((script) => script.includes(ROUTE_MANIFEST_MARKER));
  expect(routeManifest).toContain("shadowing-endpoint");
});

test("a Link to a route handler that no page matches loads it as a document", async ({ page }) => {
  await page.goto(ROOT);
  await waitForAppRouterHydration(page);
  await markDocument(page);

  await page.click("#internal-status-link");

  await expect(page).toHaveURL(`${ROOT}/internal-status`);
  await expect(page.locator("body")).toContainText('"status":"internal"');
  expect(await isSameDocument(page)).toBe(false);
});

test("a Link to a route handler under a catch-all page never renders the page's shell", async ({
  page,
}) => {
  // The settled viewport prefetch of the catch-all page teaches the client its
  // loading shell, which it then renders optimistically for any URL it matches.
  const docsPrefetch = page.waitForResponse((response) =>
    isAppRouterRscRequestForPath(response.request(), `${ROOT}/docs/intro`),
  );
  await page.goto(ROOT);
  await waitForAppRouterHydration(page);
  await (await docsPrefetch).finished();
  await page.waitForLoadState("networkidle");
  await markDocument(page);
  // The document navigation below discards window state, so record any
  // catch-all shell in sessionStorage.
  await page.evaluate(() => {
    sessionStorage.removeItem("docs-shell-rendered");
    new MutationObserver(() => {
      if (document.querySelector('[data-testid^="docs-"]')) {
        sessionStorage.setItem("docs-shell-rendered", "true");
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  await page.click("#shadowing-endpoint-link");

  await expect(page).toHaveURL(`${ROOT}/docs/shadowing-endpoint`);
  await expect(page.locator("body")).toContainText('"endpoint":"shadowing"');
  expect(await isSameDocument(page)).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem("docs-shell-rendered"))).toBeNull();
});
