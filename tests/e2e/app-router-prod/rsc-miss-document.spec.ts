import { expect, test, type Page } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const SOURCE = "/soft-nav-cache";
const TARGET = "/route-cache-identity/rsc-miss-document-e2e";
const HEADING = "CACHE_IDENTITY_CATCH_ALL:rsc-miss-document-e2e";

async function push(page: Page, href: string, heading: string): Promise<void> {
  await page.evaluate((target) => {
    const router = window.next?.router;
    if (!router) throw new Error("window.next.router is not installed");
    void router.push(target);
  }, href);
  await expect(page.locator("h1")).toHaveText(heading);
}

// Next.js keeps a page's document and RSC payload in one entry, so a soft
// navigation that misses the cache stores the page's document too, and the
// page's first document request is a hit that hydrates.
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/templates/app-page.ts
test("serves a page's first document request from the entry its soft navigation stored", async ({
  page,
}) => {
  const rscCacheStates: (string | null)[] = [];
  page.on("response", (response) => {
    if (isAppRouterRscRequestForPath(response.request(), TARGET)) {
      rscCacheStates.push(response.headers()["x-vinext-cache"] ?? null);
    }
  });

  await page.goto(SOURCE);
  await waitForAppRouterHydration(page);
  // A programmatic push isn't prefetched, so it requests the page.
  await push(page, TARGET, HEADING);
  await expect.poll(() => rscCacheStates).toEqual(["MISS"]);

  // The RSC entry is written first, then the document beside it.
  await expect
    .poll(async () => {
      const response = await page.request.get(`${TARGET}.rsc`, {
        headers: { Accept: "text/x-component", RSC: "1" },
      });
      return response.headers()["x-vinext-cache"] ?? null;
    })
    .toBe("HIT");

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const document = await page.goto(TARGET);
  expect(document?.headers()["x-vinext-cache"]).toBe("HIT");
  await waitForAppRouterHydration(page);
  await expect(page.locator("h1")).toHaveText(HEADING);
  expect(errors).toEqual([]);
});
