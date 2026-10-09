import { expect, test, type Page } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

// The browser reads the RSC compatibility ID from the server-rendered page, not
// from its bundle, and compares each RSC response against it. Mirrors Next.js'
// navigation build ID check (fetch-server-response.ts), which takes the ID from
// the initial RSC payload.
const DOCUMENT_MARKER = "__VINEXT_RSC_COMPATIBILITY_DOCUMENT__";
const NAVIGATION_RUNTIME_BOOTSTRAP_SCRIPT_RE =
  /<script>[^<]*vinext\.navigationRuntime[^<]*\.bootstrap\.rsc[^<]*<\/script>/g;

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

/** Resolves true when /about committed in the same document (a soft navigation). */
function isSameDocument(page: Page): Promise<boolean> {
  return page.evaluate((marker) => Reflect.get(window, marker) === true, DOCUMENT_MARKER);
}

async function rewriteHomeDocument(page: Page, rewrite: (html: string) => string): Promise<void> {
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      const html = await response.text();
      const rewritten = rewrite(html);
      expect(rewritten).not.toBe(html);
      return route.fulfill({ response, body: rewritten });
    },
  );
}

async function skewAboutRscResponses(page: Page): Promise<() => number> {
  let skewedResponses = 0;
  await page.route(
    (url) => url.pathname === "/about",
    async (route) => {
      if (!isAppRouterRscRequestForPath(route.request(), "/about")) return route.continue();
      const response = await route.fetch();
      skewedResponses++;
      return route.fulfill({
        response,
        headers: { ...response.headers(), "x-vinext-rsc-compatibility-id": "another-deployment" },
      });
    },
  );
  return () => skewedResponses;
}

test("soft-navigates when RSC responses match the page's compatibility ID", async ({ page }) => {
  await navigateToAbout(page);
  await expect(isSameDocument(page)).resolves.toBe(true);
});

test("hard-navigates when an RSC response carries another compatibility ID", async ({ page }) => {
  const skewedResponses = await skewAboutRscResponses(page);
  await navigateToAbout(page);
  expect(skewedResponses()).toBeGreaterThan(0);
  await expect(isSameDocument(page)).resolves.toBe(false);
});

test("hard-navigates when the page was rendered with another compatibility ID", async ({
  page,
}) => {
  await rewriteHomeDocument(page, (html) =>
    html.replace(/compatibilityId:"[^"]*"/, 'compatibilityId:"another-deployment"'),
  );
  await navigateToAbout(page);
  await expect(isSameDocument(page)).resolves.toBe(false);
});

test.describe("when the page embeds no RSC payload", () => {
  test.beforeEach(async ({ page }) => {
    // Hydration then fetches the payload and takes the ID from that response.
    await rewriteHomeDocument(page, (html) =>
      html.replace(NAVIGATION_RUNTIME_BOOTSTRAP_SCRIPT_RE, ""),
    );
  });

  test("soft-navigates with the initial response's compatibility ID", async ({ page }) => {
    await navigateToAbout(page);
    await expect(isSameDocument(page)).resolves.toBe(true);
  });

  test("hard-navigates when a later response carries another one", async ({ page }) => {
    const skewedResponses = await skewAboutRscResponses(page);
    await navigateToAbout(page);
    expect(skewedResponses()).toBeGreaterThan(0);
    await expect(isSameDocument(page)).resolves.toBe(false);
  });
});
