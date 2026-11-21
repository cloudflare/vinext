import { expect, test, type Page } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const SOURCE = "/soft-nav-cache";
const TARGET = "/soft-nav-cache/target";

async function push(page: Page, href: string, heading: string): Promise<void> {
  await page.evaluate((target) => {
    const router = window.next?.router;
    if (!router) throw new Error("window.next.router is not installed");
    void router.push(target);
  }, href);
  await expect(page.locator("h1")).toHaveText(heading);
}

// A soft navigation from a page with a static layout used to send a client
// reuse manifest, and its render was sent no-store and never stored. It's now
// stored and served from the RSC cache like any other RSC request.
test("serves a repeated soft navigation to a static page from the RSC cache", async ({ page }) => {
  const cacheStates: (string | null)[] = [];
  page.on("response", (response) => {
    if (isAppRouterRscRequestForPath(response.request(), TARGET)) {
      cacheStates.push(response.headers()["x-vinext-cache"] ?? null);
    }
  });

  await page.goto(SOURCE);
  await waitForAppRouterHydration(page);
  // A programmatic push isn't prefetched, so each one requests the page.
  await push(page, TARGET, "Soft navigation target");
  await push(page, SOURCE, "Soft navigation source");
  await push(page, TARGET, "Soft navigation target");

  await expect.poll(() => cacheStates.length).toBe(2);
  expect(cacheStates[1]).toBe("HIT");
});
