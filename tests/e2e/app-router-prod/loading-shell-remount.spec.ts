import { test, expect, type Page, type Response } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Production links prefetch a loading shell, and a click commits it before the
// real payload arrives. The payload must reuse the loading boundary the shell
// committed, so a navigation mounts one loading.tsx fallback element. Each
// navigation's RSC request is held until the test has seen what the shell
// committed. Regression test for cloudflare/vinext#4075.

async function trackSkeletonMounts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new WeakSet<Element>();
    const state = { mounted: 0 };
    Reflect.set(window, "__skeletonMounts", state);
    const observer = new MutationObserver(() => {
      for (const element of document.querySelectorAll("[data-skeleton]")) {
        if (seen.has(element)) continue;
        seen.add(element);
        state.mounted += 1;
      }
    });
    document.addEventListener("DOMContentLoaded", () =>
      observer.observe(document.body, { childList: true, subtree: true }),
    );
  });
}

function isLoadingShellPrefetch(response: Response, pathname: string): boolean {
  return (
    new URL(response.url()).pathname === pathname &&
    response.request().headers()["x-vinext-rsc-render-mode"] === "prefetch-loading-shell"
  );
}

async function prefetchLoadingShell(page: Page, href: string): Promise<void> {
  const prefetch = page.waitForResponse((response) => isLoadingShellPrefetch(response, href));
  await page.evaluate((target) => {
    const next = Reflect.get(window, "next") as { router: { prefetch(href: string): void } };
    next.router.prefetch(target);
  }, href);
  await (await prefetch).finished();
}

async function navigate(
  page: Page,
  options: { heading: string; href: string; showsLoading: boolean },
): Promise<number> {
  await page.evaluate(() => {
    Reflect.get(window, "__skeletonMounts").mounted = 0;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const target = new URL(options.href, "http://localhost");
  const matcher = (url: URL) =>
    url.pathname === target.pathname && url.searchParams.get("q") === target.searchParams.get("q");
  await page.route(matcher, async (route) => {
    const request = route.request();
    if (request.resourceType() === "fetch" && !request.headers()["next-router-prefetch"]) {
      await gate;
    }
    await route.continue();
  });

  const heading = page.locator("#page-heading");
  const previousHeading = (await heading.textContent()) ?? "";
  await page.click(`nav a[href="${options.href}"]`);
  if (options.showsLoading) {
    // Only the optimistic shell can mount a fallback while the request is held.
    await expect(page.locator("[data-skeleton]")).toBeVisible();
  } else {
    await page.waitForTimeout(300);
    await expect(page.locator("[data-skeleton]")).toHaveCount(0);
    await expect(heading).toHaveText(previousHeading);
  }
  release();
  await expect(heading).toHaveText(options.heading, { timeout: 10_000 });
  await page.unroute(matcher);
  // Let any late commit settle before counting.
  await page.waitForTimeout(300);
  return page.evaluate(() => Reflect.get(window, "__skeletonMounts").mounted);
}

for (const group of ["slow-layout", "slow-page"]) {
  test(`${group}: a navigation mounts one loading.tsx fallback`, async ({ page }) => {
    await trackSkeletonMounts(page);
    const base = `/loading-shell-remount/${group}`;
    const prefetch = page.waitForResponse((response) =>
      isLoadingShellPrefetch(response, `${base}/b`),
    );
    await page.goto(`${base}/a`);
    await waitForAppRouterHydration(page);
    await (await prefetch).finished();

    const mounted = await navigate(page, {
      heading: `${group} b`,
      href: `${base}/b`,
      showsLoading: true,
    });
    expect(mounted).toBe(1);
  });
}

test("dynamic route: a shell is keyed for the URL it commits", async ({ page }) => {
  // Five navigations, each behind the 800ms layout.
  test.slow();
  await trackSkeletonMounts(page);
  const base = "/loading-shell-remount/slow-layout-dynamic";
  await page.goto(`${base}/1`);
  await waitForAppRouterHydration(page);
  await prefetchLoadingShell(page, `${base}/2`);

  // The shell learned from /2 is keyed for /2, so the real payload reuses it.
  expect(
    await navigate(page, {
      heading: "slow-layout-dynamic 2",
      href: `${base}/2`,
      showsLoading: true,
    }),
  ).toBe(1);

  // /3 has no shell of its own, so the route's one, learned from the mounted
  // /2 page, is keyed for /3. It must not suspend inside /2's revealed
  // boundary, and the real payload reuses the fallback it mounts.
  expect(
    await navigate(page, {
      heading: "slow-layout-dynamic 3",
      href: `${base}/3`,
      showsLoading: true,
    }),
  ).toBe(1);

  // As in Next.js, a search-only change keeps the mounted boundary, so the
  // current page stays up until the new one is ready. That holds for /3, whose
  // shell was learned from /2, as well as for /2 itself.
  expect(
    await navigate(page, {
      heading: "slow-layout-dynamic 3?q=1",
      href: `${base}/3?q=1`,
      showsLoading: false,
    }),
  ).toBe(0);
  // /2's own shell, committed right after one rebound for /3.
  expect(
    await navigate(page, {
      heading: "slow-layout-dynamic 2",
      href: `${base}/2`,
      showsLoading: true,
    }),
  ).toBe(1);
  expect(
    await navigate(page, {
      heading: "slow-layout-dynamic 2?q=1",
      href: `${base}/2?q=1`,
      showsLoading: false,
    }),
  ).toBe(0);
});
