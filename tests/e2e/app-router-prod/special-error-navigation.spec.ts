import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// A page's redirect() and notFound() reach a client navigation as a digest in
// the RSC payload, as in Next.js, which also stores that render in the ISR
// cache.
const RSC_HEADERS = { Accept: "text/x-component", RSC: "1" };

async function clickFromLinksPage(page: Page, linkId: string): Promise<void> {
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

test("client navigation follows a page's redirect()", async ({ page }) => {
  await clickFromLinksPage(page, "link-to-redirect-page");
  await expect(page.locator("#result-page")).toHaveText("Result Page");
  expect(page.url()).toContain("/nextjs-compat/nav-redirect-result");
  await expectNoReload(page);
});

test("client navigation renders a page's notFound()", async ({ page }) => {
  await clickFromLinksPage(page, "link-to-notfound-page");
  await expect(page.locator("body")).toContainText("404");
  expect(page.url()).toContain("/notfound-test");
  await expectNoReload(page);
});

test("serves the RSC payload of a page that calls notFound() or redirect() from the ISR cache", async ({
  request,
}) => {
  for (const [pathname, digest] of [
    ["/notfound-test", "NEXT_HTTP_ERROR_FALLBACK;404"],
    ["/nextjs-compat/nav-redirect-server", "NEXT_REDIRECT;"],
  ]) {
    // The first request may already hit an entry stored by an earlier test.
    await request.get(`${pathname}.rsc`, { headers: RSC_HEADERS });
    const response = await request.get(`${pathname}.rsc`, { headers: RSC_HEADERS });
    expect(response.status()).toBe(200);
    expect(response.headers()["x-vinext-cache"]).toBe("HIT");
    expect(await response.text()).toContain(digest);
  }
});
