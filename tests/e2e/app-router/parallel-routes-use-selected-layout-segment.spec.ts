// Ported from Next.js v16.2.6:
// test/e2e/app-dir/parallel-routes-use-selected-layout-segment/parallel-routes-use-selected-layout-segment.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/parallel-routes-use-selected-layout-segment/parallel-routes-use-selected-layout-segment.test.ts

import fs from "node:fs/promises";
import path from "node:path";
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

  test("an abandoned concurrent render cannot replace the committed named segment", async ({
    page,
  }) => {
    await page.goto(BASE);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#concurrentAuthSegment")).toHaveText("visible");

    await page.locator("#start-abandoned-segment-render").click();
    await page.waitForFunction(
      () =>
        (window as Window & { __vinextAbandonedSegmentRenderStarted?: boolean })
          .__vinextAbandonedSegmentRenderStarted === true,
    );

    await page.locator("#supersede-segment-render").click();
    await expect(page.locator("#concurrentAuthSegment")).toHaveText("visible");

    await page.locator("#later-default-only-render").click();
    await expect(page.locator("#concurrentAuthSegment")).toHaveText("visible");
  });

  test("HMR preserves the named slot selected before navigating to children", async ({ page }) => {
    const pagePath = path.resolve(
      process.cwd(),
      "tests/fixtures/app-basic/app/parallel-selected-segment/foo/page.tsx",
    );
    const original = await fs.readFile(pagePath, "utf8");

    try {
      await page.goto(BASE);
      await waitForAppRouterHydration(page);
      await page.locator('a[href="/parallel-selected-segment/reset"]').click();
      await expectSegments(page, { nav: "", auth: "reset", route: "" });
      await page.locator('a[href="/parallel-selected-segment/foo"]').click();
      await expectSegments(page, { nav: "", auth: "reset", route: "foo" });

      await fs.writeFile(pagePath, original.replace("foo/page.tsx", "foo/page.tsx hmr"));

      await expect(page.locator("#children")).toContainText("foo/page.tsx hmr");
      await expectSegments(page, { nav: "", auth: "reset", route: "foo" });
    } finally {
      await fs.writeFile(pagePath, original);
    }
  });

  test("hard nav to a named slot renders default children", async ({ page }) => {
    await page.goto(`${BASE}/reset/withMobile`);
    await expectSegments(page, { nav: "", auth: "withMobile", route: "" });
    await expect(page.locator("#children")).toContainText(
      "/app/parallel-selected-segment/default.tsx",
    );
  });
});
