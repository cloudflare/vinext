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
});
