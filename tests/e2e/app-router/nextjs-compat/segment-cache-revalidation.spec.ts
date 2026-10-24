// Ported from Next.js:
// test/e2e/app-dir/segment-cache/revalidation/segment-cache-revalidation.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/revalidation/segment-cache-revalidation.test.ts
//
// "delay re-prefetch after revalidation to allow CDN propagation" is ported as
// is. The revalidatePath, revalidateTag and router.prefetch(..., {onInvalidate})
// tests share its shape, so each runs here with the cooldown checks too. Not
// ported: the Form test (vinext never re-prefetches a visible Form after a cache
// invalidation, and Form prefetches don't serve navigations) and "re-fetch
// visible links after a navigation", which doesn't involve a revalidation.

import { expect, test, type Request } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const ROOT = "/nextjs-compat/segment-cache-revalidation";
const GREETING = `${ROOT}/greeting`;

const cases = [
  {
    name: "delay re-prefetch after revalidation to allow CDN propagation",
    toggle: `input[data-link-accordion="${GREETING}"]`,
    link: `a[data-link-accordion-anchor="${GREETING}"]`,
    action: "#revalidate-by-path",
  },
  {
    name: "evict client cache when Server Action calls revalidateTag",
    toggle: `input[data-link-accordion="${GREETING}"]`,
    link: `a[data-link-accordion-anchor="${GREETING}"]`,
    action: "#revalidate-by-tag",
  },
  {
    name: "call router.prefetch(..., {onInvalidate}) after cache is revalidated",
    toggle: `input[data-manual-prefetch-link-accordion="${GREETING}"]`,
    link: `a[data-manual-prefetch-link="${GREETING}"]`,
    action: "#revalidate-by-path",
  },
];

test.describe("Next.js compat: segment cache revalidation", () => {
  for (const { name, toggle, link, action } of cases) {
    test(name, async ({ page }) => {
      const greetingRequests: Request[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === GREETING && request.headers()["rsc"] === "1") {
          greetingRequests.push(request);
        }
      });

      // Install fake timers before the page loads so the 300ms cooldown
      // setTimeout in the browser can be frozen later. Until it is paused the
      // fake clock runs in real time.
      await page.clock.install();
      await page.goto(ROOT);
      await waitForAppRouterHydration(page);

      // Reveal the link to the target page to trigger a prefetch.
      await page.locator(toggle).click();
      await expect.poll(() => greetingRequests.length).toBeGreaterThan(0);
      await Promise.all(greetingRequests.map((request) => request.response()));

      // Freeze the clock so the cooldown only ends when the test advances it.
      // Next.js leaves the fake clock running in real time; pausing keeps the
      // checks below independent of how long each step takes.
      const pageNow = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(pageNow + 5_000);

      // The revalidation triggers a 300ms cooldown before any new prefetch.
      greetingRequests.length = 0;
      const actionResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.request().headers()["next-action"] !== undefined,
      );
      await page.click(action);
      await (await actionResponse).finished();

      // The cooldown timer is frozen, so no prefetch has gone out.
      await page.waitForTimeout(200);
      expect(greetingRequests).toEqual([]);

      // Advance partway through the cooldown — still no prefetch.
      await page.clock.fastForward(150);
      await page.waitForTimeout(200);
      expect(greetingRequests).toEqual([]);

      // Advancing past the cooldown re-prefetches the target.
      await page.clock.fastForward(150);
      await expect.poll(() => greetingRequests.length).toBe(1);
      await greetingRequests[0].response();

      // The page is fully prefetched, so navigating makes no requests.
      greetingRequests.length = 0;
      await page.locator(link).click();
      await expect(page.locator("#greeting")).toHaveText("Hello");
      expect(greetingRequests).toEqual([]);
    });
  }
});
