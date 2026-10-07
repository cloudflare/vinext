/**
 * Link navigation to a prefetched page whose server component calls
 * redirect(). Link prefetching is production-only, so this runs against the
 * production app-basic server.
 *
 * Next.js parity: `next start` follows the redirect as a client navigation
 * (observed on Next.js 16.3.8 in the issue below). Upstream has no Link +
 * prefetch test for a page calling redirect(); the closest is the
 * production-only prefetch + click case for a middleware redirect in
 * test/e2e/app-dir/rsc-redirect/rsc-redirect.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-redirect/rsc-redirect.test.ts
 * The per-variant request counts below match `next start` on Next.js 16.2.7.
 *
 * Regression for https://github.com/cloudflare/vinext/issues/3745
 */

import { expect, test, type Page } from "@playwright/test";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../../helpers";

const ROOT = "/nextjs-compat/prefetch-redirect";
const MARKER = "__VINEXT_PREFETCH_REDIRECT_MARKER__";

function readMarker(page: Page): Promise<unknown> {
  return page.evaluate((marker) => Reflect.get(window, marker), MARKER);
}

const VARIANTS = [
  // Static and full-prefetched dynamic redirects are replayed from the
  // prefetch cache, as Next.js reuses static and full prefetches.
  { name: "static", refetchesOnClick: false },
  { name: "dynamic", refetchesOnClick: false },
  // The click fetches a dynamic redirect again after an auto prefetch, as in
  // Next.js (which does not prefetch dynamic page data on auto). In vinext the
  // auto prefetch is fetched but expires under `staleTimes.dynamic` (0 by default).
  { name: "dynamic-auto", refetchesOnClick: true },
  // The same holds when a layout reads cookies() and then redirects.
  { name: "layout-guard", refetchesOnClick: true },
] as const;

for (const { name: variant, refetchesOnClick } of VARIANTS) {
  test(`follows a prefetched ${variant} server redirect on the client`, async ({ page }) => {
    const redirectingPath = `${ROOT}/${variant}`;
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    let redirectingRequests = 0;
    page.on("request", (request) => {
      if (isAppRouterRscRequestForPath(request, redirectingPath)) redirectingRequests++;
    });

    const prefetched = page.waitForResponse((response) =>
      isAppRouterRscRequestForPath(response.request(), redirectingPath),
    );
    await page.goto(ROOT);
    await waitForAppRouterHydration(page);
    await prefetched;
    await page.waitForLoadState("networkidle");

    await page.evaluate((marker) => Reflect.set(window, marker, true), MARKER);
    redirectingRequests = 0;

    await page.click(`#prefetch-redirect-${variant}`);
    await expect(page.locator("#prefetch-redirect-target")).toBeVisible();
    await expect(page).toHaveURL(`${ROOT}/target`);

    expect(redirectingRequests).toBe(refetchesOnClick ? 1 : 0);
    // A soft navigation keeps window state; a hard reload would drop it.
    expect(await readMarker(page)).toBe(true);
    expect(consoleErrors.filter((text) => text.includes("RSC navigation error"))).toEqual([]);

    // redirect() replaces the intermediate entry while the Link's push
    // survives, so Back returns to the page that held the link.
    await page.goBack();
    await expect(page.locator("#prefetch-redirect-home")).toBeVisible();
    await expect(page).toHaveURL(ROOT);
    expect(await readMarker(page)).toBe(true);
  });
}
