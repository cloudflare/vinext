// Ported from Next.js v16.2.6:
// test/e2e/app-dir/parallel-routes-use-selected-layout-segment/parallel-routes-use-selected-layout-segment.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/parallel-routes-use-selected-layout-segment/parallel-routes-use-selected-layout-segment.test.ts

import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = `${process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4174"}/parallel-selected-segment`;

async function expectSegments(page: Page, expected: { nav: string; auth: string; route: string }) {
  await expect(page.locator("#navSegment")).toHaveText(
    `navSegment (parallel route):${expected.nav ? ` ${expected.nav}` : ""}`,
  );
  await expect(page.locator("#authSegment")).toHaveText(
    `authSegment (parallel route):${expected.auth ? ` ${expected.auth}` : ""}`,
  );
  await expect(page.locator("#routeSegment")).toHaveText(
    `routeSegment (app route):${expected.route ? ` ${expected.route}` : ""}`,
  );
}

test.describe("parallel routes useSelectedLayoutSegment", () => {
  test("hard nav to router page and soft nav around other router pages", async ({ page }) => {
    await page.goto(BASE);
    await waitForAppRouterHydration(page);
    await expectSegments(page, { nav: "", auth: "", route: "" });

    await page.locator('a[href="/parallel-selected-segment/foo"]').click();
    await expectSegments(page, { nav: "", auth: "", route: "foo" });
  });

  test("hard nav to router page and soft nav to parallel routes", async ({ page }) => {
    await page.goto(BASE);
    await waitForAppRouterHydration(page);
    await expectSegments(page, { nav: "", auth: "", route: "" });

    await page.locator('a[href="/parallel-selected-segment/login"]').click();
    await expectSegments(page, { nav: "login", auth: "login", route: "" });

    await page.locator('a[href="/parallel-selected-segment/reset"]').click();
    await expectSegments(page, { nav: "login", auth: "reset", route: "" });

    await page.locator('a[href="/parallel-selected-segment/reset/withEmail"]').click();
    await expectSegments(page, { nav: "login", auth: "withEmail", route: "" });
  });

  test("soft nav preserves a named slot while changing children", async ({ page }) => {
    await page.goto(BASE);
    await waitForAppRouterHydration(page);
    await expectSegments(page, { nav: "", auth: "", route: "" });

    await page.locator('a[href="/parallel-selected-segment/reset"]').click();
    await expectSegments(page, { nav: "", auth: "reset", route: "" });

    await page.locator('a[href="/parallel-selected-segment/foo"]').click();
    await expectSegments(page, { nav: "", auth: "reset", route: "foo" });
  });

  test("replace nav preserves a named slot while changing children", async ({ page }) => {
    await page.goto(BASE);
    await waitForAppRouterHydration(page);

    await page.locator('a[href="/parallel-selected-segment/reset"]').click();
    await expectSegments(page, { nav: "", auth: "reset", route: "" });

    await page.locator("#replace-foo").click();
    await expectSegments(page, { nav: "", auth: "reset", route: "foo" });
  });

  test("hard nav to a named slot renders default children", async ({ page }) => {
    await page.goto(`${BASE}/reset/withMobile`);
    await expectSegments(page, { nav: "", auth: "withMobile", route: "" });
    await expect(page.locator("#children")).toContainText(
      "/app/parallel-selected-segment/default.tsx",
    );
  });
});
