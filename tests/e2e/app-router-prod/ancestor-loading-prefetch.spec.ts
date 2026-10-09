import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Next.js keys a segment's loading boundary by its immediate child segment, so a
// prefetched loading shell must not replace the current page while that child
// is shared. Related Next.js test: test/e2e/app-dir/app-prefetch-false-loading/app-prefetch-false-loading.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch-false-loading/app-prefetch-false-loading.test.ts
const BASE = "/ancestor-loading-shared-layout";
const LOADING = "ancestor-shared-layout-loading";

type LoadingWindow = { __sawLoading?: boolean };

// Holds the real navigation request so that, until it is released, only the
// optimistic loading shell can put the loading UI on screen.
async function clickWithHeldNavigation(
  page: Page,
  // `current` is a selector for what the starting page shows. Without a `link`,
  // the router prefetches and pushes the target instead.
  options: {
    beforeClick?: () => Promise<void>;
    from: string;
    current: string;
    link?: string;
    loading: string;
    targetPath: string;
  },
): Promise<() => void> {
  let releaseNavigation!: () => void;
  let navigationRequestSeen = false;
  const navigationReleased = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  await page.route(`**${options.targetPath}*`, async (route) => {
    const headers = route.request().headers();
    if (
      headers.rsc === "1" &&
      headers["x-vinext-rsc-render-mode"] !== "prefetch-loading-shell" &&
      headers["next-router-prefetch"] === undefined
    ) {
      navigationRequestSeen = true;
      await navigationReleased;
    }
    await route.continue();
  });
  const shellPrefetch = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === options.targetPath &&
      response.request().headers()["x-vinext-rsc-render-mode"] === "prefetch-loading-shell",
  );
  await page.goto(options.from);
  await waitForAppRouterHydration(page);
  await expect(page.locator(options.current)).toBeVisible();
  if (options.link === undefined) {
    await page.evaluate((href) => {
      const router = window.next?.router;
      if (!router) throw new Error("window.next.router is not installed");
      router.prefetch(href);
    }, options.targetPath);
  }
  await (await shellPrefetch).finished();

  await page.evaluate((loadingId) => {
    const state = window as unknown as LoadingWindow;
    state.__sawLoading = false;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.id === loadingId || node.querySelector(`#${loadingId}`))
          ) {
            state.__sawLoading = true;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }, options.loading);
  // The client only commits a shell whose prefetch entry has settled.
  await expect
    .poll(() =>
      page.evaluate((targetPath) => {
        const cache = Reflect.get(window, "__VINEXT_RSC_PREFETCH_CACHE__") as Map<
          string,
          { optimisticRouteShell?: boolean; outcome?: string; pending?: Promise<void> }
        >;
        return Array.from(cache.entries()).some(
          ([key, entry]) =>
            key.includes(targetPath) &&
            entry.optimisticRouteShell === true &&
            entry.outcome === "cache-seeded" &&
            entry.pending === undefined,
        );
      }, options.targetPath),
    )
    .toBe(true);
  await options.beforeClick?.();
  navigationRequestSeen = false;
  if (options.link === undefined) {
    await page.evaluate((href) => {
      const router = window.next?.router;
      if (!router) throw new Error("window.next.router is not installed");
      void router.push(href);
    }, options.targetPath);
  } else {
    await page.locator(`#${options.link}`).click();
  }
  // The navigation must reach the network, or the hold proves nothing. Any
  // optimistic commit has started by then, though it may not be on screen yet;
  // the observer stays installed, so the post-release check catches a late one.
  await expect.poll(() => navigationRequestSeen).toBe(true);
  return releaseNavigation;
}

function sawLoading(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => (window as unknown as LoadingWindow).__sawLoading);
}

