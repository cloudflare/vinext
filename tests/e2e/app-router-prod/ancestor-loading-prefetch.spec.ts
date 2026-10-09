import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Next.js keys a segment's loading boundary by its immediate child segment, so a
// prefetched loading shell must not replace the current page while that child
// is shared. Related Next.js test: test/e2e/app-dir/app-prefetch-false-loading/app-prefetch-false-loading.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch-false-loading/app-prefetch-false-loading.test.ts
const BASE = "/ancestor-loading-shared-layout";

async function navigateAfterLoadingShellPrefetch(
  page: Page,
  options: { from: string; current: string; link: string; targetPath: string },
): Promise<boolean> {
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
    const state = window as unknown as { __sawAncestorSharedLayoutLoading?: boolean };
    state.__sawAncestorSharedLayoutLoading = false;
    new MutationObserver(() => {
      if (document.getElementById("ancestor-shared-layout-loading")) {
        state.__sawAncestorSharedLayoutLoading = true;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.locator(`#${options.link}`).click();
  return page
    .waitForFunction(
      () =>
        (window as unknown as { __sawAncestorSharedLayoutLoading?: boolean })
          .__sawAncestorSharedLayoutLoading,
      undefined,
      { timeout: 1_000 },
    )
    .then(
      () => true,
      () => false,
    );
}

for (const target of [
  {
    name: "a sibling page with nothing in between",
    from: "/plain/one",
    current: "one",
    link: "two",
    path: "/plain/two",
  },
  {
    name: "a sibling page under a group template",
    from: "/alpha",
    current: "alpha",
    link: "beta",
    path: "/beta",
  },
  {
    name: "a sibling page with its own layout below a layout-less segment",
    from: "/plain/three",
    current: "three",
    link: "four",
    path: "/plain/four",
  },
]) {
  test(`a prefetched loading shell keeps the current page when navigating to ${target.name}`, async ({
    page,
  }) => {
    const sawLoading = await navigateAfterLoadingShellPrefetch(page, {
      current: target.current,
      from: target.from,
      link: `ancestor-shared-layout-${target.link}-link`,
      targetPath: target.path,
    });
    expect(sawLoading).toBe(false);
    await expect(page.locator(`#ancestor-shared-layout-${target.current}`)).toBeVisible();
    await expect(page.locator(`#ancestor-shared-layout-${target.link}`)).toBeVisible({
      timeout: 10_000,
    });
  });
}

test("a prefetched loading shell still shows the loading when the boundary's child segment changes", async ({
  page,
}) => {
  const sawLoading = await navigateAfterLoadingShellPrefetch(page, {
    current: "one",
    from: "/plain/one",
    link: "ancestor-shared-layout-beta-from-one-link",
    targetPath: "/beta",
  });
  expect(sawLoading).toBe(true);
  await expect(page.locator("#ancestor-shared-layout-beta")).toBeVisible({ timeout: 10_000 });
});
