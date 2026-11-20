import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
// `${ROOT}/admin` renders per request and `${ROOT}/[slug]` has a loading.tsx.
// The server matches static segments on their raw spelling, so it renders
// `[slug]` for `${ROOT}/%61dmin` (see "renders the dynamic sibling for another
// spelling of a page without a recorded prerender" in
// tests/app-rsc-route-matching.test.ts).
const ROOT = "/nextjs-compat/optimistic-encoded";

test("does not show a dynamic sibling's loading shell on a static page prefetched by another spelling", async ({
  page,
}) => {
  await page.goto(`${BASE}${ROOT}/start`);
  await waitForAppRouterHydration(page);
  await expect(page.locator("#start-page")).toHaveText("Start");

  // A loading-shell prefetch that the server renders with `[slug]`. Dev links
  // do not prefetch on viewport entry. An href with search params prefetches
  // the loading shell, whatever route the browser reads it as.
  const prefetchHref = `${ROOT}/%61dmin?view=x`;
  await page.evaluate((href) => {
    const router = Reflect.get(window, "next") as { router: { prefetch(href: string): void } };
    router.router.prefetch(href);
  }, prefetchHref);
  // A navigation learns templates only from settled prefetch cache entries.
  await expect
    .poll(() =>
      page.evaluate((href) => {
        const cache = Reflect.get(window, "__VINEXT_RSC_PREFETCH_CACHE__") as
          | Map<string, { outcome?: string; pending?: Promise<void> }>
          | undefined;
        return Array.from(cache?.entries() ?? []).some(
          ([key, entry]) =>
            key.includes(href) && entry.outcome === "cache-seeded" && entry.pending === undefined,
        );
      }, prefetchHref),
    )
    .toBe(true);

  await page.evaluate(() => {
    new MutationObserver(() => {
      if (document.querySelector("#slug-loading") !== null) {
        Reflect.set(window, "__slugShellSeen", true);
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  // Hold the navigation's response so an optimistic shell would be visible.
  let releaseNavigation!: () => void;
  const navigationGate = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  let navigationRequested = false;
  await page.route(`**${ROOT}/admin?_rsc*`, async (route) => {
    navigationRequested = true;
    await navigationGate;
    await route.continue();
  });

  await page.click("#admin-link");
  // The router starts rendering any optimistic shell before it sends the
  // navigation request, so once the request is held, a shell would be on its
  // way. The observer above records it if it shows up before the release.
  await expect.poll(() => navigationRequested).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.locator("#slug-loading")).toHaveCount(0);

  releaseNavigation();
  await expect(page.locator("#admin-page")).toHaveText("Admin");
  expect(await page.evaluate(() => Reflect.get(window, "__slugShellSeen") === true)).toBe(false);
});
