/**
 * Link navigation to a prefetched route that calls redirect(). Link prefetching
 * is production-only, so this runs against the production app-basic server.
 *
 * A page's redirect() streams inside its Flight payload. A layout's redirect()
 * is answered early with the `X-Vinext-Rsc-Redirect` side channel, which a
 * replayed prefetch must keep. An auto prefetch of such a redirect must not
 * outlive `staleTimes.dynamic` when the layout read a dynamic API, nor the
 * `cacheLife` stale time of a cached value the layout read.
 *
 * Next.js parity: `next start` (16.2.7) follows each redirect as a client
 * navigation with the per-variant request counts below. Upstream has no Link +
 * prefetch test for a route calling redirect(); the closest is the
 * production-only prefetch + click case for a middleware redirect in
 * test/e2e/app-dir/rsc-redirect/rsc-redirect.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-redirect/rsc-redirect.test.ts
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
  // Page redirect() (the issue's reproduction). Static and full-prefetched
  // dynamic pages are replayed from the prefetch cache; an auto prefetch of a
  // dynamic page is fetched again by the click or its hover prefetch, as
  // Next.js does not prefetch dynamic page data on auto.
  { name: "static", refetchesOnClick: false },
  { name: "dynamic", refetchesOnClick: false },
  { name: "dynamic-auto", refetchesOnClick: true },
  // Layout redirect(). A static layout redirect and a full prefetch replay the
  // prefetched redirect; a layout that read cookies() bounds an auto prefetch
  // by `staleTimes.dynamic` (0 by default), so the click or its hover
  // prefetch fetches it again.
  { name: "layout-redirect", refetchesOnClick: false },
  { name: "layout-guard-full", refetchesOnClick: false },
  { name: "layout-guard", refetchesOnClick: true },
  // A layout that redirects after a `"use cache"` read with `stale: 45`.
  { name: "layout-cache-life", refetchesOnClick: false, serverStaleTime: "45" },
] as const;

for (const variantCase of VARIANTS) {
  const { name: variant, refetchesOnClick } = variantCase;
  const serverStaleTime = "serverStaleTime" in variantCase ? variantCase.serverStaleTime : null;
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
    const prefetchResponse = await prefetched;
    expect(await prefetchResponse.headerValue("x-nextjs-stale-time")).toBe(serverStaleTime);
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
