// Ported from Next.js: test/e2e/app-dir/shallow-routing/shallow-routing.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/shallow-routing/shallow-routing.test.ts
import { expect, test } from "../../fixtures";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test("a descendant layout effect can shallow-push during hydration", async ({
  page,
  consoleErrors,
}) => {
  void consoleErrors;
  await page.goto(`${BASE}/nextjs-compat/shallow-history/target?layout-effect=push`);
  await waitForAppRouterHydration(page);

  await expect(page).toHaveURL(/\?layout-effect=committed$/);
  await expect(page.locator("#layout-effect-pathname")).toHaveText(
    "/nextjs-compat/shallow-history/target",
  );

  await page.goBack();
  await expect(page).toHaveURL(/\?layout-effect=push$/);
  await expect(page.locator("#layout-effect-pathname")).toHaveText(
    "/nextjs-compat/shallow-history/target",
  );
});

test("external pushState pathname survives back and forward", async ({ page }) => {
  await page.goto(`${BASE}/nextjs-compat/shallow-history`);
  await waitForAppRouterHydration(page);

  await page.locator("#to-shallow-history-target").click();
  await expect(page.locator("h1")).toHaveText("Shallow history target");

  await page.locator("#push-shallow-pathname").click();
  await expect(page.locator("#shallow-pathname")).toHaveText(
    "/nextjs-compat/shallow-history/missing",
  );

  await page.goBack();
  await expect(page.locator("#shallow-pathname")).toHaveText(
    "/nextjs-compat/shallow-history/target",
  );

  await page.goForward();
  await expect(page.locator("#shallow-pathname")).toHaveText(
    "/nextjs-compat/shallow-history/missing",
  );
});

test("external pushState supersedes an in-flight RSC navigation", async ({ page }) => {
  await page.goto(`${BASE}/nextjs-compat/shallow-history/target`);
  await waitForAppRouterHydration(page);

  await page.locator("#supersede-rsc-navigation").click();
  await expect(page.locator("#shallow-pathname")).toHaveText(
    "/nextjs-compat/shallow-history/missing",
  );
  await page.waitForTimeout(750);
  await expect(page.locator("#shallow-pathname")).toHaveText(
    "/nextjs-compat/shallow-history/missing",
  );
  await expect(page.locator("h1")).toHaveText("Shallow history target");
});

test("external replaceState supersedes an in-flight RSC navigation", async ({ page }) => {
  await page.goto(`${BASE}/nextjs-compat/shallow-history/target`);
  await waitForAppRouterHydration(page);

  await page.locator("#replace-during-rsc-navigation").click();
  await expect(page.locator("#shallow-pathname")).toHaveText(
    "/nextjs-compat/shallow-history/replaced",
  );
  await page.waitForTimeout(750);
  await expect(page.locator("#shallow-pathname")).toHaveText(
    "/nextjs-compat/shallow-history/replaced",
  );
  await expect(page.locator("h1")).toHaveText("Shallow history target");
});

test("state-only replaceState preserves an in-flight RSC navigation", async ({ page }) => {
  await page.route("**/nextjs-compat/shallow-history?*", async (route) => {
    if (route.request().headers().rsc === "1") {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });
  await page.goto(`${BASE}/nextjs-compat/shallow-history/target`);
  await waitForAppRouterHydration(page);

  await page.locator("#state-only-replace-during-rsc-navigation").click();
  await expect.poll(() => page.evaluate(() => window.history.state.marker)).toBe(true);
  await expect(page.locator("h1")).toHaveText("Shallow history start");
  await expect(page).toHaveURL(/\/nextjs-compat\/shallow-history$/);
});

test("a rejected external pushState does not supersede an in-flight RSC navigation", async ({
  page,
}) => {
  await page.route("**/nextjs-compat/shallow-history?*", async (route) => {
    if (route.request().headers().rsc === "1") {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });
  await page.goto(`${BASE}/nextjs-compat/shallow-history/target`);
  await waitForAppRouterHydration(page);

  await page.locator("#reject-shallow-history").click();
  await expect(page.locator("h1")).toHaveText("Shallow history start");
  await expect(page).toHaveURL(/\/nextjs-compat\/shallow-history$/);
});

test("hash-only popstate supersedes an in-flight RSC navigation", async ({ page }) => {
  await page.route("**/nextjs-compat/shallow-history?*", async (route) => {
    if (route.request().headers().rsc === "1") {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });
  await page.goto(`${BASE}/nextjs-compat/shallow-history/target`);
  await waitForAppRouterHydration(page);
  await page.evaluate(() => window.history.pushState({}, "", "#section"));

  await page.locator("#start-rsc-navigation").click();
  await page.waitForTimeout(50);
  await page.goBack();
  await expect(page).toHaveURL(/\/nextjs-compat\/shallow-history\/target$/);
  await page.waitForTimeout(750);
  await expect(page.locator("h1")).toHaveText("Shallow history target");
  await expect(page).toHaveURL(/\/nextjs-compat\/shallow-history\/target$/);
});
