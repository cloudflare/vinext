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

test("serves the document of an ISR page that calls notFound() or redirect() from the ISR cache", async ({
  request,
}) => {
  for (const { pathname, status, location, rscStatus, digest } of [
    {
      pathname: "/nextjs-compat/isr-special-error/not-found",
      status: 404,
      location: undefined,
      rscStatus: 404,
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    },
    {
      pathname: "/nextjs-compat/isr-special-error/redirect",
      status: 307,
      location: "/nextjs-compat/nav-redirect-result",
      // An RSC response carries the redirect in its payload, as in Next.js.
      rscStatus: 200,
      digest: "NEXT_REDIRECT;",
    },
  ]) {
    // The first document request renders and stores the page.
    await expect
      .poll(
        async () => (await request.get(pathname, { maxRedirects: 0 })).headers()["x-vinext-cache"],
      )
      .toBe("HIT");
    const response = await request.get(pathname, { maxRedirects: 0 });
    expect(response.status()).toBe(status);
    expect(response.headers()["location"]).toBe(location);
    expect(response.headers()["cache-control"]).toContain("s-maxage=60");

    // The same render stored the page's RSC payload, with the same status.
    const rscResponse = await request.get(`${pathname}.rsc`, {
      headers: RSC_HEADERS,
      maxRedirects: 0,
    });
    expect(rscResponse.status()).toBe(rscStatus);
    expect(rscResponse.headers()["x-vinext-cache"]).toBe("HIT");
    expect(rscResponse.headers()["location"]).toBe(location);
    expect(await rscResponse.text()).toContain(digest);
  }
});

test("stores the 404 document of an ISR page without the query of the request that rendered it", async ({
  request,
}) => {
  const pathname = "/nextjs-compat/isr-special-error/not-found-query";
  const miss = await request.get(`${pathname}?token=SECRET`);
  expect(miss.status()).toBe(404);
  expect(miss.headers()["x-vinext-cache"]).toBe("MISS");
  await miss.text();

  // The miss stored the page, so the next request is a HIT.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const hit = await request.get(pathname);
  expect(hit.status()).toBe(404);
  expect(hit.headers()["x-vinext-cache"]).toBe("HIT");
  expect(await hit.text()).not.toContain("SECRET");
});
