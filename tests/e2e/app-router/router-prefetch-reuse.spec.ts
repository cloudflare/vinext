/**
 * router.prefetch() navigation reuse (issue #2707).
 *
 * A programmatic router.prefetch(x) followed by a navigation to x must reuse
 * the prefetched RSC payload instead of issuing a second RSC request, matching
 * Next.js's PrefetchKind.AUTO semantics. The /film/[imdbId] fixture has no
 * loading.tsx, so the auto prefetch policy marks it reusable, and /top
 * intercepts it via @modal/(..)film so the test also proves the interception
 * context survives prefetch reuse.
 */
import { test, expect, type Request } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4174";
const FILM_HREF = "/film/tt0068646-the-godfather-1972";

type RouterWindow = Window & {
  next?: { router?: { prefetch(href: string): void; push(href: string): void } };
};

function isFilmRscRequest(request: Request): boolean {
  const url = new URL(request.url());
  return (
    url.pathname.startsWith("/film/") &&
    url.searchParams.has("_rsc") &&
    request.headers()["rsc"] === "1"
  );
}

test.describe("router.prefetch navigation reuse", () => {
  test("click after router.prefetch reuses the prefetched payload", async ({ page }) => {
    const filmRscRequests: string[] = [];
    page.on("request", (request) => {
      if (isFilmRscRequest(request)) filmRscRequests.push(request.url());
    });

    await page.goto(`${BASE}/top`);
    await waitForAppRouterHydration(page);

    await page.evaluate((href) => {
      const router = (window as RouterWindow).next?.router;
      if (router === undefined) throw new Error("Missing app router instance");
      router.prefetch(href);
    }, FILM_HREF);
    await expect.poll(() => filmRscRequests.length).toBe(1);

    await page.click("#godfather-film-link");

    // Interception must stay intact: the modal slot renders the film panel.
    await expect(page.locator('[data-testid="film-panel"]')).toBeVisible();
    await expect(page).toHaveURL(`${BASE}${FILM_HREF}`);

    // The navigation consumed the prefetched payload; no second RSC request.
    expect(filmRscRequests.length).toBe(1);
  });

  test("router.push after router.prefetch reuses the prefetched payload", async ({ page }) => {
    // The literal sequence from the issue: both calls go through the public
    // router, with no <Link> involved.
    const filmRscRequests: string[] = [];
    page.on("request", (request) => {
      if (isFilmRscRequest(request)) filmRscRequests.push(request.url());
    });

    await page.goto(`${BASE}/top`);
    await waitForAppRouterHydration(page);

    await page.evaluate((href) => {
      const router = (window as RouterWindow).next?.router;
      if (router === undefined) throw new Error("Missing app router instance");
      router.prefetch(href);
    }, FILM_HREF);
    await expect.poll(() => filmRscRequests.length).toBe(1);

    await page.evaluate((href) => {
      const router = (window as RouterWindow).next?.router;
      if (router === undefined) throw new Error("Missing app router instance");
      void router.push(href);
    }, FILM_HREF);

    await expect(page.locator('[data-testid="film-panel"]')).toBeVisible();
    await expect(page).toHaveURL(`${BASE}${FILM_HREF}`);
    expect(filmRscRequests.length).toBe(1);
  });

  test("router.prefetch and router.push in the same task issue one request", async ({ page }) => {
    // The race the epoch guard exists for: push() starts before prefetch()
    // setup has registered anything, so there is nothing to share yet.
    //
    // Asserts the contract — the destination renders and the route is fetched
    // once — rather than the mechanism. Cancelling the late prefetch and
    // having navigation adopt an already-started prefetch are both valid ways
    // to satisfy it, and this test accepts either.
    const filmRscRequests: string[] = [];
    page.on("request", (request) => {
      if (isFilmRscRequest(request)) filmRscRequests.push(request.url());
    });

    await page.goto(`${BASE}/top`);
    await waitForAppRouterHydration(page);

    await page.evaluate((href) => {
      const router = (window as RouterWindow).next?.router;
      if (router === undefined) throw new Error("Missing app router instance");
      // No await between them: same task, no polling for the prefetch request.
      router.prefetch(href);
      void router.push(href);
    }, FILM_HREF);

    await expect(page.locator('[data-testid="film-panel"]')).toBeVisible();
    await expect(page).toHaveURL(`${BASE}${FILM_HREF}`);
    expect(filmRscRequests.length).toBe(1);
  });

  test("a shallow history update does not cancel a pending prefetch", async ({ page }) => {
    // Only a navigation that fetches the destination itself makes a pending
    // prefetch for it redundant. A raw history.pushState moves the URL without
    // requesting anything, so it must leave the prefetch running.
    //
    // The unit suite cannot cover this: it stubs window.history, so the shim's
    // pushState patch is never the function under test there.
    const filmRscRequests: string[] = [];
    page.on("request", (request) => {
      if (isFilmRscRequest(request)) filmRscRequests.push(request.url());
    });

    await page.goto(`${BASE}/top`);
    await waitForAppRouterHydration(page);

    await page.evaluate((href) => {
      const router = (window as RouterWindow).next?.router;
      if (router === undefined) throw new Error("Missing app router instance");
      router.prefetch(href);
      // Same task, so this lands while prefetch setup is still in flight, and
      // targets the very href being prefetched — the case that would be
      // cancelled if shallow routing counted as a navigation. The prefetch must
      // also retain /top's call-time interception context rather than reading the
      // target URL after asynchronous policy setup; in production the visible
      // Link already owns that /top-context entry, so a context drift would make
      // this call issue a second request.
      window.history.pushState(null, "", href);
    }, FILM_HREF);

    await expect.poll(() => filmRscRequests.length).toBe(1);
  });

  test("a same-document hash change does not cancel a pending prefetch", async ({ page }) => {
    // The fragment is stripped when comparing a navigation against pending
    // prefetch destinations, because it never reaches the RSC request. That
    // makes a hash-only navigation compare equal to the route it scrolls
    // within — but it issues no request, so it must not cancel anything.
    //
    // Like the shallow-history case above, this cannot live in the unit suite:
    // driving a hash navigation there needs a DOM the harness does not have.
    await page.goto(`${BASE}${FILM_HREF}`);
    await waitForAppRouterHydration(page);

    const filmRscRequests: string[] = [];
    page.on("request", (request) => {
      if (isFilmRscRequest(request)) filmRscRequests.push(request.url());
    });

    await page.evaluate((href) => {
      const router = (window as RouterWindow).next?.router;
      if (router === undefined) throw new Error("Missing app router instance");
      router.prefetch(href);
      // Already on href, so this only scrolls — it is not the navigation that
      // would make the prefetch above redundant.
      void router.push(`${href}#cast`);
    }, FILM_HREF);

    await expect.poll(() => filmRscRequests.length).toBe(1);
  });

  test("click without prefetch issues exactly one navigation request", async ({ page }) => {
    // Guards the request counter above: proves a plain click is observed as a
    // /film/* RSC request, so the reuse test's "still 1" assertion is meaningful.
    const filmRscRequests: string[] = [];
    page.on("request", (request) => {
      if (isFilmRscRequest(request)) filmRscRequests.push(request.url());
    });

    await page.goto(`${BASE}/top`);
    await waitForAppRouterHydration(page);

    await page.click("#godfather-film-link");

    await expect(page.locator('[data-testid="film-panel"]')).toBeVisible();
    await expect.poll(() => filmRscRequests.length).toBe(1);
  });
});
