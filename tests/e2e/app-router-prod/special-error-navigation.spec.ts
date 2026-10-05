import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// A page's redirect() and notFound() reach a client navigation as a digest in
// the RSC payload, as in Next.js. The payload replaces the page, so it is never
// stored and every navigation renders it again.
const RSC_HEADERS = { Accept: "text/x-component", RSC: "1" };

async function navigateFromLinks(page: Page, linkId: string): Promise<void> {
  await page.goto("/nextjs-compat/nav-special-error-links");
  await waitForAppRouterHydration(page);
  await page.evaluate(() => {
    (window as Window & { __NAV_MARKER__?: boolean }).__NAV_MARKER__ = true;
  });
  await page.click(`#${linkId}`);
}

async function expectNoReload(page: Page): Promise<void> {
  const marker = await page.evaluate(
    () => (window as Window & { __NAV_MARKER__?: boolean }).__NAV_MARKER__,
  );
  expect(marker).toBe(true);
}

test("client navigation follows a page's redirect() on every visit", async ({ page }) => {
  for (let visit = 0; visit < 2; visit++) {
    await navigateFromLinks(page, "link-to-redirect-page");
    await expect(page.locator("#result-page")).toHaveText("Result Page");
    expect(page.url()).toContain("/nextjs-compat/nav-redirect-result");
    await expectNoReload(page);
  }
});

test("client navigation renders a page's notFound() on every visit", async ({ page }) => {
  for (let visit = 0; visit < 2; visit++) {
    await navigateFromLinks(page, "link-to-notfound-page");
    await expect(page.locator("body")).toContainText("404");
    expect(page.url()).toContain("/notfound-test");
    await expectNoReload(page);
  }
});

test("does not store the RSC payload of a page that calls notFound() or redirect()", async ({
  request,
}) => {
  for (const [pathname, digest] of [
    ["/notfound-test", "NEXT_HTTP_ERROR_FALLBACK;404"],
    ["/nextjs-compat/nav-redirect-server", "NEXT_REDIRECT;"],
  ]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request.get(`${pathname}.rsc`, { headers: RSC_HEADERS });
      expect(response.status()).toBe(200);
      expect(response.headers()["x-vinext-cache"]).not.toBe("HIT");
      expect(await response.text()).toContain(digest);
    }
  }
});
