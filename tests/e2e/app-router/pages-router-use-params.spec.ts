// Regression test for issue #1466 ported from the Next.js deploy suite:
// .nextjs-ref/test/e2e/app-dir/use-params/use-params.test.ts (`should work on
// pages router` case).
//
// In a project that has BOTH `app/` and `pages/` directories, a Pages Router
// dynamic page using `useParams()` from `next/navigation` must return the
// dynamic route params after hydration. The Next.js test asserts:
//
//   expect(await browser.elementById('params').text()).toBe('"foobar"')
//
// `elementById` waits for the element to become visible; an empty `<div>`
// (which is what we render when `params?.dynamic` is undefined) has zero
// height and is therefore not visible, so the failure mode in the deploy
// suite is a Playwright visibility timeout.
//
// Fixture: tests/fixtures/app-basic/pages/pages-dir-use-params/[dynamic]/index.tsx
import { test, expect } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("issue #1466: Pages Router useParams under app+pages project", () => {
  test("renders dynamic param JSON after hydration", async ({ page }) => {
    await page.goto(`${BASE}/pages-dir-use-params/foobar`);
    await waitForHydration(page);

    await expect(page.locator("#params")).toBeVisible();
    await expect(page.locator("#params")).toHaveText('"foobar"');
  });

  // Ported from Next.js: test/e2e/app-dir/navigation/navigation.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
  test("keeps the pages-router params object stable across rerenders", async ({ page }) => {
    await page.goto(`${BASE}/search-params-pages/foo`);
    await waitForHydration(page);

    await expect(page.locator("#params")).toHaveText('{"foo":"foo"}');
    const initialChangeCount = await page.locator("#params-change-count").textContent();

    await page.click("#rerender-button");
    await page.click("#rerender-button");
    await page.click("#rerender-button");

    await expect(page.locator("#rerender-button")).toHaveText("Re-Render 3");
    await expect(page.locator("#params-change-count")).toHaveText(initialChangeCount ?? "");

    await page.click("#change-params-button");
    await expect(page).toHaveURL(`${BASE}/search-params-pages/bar`);
    await expect(page.locator("#params")).toHaveText('{"foo":"bar"}');
  });
});