for (const target of [
  {
    name: "a sibling page with nothing in between",
    from: `${BASE}/plain/one`,
    current: "#ancestor-shared-layout-one",
    link: "ancestor-shared-layout-two-link",
    loading: LOADING,
    target: "ancestor-shared-layout-two",
    path: `${BASE}/plain/two`,
  },
  {
    name: "a sibling page from a dynamic page",
    from: `${BASE}/plain/5`,
    current: "#ancestor-shared-layout-dynamic",
    link: "ancestor-shared-layout-two-from-dynamic-link",
    loading: LOADING,
    target: "ancestor-shared-layout-two",
    path: `${BASE}/plain/two`,
  },
  {
    name: "a sibling page under a group template",
    from: `${BASE}/alpha`,
    current: "#ancestor-shared-layout-alpha",
    link: "ancestor-shared-layout-beta-link",
    loading: LOADING,
    target: "ancestor-shared-layout-beta",
    path: `${BASE}/beta`,
  },
  {
    name: "a sibling page with its own layout below a layout-less segment",
    from: `${BASE}/plain/three`,
    current: "#ancestor-shared-layout-three",
    link: "ancestor-shared-layout-four-link",
    loading: LOADING,
    target: "ancestor-shared-layout-four",
    path: `${BASE}/plain/four`,
  },
  {
    // A leaf loading's page key ignores search params.
    name: "the same page with different search params",
    from: "/leaf-loading-search-only?q=first",
    current: "#leaf-loading-search-only-first",
    link: "leaf-loading-search-only-clear-link",
    loading: "leaf-loading-search-only-loading",
    target: "leaf-loading-search-only-none",
    path: "/leaf-loading-search-only",
  },
]) {
  test(`a prefetched loading shell keeps the current page when navigating to ${target.name}`, async ({
    page,
  }) => {
    const releaseNavigation = await clickWithHeldNavigation(page, {
      current: target.current,
      from: target.from,
      link: target.link,
      loading: target.loading,
      targetPath: target.path,
    });
    expect(await sawLoading(page)).toBe(false);
    await expect(page.locator(target.current)).toBeVisible();

    releaseNavigation();
    await expect(page.locator(`#${target.target}`)).toBeVisible({ timeout: 10_000 });
    expect(await sawLoading(page)).toBe(false);
  });
}

test("a prefetched loading shell still shows the loading when the boundary's child segment changes", async ({
  page,
}) => {
  const releaseNavigation = await clickWithHeldNavigation(page, {
    current: "#ancestor-shared-layout-one",
    from: `${BASE}/plain/one`,
    link: "ancestor-shared-layout-beta-from-one-link",
    loading: LOADING,
    targetPath: `${BASE}/beta`,
  });
  // The real navigation is held, so this fallback comes from the shell.
  await expect(page.locator(`#${LOADING}`)).toBeVisible();

  releaseNavigation();
  await expect(page.locator("#ancestor-shared-layout-beta")).toBeVisible({ timeout: 10_000 });
});

test("a prefetched loading shell shows the loading when leaving a not-found page", async ({
  page,
}) => {
  // The root not-found.tsx owns the fallback, so Next.js has unmounted the
  // ancestor loading boundary and mounts it fresh on navigation.
  const shownFallbacks = () =>
    page.evaluate(
      () =>
        (
          Reflect.get(globalThis, Symbol.for("vinext.shownSegmentFallbacks")) as
            | Set<object>
            | undefined
        )?.size ?? 0,
    );
  const releaseNavigation = await clickWithHeldNavigation(page, {
    // The guard keeps the shell because of the shown fallback, not because the
    // payload lacks a page entry.
    beforeClick: async () => expect(await shownFallbacks()).toBeGreaterThan(0),
    current: "text=404 - Page Not Found",
    from: `${BASE}/plain/missing`,
    loading: LOADING,
    targetPath: `${BASE}/plain/two`,
  });
  await expect(page.locator(`#${LOADING}`)).toBeVisible();

  releaseNavigation();
  await expect(page.locator("#ancestor-shared-layout-two")).toBeVisible({ timeout: 10_000 });
  // The not-found boundary unmounted, so the guard applies again.
  expect(await shownFallbacks()).toBe(0);
});
