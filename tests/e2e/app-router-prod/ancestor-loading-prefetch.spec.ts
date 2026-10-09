import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Next.js keys a segment's loading boundary by its immediate child segment, so a
// prefetched loading shell must not replace the current page while that child
// is shared. Related Next.js test: test/e2e/app-dir/app-prefetch-false-loading/app-prefetch-false-loading.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch-false-loading/app-prefetch-false-loading.test.ts
const BASE = "/ancestor-loading-shared-layout";

type LoadingWindow = { __sawAncestorSharedLayoutLoading?: boolean };

// Holds the real navigation request so that, until it is released, only the
// optimistic loading shell can put the loading UI on screen.
async function clickWithHeldNavigation(
  page: Page,
  options: { from: string; current: string; link: string; targetPath: string },
): Promise<() => void> {
  let releaseNavigation!: () => void;
  const navigationReleased = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  await page.route(`**${BASE}${options.targetPath}*`, async (route) => {
    const headers = route.request().headers();
    if (
      headers.rsc === "1" &&
      headers["x-vinext-rsc-render-mode"] !== "prefetch-loading-shell" &&
      headers["next-router-prefetch"] === undefined
    ) {
      await navigationReleased;
    }
    await route.continue();
  });
  const shellPrefetch = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith(`${BASE}${options.targetPath}`) &&
      response.request().headers()["x-vinext-rsc-render-mode"] === "prefetch-loading-shell",
  );
  await page.goto(`${BASE}${options.from}`);
  await waitForAppRouterHydration(page);
  await expect(page.locator(`#ancestor-shared-layout-${options.current}`)).toBeVisible();
  await (await shellPrefetch).finished();

  await page.evaluate(() => {
    const state = window as unknown as LoadingWindow;
    state.__sawAncestorSharedLayoutLoading = false;
    new MutationObserver(() => {
      if (document.getElementById("ancestor-shared-layout-loading")) {
        state.__sawAncestorSharedLayoutLoading = true;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.locator(`#${options.link}`).click();
  return releaseNavigation;
}

function sawLoading(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => (window as unknown as LoadingWindow).__sawAncestorSharedLayoutLoading);
}

for (const target of [
  {
    name: "a sibling page with nothing in between",
    from: "/plain/one",
    current: "one",
    link: "two",
    target: "two",
    path: "/plain/two",
  },
  {
    name: "a sibling page from a dynamic page",
    from: "/plain/5",
    current: "dynamic",
    link: "two-from-dynamic",
    target: "two",
    path: "/plain/two",
  },
  {
    name: "a sibling page under a group template",
    from: "/alpha",
    current: "alpha",
    link: "beta",
    target: "beta",
    path: "/beta",
  },
  {
    name: "a sibling page with its own layout below a layout-less segment",
    from: "/plain/three",
    current: "three",
    link: "four",
    target: "four",
    path: "/plain/four",
  },
]) {
  test(`a prefetched loading shell keeps the current page when navigating to ${target.name}`, async ({
    page,
  }) => {
    const releaseNavigation = await clickWithHeldNavigation(page, {
      current: target.current,
      from: target.from,
      link: `ancestor-shared-layout-${target.link}-link`,
      targetPath: target.path,
    });
    await page.waitForTimeout(1_000);
    expect(await sawLoading(page)).toBe(false);
    await expect(page.locator(`#ancestor-shared-layout-${target.current}`)).toBeVisible();

    releaseNavigation();
    await expect(page.locator(`#ancestor-shared-layout-${target.target}`)).toBeVisible({
      timeout: 10_000,
    });
    expect(await sawLoading(page)).toBe(false);
  });
}

test("a prefetched loading shell still shows the loading when the boundary's child segment changes", async ({
  page,
}) => {
  const releaseNavigation = await clickWithHeldNavigation(page, {
    current: "one",
    from: "/plain/one",
    link: "ancestor-shared-layout-beta-from-one-link",
    targetPath: "/beta",
  });
  // The real navigation is held, so this fallback comes from the shell.
  await expect(page.locator("#ancestor-shared-layout-loading")).toBeVisible({ timeout: 2_000 });

  releaseNavigation();
  await expect(page.locator("#ancestor-shared-layout-beta")).toBeVisible({ timeout: 10_000 });
});
